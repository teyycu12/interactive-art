/**
 * 像素角色 —— 捏臉角色的唯一畫法（大螢幕、手機 POV、捏臉預覽、主辦端縮圖共用）。
 *
 * 畫風對齊大螢幕的像素場景（public/screen/scenes/）：Q 版大頭、柔和的深棕外框、
 * 每個部位自帶明暗。與場景一樣全部程序繪製，沒有任何圖片檔或 CDN 依賴。
 *
 * 每個角色有四個方向 × 三格步態：
 *   down（面向觀眾）/ up（背面）/ left / right —— right 是 left 的水平鏡像
 *   frame 0 站立、1 與 2 為左右腳交替跨出
 *
 * 輸出是純資料（二維顏色陣列），不碰 DOM：SVG 與 canvas 兩種輸出都從同一份
 * 格子產生，node 測試也能直接驗。
 *
 * ── 畫法 ──
 * 每個部位（頭、頭髮、衣服、手臂、褲子、鞋）以幾何形狀畫進格子，並記下它屬於
 * 哪個部位。全部畫完後跑兩道後製：
 *   1. 明暗：部位的右緣與下緣各暗一格 —— 光從左上來，衣服、頭髮、臉頰自然有體積，
 *      不必每種組合逐格手繪陰影。
 *   2. 外框：輪廓外圍一圈柔和的深棕色。
 *
 * 座標（40 × 54，設計座標整體下移一格，讓丸子頭頂端上方仍有空間畫外框）：
 *   頭 y 3–25（約佔身高 45%，Q 版比例）、身體 y 25–40、腿 y 41–47、鞋 y 48–51。
 *   身體連同雙手與頭同寬（x 8–31）—— 矮胖的身形才是 Q 版 RPG 角色的比例，
 *   身體比頭窄會像頂著一顆氣球。
 *   左右以 x = 19.5 為中線，鏡像公式為 x' = 39 − x。
 */

export const PIXEL_W = 40;
export const PIXEL_H = 54;
const DY = 1;

export const PIXEL_DIRS = ['down', 'up', 'left', 'right'];
export const PIXEL_FRAMES = 3;

/** 外框色。比純黑柔和，Q 版角色看起來比較軟。 */
export const OUTLINE = '#3B2A26';
const EYE = '#2B2320';
const WHITE = '#F6F1E7';
const LENS = '#DCEBF0';
const FRAME = '#4E3B33';
const SHOE = '#3F4452';
const SOLE = '#E9E4D8';
/** 背面與毛帽底下露出的髮色（毛帽的 hair 欄位是帽子顏色，不是頭髮） */
const CAP_HAIR = '#3A2E27';
/** 沒有下身顏色時的預設褲色（牛仔藍） */
export const DEFAULT_PANTS = '#4F6A86';

// ── 顏色工具 ─────────────────────────────────────────────
const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const mix = (a, b, t) => { const x = parse(a), y = parse(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const shade = (hex, k) => toHex(parse(hex).map((v) => v * k));

// ── 格子畫筆 ─────────────────────────────────────────────
/** 不參與自動明暗的部位：五官與小配件本身就是最終顏色 */
const FLAT = new Set(['detail']);

function canvas() {
  const col = Array.from({ length: PIXEL_H }, () => Array(PIXEL_W).fill(null));
  const part = Array.from({ length: PIXEL_H }, () => Array(PIXEL_W).fill(null));
  const put = (x, y, c, p) => {
    const yy = y + DY;
    if (x >= 0 && x < PIXEL_W && yy >= 0 && yy < PIXEL_H) { col[yy][x] = c; part[yy][x] = p; }
  };
  const clear = (x, y) => put(x, y, null, null);
  /** 矩形（兩端皆含） */
  const rect = (x0, y0, x1, y1, c, p) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, c, p); };
  /** 以像素中心判定的實心橢圓；keep(x, y) 可裁掉不要的部分 */
  const oval = (cx, cy, rx, ry, c, p, keep = null) => {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1 && (!keep || keep(x, y))) put(x, y, c, p);
      }
    }
  };
  const dots = (list, c, p = 'detail') => { for (const [x, y] of list) put(x, y, c, p); };
  /** 左右對稱的點：只給左半邊 */
  const sym = (list, c, p = 'detail') => dots(list.flatMap(([x, y]) => [[x, y], [39 - x, y]]), c, p);
  /** 每列一段：rows = [[y, x0, x1], ...] */
  const rows = (list, c, p) => { for (const [y, x0, x1] of list) rect(x0, y, x1, y, c, p); };
  return { col, part, put, clear, rect, oval, dots, sym, rows };
}

/** 後製 1：部位的右緣與下緣各暗一格 */
function shadeEdges(g) {
  const { col, part } = g;
  const out = col.map((r) => r.slice());
  const differs = (p, x, y) => {
    const q = part[y]?.[x];
    return q !== p && !FLAT.has(q);
  };
  for (let y = 0; y < PIXEL_H; y++) {
    for (let x = 0; x < PIXEL_W; x++) {
      const p = part[y][x];
      if (!p || FLAT.has(p)) continue;
      if (differs(p, x + 1, y) || differs(p, x, y + 1)) out[y][x] = shade(col[y][x], 0.84);
    }
  }
  return out;
}

