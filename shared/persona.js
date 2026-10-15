/**
 * 進場人格問卷（團隊分類用）。
 *
 * 角色生成要等二十幾秒，這段時間順便答幾題，把人分成五種類型（DISC 四型＋變色龍），
 * 結果記成參與者身上的標籤（server/traits.js，鍵名 `persona`），
 * 主辦端看得到每個人是哪一型與全場分佈，作為分組的依據。
 *
 * 伺服器（驗證主辦端改的題目、判定類型）、手機（作答、當場顯示結果）、
 * 主辦端（編輯器）三端共用本檔。判定規則各寫一份的話，手機說你是老虎、
 * 主辦端名冊寫孔雀，而兩邊都不會報錯。
 */

/** 四種基本型。題目的每個選項對應其中一型 */
export const PERSONA_TYPES = {
  D: {
    key: 'D', id: 'tiger', emoji: '🐯', name: '老虎', style: '支配型',
    strengths: '目標導向、行動力強、具備企圖心與決斷力',
    cautions: '過於急躁、容易忽略他人感受、可能造成團隊壓力',
  },
  I: {
    key: 'I', id: 'peacock', emoji: '🦚', name: '孔雀', style: '影響型',
    strengths: '樂觀、善於人際交流、富有創意與感染力',
    cautions: '想法有時過於天馬行空、執行細節較弱、高壓下容易慌亂',
  },
  S: {
    key: 'S', id: 'koala', emoji: '🐨', name: '無尾熊', style: '穩健型',
    strengths: '平易近人、有耐心、追求團隊和諧、配合度高',
    cautions: '不喜衝突、容易被動、面對重大變故時猶豫不決',
  },
  C: {
    key: 'C', id: 'owl', emoji: '🦉', name: '貓頭鷹', style: '分析型',
    strengths: '注重細節、邏輯清晰、謹慎且追求品質',
    cautions: '容易陷入完美主義、作風保守、對新方向較難說服',
  },
};

/** 第五型：沒有明顯偏向哪一型的人。不是選項，是判定結果 */
export const CHAMELEON = {
  key: 'X', id: 'chameleon', emoji: '🦎', name: '變色龍', style: '綜合型',
  strengths: '適應力極強、身段柔軟、能隨環境切換角色',
  cautions: '立場容易擺動、缺乏長期堅持、重大決策時易優柔寡斷',
};

/** 五種結果，依顯示順序。主辦端的分佈與名冊都照這個順序排 */
export const PERSONA_RESULTS = [PERSONA_TYPES.D, PERSONA_TYPES.I, PERSONA_TYPES.S, PERSONA_TYPES.C, CHAMELEON];
export const PERSONA_RESULT_MAP = Object.fromEntries(PERSONA_RESULTS.map((t) => [t.id, t]));

/** 標籤的鍵名（server/traits.js）。主辦端名冊與人物賓果的條件都讀這個標籤 */
export const PERSONA_TRAIT_KEY = 'persona';

/**
 * 題目格式限制。
 * 至少 3 題：判定規則是「最多的那型、而且至少 2 票」，題數太少的話幾乎每個人都是變色龍。
 * 最多 5 題：要在生成的二十幾秒內答完，再多就變成負擔。
 */
export const PERSONA_LIMITS = {
  minQuestions: 3,
  maxQuestions: 5,
  minOptions: 2,
  maxOptions: 4,
  maxQuestionLength: 40,
  maxOptionLength: 20,
};

