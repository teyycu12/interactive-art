/**
 * 解碼任務：一人拿符號、一人拿密碼本（MISSION_TYPES.DECODE）
 *
 * 原型是 Keep Talking and Nobody Explodes：一個人看得到題目、另一個人拿著解法，
 * 兩邊都只能用講的。規則與理由見 docs/notes/INTERACTION-DESIGN.md「解碼任務」。
 *
 * 純邏輯：不碰 WebSocket、不讀全域狀態。場上有誰由呼叫端每拍以 sync() 餵進來，
 * 亂數可注入，測試可以直接驅動。一個進行中的 DECODE 任務對應一個 DecodeRound。
 *
 * ⚠ 不能動的一條：**答案（code）只存在這裡**。viewFor() 給拿符號的人符號、
 *   給拿密碼本的人密碼本，從不同時給同一個人，也從不給 code ——
 *   手機只要拿得到其中一樣以外的東西，開發者工具一看就解開了。
 */

import { DECODE } from '../shared/decode.js';

export const ROLE = { SYMBOLS: 'symbols', BOOK: 'book' };

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);

export class DecodeRound {
  /**
   * @param {object} p
   * @param {number} p.codeLength 密碼幾碼
   * @param {{glyph: string, name: string}[]} p.symbols 這個場景的符號集（至少 DECODE.bookSize 個）
   * @param {(a: string, b: string) => boolean} [p.met] 兩人今天是不是已經認識（優先排沒認識的）
   * @param {() => number} [p.rng]
   */
  constructor({ codeLength, symbols, met = () => false, rng = Math.random }) {
    this.codeLength = codeLength;
    this.symbols = symbols;
    this.met = met;
    this.rng = rng;
    /** @type {Map<string, object>} 進行中的組 */
    this.groups = new Map();
    /** @type {Map<string, string>} 人 → 所在的組 */
    this.memberOf = new Map();
    /** @type {Map<string, number>} 等待配對的人 → 開始等的時刻 */
    this.waiting = new Map();
    /** @type {Set<string>} 這個任務裡合作過的兩人（pairKey） */
    this.partnered = new Set();
    /** @type {Map<string, string>} 上一組拿的角色：下一組盡量換另一個 */
    this.lastRole = new Map();
    /** @type {Map<string, number>} 斷線的人 → 斷線起點 */
    this.offlineSince = new Map();
    this.solved = 0;
    this.seq = 0;
    this.colorCursor = 0;
  }

  /**
   * 依場上現況更新：新來的人排進等待區、離場（或斷線太久）的人移出，
   * 拆掉缺人的組，再把等待區的人湊成新的組。
   * @param {{id: string, offline?: boolean}[]} agents 場上的角色
   * @returns {{changed: Set<string>}} 狀態有變、要重送 viewFor 的人
   */
  sync(agents, now = Date.now()) {
    const changed = new Set();
    const here = new Set();
    for (const a of agents) {
      if (a.offline) {
        if (!this.offlineSince.has(a.id)) this.offlineSince.set(a.id, now);
        if (now - this.offlineSince.get(a.id) >= DECODE.dropOfflineMs) continue;
      } else {
        this.offlineSince.delete(a.id);
      }
      here.add(a.id);
    }
    for (const id of this.offlineSince.keys()) {
      if (!agents.some((a) => a.id === id)) this.offlineSince.delete(id);
    }

    // 有人走了：那一組拆掉，留下的人回等待區（他手上那一半已經沒用了）
    for (const g of [...this.groups.values()]) {
      if (g.members.every((id) => here.has(id))) continue;
      this.#dissolve(g, now, changed, here);
    }
    for (const id of [...this.waiting.keys()]) {
      if (!here.has(id)) { this.waiting.delete(id); changed.add(id); }
    }
    // 新來的人
    for (const id of here) {
      if (!this.memberOf.has(id) && !this.waiting.has(id)) {
        this.waiting.set(id, now);
        changed.add(id);
      }
    }
    this.#form(now, changed);
    return { changed };
  }

