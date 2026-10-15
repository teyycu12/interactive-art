/**
 * 像素角色 —— 捏臉角色的唯一畫法（大螢幕、手機 POV、捏臉預覽、主辦端縮圖共用）。
 *
 * 畫風是動畫感的 Q 版像素角色：頭約佔身高一半、蓬鬆的頭髮帶瀏海與鬢髮、
 * 有虹膜色與反光的大眼睛、細小的身體與四肢、深色外框。與大螢幕場景一樣全部
 * 程序繪製，沒有任何圖片檔或 CDN 依賴。
 *
 * 每個角色有四個方向 × 三格步態：
 *   down（面向觀眾）/ up（背面）/ left / right —— right 是 left 的水平鏡像
 *   frame 0 站立、1 與 2 為左右腳交替跨出
 *
 * 輸出是純資料（二維顏色陣列），不碰 DOM：SVG 與 canvas 兩種輸出都從同一份
 * 格子產生，node 測試也能直接驗。
 *
 * ── 畫法 ──
 * 每個部位以幾何形狀畫進格子，並記下它屬於哪個部位。畫的順序：
 *   後髮（長髮會垂在身體後面）→ 身體 → 臉 → 前髮（瀏海、鬢髮）→ 五官
 * 全部畫完後跑兩道後製：
 *   1. 明暗：部位的右緣與下緣各暗一格 —— 光從左上來，不必逐格手繪陰影。
 *   2. 外框：輪廓外圍一圈深色。
 *
 * 座標（40 × 54，設計座標整體下移 DY 格，讓丸子頭與毛球上方仍有空間畫外框）：
 *   頭髮 y 1–27、臉 y 6–26（頭約佔身高 55%）、身體 y 27–38、腿 y 39–44、鞋 y 45–47。
 *   身體只有頭寬的四成（x 14–25）—— 大頭細身才是動畫 Q 版的比例。
 *   左右以 x = 19.5 為中線，鏡像公式為 x' = 39 − x。
 */

export const PIXEL_W = 40;
export const PIXEL_H = 54;
const DY = 5;

export const PIXEL_DIRS = ['down', 'up', 'left', 'right'];
export const PIXEL_FRAMES = 3;

/** 外框色。接近黑但帶一點暖，與參考的動畫像素角色一致。 */
export const OUTLINE = '#2A1E1C';
const LASH = '#221815';
const PUPIL = '#2B1F1D';
const WHITE = '#FFFDF7';
const MOUTH = '#8A3F3A';
const LENS = '#DCEBF0';
const FRAME = '#4E3B33';
const SHOE = '#4A3A36';
const SOLE = '#EDE6DA';
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
  /** 左右對稱的矩形：只給左半邊 */
  const symRect = (x0, y0, x1, y1, c, p) => { rect(x0, y0, x1, y1, c, p); rect(39 - x1, y0, 39 - x0, y1, c, p); };
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
  const symRows = (list, c, p) => { for (const [y, x0, x1] of list) symRect(x0, y, x1, y, c, p); };
  return { col, part, put, clear, rect, symRect, oval, dots, sym, rows, symRows };
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
 * 正面／背面的腿。frame 1 抬左腳、frame 2 抬右腳（抬起那隻短一格、鞋子跟著上移）。
 * 洋裝的腿是膚色、較細，從裙襬下方才露出來。
 */
function legsFrontBack(p, c, frame, bare) {
  if (!bare) p.rect(14, 38, 25, 38, c.pants, 'pants');
  for (const [side, x0, x1] of [[1, 15, 18], [2, 21, 24]]) {
    const lift = frame === side ? 1 : 0;
    const lx0 = bare ? x0 + 1 : x0, lx1 = bare ? x1 - 1 : x1;
    p.rect(lx0, bare ? 42 : 39, lx1, 44 - lift, bare ? c.skin : c.pants, bare ? 'skin' : 'pants');
    if (bare) p.rect(lx0, 44 - lift, lx1, 44 - lift, WHITE, 'sock');
    const sx0 = side === 1 ? x0 - 1 : x0, sx1 = side === 1 ? x1 : x1 + 1;
    p.rect(sx0, 45 - lift, sx1, 46 - lift, SHOE, 'shoe');
    p.rect(sx0, 47 - lift, sx1, 47 - lift, SOLE, 'sole');
    p.clear(side === 1 ? sx0 : sx1, 45 - lift);   // 鞋頭圓角
  }
}