/** 後製 2：透明格只要上下左右有任一實心格，就塗成外框色 */
function outline(g) {
  const src = g.map((r) => r.slice());
  for (let y = 0; y < PIXEL_H; y++) {
    for (let x = 0; x < PIXEL_W; x++) {
      if (src[y][x]) continue;
      if (src[y - 1]?.[x] || src[y + 1]?.[x] || src[y][x - 1] || src[y][x + 1]) g[y][x] = OUTLINE;
    }
  }
  return g;
}

const mirror = (g) => g.map((r) => r.slice().reverse());

// ── 身體骨架 ─────────────────────────────────────────────
/**
 * 正面／背面的腿。frame 1 抬左腳、frame 2 抬右腳（抬起那隻短兩格、鞋子跟著上移）。
 * 洋裝的腿是膚色、較細，從裙襬下方才露出來。
 */
function legsFrontBack(p, c, frame, bare) {
  if (!bare) p.rect(12, 41, 27, 42, c.pants, 'pants');
  for (const [side, x0, x1] of [[1, 12, 18], [2, 21, 27]]) {
    const lift = frame === side ? 2 : 0;
    const lx0 = bare ? x0 + 1 : x0, lx1 = bare ? x1 - 1 : x1;
    p.rect(lx0, bare ? 44 : 41, lx1, 47 - lift, bare ? c.skin : c.pants, bare ? 'skin' : 'pants');
    const sx0 = side === 1 ? x0 - 1 : x0, sx1 = side === 1 ? x1 : x1 + 1;
    p.rect(sx0, 48 - lift, sx1, 50 - lift, SHOE, 'shoe');
    p.rect(sx0, 51 - lift, sx1, 51 - lift, SOLE, 'sole');
    p.clear(side === 1 ? sx0 : sx1, 48 - lift);   // 鞋頭圓角
  }
}

/** 側面的腿（面向左）。跨步時近側腿用原色、遠側腿用暗色，才分得出哪隻在前。 */
function legsSide(p, c, frame, bare) {
  const near = bare ? c.skin : c.pants;
  const far = bare ? c.skinSh : c.pantsSh;
  const leg = (x0, w, slope, color, top) => {
    for (let y = top; y <= 47; y++) {
      const dx = Math.round((y - 41) * slope);
      p.rect(x0 + dx, y, x0 + dx + w - 1, y, color, color === near ? 'pants' : 'pantsFar');
    }
    const fx = x0 + Math.round(6 * slope);
    p.rect(fx - 2, 48, fx + w - 1, 50, SHOE, 'shoe');
    p.rect(fx - 2, 51, fx + w - 1, 51, SOLE, 'sole');
  };
  const top = bare ? 44 : 41;
  const w = bare ? 4 : 6;
  if (frame === 0) { leg(bare ? 18 : 17, w, 0, near, top); return; }
  // 後腳先畫，前腳蓋在上面
  const [front, back] = frame === 1 ? [near, far] : [far, near];
  leg(bare ? 20 : 19, w, 0.55, back, top);
  leg(bare ? 17 : 16, w, -0.55, front, top);
  if (!bare) p.rect(16, 41, 23, 41, near, 'pants');
}

/** 正面／背面的手臂。sleeve：'long' 整隻衣袖、'short' 只到上臂、'bare' 全膚色 */
function armsFrontBack(p, c, frame, sleeve, raised = false) {
  for (const [side, x0, x1] of [[1, 8, 10], [2, 29, 31]]) {
    if (raised && side === 2) continue;       // 舉起的那隻手在頭畫完之後才畫（見 paintRaisedArm）
    // 抬左腳時擺右手，反之亦然：整隻手縮上來兩格
    const swing = (frame === 1 && side === 2) || (frame === 2 && side === 1) ? 2 : 0;
    const bottom = 36 - swing;
    for (let y = 27; y <= bottom; y++) {
      const cloth = sleeve === 'long' || (sleeve === 'short' && y <= 31);
      p.rect(x0, y, x1, y, cloth ? c.acc : c.skin, cloth ? 'arm' : 'armSkin');
    }
    p.put(side === 1 ? x0 : x1, 27, null, null);        // 圓肩
    if (sleeve === 'long') p.rect(x0, bottom - 1, x1, bottom, c.cuff, 'cuff');
    if (sleeve === 'short') p.rect(x0, 31, x1, 31, c.cuff, 'cuff');
    p.rect(x0, bottom + 1, x1, bottom + 3, c.skin, 'hand');
    p.put(side === 1 ? x0 : x1, bottom + 3, null, null);
  }
}

/** 側面手臂：蓋在軀幹上，跨步時前後擺 */
function armSide(p, c, frame, sleeve) {
  const dx = frame === 1 ? -2 : frame === 2 ? 2 : 0;
  for (let y = 27; y <= 36; y++) {
    const k = y <= 31 ? 0 : Math.round(((y - 31) / 5) * dx);
    const cloth = sleeve === 'long' || (sleeve === 'short' && y <= 31);
    p.rect(18 + k, y, 21 + k, y, cloth ? c.accSh : c.skin, cloth ? 'arm' : 'armSkin');
  }
  if (sleeve === 'long') p.rect(18 + dx, 35, 21 + dx, 36, c.cuff, 'cuff');
  if (sleeve === 'short') p.rect(18, 31, 21, 31, c.cuff, 'cuff');
  p.rect(18 + dx, 37, 21 + dx, 39, c.skin, 'hand');
}

