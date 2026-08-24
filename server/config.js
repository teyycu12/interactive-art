/**
 * 模組 M2 調校參數（Shared Agency Engine tuning）
 *
 * 現場實測（WP-C）調整手感時，只應修改本檔。所有數值以「邏輯座標 / 秒」為單位，
 * 與畫面解析度無關 —— 大螢幕負責把邏輯座標系縮放到實際投影尺寸。
 */

// 閒置門檻由協定層定義並直接再匯出 —— 手機端提示與伺服器仲裁必須共用同一個值
export { IDLE_THRESHOLD_MS } from '../shared/protocol.js';

export const TICK_HZ = 30;                    // 伺服器模擬與廣播頻率（技術文件 §3：30 FPS）
export const TICK_MS = 1000 / TICK_HZ;

// ── 主動控制權重 α 的時間常數（技術文件 M2）────────────────────
export const ALPHA_RAMP_UP_MS = 300;          // 偵測到搖桿輸入 → 0.3 秒內線性升至 1.0
export const ALPHA_DECAY_MS = 1200;           // 餘弦衰減回 0.0 所需時間
export const INPUT_DEADZONE = 0.08;           // 低於此強度視為未操控，避免手指微顫誤觸

// ── 斷線處理（技術文件 §6 風險 1）──────────────────────────────
export const DISCONNECT_GRACE_MS = 2000;      // 斷線逾 2 秒 → 標記離線並轉入 Boids
export const AGENT_TTL_MS = 45000;            // 斷線逾 45 秒 → 從狀態矩陣移除。
                                              // 期間帶原 userId 重連可接回同一角色；
                                              // 設太長會讓場上堆積無人操控的幽靈角色。

// ── 運動學 ────────────────────────────────────────────────────
// 最高速由協定層定義並再匯出 —— 大螢幕的程式化步態也依賴同一個值來換算步頻
export { MAX_SPEED } from '../shared/protocol.js';

export const MAX_FORCE = 520;                 // 邏輯單位/秒²，Boids 轉向力上限
export const WALK_THRESHOLD = 18;             // 速度低於此值時回報 IDLE（供 M3 播呼吸待機）

// ── Boids 群體動力學（技術文件 §1 第 3 層）─────────────────────
export const BOIDS = {
  neighborRadius: 260,                        // 對齊與凝聚的感知半徑
  separationRadius: 95,                       // 剛體避障半徑（§6 風險 2：遮擋緩解）
  separationWeight: 2.2,                      // 分離權重最高，優先確保不重疊
  alignmentWeight: 0.9,
  cohesionWeight: 0.75,
  wanderWeight: 0.55,                         // 無鄰居時仍保持漫遊，避免群體靜止
  wanderJitter: 2.4,                          // 漫遊角度的隨機遊走速率（弧度/秒）
  obstacleMargin: 55,                         // 距道具碰撞半徑此距離內開始閃避

  /**
   * 社交親和力偏置（規格 v3.0 §4.2）。
   * 配對過的鄰居在凝聚質心中的權重為 1 + 本值，因此角色會漸漸靠向
   * 曾經互動過的人，社交圖譜表現為畫面上的自然群聚而非連線。
   *
   * 過強會讓群體黏成硬塊、失去湧現感；過弱則觀眾看不出差異。
   * 現值為規格建議的起始點，待 WP-C 現場實測定案。
   */
  affinityBonus: 1.5,
};

// 障礙推力權重。必須高於凝聚力，否則角色會被人群拉著穿過沙發。
export const OBSTACLE_WEIGHT = 3.0;

// ── 場域邊界 ──────────────────────────────────────────────────
export const BOUNDARY_MARGIN = 140;           // 距邊界此距離內開始施加回推力
export const BOUNDARY_WEIGHT = 2.6;           // 邊界力權重，需高於凝聚力才不會被拉出場外

// ── 定位鎖定（合照等需要把角色帶到指定位置的情境）──────────
export const ARRIVE = {
  slowRadius: 240,      // 進入此半徑開始減速，避免衝過頭再折返
  epsilon: 6,           // 距離小於此視為到位
  takeoverMs: 600,      // 鎖定後平滑接管的時間，對應技術文件「角色平滑移向」
};

// ── 朝向 ──────────────────────────────────────────────────
// 每秒最多轉多少弧度。3D 角色需要完整朝向角，而不只是左右鏡像；
// 由伺服器統一計算，避免大螢幕與合照渲染各算一套而彼此不一致。
export const HEADING_TURN_RATE = 9;

// ── 社交動作 ──────────────────────────────────────────────────
export const EMOTE_DURATION_MS = 2200;        // 頭頂氣泡顯示時長
export const EMOTE_COOLDOWN_MS = 600;         // 單一使用者的動作發送冷卻，防洗版

