/**
 * 配對任務（規格 v3.0 §3.3）
 *
 * 核心洞察：驗證不需要照片。真正的完成證據是「雙方相互確認」，
 * 照片只是副產品。因此本模組完全不觸及相機，也就避開了
 * getUserMedia 需要安全情境的部署阻擋（見規格 §9.1）。
 *
 * 流程：
 *   1. 每人持有一組 4 位配對碼，每 60 秒輪換
 *   2. A 走向 B，口頭索取並輸入 B 的碼        ← 這個索取動作本身就是破冰
 *   3. 伺服器推送確認請求給 B
 *   4. B 按下確認，配對成立，社交圖譜寫入一條邊
 */

import { PAIRING } from './config.js';
import { PAIR_ERRORS } from '../shared/protocol.js';

/** 產生 n 位數字碼 */
function randomCode(length) {
  let s = '';
  for (let i = 0; i < length; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export class PairingSession {
  /**
   * @param {import('./socialgraph.js').SocialGraph} graph
   */
  constructor(graph) {
    this.graph = graph;
    /** @type {Map<string, {code: string, prevCode: string|null, prevUntil: number}>} */
    this.codes = new Map();
    /** 待確認的配對，鍵為被邀請者 id @type {Map<string, {from: string, to: string, expiresAt: number}>} */
    this.pending = new Map();
    /** @type {Map<string, number>} 每人上次提交時間，用於冷卻 */
    this.lastClaimAt = new Map();
    this.lastRotateAt = 0;
  }

  /** 指派一組不與現有碼衝突的配對碼 */
  #freshCode() {
    const taken = new Set();
    for (const entry of this.codes.values()) {
      taken.add(entry.code);
      if (entry.prevCode) taken.add(entry.prevCode);
    }
    // 4 位數共 10000 組，場上僅數十人，碰撞機率極低；仍設上限避免極端情況無限迴圈
    for (let i = 0; i < 200; i++) {
      const code = randomCode(PAIRING.codeLength);
      if (!taken.has(code)) return code;
    }
    return randomCode(PAIRING.codeLength);
  }

  /** 為新加入者配發配對碼 */
  register(agentId) {
    if (this.codes.has(agentId)) return this.codes.get(agentId).code;
    const code = this.#freshCode();
    this.codes.set(agentId, { code, prevCode: null, prevUntil: 0 });
    return code;
  }

  release(agentId) {
    this.codes.delete(agentId);
    this.lastClaimAt.delete(agentId);
    this.pending.delete(agentId);
    // 同時清掉以此人為發起方的待確認
    for (const [to, p] of this.pending) {
      if (p.from === agentId) this.pending.delete(to);
    }
  }

  codeOf(agentId) {
    return this.codes.get(agentId)?.code ?? null;
  }

  /**
   * 輪換所有配對碼。舊碼在寬限期內仍然有效 ——
   * 否則「A 剛把碼唸給 B，B 正在輸入」的瞬間輪換會造成無法理解的失敗。
   * @returns {boolean} 是否確實輪換了（呼叫端據此決定要不要推送新碼）
   */
  rotate(now = Date.now()) {
    if (now - this.lastRotateAt < PAIRING.rotateMs) return false;
    this.lastRotateAt = now;
    for (const [id, entry] of this.codes) {
      entry.prevCode = entry.code;
      entry.prevUntil = now + PAIRING.graceMs;
      entry.code = this.#freshCode();
      this.codes.set(id, entry);
    }
    return true;
  }

  /** 依碼找人，涵蓋仍在寬限期內的舊碼 */
  #findByCode(code, now) {
    for (const [id, entry] of this.codes) {
      if (entry.code === code) return id;
      if (entry.prevCode === code && now < entry.prevUntil) return id;
    }
    return null;
  }

  /** 清除逾時未回應的待確認 */
  sweep(now = Date.now()) {
    const expired = [];
    for (const [to, p] of this.pending) {
      if (now > p.expiresAt) {
        this.pending.delete(to);
        expired.push(p);
      }
    }
    return expired;
  }

  /**
   * A 提交 B 的配對碼。
   * @returns {{ok: true, target: string} | {ok: false, reason: string}}
   */
  claim(fromId, rawCode, now = Date.now(), missionId = null) {
    const last = this.lastClaimAt.get(fromId) ?? 0;
    if (now - last < PAIRING.claimCooldownMs) {
      return { ok: false, reason: PAIR_ERRORS.COOLDOWN };
    }
    this.lastClaimAt.set(fromId, now);

    const code = String(rawCode ?? '').trim();
    if (!/^\d+$/.test(code) || code.length !== PAIRING.codeLength) {
      return { ok: false, reason: PAIR_ERRORS.NOT_FOUND };
    }

    const targetId = this.#findByCode(code, now);
    if (!targetId) return { ok: false, reason: PAIR_ERRORS.NOT_FOUND };
    if (targetId === fromId) return { ok: false, reason: PAIR_ERRORS.SELF };
    if (this.graph.connected(fromId, targetId)) {
      return { ok: false, reason: PAIR_ERRORS.ALREADY_PAIRED };
    }
    // 一人同時只處理一組確認，避免多方同時邀請造成混亂
    if (this.pending.has(targetId)) return { ok: false, reason: PAIR_ERRORS.BUSY };
    for (const p of this.pending.values()) {
      if (p.from === fromId) return { ok: false, reason: PAIR_ERRORS.BUSY };
    }

    this.pending.set(targetId, {
      from: fromId,
      to: targetId,
      expiresAt: now + PAIRING.confirmTimeoutMs,
      // 記下發出邀請當下的任務。確認有 30 秒視窗，主辦端可能在這期間結算
      // 舊任務並發布新的 —— 沒有這個欄位，舊任務的互動會被記到新任務頭上。
      missionId,
    });
    return { ok: true, target: targetId };
  }

  /**
   * 被邀請者回應。
   * @returns {{ok: true, from: string, to: string} | {ok: false, reason: string, from?: string}}
   */
  confirm(agentId, accept, now = Date.now()) {
    const p = this.pending.get(agentId);
    if (!p) return { ok: false, reason: PAIR_ERRORS.EXPIRED };
    this.pending.delete(agentId);

    if (now > p.expiresAt) return { ok: false, reason: PAIR_ERRORS.EXPIRED, from: p.from };
    if (!accept) return { ok: false, reason: PAIR_ERRORS.DECLINED, from: p.from };

    // 帶上 missionId：這條邊是研究資料的主體，少了任務歸屬就只知道
    // 「這兩人碰過面」，無法回答「在哪一項任務下碰面」。
    const isNew = this.graph.connect(p.from, p.to, p.missionId ?? null);
    if (!isNew) return { ok: false, reason: PAIR_ERRORS.ALREADY_PAIRED, from: p.from };
    return { ok: true, from: p.from, to: p.to, missionId: p.missionId ?? null };
  }
}
