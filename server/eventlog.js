/**
 * 逐筆事件紀錄（實測數據）
 *
 * data/state.json 只有「最新狀態」：積分、社交圖譜、問答答案。它答得出
 * 「誰最後幾分」，答不出「什麼時候、誰、做了什麼」—— 停留時間、操控時間、
 * 斷線次數、入場方式、任務花了多久，全都需要時間序列。
 *
 * 格式是 JSONL：一行一筆，只附加不修改。伺服器中途當掉也只會少最後一行，
 * 而 Excel、Python、JASP 都能直接讀。
 *
 * 場次由啟動時的 PIXELAIR_SESSION 決定，檔名就是場次名稱
 * （data/events/live-1019.jsonl）。工程師測試與正式場次因此天生分在不同檔案，
 * 分析時不必再從一份檔案裡挑出哪些是測試。
 *
 * 三條原則：
 *   1. 時間一律用伺服器的 Date.now()，不信手機 —— 每支手機的時鐘都不一樣。
 *   2. 寫入失敗只警告一次並停用，**絕不拋出**。紀錄是給事後分析的，
 *      為了它讓現場的伺服器當掉是本末倒置（index.js 的 uncaughtException
 *      會直接結束行程）。
 *   3. 不記每一筆移動輸入。手機每秒送出多筆 INPUT_MOVE，30 人一小時是
 *      數十萬筆；操控時間由 mode_change 就算得出來。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 場次名稱只留檔名安全的字元，避免 PIXELAIR_SESSION=../x 寫到別處 */
export function sessionName(raw) {
  const s = String(raw ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return s || 'dev';
}

/**
 * 場次種類。以名稱前綴判定：live-* 是正式場次，其餘（dev、rehearsal-*…）
 * 都算測試。寫進 session_start，分析時不必記得哪個檔名代表什麼。
 */
export const sessionKind = (session) => (session.startsWith('live') ? 'live' : 'test');

/**
 * 從 CV 角色的貼圖路徑取出生成服務的 requestId。
 *
 * 生成服務用同一個 id 當帳本主鍵與貼圖目錄名（/assets/gen/<id>/head.webp），
 * 所以伺服器不必請手機另外回報，就能把參與者跟生成紀錄（SQLite）對上。
 * @returns {string|undefined} 捏臉角色沒有生成圖，回 undefined（JSON 裡就不出現）
 */
export const generationIdOf = (avatar) =>
  avatar?.textures?.head?.match(/^\/assets\/gen\/([^/]+)\//)?.[1] ?? undefined;

export class EventLog {
  /**
   * @param {object} options
   * @param {string} options.dir 紀錄目錄
   * @param {string} options.session 場次名稱（已經過 sessionName 清理）
   * @param {boolean} [options.enabled]
   * @param {() => number} [options.now] 測試用
   */
  constructor({ dir, session, enabled = true, now = Date.now }) {
    this.session = session;
    this.file = path.resolve(dir, `${session}.jsonl`);
    this.enabled = enabled;
    this.now = now;
    this.failed = false;
    /** @type {fs.WriteStream|null} */
    this.stream = null;
    if (!enabled) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // flags 'a'：同一場次重開伺服器是接著寫，不是覆蓋掉前半場
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', (err) => this.#fail(err));
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.stream = null;
    console.warn(`[events] 事件紀錄寫入失敗，本場不再紀錄：${err.message}`);
  }

  #line(ev, fields) {
    return `${JSON.stringify({ t: this.now(), session: this.session, ev, ...fields })}\n`;
  }

  /**
   * 記一筆事件。欄位值為 undefined 的會被 JSON.stringify 自動略過。
   * @param {string} ev 事件名稱（snake_case，與 docs 的事件表一致）
   * @param {object} [fields]
   */
  log(ev, fields = {}) {
    if (!this.stream) return;
    try {
      this.stream.write(this.#line(ev, fields));
    } catch (err) {
      this.#fail(err);
    }
  }

  /**
   * 同步寫一筆並結束。只給崩潰路徑用：那時事件迴圈已經不會再跑，
   * 串流緩衝裡的東西來不及送出，只有同步寫入確定落地。
   */
  logSync(ev, fields = {}) {
    if (!this.enabled || this.failed) return;
    try {
      fs.appendFileSync(this.file, this.#line(ev, fields), 'utf8');
    } catch { /* 崩潰中，不再多事 */ }
  }

  /** 等緩衝全部寫進磁碟。關機流程要先等這個，最後幾筆才不會掉。 */
  close() {
    const s = this.stream;
    this.stream = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => s.end(resolve));
  }
}
