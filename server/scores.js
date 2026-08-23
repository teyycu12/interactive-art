/**
 * 積分帳本（Score Ledger）
 *
 * 本檔只做一件事：記錄「誰、在什麼時候、因為什麼、得了幾分」。
 * 它不知道配對是什麼，也不知道問答是什麼 —— 任務系統與問答系統
 * 各自算完該給多少分之後呼叫 award()，帳本負責累計、排名與匯出。
 *
 * 這個切法的理由：積分是跨玩法累計的。若把分數塞進 MissionBoard，
 * 問答就得自己再存一份，兩份加總的地方（排行榜、大螢幕、匯出）
 * 都要各自合併，每新增一種得分來源就要改所有合併點。
 * 帳本獨立之後，新增玩法只需要多呼叫一次 award()。
 *
 * 分數不隨任務結算而歸零：一場活動裡任務會發布好幾輪、問答會出好幾題，
 * 排行榜要反映的是整場的累積，而不是最後一題的結果。
 */

export class ScoreBoard {
  constructor() {
    /** @type {Map<string, {total: number, bySource: Map<string, number>, lastAt: number}>} */
    this.ledger = new Map();
    /** @type {object[]} 得分流水，供 WP-C 行為分析 */
    this.events = [];
  }

  #entry(agentId) {
    let e = this.ledger.get(agentId);
    if (!e) {
      e = { total: 0, bySource: new Map(), lastAt: 0 };
      this.ledger.set(agentId, e);
    }
    return e;
  }

  /**
   * 記一筆得分。
   * @param {string} agentId
   * @param {number} points 非負整數，0 分也會留下流水（例如答錯）
   * @param {{source: string, ref?: string|null, detail?: object}} meta
   * @returns {{total: number, delta: number}}
   */
  award(agentId, points, { source, ref = null, detail = {} } = {}) {
    const delta = Math.max(0, Math.round(Number(points) || 0));
    const e = this.#entry(agentId);
    e.total += delta;
    e.bySource.set(source, (e.bySource.get(source) ?? 0) + delta);
    e.lastAt = Date.now();
    this.events.push({ agentId, points: delta, source, ref, at: e.lastAt, ...detail });
    return { total: e.total, delta };
  }

  totalOf(agentId) {
    return this.ledger.get(agentId)?.total ?? 0;
  }

  breakdownOf(agentId) {
    const e = this.ledger.get(agentId);
    return e ? Object.fromEntries(e.bySource) : {};
  }

  /**
   * 名次表。
   *
   * 同分時「先達到的人在前」—— 用最後一次得分的時間排序。
   * 這是唯一不需要額外資料、又符合現場直覺的破同分規則：
   * 兩人都是 300 分時，先衝到 300 的那位排前面。
   *
   * @param {(id: string) => boolean} [isPresent] 只列出仍在場的人；
   *   離場者的分數留在帳本裡供匯出，但不該繼續佔著排行榜。
   */
  standings(isPresent = null) {
    const rows = [];
    for (const [id, e] of this.ledger) {
      if (isPresent && !isPresent(id)) continue;
      rows.push({ id, score: e.total, lastAt: e.lastAt });
    }
    rows.sort((a, b) => (b.score - a.score) || (a.lastAt - b.lastAt));

    // 同分同名次：第 1、2 名同分時，下一位是第 3 名而不是第 2 名
    let rank = 0;
    let prevScore = null;
    rows.forEach((row, i) => {
      if (row.score !== prevScore) { rank = i + 1; prevScore = row.score; }
      row.rank = rank;
    });
    return rows;
  }

  /** 某人的名次（不在場或無得分時回傳 null） */
  rankOf(agentId, isPresent = null) {
    return this.standings(isPresent).find((r) => r.id === agentId)?.rank ?? null;
  }

  /**
   * 排行榜。名稱由呼叫端提供 —— 帳本只認 id，
   * 姓名屬於狀態矩陣的資料，不該在這裡存第二份。
   */
  leaderboard(limit, nameOf = () => '', isPresent = null) {
    return this.standings(isPresent).slice(0, limit).map((r) => ({
      id: r.id, name: nameOf(r.id), score: r.score, rank: r.rank,
    }));
  }

  /**
   * 由快照還原。
   *
   * 只還原總分與流水，不還原任何與連線有關的東西 ——
   * 帳本本來就不知道誰在線上，這也是它能安全跨重啟的原因。
   */
  hydrate(dump) {
    if (!dump || typeof dump !== 'object') return this;
    for (const [id, e] of Object.entries(dump.totals ?? {})) {
      const total = Number(e?.total) || 0;
      if (total <= 0) continue;
      this.ledger.set(id, {
        total,
        bySource: new Map(Object.entries(e.bySource ?? {})),
        lastAt: Number(e.lastAt) || 0,
      });
    }
    if (Array.isArray(dump.events)) this.events = dump.events;
    return this;
  }

  /** 匯出供 WP-C 分析。與社交圖譜一致，只帶 id 不帶姓名 */
  export() {
    return {
      totals: Object.fromEntries(
        [...this.ledger].map(([id, e]) => [id, {
          total: e.total, bySource: Object.fromEntries(e.bySource), lastAt: e.lastAt,
        }]),
      ),
      events: this.events,
    };
  }
}
