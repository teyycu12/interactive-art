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
 * 冷卻（noteClaim），不論成功失敗 —— 見 INTERACTION-DESIGN
 * 「顏色預檢不可成為枚舉管道」。
 *
 * 冷卻是賓果自己的一份，不跟配對共用（原本共用：賓果輸錯一次，配對也要跟著等，
 * 兩個一起玩時會覺得卡住）。分開之後窮舉速度最多變兩倍 —— 每 3 秒兩次，
 * 碼每分鐘換一次，仍然遠遠來不及掃完 10000 組。
 *
 * ── 開局先問幾句自我介紹（shared/bingoFacts.js）──
 * 有自我介紹題時，一輪分兩段：先 `ask`（每人勾自己符合的，最多 askMs），
 * 全部答完或時間到才發卡（`play`）。卡要等答案回來才發得出來 ——
 * 「場上至少有一人符合」才放進卡裡，而那要先知道誰勾了什麼。
 * 發卡之後才進場的人直接拿卡、不再問，免得他的卡一直發不出來。
 *
 * ── 一張卡上各類格子最多 3 格 ──
 * 不限的話，有人拿到七格顏色（看大螢幕就找得到，很快連線），
 * 有人拿到七格類型（每格都要問），同一輪難度差很多。
 *
 * ── 人少時同一個人可以填不只一格 ──
 * 「同一個人只能填一格」逼人去認識不同的人，但 9 格要 9 個不同的人 ——
 * 場上不到 10 人時全卡永遠填不滿，而主辦端看不出來。所以上限是
 * ceil(9 ÷ 其他人數)：10 人以上照舊一人一格，8 人時一人最多兩格。
 *
 * ── 被找的人也能順便填 ──
 * A 輸入 B 的碼填格之後，若 A 也符合 B 卡上還空著的某一格，B 的手機會問
 * 要不要填上（offerFor / acceptOffer）。一段對話兩個人都有進度，
 * 被找的人不再只是收到一則通知。不必再輸碼：A 剛剛才當面拿到 B 的碼。
 *
 * ── 不寫進社交圖譜 ──
 * 圖譜的邊要「經雙方確認」；賓果填格只靠一方輸入碼（碼也可能是偷看來的）。
 *
 * 純邏輯：條件的判定由呼叫端注入（test 函式），本模組不碰 WebSocket 與角色資料。
 */

import { randomUUID } from 'node:crypto';
import { factCellLabel as factLabel } from '../shared/bingoFacts.js';

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

/**
 * 「一起做一件事」的格子：不輸碼，兩個人真的一起做到時由伺服器自動填上（autoFill）。
 *
 * 原本每一格都是同一個動詞 —— 找人、要碼、輸碼。這幾格換成「一起動起來」：
 * 碰杯要兩人同時按、揮手要對方回揮、同桌要一起坐滿一分鐘（這三件事伺服器本來就會判定）。
 * 輸碼填不進去（ACT_ONLY）：那等於不必真的做那件事。
 */
export const ACT_CONDS = [
  { id: 'act:cheers', label: '跟你一起乾杯的人' },
  { id: 'act:wave', label: '跟你互相揮手的人' },
  { id: 'act:topic', label: '跟你在號碼牌桌同桌聊一分鐘的人' },
];

/** 一張卡上同一類格子（顏色、類型、問卷、自我介紹、一起做）最多幾格 */
export const KIND_CAP = 3;

/** 被找的人「順便填」的邀請多久內有效 */
export const OFFER_TTL_MS = 90_000;

/** 條件的類別：id 冒號前那一段（color:red → color） */
const kindOf = (condId) => condId.split(':')[0];

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
  NO_OFFER: 'NO_OFFER',    // 「順便填」的邀請已過期或不存在
  ACT_ONLY: 'ACT_ONLY',    // 「一起做一件事」的格子不能輸碼，要真的一起做到
};

/**
 * @typedef {{id: string, label: string}} Condition
 * @typedef {(agentId: string, conditionId: string, fromId: string) => boolean} Tester
 */

export class BingoRound {
  /** @param {{claimCooldownMs?: number}} [opts] */
  constructor({ claimCooldownMs = 3000 } = {}) {
    this.claimCooldownMs = claimCooldownMs;
    /** 每人上次輸碼的時間。跨輪保留：結束再開一輪不該把冷卻歸零 */
    this.lastClaimAt = new Map();
    /** @type {null | {id: string, startedAt: number, endsAt: number|null,
     *   cards: Map<string, {cells: {cond: Condition, by: string|null}[], lines: number}>,
     *   pool: Condition[]}} */
    this.round = null;
  }

  get isActive() { return this.round !== null; }

  /** 輸碼冷卻中嗎 */
  inCooldown(agentId, now = Date.now()) {
    return now - (this.lastClaimAt.get(agentId) ?? -Infinity) < this.claimCooldownMs;
  }

