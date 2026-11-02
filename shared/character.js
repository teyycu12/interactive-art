/**
 * 模組 M3 — 程式化 2D 步態渲染（技術文件 §程式化步態）
 *
 * 放在 shared/ 而非 public/screen/ 的理由：大螢幕與手機端 POV 畫布
 * 必須畫出**同一個角色**。若手機另抄一份步態常數，BOB_OMEGA 之類的數值
 * 就成了第二份事實來源 —— 改了一邊另一邊不會報錯，只會默默走出不同步頻，
 * 與 slicer.py / avatars.js 的切片比例是同一類跨檔案耦合。兩端一律 import 此檔。
 *
 * 兩種畫法：
 *   - 掃描生成的角色：三個面是生成的三視圖，走路時整張圖輕微起伏，手腳擺動由
 *     程式從每一面分析出部位再變形（shared/walkFrames.js）。沒有人畫走路動畫，
 *     新增一種髮型、一種衣服不需要重畫任何一格。
 *   - 捏臉角色是像素圖，四個方向各有三格步態，改用換格（drawPixelCharacter）。
 *     畫格由 shared/pixelAvatar.js 程序產生，新增一種髮型同樣不必手繪任何一格。
 *
 * 與技術文件的一處刻意差異：文件的公式以 frameCount 為自變數
 * （例如 ω = 0.2 rad/frame）。改用畫面幀數會讓動畫速度隨螢幕更新率改變 ——
 * 同一個角色在 60Hz 與 144Hz 的投影機上會走出不同的步頻。
 * 此處全部改為時間基準，並以 60fps 換算出等價常數，維持文件指定的觀感。
 */

import { WALK_THRESHOLD, AGENT_VIEW, MOTION_IDS } from '/shared/protocol.js';
import { dirFromHeading, PIXEL_W, PIXEL_H, PIXEL_POSES } from '/shared/pixelAvatar.js';
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

/**
 * 某個角色目前的步伐相位（還沒畫過是 null）。手機的腳步震動用它對齊畫面：
 * 起伏 cos²(相位) 降到 0 的那一刻（相位 π/2、3π/2）是腳著地。
 */
export function gaitPhase(key) {
  return gaits.get(key)?.phase ?? null;
}

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
  const m = MOTION_IDS.has(agent.emote) ? motionPose(agent.emote, opts.time ?? 0, opts.height ?? 150) : null;
  if (!m) { drawCharacterBody(ctx, agent, pos, sprite, opts); return; }
  // 角色動作：以腳底為支點整個角色一起動（跳起、翻面、搖擺），影子也跟著 —— 簡單但一眼看得出來
  ctx.save();
  ctx.translate(pos.x + m.dx, pos.y - m.lift);
  ctx.rotate(m.rot);
  ctx.scale(m.sx, 1);
  ctx.translate(-pos.x, -pos.y);
  drawCharacterBody(ctx, agent, pos, sprite, opts);
  ctx.restore();
}

/**
 * 角色動作（protocol.js 的 MOTION_EMOTES）每一刻的姿勢。
 * 用絕對時間算而不是動作開始的時間：大螢幕、手機各自的時鐘不同，
 * 動作只有兩秒，相位差一點看不出來，換來不必同步起始時間。
 * @returns {{lift: number, dx: number, rot: number, sx: number}}
 */
export function motionPose(id, t, height) {
  const TAU = Math.PI * 2;
  switch (id) {
    case 'JUMP': {
      // 一下一下往上跳，落地時停一拍（取正半波）
      const s = Math.sin((TAU * t) / 0.55);
      return { lift: Math.max(0, s) * height * 0.22, dx: 0, rot: 0, sx: 1 };
    }
    case 'SPIN': {
      // 像紙片一樣轉：水平縮放走一個 cos，翻到背面時是鏡像，看起來就是轉了一圈
      const c = Math.cos((TAU * t) / 0.9);
      return { lift: height * 0.03, dx: 0, rot: 0, sx: Math.abs(c) < 0.08 ? Math.sign(c || 1) * 0.08 : c };
    }
    case 'DANCE': {
      // 左右搖擺加上小小的彈跳
      const sway = Math.sin((TAU * t) / 0.6);
      return {
        lift: Math.abs(Math.sin((TAU * t) / 0.3)) * height * 0.05,
        dx: sway * height * 0.05, rot: sway * 0.18, sx: 1,
      };
    }
    default:
      return { lift: 0, dx: 0, rot: 0, sx: 1 };
  }
}

function drawCharacterBody(ctx, agent, pos, sprite, opts) {
  if (sprite?.pixelFrames) { drawPixelCharacter(ctx, agent, pos, sprite, opts); return; }
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
  if (!glyph) return;   // 角色動作（跳、轉圈、跳舞）沒有圖示
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
