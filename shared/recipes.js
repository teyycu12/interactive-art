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
 *   1. 先一題轉場問卷（要走到定點）—— 讓人動起來、身上有標籤，後面的賓果才有變化
 *   2. 配對任務或人物賓果 —— 一對一認識人
 *   3. 需要整隊合作的（尋寶、採水果）—— 這時大家已經認識幾個人，比較喊得出口
 *   4. 大合照收尾
 */

import { EV } from './protocol.js';
import { SURVEY_BANK_MAP } from './surveys.js';

// 標籤直接取題庫的題目：手寫一份會跟題庫漂移
const survey = (bankId) => ({
  kind: 'survey',
  label: `${SURVEY_BANK_MAP[bankId]?.question ?? bankId}（要走到定點）`,
  msg: { type: EV.HOST_START_SURVEY, bankId, requireArrival: true, durationMs: 30000 },
});
const pairing = (target, minutes) => ({
  kind: 'mission',
  label: `找一個人配對・每人 ${target} 次・${minutes} 分鐘`,
  msg: { type: EV.HOST_PUBLISH_MISSION, missionType: 'PAIRING', target, colorFamily: null, durationMs: minutes * 60000 },
});
const bingo = (minutes) => ({
  kind: 'bingo',
  label: `人物賓果・${minutes} 分鐘`,
  msg: { type: EV.HOST_START_BINGO, durationMs: minutes * 60000 },
});
const treasure = { kind: 'treasure', label: '尋寶（先知隨機）', msg: { type: EV.HOST_START_TREASURE, prophetId: null } };
const harvest = { kind: 'harvest', label: '採水果', msg: { type: EV.HOST_START_HARVEST } };
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
    brief: '彼此不認識的一群人：先分工、再一對一認識，最後一起找寶藏。',
    steps: [survey('kitchen_role'), pairing(2, 8), bingo(10), treasure, photo],
  },
  {
    id: 'office_onboarding',
    theme: 'office',
    name: '新人報到・新生訓練（約 35 分鐘）',
    brief: '同一個單位的新成員：先用賓果把人認一輪，再用需要分工的玩法磨合。',
    steps: [survey('team_role'), bingo(10), pairing(3, 8), harvest, photo],
  },
  {
    id: 'gym_welcome',
    theme: 'gym',
    name: '社團迎新・運動會暖場（約 25 分鐘）',
    brief: '人多、動態高：短配對、短賓果先認識幾個人，再用接力讓大家一起跑起來。',
    steps: [survey('sport_role'), pairing(2, 5), bingo(5), harvest, photo],
  },
  {
    id: 'quick_icebreaker',
    theme: null,
    name: '快速破冰（約 15 分鐘）',
    brief: '時間很短的場合：一題問卷暖身、一輪賓果、合照收尾。任何場景都能用。',
    steps: [survey('chrono'), bingo(5), photo],
  },
];

/** 某個場景可用的範本：該場景專屬的在前，通用的在後 */
export function recipesForTheme(themeId) {
  return [
    ...RECIPES.filter((r) => r.theme === themeId),
    ...RECIPES.filter((r) => r.theme === null),
  ];
}
