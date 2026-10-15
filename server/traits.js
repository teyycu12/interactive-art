/**
 * 參與者身上的標籤：agentId → key → {value, label, at, ...}
 *
 * 原本寫在轉場問卷（survey.js）裡；轉場問卷移除後抽出來單獨保留，因為還有兩個使用者：
 *   - 進場人格問卷：類型記成 `persona` 標籤（shared/persona.js），主辦端名冊與分佈都讀它。
 *   - 人物賓果：格子條件可以是「某個標籤為某值的人」（server/index.js 的 bingo 條件）。
 *
 * 跟著角色走，不跟著題目走。存檔格式沿用原本 survey 快照裡的 `traits` 陣列，
 * 舊快照（`snapshot.survey.traits`）照樣讀得回來 —— 伺服器重開後參與者以原憑證接回
 * 同一個角色 id，標籤必須還在，否則以標籤為條件的賓果格會把所有人都判成不符合。
 */

export class TraitStore {
  constructor() {
    /** @type {Map<string, Map<string, object>>} */
    this.traits = new Map();
  }

  /** 寫入標籤。以 Map 存而非物件，避開鍵名與原型衝突的問題。 */
  setTrait(agentId, key, entry) {
    if (!this.traits.has(agentId)) this.traits.set(agentId, new Map());
    this.traits.get(agentId).set(key, entry);
  }

  /** 某人身上某個標籤的完整內容，沒有回 null */
  traitOf(agentId, key) { return this.traits.get(agentId)?.get(key) ?? null; }

  /** 某人身上所有標籤，攤平成純物件供 HOST_STATE 與匯出使用 */
  traitsOf(agentId) {
    const m = this.traits.get(agentId);
    if (!m) return {};
    return Object.fromEntries([...m].map(([k, v]) => [k, { value: v.value, label: v.label }]));
  }

  /** 標籤為某個值的所有人 */
  agentsWith(key, value) {
    const out = [];
    for (const [agentId, m] of this.traits) if (m.get(key)?.value === value) out.push(agentId);
    return out;
  }

  /**
   * 某個標籤在場上的分佈，只算還在場的人。
   * @param {string} key
   * @param {(id: string) => boolean} isPresent
   * @returns {Map<string, number>}
   */
  spread(key, isPresent = () => true) {
    const counts = new Map();
    for (const [agentId, m] of this.traits) {
      const t = m.get(key);
      if (!t || !isPresent(agentId)) continue;
      counts.set(t.value, (counts.get(t.value) ?? 0) + 1);
    }
    return counts;
  }

  /** 忘掉某個人的所有標籤（主動離場或被移除時呼叫，與角色一起消失） */
  forget(agentId) { this.traits.delete(agentId); }

  /** @param {Array<{agentId: string, tags: object}>} rows */
  hydrate(rows) {
    if (!Array.isArray(rows)) return this;
    this.traits = new Map(
      rows.filter((r) => typeof r?.agentId === 'string')
        .map((r) => [r.agentId, new Map(Object.entries(r.tags ?? {}))]),
    );
    return this;
  }

  export() {
    return [...this.traits].map(([agentId, m]) => ({ agentId, tags: Object.fromEntries(m) }));
  }
}
