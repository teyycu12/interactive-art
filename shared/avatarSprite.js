/**
 * 角色圖像組裝 —— 大螢幕與手機端 POV 共用。
 *
 * 兩種來源：
 *   掃描生成（source: 'CV'）  三張貼圖依 CV_CUTS 的比例疊回一張畫布；在場上時
 *                             正面縮成像素格子，側面與背面用像素畫法補上
 *   模組捏臉（備援路徑）      像素角色，四方向 × 三格步態（shared/pixelAvatar.js）
 *
 * 與 shared/character.js 同理放在 shared/：手機畫的角色若與大螢幕不是
 * 同一份組裝邏輯，比例或替身顏色一旦漂移，兩邊都不會報錯 ——
 * 只會出現「手機上的我」和「大螢幕上的我」長得不一樣。
 */

import { avatarGrid, CV_CUTS, CV_PARTS, CV_FULL_PART } from './avatars.js';
import { PIXEL_W, PIXEL_H, PIXEL_DIRS, PIXEL_FRAMES, PIXEL_POSES, OUTLINE } from './pixelAvatar.js';

// 角色畫布的解析度。
//
// 200x260 是捏臉 SVG 的 viewBox 尺寸，CV 掃描角色原本沿用同一組數字 ——
// 但兩者的性質不同：捏臉是向量圖，放大不失真；CV 角色是點陣貼圖，
// 這個尺寸就成了硬上限。實測（2026-08-29）在 2560x1664 的 Retina 螢幕上，
// 靠近相機的角色需要約 533 個實際像素，而資料只有 260 —— 等於放大兩倍，
// 眼鏡框、衣服印花、鞋子邊緣全部糊掉。
//
// 提高到 1024 之後：
//   - AI 生成的人像本身就有約 975px 高，先前有 73% 的像素被丟掉
//   - backend/slicer.py 的 NORMALIZED_HEIGHT 必須一起提到 1024，
//     只改這裡會卡在上游的 512（兩道都是瓶頸，改一道沒有效果）
//
// 寬度維持 200:260 的比例（788:1024），畫布比例一變，drawFull 的
// 「底部對齊」與 composite 的三段疊圖都會跟著偏。
// 捏臉路徑不受影響：像素角色以原尺寸（20×27）保存，放大時由 drawCharacter
// 關掉影像平滑、以整數倍像素繪製。
export const AVATAR_W = 788;
export const AVATAR_H = 1024;

/**
 * 掃描生成的角色：優先畫未切割的整張圖，缺它才把三張貼圖疊回去。
 *
 * 回傳 canvas 而非 Image —— drawCharacter 只要求 sprite 有 complete 與
 * naturalWidth（shared/character.js），canvas 兩者都能自行掛上，
 * 這樣就不必為了取得 Image 物件多繞一次 toDataURL 編解碼。
 *
 * 貼圖尚未載入時先用取樣色畫一個替身：現場的參與者在生成完成的瞬間
 * 就會看著大螢幕找自己，不能讓角色有一段時間是空白的。
 *
 * @param {object} avatar  source: 'CV' 的外觀設定
 * @param {{enhance?: boolean, onPaint?: () => void}} opts
 *   enhance 為真時套用對比與飽和度增強。投影機的實際亮度遠低於製作時的
 *   螢幕，大螢幕需要這層補償；手機是直視發光面板，套下去只會過曝。
 *   onPaint 在貼圖載入、畫布重畫之後呼叫（cvPixelSprite 用它重做正面畫格）。
 */
