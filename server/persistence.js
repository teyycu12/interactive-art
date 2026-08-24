/**
 * 狀態快照落地
 *
 * 目的很窄：伺服器重開（當機、誤觸 Ctrl+C、換一台筆電）之後，
 * 積分、社交圖譜、任務與問答紀錄還在，主辦端的通行密鑰不變，
 * 參與者也能拿回自己原本的角色與分數。
 *
 * 不存什麼同樣重要：座標、速度、α 權重、Boids 影子速度這些每秒變動 30 次的
 * 即時狀態一律不存。它們重算即可，寫進檔案只會讓每次快照都變成整份重寫。
 *
 * 寫入一律「先寫暫存檔，再原子改名」。直接覆寫原檔的話，
 * 在寫到一半時斷電會留下一個語法壞掉的 JSON —— 那比沒有檔案更糟，
 * 因為下次啟動會載入失敗，而現場沒有人有空去修一個 JSON。
 */

import fs from 'node:fs';
import path from 'node:path';

export class SnapshotStore {
  /**
   * @param {string} file 快照路徑（相對路徑以專案根目錄為基準）
   * @param {{enabled?: boolean}} [options]
   */
  constructor(file, { enabled = true } = {}) {
    this.file = path.resolve(file);
    this.tmp = `${this.file}.tmp`;
    this.enabled = enabled;
    this.dirty = false;
    /** 最近一次寫入是否失敗，用於避免每 5 秒洗版同一則錯誤 */
    this.lastError = null;
  }

  /** 標記狀態有變動，等下一次自動存檔時寫入 */
  touch() {
    this.dirty = true;
  }

  /**
   * 讀取快照。
   *
   * 任何讀取失敗都回傳 null 而不拋出 —— 快照壞掉時系統必須照常啟動，
   * 大不了是一場乾淨的新活動；為了一個壞檔案讓現場開不了機是不能接受的。
   * @returns {object|null}
   */
  load() {
    if (!this.enabled) return null;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[state] 快照無法載入（${err.message}），以空狀態啟動`);
        // 壞掉的檔案保留成 .bad，方便事後查，但不擋啟動
        try { fs.renameSync(this.file, `${this.file}.bad`); } catch { /* 略 */ }
      }
      return null;
    }
  }

  /**
   * 寫入快照。
   * @param {object} data
   * @param {{force?: boolean}} [options] force 為真時忽略髒旗標（關機前的最後一次寫入）
   * @returns {boolean} 是否確實寫了
   */
  save(data, { force = false } = {}) {
    if (!this.enabled) return false;
    if (!this.dirty && !force) return false;

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(this.tmp, this.file);
      this.dirty = false;
      this.lastError = null;
      return true;
    } catch (err) {
      // 同一則錯誤只報一次。磁碟滿或權限不足時，每 5 秒印一行會把
      // 終端機洗到看不見其他訊息，而現場就是靠終端機在監看
      if (this.lastError !== err.message) {
        console.warn(`[state] 快照寫入失敗：${err.message}`);
        this.lastError = err.message;
      }
      return false;
    }
  }
}

/**
 * 參與者身分目錄。
 *
 * 積分是掛在 agentId 上的，而 agentId 在伺服器重開後就消失了 ——
 * 沒有這份目錄，重開機等於所有人的分數都變成無主的孤兒。
 *
 * 目錄存的是「這個 userId 是誰、憑證是什麼」，讓手機帶著 localStorage 裡的
 * userId 與 rejoinToken 回來時，能重建同一個 id 的角色，分數自然接得回去。
 * 這也是為什麼重連憑證必須落地：它是認領的唯一依據。
 *
 * ⚠ 憑證以明文存在檔案裡。這是區網單機活動的合理取捨（拿得到這個檔案的人
 *   本來就拿得到整台伺服器），但不要把 data/ 目錄放進版本控制或雲端同步。
 */
export class Directory {
  constructor({ limit = 500, ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    /** @type {Map<string, {id: string, name: string, avatar: object, rejoinToken: string, lastSeenAt: number}>} */
    this.entries = new Map();
    this.limit = limit;
    this.ttlMs = ttlMs;
  }

  /** 記住／更新一位參與者。每次進場與離場都應呼叫，以更新 lastSeenAt */
  remember(agent) {
    if (!agent) return;
    this.entries.set(agent.id, {
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      rejoinToken: agent.rejoinToken,
      lastSeenAt: Date.now(),
    });
    this.#prune();
  }

  get(id) {
    return this.entries.get(id) ?? null;
  }

  /**
   * 撤銷某人的憑證。
   *
   * 用於明確的離場（主動退出、被主辦端移除）：這個 userId 從此認領不回來。
   * 單純斷線不該呼叫 —— 那是網路瞬斷，憑證必須留著才有重連可言。
   */
  forget(id) {
    return this.entries.delete(id);
  }

  /** 汰換過期與超量的項目，最久沒出現的先走 */
  #prune(now = Date.now()) {
    for (const [id, e] of this.entries) {
      if (now - e.lastSeenAt > this.ttlMs) this.entries.delete(id);
    }
    if (this.entries.size <= this.limit) return;
    const sorted = [...this.entries.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const e of sorted.slice(0, this.entries.size - this.limit)) {
      this.entries.delete(e.id);
    }
  }

  export() {
    return [...this.entries.values()];
  }

  hydrate(rows) {
    if (!Array.isArray(rows)) return this;
    for (const r of rows) {
      if (!r?.id || typeof r.rejoinToken !== 'string') continue;
      this.entries.set(r.id, {
        id: r.id,
        name: typeof r.name === 'string' ? r.name : '',
        avatar: r.avatar ?? null,
        rejoinToken: r.rejoinToken,
        lastSeenAt: Number(r.lastSeenAt) || Date.now(),
      });
    }
    this.#prune();
    return this;
  }
}
