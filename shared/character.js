/**
 * 模組 M3 — 程式化 2D 步態渲染（技術文件 §程式化步態）
 *
 * 放在 shared/ 而非 public/screen/ 的理由：大螢幕與手機端 POV 畫布
 * 必須畫出**同一個角色**。若手機另抄一份步態常數，BOB_OMEGA 之類的數值
 * 就成了第二份事實來源 —— 改了一邊另一邊不會報錯，只會默默走出不同步頻，
 * 與 slicer.py / avatars.js 的切片比例是同一類跨檔案耦合。兩端一律 import 此檔。
 *
 * 「無逐格動畫成本」是這套作法的重點：角色只有一張靜態 SVG，
 * 走路、擺動、轉向全部由變換矩陣即時算出，
 * 因此新增一種髮型不需要重畫任何一格動畫。
 *
 * 與技術文件的一處刻意差異：文件的公式以 frameCount 為自變數
 * （例如 ω = 0.2 rad/frame）。改用畫面幀數會讓動畫速度隨螢幕更新率改變 ——
 * 同一個角色在 60Hz 與 144Hz 的投影機上會走出不同的步頻。
 * 此處全部改為時間基準，並以 60fps 換算出等價常數，維持文件指定的觀感。
 */

import { WALK_THRESHOLD } from '/shared/protocol.js';

const INK = '#2F2A26';

// 技術文件：ω = 0.2 rad/frame。以 60fps 換算 → 12 rad/s
const BOB_OMEGA = 0.2 * 60;
const BOB_AMPLITUDE = 6;        // 文件：A = 6px
const WOBBLE_DEGREES = 5;       // 文件：±5°

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
 * 繪製單一角色。
 *
 * 變換順序（由外而內）：
 *   平移到腳底位置 → 畫地面投影 → 垂直彈跳 → 左右擺動 → 轉向鏡像
 * 投影必須在彈跳之前繪製，它屬於地面而非角色；
 * 擺動的旋轉樞紐設在腳底附近，否則角色會看起來像在原地打轉。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} agent   STAGE_SYNC 的角色狀態
 * @param {{x:number,y:number}} pos  內插後的顯示座標（邏輯空間）
 * @param {HTMLImageElement|null} sprite  組裝好的捏臉圖像
 * @param {object} opts
 */
export function drawCharacter(ctx, agent, pos, sprite, opts) {
  const { time, maxSpeed, height = 150 } = opts;
  const speed = Math.hypot(agent.vx, agent.vy);

  // 步態強度：不用 state === 'WALK' 這個布林開關，改為隨速度連續淡出。
  //
  // 開關式的寫法會在停下的瞬間把擺動硬切成 0，而 sin(phase/2) 當下是任意
  // 值 —— 最壞情況角色正傾到滿幅 ±5°，卻在一幀之內被扳正，看起來就是
  // 「停下來時突然左右擺一下」。同理，速度在門檻附近來回時 state 會反覆
  // 翻轉，角色會持續抽動。
  //
  // 以 WALK_THRESHOLD 為終點線性淡出，擺動幅度隨速度一起歸零，
  // 停下時自然收束到直立，不需要任何額外的過渡狀態。
  const gait = Math.min(1, speed / GAIT_FADE_SPEED);

  // ── 垂直彈跳：Y_offset = -|sin(t·ω)| · A ──
  const phase = time * BOB_OMEGA * cadence(speed, maxSpeed);
  const lift = Math.abs(Math.sin(phase)) * BOB_AMPLITUDE * gait;

  // ── 左右擺動：Rotation = sin(t·ω/2) · 5° ──
  const wobble = Math.sin(phase / 2) * WOBBLE_DEGREES * (Math.PI / 180) * gait;

  // 靜止時不做任何動畫。
  //
  // 原本這裡有「呼吸待機」：垂直比例在 0.98~1.02 之間緩慢縮放。單看一個
  // 角色是細微的，但場上多人各自以不同相位縮放時，整片畫面會持續蠕動 ——
  // 觀眾的視線被那個動態一直拉走，反而看不出誰真的在移動。
  // 角色是貼圖而非骨架，縮放也會讓邊緣輕微抖動。

  const w = height * 0.77;   // 捏臉 SVG 的 viewBox 為 200×260
  const h = height;

  ctx.save();
  ctx.translate(pos.x, pos.y);

  // ── 動態投影：角色躍起時，陰影同步縮小並變淡 ──
  const liftRatio = lift / BOB_AMPLITUDE;
  ctx.beginPath();
  ctx.ellipse(0, 4, w * 0.34 * (1 - liftRatio * 0.28), h * 0.045 * (1 - liftRatio * 0.28),
    0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(47, 42, 38, ${0.16 * (1 - liftRatio * 0.45)})`;
  ctx.fill();

  // ── 角色本體 ──
  ctx.translate(0, -lift);
  ctx.rotate(wobble);
  // 轉向鏡像：Vx > 0 → ScaleX = 1；Vx < 0 → ScaleX = -1
  ctx.scale(agent.facing, 1);

  if (sprite?.complete && sprite.naturalWidth) {
    ctx.drawImage(sprite, -w / 2, -h, w, h);
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
