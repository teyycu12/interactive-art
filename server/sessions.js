/**
 * 活動目錄：主持人可以事先建好好幾場活動，每場的參與者、積分、任務、問答各存一份，
 * 不會混在一起（2026-10-29）。
 *
 * ── 一次只「開啟」一場 ──
 * 大螢幕只有一個、手機連的是同一台伺服器，所以同一時間只有一場在進行（「目前的活動」）。
 * 其他場是存在硬碟上的快照，格式與原本的 data/state.json 完全相同（index.js 的 snapshotData），
 * 開啟時整份載入、關掉時整份存回。
 *
 * ── 檔案 ──
 *   <dir>/<活動 id>.json   每場活動的快照
 *   <dir>/active.json      {"id": 目前的活動}
 * dir 預設是快照檔旁邊的 sessions/（data/state.json → data/sessions/）。
 * 原本的單一快照第一次啟動時轉成第一場活動；原檔不刪，留作備份。
 *
 * ── 關閉存檔時（PIXELAIR_PERSIST=0，測試用）──
 * 一樣能建立、切換，只是快照放在記憶體裡，伺服器關掉就沒了。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 活動 id：只接受這個形狀 —— 它會拿去組檔名，不能讓主辦端送來的字串決定讀寫哪個檔 */
const ID_RE = /^evt-[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$/;
export const isEventId = (id) => typeof id === 'string' && ID_RE.test(id);

/** 快照檔路徑 → 活動資料夾。環境變數 PIXELAIR_SESSIONS_DIR 優先 */
export function sessionsDirFor(stateFile) {
  if (process.env.PIXELAIR_SESSIONS_DIR) return path.resolve(process.env.PIXELAIR_SESSIONS_DIR);
  const dir = path.dirname(stateFile);
  const base = path.basename(stateFile, '.json');
  return base === 'state' ? path.join(dir, 'sessions') : path.join(dir, `${base}.sessions`);
}

function newId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}`;
  return `evt-${day}-${time}-${randomBytes(2).toString('hex')}`;
}

/** 列表上要顯示的摘要（不送整份快照給主辦端） */
function summaryOf(id, snap) {
  // 身分目錄與參與名單只留 12 小時，隔天再看會是 0 —— 得過分的人也算進來
  const people = new Set([
    ...(snap?.directory ?? []).map((e) => e?.id),
    ...(snap?.attendance ?? []).map((e) => e?.id),
    ...Object.keys(snap?.scores?.totals ?? {}),
  ].filter(Boolean)).size;
  return {
    id,
    name: snap?.event?.name ?? '',
    subtitle: snap?.event?.subtitle ?? '',
    theme: snap?.theme ?? null,
    createdAt: Number(snap?.createdAt) || Number(snap?.savedAt) || null,
    savedAt: Number(snap?.savedAt) || null,
    people,
  };
}

export class EventCatalog {
  /**
   * @param {{dir: string, legacyFile?: string|null, enabled?: boolean}} options
   *   legacyFile：舊的單一快照，第一次啟動時轉成第一場活動
   */
  constructor({ dir, legacyFile = null, enabled = true }) {
    this.dir = dir;
    this.legacyFile = legacyFile;
    this.enabled = enabled;
    /** 關閉存檔時的快照（id → 快照） @type {Map<string, object>} */
    this.memory = new Map();
    this.activeId = null;
  }

  fileOf(id) {
    if (!isEventId(id)) throw new Error(`bad event id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * 啟動時呼叫：找出目前的活動。舊的單一快照轉成第一場；一場都沒有就建一場空的
   * （未命名，主辦端會停在活動設定，跟原本第一次開機一樣）。
   * @returns {string} 目前活動的 id
   */
  init() {
    if (this.enabled) {
      fs.mkdirSync(this.dir, { recursive: true });
      const saved = this.#readJson(path.join(this.dir, 'active.json'))?.id;
      if (isEventId(saved) && fs.existsSync(this.fileOf(saved))) {
        this.activeId = saved;
        return saved;
      }
      const legacy = this.legacyFile && this.#readJson(this.legacyFile);
      if (legacy) {
        const id = newId(new Date(Number(legacy.savedAt) || Date.now()));
        // legacy：事件紀錄裡沒標活動的舊紀錄都屬於這一場（分場之前只有這一場）
        this.#write(id, { ...legacy, createdAt: legacy.createdAt ?? legacy.savedAt ?? Date.now(), legacy: true });
        console.log(`  [event] 舊的活動資料轉成第一場活動　${id}（原檔 ${path.basename(this.legacyFile)} 保留未動）`);
        this.setActive(id);
        return id;
      }
      // 資料夾裡已經有活動、只是 active.json 不見了：挑最近存過的那一場
      const latest = this.list()[0];
      if (latest) { this.setActive(latest.id); return latest.id; }
    }
    const id = this.create({ event: null, theme: null });
    this.setActive(id);
    return id;
  }

  /** 所有活動，最近存過的在前 */
  list() {
    const rows = [];
    if (this.enabled) {
      let files = [];
      try { files = fs.readdirSync(this.dir); } catch { /* 沒有資料夾就是沒有活動 */ }
      for (const f of files) {
        const id = f.replace(/\.json$/, '');
        if (!isEventId(id)) continue;
        const snap = this.#readJson(path.join(this.dir, f));
        if (snap) rows.push(summaryOf(id, snap));
      }
    } else {
      for (const [id, snap] of this.memory) rows.push(summaryOf(id, snap));
    }
    return rows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  has(id) {
    if (!isEventId(id)) return false;
    return this.enabled ? fs.existsSync(this.fileOf(id)) : this.memory.has(id);
  }

  /** 讀一場活動的快照；讀不到回傳 null */
  load(id) {
    if (!isEventId(id)) return null;
    return this.enabled ? this.#readJson(this.fileOf(id)) : (this.memory.get(id) ?? null);
  }

  /** 存一場活動的快照（關閉存檔時存在記憶體） */
  save(id, snap) {
    if (!isEventId(id)) return false;
    if (!this.enabled) { this.memory.set(id, snap); return true; }
    return this.#write(id, snap);
  }

  /**
   * 建一場新活動（只建立，不切換）。
   * @param {{event: {name: string, subtitle?: string}|null, theme: string|null, extra?: object}} init
   */
  create({ event, theme, extra = {} }) {
    let id = newId();
    while (this.has(id)) id = newId();
    const now = Date.now();
    this.save(id, { version: 1, createdAt: now, savedAt: now, event, theme, ...extra });
    return id;
  }

  /** 刪除一場活動。目前開啟中的那場不能刪 */
  remove(id) {
    if (!isEventId(id) || id === this.activeId) return false;
    if (!this.enabled) return this.memory.delete(id);
    try { fs.rmSync(this.fileOf(id)); return true; } catch { return false; }
  }

  setActive(id) {
    this.activeId = id;
    if (!this.enabled) return;
    try {
      fs.writeFileSync(path.join(this.dir, 'active.json'), JSON.stringify({ id }), 'utf8');
    } catch (err) {
      console.warn(`[event] 無法記下目前的活動：${err.message}`);
    }
  }

  #readJson(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  #write(id, snap) {
    const file = this.fileOf(id);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap), 'utf8');
      fs.renameSync(`${file}.tmp`, file);
      return true;
    } catch (err) {
      console.warn(`[event] 活動 ${id} 寫入失敗：${err.message}`);
      return false;
    }
  }
}
