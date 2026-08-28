/**
 * 尋寶任務（先知模式）
 *
 * ── 為什麼不是普通的尋寶 ─────────────────────────────────────
 * 普通尋寶（每個人都看得到冷熱提示）在這件作品裡是反效果的：
 * 從「看提示」到「找到」的每一步都不需要另一個人，而且找到之後
 * 告訴別人位置對自己是純損失。結果是十個人低頭各走各的 ——
 * 比沒有遊戲還安靜，與「讓操控者開始交流」的目標完全相反。
 *
 * 因此改成資訊不對稱：
 *   - 只有「先知」看得到冷熱，但先知**不能得分**
 *   - 其他人什麼都看不到，只能聽先知喊
 * 講話從「可有可無」變成唯一的通關路徑，而先知沒有藏私的誘因。
 * 現場會出現一個人大聲指揮、一群人跑動的畫面 —— 這也是這個版本
 * 在展場上比普通尋寶更值得看的原因。
 *
 * 本模組只管規則與狀態，不碰 WebSocket；推播由 index.js 負責。
 */

import { randomUUID } from 'node:crypto';
import { STAGE } from '../shared/protocol.js';
import { TREASURE } from './config.js';
import { OBSTACLES } from '../shared/scene.js';

// 冷熱等級由 shared/ 定義（三端共用），這裡只再匯出方便伺服器內部引用
export { HEAT_LEVELS } from '../shared/heat.js';

/** 依距離換算冷熱。thresholds 由近到遠，與 HEAT_LEVELS 反序對應 */
export function heatOf(distance) {
  const t = TREASURE.heatThresholds;
  if (distance <= t[0]) return 'BURNING';
  if (distance <= t[1]) return 'HOT';
  if (distance <= t[2]) return 'WARM';
  if (distance <= t[3]) return 'COLD';
  return 'FREEZING';
}

/** 挑一個不落在道具內、也不貼邊的藏寶點 */
function pickSpot() {
  const m = TREASURE.edgeMargin;
  for (let i = 0; i < 60; i++) {
    const x = m + Math.random() * (STAGE.width - m * 2);
    const y = m + Math.random() * (STAGE.height - m * 2);
    // 藏在道具裡的話沒有人走得到，那一輪會永遠結束不了
    if (!OBSTACLES.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + TREASURE.claimRadius)) {
      return { x, y };
    }
  }
  return { x: STAGE.width / 2, y: STAGE.height / 2 };
}

export class TreasureHunt {
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
   * @param {string[]} candidateIds 場上可當先知的人
   * @param {{x:number,y:number}|null} spot 指定藏寶點，null 為隨機
   * @param {string|null} prophetId 指定先知，null 為隨機挑
   */
  start(candidateIds, { spot = null, prophetId = null } = {}) {
    if (this.round) return { ok: false, reason: '已有進行中的尋寶，請先結束' };
    const ids = [...new Set(candidateIds)];
    // 至少要兩個人：一個先知加一個找的人。只有先知的話沒人能得分，
    // 只有找的人的話沒有任何提示來源。
    if (ids.length < 2) return { ok: false, reason: '至少需要 2 位參與者才能開始尋寶' };

    let prophet = prophetId;
    if (!prophet || !ids.includes(prophet)) {
      prophet = ids[Math.floor(Math.random() * ids.length)];
    }

    this.round = {
      id: `tre_${randomUUID().slice(0, 8)}`,
      ...(spot ?? pickSpot()),
      prophetId: prophet,
      startedAt: Date.now(),
      foundBy: null,
      foundAt: null,
      /** 先知上一次被推送的冷熱，用於只在等級變動時推播 */
      lastHeat: null,
    };
    return { ok: true, round: this.round };
  }

  /** 結束本輪 */
  stop() {
    const r = this.round;
    this.round = null;
    return r;
  }

