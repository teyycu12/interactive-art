/**
 * 模組 M3 — 程式化 2D 步態渲染（技術文件 §程式化步態）
 *
 * 「無逐格動畫成本」是這套作法的重點：角色只有一張靜態 SVG，
 * 走路、擺動、呼吸、轉向全部由變換矩陣即時算出，
 * 因此新增一種髮型不需要重畫任何一格動畫。
 *
 * 與技術文件的一處刻意差異：文件的公式以 frameCount 為自變數
 * （例如 ω = 0.2 rad/frame）。改用畫面幀數會讓動畫速度隨螢幕更新率改變 ——
 * 同一個角色在 60Hz 與 144Hz 的投影機上會走出不同的步頻。
 * 此處全部改為時間基準，並以 60fps 換算出等價常數，維持文件指定的觀感。
 */

const INK = '#2F2A26';

// 技術文件：ω = 0.2 rad/frame。以 60fps 換算 → 12 rad/s
const BOB_OMEGA = 0.2 * 60;
const BOB_AMPLITUDE = 6;        // 文件：A = 6px
const WOBBLE_DEGREES = 5;       // 文件：±5°
const BREATH_OMEGA = 2.2;       // 待機呼吸，明顯慢於步頻
const BREATH_RANGE = 0.02;      // 文件：垂直比例 0.98 ~ 1.02

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
 *   平移到腳底位置 → 畫地面投影 → 垂直彈跳 → 左右擺動 → 轉向鏡像與呼吸縮放
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
  const walking = agent.state === 'WALK';
  const speed = Math.hypot(agent.vx, agent.vy);

  // ── 垂直彈跳：Y_offset = -|sin(t·ω)| · A ──
  const phase = time * BOB_OMEGA * cadence(speed, maxSpeed);
  const lift = walking ? Math.abs(Math.sin(phase)) * BOB_AMPLITUDE : 0;

  // ── 左右擺動：Rotation = sin(t·ω/2) · 5° ──
  const wobble = walking
    ? Math.sin(phase / 2) * WOBBLE_DEGREES * (Math.PI / 180)
    : 0;

  // ── 呼吸待機：靜止時垂直比例在 0.98 ~ 1.02 之間緩慢縮放 ──
  const breath = walking ? 1 : 1 + Math.sin(time * BREATH_OMEGA) * BREATH_RANGE;

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
  ctx.scale(agent.facing, breath);

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
