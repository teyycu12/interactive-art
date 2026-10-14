/**
 * 模組 M3 — 程式化 2D 步態渲染（技術文件 §程式化步態）
 *
 * 放在 shared/ 而非 public/screen/ 的理由：大螢幕與手機端 POV 畫布
 * 必須畫出**同一個角色**。若手機另抄一份步態常數，BOB_OMEGA 之類的數值
 * 就成了第二份事實來源 —— 改了一邊另一邊不會報錯，只會默默走出不同步頻，
 * 與 slicer.py / avatars.js 的切片比例是同一類跨檔案耦合。兩端一律 import 此檔。
 *
 * 兩種畫法：
 *   - 掃描生成的角色只有一張正面貼圖，走路、擺動、左右翻面全部由變換矩陣
 *     即時算出（drawCharacter 的主體）。
 *   - 捏臉角色是像素圖，四個方向各有三格步態，改用換格（drawPixelCharacter）。
 *     畫格由 shared/pixelAvatar.js 程序產生，新增一種髮型同樣不必手繪任何一格。
 *
 * 與技術文件的一處刻意差異：文件的公式以 frameCount 為自變數
 * （例如 ω = 0.2 rad/frame）。改用畫面幀數會讓動畫速度隨螢幕更新率改變 ——
 * 同一個角色在 60Hz 與 144Hz 的投影機上會走出不同的步頻。
 * 此處全部改為時間基準，並以 60fps 換算出等價常數，維持文件指定的觀感。
 */

import { WALK_THRESHOLD } from '/shared/protocol.js';
import { dirFromHeading, PIXEL_W, PIXEL_H, PIXEL_POSES } from '/shared/pixelAvatar.js';

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
  if (sprite?.pixelFrames) { drawPixelCharacter(ctx, agent, pos, sprite, opts); return; }
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

/** 兩步一個週期，切成四段：跨左腳 → 併攏 → 跨右腳 → 併攏 */
const WALK_CYCLE = [1, 0, 2, 0];

/**
 * 一步的長度，以「角色身高」為單位。
 *
 * 像素角色的步伐由**移動距離**推進，不是時間：角色每前進 STEP_BODIES 個身高
 * 就換一隻腳。以時間推進的話，步頻與實際位移對不上 —— 慢速時腳踏得比地面
 * 移動快、快速時又跟不上，看起來就是在地板上滑行（「用飄的」）。
 * Q 版角色腿短，0.42 個身高約等於最高速每秒 3.8 步。
 */
export const STEP_BODIES = 0.42;

/** 目前是第幾步。手機 POV 用它觸發腳步震動，與畫面的換腳同一把尺。 */
export const stepIndex = (travel) => Math.floor(travel / STEP_BODIES);

/** 低於這個速度就站定（場域單位／秒）。比 WALK_THRESHOLD 低，減速的最後幾步仍會踏出來。 */
const STAND_SPEED = WALK_THRESHOLD * 0.3;

/**
 * 像素角色（捏臉）。與上面的向量／貼圖畫法有三處刻意不同：
 *
 *   1. 不旋轉、不鏡像 —— 旋轉會把方塊畫歪；左右由 left / right 兩組畫格負責，
 *      背面與正面也各有一組，鏡像只會把它們弄亂。
 *   2. 走路用換格而非擺動，換格依移動距離推進（見 STEP_BODIES）。
 *      距離預設由 pos 的逐幀位移算出；手機 POV 的角色固定在畫面上、是世界在動，
 *      因此改由呼叫端傳入 opts.travel。
 *   3. 一格像素對齊成整數個裝置像素，並關掉影像平滑。非整數倍放大會讓有的格子
 *      寬 3px、有的 4px，整個角色看起來會抖。
 *
 * 朝向優先用伺服器的 heading：它已處理「靜止時維持原朝向」與合照時轉向鏡頭，
 * 大螢幕與手機因此看到同一個方向。沒有 heading 時（手機剛進場、還沒收到同步）
 * 才用速度推算。四方向的遲滯狀態存在 sprite 上 —— 每個角色各有自己的 sprite。
 */