/** 側面的腿（面向左）。跨步時近側腿用原色、遠側腿用暗色，才分得出哪隻在前。 */
function legsSide(p, c, frame, bare) {
  const near = bare ? c.skin : c.pants;
  const far = bare ? c.skinSh : c.pantsSh;
  const top = bare ? 42 : 39;
  const leg = (x0, w, slope, color) => {
    for (let y = top; y <= 44; y++) {
      const dx = Math.round((y - 39) * slope);
      p.rect(x0 + dx, y, x0 + dx + w - 1, y, color, color === near ? 'pants' : 'pantsFar');
    }
    const fx = x0 + Math.round(5 * slope);
    if (bare) p.rect(fx, 44, fx + w - 1, 44, WHITE, 'sock');
    p.rect(fx - 2, 45, fx + w - 1, 46, SHOE, 'shoe');
    p.rect(fx - 2, 47, fx + w - 1, 47, SOLE, 'sole');
  };
  const w = bare ? 3 : 4;
  if (!bare) p.rect(16, 38, 23, 38, near, 'pants');
  if (frame === 0) { leg(bare ? 18 : 18, w, 0, near); return; }
  // 後腳先畫，前腳蓋在上面
  const [front, back] = frame === 1 ? [near, far] : [far, near];
  leg(bare ? 19 : 19, w, 0.5, back);
  leg(bare ? 17 : 17, w, -0.5, front);
}

/** 正面／背面的手臂（兩格寬的細手臂）。sleeve：'long' 整隻衣袖、'short' 只到上臂、'bare' 全膚色 */
function armsFrontBack(p, c, frame, sleeve, raised = false) {
  for (const [side, x0, x1] of [[1, 12, 13], [2, 26, 27]]) {
    if (raised && side === 2) continue;       // 舉起的那隻手在頭畫完之後才畫（見 paintRaisedArm）
    // 抬左腳時擺右手，反之亦然：整隻手縮上來一格
    const swing = (frame === 1 && side === 2) || (frame === 2 && side === 1) ? 1 : 0;
    const bottom = 35 - swing;
    for (let y = 29; y <= bottom; y++) {
      const cloth = sleeve === 'long' || (sleeve === 'short' && y <= 31);
      p.rect(x0, y, x1, y, cloth ? c.acc : c.skin, cloth ? 'arm' : 'armSkin');
    }
    if (sleeve === 'long') p.rect(x0, bottom, x1, bottom, c.cuff, 'cuff');
    p.rect(x0, bottom + 1, x1, bottom + 2, c.skin, 'hand');
  }
}

/** 側面手臂：蓋在軀幹上，跨步時前後擺 */
function armSide(p, c, frame, sleeve) {
  const dx = frame === 1 ? -2 : frame === 2 ? 2 : 0;
  for (let y = 29; y <= 35; y++) {
    const k = y <= 31 ? 0 : Math.round(((y - 31) / 4) * dx);
    const cloth = sleeve === 'long' || (sleeve === 'short' && y <= 31);
    p.rect(18 + k, y, 20 + k, y, cloth ? c.accSh : c.skin, cloth ? 'arm' : 'armSkin');
  }
  if (sleeve === 'long') p.rect(18 + dx, 35, 20 + dx, 35, c.cuff, 'cuff');
  p.rect(18 + dx, 36, 20 + dx, 37, c.skin, 'hand');
}

// ── 服裝 ─────────────────────────────────────────────────
/**
 * 每種服裝各自描述正面、背面、側面的細節；軀幹、手臂與腿的共用骨架在上面。
 * dress 的軀幹較短、下接裙襬，腿改為膚色配白襪。
 */
