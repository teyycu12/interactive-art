/**
 * 文字雲（主持人提問，參與者用手機輸入，大螢幕即時呈現）
 *
 * 一次一題。答案依 wordKey 彙整成「詞 → 票數」，同一個人重複送同一個詞只算一次。
 *
 * ── 公開投影的自由文字 ──
 * 答案會投到全場看的大螢幕上，而現場是校園公共空間，因此：
 *   - 送出時就以入場名稱同一套詞表（nameFilter.js）擋掉不雅字，被擋的不進雲。
 *   - 主持人可以隱藏任何一個詞：之後同一個詞再有人送也不會出現（本題內）。
 *   - 大螢幕不顯示是誰寫的；主辦端也只看得到詞與票數。
 *
 * ── 這個玩法與專案判準的關係 ──
 * INTERACTION-DESIGN 的判準是「通關路徑上要有一步必須開口講話」，文字雲本身不滿足：
 * 它是全場一起「說」，但每個人是對著手機。它的價值在於把現場的想法攤在大螢幕上，
 * 讓主持人接著問「誰寫了這個？」—— 開口的那一步在主持人手上，不在系統裡。
 */

import { randomUUID } from 'node:crypto';
import { WORDCLOUD, cleanAnswer, wordKey } from '../shared/wordcloud.js';
import { isBlockedName } from './nameFilter.js';

export const WORDCLOUD_ERRORS = {
  NO_ROUND: 'NO_ROUND',
  EMPTY: 'EMPTY',
  TOO_LONG: 'TOO_LONG',
  BLOCKED: 'BLOCKED',      // 不雅字
  LIMIT: 'LIMIT',          // 已送滿 maxPerPerson 個
  DUPLICATE: 'DUPLICATE',  // 自己已經送過這個詞
};

export class WordCloudSession {
  constructor() {
    /** @type {object|null} */
    this.current = null;
    /** 已收掉的題目（給活動報告用），只留詞與票數 */
    this.history = [];
  }

  get isActive() { return this.current !== null; }

  /**
   * 出題。
   * @returns {{ok: true, round: object} | {ok: false, reason: string}}
   */
  start({ question } = {}, now = Date.now()) {
    if (this.current) return { ok: false, reason: '上一題文字雲還沒收掉，請先結束本題' };
    const q = cleanAnswer(question);
    if (!q) return { ok: false, reason: '請輸入題目' };
    if ([...q].length > WORDCLOUD.maxQuestionLength) {
      return { ok: false, reason: `題目最多 ${WORDCLOUD.maxQuestionLength} 字` };
    }
    this.current = {
      id: randomUUID().slice(0, 8),
      question: q,
      startedAt: now,
      /** wordKey → {text, count, firstAt} */
      words: new Map(),
      /** agentId → wordKey[]（自己送過的） */
      answers: new Map(),
      /** 主持人隱藏的 wordKey */
      hidden: new Set(),
    };
    return { ok: true, round: this.publicView() };
  }

  /**
   * 參與者送一個答案。
   * @returns {{ok: true, mine: string[], added: boolean} | {ok: false, reason: string, mine?: string[]}}
   *   added=false 代表答案被主持人隱藏過：照樣記為已送（不讓人知道被藏而一直換說法重送），只是不進雲
   */
  answer(agentId, raw, now = Date.now()) {
    const r = this.current;
    if (!r) return { ok: false, reason: WORDCLOUD_ERRORS.NO_ROUND };
    const text = cleanAnswer(raw);
    const mine = () => (r.answers.get(agentId) ?? []).map((k) => r.words.get(k)?.text ?? k);
    if (!text) return { ok: false, reason: WORDCLOUD_ERRORS.EMPTY, mine: mine() };
    if ([...text].length > WORDCLOUD.maxAnswerLength) return { ok: false, reason: WORDCLOUD_ERRORS.TOO_LONG, mine: mine() };
    const key = wordKey(text);
    if (!key) return { ok: false, reason: WORDCLOUD_ERRORS.EMPTY, mine: mine() };
    if (isBlockedName(text)) return { ok: false, reason: WORDCLOUD_ERRORS.BLOCKED, mine: mine() };
    const list = r.answers.get(agentId) ?? [];
    if (list.includes(key)) return { ok: false, reason: WORDCLOUD_ERRORS.DUPLICATE, mine: mine() };
    if (list.length >= WORDCLOUD.maxPerPerson) return { ok: false, reason: WORDCLOUD_ERRORS.LIMIT, mine: mine() };

    list.push(key);
    r.answers.set(agentId, list);
    const word = r.words.get(key);
    if (word) word.count += 1;
    else r.words.set(key, { text, count: 1, firstAt: now });   // 顯示用第一個人的寫法
    return { ok: true, mine: mine(), added: !r.hidden.has(key) };
  }

  /** 主持人隱藏一個詞。回傳是否真的藏了一個原本看得到的詞 */
  hide(rawWord) {
    const r = this.current;
    if (!r) return false;
    const key = wordKey(rawWord);
    if (!key || r.hidden.has(key)) return false;
    r.hidden.add(key);
    return true;
  }

  /** 收題。回傳收掉那一題的摘要（給 WORDCLOUD_CLOSED 與報告） */
  close(now = Date.now()) {
    const r = this.current;
    if (!r) return null;
    const summary = {
      id: r.id, question: r.question, startedAt: r.startedAt, closedAt: now,
      words: this.#visibleWords(r), participants: r.answers.size,
    };
    this.history.push(summary);
    this.current = null;
    return summary;
  }

  /** 某人自己送過的答案（重連時補送給手機） */
  mineOf(agentId) {
    const r = this.current;
    if (!r) return [];
    return (r.answers.get(agentId) ?? []).map((k) => r.words.get(k)?.text ?? k);
  }

  /** 題目本身（手機、大螢幕、主辦端都可以看） */
  publicView() {
    const r = this.current;
    if (!r) return null;
    return { id: r.id, question: r.question, maxPerPerson: WORDCLOUD.maxPerPerson, maxAnswerLength: WORDCLOUD.maxAnswerLength };
  }

  /** 目前的詞與票數（大螢幕與主辦端），依票數由多到少，最多 maxShown 個 */
  cloud() {
    const r = this.current;
    if (!r) return null;
    return { id: r.id, words: this.#visibleWords(r).slice(0, WORDCLOUD.maxShown), participants: r.answers.size };
  }

  #visibleWords(r) {
    return [...r.words].filter(([k]) => !r.hidden.has(k))
      .map(([, w]) => ({ text: w.text, count: w.count, firstAt: w.firstAt }))
      .sort((a, b) => b.count - a.count || a.firstAt - b.firstAt)
      .map(({ text, count }) => ({ text, count }));
  }

  hydrate(dump) {
    if (!dump || typeof dump !== 'object') return this;
    // 進行中的那一題不還原：重開後手機上的作答面板早就消失了，主持人重新出題即可
    this.history = Array.isArray(dump.history) ? dump.history : [];
    this.current = null;
    return this;
  }

  export() {
    return { history: this.history };
  }
}
