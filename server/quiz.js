/**
 * 即時問答（Kahoot 式）
 *
 * 一次一題的狀態機：
 *
 *   出題 ──→ ASKING（倒數中，接受作答）──→ REVEALED（公布正解與分佈）──→ 收題
 *              │                              ▲
 *              └────── 時間到自動揭曉 ─────────┘
 *
 * 兩個不可妥協的規則：
 *
 * 1. ASKING 期間正解絕不離開伺服器。publicView() 是唯一送給客戶端的形狀，
 *    它不含 correctIndex —— 若把整題丟給手機再由前端判分，
 *    現場任何一位會開開發者工具的同學都能拿滿分。
 *
 * 2. 一人一題只能作答一次，且不可更改。這不只是防弊：容許改答案的話，
 *    速度分就失去意義（大家都會先亂按搶時間再改），
 *    而速度分正是這類問答讓現場緊張起來的來源。
 *
 * 判分與計時由本檔負責，但寫入積分帳本的動作留給呼叫端 ——
 * 帳本只該有一個寫入點，才不會出現「這分是誰加的」查不到的情況。
 */

import { QUIZ, QUIZ_ERRORS, QUIZ_PHASE } from '../shared/protocol.js';
import { QUIZ_TUNING, SCORING } from './config.js';
import { randomUUID } from 'node:crypto';