const BODY_PIXELS = {
  body_tee_01: {
    sleeve: 'short',
    down(p, c) { p.rows([[28, 18, 21], [29, 19, 20]], c.skin, 'neck'); },
    up() {},
    left(p, c) { p.rect(16, 28, 16, 29, c.skin, 'neck'); },
  },
  body_hoodie_01: {
    sleeve: 'long',
    down(p, c) {
      p.rows([[28, 15, 24]], c.accSh, 'hood');
      p.rect(18, 28, 21, 28, c.skin, 'neck');
      p.dots([[17, 29], [17, 30], [17, 31], [22, 29], [22, 30], [22, 31]], WHITE);
      p.rect(16, 34, 23, 34, c.cuff, 'detail');
      p.dots([[16, 35], [16, 36], [23, 35], [23, 36]], c.cuff);
    },
    up(p, c) { p.oval(20, 30, 5.5, 3, c.accSh, 'hood'); },
    left(p, c) { p.oval(23, 29.5, 3, 2.5, c.accSh, 'hood'); p.rect(16, 28, 16, 28, c.skin, 'neck'); },
  },
  body_shirt_02: {
    sleeve: 'long',
    down(p, c) {
      p.sym([[16, 28], [17, 28], [18, 28], [17, 29], [18, 29]], WHITE);
      p.rect(19, 28, 20, 28, c.skin, 'neck');
      p.rect(19, 30, 20, 37, c.accSh, 'detail');
      p.dots([[19, 31], [19, 34], [19, 37]], WHITE);
    },
    up(p) { p.rect(16, 28, 23, 28, WHITE, 'detail'); },
    left(p) { p.dots([[16, 28], [17, 28], [16, 29]], WHITE); },
  },
  body_dress_03: {
    sleeve: 'bare', dress: true,
    down(p, c) {
      p.rows([[28, 18, 21], [29, 19, 20]], c.skin, 'neck');
      p.rect(14, 32, 25, 32, c.cuff, 'detail');
      p.sym([[18, 33], [19, 33], [19, 34]], c.cuff);   // 腰間蝴蝶結
    },
    up(p, c) { p.rect(14, 32, 25, 32, c.cuff, 'detail'); p.sym([[18, 33], [18, 34]], c.cuff); },
    left(p, c) { p.rect(16, 28, 16, 29, c.skin, 'neck'); p.rect(16, 32, 23, 32, c.cuff, 'detail'); },
  },
  body_jacket_04: {
    sleeve: 'long',
    down(p, c) {
      p.rect(17, 28, 22, 37, WHITE, 'inner');
      p.rect(18, 28, 21, 28, c.skin, 'neck');
      p.sym([[16, 28], [16, 29], [17, 30], [16, 30], [16, 31]], c.accSh);
      p.sym([[14, 34], [15, 34]], c.accSh);
    },
    up(p, c) { p.rect(19, 30, 20, 37, c.accSh, 'detail'); },
    left(p) { p.rect(16, 29, 16, 37, WHITE, 'inner'); },
  },
  body_tank_05: {
    sleeve: 'bare',
    down(p, c) { p.rect(14, 28, 25, 29, c.skin, 'neck'); p.rect(16, 28, 16, 29, c.acc, 'cloth'); p.rect(23, 28, 23, 29, c.acc, 'cloth'); },
    up(p, c) { p.rect(14, 28, 25, 28, c.skin, 'neck'); p.rect(16, 28, 16, 28, c.acc, 'cloth'); p.rect(23, 28, 23, 28, c.acc, 'cloth'); },
    left(p, c) { p.rect(16, 28, 23, 28, c.skin, 'neck'); p.rect(20, 28, 20, 28, c.acc, 'cloth'); },
  },
};

function paintBody(p, c, body, dir, frame, pose = null) {
  const spec = BODY_PIXELS[body] ?? BODY_PIXELS.body_tee_01;
  const side = dir === 'left';
  const bare = !!spec.dress;

  if (side) legsSide(p, c, frame, bare);
  else legsFrontBack(p, c, frame, bare);

  // 脖子與軀幹：肩膀一列稍窄，做出圓肩
  const [x0, x1] = side ? [15, 24] : [14, 25];
  p.rect(side ? 15 : 18, 27, side ? 18 : 21, 27, c.skin, 'neck');
  const bottom = bare ? 32 : 37;
  p.rect(x0 + 1, 28, x1 - 1, 28, c.acc, 'cloth');
  p.rect(x0, 29, x1, bottom, c.acc, 'cloth');
  if (bare) {
    // 裙襬往下張開
    for (let y = 33; y <= 41; y++) {
      const spread = Math.round((y - 33) * 0.4);
      p.rect(x0 - spread, y, x1 + spread, y, y === 41 ? c.accSh : c.acc, 'skirt');
    }
  }
  spec[side ? 'left' : dir](p, c);

  if (side) { if (!pose) armSide(p, c, frame, spec.sleeve); }
  else armsFrontBack(p, c, frame, spec.sleeve, !!pose);
  return spec.sleeve;
}

// ── 頭 ───────────────────────────────────────────────────
/** 臉。側面時臉往前（左）偏一點，多一格鼻尖。 */
function paintFaceBase(p, c, dir) {
  if (dir === 'left') {
    p.oval(16, 17.5, 8.2, 9, c.skin, 'skin');
    p.put(7, 19, c.skin, 'skin');
  } else {
    p.oval(20, 17, 10.3, 9.5, c.skin, 'skin');
  }
}

/** 耳朵：短髮、光頭、毛帽時才看得到 */
function ears(p, c, dir) {
  if (dir === 'left') { p.oval(21, 18, 1.6, 2.3, c.skin, 'ear'); p.dots([[21, 17], [21, 18]], c.skinSh); return; }
  p.oval(9, 17.5, 1.6, 2.2, c.skin, 'ear');
  p.oval(31, 17.5, 1.6, 2.2, c.skin, 'ear');
}

/** 整顆頭的後髮量（蓬鬆的外輪廓），畫在臉後面 */
const SIDE_SKULL = [20.5, 14.5, 11.8, 12.5];
const mass = (p, c, dir, color = c.hair) => (dir === 'left'
  ? p.oval(...SIDE_SKULL, color, 'hair', (x, y) => y <= 22 || x >= 21)
  : p.oval(20, 14, 13.5, 13, color, 'hair'));
/** 頭頂：蓋住臉的上緣 */
const dome = (p, c, dir, maxY = 12, color = c.hair) => (dir === 'left'
  ? p.oval(...SIDE_SKULL, color, 'hair', (x, y) => y <= maxY)
  : p.oval(20, 14, 13.5, 13, color, 'hair', (x, y) => y <= maxY));
