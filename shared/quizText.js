/**
 * 即時問答題庫 ⇄ 純文字（.txt）。
 *
 * 為什麼是自訂的純文字而不是 JSON／CSV：要編輯題目的是主持人，工具多半只有
 * 記事本。JSON 少一個逗號整份壞掉；CSV 用 Excel 開，中文編碼與選項裡的逗號
 * 都會出事。「一題一段、正解前面加 *」用任何編輯器都改得動，打錯也只壞那一題。
 *
 * 匯出再匯入要能一字不差地還原（測試釘住這件事），否則主持人改一題、匯回來
 * 其他題卻默默變了。
 *
 * 題目物件與主辦端題庫同一個形狀：
 *   { question, options: string[], correctIndex, durationMs, talkMs }
 */
import { QUIZ } from './protocol.js';

const HEADER = [
  '# 即時問答題庫',
  '#',
  '# 格式：每題一段，題與題之間空一行。',
  '#   第一行是題目，下面每行一個選項（2～4 個），正確答案前面加 *',
  '#   可選：「時間 20」＝作答 20 秒、「討論 10」＝先討論 10 秒（0＝不討論）',
  '# 以 # 開頭的行是說明，匯入時會略過。',
  `# 題目最多 ${QUIZ.maxQuestionLength} 字、選項最多 ${QUIZ.maxOptionLength} 字。`,
  '#',
  '# 範例：',
  '#   台灣最高的山是？',
  '#   *玉山',
  '#   雪山',
  '#   合歡山',
  '#   時間 20',
  '#   討論 10',
];

const DURATION_RE = /^(?:時間|作答)\s*[:：]?\s*(\d+)\s*(?:秒|s)?$/i;
const TALK_RE = /^討論\s*[:：]?\s*(\d+)\s*(?:秒|s)?$/i;
/** 選項或題目不能被誤認成設定行：以「時間 20」開頭的選項匯出時會被跳脫 */
const looksLikeSetting = (line) => DURATION_RE.test(line) || TALK_RE.test(line);

/** 一行文字：去掉換行，免得一個選項匯出後變兩行 */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 寫出時的跳脫：選項本身以 * 或 \ 開頭、或長得像設定行時，前面墊一個 \ */
function escapeLine(text) {
  return /^[*\\#]/.test(text) || looksLikeSetting(text) ? `\\${text}` : text;
}

/** @param {Array<object>} items 題庫 @returns {string} */
export function quizBankToText(items) {
  const blocks = items.map((item) => {
    const lines = [escapeLine(oneLine(item.question))];
    (item.options ?? []).forEach((opt, i) => {
      const text = oneLine(opt);
      if (!text) return;   // 編輯區留白的選項不寫出
      lines.push((i === item.correctIndex ? '*' : '') + escapeLine(text));
    });
    if (item.durationMs) lines.push(`時間 ${Math.round(item.durationMs / 1000)}`);
    if (item.talkMs !== undefined && item.talkMs !== null) lines.push(`討論 ${Math.round(item.talkMs / 1000)}`);
    return lines.join('\n');
  });
  return [HEADER.join('\n'), ...blocks].join('\n\n') + '\n';
}

/**
 * 解析 .txt。壞掉的題目不會擋掉整份：好的照收，壞的列在 errors 裡告訴主持人第幾題、哪裡錯。
 *
 * @param {string} text
 * @returns {{ items: object[], errors: string[] }}
 */
export function parseQuizText(text) {
  const items = [];
  const errors = [];
  // 記事本存檔可能帶 BOM、Windows 換行
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);

  const blocks = [];
  let cur = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (!line) {
      if (cur.length) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);

  blocks.forEach((block, n) => {
    const label = `第 ${n + 1} 題`;
    const [first, ...rest] = block;
    const question = unescape(first);
    const options = [];
    let correctIndex = -1;
    let durationMs;
    let talkMs;
    let problem = null;

    for (const line of rest) {
      const dur = DURATION_RE.exec(line);
      const talk = TALK_RE.exec(line);
      if (dur) { durationMs = Number(dur[1]) * 1000; continue; }
      if (talk) { talkMs = Number(talk[1]) * 1000; continue; }
      const marked = line.startsWith('*');
      const opt = unescape(marked ? line.slice(1).trim() : line);
      if (!opt) continue;
      if (marked) {
        if (correctIndex >= 0) { problem = '標了不只一個正確答案（*）'; break; }
        correctIndex = options.length;
      }
      options.push(opt);
    }

    const short = question.length > 12 ? `${question.slice(0, 12)}…` : question;
    const where = `${label}（${short}）`;
    if (!problem) {
      if (question.length > QUIZ.maxQuestionLength) problem = `題目超過 ${QUIZ.maxQuestionLength} 字`;
      else if (options.length < QUIZ.minOptions) problem = `至少要有 ${QUIZ.minOptions} 個選項`;
      else if (options.length > QUIZ.maxOptions) problem = `最多 ${QUIZ.maxOptions} 個選項`;
      else if (correctIndex < 0) problem = '沒有標正確答案（在選項前面加 *）';
      else if (options.some((o) => o.length > QUIZ.maxOptionLength)) problem = `有選項超過 ${QUIZ.maxOptionLength} 字`;
      else if (durationMs !== undefined && (durationMs < QUIZ.minDurationMs || durationMs > QUIZ.maxDurationMs)) {
        problem = `作答時間要在 ${QUIZ.minDurationMs / 1000}～${QUIZ.maxDurationMs / 1000} 秒之間`;
      } else if (talkMs !== undefined && talkMs > QUIZ.maxTalkMs) {
        problem = `討論時間最多 ${QUIZ.maxTalkMs / 1000} 秒`;
      }
    }
    if (problem) { errors.push(`${where}：${problem}`); return; }

    const item = { question, options, correctIndex };
    if (durationMs !== undefined) item.durationMs = durationMs;
    if (talkMs !== undefined) item.talkMs = talkMs;
    items.push(item);
  });

  return { items, errors };
}

function unescape(line) {
  return line.startsWith('\\') ? line.slice(1) : line;
}

/** 判斷兩題是否相同（匯入時略過已經在題庫裡的題目） */
export function sameQuiz(a, b) {
  const opts = (q) => (q.options ?? []).map(oneLine).filter(Boolean).join('\n');
  return oneLine(a.question) === oneLine(b.question) && opts(a) === opts(b);
}
