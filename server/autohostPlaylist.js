/**
 * 專展自動主持的節目內容（server/autohost.js 照這份輪流跑）。
 *
 * 要改題目、順序、時間，只改這個檔，改完重開伺服器。
 *
 * 設計依據（2026-11-15）：專展同時 2–5 人、每人停 1–3 分鐘。
 * 所以每一項都很短（30–90 秒），一輪大約 5 分鐘；不管什麼時候走進來，
 * 一分鐘內一定會碰到一項可以玩的。任務都選「要開口才做得完」的
 * （見 docs/notes/INTERACTION-DESIGN.md「這個機制需不需要開口講話」）。
 * 第一項是「同一種／不同動物」配對：進場的動物問卷是必答的（shared/persona.js），每個人都有類型。
 */

export const AUTOHOST_SETTINGS = {
  minPeople: 2,          // 場上真人少於這個數就不發，等人來（NPC 不算）
  restMs: 8000,          // 兩項之間的空檔：結果在大螢幕上停一下
  startDelayMs: 5000,    // 打開自動主持後，多久發第一項
  retryMs: 15000,        // 整份都發不出去時（人數不符、題庫空），多久再試一次
  countdownMs: 10_000,   // 任務結束前，手機與大螢幕倒數幾秒
};

/**
 * 依序輪流，跑完從頭再來。
 * - mission：missionType 見 shared/protocol.js 的 MISSION_TYPES；limitMs 到了或場上每個人都做完就結算。
 *   missionType 寫成陣列 = 每一輪換下一種（這輪那種做不完，就換另一種）；label 可以對應各自的名稱。
 * - quiz：從 QUIZ_POOL 依序連續出 count 題。talkMs 先看題目（talkKind 'read' = 畫面寫「先看題目」，
 *   不寫「討論」）、durationMs 作答、公布後停 revealMs 收題接下一題
 * - wordcloud：依序從 WORDCLOUD_POOL 取下一題；answerMs 收答案、resultMs 結果停留
 * - minPeople / maxPeople：這一項需要的人數，不符合就跳過這一項
 */
export const AUTOHOST_PLAYLIST = [
  {
    kind: 'mission', missionType: ['SAME_TRAIT', 'DIFF_TRAIT'], traitKey: 'persona', target: 1, limitMs: 60_000,
    label: { SAME_TRAIT: '找跟你同一種動物的人', DIFF_TRAIT: '找跟你不同動物的人' },
  },
  { kind: 'mission', label: '兩人解碼', missionType: 'DECODE', target: 1, codeLength: 4, limitMs: 90_000 },
  { kind: 'quiz', count: 3, talkMs: 5_000, talkKind: 'read', durationMs: 10_000, revealMs: 3_000 },
  { kind: 'wordcloud', answerMs: 40_000, resultMs: 12_000 },
];

/**
 * 問答題庫。options 2–4 個（每個最多 24 字），correctIndex 從 0 算起，題目最多 80 字。
 * multiplier：答對分數乘幾倍（1–3），畫面上會寫「本題分數 ×2」。
 */
export const QUIZ_POOL = [
  { question: '我們的系統名稱是？', options: ['Pixel Air', 'Pixel Lab', 'Pixel Flow', 'Pixel Hub'], correctIndex: 0 },
  { question: '下列何者是我們的應用場景？', options: ['迎新活動', '社團聚會', '新人訓練', '以上皆是'], correctIndex: 3 },
  { question: '科技系的全名總共有幾個字？', options: ['11', '12', '13', '14'], correctIndex: 2, multiplier: 2 },
];

/** 文字雲題目（每題一句） */
export const WORDCLOUD_POOL = [
  '用一個形容詞形容本系統',
];

export const AUTOHOST_CONTENT = {
  settings: AUTOHOST_SETTINGS,
  playlist: AUTOHOST_PLAYLIST,
  quizPool: QUIZ_POOL,
  wordcloudPool: WORDCLOUD_POOL,
};