/** 天使光圈：動畫頭髮的招牌高光 */
const halo = (p, c, dir) => (dir === 'left'
  ? p.dots([[11, 8], [12, 7], [13, 6], [14, 6], [15, 5], [16, 5], [17, 5], [18, 5]], c.hairHi)
  : p.dots([[10, 8], [11, 7], [12, 6], [13, 6], [14, 5], [15, 5], [16, 5],
    [23, 5], [24, 5], [25, 5], [26, 6], [27, 6], [28, 7], [29, 8]], c.hairHi));
/** 髮流：幾道暗線 */
const strands = (p, c, pts) => p.dots(pts, c.hairSh);

/**
 * 瀏海：每欄從 y 13 往下長 len 格，厚厚蓋住額頭、髮尾參差地垂到眼睛上緣。
 * 眼睛那幾欄（x 13–16、23–26）停在睫毛上方一格 —— 眼睛是動畫角色表情的全部，
 * 兩眼之間與兩側的髮束可以更長。額頭露太多會像戴了一頂安全帽。
 */
const BANGS = [9, 7, 5, 3, 2, 2, 1, 2, 3, 3, 2, 1, 3, 3, 2, 1, 2, 2, 3, 5, 7, 9];
const bangs = (p, c, lens = BANGS) => {
  lens.forEach((len, i) => p.rect(9 + i, 13, 9 + i, 12 + len, c.hair, 'hair'));
  // 髮束之間的暗線與幾道亮色髮光：瀏海才看得出是一束一束的
  strands(p, c, [[12, 13], [12, 14], [17, 13], [17, 14], [22, 13], [22, 14], [27, 13], [27, 14]]);
  p.dots([[14, 13], [19, 13], [20, 13], [25, 13]], c.hairHi);
};
/** 側面的瀏海（面向左，只有額頭前段） */
const sideBangs = (p, c, lens = [7, 5, 3, 2, 2, 3, 3, 2]) => lens.forEach((len, i) => p.rect(9 + i, 13, 9 + i, 12 + len, c.hair, 'hair'));
/**
 * 側面的後髮：從頭頂往後腦勺的弧線，前緣在耳前垂下一束鬢髮。
 * 直接用一條垂直線切開臉與頭髮，看起來像半邊戴了安全帽。
 */
const sideHair = (p, c, lockBottom) => {
  // 耳朵以後都是頭髮，後腦勺沿著頭型收到頸背；耳前一小束鬢角
  p.oval(...SIDE_SKULL, c.hair, 'hair', (x, y) => (x >= 20 && y <= 24) || y <= 12);
  p.rect(18, 13, 19, lockBottom - 1, c.hair, 'hair');
  p.rows([[lockBottom, 19, 19]], c.hair, 'hair');
};

/** 臉頰兩側垂下的鬢髮，末端收尖 */
const locks = (p, c, bottom = 25, color = c.hair) => {
  p.symRect(6, 12, 9, bottom - 2, color, 'hair');
  p.symRows([[bottom - 1, 7, 9], [bottom, 8, 9]], color, 'hair');
};

/**
 * 髮型。每種各有正面、背面、側面（面向左）三個版本，各分兩層：
 *   back —— 畫在身體之前（長髮垂在身後、後腦的髮量）
 *   over —— 畫在臉之後（瀏海、鬢髮、帽子）
 * 毛帽的 hair 欄位是帽子顏色，帽簷下露出的頭髮固定用深棕。
 */