// ── 連線防護 ──────────────────────────────────────────────────
export const MAX_MESSAGE_BYTES = 4096;        // 單則訊息大小上限
export const MAX_NAME_LENGTH = 12;            // 顯示名稱長度上限

// 場域人數硬上限。
//
// 刻意壓到 10：這是「少而精緻」的取捨 —— 角色數降下來之後，每個人都負擔得起
// 即時陰影、高解析度貼圖與後製效果，畫面質感遠勝過塞滿一百個扁平貼紙。
// 上限同時仍是防護：無上限時，失控或惡意的客戶端可無限建立角色耗盡記憶體。
//
// 注意這是「同時在場」而非「總參與人數」。賓客關掉分頁後角色仍留在場上，
// 要等 AGENT_TTL_MS 才回收 —— 因此現場輪替速度取決於那個值，不是這個。
export const MAX_AGENTS = 10;

// ── 配對任務（規格 v3.0 §3.3）─────────────────────────────
export const PAIRING = {
  // 4 位數字。選數字而非英數混合，是因為配對碼要「唸給對方聽」——
  // 字母有 B/D、M/N 這類聽錯的風險，數字沒有，而且手機會跳數字鍵盤。
  codeLength: 4,
  rotateMs: 60000,        // 每 60 秒輪換，讓遠端貼碼分享不實用
  graceMs: 15000,         // 輪換後舊碼仍可用的寬限，避免正在交換時被打斷
  claimCooldownMs: 3000,  // 單人提交冷卻。沒有這個，4 位碼可被窮舉
  confirmTimeoutMs: 30000, // 對方未回應即作廢
};

// ── 即時問答與積分 ────────────────────────────────────────
export const QUIZ_TUNING = {
  /**
   * 逾時後仍接受作答的寬限。
   *
   * 倒數是客戶端自己畫的，而封包要走現場的無線網路。沒有寬限的話，
   * 在手機上「按下去時還剩 0.2 秒」會因為傳輸延遲被判成沒作答 ——
   * 參與者只會覺得系統吃掉了他的答案。寬限內的作答仍以完整時長計速度分，
   * 不會因為晚到而多拿分。
   */
  lateGraceMs: 700,

  /** 公布答案後，主辦端若未手動收題，本題保留在畫面上的時間 */
  revealHoldMs: 15000,
};

export const SCORING = {
  pairCompletion: 20,     // 每完成一次配對
  missionFinish: 50,      // 達成該任務目標次數時的一次性獎勵
  quizCorrect: 100,       // 答對的基本分
  quizSpeedBonus: 100,    // 速度加成上限：立刻答對得滿分，鈴響前一刻答對得 0

  leaderboardSize: 8,     // 大螢幕與主辦端排行榜列出的人數
  broadcastMs: 500,       // 排行榜廣播節流。積分變動常常一次來 30 筆（問答揭曉），
                          // 逐筆廣播會在最需要頻寬的瞬間灌爆現場網路
};

// ── 主辦端 ────────────────────────────────────────────────
export const HOST_KEY_LENGTH = 6;   // 通行密鑰長度

// ── 狀態持久化 ────────────────────────────────────────────
/**
 * 快照落地。
 *
 * 場上的即時狀態（座標、速度、α）刻意不存 —— 它每秒變動 30 次，
 * 而且伺服器重開後角色本來就該重新入場。存的是「重來一次會心痛」的東西：
 * 積分、社交圖譜、任務與問答紀錄，以及讓參與者能認領回自己角色的身分目錄。
 *
 * 用 JSON 檔而非資料庫：單場活動的資料量是幾十筆，
 * 引入 SQLite 或 Redis 換來的是部署複雜度，不是可靠度。
 * 寫入採「先寫暫存檔再改名」，中途斷電不會留下半截檔案。
 */
export const PERSISTENCE = {
  file: process.env.PERSONAFLOW_STATE_FILE || 'data/state.json',
  // 關閉持久化（測試用）。現場請勿設定。
  enabled: process.env.PERSONAFLOW_PERSIST !== '0',
  autosaveMs: 5000,
  // 身分目錄的保留上限。超過時汰換最久沒出現的，避免檔案無限成長。
  directoryLimit: 500,
  // 身分目錄的保留時間。跨越一整場活動即可，設太長沒有意義。
  directoryTtlMs: 12 * 60 * 60 * 1000,
};

// 入站速率限制（參數取捨見 ratelimit.js）
export const RATE_LIMIT = {
  capacity: 60,              // 突發容許量：協定規格 20Hz 的 3 倍
  refillPerSec: 60,          // 持續速率上限
  violationLimit: 400,       // 違規累積達此值即中斷連線
  violationDecayPerSec: 100, // 違規計數衰減速率，避免瞬間突發被延後判死
};
