/**
 * 角色某一面的整張圖與走路格 —— 大螢幕與手機端 POV 共用（經由 shared/character.js）。
 *
 * 側面與背面來自生成：像素風一次生成三視圖（正面、右側、背面），後端切成
 * 三張存成 full / side / back，shared/avatarSprite.js 載入後掛在
 * sprite.views 上。左側由 drawCharacter 把右側鏡像得到。
 *
 * 不再由程式從正面推導另外兩面。試過兩個多星期（背面塗頭髮、側面重組部位、
 * 拆手腳擺動），每換一種髮型就冒出一種新的怪圖 —— 程式猜不出看不到的
 * 後腦勺與側臉。沒有側面／背面的角色（舊資產、其他風格、三視圖切失敗）
 * 一律畫正面：只是轉身時不換圖，不會出現切面或禿頭。
 *
 * 走路時手腳的擺動由 shared/walkFrames.js 從每一面各自分析、變形出來；
 * 這裡負責在瀏覽器裡把它算成一格格的畫布並快取。
 */

import { AGENT_VIEW } from './protocol.js';
import { buildWalkRig, walkFrame, frameS, WALK_FRAMES } from './walkFrames.js';

/**
 * 某一面的整張圖。正面就是 sprite 本身；側面（朝右）與背面有生成的圖
 * 且已載入時用它，否則退回正面。
 */
export function spriteView(sprite, view) {
  if (!sprite || !view || view === AGENT_VIEW.FRONT) return sprite;
  const img = sprite.views?.[view];
  return img?.complete && img.naturalWidth ? img : sprite;
}

/**
 * 步伐相位（0…2π）對到第幾格。0 與 WALK_FRAMES/2 是兩腳併攏 —— 與原圖相同，
 * 回傳 0 表示「畫原圖就好」。
 */
export function walkFrameIndex(phase) {
  const k = Math.round((phase / (Math.PI * 2)) * WALK_FRAMES) % WALK_FRAMES;
  return k === WALK_FRAMES / 2 ? 0 : k;
}

// ── 走路格的快取 ──
//
// 以 448px 高的畫布算：大螢幕上的角色約 170–250px、手機約 190 CSS px，
// 448 夠清楚；用原圖的 1024px 高，30 個人的走路格會吃掉快 1GB 記憶體。
// 每一面最多 6 格（兩腳併攏的兩格就是原圖，不另存），一人約 3–5MB。
const WALK_HEIGHT = 448;

// 每一幀花在分析與變形上的時間上限（毫秒）。超過就先畫原圖、下一幀再補：
// 30 個人同時進場時一口氣算完會卡住好幾百毫秒
const BUILD_BUDGET_MS = 6;

const walkCache = new WeakMap();   // sprite → { version, arms, views: { front, side, back } }
let budgetFrame = null;
let budgetSpent = 0;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 這一幀還有沒有時間做一件事；有就把花掉的時間記進去 */
function withBudget(time, work) {
  if (budgetFrame !== time) { budgetFrame = time; budgetSpent = 0; }
  if (budgetSpent >= BUILD_BUDGET_MS) return undefined;
  const t0 = performance.now();
  const out = work();
  budgetSpent += performance.now() - t0;
  return out;
}

function prepareView(src, view, skin, body, arms) {
  const scale = WALK_HEIGHT / src.height;
  const w = Math.round(src.width * scale);
  const c = makeCanvas(w, WALK_HEIGHT);
  const ctx = c.getContext('2d');
  // 最近鄰縮小：平滑縮小會把相鄰兩格混成第三種顏色，膚色、描邊都量歪
  // （實測粉紅洋裝的膚色量成粉紅，側面整件裙子被當成手拉走）。
  // 像素風的圖本來就是一格一色，最近鄰縮小後仍是原來的那幾種顏色
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, w, WALK_HEIGHT);
  const img = ctx.getImageData(0, 0, w, WALK_HEIGHT);
  const rig = buildWalkRig(img, view, { skin, body, arms });
  return { img, rig, frames: new Array(WALK_FRAMES), w };
}

function renderFrame(v, k) {
  const fr = walkFrame(v.img, v.rig, frameS(k));
  // 裁到不透明的範圍，省記憶體
  const { width, height, data } = fr;
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const canvas = makeCanvas(cw, ch);
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), -x0, -y0, x0, y0, cw, ch);
  // 位置與大小以整張圖（sprite 的畫布）為 1 的比例記
  return { canvas, x: x0 / width, y: y0 / height, w: cw / width, h: ch / height };
}

/**
 * 走路的第 k 格（walkFrameIndex 的結果）。回傳 { canvas, x, y, w, h }（比例），
 * 或 null —— 畫原圖就好（兩腳併攏、還沒算好、這個角色沒有三視圖、分析不出手腳）。
 *
 * 只給有三視圖的角色（像素風）：位移以「格」為單位，平滑風格的圖沒有格子，
 * 整格移動在它們身上是一截截的斷層。
 */
export function walkSprite(sprite, view, k, time) {
  if (!k || !sprite?.views?.side || !sprite.spriteReady) return null;
  const v = view ?? AGENT_VIEW.FRONT;
  const src = v === AGENT_VIEW.FRONT ? sprite : sprite.views[v];
  if (!src?.complete || !src.naturalWidth) return null;

  // sprite.arms：換裝角色的手臂範圍（arms.json，avatarSprite 載入）。比貼圖晚到時重算一次
  let entry = walkCache.get(sprite);
  if (!entry || entry.version !== sprite.spriteVersion || entry.arms !== sprite.arms) {
    entry = { version: sprite.spriteVersion, arms: sprite.arms, views: {} };
    walkCache.set(sprite, entry);
  }
  const arms = (name) => sprite.arms?.[name];
  // 側面與背面要用正面的膚色與手掌高度找手，正面先算
  if (!entry.views.front) {
    const built = withBudget(time, () => prepareView(sprite, AGENT_VIEW.FRONT, null, undefined, arms(AGENT_VIEW.FRONT)));
    if (!built) return null;
    entry.views.front = built;
  }
  if (!entry.views[v]) {
    const fr = entry.views.front.rig;
    const body = fr && { handRow: fr.handRow ?? null };
    const built = withBudget(time, () => prepareView(src, v, fr?.skin ?? null, body, arms(v)));
    if (!built) return null;
    entry.views[v] = built;
  }
  const vw = entry.views[v];
  if (!vw.rig || !vw.rig.regions.length) return null;
  if (vw.frames[k] === undefined) {
    const fr = withBudget(time, () => renderFrame(vw, k));
    if (fr === undefined) return null;
    vw.frames[k] = fr;
  }
  return vw.frames[k];
}
