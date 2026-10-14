/**
 * 模組 M3 — 程式化 2D 步態渲染（技術文件 §程式化步態）
 *
 * 放在 shared/ 而非 public/screen/ 的理由：大螢幕與手機端 POV 畫布
 * 必須畫出**同一個角色**。若手機另抄一份步態常數，BOB_OMEGA 之類的數值
 * 就成了第二份事實來源 —— 改了一邊另一邊不會報錯，只會默默走出不同步頻，
 * 與 slicer.py / avatars.js 的切片比例是同一類跨檔案耦合。兩端一律 import 此檔。
 *
 * 「無逐格動畫成本」是這套作法的重點：沒有人畫走路動畫。三個面是生成的
 * 三視圖，走路時的手腳擺動由程式從每一面分析出部位再變形（shared/walkFrames.js），
 * 因此新增一種髮型、一種衣服不需要重畫任何一格動畫。
 *
 * 與技術文件的一處刻意差異：文件的公式以 frameCount 為自變數
 * （例如 ω = 0.2 rad/frame）。改用畫面幀數會讓動畫速度隨螢幕更新率改變 ——
 * 同一個角色在 60Hz 與 144Hz 的投影機上會走出不同的步頻。
 * 此處全部改為時間基準，並以 60fps 換算出等價常數，維持文件指定的觀感。
 */

import { WALK_THRESHOLD, AGENT_VIEW } from '/shared/protocol.js';
import { spriteView, walkSprite, walkFrameIndex } from '/shared/spriteCache.js';

const INK = '#2F2A26';

/**
 * 起伏的角頻率：一個循環 2π 起伏兩次（cos²），最高速時約每秒 1.9 次，
 * 接近正常步行的步頻。
 */
const STEP_OMEGA = 6;

// 身體起伏（角色高的比例）。只有一點點 —— 舊版整張圖上下跳 6px 加左右轉
// ±5°，現場回報「人在抖」；之後試過把手腳拆開各自擺（紙娃娃），現場回報
// 看起來很詭異。現在只剩整張圖的輕微起伏
const BODY_BOB = 0.012;

// 步態強度高過這個才換走路格（手腳擺動）。低速時整格位移一格一格跳，
// 看起來像在抽動；起伏照樣隨速度連續淡出
const WALK_FRAME_GAIT = 0.5;

/**
 * 步態淡出的速度基準：直接沿用協定層的行走門檻。
 *
 * 低於它伺服器就回報 IDLE，因此步態也在同一點收斂到零 ——
 * 兩者才不會出現「已回報 IDLE、畫面卻還在擺動」的矛盾。
 * 不要在這裡另外寫死數字（見 CLAUDE.md 的單一事實來源原則）。
 */
const GAIT_FADE_SPEED = WALK_THRESHOLD;

/**
 * 依速度調節步頻。技術文件未指定，但固定步頻會讓緩慢移動的角色
 * 看起來像在原地急促踏步。以最高速為基準線性內插，下限保留一點基礎步頻。
 */
function cadence(speed, maxSpeed) {
  return 0.55 + 0.45 * Math.min(1, speed / maxSpeed);
}

/**
 * 每個角色自己的步伐相位。
 *
 * 不能用 time × 步頻 直接算：步頻隨速度變（cadence），而 time 是開頁到
 * 現在的秒數 —— 速度一變（轉彎時會減速再加速），相位就整段跳動，
 * 實測轉彎時步伐變得飛快。改成每幀以當下的步頻累加，速度怎麼變都是連續的。
 * 以 agent.id 為鍵（手機端的自己沒有 id，由 opts.gaitKey 指定）。
 */
const gaits = new Map();
let lastPruneAt = 0;

function stepPhase(key, time, rate) {
  let g = gaits.get(key);
  if (!g) { g = { phase: 0, at: time }; gaits.set(key, g); }
  // 上限 0.1 秒：分頁切回來的第一幀不要一口氣跨好幾步
  const dt = Math.min(0.1, Math.max(0, time - g.at));
  g.phase = (g.phase + rate * dt) % (Math.PI * 2);
  g.at = time;
  // 久未出現的角色（離場）清掉
  if (time - lastPruneAt > 10) {
    lastPruneAt = time;
    for (const [k, v] of gaits) if (time - v.at > 10) gaits.delete(k);
  }
  return g.phase;
}

/**
 * 繪製單一角色（完全平面）。
 *
 * 四面：伺服器的 updateView 決定正面、背面或側面；側面圖朝右，往左走時依
 * facing 鏡像。三面都是生成的圖（像素風的三視圖），沒有的面退回正面。
 * 走路時：整張圖輕微上下起伏，手腳依 shared/walkFrames.js 從那一面分析出來的
 * 部位變形擺動（只有三視圖的角色；其他角色只有起伏）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} agent   STAGE_SYNC 的角色狀態
 * @param {{x:number,y:number}} pos  內插後的顯示座標（邏輯空間）
 * @param {HTMLImageElement|HTMLCanvasElement|null} sprite  組裝好的角色圖像
 * @param {object} opts
 */