export function cvAvatarImage(avatar, { enhance = false, onPaint = null } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_W;
  canvas.height = AVATAR_H;
  const ctx = canvas.getContext('2d');

  const paintPlaceholder = () => {
    const c = avatar.fallbackColors;
    for (const part of CV_PARTS) {
      const [top, bottom] = CV_CUTS[part];
      ctx.fillStyle = part === 'head' ? c.skin : (part === 'torso' ? c.torso : c.legs);
      ctx.fillRect(AVATAR_W * 0.25, AVATAR_H * top, AVATAR_W * 0.5, AVATAR_H * (bottom - top));
    }
    // 頭部上緣的髮色帶，比例與 slicer 取樣 hair 的區域一致
    const [, headBottom] = CV_CUTS.head;
    ctx.fillStyle = c.hair;
    ctx.fillRect(AVATAR_W * 0.25, 0, AVATAR_W * 0.5, AVATAR_H * headBottom * 0.35);
  };

  paintPlaceholder();
  // 先讓替身可被繪製；貼圖到齊後原地重畫，roster 不需要重新建立條目
  canvas.complete = true;
  canvas.naturalWidth = canvas.width;

  /**
   * 整張圖：等比縮放後底部對齊。
   *
   * 不能直接鋪滿畫布 —— 角色的寬高比實測平均約 0.642，畫布是 200x260 =
   * 0.769，直接填滿會把每個人橫向拉寬約 20%。底部對齊而非置中，是為了讓
   * 所有角色站在同一條基準線上；置中會讓矮的角色浮在半空。
   *
   * 畫之前清空且不重畫替身：整張圖已經是完整的角色，替身的實心矩形只會
   * 從透明處透出來（與下方 composite() 不畫替身是同一個理由）。
   */
  const drawFull = (img) => {
    const scale = Math.min(AVATAR_W / img.naturalWidth, AVATAR_H / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.clearRect(0, 0, AVATAR_W, AVATAR_H);
    if (enhance) ctx.filter = 'contrast(1.15) saturate(1.15) brightness(1.05)';
    ctx.drawImage(img, (AVATAR_W - w) / 2, AVATAR_H - h, w, h);
    ctx.filter = 'none';
    onPaint?.();
  };

  const loaded = {};
  let pending = CV_PARTS.length;
  const composite = () => {
    if (!CV_PARTS.some((p) => loaded[p])) return; // 三張都載入失敗就留著替身
    ctx.clearRect(0, 0, AVATAR_W, AVATAR_H);

    // 替身只在「有貼圖沒載到」時才畫。
    //
    // 貼圖是去背過的透明 PNG，而替身是不透明的實心矩形 —— 無條件先畫替身
    // 再疊貼圖，矩形就會從角色輪廓外的透明處透出來：頭部後方一塊髮色方塊、
    // 肩膀兩側各一塊，看起來就像根本沒去背（而去背其實是好的）。
    //
    // 仍然保留部分失敗的保險：只要有任一張沒到齊，該部位維持取樣色替身，
    // 總比角色在大螢幕上缺頭或缺腿好。
    const missing = CV_PARTS.filter((p) => !loaded[p]);
    if (missing.length > 0) paintPlaceholder();

    if (enhance) ctx.filter = 'contrast(1.15) saturate(1.15) brightness(1.05)';

    for (const part of CV_PARTS) {
      const img = loaded[part];
      if (!img) continue;
      const [top, bottom] = CV_CUTS[part];
      ctx.drawImage(img, 0, AVATAR_H * top, AVATAR_W, AVATAR_H * (bottom - top));
    }
    ctx.filter = 'none';
    onPaint?.();
  };

  const loadParts = () => {
    for (const part of CV_PARTS) {
      const img = new Image();
      img.addEventListener('load', () => { loaded[part] = img; if (--pending === 0) composite(); });
      img.addEventListener('error', () => { if (--pending === 0) composite(); });
      img.src = avatar.textures[part];
    }
  };

  // 整張圖是選用的：改版前生成的資產目錄只有三張切片，那些角色仍在場上，
  // 把它列為必要會讓一次改版就把先前生成的人全部踢出場。
  // 載入失敗也退回切片 —— 兩條路都通到同一個替身，參與者不會看到空白。
  const fullUrl = avatar.textures?.[CV_FULL_PART];
  if (fullUrl) {
    const img = new Image();
    img.addEventListener('load', () => drawFull(img));
    img.addEventListener('error', loadParts);
    img.src = fullUrl;
  } else {
    loadParts();
  }

  return canvas;
}

/**
 * 捏臉角色：四個方向 × 三格步態，每格一張原尺寸（PIXEL_W × PIXEL_H）的小 canvas。
 *
 * 回傳的是「正面站立」那一格，其餘掛在 pixelFrames 上 —— 這樣直接放進 DOM
 * 的呼叫端（手機的社交連結頭像）拿到的仍是一張正常的圖，而 drawCharacter
 * 看到 pixelFrames 就改走像素畫法（依朝向選方向、依步態換格）。
 *
 * 不經過 SVG → Image 解碼：12 格同步畫完，角色進場的第一幀就有圖。
 */
export function pixelAvatarImage(avatar) {
  const paint = (grid) => {
    const c = document.createElement('canvas');
    c.width = PIXEL_W;
    c.height = PIXEL_H;
    const ctx = c.getContext('2d');
    for (let y = 0; y < PIXEL_H; y++) {
      for (let x = 0; x < PIXEL_W; x++) {
        const color = grid[y][x];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    c.complete = true;
    c.naturalWidth = PIXEL_W;
    return c;
  };
  const frames = {};
  // 動作畫格（揮手、乾杯）：每個方向每種動作兩格，交替播放
  const poses = {};
  for (const dir of PIXEL_DIRS) {
    frames[dir] = [];
    for (let f = 0; f < PIXEL_FRAMES; f++) frames[dir].push(paint(avatarGrid(avatar, dir, f)));
    poses[dir] = {};
    for (const kind of Object.values(PIXEL_POSES)) {
      poses[dir][kind] = [1, 2].map((step) => paint(avatarGrid(avatar, dir, 0, `${kind}${step}`)));
    }
  }
  const sprite = frames.down[0];
  sprite.pixelFrames = frames;
  sprite.pixelPoses = poses;
  return sprite;
}

/** 一格像素畫格：PIXEL_W × PIXEL_H 的小 canvas，帶 drawCharacter 需要的欄位 */
function pixelCanvas() {
  const c = document.createElement('canvas');
  c.width = PIXEL_W;
  c.height = PIXEL_H;
  c.complete = true;
  c.naturalWidth = PIXEL_W;
  return c;
}

/**
 * 捏臉像素角色的版面（格子列號，已含 pixelAvatar 的 DY）：頭髮頂端、下巴、鞋底。
 * 生成的正面要擺進同一個版面，轉身時頭與腳才不會跳。
 */
const GRID_TOP = 6;
const GRID_CHIN = 31;
const GRID_SOLE = 52;
/** 身體的橫向加寬倍率（見 cvFrontFrames） */
const BODY_WIDEN = 1.45;

/**
 * 找出不透明像素的外接框（在縮小的副本上找，1024 高的原圖逐點掃太慢）。
 * 回傳的函式可以只看某幾列 —— 頭部要用頭自己的寬度，不能用含手臂的全身寬。
 */
function opaqueScanner(src) {
  const k = 4;
  const w = Math.ceil(src.width / k), h = Math.ceil(src.height / k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const box = (fromY = 0, toY = src.height) => boxIn(d, w, h, k, fromY, toY);
  /**
   * 頭與身體的分界：肩膀開始變寬的那一列（往下幾列內寬度增加最多處）。
   *
   * 不能直接用 CV_CUTS.head 的 30%：那是 slicer 切貼圖用的固定比例，實測會
   * 落在下巴上方，下巴就被分到身體那段一起縮小。也不能找「最窄的一列」：
   * 長髮蓋住脖子時根本沒有那一列，實測會切在眼睛，整顆頭變成一朵香菇。
   * 肩膀變寬則不管頭髮多長都在 —— 手臂從那裡往外張開。
   */
  const rowWidth = (y) => {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 64) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
    }
    return x0 < 0 ? 0 : x1 - x0 + 1;
  };
  const neck = (lo, hi) => {
    const RISE = 3;
    let best = null, bestRise = 0;
    for (let y = Math.floor(lo / k); y + RISE < Math.min(h, Math.ceil(hi / k)); y++) {
      const rise = rowWidth(y + RISE) - rowWidth(y);
      if (rise > bestRise) { bestRise = rise; best = y; }
    }
    return best === null ? null : (best + 1) * k;
  };
  return { box, neck };
}

function boxIn(d, w, h, k, fromY, toY) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = Math.max(0, Math.floor(fromY / k)); y < Math.min(h, Math.ceil(toY / k)); y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 64) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0 * k, y: y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
}