function drawPixelCharacter(ctx, agent, pos, sprite, opts) {
  const { height = 150 } = opts;
  const speed = Math.hypot(agent.vx, agent.vy);

  let heading = agent.heading;
  if (!Number.isFinite(heading) && speed > GAIT_FADE_SPEED) heading = Math.atan2(agent.vy, agent.vx);
  const dir = dirFromHeading(heading, sprite.pixelDir ?? null);
  sprite.pixelDir = dir;

  let travel = opts.travel;
  if (travel === undefined) {
    const last = sprite.pixelLastPos;
    let moved = last ? Math.hypot(pos.x - last.x, pos.y - last.y) / height : 0;
    if (moved > 1) moved = 0;          // 瞬移（重連、切換場景）不算走路
    sprite.pixelTravel = (sprite.pixelTravel ?? 0) + moved;
    sprite.pixelLastPos = { x: pos.x, y: pos.y };
    travel = sprite.pixelTravel;
  }
  const walking = speed > STAND_SPEED;
  const frame = walking ? WALK_CYCLE[Math.floor(travel / (STEP_BODIES / 2)) % 4] : 0;
  // 揮手與乾杯：角色本身舉手做動作，兩格交替（揮手快、碰杯慢一點）
  const pose = PIXEL_POSES[agent.emote];
  const img = pose && sprite.pixelPoses
    ? sprite.pixelPoses[dir][pose][Math.floor((opts.time ?? 0) * (pose === 'wave' ? 6 : 3.5)) % 2]
    : sprite.pixelFrames[dir][frame];

  const m = ctx.getTransform?.();
  const s = (m && Math.hypot(m.a, m.b)) || 1;
  const px = Math.max(1, Math.round((height / PIXEL_H) * s)) / s;
  const w = px * PIXEL_W;
  const h = px * PIXEL_H;
  // 併攏的那一格身體抬高一格像素，走起來才有上下的節奏
  const lift = walking && frame === 0 ? px : 0;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(pos.x, pos.y - px, w * 0.3, h * 0.045, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(47, 42, 38, 0.18)';
  ctx.fill();

  const x = Math.round((pos.x - w / 2) * s) / s;
  const y = Math.round((pos.y - h - lift) * s) / s;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

const nameplateFont = (fontSize) => `700 ${fontSize}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
const NAMEPLATE_PAD_X = 9;
/** 名牌上緣與腳底的距離。緊貼腳底：隔太遠時，人多的地方會看不出哪個名字屬於哪個角色 */
export const NAMEPLATE_DROP = 3;

/** 名牌的寬高，供避讓排版使用（見 shared/nameplateLayout.js）。字型必須與 drawNameplate 一致 */
export function measureNameplate(ctx, name, { fontSize = 17 } = {}) {
  ctx.save();
  ctx.font = nameplateFont(fontSize);
  const w = ctx.measureText(name).width + NAMEPLATE_PAD_X * 2;
  ctx.restore();
  return { w, h: fontSize + 9 };
}

/**
 * 名牌。與角色分開繪製，因此不受彈跳與擺動影響 ——
 * 跟著角色一起晃動的文字會非常難讀。
 *
 * offset 是避讓排版算出的位移。離開原位時從腳底拉一條細線到名牌，
 * 否則人擠在一起時看不出被挪開的名牌是誰的。
 */
export function drawNameplate(ctx, pos, name, { fontSize = 17, offset = null } = {}) {
  const dx = offset?.dx ?? 0;
  const dy = offset?.dy ?? 0;
  ctx.save();
  ctx.font = nameplateFont(fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const w = ctx.measureText(name).width + NAMEPLATE_PAD_X * 2;
  const h = fontSize + 9;
  const x = pos.x + dx;
  const y = pos.y + NAMEPLATE_DROP + dy;

  if (Math.abs(dx) > 1 || dy > 1) {
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    ctx.lineTo(x, y);
    ctx.strokeStyle = 'rgba(47, 42, 38, .55)';
    ctx.lineWidth = Math.max(1, fontSize / 12);
    ctx.stroke();
  }

  // 米白底襯，確保名字在任何分區色塊上都讀得清楚
  ctx.fillStyle = 'rgba(250, 248, 245, .84)';
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y, w, h, 7);
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.fillText(name, x, y + 4);
  ctx.restore();
}

/**
 * 這個角色的動作是否由角色本身演出（像素角色的揮手、乾杯）。
 * 是的話就不再畫頭上的圖示 —— 兩個同時出現反而分散視線。
 */
export const emoteIsPosed = (sprite, emote) => !!(sprite?.pixelPoses && PIXEL_POSES[emote]);

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