// ── 服裝 ─────────────────────────────────────────────────
/**
 * 每種服裝各自描述正面、背面、側面的細節；軀幹、手臂與腿的共用骨架在上面。
 * dress 的軀幹較短、下接裙襬，腿改為膚色。
 */
const BODY_PIXELS = {
  body_tee_01: {
    sleeve: 'short',
    down(p, c) { p.rows([[26, 17, 22], [27, 18, 21]], c.skin, 'neck'); },
    up(p, c) { p.rect(18, 26, 21, 26, c.skin, 'neck'); },
    left(p, c) { p.rect(14, 26, 15, 27, c.skin, 'neck'); },
  },
  body_hoodie_01: {
    sleeve: 'long',
    down(p, c) {
      p.rows([[25, 13, 26], [26, 13, 26], [27, 14, 25]], c.accSh, 'hood');
      p.rect(18, 26, 21, 27, c.skin, 'neck');
      p.dots([[17, 28], [17, 29], [17, 30], [22, 28], [22, 29], [22, 30]], WHITE);
      p.rect(14, 34, 25, 34, c.cuff, 'detail');
      p.dots([[14, 35], [14, 36], [14, 37], [25, 35], [25, 36], [25, 37]], c.cuff);
    },
    up(p, c) { p.oval(20, 29, 7, 4.5, c.accSh, 'hood'); },
    left(p, c) { p.oval(25, 28, 4, 3.5, c.accSh, 'hood'); p.rect(14, 26, 15, 27, c.skin, 'neck'); },
  },
  body_shirt_02: {
    sleeve: 'long',
    down(p, c) {
      p.sym([[16, 26], [17, 26], [18, 26], [17, 27], [18, 27], [18, 28]], WHITE);
      p.rect(19, 26, 20, 27, c.skin, 'neck');
      p.rect(19, 29, 20, 40, c.accSh, 'detail');
      p.dots([[19, 31], [19, 35], [19, 39]], WHITE);
    },
    up(p) { p.rect(16, 26, 23, 26, WHITE, 'detail'); },
    left(p) { p.dots([[14, 26], [15, 26], [14, 27]], WHITE); },
  },
  body_dress_03: {
    sleeve: 'bare', dress: true,
    down(p, c) { p.rows([[26, 17, 22], [27, 18, 21]], c.skin, 'neck'); p.rect(11, 33, 28, 33, c.cuff, 'detail'); },
    up(p, c) { p.rect(18, 26, 21, 26, c.skin, 'neck'); p.rect(11, 33, 28, 33, c.cuff, 'detail'); },
    left(p, c) { p.rect(14, 26, 15, 27, c.skin, 'neck'); p.rect(14, 33, 25, 33, c.cuff, 'detail'); },
  },
  body_jacket_04: {
    sleeve: 'long',
    down(p, c) {
      p.rect(17, 26, 22, 40, WHITE, 'inner');
      p.rect(18, 26, 21, 26, c.skin, 'neck');
      p.sym([[16, 26], [16, 27], [16, 28], [17, 29], [16, 29], [16, 30]], c.accSh);
      p.sym([[12, 34], [13, 34], [14, 34]], c.accSh);
    },
    up(p, c) { p.rect(19, 28, 20, 40, c.accSh, 'detail'); },
    left(p) { p.rect(14, 27, 15, 40, WHITE, 'inner'); },
  },
  body_tank_05: {
    sleeve: 'bare',
    down(p, c) { p.rect(11, 26, 28, 28, c.skin, 'neck'); p.rect(14, 26, 15, 28, c.acc, 'cloth'); p.rect(24, 26, 25, 28, c.acc, 'cloth'); },
    up(p, c) { p.rect(11, 26, 28, 27, c.skin, 'neck'); p.rect(14, 26, 15, 27, c.acc, 'cloth'); p.rect(24, 26, 25, 27, c.acc, 'cloth'); },
    left(p, c) { p.rect(14, 26, 25, 27, c.skin, 'neck'); p.rect(19, 26, 20, 27, c.acc, 'cloth'); },
  },
};

function paintBody(p, c, body, dir, frame, pose = null) {
  const spec = BODY_PIXELS[body] ?? BODY_PIXELS.body_tee_01;
  const side = dir === 'left';
  const bare = !!spec.dress;

  if (side) legsSide(p, c, frame, bare);
  else legsFrontBack(p, c, frame, bare);

  // 軀幹：肩膀一列稍窄，做出圓肩
  const [x0, x1] = side ? [14, 25] : [11, 28];
  const bottom = bare ? 33 : 40;
  p.rect(x0 + 1, 26, x1 - 1, 26, c.acc, 'cloth');
  p.rect(x0, 27, x1, bottom, c.acc, 'cloth');
  if (bare) {
    // 裙襬往下張開
    for (let y = 34; y <= 43; y++) {
      const spread = Math.round((y - 34) * 0.35);
      p.rect(x0 - spread, y, x1 + spread, y, y === 43 ? c.accSh : c.acc, 'skirt');
    }
  }
  spec[side ? 'left' : dir](p, c);

  if (side) { if (!pose) armSide(p, c, frame, spec.sleeve); }
  else armsFrontBack(p, c, frame, spec.sleeve, !!pose);
  return spec.sleeve;
}

