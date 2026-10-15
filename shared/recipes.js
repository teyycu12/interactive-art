/**
 * 活動配方範本：依場合預先排好的節目單。
 *
 * INTERACTION-DESIGN「這件作品賣的不是場景，是依場合配出來的互動」指出：
 * 配方的四個欄位裡，「玩法順序與參數」原本只存在主辦端操作者的腦子裡。
 * 這裡把它寫成資料 —— 主辦端選了場景後，可以一鍵把對應的範本套進節目單，
 * 再自己增刪調整。
 *
 * 每一步與主辦端「加入節目單」產生的格式完全相同（{kind, label, msg}），
 * 現場按「下一項」送出的就是 msg，與直接按該玩法的按鈕沒有差別。
 *
 * 不放即時問答：題目與正解是每場活動自己的內容，範本替不了。
 *
 * 編排原則（每一套都照這個順序）：
 *   1. 先一題文字雲暖場 —— 每個人都送得出一個詞，大螢幕馬上熱鬧起來，
 *      主持人也有話題可以接（「誰寫了這個？」）
 *   2. 配對任務或人物賓果 —— 一對一認識人
 *   3. 大合照收尾
 * （尋寶、採水果、轉場問卷已於 2026-10 移除，原本排在這裡的步驟改成文字雲。）
 */

import { EV } from './protocol.js';
import { WORDCLOUD } from './wordcloud.js';

const wordcloud = (question) => {
  if ([...question].length > WORDCLOUD.maxQuestionLength) throw new Error(`文字雲題目太長：${question}`);
  return { kind: 'wordcloud', label: `文字雲：${question}`, msg: { type: EV.HOST_START_WORDCLOUD, question } };
};
const pairing = (target, minutes) => ({
  kind: 'mission',
  label: `找一個人配對・每人 ${target} 次・${minutes} 分鐘`,
  msg: { type: EV.HOST_PUBLISH_MISSION, missionType: 'PAIRING', target, durationMs: minutes * 60000 },
});
const bingo = (minutes) => ({
  kind: 'bingo',
  label: `人物賓果・${minutes} 分鐘`,
  msg: { type: EV.HOST_START_BINGO, durationMs: minutes * 60000 },
});
const photo = { kind: 'photo', label: '拍大合照', msg: { type: EV.HOST_TAKE_PHOTO } };

/**
 * themeId → 範本。theme 為 null 的範本任何場景都能用。
 * @type {{id: string, theme: string|null, name: string, brief: string, steps: object[]}[]}
 */
export const RECIPES = [
  {
    id: 'kitchen_mixer',
    theme: 'kitchen',
    name: '交誼破冰（約 30 分鐘）',
    brief: '彼此不認識的一群人：先用文字雲暖場，再一對一認識，最後聊聊今天的收穫。',
    steps: [wordcloud('用一個詞形容你今天的心情'), pairing(2, 8), bingo(10), wordcloud('今天最難忘的一刻？'), photo],
  },
  {
    id: 'office_onboarding',
    theme: 'office',
    name: '新人報到・新生訓練（約 35 分鐘）',
    brief: '同一個單位的新成員：先說說期待，用賓果把人認一輪，再配對加深印象。',
    steps: [wordcloud('你最期待在這裡學到什麼？'), bingo(10), pairing(3, 8), wordcloud('用一個詞形容這個團隊'), photo],
  },
  {
    id: 'gym_welcome',
    theme: 'gym',
    name: '社團迎新・運動會暖場（約 25 分鐘）',
    brief: '人多、動態高：先看看大家愛什麼運動，再用短配對、短賓果認識幾個人。',
    steps: [wordcloud('你最喜歡的運動是？'), pairing(2, 5), bingo(5), photo],
  },
  {
    id: 'quick_icebreaker',
    theme: null,
    name: '快速破冰（約 15 分鐘）',
    brief: '時間很短的場合：一題文字雲暖身、一輪賓果、合照收尾。任何場景都能用。',
    steps: [wordcloud('用一個詞形容今天'), bingo(5), photo],
  },
];

/** 某個場景可用的範本：該場景專屬的在前，通用的在後 */
export function recipesForTheme(themeId) {
  return [
    ...RECIPES.filter((r) => r.theme === themeId),
    ...RECIPES.filter((r) => r.theme === null),
  ];
}
