/**
 * 揮手：要對方回應才算數的社交動作。
 *
 * 原本三個表情鍵都只是在自己頭上冒一個圖示：沒有對象、沒有人回應、
 * 也不改變任何事。依 INTERACTION-DESIGN「這個機制需不需要開口講話」，
 * 它不及格 —— 按的人沒有理由轉頭看旁邊的人，玩兩下就沒人按了。
 *
 * 現在：
 *
 * - **揮手**對準最近的人。對方手機跳出「某某在跟你揮手」，回揮才算打了招呼。
 * - 原本還有**乾杯**（附近兩人同時按才碰得到杯），2026-10-17 依主持人要求移除。
 *
 * **成功不寫進社交圖譜。** 圖譜的邊代表「經雙方確認的實體接觸」
 * （socialgraph.js 檔頭），配對碼保證兩人真的講過話；互相揮手是薄得多的
 * 訊號，混進去會稀釋研究資料。這裡只回報結果，由呼叫端決定要不要記錄。
 *
 * **尊重私訊的封鎖**（server/messages.js）。揮手邀請也是一種「讓對方手機跳出我名字」
 * 的接觸，封鎖了卻擋不住揮手，封鎖就形同虛設。規則照私訊：
 * - 對方封鎖了我：照樣回我「已揮出」，但不送邀請、也不可能成功 ——
 *   告訴他「你被封鎖了」只會換來換個方式繼續騷擾。
 * - 我封鎖了對方：不選他當對象（我自己知道我封鎖了他）。
 *
 * 純邏輯：只吃角色座標與時間，不碰 WebSocket，方便測試。
 */

/**
 * @typedef {{id: string, x: number, y: number, disconnectedAt: number|null}} AgentLike
 */

export class Greetings {
  /**
   * @param {object} opts
   * @param {number} opts.radius          兩人相距多近才算「身邊的人」
   * @param {number} opts.waveWindowMs    揮手後等對方回揮的時間
   * @param {(by: string, target: string) => boolean} [opts.isBlocked] by 是否封鎖了 target
   */
  constructor({ radius, waveWindowMs, isBlocked = () => false }) {
    this.radius = radius;
    this.isBlocked = isBlocked;
    this.waveWindowMs = waveWindowMs;
    /** 揮手 → 等對方回揮 @type {Map<string, {to: string, until: number}>} */
    this.waves = new Map();
  }

  /**
   * 揮手。
   *
   * @param {string} fromId
   * @param {Map<string, AgentLike>} agents
   * @param {number} now
   * @param {string} [targetId] 回揮時指定對象（手機上按「揮回去」）。
   *   不在身邊就退回找最近的人 —— 對方可能已經走開，按了沒反應比揮錯人更糟。
   * @returns {{kind: 'mutual', a: string, b: string}
   *          |{kind: 'invite', from: string, to: string, silent?: true}
   *          |{kind: 'nobody'}}
   *   silent：對方封鎖了我。照樣告訴我「已揮出」，但呼叫端不可把邀請送給對方。
   */
  wave(fromId, agents, now, targetId) {
    const me = agents.get(fromId);
    if (!me) return { kind: 'nobody' };

    const explicit = targetId && agents.get(targetId);
    const to = explicit && this.#near(me, explicit) && !this.isBlocked(fromId, explicit.id)
      ? explicit
      : this.#nearest(me, agents, (other) => !this.isBlocked(fromId, other.id));
    if (!to) return { kind: 'nobody' };

    // 不登記：沒有登記就不可能湊成互相揮手
    if (this.isBlocked(to.id, fromId)) return { kind: 'invite', from: fromId, to: to.id, silent: true };

    const theirs = this.waves.get(to.id);
    if (theirs && theirs.to === fromId && theirs.until >= now) {
      this.waves.delete(to.id);
      this.waves.delete(fromId);
      return { kind: 'mutual', a: to.id, b: fromId };
    }
    this.waves.set(fromId, { to: to.id, until: now + this.waveWindowMs });
    return { kind: 'invite', from: fromId, to: to.id };
  }

  /** 離場時清掉。否則對方會對著一個已經不在的人揮手成功 */
  drop(id) {
    this.waves.delete(id);
    for (const [from, w] of this.waves) if (w.to === id) this.waves.delete(from);
  }

  /** 清掉過期的登記。不清也不會判錯（每次都比對 until），只是避免 Map 一直長 */
  prune(now) {
    for (const [id, w] of this.waves) if (w.until < now) this.waves.delete(id);
  }

  #eitherBlocked(a, b) {
    return this.isBlocked(a, b) || this.isBlocked(b, a);
  }

  #near(a, b) {
    return b.disconnectedAt === null && Math.hypot(b.x - a.x, b.y - a.y) <= this.radius;
  }

  /** 身邊最近的在線者。斷線的人手機收不到邀請，揮給他等於揮給空氣 */
  #nearest(me, agents, accept = () => true) {
    let best = null;
    let bestD = Infinity;
    for (const other of agents.values()) {
      if (other.id === me.id || other.disconnectedAt !== null || !accept(other)) continue;
      const d = Math.hypot(other.x - me.x, other.y - me.y);
      if (d <= this.radius && d < bestD) { best = other; bestD = d; }
    }
    return best;
  }
}