// ── 頭 ───────────────────────────────────────────────────
function paintHeadBase(p, c, dir) {
  p.oval(20, 15.5, 11.5, 11, c.skin, 'skin');
  if (dir === 'left') {
    p.put(7, 18, c.skin, 'skin');        // 鼻尖
  } else {
    p.oval(8, 17.5, 1.8, 2.4, c.skin, 'ear');
    p.oval(32, 17.5, 1.8, 2.4, c.skin, 'ear');
  }
}

/** 瀏海每一欄的長度（x = 9…30）。參差不齊才像真的頭髮，而不是一條直線。 */
const BANGS = [4, 3, 4, 2, 3, 4, 3, 2, 1, 2, 3, 3, 2, 1, 2, 3, 4, 3, 2, 4, 3, 4];

/** 頭頂的髮型輪廓（正面／背面共用的上半部） */
const crown = (p, c, cy = 13) => p.oval(20, cy, 12.5, 10.5, c.hair, 'hair', (x, y) => y <= 12);
/** 高光：左上一道弧，讓頭髮有光澤 */
const gloss = (p, c, pts = [[12, 7], [13, 6], [14, 6], [15, 5], [12, 8]]) => p.dots(pts, c.hairHi);
/** 髮流：幾道暗線 */
const strands = (p, c, pts) => p.dots(pts, c.hairSh);

/**
 * 髮型。每種各有正面、背面、側面（面向左）三個版本。
 * 毛帽的 hair 欄位是帽子顏色，帽簷下露出的頭髮固定用深棕。
 */
