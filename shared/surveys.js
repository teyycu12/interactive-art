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
  /**
   * 「到場才算」的判定半徑（邏輯單位），加在道具自己的 r 之上。
   *
   * 放在 shared/ 是因為三端都要用同一個值：伺服器據此判定到位、大螢幕據此畫出
   * 那一圈範圍、手機據此顯示自己到了沒。各寫一份的話，會出現「畫面上明明站在
   * 圈裡卻不算到位」—— 現場最惱人的一種故障，因為它看起來像系統壞了而不是規則。
   *
   * 45 是上限推出來的，不是隨手取的：同一題的兩個集合點若圈圈重疊，站在中間的
   * 人會同時落在兩個答案的範圍裡，兩群人也會黏成一團，而「去跟答案一樣的人站
   * 在一起」正是這個玩法的全部意義。題庫裡最擠的一對是 tbl_3 與 tbl_2
   * （邊緣相距 95）與 tbl_1 與 tbl_3（98），因此半徑最多只能是 47。
   *
   * 下限由站位決定：道具同時是障礙物，角色擠不進 r 以內，實際站的位置大約在
   * r + 身體半徑。45 剛好容得下繞著一張桌子站一圈的人。
   * test/survey.test.mjs 會擋下讓圈圈重疊的題目。
   */
  arriveRadius: 45,
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
    // 地點刻意散在房間四角，不是挑語意最貼的那一個：洗手台就在湯鍋正下方
    // （相距 218），兩個集合圈會重疊成一團，看不出誰屬於哪一邊。
    // 「負責洗」因此擺到餐具櫃。見 INTERACTION-DESIGN 的半徑說明。
    options: [
      { value: 'cook', label: '負責煮', spot: 'tbl_3' },
      { value: 'wash', label: '負責洗', spot: 'k_dishes' },
      { value: 'eat', label: '負責吃', spot: 'k_dining' },
      { value: 'order', label: '負責訂外送', spot: 'k_cart' },
    ],
  },
  {
    id: 'team_role',
    key: 'team_role',
    theme: 'office',
    question: '在團隊裡，你比較像哪一種人？',
    // 同上：會議桌緊鄰行動白板、3號工作桌緊鄰1號工作桌，原本四個圈擠成兩對。
    // 改散到白板、工作桌、圓桌、咖啡販賣機四個角落。
    options: [
      { value: 'ideas', label: '出點子的', spot: 'k_cart' },
      { value: 'build', label: '做出來的', spot: 'tbl_1' },
      { value: 'coord', label: '協調的', spot: 'k_dining' },
      { value: 'fix', label: '救火的', spot: 'spk_r' },
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
