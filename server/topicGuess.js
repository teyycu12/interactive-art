/**
 * 話題桌的「猜對方」：同桌的人每人被分到一個要猜的對象，同一題、同一組選項。
 *
 * 原本話題桌只發一題聊天題，手機跳出來看一眼就收起來 —— 沒有任何一步需要對方，
 * 用 INTERACTION-DESIGN 的判準看是不及格的（2026-10-29 討論）。現在每個人要做兩件事：
 *
 *   1. 選自己的答案（「你的早餐通常吃什麼？」）—— 這是給別人來問的標準答案。
 *   2. 幫被分到的那個人選（「小明的早餐通常吃什麼？」）—— 不去當面問只能用猜的。
 *
 * 猜的人和被猜的人都送出後才揭曉，兩邊手機都看得到結果。揭曉那一刻
 * （「你怎麼知道！」「蛤你不吃早餐？」）才是對話真正的開頭。
 *
 * 只能猜一次：選項只有三四個，可以重猜的話亂按就會對，「去問」就沒有必要了。
 *
 * 分配是一個圈：排序後每個人猜下一個人，最後一個猜第一個。兩人時就是互猜；
 * 三人以上每人都恰好被一個人猜、也恰好猜一個人，沒有人被冷落。
 *
 * 答案只在記憶體裡、只用來揭曉，回合結束就丟掉，不記錄、不計分（題庫不碰隱私，見 shared/topics.js）。
 * 純邏輯：不碰網路，回傳該通知誰什麼。
 */

/**
 * @typedef {{ask: string, options: string[]}} GuessQuestion
 * @typedef {{round: number, guesser: string, target: string, guess: number, answer: number, correct: boolean}} Reveal
 */

export class TopicGuess {
  /**
   * @param {object} opts
   * @param {number} opts.roundMs 一回合多久沒做完就作廢，人走掉了不能永遠卡著同桌的人
   */
  constructor({ roundMs }) {
    this.roundMs = roundMs;
    this.seq = 0;
    /** @type {Map<number, {id: number, ids: string[], question: GuessQuestion, startedAt: number, self: Map<string, number>, guesses: Map<string, number>, revealed: Set<string>}>} */
    this.rounds = new Map();
    /** 每個人目前所在的回合（只認最新的一回合） @type {Map<string, number>} */
    this.current = new Map();
  }

  /**
   * 開一回合。
   * @param {string[]} ids 已排序的同桌名單（至少兩人）
   * @param {GuessQuestion} question
   * @param {string} [spot] 桌名，重連補送卡片時要用
   * @returns {{round: number, assignments: {id: string, target: string}[]}}
   */
  start(ids, question, now = Date.now(), spot = '') {
    const id = ++this.seq;
    this.rounds.set(id, {
      id, ids: [...ids], question, spot, startedAt: now,
      self: new Map(), guesses: new Map(), revealed: new Set(),
    });
    for (const a of ids) this.current.set(a, id);
    return { round: id, assignments: ids.map((a, i) => ({ id: a, target: ids[(i + 1) % ids.length] })) };
  }

  /**
   * 某人目前那一回合的進度，給重連補送用：手機重整後卡片會不見，
   * 而 isBusy 還把他當成作答中，那張桌子會卡到回合過期都不發新題。
   * @returns {null | {round: number, spot: string, ids: string[], question: GuessQuestion, target: string,
   *   self: number|undefined, guess: number|undefined, reveals: Reveal[]}}
   */
  stateFor(agentId, now = Date.now()) {
    const rd = this.rounds.get(this.current.get(agentId));
    if (!rd || now - rd.startedAt > this.roundMs) return null;
    const i = rd.ids.indexOf(agentId);
    const n = rd.ids.length;
    const target = rd.ids[(i + 1) % n];
    const guesser = rd.ids[(i - 1 + n) % n];
    const reveals = [];
    for (const g of new Set([agentId, guesser])) {
      if (!rd.revealed.has(g)) continue;
      const t = rd.ids[(rd.ids.indexOf(g) + 1) % n];
      const guess = rd.guesses.get(g);
      const answer = rd.self.get(t);
      reveals.push({ round: rd.id, guesser: g, target: t, guess, answer, correct: guess === answer });
    }
    return {
      round: rd.id, spot: rd.spot, ids: rd.ids, question: rd.question, target,
      self: rd.self.get(agentId), guess: rd.guesses.get(agentId), reveals,
    };
  }

