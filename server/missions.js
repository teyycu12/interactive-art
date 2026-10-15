/**
 * 任務生命週期（規格 v3.0 §3.1）
 *
 *   發布 → 執行 → 提交 → 驗證 → 回饋 → 結算
 *
 * 本檔只負責通用的生命週期與進度記帳，不含任何特定任務的規則。
 * 各任務型別的「提交什麼」與「怎麼驗證」由外部的驗證器（如 pairing.js）實作，
 * 完成時呼叫 credit() 記帳即可。三種任務型別的驗證模型差異極大
 * （雙方確認 / 自動比對 / 人工審核），硬塞進同一套判定邏輯會失控。
 *
 * 可以同時進行好幾個任務（2026-10-17，原本限一個）：例如「找一個人配對」與
 * 「找穿紅色的人」同時開著，一次配對符合哪幾個就同時記進哪幾個。
 * 上限 MAX_ACTIVE_MISSIONS 個，同一種任務（同型別、同顏色）不能重複開 ——
 * 重複的兩個任務會讓一次配對被記兩次，手機上也分不出是哪一個。
 * 問答、文字雲、賓果仍是一次一個（見 server/index.js 的 busyActivity）。
 */

import { randomUUID } from 'node:crypto';
import { MISSION_TYPES, MISSION_DURATIONS } from '../shared/protocol.js';
import { COLOR_FAMILY_MAP } from '../shared/colorFamily.js';

/** 同時進行中的任務上限：再多手機的任務橫幅與大螢幕的「進行中」一列就放不下了 */
export const MAX_ACTIVE_MISSIONS = 4;

/**
 * 兩個任務「一樣」的判定依據：型別加上條件本身，不含顯示用的文字。
 * 「找貓頭鷹」與「找老虎」可以同時開，兩個「找貓頭鷹」不行。
 */
function ruleKey(rule) {
  return JSON.stringify([
    rule.type, rule.colorFamily ?? null, rule.trait?.key ?? null, rule.trait?.value ?? null,
    rule.traitKey ?? null, rule.spot ?? null,
  ]);
}

function titleOf(spec, rule) {
  switch (spec.id) {
    case 'COLOR_HUNT': return `找${rule.label}的人配對`;
    case 'TRAIT_HUNT': return `找「${rule.label}」的人配對`;
    case 'GATHER': return `${rule.teamSize} 人到${rule.label}集合`;
    case 'DIFF_TRAIT':
    case 'SAME_TRAIT': return `${spec.label}（依${rule.title}）`;
    default: return spec.label;
  }
}

export class MissionBoard {
  constructor() {
    /** @type {object[]} 進行中的任務，依發布順序 */
    this.actives = [];
    /** @type {object[]} 已結算的任務，供主辦端回顧與 WP-C 匯出 */
    this.history = [];
  }

  /**
   * 發布任務。
   * @returns {{ok: true, mission: object} | {ok: false, reason: string}}
   */
  publish({ type, target, colorFamily = null, rule = null, durationMs = 0, now = Date.now() }) {
    if (this.actives.length >= MAX_ACTIVE_MISSIONS) {
      return { ok: false, reason: `同時最多 ${MAX_ACTIVE_MISSIONS} 個任務，請先結算一個` };
    }

    const spec = MISSION_TYPES[type];
    if (!spec) return { ok: false, reason: `未知的任務型別：${type}` };

    const n = Number(target);
    if (!Number.isInteger(n) || n < 1 || n > spec.maxTarget) {
      return { ok: false, reason: `目標次數須為 1 至 ${spec.maxTarget} 的整數` };
    }

    // 帶額外參數的任務型別在這裡驗證。白名單比對而非只檢查非空 ——
    // 這個值會被送到三端顯示，且是配對判定的依據。
    let param = null;
    if (spec.param === 'colorFamily') {
      if (!COLOR_FAMILY_MAP[colorFamily]) {
        return { ok: false, reason: `未知的顏色：${colorFamily}` };
      }
      param = colorFamily;
    } else if (spec.param && rule?.type !== spec.id) {
      // 標籤與集合點要對照場上現況才驗得了，由呼叫端先以 missionRules.buildRule() 整理好
      return { ok: false, reason: '任務條件不完整' };
    }

    const finalRule = rule ?? (param ? { type: spec.id, colorFamily: param, label: COLOR_FAMILY_MAP[param].label } : { type: spec.id });
    if (this.actives.some((m) => ruleKey(m.rule ?? { type: m.type, colorFamily: m.colorFamily }) === ruleKey(finalRule))) {
      return { ok: false, reason: '同樣的任務已經在進行中' };
    }

    // 限時由伺服器計時而非主辦端：主辦端的分頁可能被關掉或休眠，
    // 那時任務仍要照宣布的時間收掉，大家才不會一直配對下去。
    const limit = Number(durationMs ?? 0);
    if (!MISSION_DURATIONS.includes(limit)) {
      return { ok: false, reason: '不支援這個時間限制' };
    }

    const mission = {
      id: `msn_${randomUUID().slice(0, 8)}`,
      type: spec.id,
      // 標題帶上條件（顏色、類型、集合點）：同型別的兩個任務同時開著時，三端才分得出是哪一個
      title: titleOf(spec, finalRule),
      brief: spec.brief,
      target: n,
      colorFamily: param,
      /** 條件（missionRules.buildRule 的結果）。PAIRING 為 { type } */
      rule: finalRule,
      publishedAt: now,
      closedAt: null,
      /** 限時任務的截止時間；不限時為 null */
      endsAt: limit > 0 ? now + limit : null,
      /** @type {Map<string, number>} 每位參與者的完成次數 */
      progress: new Map(),
      /** @type {object[]} 完成事件流水，供大螢幕回饋與事後分析 */
      events: [],
    };
    this.actives.push(mission);
    return { ok: true, mission };
  }

