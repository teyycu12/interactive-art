/**
 * 傳球＋投籃（體育館；哪個場景開、球車與籃框在哪由 shared/themes.js 的 `hoops` 決定）
 *
 *   走到球車 → 自動拿到球 → 傳給別人／自己到籃框區投
 *   接到傳球後 HOOPS.assistMs 內投進 = 助攻，兩個人都記一筆
 *
 * 單人也投得進，但合作才有助攻 —— 「傳給我！」是這個玩法要逼出來的那一句
 * （INTERACTION-DESIGN「這個機制需不需要開口講話」）。球在誰手上大螢幕看得到。
 *
 * 純邏輯：不碰 WebSocket。場上角色由呼叫端每拍以 step() 餵進來，亂數可注入。
 */

import { HOOPS, inRect, shotChance } from '../shared/hoops.js';

export const HOOP_ERRORS = {
  NO_BALL: 'NO_BALL',
  SELF: 'SELF',
  NOT_FOUND: 'NOT_FOUND',
  TOO_FAR: 'TOO_FAR',
  HAS_BALL: 'HAS_BALL',
  OUT_OF_ZONE: 'OUT_OF_ZONE',
  COOLDOWN: 'COOLDOWN',
  BAD_SHOT: 'BAD_SHOT',
};

export class HoopCourt {
  /**
   * @param {{cart: object, hoop: object, zone: object}} court shared/hoops.js 的 hoopsFor()
   * @param {() => number} [rng]
   */
  constructor(court, rng = Math.random) {
    this.court = court;
    this.rng = rng;
    /** @type {Map<string, {from: string|null, passedAt: number}>} 拿著球的人 → 球從哪來 */
    this.holders = new Map();
    /** @type {Map<string, {made: number, attempts: number, assists: number}>} */
    this.stats = new Map();
    /** @type {Map<string, number>} 上一次投籃的時刻 */
    this.lastShot = new Map();
    /**
     * 目前站在球車旁的人。只有「剛走進來」那一刻才拿得到球：球車就在籃框區裡，
     * 站著不動就一直有球的話，一個人可以投到天荒地老，傳球就沒有意義了
     */
    this.atCart = new Set();
    this.totals = { made: 0, attempts: 0, assists: 0, points: 0 };
  }

  statOf(id) {
    let s = this.stats.get(id);
    if (!s) { s = { made: 0, attempts: 0, assists: 0, points: 0 }; this.stats.set(id, s); }
    return s;
  }

  /**
   * 每拍：走到球車旁邊的人拿球，離場或斷線的人手上的球收回球車。
   * @param {Iterable<{id: string, x: number, y: number, offline?: boolean}>} agents
   * @returns {{changed: Set<string>}} 拿球狀態有變的人
   */
  step(agents) {
    const changed = new Set();
    const here = new Set();
    const { cart } = this.court;
    for (const a of agents) {
      if (a.offline) continue;
      here.add(a.id);
      const near = Math.hypot(a.x - cart.x, a.y - cart.y) <= cart.r + HOOPS.pickupReach;
      const arrived = near && !this.atCart.has(a.id);
      if (near) this.atCart.add(a.id); else this.atCart.delete(a.id);
      if (arrived && !this.holders.has(a.id)) {
        this.holders.set(a.id, { from: null, passedAt: 0 });
        changed.add(a.id);
      }
    }
    for (const id of [...this.atCart]) if (!here.has(id)) this.atCart.delete(id);
    // 人不在了，球留著也沒人拿得到：直接回球車（球車的球拿不完）
    for (const id of [...this.holders.keys()]) {
      if (!here.has(id)) { this.holders.delete(id); changed.add(id); }
    }
    return { changed };
  }