  #dissolve(g, now, changed, here) {
    this.groups.delete(g.id);
    for (const id of g.members) {
      this.memberOf.delete(id);
      changed.add(id);
      if (here.has(id)) this.waiting.set(id, now);
    }
  }

  /** 等待區湊組：先等最久的人；優先找這個任務裡沒合作過、今天也還不認識的人 */
  #form(now, changed) {
    // 斷線中的人留在等待區但不排進新的組：他現在看不到手機
    const pool = [...this.waiting.entries()]
      .filter(([id]) => !this.offlineSince.has(id))
      .sort((p, q) => p[1] - q[1]).map(([id]) => id);
    const used = new Set();
    const formed = [];
    for (const a of pool) {
      if (used.has(a)) continue;
      const free = pool.filter((b) => b !== a && !used.has(b));
      const fresh = free.filter((b) => !this.partnered.has(pairKey(a, b)));
      // 等太久的人放寬：跟剛合作過的人再一組，總比一直站著好
      const waited = now - this.waiting.get(a) >= DECODE.repeatAfterMs;
      const candidates = fresh.length ? fresh : waited ? free : [];
      if (!candidates.length) continue;
      // 今天還不認識的優先；其次是上一組角色跟他相反的人，兩個人才都換得到另一個角色
      const score = (x) => (this.met(a, x) ? 0 : 2)
        + (this.lastRole.has(a) && this.lastRole.get(x) !== this.lastRole.get(a) ? 1 : 0);
      const b = candidates.reduce((best, x) => (score(x) > score(best) ? x : best), candidates[0]);
      used.add(a); used.add(b);
      formed.push([a, b]);
    }
    // 落單的一個人：併進這一次剛湊好的組，變成三人組（密碼本拆兩半）
    // 剛跟組裡的人合作過就不併（剛解完的兩人又被湊在一起），除非他已經等太久
    const left = pool.filter((id) => !used.has(id));
    if (left.length === 1) {
      const x = left[0];
      const waited = now - this.waiting.get(x) >= DECODE.repeatAfterMs;
      const host = [...formed].reverse().find((ms) => waited || ms.every((m) => !this.partnered.has(pairKey(x, m))));
      if (host) host.push(x);
    }
    for (const members of formed) this.#start(members, now, changed);
  }

  #start(members, now, changed) {
    const id = `dg${++this.seq}`;
    // 拿符號的人：上一組拿密碼本（或還沒玩過）的人優先，大家輪流
    const order = shuffle(members, this.rng);
    const holder = order.find((m) => this.lastRole.get(m) !== ROLE.SYMBOLS) ?? order[0];
    const bookers = order.filter((m) => m !== holder);

    const picked = shuffle(this.symbols, this.rng).slice(0, DECODE.bookSize);
    const digits = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], this.rng);
    const book = picked.map((s, i) => ({ glyph: s.glyph, name: s.name, digit: digits[i] }));
    // 三人組：密碼本拆兩半，題目一定要兩半都用到 —— 否則其中一個人整輪都不用開口
    const halves = bookers.length === 2
      ? [book.slice(0, book.length / 2), book.slice(book.length / 2)]
      : [book];
    let seq;
    for (let tries = 0; tries < 50; tries++) {
      seq = Array.from({ length: this.codeLength }, () => book[Math.floor(this.rng() * book.length)]);
      if (halves.every((h) => seq.some((s) => h.includes(s)))) break;
    }

    const g = {
      id,
      members,
      holder,
      books: new Map(bookers.map((m, i) => [m, halves[i]])),
      seq,
      code: seq.map((s) => s.digit).join(''),
      color: DECODE.keyColors[this.colorCursor++ % DECODE.keyColors.length],
      startedAt: now,
      wrong: 0,
      cooldownUntil: 0,
      lastHits: null,
    };
    this.groups.set(id, g);
    for (const m of members) {
      this.waiting.delete(m);
      this.memberOf.set(m, id);
      changed.add(m);
    }
  }

  /**
   * 有人輸入了密碼。
   * @returns {{ok: false, reason: string} | {ok: true, solved: boolean, hits: number, cooldownMs: number, group: object}}
   */
  guess(agentId, raw, now = Date.now()) {
    const g = this.groups.get(this.memberOf.get(agentId));
    if (!g) return { ok: false, reason: 'NO_GROUP' };
    const code = String(raw ?? '');
    if (code.length !== this.codeLength || !/^\d+$/.test(code)) return { ok: false, reason: 'BAD_CODE' };
    if (now < g.cooldownUntil) return { ok: false, reason: 'COOLDOWN', cooldownMs: g.cooldownUntil - now };

    if (code === g.code) {
      this.#solve(g, now);
      return { ok: true, solved: true, hits: this.codeLength, cooldownMs: 0, group: g };
    }
    // 只講對了幾碼，不講是哪幾碼：講位置的話，一位一位試很快就猜得出來
    let hits = 0;
    for (let i = 0; i < code.length; i++) if (code[i] === g.code[i]) hits += 1;
    g.wrong += 1;
    g.lastHits = hits;
    let cooldownMs = 0;
    if (g.wrong >= DECODE.wrongLimit) {
      g.wrong = 0;
      g.cooldownUntil = now + DECODE.cooldownMs;
      cooldownMs = DECODE.cooldownMs;
    }
    return { ok: true, solved: false, hits, cooldownMs, group: g };
  }

  #solve(g, now) {
    this.solved += 1;
    this.groups.delete(g.id);
    for (let i = 0; i < g.members.length; i++) {
      for (let j = i + 1; j < g.members.length; j++) this.partnered.add(pairKey(g.members[i], g.members[j]));
    }
    for (const m of g.members) {
      this.memberOf.delete(m);
      this.lastRole.set(m, m === g.holder ? ROLE.SYMBOLS : ROLE.BOOK);
      // 解開就換人再來一組：回等待區，下一次 sync 湊新的組
      this.waiting.set(m, now);
    }
  }

  /**
   * 這個人手機上該看到的東西。**只有自己那一半**：拿符號的人沒有密碼本，
   * 拿密碼本的人沒有符號，任何人都沒有答案。
   */
  viewFor(agentId, now = Date.now()) {
    const g = this.groups.get(this.memberOf.get(agentId));
    if (!g) return { state: 'waiting', codeLength: this.codeLength };
    const role = agentId === g.holder ? ROLE.SYMBOLS : ROLE.BOOK;
    const view = {
      state: 'playing',
      group: g.id,
      color: g.color,
      role,
      codeLength: this.codeLength,
      partners: g.members.filter((m) => m !== agentId),
      holder: g.holder,
      cooldownMs: Math.max(0, g.cooldownUntil - now),
      lastHits: g.lastHits,
    };
    if (role === ROLE.SYMBOLS) view.symbols = g.seq.map((s) => ({ glyph: s.glyph, name: s.name }));
    else view.book = g.books.get(agentId).map((s) => ({ glyph: s.glyph, name: s.name, digit: s.digit }));
    return view;
  }

  /** 大螢幕與主辦端：誰跟誰一組、什麼顏色、解開了幾組。不含任何符號或數字 */
  publicView() {
    return {
      groups: [...this.groups.values()].map((g) => ({ id: g.id, members: [...g.members], color: g.color })),
      solved: this.solved,
      waiting: this.waiting.size,
    };
  }
}
