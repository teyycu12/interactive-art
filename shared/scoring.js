/**
 * 主持人可以調整的配分（2026-10-17）。伺服器驗證、主辦端畫表單都用這一份。
 *
 * 預設值在 config.js 的 SCORING；主辦端「節目單」頁可以改，改了落地進快照。
 * 只開放「每個動作給幾分」這幾項 —— 排行榜長度、廣播節流是技術參數，不給改。
 *
 * 純函式：驗證主辦端送來的值，不碰伺服器狀態，方便測試。
 */

/** 可以改的項目與它們在主辦端的說明（順序就是畫面上的順序） */
export const SCORING_FIELDS = [
  { key: 'quizCorrect', label: '問答答對' },
  { key: 'quizSpeedBonus', label: '問答速度加成上限' },
  { key: 'pairCompletion', label: '每完成一次配對' },
  { key: 'missionFinish', label: '任務達標' },
  { key: 'bingoCell', label: '賓果每填一格' },
  { key: 'bingoLine', label: '賓果每連一線' },
  { key: 'bingoFull', label: '賓果全卡填滿' },
];

/** 單項上限：再大就是打錯字（多按了一個 0），而且排行榜會被一題洗掉 */
export const SCORING_MAX = 1000;

/**
 * 驗證並正規化。只收認得的項目；每一項都要是 0～SCORING_MAX 的整數。
 * 缺的項目沿用 base（目前的值），所以主辦端可以只送改過的幾項。
 *
 * @param {unknown} input 主辦端送來的 {key: number}
 * @param {Record<string, number>} base 目前的配分
 * @returns {{ok: true, value: Record<string, number>} | {ok: false, reason: string}}
 */
export function normalizeScoring(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: '配分格式錯誤' };
  const value = {};
  for (const { key, label } of SCORING_FIELDS) {
    const raw = key in input ? input[key] : base[key];
    // 空值不能當 0：Number(null) 與 Number('') 都是 0，輸入框清空送出就會默默變成 0 分
    const n = raw === null || raw === '' ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > SCORING_MAX) {
      return { ok: false, reason: `「${label}」要是 0～${SCORING_MAX} 的整數` };
    }
    value[key] = n;
  }
  return { ok: true, value };
}

/** 從完整的 SCORING 取出可以改的那幾項（存檔、送給主辦端都用這份） */
export const editableScoring = (scoring) =>
  Object.fromEntries(SCORING_FIELDS.map(({ key }) => [key, scoring[key]]));
