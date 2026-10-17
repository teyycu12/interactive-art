/**
 * 模組 M2 調校參數（Shared Agency Engine tuning）
 *
 * 現場實測（WP-C）調整手感時，只應修改本檔。所有數值以「邏輯座標 / 秒」為單位，
 * 與畫面解析度無關 —— 大螢幕負責把邏輯座標系縮放到實際投影尺寸。
 */

// 閒置門檻由協定層定義並直接再匯出 —— 手機端提示與伺服器仲裁必須共用同一個值
export { IDLE_THRESHOLD_MS } from '../shared/protocol.js';
import fs from 'node:fs';

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

// 行走門檻同樣由協定層定義並再匯出 —— shared/character.js 的步態淡出
// 依賴同一個值，兩邊對不上會出現「回報 IDLE 但畫面還在擺」的矛盾
export { WALK_THRESHOLD } from '../shared/protocol.js';

/**
 * 改變左右朝向所需的速度（邏輯單位／秒）。
 *
 * 刻意高於 WALK_THRESHOLD，兩者的差構成遲滯區：速度在零附近抖動時
 * 角色維持原本的朝向，不會翻面。翻面是整個角色的水平鏡像，
 * 是畫面上最醒目的變化，因此判定要比「是否在走路」保守得多。
 *
 * 太低 → 放開搖桿時角色瘋狂左右擺動（速度會反覆穿越零點）；
 * 太高 → 真的要轉身時反應遲鈍。現值約為行走門檻的 2.5 倍。
 */
export const FACING_FLIP_SPEED = 45;

/**
 * 改變朝向前，新方向必須持續多久（毫秒）。
 *
 * 只靠速度門檻擋不住「把托盤拖回原點」的情況：手指回中途不可能走直線，
 * 向量會在零附近來回換邊，而每次換邊的瞬時速度都可能衝過門檻 ——
 * 實測仍會翻面 6 次。要求新方向「站得住腳」才改變鏡像，
 * 短暫的來回抖動就完全不會觸發。
 *
 * 150ms 是取捨點：低於此值擋不掉手指抖動，高於約 250ms 則真的要轉身時
 * 會感覺到延遲。實測 150ms 可將拖回原點期間的翻面次數降到 0。
 */
export const FACING_DWELL_MS = 150;

/**
 * 正面／背面／側面的判定：|vx| 要大於 |vy| 的幾倍才算側走。
 *
 * 斜著走時兩個分量差不多大，若以 1 為界，角色會在側面與背面之間反覆
 * 切換。這個值同時作為遲滯：已經是側面時改用它的倒數，要明顯轉成上下走
 * 才離開側面；已經是正／背面時則要明顯橫走才進側面。
 */
export const VIEW_SIDE_RATIO = 1.3;

/**
 * 停下多久之後轉回正面（毫秒）。
 *
 * 參與者停下來時要能被認出來 —— 背對鏡頭的角色等於沒有臉。
 * 但不能一停就轉：走走停停時角色會在背面與正面間閃爍。
 */
export const VIEW_RETURN_FRONT_MS = 900;

/**
 * 手動速度的平滑時間常數（秒）。
 *
 * 搖桿的輸入方向是**單位向量**（applyMove 會正規化），因此靠近中心時
 * 手指的一點點偏移就是一個滿長度的方向 —— 只有 intensity 在縮放。
 * 使用者把托盤拖回原點的過程中，方向會反覆換邊而速度仍有數十單位，
 * 角色因此以接近全速的步態左右亂晃。
 *
 * 對合成後的手動速度做一階低通，讓速度不可能瞬間反向：手指抖動被濾掉，
 * 而正常推桿因為方向持續一致，幾乎感覺不到延遲（時間常數遠小於人的
 * 操作節奏）。
 *
 * 太大 → 推桿有黏滯感，破壞掌控感（M2 的核心目標）；
 * 太小 → 濾不掉回中時的抖動。
 */
export const MANUAL_SMOOTH_TAU = 0.15;

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

/**
 * 角色之間的剛體距離（腳底圓心距，邏輯單位）：兩人再近就被擋住，不能互相穿越（2026-10-17）。
 *
 * 靜止模式（預設）下 Boids 的分離力不參與合成，手動操控的角色原本會直接穿過別人。
 * 60 約是一個像素角色的身寬：小於它看起來會疊在一起，太大則兩人站不近 ——
 * 配對、揮手、話題桌都要兩個人站在一起，不能大到像隔著一道牆。
 */