/**
 * 把生成的全身圖縮成像素格子（PIXEL_W × PIXEL_H）。
 *
 * 縮到與捏臉角色同一個格子，拍照角色與捏臉角色在場上才是同一種畫風、
 * 同樣的像素顆粒。
 *
 *   1. Q 版化：生成圖大約是三頭身，捏臉角色是兩頭身。頭部放大、身體縮小，
 *      頭頂、下巴、鞋底都對齊捏臉角色的版面（GRID_TOP / GRID_CHIN / GRID_SOLE）。
 *   2. 取最近的像素而不是平均：生成圖本身就是像素畫，平均會把相鄰色塊混成一片糊
 *   3. 半透明一律二值化（外框在最後各方向畫格完成後才補）
 *
 * @returns {{cells: (number[]|null)[][], legTop: number} | null}
 *   cells[y][x] 為 [r, g, b] 或 null（透明）
 */
function cvFrontCells(front) {
  const c = pixelCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;

  const scan = opaqueScanner(front);
  const box = scan.box();
  if (!box) return null;
  // 在 CV_CUTS.head 的切線附近找肩膀；找不到就退回那條切線
  const cut = CV_CUTS.head[1];
  const neck = scan.neck(box.y + box.h * (cut - 0.04), box.y + box.h * (cut + 0.14)) ?? box.y + box.h * cut;
  const head = scan.box(box.y, neck) ?? box;
  const headH = neck - box.y;
  const bodyH = box.y + box.h - neck;
  // 頭：頭頂到下巴佔 GRID_TOP–GRID_CHIN，用頭自己的寬度；不超出畫布（留一格給外框）
  const sh = Math.min((GRID_CHIN - GRID_TOP) / headH, (PIXEL_W - 4) / head.w);
  // 身體：下巴到鞋底。橫向多放大一些 —— 等比縮下來只剩十格寬，比捏臉角色的
  // 身體（含手臂約十六格）細一圈
  const sb = (GRID_SOLE - GRID_CHIN) / bodyH;
  const bw = Math.min(box.w * sb * BODY_WIDEN, 22);
  const hw = head.w * sh;
  ctx.drawImage(front, box.x, neck, box.w, bodyH, Math.round((PIXEL_W - bw) / 2), GRID_CHIN, Math.round(bw), GRID_SOLE - GRID_CHIN);
  // 頭畫在身體之後、往下多蓋一格，脖子接縫不會露出一條透明縫
  ctx.drawImage(front, head.x, box.y, head.w, headH + 1 / sh,
    Math.round((PIXEL_W - hw) / 2), Math.round(GRID_CHIN - headH * sh), Math.round(hw), Math.round(headH * sh) + 1);

  const d = ctx.getImageData(0, 0, PIXEL_W, PIXEL_H).data;
  const cells = [];
  for (let y = 0; y < PIXEL_H; y++) {
    const row = [];
    for (let x = 0; x < PIXEL_W; x++) {
      const i = (y * PIXEL_W + x) * 4;
      row.push(d[i + 3] >= 128 ? [d[i], d[i + 1], d[i + 2]] : null);
    }
    cells.push(row);
  }
  const legTop = Math.round(GRID_CHIN + (box.y + box.h * CV_CUTS.legs[0] - neck) * sb);
  return { cells, legTop };
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 一群顏色的中位數（逐通道），拿來當「這一塊的代表色」，不會被少數雜色拉偏 */
function medianColor(list) {
  if (!list.length) return null;
  return [0, 1, 2].map((k) => list.map((c) => c[k]).sort((a, b) => a - b)[list.length >> 1]);
}
const cloneCells = (cells) => cells.map((r) => r.slice());

/**
 * 臉在哪裡：頭部每一列裡「像膚色」的像素範圍。
 * 眼睛、嘴巴、眼鏡夾在膚色中間，落在範圍內一起算進臉。
 */
function faceSpans(cells) {
  const pick = (x0, x1, y0, y1) => {
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (cells[y][x]) out.push(cells[y][x]);
    return out;
  };
  const skin = medianColor(pick(16, 23, GRID_CHIN - 7, GRID_CHIN - 3));
  const hair = medianColor(pick(14, 25, GRID_TOP, GRID_TOP + 3));
  if (!skin || !hair) return { spans: new Map(), hair, skin };
  const isSkin = (c) => c && dist3(c, skin) < 60 && dist3(c, skin) < dist3(c, hair);
  const spans = new Map();
  for (let y = GRID_TOP + 2; y <= GRID_CHIN; y++) {
    let a = -1, b = -1, n = 0;
    for (let x = 0; x < PIXEL_W; x++) if (isSkin(cells[y][x])) { if (a < 0) a = x; b = x; n++; }
    if (n >= 2) spans.set(y, [a, b]);
  }
  return { spans, hair, skin };
}

/**
 * 背面：同一個輪廓，整張臉（連同眼睛、眼鏡、嘴）換成頭髮。
 * 髮型、髮量、衣服與褲子都來自本人的正面 —— 通用的像素髮型再怎麼挑，
 * 都不會比本人自己的輪廓更像。
 *
 * 臉的範圍取膚色列的聯集，再往上多涵蓋幾列：眼睛與墨鏡不是膚色，
 * 只換膚色會讓眼睛留在後腦勺上（實測過）。
 */
function backCells(cells, { spans, hair }) {
  const out = cloneCells(cells);
  if (!hair) return out;
  const rows = [...spans.keys()];
  if (rows.length < 3) return out;
  let a = PIXEL_W, b = -1;
  for (const [x0, x1] of spans.values()) { a = Math.min(a, x0); b = Math.max(b, x1); }
  const top = Math.max(GRID_TOP + 2, Math.min(...rows) - 5);
  const dark = hair.map((v) => v * 0.82);
  for (let y = top; y <= GRID_CHIN; y++) {
    // 越往下越暗一點，後腦勺才有體積；每隔幾欄一道暗色髮絲
    const t = (y - top) / Math.max(1, GRID_CHIN - top);
    const base = hair.map((v, k) => v + (dark[k] - v) * t);
    for (let x = a - 1; x <= b + 1; x++) {
      if (x < 0 || x >= PIXEL_W || !out[y][x]) continue;
      out[y][x] = (x - a) % 4 === 1 && t > 0.15 ? dark : base;
    }
  }
  return out;
}

/**
 * 側面（面向左）。
 *
 * 頭：背面的髮型輪廓稍微收窄，再在前緣「畫」一張側臉 —— 膚色的臉頰往下收成下巴、
 * 一隻眼睛（取自正面左眼）、鼻尖、嘴。先前直接把半張正臉貼上去，實測
 * 「側面很醜」：正臉的半邊帶著鬢髮與臉頰輪廓，貼到側面變成一塊缺口。
 * 身體：只留軀幹與一隻手臂（近側），收成側身的厚度 —— 正面兩隻手都壓進去
 * 會像一個扁盒子兩邊各黏一隻手。
 */
function sideCells(cells, back, { spans, skin }, legCols) {
  const out = cells.map(() => Array(PIXEL_W).fill(null));
  const squeeze = (src, y, k, x0 = 0, x1 = PIXEL_W - 1) => {
    for (let x = 0; x < PIXEL_W; x++) {
      const sx = Math.round(20 + (x + 0.5 - 20) / k - 0.5);
      if (sx >= x0 && sx <= x1) out[y][x] = src[y][sx];
    }
  };
  // 身體：軀幹（兩腿之間那幾欄）收窄；手臂另外補一隻
  const [la, lb] = legCols;
  for (let y = 0; y < PIXEL_H; y++) {
    if (y <= GRID_CHIN) squeeze(back, y, 0.86);
    else squeeze(cells, y, 0.7, la, lb);
  }
  // 近側手臂：正面左手那一段（腿欄左邊的像素），搬到軀幹中間
  for (let y = GRID_CHIN + 1; y < PIXEL_H; y++) {
    const arm = [];
    for (let x = 0; x < la; x++) if (cells[y][x]) arm.push(cells[y][x]);
    if (!arm.length) continue;
    const w = Math.min(3, arm.length);
    for (let i = 0; i < w; i++) out[y][18 + i] = arm[arm.length - w + i];
  }

  // 真正的臉：膚色至少五格寬的那幾列（額頭從瀏海縫隙露出的一兩格不算）
  const rows = [...spans.keys()].filter((y) => spans.get(y)[1] - spans.get(y)[0] >= 4).sort((a, b) => a - b);
  if (rows.length < 4 || !skin) return out;
  const top = rows[0], chin = rows[rows.length - 1];
  const shadeC = (c, k) => c.map((v) => Math.round(v * k));

  // 左眼：臉內側（離臉的左緣兩格以上）明顯比膚色暗的像素。
  // 只看臉內側 —— 臉緣外的鬢髮也是暗的，算進來眼睛會被放到頭髮上
  const eye = [];
  for (const y of rows.slice(0, 9)) {
    const [x0] = spans.get(y);
    for (let x = x0 + 1; x < 20; x++) {
      const c = cells[y][x];
      if (!c) continue;
      const lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
      const lumSkin = 0.3 * skin[0] + 0.59 * skin[1] + 0.11 * skin[2];
      if (lum < lumSkin * 0.62) eye.push([x, y, c]);
    }
  }
  const eyeX0 = eye.length ? Math.min(...eye.map((e) => e[0])) : 0;
  const eyeY0 = eye.length ? Math.min(...eye.map((e) => e[1])) : top + 2;
  const eyeY1 = eye.length ? Math.max(...eye.map((e) => e[1])) : top + 5;

  // 臉貼齊頭的前緣：側臉的輪廓就是角色的前緣
  const lead = Math.min(...rows.map((y) => { const i = out[y].findIndex(Boolean); return i < 0 ? PIXEL_W : i; }));
  const n = chin - top;
  for (const y of rows) {
    // 臉頰的弧：上緣 6 格、中段 7 格、往下巴收到 3 格
    const k = y - top, fromChin = chin - y;
    const w = fromChin <= 3 ? [3, 4, 5, 6][fromChin] : k < 1 ? 6 : 7;
    for (let x = lead; x < lead + w; x++) {
      // 後緣與下巴一格陰影，臉才有體積
      out[y][x] = x === lead + w - 1 || fromChin === 0 ? shadeC(skin, 0.86) : skin;
    }
  }
  // 眼睛：取正面左眼最靠外的三欄，放在臉的前段
  if (eye.length) {
    for (const [x, y, c] of eye) {
      const tx = lead + 1 + (x - eyeX0);
      if (tx <= lead + 3) out[y][tx] = c;
    }
  } else {
    for (let y = top + 2; y <= Math.min(chin - 3, top + 4); y++) out[y][lead + 1] = [43, 31, 29];
  }
  // 瀏海蓋住額頭：臉最上面兩列換回頭髮色，第二列留參差的髮尾
  const hairAt = (y) => out[y].find((c, x) => c && x > lead + 8) ?? [40, 30, 28];
  for (let x = lead; x < lead + 7; x++) if (out[top][x]) out[top][x] = hairAt(top);
  for (let x = lead + 1; x < lead + 7; x += 2) if (out[top + 1][x]) out[top + 1][x] = hairAt(top + 1);
  // 鼻尖（往前凸一格）與嘴
  const ny = Math.min(chin - 2, eyeY1 + 2);
  if (lead > 0) out[ny][lead - 1] = skin;
  if (chin - 1 > ny) out[chin - 1][lead] = shadeC(skin, 0.68);
  // 耳朵：臉後緣、與眼睛同高
  const ex = lead + 7;
  for (let y = eyeY1; y <= Math.min(chin - 2, eyeY1 + 2); y++) if (out[y][ex]) out[y][ex] = y === eyeY1 + 1 ? shadeC(skin, 0.85) : skin;
  void n; void eyeY0;
  return out;
}

/**
 * 腿在哪幾欄：鞋底附近幾列的不透明範圍。
 * 步態只能動這幾欄 —— 先前整個左半邊一起上提，腿欄外的手也跟著抬，
 * 實測就是「同手同腳」。
 */
function legColumns(cells) {
  let a = PIXEL_W, b = -1;
  for (let y = GRID_SOLE - 4; y <= GRID_SOLE; y++) {
    for (let x = 0; x < PIXEL_W; x++) if (cells[y]?.[x]) { a = Math.min(a, x); b = Math.max(b, x); }
  }
  return b < 0 ? [14, 25] : [a, b];
}

/** 把某個矩形範圍內的像素上移一格 */
function liftBlock(out, src, x0, x1, y0, y1) {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) out[y - 1][x] = src[y][x];
    out[y1][x] = null;
  }
}