const HAIR_PIXELS = {
  head_short_01: {
    down(p, c) {
      crown(p, c);
      BANGS.forEach((len, i) => p.rect(9 + i, 13, 9 + i, 12 + len, c.hair, 'hair'));
      p.rect(8, 13, 10, 19, c.hair, 'hair'); p.rect(29, 13, 31, 19, c.hair, 'hair');
      strands(p, c, [[18, 5], [19, 6], [19, 7], [24, 8], [25, 9], [15, 10]]);
      gloss(p, c);
    },
    up(p, c) {
      p.oval(20, 14.5, 12.5, 11.5, c.hair, 'hair', (x, y) => y <= 24);
      strands(p, c, [[20, 8], [20, 9], [16, 14], [16, 15], [24, 14], [24, 15], [20, 19], [20, 20]]);
      gloss(p, c, [[14, 6], [15, 5], [16, 5], [13, 7]]);
    },
    left(p, c) {
      crown(p, c);
      p.oval(24, 14, 9, 11, c.hair, 'hair', (x) => x >= 18);
      [3, 2, 4, 3, 2, 3].forEach((len, i) => p.rect(9 + i, 13, 9 + i, 12 + len, c.hair, 'hair'));
      strands(p, c, [[24, 10], [25, 11], [26, 16], [27, 17]]);
      gloss(p, c);
    },
    ear: true,
  },
  head_curly_02: {
    down(p, c) {
      p.oval(20, 10.5, 12, 8, c.hair, 'hair');
      for (const [x, y, r] of [[11, 7, 3.4], [15, 4.5, 3.4], [20, 3.6, 3.4], [25, 4.5, 3.4], [29, 7, 3.4],
        [8.5, 11.5, 3], [31.5, 11.5, 3], [8.5, 16, 2.8], [31.5, 16, 2.8],
        [13, 12.5, 2.6], [17.6, 13.2, 2.6], [22.4, 13.2, 2.6], [27, 12.5, 2.6]]) p.oval(x, y, r, r, c.hair, 'hair');
      p.dots([[11, 5], [15, 3], [20, 2], [25, 3], [29, 5], [8, 10], [17, 12], [22, 12]], c.hairHi);
      strands(p, c, [[13, 9], [18, 7], [23, 7], [27, 9]]);
    },
    up(p, c) {
      p.oval(20, 14, 12.5, 11.5, c.hair, 'hair');
      for (const [x, y, r] of [[11, 7, 3.4], [15, 4.5, 3.4], [20, 3.6, 3.4], [25, 4.5, 3.4], [29, 7, 3.4],
        [8.5, 12, 3], [31.5, 12, 3], [9, 18, 3], [31, 18, 3], [13, 23, 3], [20, 24.5, 3], [27, 23, 3]]) p.oval(x, y, r, r, c.hair, 'hair');
      p.dots([[11, 5], [15, 3], [20, 2], [25, 3], [29, 5]], c.hairHi);
      strands(p, c, [[15, 11], [20, 10], [25, 11], [17, 17], [23, 17]]);
    },
    left(p, c) {
      p.oval(20, 10.5, 12, 8, c.hair, 'hair');
      for (const [x, y, r] of [[12, 6, 3.4], [17, 4, 3.4], [22, 4, 3.4], [27, 6, 3.4], [30, 11, 3.2],
        [29, 17, 3.2], [25, 22, 3], [10, 11.5, 2.8], [14, 12.8, 2.4]]) p.oval(x, y, r, r, c.hair, 'hair');
      p.oval(25, 15, 6.5, 8, c.hair, 'hair', (x) => x >= 20);
      p.dots([[12, 4], [17, 2], [22, 2], [27, 4], [10, 10]], c.hairHi);
      strands(p, c, [[24, 9], [27, 13], [26, 18]]);
    },
    ear: true,
  },
  head_bun_03: {
    down(p, c) {
      p.oval(20, 2.8, 4.2, 3.2, c.hair, 'bun');
      crown(p, c, 13.5);
      p.rows([[13, 9, 12], [13, 27, 30], [14, 9, 11], [14, 28, 30]], c.hair, 'hair');
      p.rect(8, 13, 9, 18, c.hair, 'hair'); p.rect(30, 13, 31, 18, c.hair, 'hair');
      strands(p, c, [[16, 6], [17, 8], [23, 6], [22, 8], [19, 9]]);
      p.dots([[18, 1], [19, 1]], c.hairHi); gloss(p, c);
    },
    up(p, c) {
      p.oval(20, 2.8, 4.2, 3.2, c.hair, 'bun');
      p.oval(20, 14.5, 12.5, 11.5, c.hair, 'hair', (x, y) => y <= 23);
      strands(p, c, [[16, 9], [17, 12], [23, 9], [22, 12], [20, 17]]);
      p.dots([[18, 1], [19, 1]], c.hairHi); gloss(p, c, [[14, 7], [15, 6], [13, 8]]);
    },
    left(p, c) {
      p.oval(27, 4.5, 3.6, 3.4, c.hair, 'bun');
      crown(p, c, 13.5);
      p.oval(24, 14, 9, 10.5, c.hair, 'hair', (x) => x >= 19);
      p.rows([[13, 9, 11]], c.hair, 'hair');
      strands(p, c, [[23, 9], [25, 12], [26, 16]]);
      p.dots([[26, 3], [27, 3]], c.hairHi); gloss(p, c);
    },
    ear: true,
  },
  head_long_04: {
    down(p, c) {
      crown(p, c);
      p.rows([[13, 9, 18], [14, 10, 17], [15, 11, 16], [13, 21, 30], [14, 22, 29], [15, 23, 28]], c.hair, 'hair');
      p.rect(7, 12, 11, 33, c.hair, 'hair'); p.rect(28, 12, 32, 33, c.hair, 'hair');
      p.rows([[34, 8, 10], [34, 29, 31]], c.hair, 'hair');
      strands(p, c, [[9, 20], [9, 21], [9, 26], [30, 20], [30, 21], [30, 26], [19, 5], [19, 6], [20, 7]]);
      gloss(p, c);
    },
    up(p, c) {
      p.oval(20, 14.5, 12.5, 11.5, c.hair, 'hair');
      p.rect(7, 14, 32, 33, c.hair, 'hair'); p.rows([[34, 8, 31]], c.hair, 'hair');
      strands(p, c, [[14, 18], [14, 19], [14, 26], [20, 12], [20, 13], [20, 22], [26, 18], [26, 19], [26, 27]]);
      gloss(p, c, [[14, 6], [15, 5], [16, 5], [13, 7]]);
    },
    left(p, c) {
      crown(p, c);
      p.oval(24, 14, 9, 11, c.hair, 'hair', (x) => x >= 18);
      p.rect(19, 18, 32, 33, c.hair, 'hair'); p.rows([[34, 20, 31]], c.hair, 'hair');
      p.rows([[13, 9, 13], [14, 9, 11]], c.hair, 'hair');
      strands(p, c, [[25, 20], [25, 21], [28, 26], [28, 27]]);
      gloss(p, c);
    },
    ear: false,
  },
  head_cap_05: {
    down(p, c) {
      p.oval(20, 11, 12.5, 9.5, c.hair, 'hair', (x, y) => y <= 10);
      p.rect(7, 10, 32, 13, c.band, 'band');
      for (let x = 8; x <= 31; x += 2) p.rect(x, 11, x, 13, shade(c.band, 0.86), 'detail');
      p.oval(20, 1.8, 2.6, 2, mix(c.hair, '#FFFFFF', 0.35), 'pom');
      p.rect(8, 14, 10, 18, CAP_HAIR, 'hair2'); p.rect(29, 14, 31, 18, CAP_HAIR, 'hair2');
      p.dots([[12, 5], [13, 4], [14, 4]], c.hairHi);
    },
    up(p, c) {
      p.oval(20, 14.5, 12.5, 11.5, CAP_HAIR, 'hair2', (x, y) => y >= 13 && y <= 24);
      p.oval(20, 11, 12.5, 9.5, c.hair, 'hair', (x, y) => y <= 10);
      p.rect(7, 10, 32, 13, c.band, 'band');
      for (let x = 8; x <= 31; x += 2) p.rect(x, 11, x, 13, shade(c.band, 0.86), 'detail');
      p.oval(20, 1.8, 2.6, 2, mix(c.hair, '#FFFFFF', 0.35), 'pom');
    },
    left(p, c) {
      p.oval(24, 17, 8, 7, CAP_HAIR, 'hair2', (x, y) => x >= 19 && y >= 13);
      p.oval(20, 11, 12.5, 9.5, c.hair, 'hair', (x, y) => y <= 10);
      p.rect(7, 10, 32, 13, c.band, 'band');
      for (let x = 8; x <= 31; x += 2) p.rect(x, 11, x, 13, shade(c.band, 0.86), 'detail');
      p.oval(21, 1.8, 2.6, 2, mix(c.hair, '#FFFFFF', 0.35), 'pom');
      p.dots([[12, 5], [13, 4], [14, 4]], c.hairHi);
    },
    ear: true,
  },
  head_bald_06: {
    down(p, c) { p.dots([[13, 7], [14, 6], [15, 6], [13, 8]], c.skinHi); },
    up(p, c) { p.dots([[14, 7], [15, 6], [16, 6], [14, 8]], c.skinHi); },
    left(p, c) { p.dots([[15, 6], [16, 5], [17, 5], [15, 7]], c.skinHi); },
    ear: true,
  },
};

