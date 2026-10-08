/**
 * 採水果（籃子接力）—— 規則與狀態。不碰 WebSocket，推播由 index.js 負責。
 *
 * 規則全部繞著一條限制轉：**一個人一輪只能採一畦**。採完之後籃子對你就沒用了，
 * 要繼續只能交給一個還沒採過的人 —— 而那個人得先被你叫過來。
 * 設計理由寫在 shared/harvest.js 與 docs/notes/INTERACTION-DESIGN.md。
 *
 * ── 籃子的位置為什麼每拍都記 ──
 * 籃子有人拿著時位置就是那個人的位置；但賓客關掉分頁後角色要等
 * AGENT_TTL_MS（45 秒）才回收，而回收的那一瞬間我們就再也問不到他在哪了。
 * 因此每一拍都把持有者的座標抄進 `at` —— 人一離場，籃子自然留在他最後站的
 * 地方，誰都可以走過去撿起來。不這樣做的話籃子會跟著人一起消失，
 * 這一輪永遠結束不了，而畫面上完全看不出原因。
 */

import { randomUUID } from 'node:crypto';
import { HARVEST } from '../shared/harvest.js';
import { PROPS } from '../shared/scene.js';

const PROP_BY_ID = new Map(PROPS.map((p) => [p.id, p]));

/** 走到道具旁算不算到了。與 survey 的到位判定同一套算法：半徑加在碰撞半徑之外 */
function within(pos, propId) {
  const prop = PROP_BY_ID.get(propId);
  if (!prop || !pos) return false;
  return Math.hypot(pos.x - prop.x, pos.y - prop.y) <= prop.r + HARVEST.reachRadius;
}

export class HarvestRelay {
  constructor() {
    /** @type {object|null} */
    this.round = null;
  }

  get isActive() {
    return this.round !== null;
  }

  /**
   * 開始一輪。
   *
   * @param {string[]} agentIds 場上的人
   * @param {{beds: string[], home: string}} plan 要採哪幾畦、送回哪
   */
  start(agentIds, plan) {
    if (this.round) return { ok: false, reason: '已有進行中的採收，請先結束' };

    const beds = [...new Set(plan.beds)].filter((id) => PROP_BY_ID.has(id));
    if (beds.length === 0) return { ok: false, reason: '設定裡沒有任何採收點' };
    if (!PROP_BY_ID.has(plan.home)) return { ok: false, reason: '設定裡的放回地點不存在' };

    // 一人一畦，所以人數少於畦數時這一輪從一開始就不可能完成。
    // 擋在這裡而不是等到卡住才中止：現場會以為是系統壞了。
    const ids = [...new Set(agentIds)];
    if (ids.length < beds.length) {
      return { ok: false, reason: `一人只能採一畦，${beds.length} 畦至少需要 ${beds.length} 位參與者` };
    }

    this.round = {
      id: `hrv_${randomUUID().slice(0, 8)}`,
      beds: beds.map((propId) => ({ propId, pickedBy: null, pickedAt: null })),
      home: plan.home,
      /** 誰拿著籃子；沒有人拿著時為 null，籃子留在 at */
      holder: null,
      /** 籃子最後所在的座標。一開始放在送回地點，等於「從這裡出發」 */
      at: { x: PROP_BY_ID.get(plan.home).x, y: PROP_BY_ID.get(plan.home).y },
      /** 採過的人。一人一畦就是靠這個集合 */
      pickedBy: new Set(),
      /** 誰可以按「接過籃子」，只在變動時推播（同 SURVEY_ARRIVED 的理由） */
      reach: new Set(),
      startedAt: Date.now(),
      doneAt: null,
    };
    return { ok: true, round: this.round };
  }

  stop() {
    const r = this.round;
    this.round = null;
    return r;
  }

  /** 還沒採的畦 */
  remaining() {
    return this.round ? this.round.beds.filter((b) => b.pickedBy === null) : [];
  }

  /** 籃子現在在哪（有人拿著就是那個人的位置） */
  basketAt() {
    return this.round ? { ...this.round.at } : null;
  }

  /**
   * 拿起／接過籃子。
   *
   * 由**接的人**發起，不是給的人。這是刻意的：接的人要先被叫過去，
   * 而「叫過去」正是這個玩法要的那一步。給的人想主動脫手時用 drop()。
   */
  take(agentId, positionOf) {
    const r = this.round;
    if (!r) return { ok: false, reason: 'NO_ROUND' };
    if (r.holder === agentId) return { ok: false, reason: 'ALREADY_HOLDING' };
    const pos = positionOf(agentId);
    if (!pos) return { ok: false, reason: 'NOT_ON_STAGE' };
    if (Math.hypot(pos.x - r.at.x, pos.y - r.at.y) > HARVEST.handRadius) {
      return { ok: false, reason: 'TOO_FAR' };
    }
    const from = r.holder;
    r.holder = agentId;
    r.at = { x: pos.x, y: pos.y };
    return { ok: true, from };
  }