/**
 * 正面／背面的步態：一隻腳抬起一格，**另一側**的手同時擺起一格 ——
 * 與捏臉角色的 armsFrontBack 一致，走路才是左腳配右手。
 */
function liftStep(cells, legTop, frame, legCols) {
  if (frame === 0) return cells;
  const out = cloneCells(cells);
  const [la, lb] = legCols;
  const mid = Math.round((la + lb) / 2);
  const [fx0, fx1] = frame === 1 ? [la, mid - 1] : [mid, lb];
  liftBlock(out, cells, fx0, fx1, legTop + 1, PIXEL_H - 1);
  // 對側的手：腿欄之外、腰到手掌那一段
  const [hx0, hx1] = frame === 1 ? [lb + 1, PIXEL_W - 1] : [0, la - 1];
  if (hx0 <= hx1) liftBlock(out, cells, hx0, hx1, legTop - 6, legTop + 3);
  return out;
}

/** 側面的步態：兩隻腳前後張開（只動腿欄，手不跟著動） */
function strideStep(cells, legTop, frame, legCols) {
  if (frame === 0) return cells;
  const out = cloneCells(cells);
  const [la, lb] = legCols;
  const mid = Math.round((la + lb) / 2);
  const dir = frame === 1 ? 1 : -1;
  for (let y = legTop + 2; y < PIXEL_H; y++) {
    const row = out[y].slice();
    for (let x = la - 2; x <= lb + 2; x++) if (x >= 0 && x < PIXEL_W) row[x] = null;
    for (let x = la; x <= lb; x++) {
      if (!cells[y][x]) continue;
      const tx = x + (x < mid ? -dir : dir);
      if (tx >= 0 && tx < PIXEL_W) row[tx] = cells[y][x];
    }
    out[y] = row;
  }
  return out;
}