/** 一顆 3×4 的大眼睛，左上一點反光 —— Q 版可愛感的主要來源 */
const eye = (p, x) => { p.rect(x, 15, x + 2, 18, EYE, 'detail'); p.put(x, 15, WHITE, 'detail'); p.put(x + 2, 18, mix(EYE, '#FFFFFF', 0.25), 'detail'); };
const smile = (p) => p.dots([[17, 21], [18, 22], [19, 22], [20, 22], [21, 22], [22, 21]], EYE);
const blush = (p, c) => p.sym([[11, 20], [12, 20], [13, 20]], c.blush);

/** 表情。背面看不到臉，所以只有正面與側面（面向左）。 */
const FACE_PIXELS = {
  face_smile_01: {
    down(p, c) { eye(p, 13); eye(p, 24); smile(p); blush(p, c); },
    left(p, c) { p.rect(11, 15, 12, 18, EYE, 'detail'); p.put(11, 15, WHITE, 'detail'); p.dots([[9, 21], [10, 22], [11, 22]], EYE); p.dots([[13, 20], [14, 20]], c.blush); },
  },
  face_smile_glasses: {
    down(p, c) {
      for (const x0 of [11, 22]) {
        p.rect(x0, 13, x0 + 6, 13, FRAME, 'detail'); p.rect(x0, 19, x0 + 6, 19, FRAME, 'detail');
        p.rect(x0, 14, x0, 18, FRAME, 'detail'); p.rect(x0 + 6, 14, x0 + 6, 18, FRAME, 'detail');
        p.rect(x0 + 1, 14, x0 + 5, 18, mix(c.skin, LENS, 0.45), 'detail');
      }
      p.rect(18, 15, 21, 15, FRAME, 'detail');
      eye(p, 13); eye(p, 24); smile(p); blush(p, c);
    },
    left(p, c) {
      p.rect(8, 13, 13, 13, FRAME, 'detail'); p.rect(8, 19, 13, 19, FRAME, 'detail');
      p.rect(8, 14, 8, 18, FRAME, 'detail'); p.rect(13, 14, 13, 18, FRAME, 'detail');
      p.rect(9, 14, 12, 18, mix(c.skin, LENS, 0.45), 'detail'); p.rect(14, 15, 21, 15, FRAME, 'detail');
      p.rect(10, 15, 11, 18, EYE, 'detail'); p.put(10, 15, WHITE, 'detail');
      p.dots([[9, 21], [10, 22], [11, 22]], EYE); p.dots([[14, 20], [15, 20]], c.blush);
    },
  },
  face_wink_02: {
    down(p, c) { eye(p, 13); p.dots([[24, 18], [25, 17], [26, 17], [27, 18]], EYE); smile(p); blush(p, c); },
    left(p, c) { p.rect(11, 15, 12, 18, EYE, 'detail'); p.put(11, 15, WHITE, 'detail'); p.dots([[9, 21], [10, 22], [11, 22]], EYE); p.dots([[13, 20], [14, 20]], c.blush); },
  },
  face_calm_03: {
    down(p, c) {
      p.dots([[12, 17], [13, 18], [14, 18], [15, 17], [24, 17], [25, 18], [26, 18], [27, 17]], EYE);
      p.dots([[19, 22], [20, 22]], EYE); blush(p, c);
    },
    left(p, c) { p.dots([[10, 17], [11, 18], [12, 18], [13, 17], [10, 22]], EYE); p.dots([[13, 20], [14, 20]], c.blush); },
  },
  face_grin_04: {
    down(p, c) {
      eye(p, 13); eye(p, 24);
      p.rect(17, 21, 22, 21, EYE, 'detail'); p.rect(18, 22, 21, 23, EYE, 'detail'); p.rect(19, 24, 20, 24, EYE, 'detail');
      p.rect(18, 21, 21, 21, WHITE, 'detail'); p.rect(19, 23, 20, 23, '#D9736A', 'detail');
      blush(p, c);
    },
    left(p, c) {
      p.rect(11, 15, 12, 18, EYE, 'detail'); p.put(11, 15, WHITE, 'detail');
      p.rect(8, 21, 11, 21, EYE, 'detail'); p.rect(8, 22, 10, 23, EYE, 'detail'); p.rect(9, 21, 10, 21, WHITE, 'detail');
      p.dots([[13, 20], [14, 20]], c.blush);
    },
  },
  face_shades_05: {
    down(p) {
      for (const x0 of [11, 22]) { p.rect(x0, 14, x0 + 6, 17, EYE, 'detail'); p.rect(x0 + 1, 18, x0 + 5, 18, EYE, 'detail'); }
      p.rect(18, 14, 21, 15, EYE, 'detail');
      p.dots([[12, 15], [13, 15], [12, 16], [23, 15], [24, 15], [23, 16]], '#7E8E99');
      p.dots([[18, 21], [19, 22], [20, 22], [21, 21]], EYE);
    },
    left(p) {
      p.rect(8, 14, 13, 18, EYE, 'detail'); p.rect(14, 15, 21, 15, EYE, 'detail');
      p.dots([[9, 15], [10, 15], [9, 16]], '#7E8E99'); p.dots([[9, 21], [10, 21]], EYE);
    },
  },
};