/** 預設題目。主持人可在主辦端修改；每題四個選項各對應一型 */
export const DEFAULT_PERSONA_QUIZ = {
  questions: [
    {
      text: '團隊要辦一場活動，你最想負責？',
      options: [
        { label: '定目標、分配工作', type: 'D' },
        { label: '宣傳、炒熱氣氛', type: 'I' },
        { label: '幫大家打點、補位', type: 'S' },
        { label: '規劃流程、檢查細節', type: 'C' },
      ],
    },
    {
      text: '遇到意見不合時，你通常會？',
      options: [
        { label: '直接說出我的決定', type: 'D' },
        { label: '用說服或開玩笑化解', type: 'I' },
        { label: '先聽大家、找折衷', type: 'S' },
        { label: '拿出資料講道理', type: 'C' },
      ],
    },
    {
      text: '朋友最常用哪個詞形容你？',
      options: [
        { label: '果斷', type: 'D' },
        { label: '有趣', type: 'I' },
        { label: '可靠', type: 'S' },
        { label: '細心', type: 'C' },
      ],
    },
    {
      text: '截止日前一天，你會？',
      options: [
        { label: '衝刺把事情做完', type: 'D' },
        { label: '揪人一起趕工', type: 'I' },
        { label: '照原本步調穩穩做', type: 'S' },
        { label: '再檢查一遍確保沒錯', type: 'C' },
      ],
    },
  ],
};

const cleanLine = (raw) => (typeof raw === 'string'
  ? [...raw].filter((ch) => { const c = ch.codePointAt(0); return c > 0x1f && c !== 0x7f; }).join('').trim()
  : '');

/**
 * 驗證主辦端送來的題目。超長一律拒絕而不是截斷（UI 已設 maxlength，
 * 會送來超長的只有繞過 UI 的客戶端；默默截斷會讓手機上出現半句話的題目）。
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function validatePersonaQuiz(raw) {
  const L = PERSONA_LIMITS;
  const qs = raw?.questions;
  if (!Array.isArray(qs) || qs.length < L.minQuestions || qs.length > L.maxQuestions) {
    return { ok: false, reason: `題目要有 ${L.minQuestions}～${L.maxQuestions} 題` };
  }
  const questions = [];
  for (const [i, q] of qs.entries()) {
    const text = cleanLine(q?.text);
    if (!text) return { ok: false, reason: `第 ${i + 1} 題沒有題目` };
    if ([...text].length > L.maxQuestionLength) return { ok: false, reason: `第 ${i + 1} 題超過 ${L.maxQuestionLength} 字` };
    const opts = q?.options;
    if (!Array.isArray(opts) || opts.length < L.minOptions || opts.length > L.maxOptions) {
      return { ok: false, reason: `第 ${i + 1} 題要有 ${L.minOptions}～${L.maxOptions} 個選項` };
    }
    const options = [];
    for (const [j, o] of opts.entries()) {
      const label = cleanLine(o?.label);
      if (!label) return { ok: false, reason: `第 ${i + 1} 題的第 ${j + 1} 個選項是空的` };
      if ([...label].length > L.maxOptionLength) return { ok: false, reason: `第 ${i + 1} 題的選項超過 ${L.maxOptionLength} 字` };
      if (!Object.hasOwn(PERSONA_TYPES, o?.type)) return { ok: false, reason: `第 ${i + 1} 題的選項沒有對應類型` };
      options.push({ label, type: o.type });
    }
    questions.push({ text, options });
  }
  return { ok: true, value: { questions } };
}

/**
 * 依作答判定類型。
 *
 * 規則：選最多的那一型勝出，但要「唯一最多、而且至少 2 票」；
 * 打平、或沒有任何一型拿到 2 票，就是變色龍 —— 沒有明顯偏向，正是綜合型的定義。
 *
 * @param {{questions: object[]}} quiz
 * @param {unknown} answers 每題選了第幾個選項（0 起算）
 * @returns {object|null} PERSONA_RESULTS 其中一個；作答不完整或不合格時回 null
 */
export function scorePersona(quiz, answers) {
  const qs = quiz?.questions;
  if (!Array.isArray(qs) || !Array.isArray(answers) || answers.length !== qs.length) return null;
  const counts = { D: 0, I: 0, S: 0, C: 0 };
  for (const [i, q] of qs.entries()) {
    const choice = answers[i];
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return null;
    counts[q.options[choice].type] += 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [[topKey, top], [, second]] = ranked;
  if (top >= 2 && top > second) return PERSONA_TYPES[topKey];
  return CHAMELEON;
}

/** 題目內容的指紋。手機用它判斷「我答的是不是現在這份題目」 */
export function personaQuizVersion(quiz) {
  const s = JSON.stringify(quiz);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
