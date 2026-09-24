/**
 * 轉場問卷（沒有正確答案的題目）
 *
 * 用途是在切換場景的空檔問一題，把答案留成參與者身上的標籤，
 * 讓後續任務可以用「答某個選項的人」當成條件。
 *
 * ── 為什麼不併進 quiz.js ──
 * 問答有兩條不可妥協的規則：正解絕不離開伺服器、一人一題只能答一次且不可更改
 * （否則速度分失去意義）。問卷兩條都不適用 —— 它沒有正解，改答案也無所謂。
 * 把兩者塞進同一個狀態機，等於讓每個分支都得先問「這題算不算分」，
 * 而算錯的那一次不會報錯，只會讓某個人莫名其妙多了 100 分。
 * 這與 missions.js 開頭「驗證模型差異極大的任務不共用判定邏輯」是同一個判斷。
 *
 * ── 標籤在作答當下就寫入，不等收題 ──
 * 標籤才是問卷的產物，題目只是取得它的手段。等收題才寫的話，
 * 主辦端忘記收題（現場很常見）就等於整題白問；而且中途離場的人
 * 已經回答過了，沒有理由不算。
 */

import { randomUUID } from 'node:crypto';
import { SURVEY, SURVEY_BANK_MAP } from '../shared/surveys.js';

