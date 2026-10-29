/**
 * 話題桌：兩人以上在同一張桌子旁停留一下，手機同時跳出同一題。
 *
 * 參考 Brella 這類活動平台「預約桌位、坐下來當面聊」的做法，但不用預約：
 * 走過去坐下就有題目。這是場景道具第一次在「沒有主辦端開活動」的空檔也有作用 ——
 * 原本道具只在問卷、尋寶、採收時才派得上用場，大部分時間只是背景。
 *
 * 判準（INTERACTION-DESIGN）：一個人走到桌邊什麼都不會發生；要兩個人以上。
 * 題目發下去之後怎麼玩（每人猜同桌的一個人）在 topicGuess.js。
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
   * @param {any[]} opts.questions
   * @param {number} opts.reach
   * @param {number} opts.dwellMs
   * @param {number} opts.groupCooldownMs
   * @param {number} opts.tableGapMs
   * @param {number} [opts.sitMs] 兩人在同一張桌邊一起待滿這麼久，才算「同桌聊天」（見 seatedPairs）
   * @param {() => number} [opts.rng]
   */
  constructor({ questions, reach, dwellMs, groupCooldownMs, tableGapMs, sitMs = Infinity, rng = Math.random }) {
    this.questions = questions;
    this.reach = reach;
    this.dwellMs = dwellMs;
    this.groupCooldownMs = groupCooldownMs;
    this.tableGapMs = tableGapMs;
    this.sitMs = sitMs;
    this.rng = rng;
    this.enabled = true;
    /** 每張桌子：目前那組人、從何時起是這組人、上次發題時間 */
    this.tables = new Map();
    /** 某組人（排序後的 id）上次拿到題目的時間 */
    this.groupDealtAt = new Map();
    /** 每張桌子邊上的每個人從何時開始坐在這裡 @type {Map<string, Map<string, number>>} */
    this.seats = new Map();
    /** 抽題用的袋子：抽完一輪才重洗，同一場不會很快重複 */
    this.bag = [];
  }

  /**
   * 推進一步。
   * @param {Spot[]} spots
   * @param {Iterable<AgentLike>} agents
   * @param {number} [now]
   * @param {(id: string) => boolean} [busy] 這個人手上的題目還沒做完（topicGuess.js）：
   *   有新的人坐下也先不換題，等這一題揭曉 —— 換題會把正在問、正在猜的那一半蓋掉
   * @returns {{spotId: string, label: string, ids: string[], question: any}[]} 這一步要發的題目
   */
  update(spots, agents, now = Date.now(), busy = () => false) {
    if (!this.enabled) return [];
    const online = [...agents].filter((a) => a.disconnectedAt === null);
    const deals = [];
    for (const spot of spots) {
      const ids = online
        .filter((a) => Math.hypot(a.x - spot.x, a.y - spot.y) <= spot.r + this.reach)
        .map((a) => a.id)
        .sort();
      this.#seat(spot.id, ids, now);
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
      if (ids.some(busy)) continue;
      st.dealtAt = now;
      this.groupDealtAt.set(sig, now);
      deals.push({ spotId: spot.id, label: spot.label, ids, question: this.#draw() });
    }
    // 換主題後桌子跟著換，舊桌子邊上的人不能一直被當成還坐著
    const live = new Set(spots.map((s) => s.id));
    for (const id of this.seats.keys()) if (!live.has(id)) this.seats.delete(id);
    // 舊的組合紀錄不必永遠留著
    for (const [sig, at] of this.groupDealtAt) {
      if (now - at > this.groupCooldownMs) this.groupDealtAt.delete(sig);
    }
    return deals;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.tables.clear();
      this.seats.clear();
    }
  }

  /**
   * 在同一張桌邊一起待滿 sitMs 的兩人組合，給「今天遇見的人」記帳用。
   *
   * 不能拿發題當條件：發題的停留門檻只有 dwellMs（2 秒），走過去站一下就有。
   * 這裡逐對計時，而不是看整桌的組合 —— 第三個人坐下來不該讓原本聊了
   * 五十秒的兩個人重新計時。
   *
   * 同一對人只要還坐著，每一次呼叫都會再回報；去重交給記帳的那一方。
   * @returns {[string, string][]}
   */
  seatedPairs(now = Date.now()) {
    const pairs = [];
    for (const seated of this.seats.values()) {
      const list = [...seated];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (now - Math.max(list[i][1], list[j][1]) >= this.sitMs) pairs.push([list[i][0], list[j][0]]);
        }
      }
    }
    return pairs;
  }

  /** 更新某張桌邊的人：新來的從現在起算，離開的移除 */
  #seat(spotId, ids, now) {
    const prev = this.seats.get(spotId) ?? new Map();
    const next = new Map();
    for (const id of ids) next.set(id, prev.get(id) ?? now);
    this.seats.set(spotId, next);
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
