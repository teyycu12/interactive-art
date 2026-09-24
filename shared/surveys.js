/**
 * 轉場問卷：題庫與格式限制。
 *
 * 與即時問答（QUIZ）的差別只有一個，但那個差別決定了它是另一個模組：
 * **問卷沒有正確答案**。它不計分、不比快，收集到的是「這個人是什麼樣的人」，
 * 而那份資料會留在場上，成為後續任務的條件（「答『負責煮』的人到湯鍋集合」）。
 *
 * 放在 shared/ 的理由與 MISSION_TYPES、QUIZ_CHOICES 相同：主辦端要據此渲染題庫、
 * 伺服器要據此驗證、大螢幕要顯示題目。各存一份必然漂移。
 *
 * ── option.spot ──
 * 選項可以綁一個道具 id（見 shared/scene.js 的 PROPS）。綁了之後，
 * 「答這個選項的人請到那個家具旁集合」就有了單一事實來源：
 * 大螢幕畫的號碼牌、伺服器判定的座標、手機上顯示的地點名稱全部指向同一個道具。
 * 兩邊各寫一份的話，會出現「畫面叫你去湯鍋、伺服器在餐桌等你」而兩邊都不報錯。
 *
 * spot 指向的道具**必須存在於 PROPS**，且該題的 theme 必須真的有那個場景 ——
 * test/survey.test.mjs 有把關。
 */

export const SURVEY = {
  minOptions: 2,
  maxOptions: 4,
  maxQuestionLength: 80,   // 與 QUIZ 相同：大螢幕一行放得下的長度
  maxOptionLength: 24,
  maxKeyLength: 32,
  minDurationMs: 5000,
  maxDurationMs: 120000,
  defaultDurationMs: 20000,
};

/**
 * 題庫。
 *
 * theme 為 null 代表任何場景都適用；填了場景 id 就只在該主題下建議
 * （主辦端仍可手動選，因為現場可能先問再換場景）。
 *
 * key 是這題在參與者身上留下的標籤名稱。**同一個 key 再問一次會覆蓋前值**，
 * 這是刻意的：現場重問通常是因為第一次沒問清楚。
 */
export const SURVEY_BANK = [
  {
    id: 'kitchen_role',
    key: 'kitchen_role',
    theme: 'kitchen',
    question: '在廚房裡，你通常負責什麼？',
    options: [
      { value: 'cook', label: '負責煮', spot: 'tbl_3' },
      { value: 'wash', label: '負責洗', spot: 'tbl_2' },
      { value: 'eat', label: '負責吃', spot: 'k_dining' },
      { value: 'order', label: '負責訂外送', spot: 'k_cart' },
    ],
  },
  {
    id: 'team_role',
    key: 'team_role',
    theme: 'office',
    question: '在團隊裡，你比較像哪一種人？',
    options: [
      { value: 'ideas', label: '出點子的', spot: 'k_cart' },
      { value: 'build', label: '做出來的', spot: 'tbl_1' },
      { value: 'coord', label: '協調的', spot: 'k_island' },
      { value: 'fix', label: '救火的', spot: 'tbl_3' },
    ],
  },
  {
    id: 'chrono',
    key: 'chrono',
    theme: null,
    question: '你是早鳥還是夜貓？',
    options: [
      { value: 'early', label: '早鳥' },
      { value: 'night', label: '夜貓' },
    ],
  },
  {
    id: 'taste',
    key: 'taste',
    theme: null,
    question: '鹹的還是甜的？',
    options: [
      { value: 'salty', label: '鹹派' },
      { value: 'sweet', label: '甜派' },
    ],
  },
  {
    id: 'getaway',
    key: 'getaway',
    theme: null,
    question: '放假想去山上還是海邊？',
    options: [
      { value: 'mountain', label: '山上' },
      { value: 'sea', label: '海邊' },
    ],
  },
  {
    id: 'superpower',
    key: 'superpower',
    theme: null,
    question: '最想要哪一種超能力？',
    options: [
      { value: 'fly', label: '飛行' },
      { value: 'invisible', label: '隱形' },
      { value: 'time', label: '時間暫停' },
      { value: 'mind', label: '讀心' },
    ],
  },
];

export const SURVEY_BANK_MAP = Object.fromEntries(SURVEY_BANK.map((q) => [q.id, q]));

/** 某個主題建議的題目：該主題專屬的排前面，通用題接在後面 */
export function surveysForTheme(themeId) {
  return [
    ...SURVEY_BANK.filter((q) => q.theme === themeId),
    ...SURVEY_BANK.filter((q) => q.theme === null),
  ];
}