  /** 把籃子放在原地。放下之後任何人都可以走過來撿 */
  drop(agentId) {
    const r = this.round;
    if (!r || r.holder !== agentId) return { ok: false, reason: 'NOT_HOLDING' };
    r.holder = null;
    return { ok: true };
  }

  /**
   * 推進一拍：更新籃子位置、判定採收與送回、重算誰按得到「接過籃子」。
   *
   * @param {(id: string) => {x:number,y:number}|null} positionOf
   * @param {Iterable<string>} agentIds 場上的人，用來算 reach
   * @returns {{picked: object[], delivered: boolean, dropped: boolean, reachChanged: string[]}}
   */
  tick(positionOf, agentIds) {
    const r = this.round;
    if (!r || r.doneAt) return { picked: [], delivered: false, dropped: false, reachChanged: [] };

    const picked = [];
    let dropped = false;

    if (r.holder) {
      const pos = positionOf(r.holder);
      if (pos) {
        r.at = { x: pos.x, y: pos.y };
      } else {
        // 持有者離場。籃子留在他最後站的位置（見檔頭說明）
        r.holder = null;
        dropped = true;
      }
    }

    if (r.holder && !r.pickedBy.has(r.holder)) {
      // 一拍只採一畦：兩畦的判定圈不會重疊（見 shared/harvest.js 的 reachRadius），
      // 真的同時站在兩畦旁是不可能的，但寫成只取第一個比較誠實
      const bed = r.beds.find((b) => b.pickedBy === null && within(r.at, b.propId));
      if (bed) {
        bed.pickedBy = r.holder;
        bed.pickedAt = Date.now();
        r.pickedBy.add(r.holder);
        picked.push(bed);
      }
    }

    let delivered = false;
    if (r.holder && this.remaining().length === 0 && within(r.at, r.home)) {
      r.doneAt = Date.now();
      delivered = true;
    }

    return { picked, delivered, dropped, reachChanged: this.#syncReach(positionOf, agentIds) };
  }

  /**
   * 誰站得夠近、按得到「接過籃子」。
   *
   * 只回報**變動**的人，不是每拍廣播：30Hz × 10 人是每秒三百則重複訊息，
   * 而現場的症狀只會是「網路很慢」，完全看不出跟這個玩法有關
   * （同 SURVEY_ARRIVED 與分區回報）。
   */
  #syncReach(positionOf, agentIds) {
    const r = this.round;
    const changed = [];
    const next = new Set();
    for (const id of agentIds) {
      if (id === r.holder) continue;
      const pos = positionOf(id);
      if (!pos) continue;
      if (Math.hypot(pos.x - r.at.x, pos.y - r.at.y) <= HARVEST.handRadius) next.add(id);
    }
    for (const id of next) if (!r.reach.has(id)) changed.push(id);
    for (const id of r.reach) if (!next.has(id)) changed.push(id);
    r.reach = next;
    return changed;
  }

  /** 這個人現在按不按得到「接過籃子」 */
  canTake(agentId) {
    return this.round ? this.round.reach.has(agentId) : false;
  }

  /**
   * 本輪是否仍然成立。
   *
   * 一人一畦的代價是它會卡死：還沒採的畦若多於「還沒採過的人」，
   * 這一輪就永遠不可能完成。賓客關掉分頁、角色留在場上 45 秒才回收，
   * 一場活動下來必然發生 —— 因此由伺服器自己檢查，而不是等主辦端發現不對勁
   * （主辦端多半正在忙別的，現場只會看到「這個遊戲壞了」）。
   */
  viability(agentIds) {
    const r = this.round;
    if (!r || r.doneAt) return { ok: true };
    const ids = [...agentIds];
    if (ids.length === 0) return { ok: false, reason: 'NO_PLAYERS' };
    const left = this.remaining().length;
    if (left === 0) return { ok: true };
    const fresh = ids.filter((id) => !r.pickedBy.has(id)).length;
    if (fresh < left) return { ok: false, reason: 'NO_FRESH_HANDS' };
    return { ok: true };
  }

  /**
   * 推給所有人的公開狀態。
   *
   * 這個玩法沒有秘密 —— 跟尋寶相反，哪一畦採過了、籃子在誰手上都要讓全場看見，
   * 「誰還沒採」正是大家要互相喊的那件事。因此三端送同一份。
   */
  publicView() {
    const r = this.round;
    if (!r) return null;
    return {
      id: r.id,
      home: r.home,
      holder: r.holder,
      basket: { ...r.at },
      beds: r.beds.map((b) => ({ propId: b.propId, pickedBy: b.pickedBy })),
      picked: [...r.pickedBy],
      startedAt: r.startedAt,
      doneAt: r.doneAt,
    };
  }
}
