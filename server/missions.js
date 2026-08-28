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
 * v1 限定同時只有一個進行中的任務。實體活動的節奏本來就是
 * 「宣布一項 → 大家做 → 收掉 → 下一項」，同時多工只會讓大螢幕與手機的
 * 資訊層級混亂，也讓主辦者難以掌控現場。
 */

import { randomUUID } from 'node:crypto';
import { MISSION_TYPES } from '../shared/protocol.js';
import { COLOR_FAMILY_MAP } from '../shared/colorFamily.js';

export class MissionBoard {
  constructor() {
    /** @type {object|null} 目前進行中的任務 */
    this.active = null;
    /** @type {object[]} 已結算的任務，供主辦端回顧與 WP-C 匯出 */
    this.history = [];
  }

  /**
   * 發布任務。
   * @returns {{ok: true, mission: object} | {ok: false, reason: string}}
   */
  publish({ type, target, colorFamily = null }) {
    if (this.active) return { ok: false, reason: '已有進行中的任務，請先結算' };

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
    }

    this.active = {
      id: `msn_${randomUUID().slice(0, 8)}`,
      type: spec.id,
      title: spec.label,
      brief: spec.brief,
      target: n,
      colorFamily: param,
      publishedAt: Date.now(),
      closedAt: null,
      /** @type {Map<string, number>} 每位參與者的完成次數 */
      progress: new Map(),
      /** @type {object[]} 完成事件流水，供大螢幕回饋與事後分析 */
      events: [],
    };
    return { ok: true, mission: this.active };
  }

  /** 結算並關閉目前任務 */
  close() {
    if (!this.active) return null;
    this.active.closedAt = Date.now();
    const closed = this.active;
    this.history.push(closed);
    this.active = null;
    return closed;
  }

  /** 任務是否進行中 */
  get isActive() {
    return this.active !== null;
  }

  /**
   * 為參與者記一次完成。由各任務型別的驗證器在驗證通過後呼叫。
   * @returns {{count: number, done: boolean} | null}
   */
  credit(agentId, detail = {}) {
    if (!this.active) return null;
    const count = (this.active.progress.get(agentId) ?? 0) + 1;
    this.active.progress.set(agentId, count);
    this.active.events.push({ agentId, at: Date.now(), ...detail });
    return { count, done: count >= this.active.target };
  }

  progressOf(agentId) {
    return this.active?.progress.get(agentId) ?? 0;
  }

  /** 公告用的任務摘要（推送給手機與大螢幕） */
  announcement() {
    if (!this.active) return null;
    const m = this.active;
    return {
      id: m.id, type: m.type, title: m.title, brief: m.brief, target: m.target,
      colorFamily: m.colorFamily ?? null,
    };
  }

  /**
   * 全場進度摘要。
   * @param {number} totalAgents 目前場上人數，用於計算完成率
   */
  state(totalAgents) {
    if (!this.active) return null;
    const m = this.active;
    let finished = 0;
    let totalCompletions = 0;
    for (const count of m.progress.values()) {
      totalCompletions += count;
      if (count >= m.target) finished++;
    }
    return {
      id: m.id,
      title: m.title,
      target: m.target,
      finished,          // 已達標人數
      participating: m.progress.size,
      totalCompletions,
      totalAgents,
    };
  }

  /**
   * 由快照還原。
   *
   * 進行中的任務連同每個人的進度一起還原 —— 伺服器在活動中途重開時，
   * 已經配對到一半的人不該被要求從頭再來。
   */
  hydrate(dump) {
    if (!dump || typeof dump !== 'object') return this;
    const revive = (m) => (m ? {
      ...m,
      progress: new Map(Object.entries(m.progress ?? {})),
      events: Array.isArray(m.events) ? m.events : [],
    } : null);

    this.active = revive(dump.active);
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
      publishedAt: m.publishedAt,
      closedAt: m.closedAt,
      progress: Object.fromEntries(m.progress),
      events: m.events,
    });
    return {
      active: this.active ? dump(this.active) : null,
      history: this.history.map(dump),
    };
  }
}