const HAIR_PIXELS = {
  head_short_01: {
    back: (p, c, dir) => mass(p, c, dir),
    down(p, c) {
      dome(p, c, 'down'); bangs(p, c); locks(p, c, 22);
      strands(p, c, [[18, 4], [19, 5], [19, 6], [24, 9], [15, 9]]); halo(p, c, 'down');
    },
    up(p, c) {
      mass(p, c, 'up');
      strands(p, c, [[20, 6], [20, 7], [15, 13], [15, 14], [25, 13], [25, 14], [20, 20], [20, 21]]);
      halo(p, c, 'up');
    },
    left(p, c) {
      dome(p, c, 'left'); sideBangs(p, c, [3, 2, 2, 2, 2, 1, 2, 2]); sideHair(p, c, 17);
      strands(p, c, [[25, 9], [26, 10], [27, 16], [28, 17]]); halo(p, c, 'left');
    },
    ear: true,
  },
  head_curly_02: {
    back(p, c, dir) {
      mass(p, c, dir);
      const pts = dir === 'left'
        ? [[12, 5, 3.2], [17, 3, 3.2], [23, 3, 3.2], [28, 5, 3.2], [31, 10, 3], [32, 16, 2.8], [30, 21, 2.8]]
        : [[10, 6, 3.4], [15, 3, 3.4], [20, 2.4, 3.4], [25, 3, 3.4], [30, 6, 3.4],
          [7, 11, 3], [33, 11, 3], [6.5, 17, 3], [33.5, 17, 3], [8, 23, 3], [32, 23, 3]];
      for (const [x, y, r] of pts) p.oval(x, y, r, r, c.hair, 'hair');
    },
    down(p, c) {
      dome(p, c, 'down', 10);
      for (const [x, y, r] of [[10.5, 12, 2.6], [14.5, 11, 2.4], [19.5, 11.5, 2.6], [24.5, 11, 2.4], [28.5, 12, 2.6],
        [8, 16, 2.4], [31, 16, 2.4], [8, 20, 2.2], [31, 20, 2.2]]) p.oval(x, y, r, r, c.hair, 'hair');
      p.dots([[10, 4], [15, 1], [20, 1], [25, 1], [30, 4], [13, 9], [18, 9], [23, 9]], c.hairHi);
      strands(p, c, [[12, 7], [17, 6], [22, 6], [27, 7]]);
    },
    up(p, c) {
      mass(p, c, 'up');
      for (const [x, y, r] of [[13, 22, 3], [20, 24, 3], [27, 22, 3]]) p.oval(x, y, r, r, c.hair, 'hair');
      p.dots([[10, 4], [15, 1], [20, 1], [25, 1], [30, 4]], c.hairHi);
      strands(p, c, [[15, 10], [20, 9], [25, 10], [17, 16], [23, 16]]);
    },
    left(p, c) {
      dome(p, c, 'left', 10);
      for (const [x, y, r] of [[10.5, 12, 2.6], [14.5, 11, 2.4], [18.5, 11.5, 2.4]]) p.oval(x, y, r, r, c.hair, 'hair');
      p.oval(25, 15, 8, 10, c.hair, 'hair', (x) => x >= 21);
      p.dots([[12, 3], [17, 1], [23, 1], [28, 3], [13, 9]], c.hairHi);
      strands(p, c, [[25, 9], [28, 14], [27, 20]]);
    },
    ear: false,
  },
  head_bun_03: {
    back(p, c, dir) {
      mass(p, c, dir);
      if (dir === 'left') p.oval(28, 2.5, 4, 3.5, c.hair, 'bun');
      else p.oval(20, 1, 4.2, 3.4, c.hair, 'bun');
    },
    down(p, c) {
      dome(p, c, 'down');
      bangs(p, c, [5, 4, 3, 2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 2, 2, 1, 1, 1, 2, 3, 4, 5]);
      locks(p, c, 21);
      p.rect(19, -1, 20, -1, c.hairHi, 'detail');
      strands(p, c, [[16, 5], [17, 7], [23, 5], [22, 7]]); halo(p, c, 'down');
    },
    up(p, c) {
      mass(p, c, 'up');
      p.oval(20, 1, 4.2, 3.4, c.hair, 'bun');
      strands(p, c, [[16, 8], [17, 11], [23, 8], [22, 11], [20, 16]]); halo(p, c, 'up');
    },
    left(p, c) {
      dome(p, c, 'left'); sideBangs(p, c, [2, 2, 2, 1, 1, 1, 2, 2]); sideHair(p, c, 16);
      strands(p, c, [[24, 9], [26, 12], [27, 16]]); halo(p, c, 'left');
    },
    ear: true,
  },
  head_long_04: {
    back(p, c, dir) {
      mass(p, c, dir);
      if (dir === 'left') {
        p.rect(20, 14, 31, 37, c.hair, 'hair'); p.rows([[38, 21, 30], [39, 23, 29]], c.hair, 'hair');
      } else {
        p.rect(7, 14, 32, 38, c.hair, 'hair'); p.rows([[39, 8, 31], [40, 9, 13], [40, 26, 30]], c.hair, 'hair');
      }
    },
    down(p, c) {
      dome(p, c, 'down'); bangs(p, c); locks(p, c, 34);
      strands(p, c, [[8, 20], [8, 21], [8, 27], [31, 20], [31, 21], [31, 27], [19, 4], [19, 5], [20, 6]]);
      halo(p, c, 'down');
    },
    up(p, c) {
      mass(p, c, 'up');
      strands(p, c, [[14, 17], [14, 18], [14, 27], [14, 28], [20, 11], [20, 12], [20, 24], [20, 25], [26, 17], [26, 18], [26, 30]]);
      halo(p, c, 'up');
    },
    left(p, c) {
      dome(p, c, 'left'); sideBangs(p, c, [3, 2, 2, 2, 2, 2, 3, 3]); sideHair(p, c, 26);
      strands(p, c, [[25, 20], [25, 21], [28, 28], [28, 29]]); halo(p, c, 'left');
    },
    ear: false,
  },
  head_cap_05: {
    back: (p, c, dir) => mass(p, c, dir, CAP_HAIR),
    down(p, c) {
      locks(p, c, 21, CAP_HAIR);
      p.oval(20, 11, 13.5, 11, c.hair, 'hair', (x, y) => y <= 9);
      p.rect(6, 9, 33, 12, c.band, 'band');
      for (let x = 7; x <= 32; x += 2) p.rect(x, 10, x, 12, shade(c.band, 0.86), 'detail');
      p.oval(20, 0.5, 2.8, 2.2, mix(c.hair, '#FFFFFF', 0.35), 'pom');
      p.dots([[12, 4], [13, 3], [14, 3]], c.hairHi);
    },
    up(p, c) {
      mass(p, c, 'up', CAP_HAIR);
      p.oval(20, 11, 13.5, 11, c.hair, 'hair', (x, y) => y <= 9);
      p.rect(6, 9, 33, 12, c.band, 'band');
      for (let x = 7; x <= 32; x += 2) p.rect(x, 10, x, 12, shade(c.band, 0.86), 'detail');
      p.oval(20, 0.5, 2.8, 2.2, mix(c.hair, '#FFFFFF', 0.35), 'pom');
    },
    left(p, c) {
      p.oval(20.5, 11, 12.5, 11, c.hair, 'hair', (x, y) => y <= 9);
      p.rect(8, 9, 32, 12, c.band, 'band');
      for (let x = 9; x <= 31; x += 2) p.rect(x, 10, x, 12, shade(c.band, 0.86), 'detail');
      p.oval(22, 0.5, 2.8, 2.2, mix(c.hair, '#FFFFFF', 0.35), 'pom');
      p.dots([[13, 4], [14, 3], [15, 3]], c.hairHi);
    },
    ear: true,
  },
  head_bald_06: {
    back() {},
    down(p, c) { p.dots([[13, 8], [14, 7], [15, 7], [13, 9]], c.skinHi); },
    up(p, c) { p.dots([[14, 8], [15, 7], [16, 7], [14, 9]], c.skinHi); },
    left(p, c) { p.dots([[15, 8], [16, 7], [17, 7], [15, 9]], c.skinHi); },
    ear: true,
  },
};

