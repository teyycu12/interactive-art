/**
 * PersonaFlow 通訊協定定義（技術文件 §3）
 *
 * 本檔同時被 Node.js 伺服器與瀏覽器端載入，是協定的單一事實來源。
 * 任何事件名稱或節流頻率的變更只需改這裡，兩端自動同步。
 */

/** WebSocket 事件名稱 */
export const EV = {
  // Phone → Server
  CLIENT_JOIN: 'CLIENT_JOIN',       // 捏臉完成登入
  INPUT_MOVE: 'INPUT_MOVE',         // 搖桿即時向量（節流 20Hz）
  INPUT_ACTION: 'INPUT_ACTION',     // 社交動作
  CLIENT_LEAVE: 'CLIENT_LEAVE',     // 主動退出，角色立即離場
  // Screen → Server
  SCREEN_HELLO: 'SCREEN_HELLO',     // 大螢幕註冊為顯示端
  // Server → Phone
  CLIENT_WELCOME: 'CLIENT_WELCOME', // 登入確認，回傳伺服器指派的 userId
  CLIENT_REJECT: 'CLIENT_REJECT',   // 資料驗證失敗
  CLIENT_SYNC: 'CLIENT_SYNC',       // 自己與鄰近角色的座標（10Hz，僅送該連線）
  // Server → Screen
  STAGE_META: 'STAGE_META',         // 場域尺寸等靜態資訊（連線時送一次）
  STAGE_ROSTER: 'STAGE_ROSTER',     // 參與者名冊（僅在有人加入/離開時送）
  STAGE_SYNC: 'STAGE_SYNC',         // 空間狀態廣播（30 FPS）
  STAGE_LINKS: 'STAGE_LINKS',       // 社交圖譜的邊（僅在有人配對成功時送）

  // ── 主辦端（規格 v3.0 §05）────────────────────────────
  HOST_AUTH: 'HOST_AUTH',                     // Host → Server：以通行密鑰註冊
  HOST_WELCOME: 'HOST_WELCOME',               // Server → Host：認證通過
  HOST_REJECT: 'HOST_REJECT',                 // Server → Host：認證失敗
  HOST_STATE: 'HOST_STATE',                   // Server → Host：參與者與任務現況
  HOST_PUBLISH_MISSION: 'HOST_PUBLISH_MISSION', // Host → Server：發布任務
  HOST_CLOSE_MISSION: 'HOST_CLOSE_MISSION',   // Host → Server：結算並關閉任務
  HOST_KICK: 'HOST_KICK',                     // Host → Server：踢除參與者
  HOST_TAKE_PHOTO: 'HOST_TAKE_PHOTO',         // Host → Server：拍大合照（定位→合成）
  HOST_PHOTO_STATE: 'HOST_PHOTO_STATE',       // Server → Host：合照進度與結果
  SCREEN_CAPTURE_REQ: 'SCREEN_CAPTURE_REQ',   // Server → Screen：請大螢幕交出當下畫面
  SCREEN_CAPTURE: 'SCREEN_CAPTURE',           // Screen → Server：回傳截圖（合照底圖）

  // ── 任務生命週期（規格 v3.0 §03）──────────────────────
  MISSION_ANNOUNCE: 'MISSION_ANNOUNCE',       // Server → All：任務公告
  MISSION_STATE: 'MISSION_STATE',             // Server → All：進度更新
  MISSION_COMPLETE: 'MISSION_COMPLETE',       // Server → All：完成事件，觸發大螢幕回饋
  MISSION_CLOSED: 'MISSION_CLOSED',           // Server → All：任務結束

  // ── 配對任務 ──────────────────────────────────────────
  PAIR_CODE: 'PAIR_CODE',                     // Server → Phone：下發本輪配對碼
  PAIR_CLAIM: 'PAIR_CLAIM',                   // Phone → Server：提交對方的配對碼
  PAIR_CONFIRM_REQ: 'PAIR_CONFIRM_REQ',       // Server → Phone：推送確認請求
  PAIR_CONFIRM: 'PAIR_CONFIRM',               // Phone → Server：被指定方回應
  PAIR_RESULT: 'PAIR_RESULT',                 // Server → Phone：配對結果

  // ── 即時問答 ──────────────────────────────────────────
  HOST_START_QUIZ: 'HOST_START_QUIZ',         // Host → Server：出題並開始倒數
  HOST_REVEAL_QUIZ: 'HOST_REVEAL_QUIZ',       // Host → Server：提前公布答案
  HOST_END_QUIZ: 'HOST_END_QUIZ',             // Host → Server：收掉本題
  QUIZ_QUESTION: 'QUIZ_QUESTION',             // Server → All：題目與選項（不含正解）
  QUIZ_TALLY: 'QUIZ_TALLY',                   // Server → Screen/Host：作答人數（不含分佈）
  QUIZ_ANSWER: 'QUIZ_ANSWER',                 // Phone → Server：送出選擇
  QUIZ_ACK: 'QUIZ_ACK',                       // Server → Phone：作答已鎖定
  QUIZ_REVEAL: 'QUIZ_REVEAL',                 // Server → All：正解與答案分佈
  QUIZ_RESULT: 'QUIZ_RESULT',                 // Server → Phone：個人對錯與得分
  QUIZ_ENDED: 'QUIZ_ENDED',                   // Server → All：本題收掉

  // ── 積分 ──────────────────────────────────────────────
  SCORE_BOARD: 'SCORE_BOARD',                 // Server → Screen/Host：排行榜
  SCORE_SELF: 'SCORE_SELF',                   // Server → Phone：個人積分與名次

  // ── 社交圖譜 ──────────────────────────────────────────
  SOCIAL_SELF: 'SOCIAL_SELF',                 // Server → Phone：我認識了誰
};