  /** 記一次輸碼。不論成功失敗都要記（防枚舉） */
  noteClaim(agentId, now = Date.now()) {
    this.lastClaimAt.set(agentId, now);
  }

  /**
   * 開一輪。
   * @param {string[]} agentIds 場上的人
   * @param {Condition[]} pool 候選條件（呼叫端已濾掉「場上沒有任何人符合」的）
   * @param {Tester} test 判定某人是否符合某條件
   * @param {{durationMs?: number|null, facts?: string[], askMs?: number, rng?: () => number}} [opts]
   *   facts：這一輪要問的自我介紹題（空的話跳過 ask，直接發卡）
   */
  start(agentIds, pool, test, {
    durationMs = null, facts = [], askMs = 30_000, rng = Math.random, now = Date.now(),
  } = {}) {
    if (this.round) return { ok: false, reason: '已有進行中的賓果，請先結束' };
    if (agentIds.length < 2) return { ok: false, reason: '至少需要 2 位參與者才能開始賓果' };
    this.test = test;
    this.rng = rng;
    this.round = {
      id: `bgo_${randomUUID().slice(0, 8)}`,
      startedAt: now,
      phase: facts.length ? 'ask' : 'play',
      askEndsAt: facts.length ? now + askMs : null,
      durationMs,
      endsAt: null,
      cards: new Map(),
      pool,
      /** 這一輪問的題目。id 是題號，條件 id 為 fact:<題號> */
      facts: facts.map((text, i) => ({ id: String(i), text })),
      /** 誰勾了哪幾題 @type {Map<string, Set<string>>} */
      answers: new Map(),
      /** 被找的人「順便填」的邀請 @type {Map<string, {from: string, cell: number, at: number}>} */
      offers: new Map(),
    };
    if (this.round.phase === 'play') this.beginPlay(agentIds, now);
    return { ok: true, round: this.round };
  }

  get phase() { return this.round?.phase ?? null; }

  /**
   * 收下某人勾的自我介紹題。ask 與 play 階段都收（重送、晚到的回答都算數），
   * 只收這一輪真的有的題號。
   */
  answerFacts(agentId, ids) {
    const r = this.round;
    if (!r || !r.facts.length || !Array.isArray(ids)) return false;
    const valid = new Set(r.facts.map((f) => f.id));
    r.answers.set(agentId, new Set(ids.filter((id) => typeof id === 'string' && valid.has(id))));
    return true;
  }

  hasAnswered(agentId) {
    return this.round?.answers.has(agentId) ?? false;
  }

  hasFact(agentId, factId) {
    return this.round?.answers.get(agentId)?.has(factId) ?? false;
  }

  /** ask 階段是否該結束：時間到，或在場的人都答完了 */
  readyToPlay(presentIds, now = Date.now()) {
    const r = this.round;
    if (!r || r.phase !== 'ask') return false;
    return now >= r.askEndsAt || presentIds.every((id) => r.answers.has(id));
  }

  /**
   * 發卡、開始計時。自我介紹題的條件在這時才放進候選 ——
   * 要等答案回來，才知道哪幾題「場上有人符合」。
   */
  beginPlay(presentIds, now = Date.now()) {
    const r = this.round;
    if (!r) return;
    r.phase = 'play';
    r.endsAt = r.durationMs ? now + r.durationMs : null;
    r.pool = [
      ...r.pool,
      ...r.facts.map((f) => ({ id: `fact:${f.id}`, label: factLabel(f.text) })),
    ];
    for (const id of presentIds) this.dealCard(id, presentIds);
  }