/**
 * 一隻動畫大眼（4 × 7）：上緣睫毛、深色瞳孔、虹膜色往下漸亮、左上兩格反光。
 * outer = 外眼角那一側（-1 左、+1 右），睫毛往那邊多拖一格。
 * 兩眼之間只隔約一個眼寬 —— 隔太開會像在發呆，參考的動畫角色都是這個距離。
 */
function eye(p, c, x, outer, w = 4) {
  const r = x + w - 1;
  p.rect(x, 15, r, 15, LASH, 'detail');
  p.put(outer < 0 ? x - 1 : r + 1, 15, LASH, 'detail');
  p.rect(x, 16, r, 16, PUPIL, 'detail');
  p.rect(x, 17, r, 18, c.iris, 'detail');
  p.rect(x + 1, 17, r - 1, 17, PUPIL, 'detail');
  p.rect(x, 19, r, 19, c.irisHi, 'detail');
  p.rect(x + 1, 20, r - (w > 3 ? 1 : 0), 20, c.irisHi, 'detail');
  p.dots([[x, 16], [x, 17]], WHITE);
  p.put(r, 19, WHITE, 'detail');
}
/** 閉眼的弧線（笑眼、眨眼） */
const closedEye = (p, x, up = true) => p.dots(up
  ? [[x, 19], [x + 1, 18], [x + 2, 18], [x + 3, 19]]
  : [[x, 18], [x + 1, 19], [x + 2, 19], [x + 3, 18]], LASH);
const smile = (p) => p.dots([[19, 23], [20, 23]], MOUTH);
const blush = (p, c) => p.symRows([[21, 10, 11]], c.blush, 'detail');
const sideEye = (p, c) => eye(p, c, 10, 1, 3);
const sideMouth = (p) => p.dots([[9, 23]], '#B0786A');
const sideBlush = (p, c) => p.dots([[13, 21], [14, 21]], c.blush);