function paintHead(p, c, cfg, dir) {
  const hair = HAIR_PIXELS[cfg.head] ?? HAIR_PIXELS.head_short_01;
  const face = FACE_PIXELS[cfg.face] ?? FACE_PIXELS.face_smile_01;
  const side = dir === 'left';
  paintHeadBase(p, c, dir);
  hair[side ? 'left' : dir](p, c);
  // 五官畫在頭髮之後：瀏海不能蓋掉眼睛（眼睛是 Q 版角色最重要的部位）
  if (dir === 'down') face.down(p, c);
  if (side) face.left(p, c);
  // 側面的耳朵在頭髮之後補上，才會從髮間露出來
  if (side && hair.ear) {
    p.oval(22.5, 17.5, 2, 2.6, c.skin, 'ear');
    p.dots([[22, 17], [22, 18]], c.skinSh);
  }
  // 背面的耳朵從頭髮兩側露出
  if (dir === 'up' && hair.ear) {
    p.oval(8, 17.5, 1.8, 2.4, c.skin, 'ear');
    p.oval(32, 17.5, 1.8, 2.4, c.skin, 'ear');
  }
}

// ── 動作（揮手、乾杯）─────────────────────────────────────
const MUG = '#E8A33A';
const FOAM = '#FBF6EA';

/**
 * 舉起的那隻手。揮手與乾杯是「角色本身在做」的動作，而不是頭上多一個漂浮的圖：
 * 現場的人看大螢幕時，要一眼看出「那個人在跟我揮手」。
 *
 * pose 為 'wave1' / 'wave2' / 'cheers1' / 'cheers2'，兩格交替播放
 * （揮手：手掌左右擺；乾杯：酒杯上下碰）。畫在頭之後，手才不會被頭髮蓋住。
 */
function paintRaisedArm(p, c, dir, pose, sleeve) {
  const kind = pose.slice(0, -1);
  const step = Number(pose.slice(-1));
  // 離肩膀近的一段是袖子：長袖整隻、短袖只有肩頭、無袖全膚色
  const col = (y) => (sleeve === 'long' || (sleeve === 'short' && y >= 25) ? c.acc : c.skin);
  const arm = (list) => { for (const [y, x] of list) p.rect(x, y, x + 2, y, col(y), 'raised'); };
  const span = (y0, y1, xAt) => { const out = []; for (let y = y0; y <= y1; y++) out.push([y, xAt(y)]); return out; };
  const mug = (x0, y0) => {
    p.rect(x0, y0 + 2, x0 + 4, y0 + 7, MUG, 'mug');
    p.rect(x0, y0, x0 + 4, y0 + 1, FOAM, 'foam');
    p.dots([[x0 + 1, y0 - 1], [x0 + 3, y0 - 1]], FOAM, 'foam');
    p.dots([[x0 + 1, y0 + 3], [x0 + 1, y0 + 4]], mix(MUG, '#FFFFFF', 0.45));
  };

  if (dir === 'left') {
    // 側面的臉在左半邊，手不能從臉前面舉：揮手從後腦勺那側舉起，
    // 乾杯則把酒杯往前伸到臉的前方（鼻尖之外）
    if (kind === 'wave') {
      const lean = step === 1 ? 0 : 2;
      arm(span(12, 27, (y) => 21 + Math.round((27 - y) * 0.35) + (y < 18 ? lean : 0)));
      const hx = 26 + (step === 1 ? 0 : 2);
      p.rect(hx, 8, hx + 2, 11, c.skin, 'hand2');
      p.dots([[hx, 7], [hx + 2, 7]], c.skin, 'hand2');
    } else {
      const off = step === 2 ? 2 : 0;
      arm(span(24 - off, 28, (y) => 17 - Math.round((28 - y) * 2.2)));
      mug(1, 15 - off);
      p.rect(5, 22 - off, 7, 24 - off, c.skin, 'hand2');
    }
    return;
  }

  // 正面／背面：舉右側那隻手（畫面右邊），手臂向外撐開，不貼著臉
  if (kind === 'wave') {
    if (step === 1) {
      arm(span(18, 28, (y) => (y >= 27 ? 29 : y >= 24 ? 30 : 32)));
      p.rect(32, 14, 34, 17, c.skin, 'hand2'); p.dots([[32, 13], [34, 13]], c.skin, 'hand2');
    } else {
      arm(span(22, 28, (y) => (y >= 27 ? 29 : y >= 24 ? 30 : 32))); arm(span(18, 21, () => 33));
      p.rect(34, 14, 36, 17, c.skin, 'hand2'); p.dots([[34, 13], [36, 13]], c.skin, 'hand2');
    }
  } else {
    const off = step === 2 ? 2 : 0;
    arm(span(21 - off, 28, (y) => (y >= 26 ? 29 : y >= 23 - off ? 30 : 31)));
    mug(32, 11 - off);
    p.rect(31, 18 - off, 33, 20 - off, c.skin, 'hand2');
  }
}

