/**
 * 人物賓果：每人一張 3×3 卡，每格是「找一個〔條件〕的人」。
 *
 * ── 為什麼是這個玩法 ──
 * 參考實體活動常見的 networking bingo。它天生符合 INTERACTION-DESIGN 的判準：
 * 每一格都得開口問人（「你是什麼類型？」「可以給我你的配對碼嗎？」），而且
 * **同一個人在一張卡上只能填一格**，逼你去認識不同的人。
 *
 * 條件全部取自系統本來就有的資料，不用另外問：
 *   - 服裝顏色（大螢幕上看得到，但還是得過去要碼）
 *   - 進場人格類型（只有本人知道 —— 非開口問不可）
 *   - 轉場問卷的答案
 *   - 「還不認識的人」（社交圖譜裡沒有連線）：條件不夠湊滿 9 格時補位，永遠湊得出來
 *
 * ── 防枚舉 ──
 * 填格要輸入對方的配對碼（4 位數），伺服器驗證對方符合條件。這等於一個
 * 「碼 → 這人是否符合」的查詢，沒有冷卻就能窮舉。呼叫端必須每一次嘗試都記
 * 配對的冷卻（pairing.noteClaim），不論成功失敗 —— 見 INTERACTION-DESIGN
 * 「顏色預檢不可成為枚舉管道」。本模組只管規則。
 *
 * ── 不寫進社交圖譜 ──
 * 圖譜的邊要「經雙方確認」；賓果填格只靠一方輸入碼（碼也可能是偷看來的）。
 *
 * 純邏輯：條件的判定由呼叫端注入（test 函式），本模組不碰 WebSocket 與角色資料。
 */

import { randomUUID } from 'node:crypto';

export const BINGO_SIZE = 3;
const CELLS = BINGO_SIZE * BINGO_SIZE;

/** 所有可能連線：三橫、三直、兩斜 */
export const BINGO_LINES = (() => {
  const n = BINGO_SIZE;
  const lines = [];
  for (let r = 0; r < n; r++) lines.push([...Array(n)].map((_, c) => r * n + c));
  for (let c = 0; c < n; c++) lines.push([...Array(n)].map((_, r) => r * n + c));
  lines.push([...Array(n)].map((_, i) => i * n + i));
  lines.push([...Array(n)].map((_, i) => i * n + (n - 1 - i)));
  return lines;
})();

/** 補位條件的 id。判定由呼叫端注入（需要社交圖譜） */
export const STRANGER = 'STRANGER';

export const BINGO_ERRORS = {
  NO_ROUND: 'NO_ROUND',
  NO_CARD: 'NO_CARD',
  BAD_CELL: 'BAD_CELL',
  FILLED: 'FILLED',
  SELF: 'SELF',
  USED: 'USED',            // 這個人已經填在你卡上的另一格
  MISMATCH: 'MISMATCH',    // 對方不符合這格的條件
  NOT_FOUND: 'NOT_FOUND',  // 查無此碼（由呼叫端判定）
  COOLDOWN: 'COOLDOWN',    // 太快（由呼叫端判定）
};

/**
 * @typedef {{id: string, label: string}} Condition
 * @typedef {(agentId: string, conditionId: string, fromId: string) => boolean} Tester
 */

export class BingoRound {
  constructor() {
    /** @type {null | {id: string, startedAt: number, endsAt: number|null,
     *   cards: Map<string, {cells: {cond: Condition, by: string|null}[], lines: number}>,
     *   pool: Condition[]}} */
    this.round = null;
  }

  get isActive() { return this.round !== null; }