export const AGENT_BODY_DISTANCE = 60;

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

// 揮手要對方回揮才算數（server/greetings.js）。
// radius 刻意小於 CLIENT_SYNC_RADIUS（320）：揮給的那個人一定也在自己手機的
// 個人視角裡 —— 否則手機跳出「你跟小明揮手」，畫面上卻找不到小明是誰。
export const GREET = {
  radius: 240,
  waveWindowMs: 8000,     // 對方要看到提示、抬頭找人、再按，給足時間
};

// ── 連線防護 ──────────────────────────────────────────────────
export const MAX_MESSAGE_BYTES = 4096;        // 單則訊息大小上限
export const MAX_NAME_LENGTH = 12;            // 顯示名稱長度上限

// 場域人數硬上限。
//
// 2026-09-23 由 10 提高到 30，因為當初壓到 10 的理由已經消失。
//
// 原本的取捨是「少而精緻」：3D 客廳要為每個角色跑即時陰影、高解析度貼圖與
// 後製效果，角色數降下來畫面質感才撐得住。但預設場景已改為 2D 像素場景
// （見 public/screen/scenes/），角色是平面貼圖，那項成本不存在了。
// 30 也正是 boids.js 鄰居搜尋當初設定的目標值（O(n²)，每 tick 約 900 次距離計算）。
//
// 上限同時仍是防護：無上限時，失控或惡意的客戶端可無限建立角色耗盡記憶體。
//
// ⚠ 改大之前先量過的環節（結果見 docs/notes/FIELD-OPS.md「人數與延遲」）：
//   模擬迴圈、STAGE_SYNC 頻寬、大螢幕畫格率。真正的瓶頸不在互動層，
//   而在入場時的角色生成佇列 —— 那是每人數十秒的序列化成本。
//
// 注意這是「同時在場」而非「總參與人數」。賓客關掉分頁後角色仍留在場上，
// 要等 AGENT_TTL_MS 才回收 —— 因此現場輪替速度取決於那個值，不是這個。
export const MAX_AGENTS = 30;

// ── 配對任務（規格 v3.0 §3.3）─────────────────────────────
export const PAIRING = {
  // 4 位數字。選數字而非英數混合，是因為配對碼要「唸給對方聽」——
  // 字母有 B/D、M/N 這類聽錯的風險，數字沒有，而且手機會跳數字鍵盤。
  codeLength: 4,
  rotateMs: 60000,        // 每 60 秒輪換，讓遠端貼碼分享不實用
  // 輪換後舊碼仍可用的寬限，避免正在交換時被打斷。
  // 原本 15 秒：試玩時常見「先記下對方的碼、走去找下一格的人、晚點才輸入」，
  // 碰上輪換就變成查無此碼（2026-10-17 回饋「密碼對不上」）。拉到跟輪換間隔一樣長 ——
  // 每組碼因此至少能用一分鐘；再長就得存兩代舊碼。新碼本來就避開仍在寬限內的舊碼，不會撞到別人
  graceMs: 60000,
  claimCooldownMs: 3000,  // 單人提交冷卻。沒有這個，4 位碼可被窮舉
  confirmTimeoutMs: 30000, // 對方未回應即作廢
};