/** 有專屬動作畫格的表情。其餘（愛心）仍用頭上的圖示。 */
export const PIXEL_POSES = { WAVE: 'wave', CHEERS: 'cheers' };

// ── 對外 ─────────────────────────────────────────────────
/**
 * 調色盤。colors 由呼叫端給定（捏臉的白名單色、或 CV 取樣色），
 * 陰影與高光都從它們推導，不另外存。
 */
export function pixelPalette({ skin, hair: hairIn, accent, pants = DEFAULT_PANTS }) {
  // 膚色與髮色太接近時把頭髮壓暗。最深的膚色 #5C3A21 與長髮預設的 #5B3A29
  // 幾乎同色，不處理的話臉與頭髮會糊成一塊，看不出髮型也看不出五官。
  const dist = Math.hypot(...parse(skin).map((v, i) => v - parse(hairIn)[i]));
  const hair = dist < 60 ? shade(hairIn, 0.55) : hairIn;
  return {
    skin, skinSh: shade(skin, 0.84), skinHi: mix(skin, '#FFFFFF', 0.4),
    blush: mix(skin, '#E86F6A', 0.45),
    hair, hairHi: mix(hair, '#FFFFFF', 0.32), hairSh: shade(hair, 0.72),
    band: mix(hair, '#FFFFFF', 0.22),
    acc: accent, accSh: shade(accent, 0.8), cuff: shade(accent, 0.68),
    pants, pantsSh: shade(pants, 0.75),
  };
}

/**
 * 產生一格畫面。
 *
 * @param {{head:string, face:string, body:string}} parts  模組 token
 * @param {object} pal     pixelPalette() 的結果
 * @param {'down'|'up'|'left'|'right'} dir
 * @param {0|1|2} frame
 * @param {string|null} pose  'wave1' / 'wave2' / 'cheers1' / 'cheers2'，見 paintRaisedArm
 * @returns {(string|null)[][]}  PIXEL_H 列 × PIXEL_W 欄，null 為透明
 */
export function pixelGrid(parts, pal, dir = 'down', frame = 0, pose = null) {
  const facing = dir === 'right' ? 'left' : dir;
  const p = canvas();
  const sleeve = paintBody(p, pal, parts.body, facing, frame, pose);
  paintHead(p, pal, parts, facing);
  if (pose) paintRaisedArm(p, pal, facing, pose, sleeve);
  const g = outline(shadeEdges(p));
  return dir === 'right' ? mirror(g) : g;
}

/**
 * 把格子輸出成 SVG。同一列相鄰的同色格合併成一個 rect，數量約減到三分之一。
 * shape-rendering="crispEdges" 讓縮放時不出現反鋸齒的毛邊。
 */
export function gridToSVG(grid, { width = 200, height = 270, unit = 5 } = {}) {
  const rects = [];
  for (let y = 0; y < grid.length; y++) {
    const r = grid[y];
    for (let x = 0; x < r.length;) {
      const c = r[x];
      let end = x + 1;
      while (end < r.length && r[end] === c) end++;
      if (c) rects.push(`<rect x="${x * unit}" y="${y * unit}" width="${(end - x) * unit}" height="${unit}" fill="${c}"/>`);
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIXEL_W * unit} ${PIXEL_H * unit}"
    width="${width}" height="${height}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

/**
 * 依朝向角選四方向之一，帶遲滯：離目前方向的中心不超過 45° + HYSTERESIS 就維持不變。
 * heading 定義同伺服器：atan2(vy, vx)，邏輯平面 y 向下 —— π/2 是面向觀眾。
 * 沒有遲滯的話，斜向移動會在兩個方向之間逐幀跳動。
 */
const HYSTERESIS = (12 * Math.PI) / 180;
const DIR_CENTER = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
export function dirFromHeading(heading, prev = null) {
  if (!Number.isFinite(heading)) return prev ?? 'down';
  const diff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  if (prev && diff(heading, DIR_CENTER[prev]) <= Math.PI / 4 + HYSTERESIS) return prev;
  let best = 'down';
  for (const d of PIXEL_DIRS) if (diff(heading, DIR_CENTER[d]) < diff(heading, DIR_CENTER[best])) best = d;
  return best;
}