  /**
   * 開一輪。
   * @param {string[]} agentIds 場上的人
   * @param {Condition[]} pool 候選條件（呼叫端已濾掉「場上沒有任何人符合」的）
   * @param {Tester} test 判定某人是否符合某條件
   * @param {{durationMs?: number|null, rng?: () => number}} [opts]
   */
  start(agentIds, pool, test, { durationMs = null, rng = Math.random, now = Date.now() } = {}) {
    if (this.round) return { ok: false, reason: '已有進行中的賓果，請先結束' };
    if (agentIds.length < 2) return { ok: false, reason: '至少需要 2 位參與者才能開始賓果' };
    this.test = test;
    this.rng = rng;
    this.round = {
      id: `bgo_${randomUUID().slice(0, 8)}`,
      startedAt: now,
      endsAt: durationMs ? now + durationMs : null,
      cards: new Map(),
      pool,
    };
    for (const id of agentIds) this.dealCard(id, agentIds);
    return { ok: true, round: this.round };
  }

  /**
   * 發一張卡。中途進場的人也走這裡。
   *
   * 只放「場上除了自己以外至少有一人符合」的條件 —— 一格怎麼找都找不到人，
   * 那條線就永遠連不成，等於在懲罰參與者。不夠 9 格時用 STRANGER 補。
   */
  dealCard(agentId, presentIds) {
    const r = this.round;
    if (!r) return null;
    if (r.cards.has(agentId)) return r.cards.get(agentId);
    const others = presentIds.filter((id) => id !== agentId);
    const doable = r.pool.filter((c) => others.some((o) => this.test(o, c.id, agentId)));
    const picked = shuffle(doable, this.rng).slice(0, CELLS);
    while (picked.length < CELLS) picked.push({ id: STRANGER, label: '找一個你還不認識的人' });
    // 補位的格子打散，不要全擠在最後一列
    const cells = shuffle(picked, this.rng).map((cond) => ({ cond, by: null }));
    const card = { cells, lines: 0 };
    r.cards.set(agentId, card);
    return card;
  }

  /**
   * 填一格。對方是誰由呼叫端依配對碼查出。
   * @returns {{ok: true, cell: number, newLines: number, full: boolean}
   *          | {ok: false, reason: string}}
   */
  claim(fromId, cellIndex, targetId) {
    const r = this.round;
    if (!r) return { ok: false, reason: BINGO_ERRORS.NO_ROUND };
    const card = r.cards.get(fromId);
    if (!card) return { ok: false, reason: BINGO_ERRORS.NO_CARD };
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= CELLS) {
      return { ok: false, reason: BINGO_ERRORS.BAD_CELL };
    }
    const cell = card.cells[cellIndex];
    if (cell.by) return { ok: false, reason: BINGO_ERRORS.FILLED };
    if (targetId === fromId) return { ok: false, reason: BINGO_ERRORS.SELF };
    if (card.cells.some((c) => c.by === targetId)) return { ok: false, reason: BINGO_ERRORS.USED };
    if (!this.test(targetId, cell.cond.id, fromId)) return { ok: false, reason: BINGO_ERRORS.MISMATCH };

    cell.by = targetId;
    const lines = BINGO_LINES.filter((l) => l.every((i) => card.cells[i].by)).length;
    const newLines = lines - card.lines;
    card.lines = lines;
    return { ok: true, cell: cellIndex, newLines, full: card.cells.every((c) => c.by) };
  }

  /** 某人的卡，給手機看。by 換成名字由呼叫端處理 */
  cardOf(agentId) {
    return this.round?.cards.get(agentId) ?? null;
  }

  /** 進度排行：連線數優先，再比填了幾格 */
  standings() {
    if (!this.round) return [];
    return [...this.round.cards].map(([id, c]) => ({
      id, lines: c.lines, filled: c.cells.filter((x) => x.by).length,
    })).sort((a, b) => b.lines - a.lines || b.filled - a.filled);
  }

  shouldAutoEnd(now = Date.now()) {
    return !!this.round?.endsAt && now >= this.round.endsAt;
  }

  end() {
    const r = this.round;
    this.round = null;
    return r;
  }

  forget(agentId) {
    this.round?.cards.delete(agentId);
  }
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