/** 補外框後畫成 canvas */
function cellsToCanvas(cells, mirrored = false) {
  const c = pixelCanvas();
  const g = c.getContext('2d');
  const solid = (x, y) => x >= 0 && y >= 0 && x < PIXEL_W && y < PIXEL_H && cells[y][x];
  for (let y = 0; y < PIXEL_H; y++) {
    for (let x = 0; x < PIXEL_W; x++) {
      const px = mirrored ? PIXEL_W - 1 - x : x;
      const cell = cells[y][x];
      if (cell) g.fillStyle = `rgb(${cell[0]},${cell[1]},${cell[2]})`;
      else if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) g.fillStyle = OUTLINE;
      else continue;
      g.fillRect(px, y, 1, 1);
    }
  }
  return c;
}

/**
 * 拍照角色的四個方向，全部從生成的正面推出來。
 *
 * 生成服務只畫正面（一次畫多個視角會被品質檢查判為碎裂，見
 * backend/garment_gen.py 的「EXACTLY ONE single figure」）。側面與背面若用通用的
 * 像素髮型與取樣色去畫，實測「側邊跟背後超級不像」—— 本人的長髮、瀏海形狀、
 * 衣服花色全都不見了。改為從正面本身推：背面是同一個輪廓把臉換成頭髮，
 * 側面是背面的髮型收窄後貼上半張臉。
 */