export function drawCharacter(ctx, agent, pos, sprite, opts) {
  const { time, maxSpeed, height = 150 } = opts;
  const speed = Math.hypot(agent.vx, agent.vy);

  // 步態強度：不用 state === 'WALK' 這個布林開關，改為隨速度連續淡出。
  // 開關式的寫法會在停下的瞬間把起伏硬切成 0；速度在門檻附近來回時
  // state 會反覆翻轉，角色會持續抽動。以 WALK_THRESHOLD 為終點線性淡出。
  const gait = Math.min(1, speed / GAIT_FADE_SPEED);
  const phase = stepPhase(opts.gaitKey ?? agent.id ?? 'self', time, STEP_OMEGA * cadence(speed, maxSpeed));
  const lift = Math.cos(phase) ** 2 * BODY_BOB * height * gait;

  // 靜止時不做任何動畫。
  //
  // 原本這裡有「呼吸待機」：垂直比例在 0.98~1.02 之間緩慢縮放。單看一個
  // 角色是細微的，但場上多人各自以不同相位縮放時，整片畫面會持續蠕動 ——
  // 觀眾的視線被那個動態一直拉走，反而看不出誰真的在移動。

  const w = height * 0.77;   // 捏臉 SVG 的 viewBox 為 200×260
  const h = height;

  ctx.save();
  ctx.translate(pos.x, pos.y);

  // ── 地面投影：身體升起時略為縮小變淡 ──
  const liftRatio = lift / (BODY_BOB * height || 1);
  ctx.beginPath();
  ctx.ellipse(0, 4, w * 0.34 * (1 - liftRatio * 0.12), h * 0.045 * (1 - liftRatio * 0.12),
    0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(47, 42, 38, ${0.16 * (1 - liftRatio * 0.2)})`;
  ctx.fill();

  // 體素 3D 角色（大螢幕 ?voxel=1 才有）：動作與轉身都在 3D 裡做完，
  // 這裡只把圖集那一格貼到腳底
  if (opts.voxel) {
    const v = opts.voxel;
    const size = h / v.heightV;
    ctx.drawImage(v.canvas, v.sx, v.sy, v.size, v.size, -v.footU * size, -v.footV * size, size, size);
    ctx.restore();
    return;
  }

  // 正面／背面／側面（伺服器的 updateView 決定；沒帶欄位就是正面）。
  //
  // 只有真的側面圖依 facing 鏡像 —— 側面圖朝右，往左走翻過來。
  // 正面與背面不翻：正面再翻只會讓衣服上的字、旁分的瀏海在橫向微調方向時
  // 左右跳。沒有側面圖的角色（spriteView 退回正面）同理不翻。
  const view = agent.view ?? AGENT_VIEW.FRONT;
  const img = spriteView(sprite, view);
  if (view === AGENT_VIEW.SIDE && img !== sprite) ctx.scale(agent.facing, 1);

  ctx.translate(0, -lift);
  // 走路格：與起伏同一個相位（兩腳併攏時身體最高）。還沒算好或不適用時是 null
  const frame = gait > WALK_FRAME_GAIT ? walkSprite(sprite, view, walkFrameIndex(phase), time) : null;
  if (frame) {
    ctx.drawImage(frame.canvas, -w / 2 + frame.x * w, -h + frame.y * h, frame.w * w, frame.h * h);
  } else if (img?.complete && img.naturalWidth) {
    ctx.drawImage(img, -w / 2, -h, w, h);
  } else {
    // 圖像尚未解碼完成時的替身，避免角色在畫面上憑空消失
    ctx.beginPath();
    ctx.arc(0, -h * 0.5, w * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = '#D8D0C6';
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 名牌。與角色分開繪製，因此不受彈跳與擺動影響 ——
 * 跟著角色一起晃動的文字會非常難讀。
 */
export function drawNameplate(ctx, pos, name, { fontSize = 17 } = {}) {
  ctx.save();
  ctx.font = `700 ${fontSize}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const padX = 9;
  const w = ctx.measureText(name).width + padX * 2;
  const h = fontSize + 9;
  const y = pos.y + 12;

  // 米白底襯，確保名字在任何分區色塊上都讀得清楚
  ctx.fillStyle = 'rgba(250, 248, 245, .84)';
  ctx.beginPath();
  ctx.roundRect(pos.x - w / 2, y, w, h, 7);
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.fillText(name, pos.x, y + 4);
  ctx.restore();
}

/** 頭頂的社交動作氣泡 */
export function drawEmote(ctx, pos, glyph, { height = 150 } = {}) {
  ctx.save();
  ctx.font = `${Math.round(height * 0.28)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(glyph, pos.x, pos.y - height - 14);
  ctx.restore();
}

/** 離線標記（技術文件 §6 風險 1：斷線角色轉入漫遊並標示，而非消失） */
export function drawOffline(ctx, pos, { height = 150 } = {}) {
  ctx.save();
  ctx.font = `700 ${Math.round(height * 0.16)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#457B9D';
  ctx.fillText('zZ', pos.x + height * 0.26, pos.y - height * 0.9);
  ctx.restore();
}