/** 表情。背面看不到臉，所以只有正面與側面（面向左）。 */
const FACE_PIXELS = {
  face_smile_01: {
    down(p, c) { eye(p, c, 13, -1); eye(p, c, 23, 1); smile(p); blush(p, c); },
    left(p, c) { sideEye(p, c); sideMouth(p); sideBlush(p, c); },
  },
  face_smile_glasses: {
    down(p, c) {
      for (const x0 of [12, 22]) p.rect(x0, 14, x0 + 5, 21, mix(c.skin, LENS, 0.4), 'detail');
      eye(p, c, 13, -1); eye(p, c, 23, 1);
      for (const x0 of [12, 22]) {
        p.rect(x0, 14, x0 + 5, 14, FRAME, 'detail'); p.rect(x0, 21, x0 + 5, 21, FRAME, 'detail');
        p.rect(x0, 15, x0, 20, FRAME, 'detail'); p.rect(x0 + 5, 15, x0 + 5, 20, FRAME, 'detail');
      }
      p.rect(18, 17, 21, 17, FRAME, 'detail');
      smile(p); p.symRows([[22, 10, 11]], c.blush, 'detail');
    },
    left(p, c) {
      p.rect(9, 14, 13, 21, mix(c.skin, LENS, 0.4), 'detail');
      sideEye(p, c);
      p.rect(9, 14, 13, 14, FRAME, 'detail'); p.rect(9, 21, 13, 21, FRAME, 'detail');
      p.rect(9, 15, 9, 20, FRAME, 'detail'); p.rect(13, 15, 13, 20, FRAME, 'detail');
      p.rect(14, 17, 18, 17, FRAME, 'detail');
      sideMouth(p); p.dots([[14, 22], [15, 22]], c.blush);
    },
  },
  face_wink_02: {
    down(p, c) { eye(p, c, 13, -1); closedEye(p, 23); p.put(27, 18, LASH, 'detail'); smile(p); blush(p, c); },
    left(p, c) { sideEye(p, c); sideMouth(p); sideBlush(p, c); },
  },
  face_calm_03: {
    down(p, c) { closedEye(p, 13, false); closedEye(p, 23, false); p.dots([[19, 23], [20, 23]], MOUTH); blush(p, c); },
    left(p, c) { p.dots([[10, 18], [11, 19], [12, 19], [13, 18]], LASH); p.put(10, 23, MOUTH, 'detail'); sideBlush(p, c); },
  },
  face_grin_04: {
    down(p, c) {
      eye(p, c, 13, -1); eye(p, c, 23, 1);
      p.rect(18, 22, 21, 22, MOUTH, 'detail'); p.rect(18, 23, 21, 24, MOUTH, 'detail');
      p.rect(18, 22, 21, 22, WHITE, 'detail'); p.rect(19, 24, 20, 24, '#E0837A', 'detail');
      blush(p, c);
    },
    left(p, c) {
      sideEye(p, c);
      p.rect(8, 22, 11, 22, MOUTH, 'detail'); p.rect(8, 23, 10, 24, MOUTH, 'detail'); p.rect(9, 22, 10, 22, WHITE, 'detail');
      sideBlush(p, c);
    },
  },
  face_shades_05: {
    down(p) {
      for (const x0 of [12, 22]) { p.rect(x0, 16, x0 + 5, 20, PUPIL, 'detail'); p.rect(x0 + 1, 21, x0 + 4, 21, PUPIL, 'detail'); }
      p.rect(18, 17, 21, 17, PUPIL, 'detail');
      p.dots([[13, 17], [14, 17], [13, 18], [23, 17], [24, 17], [23, 18]], '#8FA3B0');
      p.dots([[19, 23], [20, 23]], MOUTH);
    },
    left(p) {
      p.rect(9, 16, 13, 20, PUPIL, 'detail'); p.rect(10, 21, 12, 21, PUPIL, 'detail'); p.rect(14, 17, 18, 17, PUPIL, 'detail');
      p.dots([[10, 17], [11, 17], [10, 18]], '#8FA3B0'); sideMouth(p);
    },
  },
};

/** 瀏海正下方那一格膚色壓暗：參考的動畫角色都有這道影子，少了它臉像貼上去的 */
function bangShadow(p, c) {
  for (let x = 8; x <= 31; x++) {
    for (let y = 12; y <= 22; y++) {
      const yy = y + DY;
      if (p.part[yy][x] === 'hair' && p.part[yy + 1][x] === 'skin') { p.put(x, y + 1, c.skinSh, 'skinShade'); break; }
    }
  }
}