  /**
   * 傳球。不用對方確認：接球的人本來就在旁邊喊「傳給我」，多一步確認只會讓球停在半空。
   * @param {(id: string) => {x: number, y: number}|null} posOf
   */
  pass(from, to, posOf, now = Date.now()) {
    if (!this.holders.has(from)) return { ok: false, reason: HOOP_ERRORS.NO_BALL };
    if (from === to) return { ok: false, reason: HOOP_ERRORS.SELF };
    const a = posOf(from);
    const b = posOf(to);
    if (!a || !b) return { ok: false, reason: HOOP_ERRORS.NOT_FOUND };
    if (this.holders.has(to)) return { ok: false, reason: HOOP_ERRORS.HAS_BALL };
    if (Math.hypot(a.x - b.x, a.y - b.y) > HOOPS.passRange) return { ok: false, reason: HOOP_ERRORS.TOO_FAR };
    this.holders.delete(from);
    this.holders.set(to, { from, passedAt: now });
    return { ok: true };
  }

  /**
   * 投籃。手機送來的是手勢（偏了幾度、多大力），進不進由這裡依離籃框的距離判定。
   * 投完球就沒了（回球車）—— 想再投就得走回去拿，或請人傳給你。
   * @returns {{ok: false, reason: string} | {ok: true, made: boolean, assist: string|null, chance: number}}
   */
  shoot(id, pos, { angle, power } = {}, now = Date.now()) {
    const held = this.holders.get(id);
    if (!held) return { ok: false, reason: HOOP_ERRORS.NO_BALL };
    if (!pos || !inRect(this.court.zone, pos.x, pos.y)) return { ok: false, reason: HOOP_ERRORS.OUT_OF_ZONE };
    if (now - (this.lastShot.get(id) ?? -Infinity) < HOOPS.shootCooldownMs) return { ok: false, reason: HOOP_ERRORS.COOLDOWN };
    const ang = Number(angle);
    const pow = Number(power);
    if (!Number.isFinite(ang) || !Number.isFinite(pow) || pow < 0 || pow > 1 || Math.abs(ang) > 90) {
      return { ok: false, reason: HOOP_ERRORS.BAD_SHOT };
    }
    this.lastShot.set(id, now);
    this.holders.delete(id);

    const { hoop } = this.court;
    const chance = shotChance(Math.hypot(pos.x - hoop.x, pos.y - hoop.y), ang, pow);
    const made = chance > 0 && this.rng() < chance;
    // 自己傳給自己不可能（pass 擋掉了）；接球後拖太久才投就不算助攻
    const assist = made && held.from && held.from !== id && now - held.passedAt <= HOOPS.assistMs ? held.from : null;

    const s = this.statOf(id);
    s.attempts += 1;
    this.totals.attempts += 1;
    if (made) { s.made += 1; this.totals.made += 1; }
    // 計分偏向合作：自己投進 1 分，被助攻的進球 2 分、助攻的人也 2 分
    if (made) s.points += assist ? HOOPS.points.assisted : HOOPS.points.solo;
    if (assist) {
      const p = this.statOf(assist);
      p.assists += 1;
      p.points += HOOPS.points.assist;
      this.totals.assists += 1;
    }
    return { ok: true, made, assist, chance };
  }

  /** 手機：自己有沒有球、球從誰那裡來、還剩多久算助攻、自己的進球數 */
  viewFor(id, now = Date.now()) {
    const held = this.holders.get(id);
    return {
      hasBall: !!held,
      from: held?.from ?? null,
      assistMs: held?.from ? Math.max(0, held.passedAt + HOOPS.assistMs - now) : 0,
      ...(this.stats.get(id) ?? { made: 0, attempts: 0, assists: 0, points: 0 }),
    };
  }

  /** 大螢幕：誰拿著球、全場進球與助攻、進球排行 */
  publicView(top = 3) {
    return {
      holders: [...this.holders.keys()],
      totals: { ...this.totals },
      top: [...this.stats.entries()]
        .filter(([, s]) => s.points > 0)
        .sort((p, q) => q[1].points - p[1].points)
        .slice(0, top)
        .map(([id, s]) => ({ id, made: s.made, assists: s.assists, points: s.points })),
    };
  }

  forget(id) {
    this.holders.delete(id);
    this.stats.delete(id);
    this.lastShot.delete(id);
    this.atCart.delete(id);
  }
}