function cvViews(front) {
  const fc = cvFrontCells(front);
  if (!fc) return null;
  const { cells, legTop } = fc;
  const legCols = legColumns(cells);
  const face = faceSpans(cells);
  const back = backCells(cells, face);
  const side = sideCells(cells, back, face, legCols);
  const sideLegs = legColumns(side);
  const frames = (src, step, mirrored, cols = legCols) => [0, 1, 2].map((f) => cellsToCanvas(step(src, legTop, f, cols), mirrored));
  return {
    down: frames(cells, liftStep),
    up: frames(back, liftStep),
    left: frames(side, strideStep, false, sideLegs),
    right: frames(side, strideStep, true, sideLegs),
  };
}

/**
 * 拍照角色在場上的畫格：四個方向都從生成的正面推出來（見 cvViews）。
 *
 * 生成的圖還沒載入前，先用像素畫法依取樣色與 pixelParts 頂著，
 * 角色不會有空白期；載入後原地換掉。
 * 揮手、乾杯沒有專屬畫格（正面是生成的圖，畫不出舉手），沿用頭上的圖示。
 */
function cvPixelSprite(avatar, opts = {}) {
  let frames = {};
  const paintGrid = (grid) => {
    const c = pixelCanvas();
    const g = c.getContext('2d');
    for (let y = 0; y < PIXEL_H; y++) {
      for (let x = 0; x < PIXEL_W; x++) {
        if (!grid[y][x]) continue;
        g.fillStyle = grid[y][x];
        g.fillRect(x, y, 1, 1);
      }
    }
    return c;
  };
  for (const dir of PIXEL_DIRS) {
    frames[dir] = [];
    for (let f = 0; f < PIXEL_FRAMES; f++) frames[dir].push(paintGrid(avatarGrid(avatar, dir, f)));
  }
  const front = cvAvatarImage(avatar, {
    ...opts,
    onPaint: () => { frames = cvViews(front) ?? frames; opts.onReady?.(); },
  });
  // 用 getter：onPaint 換掉整組畫格，drawCharacter 每幀讀到的都是最新的
  Object.defineProperty(front, 'pixelFrames', { get: () => frames, configurable: true });
  return front;
}