const clean = (raw, max) => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class SurveySession {
  constructor() {
    /** @type {object|null} 目前進行中的題目 */
    this.current = null;
    /** @type {object[]} 已收掉的題目 */
    this.history = [];
    /** 已問過幾題 */
    this.asked = 0;
    /**
     * 參與者身上的標籤：agentId → key → {value, label, questionId, at}
     *
     * 跟著角色走，不跟著題目走 —— 題目收掉之後標籤仍在，那正是後續任務要用的東西。
     * @type {Map<string, Map<string, object>>}
     */
    this.traits = new Map();
  }

  get isActive() { return this.current !== null; }

  /**
   * 出題。可帶 bankId 從題庫取，或自訂 key / question / options。
   * @returns {{ok: true, survey: object} | {ok: false, reason: string}}
   */
  start({ bankId = null, key, question, options, durationMs }, now = Date.now()) {
    if (this.current) return { ok: false, reason: '上一題問卷還沒收掉，請先結束本題' };

    let spec = { key, question, options };
    if (bankId !== null && bankId !== undefined && bankId !== '') {
      const preset = SURVEY_BANK_MAP[bankId];
      if (!preset) return { ok: false, reason: `題庫裡沒有這一題：${bankId}` };
      spec = preset;
    }

    const traitKey = clean(spec.key, SURVEY.maxKeyLength);
    // 標籤名稱會成為物件的鍵，擋下原型鏈上的名字：以 __proto__ 當 key 時
    // 寫入會靜默地改到原型而不是資料，讀回來永遠是 undefined。
    if (!traitKey || traitKey === '__proto__' || traitKey === 'constructor' || traitKey === 'prototype') {
      return { ok: false, reason: '標籤名稱不合法' };
    }

    const text = clean(spec.question, SURVEY.maxQuestionLength);
    if (!text) return { ok: false, reason: '題目不可為空' };

    if (!Array.isArray(spec.options)) return { ok: false, reason: '選項格式錯誤' };
    const opts = [];
    for (const [i, o] of spec.options.entries()) {
      const label = clean(typeof o === 'string' ? o : o?.label, SURVEY.maxOptionLength);
      if (!label) continue;
      const value = clean(typeof o === 'string' ? o : (o?.value ?? o?.label), SURVEY.maxOptionLength) || `opt_${i}`;
      const spot = typeof o?.spot === 'string' ? o.spot : null;
      opts.push({ label, value, spot });
    }
    if (opts.length < SURVEY.minOptions || opts.length > SURVEY.maxOptions) {
      return { ok: false, reason: `選項須為 ${SURVEY.minOptions} 至 ${SURVEY.maxOptions} 個` };
    }
    if (new Set(opts.map((o) => o.value)).size !== opts.length) {
      return { ok: false, reason: '選項的值不可重複' };
    }

    const ms = Number(durationMs) || SURVEY.defaultDurationMs;
    if (ms < SURVEY.minDurationMs || ms > SURVEY.maxDurationMs) {
      return {
        ok: false,
        reason: `作答時間須介於 ${SURVEY.minDurationMs / 1000} 至 ${SURVEY.maxDurationMs / 1000} 秒`,
      };
    }

    this.asked++;
    this.current = {
      id: `sv_${randomUUID().slice(0, 8)}`,
      index: this.asked,
      key: traitKey,
      question: text,
      options: opts,
      durationMs: ms,
      startedAt: now,
      endsAt: now + ms,
      /** @type {Map<string, {choice: number, at: number}>} */
      answers: new Map(),
    };
    return { ok: true, survey: this.current };
  }

  /**
   * 送給客戶端的形狀。
   *
   * 與問答一樣送 remainingMs 而非 endsAt：現場一定有人的手機時鐘不準，
   * 用絕對時戳倒數會出現「一進來就剩負秒數」。
   */
  publicView(now = Date.now()) {
    const s = this.current;
    if (!s) return null;
    return {
      id: s.id,
      index: s.index,
      key: s.key,
      question: s.question,
      options: s.options.map((o) => ({ label: o.label, value: o.value, spot: o.spot })),
      durationMs: s.durationMs,
      remainingMs: Math.max(0, s.endsAt - now),
      answered: s.answers.size,
    };
  }

  /**
   * 作答。與問答不同，**允許改答案** —— 沒有速度分，改了也沒有人吃虧，
   * 而按錯卻不能改會讓那個人身上的標籤一直是錯的。
   * @returns {{ok: true, choice: number, option: object} | {ok: false, reason: string}}
   */
  answer(agentId, rawChoice, now = Date.now()) {
    const s = this.current;
    if (!s) return { ok: false, reason: 'NO_SURVEY' };
    if (now > s.endsAt + 1500) return { ok: false, reason: 'CLOSED' };
    const choice = rawChoice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= s.options.length) {
      return { ok: false, reason: 'BAD_CHOICE' };
    }
    s.answers.set(agentId, { choice, at: now });
    const option = s.options[choice];
    this.setTrait(agentId, s.key, { value: option.value, label: option.label, spot: option.spot, questionId: s.id, at: now });
    return { ok: true, choice, option };
  }

  /** 寫入標籤。以 Map 存而非物件，避開鍵名與原型衝突的問題。 */
  setTrait(agentId, key, entry) {
    if (!this.traits.has(agentId)) this.traits.set(agentId, new Map());
    this.traits.get(agentId).set(key, entry);
  }

  /** 作答人數。倒數期間可以公布 —— 問卷沒有正解，先知道分佈也不影響任何人。 */
  tally() {
    return { id: this.current?.id ?? null, answered: this.current?.answers.size ?? 0 };
  }

  /** 目前這題的分佈。任何時候都能取，供大螢幕即時長出長條圖。 */
  distribution(now = Date.now()) {
    const s = this.current;
    if (!s) return null;
    const counts = new Array(s.options.length).fill(0);
    for (const a of s.answers.values()) counts[a.choice]++;
    return {
      id: s.id,
      key: s.key,
      question: s.question,
      options: s.options.map((o) => ({ label: o.label, value: o.value, spot: o.spot })),
      counts,
      totalAnswers: s.answers.size,
      remainingMs: Math.max(0, s.endsAt - now),
    };
  }

  /** 時間到（含 1.5 秒寬限）就自動收題，避免題目卡在大螢幕上 */
  shouldAutoClose(now = Date.now()) {
    return !!this.current && now > this.current.endsAt + 1500;
  }

  /** 收題。標籤在作答當下就寫過了，這裡只是把題目移進歷史。 */
  close(now = Date.now()) {
    const s = this.current;
    if (!s) return null;
    const result = this.distribution(now);
    s.closedAt = now;
    this.history.push(s);
    this.current = null;
    return result;
  }

  // ── 供後續任務查詢 ────────────────────────────────────────

  /** 某人身上某個標籤的內容（含 label 與 spot），沒有回 null */
  traitOf(agentId, key) { return this.traits.get(agentId)?.get(key) ?? null; }

  /** 某人身上所有標籤，攤平成純物件供 HOST_STATE 與匯出使用 */
  traitsOf(agentId) {
    const m = this.traits.get(agentId);
    if (!m) return {};
    return Object.fromEntries([...m].map(([k, v]) => [k, { value: v.value, label: v.label }]));
  }

  /** 標籤為某個值的所有人。集合任務的判定依據。 */
  agentsWith(key, value) {
    const out = [];
    for (const [agentId, m] of this.traits) if (m.get(key)?.value === value) out.push(agentId);
    return out;
  }

  /**
   * 某個標籤在場上的分佈，只算還在場的人。
   * @param {string} key
   * @param {(id: string) => boolean} isPresent
   */
  spread(key, isPresent = () => true) {
    const counts = new Map();
    for (const [agentId, m] of this.traits) {
      const t = m.get(key);
      if (!t || !isPresent(agentId)) continue;
      counts.set(t.value, (counts.get(t.value) ?? 0) + 1);
    }
    return counts;
  }

  /** 忘掉某個人的所有標籤（主動離場時呼叫，與角色一起消失） */
  forget(agentId) { this.traits.delete(agentId); }

  hydrate(dump) {
    if (!dump || typeof dump !== 'object') return this;
    // 與 quiz 相同：不還原進行中的那一題。倒數是相對於重開前算的，
    // 重開之後那個截止時間已經沒有意義，參與者手上的題目畫面也早就消失了。
    const revive = (s) => ({ ...s, answers: new Map((s.answers ?? []).map((a) => [a.agentId, { choice: a.choice, at: a.at ?? 0 }])) });
    this.history = (dump.history ?? []).map(revive);
    if (dump.current) this.history.push(revive(dump.current));
    this.asked = this.history.reduce((max, s) => Math.max(max, s.index ?? 0), 0);
    this.current = null;
    // 標籤要還原：它是「這個人是誰」，不是「這一題問到哪」。
    // 伺服器重開後參與者以原憑證接回同一個角色 id，標籤必須還在，
    // 否則以標籤為條件的任務會在重開後把所有人都判成不符合。
    this.traits = new Map(
      (dump.traits ?? []).map((row) => [row.agentId, new Map(Object.entries(row.tags ?? {}))]),
    );
    return this;
  }

  export() {
    const dump = (s) => ({
      id: s.id, index: s.index, key: s.key, question: s.question,
      options: s.options, durationMs: s.durationMs, startedAt: s.startedAt, closedAt: s.closedAt ?? null,
      answers: [...s.answers].map(([agentId, a]) => ({ agentId, choice: a.choice, at: a.at })),
    });
    return {
      current: this.current ? dump(this.current) : null,
      history: this.history.map(dump),
      traits: [...this.traits].map(([agentId, m]) => ({ agentId, tags: Object.fromEntries(m) })),
    };
  }
}
