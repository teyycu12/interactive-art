/**
 * 今天來過的人（大合照用）。
 *
 * 大合照原本只拍「按下快門那一刻在場上的人」：先走的人、手機剛好斷線的人，
 * 明明玩了一整場，合照上卻沒有他（2026-10-19 主持人回報）。這裡記下每個
 * 進過場的人，合照時把「有參與」但不在畫面裡的人一起放進照片下方的名單。
 *
 * 「有參與」的門檻：操控過角色移動，或有社交連結（配對、揮手、私訊……）。
 * 只是掃了 QR、進場後就把手機放下的人不算 —— 不然名單會被路過的人灌滿。
 * 社交連結這裡不記，由呼叫端在合照時查社交圖譜與相遇名單（見 index.js），
 * 這樣不必在每一種互動事件裡都多掛一個呼叫。
 *
 * 身分目錄（persistence.js 的 Directory）不能拿來用：它在主動離場時就忘掉那個人
 * （憑證要撤銷），但先走的人正是最需要被記住的那一群。
 */
export class Attendance {
  constructor({ ttlMs = 12 * 60 * 60 * 1000, limit = 500 } = {}) {
    /** @type {Map<string, {id: string, name: string, avatar: object|null, moved: boolean, firstSeenAt: number, lastSeenAt: number}>} */
    this.entries = new Map();
    this.ttlMs = ttlMs;
    this.limit = limit;
  }

  /** 進場（或重連）時記下名字與外觀；外觀之後換過的話，合照時以場上的為準 */
  note(agent, now = Date.now()) {
    if (!agent?.id) return;
    const prev = this.entries.get(agent.id);
    this.entries.set(agent.id, {
      id: agent.id,
      name: agent.name ?? prev?.name ?? '',
      avatar: agent.avatar ?? prev?.avatar ?? null,
      moved: prev?.moved ?? false,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
    this.#prune(now);
  }

  /** 推過搖桿（超過死區）。搖桿每秒送十幾次，已記過的直接略過 */
  markMoved(id) {
    const e = this.entries.get(id);
    if (e && !e.moved) e.moved = true;
  }

  /** 被主辦端請出場、或換了新角色：舊的那一個不該出現在合照名單上 */
  forget(id) {
    return this.entries.delete(id);
  }

  /**
   * 有參與的人，依第一次進場的先後。
   * @param {(id: string) => boolean} hasSocial 這個人有沒有社交連結
   */
  participants(hasSocial = () => false) {
    return [...this.entries.values()]
      .filter((e) => e.moved || hasSocial(e.id))
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  }

  #prune(now = Date.now()) {
    for (const [id, e] of this.entries) {
      if (now - e.lastSeenAt > this.ttlMs) this.entries.delete(id);
    }
    if (this.entries.size <= this.limit) return;
    const sorted = [...this.entries.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const e of sorted.slice(0, this.entries.size - this.limit)) this.entries.delete(e.id);
  }

  export() {
    return [...this.entries.values()];
  }

  hydrate(rows) {
    if (!Array.isArray(rows)) return this;
    for (const r of rows) {
      if (typeof r?.id !== 'string' || !r.id) continue;
      this.entries.set(r.id, {
        id: r.id,
        name: typeof r.name === 'string' ? r.name : '',
        avatar: r.avatar ?? null,
        moved: r.moved === true,
        firstSeenAt: Number(r.firstSeenAt) || Date.now(),
        lastSeenAt: Number(r.lastSeenAt) || Date.now(),
      });
    }
    this.#prune();
    return this;
  }
}
