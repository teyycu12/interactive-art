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
import { PROPS } from '../shared/scene.js';

const PROP_BY_ID = new Map(PROPS.map((p) => [p.id, p]));

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
  start({ bankId = null, key, question, options, durationMs, requireArrival }, now = Date.now()) {
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

    // 「到場才算」只在每個選項都綁了地點時成立 —— 少一個地點，選那一項的人
    // 就永遠到不了位，而畫面上只會顯示那一欄的到位數停在 0，看不出原因。
    const everyOptionHasSpot = opts.every((o) => o.spot && PROP_BY_ID.has(o.spot));
    const arrival = requireArrival === undefined ? everyOptionHasSpot : (!!requireArrival && everyOptionHasSpot);

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
      requireArrival: arrival,
      /** @type {Map<string, {choice: number, at: number, arrived: boolean, arrivedAt: number|null}>} */
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
      requireArrival: s.requireArrival,
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
    // 改答案要把到位狀態一起歸零：原本站在 A 桌旁的人改選 B，
    // 不重設的話他會以「已到位」的身分留在 B 的統計裡，而人根本沒動。
    s.answers.set(agentId, { choice, at: now, arrived: false, arrivedAt: null });
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

  /**
   * 更新「到位」狀態。由主迴圈每拍呼叫，傳入查座標的函式。
   *
   * 到位由伺服器自己的座標判定，不是手機回報的 ——
   * 手機根本不知道自己在房間的哪裡（它只有搖桿），而就算知道也不該由它說了算。
   *
   * @param {(agentId: string) => {x: number, y: number} | null} positionOf
   * @returns {string[]} 到位狀態有變的人，供伺服器通知他們的手機
   */
  syncArrivals(positionOf) {
    const s = this.current;
    if (!s || !s.requireArrival) return [];
    const changed = [];
    for (const [agentId, a] of s.answers) {
      const spot = s.options[a.choice]?.spot;
      const prop = spot ? PROP_BY_ID.get(spot) : null;
      const pos = prop ? positionOf(agentId) : null;
      // 查不到座標（人已離場）時維持原狀而不是判成離開：那一瞬間的閃爍
      // 會讓大螢幕的到位數跳動，而現場會以為是自己走錯了
      if (!pos) continue;
      const reach = (prop.r ?? 0) + SURVEY.arriveRadius;
      const here = Math.hypot(pos.x - prop.x, pos.y - prop.y) <= reach;
      if (here === a.arrived) continue;
      a.arrived = here;
      // arrivedAt 只記第一次：它是「這個人完成過這題」的證據，
      // 之後走開不該把它抹掉，否則任務結算時先到先走的人會全部不算
      if (here && a.arrivedAt === null) {
        a.arrivedAt = Date.now();
        const trait = this.traits.get(agentId)?.get(s.key);
        if (trait) trait.arrivedAt = a.arrivedAt;
      }
      changed.push(agentId);
    }
    return changed;
  }

  /** 某個人在這一題是否正站在自己選的地點旁 */
  isArrived(agentId) {
    return this.current?.answers.get(agentId)?.arrived === true;
  }

  /** 目前這題的分佈。任何時候都能取，供大螢幕即時長出長條圖。 */
  distribution(now = Date.now()) {
    const s = this.current;
    if (!s) return null;
    const counts = new Array(s.options.length).fill(0);
    const arrived = new Array(s.options.length).fill(0);
    for (const a of s.answers.values()) {
      counts[a.choice]++;
      if (a.arrived) arrived[a.choice]++;
    }
    // 答了但還沒走到的人。大螢幕用它在那幾個角色頭上標一個記號 ——
    // 「還差一個」只說得出數字，說不出是誰，而旁邊的人看得到記號就會開口提醒他。
    // 這正是本專案對新玩法的判準：通關路徑上要有一步必須跟另一個人講話。
    //
    // 個人選了什麼因此會公開，但這類題目本來就是走過去給全場看的 ——
    // 站進圈子的那一刻答案已經公開，記號只是早幾秒。
    const pending = [];
    if (s.requireArrival) {
      for (const [agentId, a] of s.answers) if (!a.arrived) pending.push({ id: agentId, choice: a.choice });
    }

    return {
      id: s.id,
      key: s.key,
      question: s.question,
      options: s.options.map((o) => ({ label: o.label, value: o.value, spot: o.spot })),
      counts,
      // 選了之後真的走過去的人。要到場才算的題目，這一欄才是成績。
      arrived,
      pending,
      requireArrival: s.requireArrival,
      totalAnswers: s.answers.size,
      totalArrived: arrived.reduce((sum, n) => sum + n, 0),
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
    const revive = (s) => ({ ...s, answers: new Map((s.answers ?? []).map((a) => [a.agentId, { choice: a.choice, at: a.at ?? 0, arrived: false, arrivedAt: a.arrivedAt ?? null }])) });
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
      id: s.id, index: s.index, key: s.key, question: s.question, requireArrival: s.requireArrival ?? false,
      options: s.options, durationMs: s.durationMs, startedAt: s.startedAt, closedAt: s.closedAt ?? null,
      answers: [...s.answers].map(([agentId, a]) => ({ agentId, choice: a.choice, at: a.at, arrivedAt: a.arrivedAt ?? null })),
    });
    return {
      current: this.current ? dump(this.current) : null,
      history: this.history.map(dump),
      traits: [...this.traits].map(([agentId, m]) => ({ agentId, tags: Object.fromEntries(m) })),
    };
  }
}
