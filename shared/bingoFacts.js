/**
 * 人物賓果的「自我介紹題」：開局時每人勾自己符合的幾句，卡上就會出現
 * 「找一個〔今天是第一次來〕的人」這種格子。
 *
 * ── 為什麼需要 ──
 * 原本卡上只有兩種格子：衣服顏色（看一眼大螢幕就知道，對話只剩「給我你的碼」）
 * 與進場人格類型。一張卡大概是五格顏色加四格類型，玩兩次就膩了。
 * 實體活動的 networking bingo 最經典的格子正是這種「只有本人知道的小事」——
 * 非開口問不可，而且問完通常就有話聊了。
 *
 * ── 題目怎麼寫 ──
 * 一句話兩用：手機上問「你：今天是第一次來？」，卡上寫「今天是第一次來的人」。
 * 所以寫成「〔描述〕」而不是問句，接上「的人」要通順。
 *
 * **不碰隱私**：不問感情狀態、宗教、政治、收入、健康、住址。這些格子會被
 * 大聲問出來（「欸你是不是……？」），答案也會出現在別人的卡上。
 *
 * 題庫要能依場合整組換（INTERACTION-DESIGN「玩法是依場合配出來的」）：
 * 通用題 + 各場景一組，主辦端可以整份改掉。
 */

/** 每一輪最多問幾題。題目太多，開局就變成填表 */
export const BINGO_FACTS_ASK = 6;

/** 開局勾題目最多等多久。全部人答完會提早發卡 */
export const BINGO_ASK_MS = 30_000;

/** 主辦端自訂題目的限制 */
export const BINGO_FACT_LIMITS = { min: 3, max: 20, minLength: 2, maxLength: 16 };

const GENERAL = [
  '今天是第一次來',
  '會一種樂器',
  '養過寵物',
  '習慣早起',
  '去過三個以上的國家',
  '最近在追劇',
  '喜歡爬山',
  '會說兩種以上的語言',
];

/** 各場景加的題目。找不到場景時只用通用題 */
const BY_THEME = {
  kitchen: ['會做一道拿手菜', '能吃辣', '喜歡甜點勝過鹹食'],
  office: ['每天都喝咖啡', '習慣用兩個螢幕', '換過三份以上的工作'],
  gym: ['每週運動三次以上', '跑過路跑', '會游泳'],
};

/** 某個場景的預設題目：場景題在前（比較有那個場合的味道），再接通用題 */
export function defaultBingoFacts(theme) {
  return [...(BY_THEME[theme] ?? []), ...GENERAL];
}

/** 卡上那一格的文字 */
export const factCellLabel = (text) => `${text}的人`;

/**
 * 驗證主辦端送來的題目。去頭尾空白、去重複、去空行。
 * @param {unknown} list
 * @param {(text: string) => boolean} [isBlocked] 不雅字過濾（伺服器注入）
 * @returns {{ok: true, value: string[]} | {ok: false, reason: string}}
 */
export function validateBingoFacts(list, isBlocked = () => false) {
  if (!Array.isArray(list)) return { ok: false, reason: '題目格式不正確' };
  const L = BINGO_FACT_LIMITS;
  const seen = new Set();
  const value = [];
  for (const raw of list) {
    if (typeof raw !== 'string') return { ok: false, reason: '題目格式不正確' };
    // 「的人」由系統接上，主持人多打了也收掉，不然卡上會變成「會游泳的人的人」
    const text = raw.trim().replace(/的人$/, '').trim();
    if (!text || seen.has(text)) continue;
    const len = [...text].length;
    if (len < L.minLength || len > L.maxLength) {
      return { ok: false, reason: `每題 ${L.minLength}–${L.maxLength} 個字：「${text}」` };
    }
    if (isBlocked(text)) return { ok: false, reason: `題目含不適當的字詞：「${text}」` };
    seen.add(text);
    value.push(text);
  }
  if (value.length < L.min) return { ok: false, reason: `至少要 ${L.min} 題` };
  if (value.length > L.max) return { ok: false, reason: `最多 ${L.max} 題` };
  return { ok: true, value };
}
