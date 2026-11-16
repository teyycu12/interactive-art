/**
 * 主辦端密鑰的失敗次數限制（REVIEW-2026-11-15 B1）。
 *
 * 密鑰 6 碼、31 種字元（約 8.9 億種）。WebSocket 的 HOST_AUTH 至少受每條連線每秒 60 則的
 * 限流；HTTP 那兩條（/api/host/history、/api/host/avatars）原本完全沒有，本機一秒可以試上千次，
 * 而那兩條給得出參與者的原始照片。
 *
 * 依來源位址計：視窗內錯太多次就鎖一段時間，鎖住期間連正確的密鑰也不收
 * （收的話，暴力嘗試只是多等一分鐘而已）。WebSocket 與 HTTP 共用同一份計數，
 * 攻擊者不能兩條路各試一輪。
 *
 * 時間由呼叫端傳入，理由同 ratelimit.js：純函式、可以用合成時間測。
 */
export class KeyGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxFails] 視窗內錯幾次就鎖
   * @param {number} [opts.windowMs] 計算失敗次數的視窗
   * @param {number} [opts.lockMs] 鎖多久
   */
  constructor({ maxFails = 10, windowMs = 60_000, lockMs = 60_000 } = {}) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    /** @type {Map<string, {fails: number[], lockedUntil: number}>} */
    this.entries = new Map();
  }

  /** 這個來源現在被鎖住嗎 */
  locked(ip, now = Date.now()) {
    return (this.entries.get(ip)?.lockedUntil ?? 0) > now;
  }

  /** 還要鎖多久（毫秒）；沒鎖回 0 */
  retryAfterMs(ip, now = Date.now()) {
    return Math.max(0, (this.entries.get(ip)?.lockedUntil ?? 0) - now);
  }

  /** 記一次失敗。回傳這次之後是不是被鎖住了 */
  fail(ip, now = Date.now()) {
    this.#prune(now);
    let e = this.entries.get(ip);
    if (!e) { e = { fails: [], lockedUntil: 0 }; this.entries.set(ip, e); }
    e.fails = e.fails.filter((t) => now - t < this.windowMs);
    e.fails.push(now);
    if (e.fails.length >= this.maxFails) {
      e.lockedUntil = now + this.lockMs;
      e.fails = [];
    }
    return e.lockedUntil > now;
  }

  /** 密鑰對了：清掉這個來源的失敗紀錄（打錯幾次之後輸入正確的人不該被記著） */
  succeed(ip) {
    this.entries.delete(ip);
  }

  /**
   * 比對一次。把「鎖住？比對？記帳」收在一處，呼叫端不會漏掉其中一步。
   * @param {(input: string) => boolean} matches 密鑰比對
   * @returns {'ok'|'bad'|'locked'}
   */
  check(ip, input, matches, now = Date.now()) {
    if (this.locked(ip, now)) return 'locked';
    if (matches(input)) { this.succeed(ip); return 'ok'; }
    this.fail(ip, now);
    return 'bad';
  }

  /** 沒有失敗紀錄、鎖也過期的來源清掉，免得 Map 隨到訪過的位址無限成長 */
  #prune(now) {
    if (this.entries.size < 256) return;
    for (const [ip, e] of this.entries) {
      if (e.lockedUntil <= now && e.fails.every((t) => now - t >= this.windowMs)) this.entries.delete(ip);
    }
  }
}
