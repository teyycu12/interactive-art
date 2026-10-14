/**
 * 角色生成的排隊。
 *
 * 原本超過並發上限的請求一律立刻回 too_busy：30 人同時按拍照時，4 個人在生成、
 * 26 個人看到「同時生成的人太多」，然後靠各自狂按重拍去搶空位 —— 誰先輪到
 * 是隨機的，不是先來先到，而且每一次重按都要重新上傳一張數 MB 的照片。
 *
 * 現在改為依先後排隊。兩個刻意的設計：
 *
 * 1. **逾時從輪到才開始算。** 排隊時間不計入 GENERATE_TIMEOUT_MS ——
 *    否則排在第 20 位的人還沒送出就已經逾時，排了等於白排。
 *    排隊本身另有上限（maxQueued），超過才回 too_busy。
 *
 * 2. **號碼牌由手機產生。** 生成請求是一個掛著等結果的 POST，手機沒辦法從
 *    同一條連線知道自己排第幾。手機送出時附上自己產生的號碼牌，另外輪詢
 *    status() —— 號碼牌讓兩條請求對得上，伺服器不必先發號再收照片。
 *
 * 排隊中的人斷線（關分頁、切 App 被系統殺掉）必須呼叫 cancel()，
 * 否則後面的人會白等一個永遠不會送出的位子。
 */

const TICKET_RE = /^[0-9a-f]{16,64}$/;

/** 號碼牌格式檢查。格式不對就當作沒帶，由伺服器自己產一張。 */
export function isValidTicket(ticket) {
  return typeof ticket === 'string' && TICKET_RE.test(ticket);
}

export class GenerateQueue {
  /**
   * @param {object} opts
   * @param {number} opts.maxActive  同時送去生成的上限（與生成服務的 GEN_MAX_CONCURRENT 相同）
   * @param {number} opts.maxQueued  排隊人數上限，超過才回 too_busy
   * @param {number} [opts.typicalMs] 還沒有實測資料時，用來估計等待時間的單次耗時
   */
  constructor({ maxActive, maxQueued, typicalMs = 28_000 }) {
    this.maxActive = Math.max(1, maxActive);
    this.maxQueued = Math.max(0, maxQueued);
    this.typicalMs = typicalMs;
    /** @type {{ticket: string, run: (done: () => void) => void}[]} */
    this.waiting = [];
    /** @type {Set<string>} */
    this.active = new Set();
    /** 最近幾次的實際耗時，用來估計排隊時間 */
    this.recentMs = [];
  }

  /**
   * 排進隊伍。有空位就立刻執行 run，否則等前面的人做完。
   *
   * run 收到一個 done()，生成結束（成功、失敗、逾時都算）時必須呼叫且只呼叫一次。
   *
   * @returns {'started'|'queued'|'full'|'duplicate'}
   */
  enqueue(ticket, run) {
    if (this.active.has(ticket) || this.waiting.some((w) => w.ticket === ticket)) {
      return 'duplicate';
    }
    if (this.active.size < this.maxActive) {
      this.#start(ticket, run);
      return 'started';
    }
    if (this.waiting.length >= this.maxQueued) return 'full';
    this.waiting.push({ ticket, run });
    return 'queued';
  }

  /** 排隊中的人放棄。已經在生成的不受影響（那筆錢已經付了，讓它做完）。 */
  cancel(ticket) {
    const i = this.waiting.findIndex((w) => w.ticket === ticket);
    if (i >= 0) this.waiting.splice(i, 1);
    return i >= 0;
  }

  /**
   * 查詢某張號碼牌的狀態。
   *
   * @returns {{state: 'queued', ahead: number, etaMs: number}
   *          | {state: 'active'}
   *          | null}  null 代表沒有這張號碼牌（已完成、已取消或從未出現）
   */
  status(ticket) {
    if (this.active.has(ticket)) return { state: 'active' };
    const i = this.waiting.findIndex((w) => w.ticket === ticket);
    if (i < 0) return null;
    return { state: 'queued', ahead: i, etaMs: this.estimateWaitMs(i) };
  }

  /**
   * 排在第 position 位（0 起算）的人，大約還要等多久才輪到。
   *
   * 粗估就好：每一輪放行 maxActive 個人，一輪的時間取最近實測耗時的中位數。
   * 現在正在跑的那一輪平均已經過了一半，所以只算半輪。
   */
  estimateWaitMs(position) {
    const per = this.#typicalDuration();
    const rounds = Math.floor(position / this.maxActive);
    return Math.round(per * (rounds + 0.5));
  }

  get size() {
    return { active: this.active.size, waiting: this.waiting.length };
  }

  #typicalDuration() {
    if (this.recentMs.length === 0) return this.typicalMs;
    const sorted = [...this.recentMs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  #start(ticket, run) {
    this.active.add(ticket);
    const startedAt = Date.now();
    let finished = false;
    const done = () => {
      if (finished) return;   // 成功、逾時、斷線可能先後各觸發一次，只能還一次位子
      finished = true;
      this.active.delete(ticket);
      const ms = Date.now() - startedAt;
      // 秒回的失敗（服務沒開、熔斷器開著）不是生成耗時，算進去會讓估計失準
      if (ms > 3000) {
        this.recentMs.push(ms);
        if (this.recentMs.length > 20) this.recentMs.shift();
      }
      this.#drain();
    };
    try {
      run(done);
    } catch (err) {
      // 不往外拋：#drain() 是在前一個人的 done() 裡呼叫的，拋出去會讓
      // 排在後面的人全部卡住，而那些人跟這個錯誤毫無關係。
      console.error('[generateQueue] run 拋出例外：', err);
      done();
    }
  }

  #drain() {
    while (this.active.size < this.maxActive && this.waiting.length > 0) {
      const next = this.waiting.shift();
      this.#start(next.ticket, next.run);
    }
  }
}