/**
 * 任務型別目錄。
 * 同時被主辦端 UI（渲染發布表單）與伺服器（驗證參數）使用。
 * v1 僅實作配對任務，另兩型的延後原因見規格 v3.0 §9.1、§9.2。
 */
export const MISSION_TYPES = {
  PAIRING: {
    id: 'PAIRING',
    label: '找一個人配對',
    brief: '走向另一位參與者，互相交換配對碼',
    defaultTarget: 2,   // 每人要完成幾次
    maxTarget: 10,
  },
};

/**
 * 即時問答的格式限制。
 *
 * 放在協定層是因為主辦端 UI 要據此擋下不合法的輸入（即時回饋），
 * 伺服器也要據此驗證（不能信任客戶端）。兩邊各存一份必然會漂移。
 */
export const QUIZ = {
  minOptions: 2,
  maxOptions: 4,
  maxQuestionLength: 80,   // 大螢幕一行放得下的長度；超過投影出去就看不清
  maxOptionLength: 24,
  minDurationMs: 5000,
  maxDurationMs: 120000,
  defaultDurationMs: 20000,
};

/**
 * 選項的顏色與符號。
 *
 * 手機、大螢幕、主辦端三端必須完全一致 —— Kahoot 式問答的前提是
 * 「大螢幕顯示題目與符號，手機只按顏色」，任何一端對不上，
 * 參與者就會按錯。這是共用而非各自定義的唯一理由。
 */
export const QUIZ_CHOICES = [
  { glyph: '▲', color: '#E76F51', label: 'A' },
  { glyph: '◆', color: '#457B9D', label: 'B' },
  { glyph: '●', color: '#E9C46A', label: 'C' },
  { glyph: '■', color: '#2A8C80', label: 'D' },
];

/** 問答階段。ASKING 期間正解絕不離開伺服器。 */
export const QUIZ_PHASE = { ASKING: 'ASKING', REVEALED: 'REVEALED' };

/** 問答失敗原因 */
export const QUIZ_ERRORS = {
  NO_QUIZ: 'NO_QUIZ',
  CLOSED: 'CLOSED',
  ALREADY_ANSWERED: 'ALREADY_ANSWERED',
  BAD_CHOICE: 'BAD_CHOICE',
};

/** 積分來源。主辦端與手機端據此顯示「這分是怎麼來的」 */
export const SCORE_SOURCES = {
  PAIR: 'PAIR',               // 完成一次配對
  MISSION_DONE: 'MISSION_DONE', // 達成該任務的目標次數
  QUIZ: 'QUIZ',               // 答對問答
};

/** 積分來源的顯示文案，集中定義避免三端各寫一套 */
export const SCORE_LABELS = {
  PAIR: '完成配對',
  MISSION_DONE: '任務達標',
  QUIZ: '答對問答',
};

/** 配對失敗原因，集中定義以便手機端顯示對應文案 */
export const PAIR_ERRORS = {
  NO_MISSION: 'NO_MISSION',
  NOT_FOUND: 'NOT_FOUND',
  SELF: 'SELF',
  ALREADY_PAIRED: 'ALREADY_PAIRED',
  BUSY: 'BUSY',
  COOLDOWN: 'COOLDOWN',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
};

