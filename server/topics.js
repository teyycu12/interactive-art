/**
 * 話題桌：兩人以上在同一張桌子旁停留一下，手機同時跳出同一題聊天題。
 *
 * 參考 Brella 這類活動平台「預約桌位、坐下來當面聊」的做法，但不用預約：
 * 走過去坐下就有題目。這是場景道具第一次在「沒有主辦端開活動」的空檔也有作用 ——
 * 原本道具只在問卷、尋寶、採收時才派得上用場，大部分時間只是背景。
 *
 * 判準（INTERACTION-DESIGN）：一個人走到桌邊什麼都不會發生；要兩個人以上，
 * 而題目丟給在場所有人 —— 拿到同一題的人自然會轉頭問「那你呢？」。
 *
 * 桌子是哪幾張，來自目前主題的 spots（shared/themes.js，「1號桌」那種號碼牌），
 * 本模組不寫死任何道具。純邏輯：吃座標與時間，回傳該發的題目。
 */

/**
 * @typedef {{id: string, x: number, y: number, r: number, label: string}} Spot
 * @typedef {{id: string, x: number, y: number, disconnectedAt: number|null}} AgentLike
 */

export class TopicTables {
  /**
   * @param {object} opts
   * @param {string[]} opts.questions
   * @param {number} opts.reach
   * @param {number} opts.dwellMs
   * @param {number} opts.groupCooldownMs
   * @param {number} opts.tableGapMs
   * @param {() => number} [opts.rng]
   */
  constructor({ questions, reach, dwellMs, groupCooldownMs, tableGapMs, rng = Math.random }) {
    this.questions = questions;
    this.reach = reach;
    this.dwellMs = dwellMs;
    this.groupCooldownMs = groupCooldownMs;
    this.tableGapMs = tableGapMs;
    this.rng = rng;
    this.enabled = true;
    /** 每張桌子：目前那組人、從何時起是這組人、上次發題時間 */
    this.tables = new Map();
    /** 某組人（排序後的 id）上次拿到題目的時間 */
    this.groupDealtAt = new Map();
    /** 抽題用的袋子：抽完一輪才重洗，同一場不會很快重複 */
    this.bag = [];
  }

  /**
   * 推進一步。
   * @param {Spot[]} spots
   * @param {Iterable<AgentLike>} agents
   * @returns {{spotId: string, label: string, ids: string[], question: string}[]} 這一步要發的題目
   */
  update(spots, agents, now = Date.now()) {
    if (!this.enabled) return [];
    const online = [...agents].filter((a) => a.disconnectedAt === null);
    const deals = [];
    for (const spot of spots) {
      const ids = online
        .filter((a) => Math.hypot(a.x - spot.x, a.y - spot.y) <= spot.r + this.reach)
        .map((a) => a.id)
        .sort();
      const st = this.tables.get(spot.id) ?? { sig: null, since: 0, dealtAt: -Infinity };
      this.tables.set(spot.id, st);
      if (ids.length < 2) {
        st.sig = null;
        continue;
      }
      const sig = ids.join(' ');
      if (sig !== st.sig) {
        st.sig = sig;
        st.since = now;
      }
      if (now - st.since < this.dwellMs) continue;
      if (now - st.dealtAt < this.tableGapMs) continue;
      if (now - (this.groupDealtAt.get(sig) ?? -Infinity) < this.groupCooldownMs) continue;
      st.dealtAt = now;
      this.groupDealtAt.set(sig, now);
      deals.push({ spotId: spot.id, label: spot.label, ids, question: this.#draw() });
    }
    // 舊的組合紀錄不必永遠留著
    for (const [sig, at] of this.groupDealtAt) {
      if (now - at > this.groupCooldownMs) this.groupDealtAt.delete(sig);
    }
    return deals;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.tables.clear();
  }

  #draw() {
    if (!this.bag.length) {
      this.bag = [...this.questions];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }
}