  /**
   * 選自己的答案。被猜的人答了之後，先送出猜測、在等的那個人就能揭曉。
   * @returns {{ok: boolean, reason?: string, reveals: Reveal[]}}
   */
  answerSelf(agentId, round, choice, now = Date.now()) {
    const r = this.#open(agentId, round, choice, now);
    if (!r.ok) return { ...r, reveals: [] };
    const rd = r.round;
    if (rd.self.has(agentId)) return { ok: false, reason: 'ALREADY', reveals: [] };
    rd.self.set(agentId, choice);
    const guesser = rd.ids[(rd.ids.indexOf(agentId) - 1 + rd.ids.length) % rd.ids.length];
    return { ok: true, reveals: this.#tryReveal(rd, guesser) };
  }

  /**
   * 猜對方的答案。只能猜一次。
   * @returns {{ok: boolean, reason?: string, reveals: Reveal[]}}
   */
  guess(agentId, round, choice, now = Date.now()) {
    const r = this.#open(agentId, round, choice, now);
    if (!r.ok) return { ...r, reveals: [] };
    const rd = r.round;
    if (rd.guesses.has(agentId)) return { ok: false, reason: 'ALREADY', reveals: [] };
    rd.guesses.set(agentId, choice);
    return { ok: true, reveals: this.#tryReveal(rd, agentId) };
  }

  /**
   * 這個人手上還有沒做完的回合 —— 話題桌在這時不該發新題蓋掉它。
   * 「做完」= 自己的答案選了、猜測也揭曉了。
   */
  isBusy(agentId, now = Date.now()) {
    const rd = this.rounds.get(this.current.get(agentId));
    if (!rd || now - rd.startedAt > this.roundMs) return false;
    return !(rd.self.has(agentId) && rd.revealed.has(agentId));
  }

  /** 過期的回合丟掉。回傳作廢的回合與名單，讓手機把卡片收掉 */
  expire(now = Date.now()) {
    const out = [];
    for (const [id, rd] of this.rounds) {
      if (now - rd.startedAt <= this.roundMs) continue;
      this.rounds.delete(id);
      const left = rd.ids.filter((a) => this.current.get(a) === id);
      for (const a of left) this.current.delete(a);
      if (rd.revealed.size < rd.ids.length) out.push({ round: id, ids: left });
    }
    return out;
  }

  /**
   * 主動離場的人。他所在的回合還沒做完的話整回合作廢 —— 等他答案、或該被他猜的人
   * 不會等到了，與其讓同桌的人空等到過期（期間這張桌子也不發新題），不如直接收掉。
   * @returns {{round: number, ids: string[]} | null} 要通知收卡的人
   */
  forget(agentId) {
    const id = this.current.get(agentId);
    this.current.delete(agentId);
    const rd = this.rounds.get(id);
    if (!rd || rd.revealed.size === rd.ids.length) return null;
    this.rounds.delete(id);
    const left = rd.ids.filter((a) => this.current.get(a) === id);
    for (const a of left) this.current.delete(a);
    return { round: id, ids: left };
  }

  #open(agentId, round, choice, now) {
    const rd = this.rounds.get(round);
    if (!rd || !rd.ids.includes(agentId) || now - rd.startedAt > this.roundMs) return { ok: false, reason: 'GONE' };
    if (!Number.isInteger(choice) || choice < 0 || choice >= rd.question.options.length) return { ok: false, reason: 'BAD_CHOICE' };
    return { ok: true, round: rd };
  }

  #tryReveal(rd, guesser) {
    if (rd.revealed.has(guesser) || !rd.guesses.has(guesser)) return [];
    const target = rd.ids[(rd.ids.indexOf(guesser) + 1) % rd.ids.length];
    if (!rd.self.has(target)) return [];
    rd.revealed.add(guesser);
    const guess = rd.guesses.get(guesser);
    const answer = rd.self.get(target);
    return [{ round: rd.id, guesser, target, guess, answer, correct: guess === answer }];
  }
}