/**
 * 角色肖像：場上實際用的那一格像素畫格，放大成整數倍、不平滑。
 *
 * 手機左上角縮圖、拍照確認頁、配對確認、離場頁都用這個 —— 它們原本各自畫
 * （捏臉 SVG、或生成的原圖），拍照角色在確認頁是三頭身的原圖，進場後卻是
 * 兩頭身的像素角色，實測被指出「進場畫面跟實際在場景裡不一樣」。
 *
 * 拍照角色要等生成圖載入才畫得出正面；最多等 4 秒，逾時就用取樣色的像素角色。
 *
 * @returns {Promise<HTMLCanvasElement>}
 */
export function avatarPortrait(avatar, { dir = 'down', scale = 8 } = {}) {
  return new Promise((resolve) => {
    const done = (frames) => {
      const c = document.createElement('canvas');
      c.width = PIXEL_W * scale;
      c.height = PIXEL_H * scale;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(frames[dir][0], 0, 0, c.width, c.height);
      resolve(c);
    };
    if (avatar?.source !== 'CV') { done(pixelAvatarImage(avatar).pixelFrames); return; }
    const sprite = cvPixelSprite(avatar, { onReady: () => done(sprite.pixelFrames) });
    setTimeout(() => done(sprite.pixelFrames), 4000);
  });
}

/** 依來源選用組裝方式。回傳物件皆帶有 complete / naturalWidth，可直接交給 drawCharacter。 */
export function avatarImage(avatar, opts) {
  if (avatar?.source === 'CV') return cvPixelSprite(avatar, opts);
  return pixelAvatarImage(avatar);
}