function paintHead(p, c, cfg, dir) {
  const hair = HAIR_PIXELS[cfg.head] ?? HAIR_PIXELS.head_short_01;
  const face = FACE_PIXELS[cfg.face] ?? FACE_PIXELS.face_smile_01;
  const side = dir === 'left';
  if (hair.ear && !side) ears(p, c, dir);
  paintFaceBase(p, c, dir);
  hair[side ? 'left' : dir](p, c);
  if (dir !== 'up') bangShadow(p, c);
  // 五官畫在頭髮之後：瀏海不能蓋掉眼睛
  if (dir === 'down') face.down(p, c);
  if (side) face.left(p, c);
  // 側面的耳朵在頭髮之後補上，才會從髮間露出來
  if (side && hair.ear) ears(p, c, 'left');
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
 * 頭很大，所以手要舉到頭髮輪廓之外（x ≥ 34）才看得見。
 */
function paintRaisedArm(p, c, dir, pose, sleeve) {
  const kind = pose.slice(0, -1);
  const step = Number(pose.slice(-1));
  // 離肩膀近的一段是袖子：長袖整隻、短袖只有肩頭、無袖全膚色
  const col = (y) => (sleeve === 'long' || (sleeve === 'short' && y >= 27) ? c.acc : c.skin);
  const arm = (list) => { for (const [y, x] of list) p.rect(x, y, x + 1, y, col(y), 'raised'); };
  const span = (y0, y1, xAt) => { const out = []; for (let y = y0; y <= y1; y++) out.push([y, xAt(y)]); return out; };
  const hand = (x, y) => { p.rect(x, y, x + 2, y + 2, c.skin, 'hand2'); p.dots([[x, y - 1], [x + 2, y - 1]], c.skin, 'hand2'); };
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
      const lean = step === 1 ? 0 : 1;
      arm(span(13, 29, (y) => 20 + Math.round((29 - y) * 0.85) + (y < 18 ? lean : 0)));
      hand(35 + lean, 9);
    } else {
      const off = step === 2 ? 2 : 0;
      arm(span(23 - off, 29, (y) => 17 - Math.round((29 - y) * 1.5)));
      mug(1, 13 - off);
      p.rect(5, 21 - off, 7, 23 - off, c.skin, 'hand2');
    }
    return;
  }

  // 正面／背面：舉右側那隻手（畫面右邊），手臂向外撐開，不貼著臉
  if (kind === 'wave') {
    const lean = step === 1 ? 0 : 1;
    arm(span(19, 29, (y) => (y >= 28 ? 26 : y >= 25 ? 28 : y >= 22 ? 30 : 32 + (y < 21 ? lean : 0))));
    hand(34 + lean, 15);
  } else {
    const off = step === 2 ? 2 : 0;
    arm(span(21 - off, 29, (y) => (y >= 28 ? 26 : y >= 25 ? 28 : 30)));
    mug(33, 11 - off);
    p.rect(31, 18 - off, 33, 20 - off, c.skin, 'hand2');
  }
}

/** 有專屬動作畫格的表情 */
export const PIXEL_POSES = { WAVE: 'wave', CHEERS: 'cheers' };

// ── 對外 ─────────────────────────────────────────────────
/**
 * 動畫眼色（虹膜、下半的亮色）。依代表色的色相挑一組，而不是直接拿代表色：
 * 代表色是紅或橘時眼睛會變成紅眼，看起來像生氣或生病。
 * 紅、橘、黃一律落在琥珀／棕，灰色（無彩度）也是棕。
 */
const EYE_SETS = [
  { hue: 30, iris: '#8A5220', hi: '#D9973F' },    // 琥珀（紅橘黃）
  { hue: 105, iris: '#3F7A3A', hi: '#86C46E' },   // 綠
  { hue: 170, iris: '#1F7A74', hi: '#5CC7BB' },   // 青
  { hue: 212, iris: '#2F5E9A', hi: '#78AEE6' },   // 藍
  { hue: 285, iris: '#6A4596', hi: '#B08AE0' },   // 紫（含粉紅、玫瑰）
];
const BROWN_EYES = { iris: '#6B4128', hi: '#B87A4B' };
function eyeColors(accent) {
  const [r, g, b] = parse(accent).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.12) return BROWN_EYES;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h >= 345 || h < 60) return EYE_SETS[0];
  const dist = (a) => Math.min(Math.abs(a - h), 360 - Math.abs(a - h));
  return EYE_SETS.slice(1).reduce((best, e) => (dist(e.hue) < dist(best.hue) ? e : best));
}

/**
 * 調色盤。colors 由呼叫端給定（捏臉的白名單色、或 CV 取樣色），
 * 陰影與高光都從它們推導，不另外存。
 * 眼色跟著代表色走（見 eyeColors）：捏臉沒有眼睛顏色可選，這樣至少每個人不一樣。
 */
export function pixelPalette({ skin, hair: hairIn, accent, pants = DEFAULT_PANTS }) {
  // 膚色與髮色太接近時把頭髮壓暗。最深的膚色 #5C3A21 與長髮預設的 #5B3A29
  // 幾乎同色，不處理的話臉與頭髮會糊成一塊，看不出髮型也看不出五官。
  const dist = Math.hypot(...parse(skin).map((v, i) => v - parse(hairIn)[i]));
  const hair = dist < 60 ? shade(hairIn, 0.55) : hairIn;
  const eyes = eyeColors(accent);
  return {
    skin, skinSh: shade(skin, 0.84), skinHi: mix(skin, '#FFFFFF', 0.4),
    blush: mix(skin, '#F0736E', 0.5),
    hair, hairHi: mix(hair, '#FFE3C8', 0.4), hairSh: shade(hair, 0.72),
    band: mix(hair, '#FFFFFF', 0.22),
    acc: accent, accSh: shade(accent, 0.8), cuff: shade(accent, 0.68),
    iris: eyes.iris, irisHi: eyes.hi,
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
  const hair = HAIR_PIXELS[parts.head] ?? HAIR_PIXELS.head_short_01;
  const p = canvas();
  hair.back(p, pal, facing);
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