/** 社交動作白名單（技術文件 M1 §操控輸入發送規格） */
export const ACTIONS = ['CHEERS', 'HEART', 'WAVE'];

/**
 * 社交動作的顯示圖示。
 * 大螢幕與手機端 POV 都要畫，放在協定層避免兩邊各存一份而漂移
 * （與 QUIZ_CHOICES 的顏色符號是同一個理由）。
 */
export const EMOTE_GLYPH = { CHEERS: '🍻', HEART: '💗', WAVE: '👋' };

/** 搖桿輸入節流頻率：20 Hz = 每 50ms 一次 */
export const INPUT_HZ = 20;
export const INPUT_THROTTLE_MS = 1000 / INPUT_HZ;

/** 大螢幕狀態廣播頻率：30 FPS */
export const SYNC_FPS = 30;

/**
 * 手機端個人視角同步（CLIENT_SYNC）。
 *
 * 與 STAGE_SYNC 的差別是「一對一」而非廣播：每支手機只收到自己
 * 與半徑內的鄰居，而不是全場名冊。
 *
 * 頻率刻意低於大螢幕的 30Hz：
 * 大螢幕只有一條連線，手機則是每人一條。30Hz × 10 人 = 300 則/秒，
 * 而現場無線網路的餘裕已經被貼圖與 STAGE_SYNC 吃掉大半
 * （見 CLAUDE.md「貼圖走 URL，不走 base64」的同一組取捨）。
 * 10Hz 配合手機端內插，肉眼看不出與 30Hz 的差別。
 */
export const CLIENT_SYNC_HZ = 10;
export const CLIENT_SYNC_MS = 1000 / CLIENT_SYNC_HZ;

/**
 * 鄰居可見半徑（邏輯單位）。
 *
 * 取 Boids 的 Cohesion 半徑（200）再放寬一些：使用者在手機上該看見的，
 * 正是那些正在影響自己角色運動的鄰居。半徑再大只是多送不會互動的人，
 * 每則訊息都要乘以人數與頻率。
 */
export const CLIENT_SYNC_RADIUS = 320;

/**
 * 閒置逾此時間即交還控制權給 Boids（技術文件 M2：3.0 秒）。
 *
 * 這個值放在協定層而非伺服器設定檔，是因為它同時決定了「伺服器何時收回
 * 控制權」與「手機端何時提示使用者角色即將自主漫遊」。兩邊若各存一份副本
 * 必然會在調校時漂移，導致手機顯示「你正在操控」但角色其實已被接管。
 * server/config.js 直接再匯出本常數，不另行定義。
 */
export const IDLE_THRESHOLD_MS = 3000;

/** 場域邏輯座標系。大螢幕負責把這個座標系縮放到實際解析度 */
export const STAGE = { width: 1920, height: 1080 };

/**
 * 角色最高移動速度（邏輯單位／秒）。
 *
 * 放在協定層是因為兩端都需要它：伺服器用來限制速度，
 * 大螢幕用來換算程式化步態的步頻（速度越快步伐越急）。
 * server/config.js 直接再匯出本常數，不另行定義。
 */
export const MAX_SPEED = 190;

/**
 * 行走判定門檻（邏輯單位／秒）。低於此速度視為靜止。
 *
 * 與 MAX_SPEED 同樣放在協定層：伺服器用它決定回報 IDLE 或 WALK，
 * shared/character.js 用同一個值把程式化步態淡出到零。兩邊必須一致 ——
 * 對不上時會出現「伺服器說 IDLE、畫面上卻還在擺動」的矛盾，
 * 而且兩邊都不會報錯。server/config.js 直接再匯出本常數，不另行定義。
 */
export const WALK_THRESHOLD = 18;

/** 角色渲染狀態，供 M3 決定是否播放彈跳步態（IDLE 為完全靜止） */
export const AGENT_STATE = { IDLE: 'IDLE', WALK: 'WALK' };

/**
 * 控制模式。
 * ACTIVE / SWARM 是 M2 的兩個常態端點；
 * STAGED 代表場域被鎖定、角色正被帶往指定位置（合照等情境），
 * 此時使用者的操控與群體動力都不生效。
 */
export const AGENT_MODE = { ACTIVE: 'ACTIVE', SWARM: 'SWARM', STAGED: 'STAGED' };