  /**
   * 發一張卡。中途進場的人也走這裡。
   *
   * 只放「場上除了自己以外至少有一人符合」的條件 —— 一格怎麼找都找不到人，
   * 那條線就永遠連不成，等於在懲罰參與者。不夠 9 格時用 STRANGER 補。
   */
  dealCard(agentId, presentIds) {
    const r = this.round;
    if (!r || r.phase !== 'play') return null;
    if (r.cards.has(agentId)) return r.cards.get(agentId);
    const others = presentIds.filter((id) => id !== agentId);
    const doable = shuffle(r.pool.filter((c) => others.some((o) => this.test(o, c.id, agentId))), this.rng);
    // 先照每類上限挑；挑不滿 9 格再放寬，用剩下的補 —— 上限是為了平均，不是為了留空格
    const picked = [];
    const perKind = new Map();
    const rest = [];
    for (const c of doable) {
      const k = kindOf(c.id);
      if (picked.length < CELLS && (perKind.get(k) ?? 0) < KIND_CAP) {
        picked.push(c);
        perKind.set(k, (perKind.get(k) ?? 0) + 1);
      } else {
        rest.push(c);
      }
    }
    while (picked.length < CELLS && rest.length) picked.push(rest.shift());
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
    if (kindOf(cell.cond.id) === 'act') return { ok: false, reason: BINGO_ERRORS.ACT_ONLY };
    if (targetId === fromId) return { ok: false, reason: BINGO_ERRORS.SELF };
    if (this.#uses(card, targetId) >= this.maxUses()) return { ok: false, reason: BINGO_ERRORS.USED };
    if (!this.test(targetId, cell.cond.id, fromId)) return { ok: false, reason: BINGO_ERRORS.MISMATCH };

    cell.by = targetId;
    const lines = BINGO_LINES.filter((l) => l.every((i) => card.cells[i].by)).length;
    const newLines = lines - card.lines;
    card.lines = lines;
    return { ok: true, cell: cellIndex, newLines, full: card.cells.every((c) => c.by) };
  }

  /**
   * 兩人一起做到了某件事（ACT_CONDS）：agentId 卡上那一格還空著就填上 other。
   * 照一般的「同一人最多幾格」限制；不成立時回 null（不是錯誤，只是不用填）。
   * @returns {{ok: true, cell: number, newLines: number, full: boolean}|null}
   */
  autoFill(agentId, condId, otherId) {
    const r = this.round;
    if (!r || r.phase !== 'play' || agentId === otherId) return null;
    const card = r.cards.get(agentId);
    if (!card || this.#uses(card, otherId) >= this.maxUses()) return null;
    const i = card.cells.findIndex((c) => !c.by && c.cond.id === condId);
    if (i < 0) return null;
    card.cells[i].by = otherId;
    const lines = BINGO_LINES.filter((l) => l.every((j) => card.cells[j].by)).length;
    const newLines = lines - card.lines;
    card.lines = lines;
    return { ok: true, cell: i, newLines, full: card.cells.every((c) => c.by) };
  }

  /**
   * 同一個人在一張卡上最多填幾格。10 人以上一人一格；不到時放寬到填得滿為止。
   * 「其他人」以拿到卡的人數計 —— 中途進場的人也算進來，上限會跟著收緊。
   */
  maxUses() {
    const others = Math.max(1, (this.round?.cards.size ?? 1) - 1);
    return Math.max(1, Math.ceil(CELLS / others));
  }

  #uses(card, targetId) {
    return card.cells.filter((c) => c.by === targetId).length;
  }

  /**
   * from 剛把 target 填進自己的卡。看 from 符不符合 target 卡上還空著的某一格，
   * 符合就記一筆邀請（同一人只留最新的一筆）。
   * 優先挑填了會連成線的那一格，其次照格子順序。
   * @returns {{cell: number, label: string}|null}
   */
  offerFor(targetId, fromId, now = Date.now()) {
    const r = this.round;
    const card = r?.cards.get(targetId);
    if (!card || this.#uses(card, fromId) >= this.maxUses()) return null;
    const open = card.cells
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.by && kindOf(c.cond.id) !== 'act' && this.test(fromId, c.cond.id, targetId));
    if (!open.length) return null;
    const completes = (i) => BINGO_LINES.some((l) => l.includes(i) && l.every((j) => j === i || card.cells[j].by));
    const best = open.find(({ i }) => completes(i)) ?? open[0];
    r.offers.set(targetId, { from: fromId, cell: best.i, at: now });
    return { cell: best.i, label: best.c.cond.label };
  }

  /**
   * 收下邀請：照一般填格的規則再驗一次（這段時間裡格子可能已經填了、對方可能已離場）。
   * @returns {ReturnType<BingoRound['claim']> & {from?: string}}
   */
  acceptOffer(targetId, now = Date.now()) {
    const offer = this.round?.offers.get(targetId);
    if (!offer || now - offer.at > OFFER_TTL_MS) return { ok: false, reason: BINGO_ERRORS.NO_OFFER };
    this.round.offers.delete(targetId);
    return { ...this.claim(targetId, offer.cell, offer.from), from: offer.from };
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

  /**
   * 結算用的全場統計：一共填了幾格、誰被最多人找到（同分取先出現的）。
   * 「被最多人找到」是大螢幕收尾時唸的 —— 比只唸連線最多的人更像這個遊戲的意義。
   * @returns {{cells: number, mostFound: {id: string, count: number}|null}}
   */
  summary() {
    const found = new Map();
    let cells = 0;
    for (const card of this.round?.cards.values() ?? []) {
      // 同一張卡上被填兩格（人少時）只算被這個人找到一次
      for (const id of new Set(card.cells.map((c) => c.by).filter(Boolean))) found.set(id, (found.get(id) ?? 0) + 1);
      cells += card.cells.filter((c) => c.by).length;
    }
    let mostFound = null;
    for (const [id, count] of found) if (!mostFound || count > mostFound.count) mostFound = { id, count };
    return { cells, mostFound };
  }

  shouldAutoEnd(now = Date.now()) {
    return this.round?.phase === 'play' && !!this.round.endsAt && now >= this.round.endsAt;
  }

  end() {
    const r = this.round;
    this.round = null;
    return r;
  }

  forget(agentId) {
    this.round?.cards.delete(agentId);
    this.round?.answers.delete(agentId);
    this.round?.offers.delete(agentId);
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
