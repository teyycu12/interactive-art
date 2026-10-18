/**
 * 生成結果的暫存，讓斷線的手機用號碼牌領回自己的角色。
 *
 * 生成請求是一個掛著等結果的 POST。排隊加生成可能要好幾分鐘，這段時間裡
 * 切去別的 App、點開通知、螢幕自動鎖定，iOS 都會把頁面暫停，連線跟著斷掉 ——
 * 而那張圖照樣生完、照樣收費，結果卻沒有地方送。手機只看到「生成服務連不上」，
 * 只好重拍，再付一次錢。
 *
 * 所以每一次的最終結果（成功或失敗都算）都依號碼牌留一段時間。連線看起來
 * 送達了也照樣留：res.end() 成功只代表寫進了作業系統的緩衝區，暫停中的手機
 * 不一定收得到。
 *
 * 號碼牌是手機產生的 128 位元亂數，拿得到號碼牌就等於是本人，不另外驗證。
 */

export class GenerateResults {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]      留多久。要涵蓋「生成中被暫停、幾分鐘後才切回來」
   * @param {number} [opts.maxEntries] 最多留幾筆，超過丟最舊的。貼圖是網址不是內嵌，
   *                                   一筆不到 1 KB；上限只是防有東西狂送號碼牌
   * @param {() => number} [opts.now]
   */
  constructor({ ttlMs = 5 * 60_000, maxEntries = 200, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Map<string, {statusCode: number, body: Buffer, at: number}>} 依存入先後排列 */
    this.entries = new Map();
  }

  /** 存一筆結果。同一張號碼牌重複存，以後到的為準。 */
  put(ticket, statusCode, body) {
    this.#prune();
    this.entries.delete(ticket);
    this.entries.set(ticket, { statusCode, body, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  has(ticket) {
    this.#prune();
    return this.entries.has(ticket);
  }

  /** 領走一筆結果。領過就刪 —— 一張號碼牌只對應一次生成。 */
  take(ticket) {
    this.#prune();
    const entry = this.entries.get(ticket);
    if (!entry) return null;
    this.entries.delete(ticket);
    return { statusCode: entry.statusCode, body: entry.body };
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [ticket, entry] of this.entries) {
      if (entry.at >= cutoff) break;   // 依存入先後排列，遇到沒過期的就可以停
      this.entries.delete(ticket);
    }
  }
}