  /** 進行中的某個任務 */
  get(id) {
    return this.actives.find((m) => m.id === id) ?? null;
  }

  /** 結算並關閉某個任務 */
  close(id, now = Date.now()) {
    const i = this.actives.findIndex((m) => m.id === id);
    if (i === -1) return null;
    const [closed] = this.actives.splice(i, 1);
    closed.closedAt = now;
    this.history.push(closed);
    return closed;
  }

  /** 限時已到、該由主迴圈結算的任務 id */
  expired(now = Date.now()) {
    return this.actives.filter((m) => m.endsAt && now >= m.endsAt).map((m) => m.id);
  }

  /** 有沒有任何進行中的任務 */
  get isActive() {
    return this.actives.length > 0;
  }

  /**
   * 為參與者在某個任務記一次完成。由各任務型別的驗證器在驗證通過後呼叫。
   * @returns {{count: number, done: boolean} | null} 任務不存在（已結算）時回 null
   */
  credit(id, agentId, detail = {}) {
    const m = this.get(id);
    if (!m) return null;
    const count = (m.progress.get(agentId) ?? 0) + 1;
    m.progress.set(agentId, count);
    m.events.push({ agentId, at: Date.now(), ...detail });
    return { count, done: count >= m.target };
  }

  progressOf(id, agentId) {
    return this.get(id)?.progress.get(agentId) ?? 0;
  }

  /** 某人在每個進行中任務的進度 {missionId: 次數}（主辦端名冊用） */
  progressMap(agentId) {
    return Object.fromEntries(this.actives.map((m) => [m.id, m.progress.get(agentId) ?? 0]));
  }

  /** 公告用的任務摘要（推送給手機與大螢幕） */
  announcement(id) {
    const m = this.get(id);
    if (!m) return null;
    return {
      id: m.id, type: m.type, title: m.title, brief: m.brief, target: m.target,
      colorFamily: m.colorFamily ?? null,
      rule: m.rule ?? { type: m.type },
    };
  }

  announcements() {
    return this.actives.map((m) => this.announcement(m.id));
  }

  /**
   * 某個任務的全場進度摘要。
   * @param {number} totalAgents 目前場上人數，用於計算完成率
   */
  state(id, totalAgents, now = Date.now()) {
    const m = this.get(id);
    if (!m) return null;
    let finished = 0;
    let totalCompletions = 0;
    for (const count of m.progress.values()) {
      totalCompletions += count;
      if (count >= m.target) finished++;
    }
    return {
      id: m.id,
      type: m.type,
      title: m.title,
      colorFamily: m.colorFamily ?? null,
      target: m.target,
      rule: m.rule ?? { type: m.type },
      finished,          // 已達標人數
      participating: m.progress.size,
      totalCompletions,
      totalAgents,
      // 送剩餘毫秒而非截止時刻：主辦端的電腦時鐘不一定準（理由同問答的 remainingMs）
      remainingMs: m.endsAt ? Math.max(0, m.endsAt - now) : null,
    };
  }

  states(totalAgents, now = Date.now()) {
    return this.actives.map((m) => this.state(m.id, totalAgents, now));
  }

  /**
   * 由快照還原。
   *
   * 進行中的任務連同每個人的進度一起還原 —— 伺服器在活動中途重開時，
   * 已經配對到一半的人不該被要求從頭再來。舊版快照只有一個 active，照樣讀得回來。
   */
  hydrate(dump) {
    if (!dump || typeof dump !== 'object') return this;
    const revive = (m) => (m ? {
      ...m,
      progress: new Map(Object.entries(m.progress ?? {})),
      events: Array.isArray(m.events) ? m.events : [],
    } : null);

    const actives = Array.isArray(dump.actives) ? dump.actives : (dump.active ? [dump.active] : []);
    this.actives = actives.map(revive).filter(Boolean);
    this.history = (dump.history ?? []).map(revive).filter(Boolean);
    return this;
  }

  /** 匯出供 WP-C 分析 */
  export() {
    const dump = (m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      brief: m.brief,
      target: m.target,
      colorFamily: m.colorFamily ?? null,
      rule: m.rule ?? { type: m.type },
      publishedAt: m.publishedAt,
      closedAt: m.closedAt,
      endsAt: m.endsAt ?? null,
      progress: Object.fromEntries(m.progress),
      events: m.events,
    });
    return {
      actives: this.actives.map(dump),
      history: this.history.map(dump),
    };
  }
}
