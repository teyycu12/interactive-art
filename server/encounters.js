/**
 * 今天遇見的人：手機上的名單與紀念卡讀這一本帳，不讀社交圖譜。
 *
 * ── 為什麼不直接把互動寫進社交圖譜 ──
 * 圖譜的邊代表「經雙方確認的實體接觸」（socialgraph.js 檔頭），是研究資料，
 * 大螢幕的連線圖、Boids 的凝聚偏置、賓果的「還不認識的人」都讀它。
 * 揮手、乾杯、同桌這些訊號比配對碼薄得多，混進去會稀釋那份資料
 * （greetings.js、bingo.js 檔頭都寫了不寫圖譜的理由）。
 *
 * 但只算配對的話，兩個人一起玩了賓果、碰了杯、在桌邊聊了十分鐘，
 * 只因為沒互輸配對碼，紀念卡上就沒有對方 —— 玩家會覺得不公平。
 * 所以分兩本：圖譜維持嚴格，這本帳收「兩個人都做了動作」的所有互動。
 *
 * ── 單方面的互動只記在主動的那一方 ──
 * 賓果填格只靠一方輸入碼，碼也可能是偷看來的。輸碼的人確實去找過對方，算數；
 * 被輸碼的人不該被塞進一個陌生名字。所以 A 的名單上有 B、B 的上面卻沒有 A 是正常的。
 *
 * ── 私訊要對方回過才算 ──
 * 單方面傳訊息不算交集。先把「誰寫給過誰」記下來，反方向也出現時才兩邊都記。
 *
 * 封鎖不在這裡處理：封鎖關係只在私訊模組的記憶體裡，名單由呼叫端在送出前濾掉
 * （peersOf 的 hidden）。這樣解除封鎖時名單會自己回來，不必再補記。
 *
 * 純邏輯，不碰 WebSocket。
 */

import { ENCOUNTER_KINDS, VIA } from '../shared/encounters.js';

const ORDER = new Map(ENCOUNTER_KINDS.map((k, i) => [k.id, i]));
const ONE_WAY = new Set(ENCOUNTER_KINDS.filter((k) => k.oneWay).map((k) => k.id));

/**
 * 排序的層級：配對過的 → 有雙方動作的 → 只有單方面的。
 * 數字小的排前面。
 */
const tierOf = (via) => {
  if (via.has(VIA.PAIR)) return 0;
  for (const v of via) if (!ONE_WAY.has(v)) return 1;
  return 2;
};

export class Encounters {
  constructor() {
    /** 某人 → 他遇見的人 → 怎麼遇見、第一次是什麼時候 @type {Map<string, Map<string, {via: Set<string>, at: number}>>} */
    this.byId = new Map();
    /** 「from to」：from 傳過訊息給 to，等對方回 @type {Set<string>} */
    this.wroteTo = new Set();
  }

  /** 記在 from 的名單上。回傳名單是否有變動 */
  #note(from, to, via, now) {
    if (!ORDER.has(via)) return false;
    let peers = this.byId.get(from);
    if (!peers) this.byId.set(from, (peers = new Map()));
    const e = peers.get(to);
    if (!e) {
      peers.set(to, { via: new Set([via]), at: now });
      return true;
    }
    if (e.via.has(via)) return false;
    e.via.add(via);
    return true;
  }

  /**
   * 兩人都做了動作的互動，兩邊各記一筆。
   * @returns {boolean} 任一方的名單是否有變動（有才需要推送）
   */
  meet(a, b, via, now = Date.now()) {
    if (!a || !b || a === b) return false;
    const x = this.#note(a, b, via, now);
    const y = this.#note(b, a, via, now);
    return x || y;
  }

  /** 單方面的互動（賓果），只記在主動的那一方 */
  noteOneWay(from, to, via, now = Date.now()) {
    if (!from || !to || from === to) return false;
    return this.#note(from, to, via, now);
  }

  /**
   * 一則私訊送達。對方先前也寫給過自己，才算兩人聊過。
   * @returns {boolean} 名單是否有變動
   */
  wrote(from, to, now = Date.now()) {
    if (!from || !to || from === to) return false;
    this.wroteTo.add(`${from} ${to}`);
    if (!this.wroteTo.has(`${to} ${from}`)) return false;
    return this.meet(from, to, VIA.MESSAGE, now);
  }

  /**
   * 某人的名單，已排好序：配對過的在前，再來是雙方動作種類多的，
   * 只有單方面的排最後；同一層先遇到的在前。
   * @param {string} id
   * @param {{hidden?: (peerId: string) => boolean}} [opts] 例如封鎖關係
   * @returns {{id: string, via: string[], at: number}[]}
   */
  peersOf(id, { hidden = () => false } = {}) {
    const peers = this.byId.get(id);
    if (!peers) return [];
    return [...peers]
      .filter(([pid]) => !hidden(pid))
      .map(([pid, e]) => ({ id: pid, via: e.via, at: e.at }))
      .sort((p, q) => tierOf(p.via) - tierOf(q.via) || q.via.size - p.via.size || p.at - q.at)
      .map((p) => ({ id: p.id, via: [...p.via].sort((u, v) => ORDER.get(u) - ORDER.get(v)), at: p.at }));
  }

  /**
   * 某人離場（主動或被移除）：丟掉他自己的名單與未回的私訊。
   *
   * 別人名單上的他保留 —— 先走的人仍是今天遇見過的人。
   * 他重新進場會拿到新的 id，舊名單不會再被讀到，留著只是佔記憶體。
   */
  forget(id) {
    this.byId.delete(id);
    for (const k of this.wroteTo) {
      const [from, to] = k.split(' ');
      if (from === id || to === id) this.wroteTo.delete(k);
    }
  }

  /** 快照只存名單，不存「誰寫給過誰」—— 私訊本身也不落地（見 messages.js） */
  export() {
    return [...this.byId].map(([id, peers]) => ({
      id,
      peers: [...peers].map(([pid, e]) => ({ id: pid, via: [...e.via], at: e.at })),
    }));
  }

  hydrate(rows) {
    if (!Array.isArray(rows)) return this;
    for (const r of rows) {
      if (typeof r?.id !== 'string' || !Array.isArray(r.peers)) continue;
      for (const p of r.peers) {
        if (typeof p?.id !== 'string' || !Array.isArray(p.via)) continue;
        const at = Number(p.at) || Date.now();
        for (const v of p.via) this.#note(r.id, p.id, v, at);
      }
    }
    return this;
  }

  /**
   * 舊快照沒有這本帳時，從社交圖譜補回配對過的人 ——
   * 活動中途升級伺服器，不能讓大家的名單突然清空。
   * @param {{edges: {a: string, b: string, at: number}[]}} graphExport
   */
  seedFromGraph(graphExport) {
    for (const e of graphExport?.edges ?? []) this.meet(e.a, e.b, VIA.PAIR, Number(e.at) || Date.now());
    return this;
  }
}