  /**
   * 先知眼中的冷熱。距離取「離藏寶點最近的非先知角色」——
   * 先知報的是別人的溫度，不是自己的：他自己走過去也不能得分，
   * 若回報他自己的距離，他會本能地往寶藏走，而那對隊伍毫無幫助。
   *
   * @param {Map<string, object>} agents
   * @returns {{heat: string, changed: boolean}|null}
   */
  heatFor(agents) {
    if (!this.round || this.round.foundBy) return null;
    let best = Infinity;
    for (const [id, a] of agents) {
      if (id === this.round.prophetId) continue;
      const d = Math.hypot(a.x - this.round.x, a.y - this.round.y);
      if (d < best) best = d;
    }
    if (!Number.isFinite(best)) return null;

    const heat = heatOf(best);
    const changed = heat !== this.round.lastHeat;
    this.round.lastHeat = heat;
    return { heat, changed };
  }

  /**
   * 檢查是否有人踩到藏寶點。
   *
   * 先知被排除在外：他看得到冷熱，讓他自己去踩等於整個機制失效。
   * 這是本模組唯一真正的規則，其餘都是呈現。
   *
   * @returns {{id: string}|null} 找到的人
   */
  check(agents) {
    if (!this.round || this.round.foundBy) return null;
    for (const [id, a] of agents) {
      if (id === this.round.prophetId) continue;
      if (Math.hypot(a.x - this.round.x, a.y - this.round.y) <= TREASURE.claimRadius) {
        this.round.foundBy = id;
        this.round.foundAt = Date.now();
        return { id };
      }
    }
    return null;
  }

  /**
   * 忘記「上次送出的冷熱」，讓下一幀無條件重送一次。
   *
   * 先知的手機重連時要呼叫：現場無線網路瞬斷是常態（見 CLAUDE.md
   * 的斷線重連一節），而重連後畫面是空的。若不重置，要等到冷熱
   * **等級變動**才會再收到 —— 隊伍恰好停在原地時可以是好幾十秒，
   * 而先知正是那個所有人都在等他喊話的人。
   */
  resendHeat() {
    if (this.round) this.round.lastHeat = null;
  }

  /**
   * 本輪是否仍然成立。
   *
   * 現場有兩種會讓尋寶卡死的情況，都不是假設出來的 ——
   * 賓客關掉分頁角色仍留在場上，要等 AGENT_TTL_MS（45 秒）才回收，
   * 一場活動下來必然會發生好幾次：
   *
   *   1. **先知離場**：冷熱照算，但沒有人收得到。其他人完全沒有提示，
   *      只能亂走，這一輪永遠不會結束。
   *   2. **其他人都離場**：只剩先知，而先知不能撿，同樣結束不了。
   *
   * 兩者都得靠主辦端發現不對勁再手動中止 —— 但主辦端多半正在忙別的，
   * 而現場只會看到「這個遊戲壞了」。因此由伺服器自己檢查。
   *
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  viability(agents) {
    if (!this.round) return { ok: true };
    if (!agents.has(this.round.prophetId)) {
      return { ok: false, reason: 'PROPHET_LEFT' };
    }
    // 先知以外還有沒有人。只有先知的話沒有人撿得到寶藏
    for (const id of agents.keys()) {
      if (id !== this.round.prophetId) return { ok: true };
    }
    return { ok: false, reason: 'NO_SEEKERS' };
  }

  /**
   * 推送給所有人的公開狀態。
   *
   * ⚠ 絕對不能包含 x / y —— 那是本輪唯一的秘密。
   *   手機端只要收到座標，打開開發者工具就能直接看到答案，
   *   而現場一定有人會這麼做。找到之後才隨結果一起公布。
   */
  publicView() {
    if (!this.round) return null;
    const r = this.round;
    return {
      id: r.id,
      prophetId: r.prophetId,
      startedAt: r.startedAt,
      foundBy: r.foundBy,
    };
  }

  /** 藏寶點座標。只給大螢幕與主辦端，不給手機 */
  spot() {
    if (!this.round) return null;
    return { x: this.round.x, y: this.round.y };
  }
}