// ── 私訊（見 server/messages.js）──────────────────────────
export const DIRECT_MESSAGES = {
  minIntervalMs: 2000,    // 同一人兩則之間至少隔 2 秒：擋連按送出，也擋洗版
  perMinute: 10,          // 每分鐘最多 10 則
  keepForReportMs: 30 * 60 * 1000, // 訊息留 30 分鐘供檢舉；只在記憶體，不寫快照
  keepMax: 500,           // 保留則數上限，超過就丟最舊的
  reportsMax: 50,         // 主辦端檢舉清單上限
  maxBlocks: 100,         // 每人最多封鎖幾個人（場上最多 30 人，這個上限只擋捏造的 id）
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
  bingoCell: 5,           // 人物賓果每填一格（每格都是去認識一個人，給一點但不多）
  bingoLine: 20,          // 每連成一線
  bingoFull: 40,          // 全卡填滿

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
/**
 * 生成服務（backend/service.py）的位址。httplayer.js 的代理與 index.js 的大合照共用。
 *
 * 放這裡而不是 httplayer.js：抽出 HTTP 層時這兩個常數跟著搬進 createHttpLayer()，
 * 合照那段卻還留在 index.js 引用它們 —— 只要場上有人按「拍大合照」就 ReferenceError，
 * 整個互動層行程結束、全場斷線（e2e「拍大合照時生成服務沒開…」釘住這條）。
 *
 * 用 || 而非 ??：?? 只接住 null/undefined，接不到空字串，
 * 而 .env 裡留一行 VISION_PORT= 正是會產生空字串的寫法。
 */
export const VISION_HOST = process.env.VISION_HOST || '127.0.0.1';
export const VISION_PORT = Number(process.env.VISION_PORT || 5055);

/**
 * 同時送去生成的人數上限。**與生成服務共用 .env 的 GEN_MAX_CONCURRENT。**
 *
 * 兩邊原本各自寫死 4。Node 這邊若比 Python 大，多出來的請求會在 Python 的
 * 信號量上隱形排隊 —— 手機顯示「輪到你了」卻還要再等一輪，而且 150 秒的
 * 逾時已經開始計。若比 Python 小，則是白白少用了上游的配額。
 *
 * Node 不載入 .env（API 金鑰沒有理由進到這個行程），所以只從檔案裡挑出
 * 這一個值。預設 2 與 backend/config.py 相同。
 */
export const GEN_MAX_CONCURRENT = readGenMaxConcurrent();

function readGenMaxConcurrent() {
  let raw = process.env.GEN_MAX_CONCURRENT;
  if (!raw) {
    try {
      const envFile = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
      raw = envFile.match(/^\s*GEN_MAX_CONCURRENT\s*=\s*["']?(\d+)/m)?.[1];
    } catch { /* 沒有 .env：用預設值 */ }
  }
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

export const PERSISTENCE = {
  file: process.env.PIXELAIR_STATE_FILE || 'data/state.json',
  // 關閉持久化（測試用）。現場請勿設定。
  enabled: process.env.PIXELAIR_PERSIST !== '0',
  autosaveMs: 5000,
  // 身分目錄的保留上限。超過時汰換最久沒出現的，避免檔案無限成長。
  directoryLimit: 500,
  // 身分目錄的保留時間。跨越一整場活動即可，設太長沒有意義。
  directoryTtlMs: 12 * 60 * 60 * 1000,
};

// 逐筆事件紀錄（見 eventlog.js）。場次名稱決定檔名，測試與正式場次自然分檔。
export const EVENTS = {
  session: process.env.PIXELAIR_SESSION || 'dev',
  dir: process.env.PIXELAIR_EVENTS_DIR || 'data/events',
  // 與快照共用同一個開關：測試關掉持久化時，也不該在 data/ 底下留紀錄
  enabled: process.env.PIXELAIR_PERSIST !== '0',
};

// 入站速率限制（參數取捨見 ratelimit.js）
export const RATE_LIMIT = {
  capacity: 60,              // 突發容許量：協定規格 20Hz 的 3 倍
  refillPerSec: 60,          // 持續速率上限
  violationLimit: 400,       // 違規累積達此值即中斷連線
  violationDecayPerSec: 100, // 違規計數衰減速率，避免瞬間突發被延後判死
};

// ── 閒置行為（無人操控時角色該做什麼）─────────────────────
/**
 * α 衰減歸零後，角色交還給誰。
 *
 *   'still'  完全靜止：速度歸零，只播 IDLE 待機動作。
 *   'wander' 原始設計：Boids 三力 + 漫遊擾動，角色持續閒晃。
 *   'flock'  折衷：保留三力，但關掉漫遊擾動 ——
 *            有鄰居時仍會對齊靠攏，孤身一人時自然停下。
 *
 * 預設改為 'still'。原始設計刻意讓閒置角色漫遊（boids.js 的 wanderForce
 * 就是為此存在），理由是「現場有人掛機時畫面不要死寂」；但那也讓參與者
 * 分不清畫面上的移動是自己造成的還是系統自己在動 —— 放開搖桿後角色仍在走，
 * 掌控感會被稀釋。靜止則讓「我推了才會動」這件事清楚可辨。
 *
 * 兩種取捨都成立，因此保留成參數而非寫死：現場若覺得畫面太靜，
 * 改回 'wander' 即可，不需要動任何程式邏輯。
 */
export const IDLE_MOTION = process.env.PIXELAIR_IDLE_MOTION || 'still';