const clean = (raw, max) => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class QuizSession {
  constructor() {
    /** @type {object|null} 目前的題目 */
    this.current = null;
    /** @type {object[]} 已收掉的題目，供主辦端回顧與 WP-C 匯出 */
    this.history = [];
    /** 已出過幾題，用於「第 N 題」的顯示 */
    this.asked = 0;
  }

  get isActive() { return this.current !== null; }
  get phase() { return this.current?.phase ?? null; }

  /**
   * 出題。
   * @returns {{ok: true, quiz: object} | {ok: false, reason: string}}
   */
  start({ question, options, correctIndex, durationMs }, now = Date.now()) {
    if (this.current) return { ok: false, reason: '上一題還沒收掉，請先結束本題' };

    const text = clean(question, QUIZ.maxQuestionLength);
    if (!text) return { ok: false, reason: '題目不可為空' };

    if (!Array.isArray(options)) return { ok: false, reason: '選項格式錯誤' };
    const opts = options.map((o) => clean(o, QUIZ.maxOptionLength)).filter(Boolean);
    if (opts.length < QUIZ.minOptions || opts.length > QUIZ.maxOptions) {
      return { ok: false, reason: `選項須為 ${QUIZ.minOptions} 至 ${QUIZ.maxOptions} 個` };
    }

    const correct = Number(correctIndex);
    if (!Number.isInteger(correct) || correct < 0 || correct >= opts.length) {
      return { ok: false, reason: '請指定正確答案' };
    }

    const ms = Number(durationMs) || QUIZ.defaultDurationMs;
    if (ms < QUIZ.minDurationMs || ms > QUIZ.maxDurationMs) {
      return {
        ok: false,
        reason: `作答時間須介於 ${QUIZ.minDurationMs / 1000} 至 ${QUIZ.maxDurationMs / 1000} 秒`,
      };
    }

    this.asked++;
    this.current = {
      id: `qz_${randomUUID().slice(0, 8)}`,
      index: this.asked,
      question: text,
      options: opts,
      correctIndex: correct,
      durationMs: ms,
      startedAt: now,
      endsAt: now + ms,
      revealedAt: null,
      phase: QUIZ_PHASE.ASKING,
      /** @type {Map<string, {choice: number, at: number, elapsedMs: number}>} */
      answers: new Map(),
    };
    return { ok: true, quiz: this.current };
  }

  /**
   * 送給客戶端的題目形狀。刻意不含 correctIndex。
   *
   * 送 remainingMs 而不是 endsAt：手機的系統時間常常是歪的
   * （現場一定有人時區或時鐘不準），用絕對時戳倒數會出現
   * 「一進來就剩負秒數」。剩餘毫秒由伺服器在送出當下算，
   * 客戶端只要自己往下數就好，中途進場的人也能拿到正確的殘餘時間。
   */
  publicView(now = Date.now()) {
    const q = this.current;
    if (!q) return null;
    return {
      id: q.id,
      index: q.index,
      question: q.question,
      options: q.options,
      durationMs: q.durationMs,
      remainingMs: Math.max(0, q.endsAt - now),
      phase: q.phase,
      answered: q.answers.size,
    };
  }

  /**
   * 作答。
   * @returns {{ok: true, choice: number, elapsedMs: number} | {ok: false, reason: string}}
   */
  answer(agentId, rawChoice, now = Date.now()) {
    const q = this.current;
    if (!q) return { ok: false, reason: QUIZ_ERRORS.NO_QUIZ };
    if (q.phase !== QUIZ_PHASE.ASKING) return { ok: false, reason: QUIZ_ERRORS.CLOSED };
    if (now > q.endsAt + QUIZ_TUNING.lateGraceMs) return { ok: false, reason: QUIZ_ERRORS.CLOSED };
    if (q.answers.has(agentId)) return { ok: false, reason: QUIZ_ERRORS.ALREADY_ANSWERED };

    // 只收真正的整數。不做型別寬容轉換 —— Number(null) 是 0，
    // 一個欄位漏填的客戶端會因此被判成「選了第一個選項」，
    // 那是無聲的錯誤答案，比直接拒收糟糕得多。
    const choice = rawChoice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) {
      return { ok: false, reason: QUIZ_ERRORS.BAD_CHOICE };
    }

    // 寬限期內的作答以完整時長計，晚到不會反而多拿速度分
    const elapsedMs = Math.min(Math.max(0, now - q.startedAt), q.durationMs);
    q.answers.set(agentId, { choice, at: now, elapsedMs });
    return { ok: true, choice, elapsedMs };
  }

  /** 作答人數（不含分佈 —— 倒數期間洩漏分佈等於洩漏答案） */
  tally() {
    return { id: this.current?.id ?? null, answered: this.current?.answers.size ?? 0 };
  }

  /** 時間到（含寬限）且尚未揭曉 */
  shouldAutoReveal(now = Date.now()) {
    const q = this.current;
    return !!q && q.phase === QUIZ_PHASE.ASKING && now > q.endsAt + QUIZ_TUNING.lateGraceMs;
  }

  /** 揭曉後主辦端遲遲沒收題，時間到就自動收掉，避免題目卡在大螢幕上 */
  shouldAutoEnd(now = Date.now()) {
    const q = this.current;
    return !!q && q.phase === QUIZ_PHASE.REVEALED
      && now - q.revealedAt > QUIZ_TUNING.revealHoldMs;
  }

  /**
   * 公布正解並算分。
   *
   * 速度分：立刻答對得滿額加成，鈴響前一刻答對得 0。
   * 這讓「知道答案」與「反應快」都有回報，而答錯永遠是 0 分 ——
   * 亂按搶時間不會有任何期望值。
   *
   * @returns {{correctIndex: number, counts: number[], totalAnswers: number,
   *            awards: {agentId: string, choice: number, correct: boolean,
   *                     elapsedMs: number, points: number}[]} | null}
   */
  reveal(now = Date.now()) {
    const q = this.current;
    if (!q || q.phase !== QUIZ_PHASE.ASKING) return null;
    q.phase = QUIZ_PHASE.REVEALED;
    q.revealedAt = now;

    const counts = new Array(q.options.length).fill(0);
    const awards = [];
    for (const [agentId, a] of q.answers) {
      counts[a.choice]++;
      const correct = a.choice === q.correctIndex;
      const speed = correct
        ? Math.round(SCORING.quizSpeedBonus * (1 - a.elapsedMs / q.durationMs))
        : 0;
      const points = correct ? SCORING.quizCorrect + speed : 0;
      awards.push({ agentId, choice: a.choice, correct, elapsedMs: a.elapsedMs, points });
    }

    return {
      id: q.id,
      correctIndex: q.correctIndex,
      counts,
      totalAnswers: q.answers.size,
      awards,
    };
  }

  /** 揭曉後的結果視圖，供中途連上的大螢幕補畫 */
  revealView() {
    const q = this.current;
    if (!q || q.phase !== QUIZ_PHASE.REVEALED) return null;
    const counts = new Array(q.options.length).fill(0);
    for (const a of q.answers.values()) counts[a.choice]++;
    return {
      id: q.id, correctIndex: q.correctIndex, counts, totalAnswers: q.answers.size,
    };
  }

  /** 收題。未揭曉就收掉時不算分，等同作廢本題。 */
  end() {
    const q = this.current;
    if (!q) return null;
    q.endedAt = Date.now();
    this.history.push(q);
    this.current = null;
    return q;
  }

  /**
   * 由快照還原。
   *
   * 刻意不還原「進行中的那一題」：倒數是相對於伺服器啟動前的時間算的，
   * 重開之後那個截止時間已經沒有意義，而參與者手上的題目畫面也早就消失。
   * 正確的處置是把它併入歷史（未揭曉即作廢），由主辦端重新出題。
   * 題號則繼續往下數，這樣匯出的資料裡不會出現兩個「第 3 題」。
   */
  hydrate(dump) {
    if (!dump || typeof dump !== 'object') return this;
    const revive = (q) => ({ ...q, answers: new Map(
      (q.answers ?? []).map((a) => [a.agentId, { choice: a.choice, at: a.at ?? 0, elapsedMs: a.elapsedMs }]),
    ) });

    this.history = (dump.history ?? []).map(revive);
    if (dump.current) this.history.push(revive(dump.current));
    this.asked = this.history.reduce((max, q) => Math.max(max, q.index ?? 0), 0);
    this.current = null;
    return this;
  }

  /** 匯出供 WP-C 分析。含每個人的選擇與作答耗時，可分析猶豫程度。 */
  export() {
    const dump = (q) => ({
      id: q.id,
      index: q.index,
      question: q.question,
      options: q.options,
      correctIndex: q.correctIndex,
      durationMs: q.durationMs,
      startedAt: q.startedAt,
      revealedAt: q.revealedAt,
      answers: [...q.answers].map(([agentId, a]) => ({
        agentId, choice: a.choice, elapsedMs: a.elapsedMs,
      })),
    });
    return {
      current: this.current ? dump(this.current) : null,
      history: this.history.map(dump),
    };
  }
}
