/**
 * 2D 走路格：從三視圖（正面、側面、背面）各自分析出手腳，再以「變形」
 * 做出一個步伐循環的幾格畫面。純函式，不碰 DOM —— 輸入輸出都是
 * { width, height, data }（ImageData 的形狀），瀏覽器端的快取在 spriteCache.js。
 *
 * 為什麼是變形而不是剪下來轉：試過把手腳剪下來繞關節轉（紙娃娃），現場回報
 * 「切面很詭異」—— 剪開的地方一轉就露出切口。這裡每一列的位移從關節的 0
 * 漸增到手腳末端的最大值，關節處完全不動，所以沒有切口。
 *
 * 為什麼位移以整格為單位：像素風的角色本來就是 90 格高的格子畫。半格的位移
 * 會讓一格被拆成兩半，邊緣出現原圖沒有的鋸齒；整格移動正是像素遊戲做走路的方式。
 *
 * 為什麼三面各自分析、不從正面推導：背面與側面都是模型畫的（三視圖），
 * 程式只決定「哪一塊是手、哪一塊是腳、關節在哪」，不需要猜看不到的地方。
 * 唯一要補的是側面的手臂擺開後露出的身體 —— 用同一列身後的衣服顏色補。
 *
 * 一個步伐循環 = 左右腳各跨一次。s = sin(相位)：s = 0 是兩腳併攏（身體最高，
 * 與 character.js 的起伏同相），s = ±1 是兩腳張到最開。
 */

import { sampleGrid, segment, GRID_ROWS } from './voxelRig.js';
import { findNeckRow } from './spriteViews.js';

/** 一個循環切幾格。8 格：最高速一秒約 8 格，整格位移下再多也只是重複 */
export const WALK_FRAMES = 8;

const ALPHA_SOLID = 128;

// ── 擺幅（格） ──
// 正面／背面：往前抬的那隻腳看起來變短（往上縮），手反向縮一格
const FRONT_LEG_LIFT = 2;
const FRONT_FEET_LIFT = 1;      // 長裙只露出腳時
const FRONT_ARM_LIFT = 2;
// 正面往前擺的那隻手，手掌往身體中線靠幾格（往前伸的手從正面看會往內收）
const FRONT_ARM_IN = 1;
// 側面：腳尖離髖部的水平位移（腿長的比例）、手離肩膀的位移（手臂長的比例）
const SIDE_LEG_SWING = 0.13;
const SIDE_ARM_SWING = 0.24;
const ARM_PAD = 2;
// 比這個暗就算描邊
const OUTLINE_LUMA = 110;

// ── 側面的比例 ──
// 髖部在脖子到腳底的這個位置：3 頭身（脖子約 35%）落在 64%，2.2 頭身（脖子約
// 47%）落在 71%，兩組參考圖都對得上
const HIP_FROM_NECK = 0.45;
// 手在這個高度範圍裡找（臉與脖子在上面、腿在下面，都不會被當成手）
const SIDE_HAND_ROWS = [0.45, 0.74];
// 側面的手掌可以比正面量到的再低幾格：側面的手垂在身體前面、不往外張
const HAND_ROW_PAD = 3;
// 腳掌佔角色高的比例：腳踝以下整塊移動，找腿的上緣時也跳過這一段
const FEET_RATIO = 0.06;
// 小腿：腳掌以上這麼高的一段，量它的寬度當基準
const SHIN_RATIO = 0.1;
// 比小腿寬這麼多倍的那一列就不是腿了（裙子、短褲、上衣）
const LEG_WIDTH_RATIO = 1.6;
// 腿的上緣最高到這裡（以角色高為單位）：褲子一路到腰時不要爬進上身
const LEG_TOP_MIN = 0.55;
// 露出的手臂（膚色）至少要這麼長才擺；只有手掌時不擺
const SIDE_MIN_ARM = 0.12;
// 側面遠側那隻腳（複製出來的）往這個灰收多少：降低對比，讀得出在後面。
// 不只是壓暗：黑褲子壓暗 20% 還是黑，兩隻腳疊成一團，看起來只有一隻
// （2026-10-15 回報「腳沒有分成兩隻」）；往灰收，黑的變深灰、淺的變暗
const FAR_LEG_SHADE = 0.75;
const FAR_LEG_TONE = [92, 92, 100];

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function solidCell(g, c, r) {
  return c >= 0 && r >= 0 && c < g.width && r < g.height && g.data[(r * g.width + c) * 4 + 3] > 0;
}

function cellColor(g, c, r) {
  const i = (r * g.width + c) * 4;
  return [g.data[i], g.data[i + 1], g.data[i + 2]];
}

function rowRuns(g, r) {
  const out = [];
  let start = -1;
  for (let c = 0; c <= g.width; c++) {
    const s = c < g.width && solidCell(g, c, r);
    if (s && start < 0) start = c;
    if (!s && start >= 0) { out.push([start, c - 1]); start = -1; }
  }
  return out;
}

function rowExtent(g, r) {
  const rs = rowRuns(g, r);
  return rs.length ? [rs[0][0], rs[rs.length - 1][1]] : null;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 膚色：正面臉部（頭的下半、中間 40%）最常見的膚色。給側面找手用。
 * 取量化後的眾數而不平均：平均會把眼睛、嘴巴混進去。
 *
 * 只收「紅 > 綠 ≥ 藍、紅比藍多出 SKIN_MIN_CHROMA」的顏色：不限的話白色
 * 衣領、粉紅洋裝都可能比臉多（實測大螢幕上白上衣角色的膚色量成白色、粉紅
 * 洋裝量成粉紅，側面整件裙子被當成手拉走）。粉紅的藍比綠多，白色沒有色度，
 * 兩者都不是膚色。
 */
const SKIN_MIN_CHROMA = 30;
const SKIN_MIN_LUMA = 80;   // 再暗是描邊、眼睛、頭髮；深膚色的臉約 90

function isSkinLike([R, G, B]) {
  return R > G && G >= B && R - B >= SKIN_MIN_CHROMA && luma(R, G, B) >= SKIN_MIN_LUMA;
}

export function skinTone(g, neck) {
  const counts = new Map();
  const top = Math.round(neck * 0.55);
  const c0 = Math.round(g.width * 0.3);
  const c1 = Math.round(g.width * 0.7);
  for (let r = top; r < neck; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!solidCell(g, c, r)) continue;
      const [R, G, B] = cellColor(g, c, r);
      if (!isSkinLike([R, G, B])) continue;
      const key = ((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4);
      const e = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += R; e.g += G; e.b += B;
      counts.set(key, e);
    }
  }
  let best = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best && best.n >= 3 ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}

// 膚色的容差（三通道差的總和）。60 太寬：粉紅洋裝與膚色只差 46，整件裙子
// 被當成手
const SKIN_TOL = 32;
const near = (a, b, tol) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol;

// 背光的膚色：同一種膚色只是暗一些（亮度是膚色的 SHADE_MIN 到 1 倍）。
// 側面手臂靠身體那一側常有一條 1–2 格寬的陰影，跟膚色差 100 上下，容差內收不到
const SHADE_MIN = 0.55;
function skinShade(rgb, skin) {
  const k = luma(...rgb) / luma(...skin);
  return k >= SHADE_MIN && k <= 1 && near(rgb, skin.map((v) => v * k), SKIN_TOL);
}

// 腿的顏色：一種顏色至少佔小腿這麼多才算（描邊約佔兩成，要收進來 ——
// 黑色窄裙與膚色腿的描邊差很多，與黑褲子的描邊則一樣）
const LEG_COLOR_SHARE = 0.1;
const LEG_COLOR_TOL = 48;
// 綠減藍差這麼多就不是同一種顏色：粉紅與膚色的三通道差只有 40 上下（實測
// 粉紅洋裝 37），但膚色綠比藍多、粉紅藍比綠多，看這一項就分得開
const HUE_TOL = 20;
const sameColor = (a, b, tol) => near(a, b, tol) && Math.abs((a[1] - a[2]) - (b[1] - b[2])) <= HUE_TOL;

/** r0…r1 這幾列（小腿）的主要顏色：量化後佔 LEG_COLOR_SHARE 以上的每一種 */
function shinPalette(g, r0, r1) {
  const counts = new Map();
  let total = 0;
  for (let r = Math.max(0, r0); r <= r1; r++) {
    for (let c = 0; c < g.width; c++) {
      if (!solidCell(g, c, r)) continue;
      const [R, G, B] = cellColor(g, c, r);
      const key = ((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4);
      const e = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += R; e.g += G; e.b += B;
      counts.set(key, e);
      total++;
    }
  }
  return [...counts.values()].filter((e) => e.n >= total * LEG_COLOR_SHARE).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
}

// 連續這麼多列的主色都不是腿的顏色，才算碰到下襬。只看一列會被腳踝擋下：
// 那裡有鞋口、襪子、腳踝的陰影，常常一列的主色就是小腿沒有的顏色
const HEM_ROWS = 3;

/** 一列裡最常見的顏色（量化後的眾數）；空的列回傳 null */
function rowMode(g, r) {
  const counts = new Map();
  let best = null;
  for (let c = 0; c < g.width; c++) {
    if (!solidCell(g, c, r)) continue;
    const rgb = cellColor(g, c, r);
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    const e = counts.get(key) ?? { n: 0, rgb };
    e.n++;
    counts.set(key, e);
    if (!best || e.n > best.n) best = e;
  }
  return best?.rgb ?? null;
}

/**
 * 下襬：從 from 往上到 to，第一段連續 HEM_ROWS 列主色都不是腿的顏色的地方，
 * 回傳那一段最下面的一列（裙子、短褲、上衣的最下緣）；找不到回傳 -1。
 */
function findHem(g, from, to, legColors) {
  let run = 0;
  for (let r = from; r >= to; r--) {
    const mode = rowMode(g, r);
    if (mode && !legColors.some((k) => sameColor(mode, k, LEG_COLOR_TOL))) {
      if (++run >= HEM_ROWS) return r + HEM_ROWS - 1;
    } else run = 0;
  }
  return -1;
}

// 一列裡膚色佔這麼多才算露出來的腿。描邊（腿自己最暗的那一階）約佔兩成；
// 長褲前面垂著手掌時，手掌佔不到一半
const BARE_SHARE = 0.6;
const BARE_TOL = 80;   // 腿上的陰影比臉暗一階，比找手的容差寬

/**
 * 這一列是露出來的腿。每一段的頭尾兩格（輪廓的描邊）不算；不用亮度排除
 * 描邊：黑褲子整件都暗，一排除就只剩前面垂著的手掌，反而判成光腿
 */
function bareRow(g, r, skin) {
  let n = 0, hit = 0;
  for (const [a, b] of rowRuns(g, r)) {
    for (let c = a + 1; c < b; c++) {
      n++;
      if (sameColor(cellColor(g, c, r), skin, BARE_TOL)) hit++;
    }
  }
  return n > 0 && hit >= n * BARE_SHARE;
}

/**
 * 給分析用的網格：手與身體之間那幾格小小的白色當成空的。
 *
 * 模型常在手臂與衣服之間畫一兩格白色縫，去背時因為被圍住而保留成不透明的白
 * （白色衣物、白鞋靠同一條規則留下來）。不當成空的，手就「黏」在身體上，
 * 正面的手完全分不出來。只限脖子以下、腳以上的小塊：眼睛的反光在脖子以上，
 * 白鞋在最底下，白上衣是一大片，都不會被挖掉。只影響分析，畫的時候原樣照畫。
 *
 * 「小」有兩種：零碎的小塊（不超過 GAP_MAX_CELLS 格），或窄而直的長條（每一列
 * 平均不超過 GAP_MAX_WIDTH 格、高比寬長）—— 一條沿著手臂的長縫有好幾十格，
 * 只看格數會漏掉。與後端 turnaround._enclosed_gaps 同一套判斷。
 */
const GAP_WHITE = 235;
const GAP_MAX_CELLS = 12;
const GAP_MAX_WIDTH = 2.5;
const GAP_MIN_ASPECT = 1.3;

function openGaps(g) {
  const W = g.width;
  const H = g.height;
  const neck = findNeckRow(g);
  const r1 = Math.round(H * 0.85);
  const white = (c, r) => {
    if (!solidCell(g, c, r)) return false;
    const [R, G, B] = cellColor(g, c, r);
    return Math.min(R, G, B) >= GAP_WHITE;
  };
  const data = new Uint8ClampedArray(g.data);
  const seen = new Uint8Array(W * H);
  for (let r = neck + 1; r < r1; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (seen[i] || !white(c, r)) continue;
      const cells = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        cells.push(j);
        const cc = j % W, rr = Math.floor(j / W);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = cc + dc, nr = rr + dr;
          if (nc < 0 || nc >= W || nr <= neck || nr >= r1) continue;
          const k = nr * W + nc;
          if (!seen[k] && white(nc, nr)) { seen[k] = 1; stack.push(k); }
        }
      }
      let rMin = H, rMax = -1;
      for (const j of cells) { const rr = Math.floor(j / W); rMin = Math.min(rMin, rr); rMax = Math.max(rMax, rr); }
      const tall = rMax - rMin + 1;
      const meanW = cells.length / tall;
      const strip = meanW <= GAP_MAX_WIDTH && tall >= GAP_MIN_ASPECT * meanW;
      if (cells.length <= GAP_MAX_CELLS || strip) for (const j of cells) data[j * 4 + 3] = 0;
    }
  }
  return { ...g, data };
}

/**
 * 部位標記：每一格屬於哪個會動的區塊（regions 的索引），-1 是不動的身體。
 *
 * 區塊：{ name, pivot, bottom, lift, swing, sign, z }，單位都是格。
 *   lift   正面／背面用：s 同號時，pivot 到 bottom 這一段往上縮幾格
 *   swing  側面用：bottom 那一列的水平位移（格），往上線性遞減到 pivot 為 0
 *   sign   這一塊跟 s 同向還是反向（左右腳、手腳反向）
 *   z      疊的順序：負的畫在身體後面，正的畫在前面
 */
function frontRig(g, skin, given = null) {
  const ga = openGaps(g);
  const seg = segment(ga);
  const H = g.height;
  const W = g.width;
  const label = new Int16Array(W * H).fill(-1);
  const regions = [];
  const add = (r) => regions.push(r) - 1;

  // 腿：segment 找得到胯下就用它的左右腿；長裙找不到時，從腳往上找
  // 「中間有縫」的那幾列當成露出來的腳
  let legL, legR;
  if (seg.crotch !== null) {
    legL = add({ name: 'legL', pivot: seg.crotch, bottom: H - 1, lift: FRONT_LEG_LIFT, sign: 1, z: 0 });
    legR = add({ name: 'legR', pivot: seg.crotch, bottom: H - 1, lift: FRONT_LEG_LIFT, sign: -1, z: 0 });
    for (let r = seg.crotch; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const p = seg.part[r * W + c];
        if (p === 4) label[r * W + c] = legL;
        else if (p === 5) label[r * W + c] = legR;
      }
    }
  } else {
    const cx = (W - 1) / 2;
    let top = H;
    let split = cx;
    // 最底下幾列是鞋底，兩隻鞋常常連成一條，先容許幾列沒有縫
    let misses = 0;
    for (let r = H - 1; r > H * 0.7; r--) {
      const rs = rowRuns(g, r);
      let gap = null;
      for (let i = 0; i + 1 < rs.length; i++) {
        const m = (rs[i][1] + rs[i + 1][0]) / 2;
        if (Math.abs(m - cx) <= W * 0.2) gap = m;
      }
      if (gap === null) {
        if (top === H && ++misses <= 2) continue;
        break;
      }
      top = r;
      split = gap;
    }
    if (H - top >= 2) {
      legL = add({ name: 'feetL', pivot: top - 1, bottom: H - 1, lift: FRONT_FEET_LIFT, sign: 1, z: 0 });
      legR = add({ name: 'feetR', pivot: top - 1, bottom: H - 1, lift: FRONT_FEET_LIFT, sign: -1, z: 0 });
      for (let r = top; r < H; r++) {
        for (let c = 0; c < W; c++) {
          if (solidCell(g, c, r)) label[r * W + c] = c < split ? legL : legR;
        }
      }
    }
  }

  // 手：與腳反向。inward：往身體中線的方向（左手往右、右手往左）
  const legTop = seg.crotch ?? Math.round(H * 0.8);
  let handRow = null;
  for (const [side, name, sign, inward] of [[-1, 'armL', -1, 1], [1, 'armR', 1, -1]]) {
    // 給了手臂範圍（換裝角色）就用給的，不從圖上找：斜背包、長髮、寬袖都會擋住手與身體之間的縫
    const arm = given ? givenArm(g, given, name) : frontArm(ga, g, skin, side, seg.neck, legTop);
    if (!arm) continue;
    handRow = Math.max(handRow ?? 0, arm.bottom);
    const idx = add({ name, pivot: arm.top, bottom: arm.bottom, lift: FRONT_ARM_LIFT, inward: inward * FRONT_ARM_IN, sign, z: 0 });
    for (const [r, a, b] of arm.rows) {
      for (let c = a; c <= b; c++) if (solidCell(g, c, r)) label[r * W + c] = idx;
    }
  }

  // 給側面用的手掌高度（格的列）。側面自己量不出來：手貼在身體前面分不出手掌
  return { kind: 'lift', label, regions, fill: null, handRow };
}

/**
 * 正面／背面的一隻手，逐列追：[列, 起欄, 迄欄]。
 *
 * 不用 segment 的手臂：它假設手臂與身體的分界是一條直線（取各列的中位數），
 * 手臂往外斜的角色分界會落在最外側，只分到一兩格（實測白上衣角色兩手都沒動）。
 * 這裡每一列各自看：
 *   - 手與身體分得開的列：最外側那一段就是手；
 *   - 分得開的第一列以上（肩膀）、最後一列以下（手碰到裙子）：沿用最近那一列
 *     的分界往上、往下延伸；中間偶爾黏住的列取上下兩列分界的內插；
 *   - 手的下端停在最後一列有膚色的地方（手掌）。洋裝的裙擺往外張，不停的話
 *     會一路算到裙子底下，手一動裙子邊緣跟著被拉走。
 * side：-1 左手、1 右手。分得開的列少於 3 列就當作分不出手。
 */
function frontArm(ga, g, skin, side, neck, legTop) {
  const W = g.width;
  const H = g.height;
  const cx = (W - 1) / 2;
  const top = neck + 1;
  const end = Math.min(legTop - 1, Math.round(H * 0.8));
  const inner = new Map();   // 列 → 手的內緣
  for (let r = top; r <= end; r++) {
    const rs = rowRuns(ga, r);
    if (rs.length < 2) continue;
    const run = side < 0 ? rs[0] : rs[rs.length - 1];
    const edge = side < 0 ? run[1] : run[0];
    if (side < 0 ? edge < cx - W * 0.12 : edge > cx + W * 0.12) inner.set(r, edge);
  }
  if (inner.size < 3) return null;
  const sep = [...inner.keys()].sort((a, b) => a - b);
  const first = sep[0];
  const last = sep[sep.length - 1];
  const edgeAt = (r) => {
    if (inner.has(r)) return inner.get(r);
    if (r < first) return inner.get(first);
    if (r > last) return inner.get(last);
    let lo = r, hi = r;
    while (!inner.has(lo)) lo--;
    while (!inner.has(hi)) hi++;
    return Math.round(inner.get(lo) + (inner.get(hi) - inner.get(lo)) * (r - lo) / (hi - lo));
  };
  const span = (r) => {
    const e = rowExtent(g, r);
    if (!e) return null;
    const edge = edgeAt(r);
    return side < 0 ? [e[0], Math.min(edge, e[1])] : [Math.max(edge, e[0]), e[1]];
  };
  // 手掌的下端：最後一列手的範圍內有膚色的
  let bottom = last;
  if (skin) {
    for (let r = first; r <= end; r++) {
      const sp = span(r);
      if (!sp) continue;
      for (let c = sp[0]; c <= sp[1]; c++) {
        if (solidCell(g, c, r) && near(cellColor(g, c, r), skin, SKIN_TOL)) { bottom = Math.max(bottom, r); break; }
      }
    }
  }
  bottom = Math.min(end, bottom + 1);
  const rows = [];
  for (let r = top; r <= bottom; r++) {
    const sp = span(r);
    if (sp && sp[0] <= sp[1]) rows.push([r, sp[0], sp[1]]);
  }
  return rows.length ? { top, bottom, rows } : null;
}

/**
 * 側面（朝右）：腿、裙襬、靠近觀眾的那隻手。
 * segment 的手臂偵測靠「手與身體之間的縫」，側面的手貼在身體前面，沒有縫，
 * 所以改用膚色找手，再沿著手往上量出手臂。
 */
function sideRig(g, skin, body = {}, given = null) {
  const H = g.height;
  const W = g.width;
  const label = new Int16Array(W * H).fill(-1);
  const regions = [];
  const add = (r) => regions.push(r) - 1;

  let bottom = H - 1;
  while (bottom > 0 && !rowExtent(g, bottom)) bottom--;
  // 髖部：脖子到腳底之間固定的位置。固定佔全身的比例只對一種頭身比成立 ——
  // 3 頭身的髖部約在 64%，2.2 頭身約 71%，參考圖集換了之後新舊角色同時在場上。
  // 不用正面的胯下：寬褲的兩腿只有褲管底部分開，量到的「胯下」其實是褲腳
  const neck = findNeckRow(g);
  const hip = Math.round(neck + (bottom - neck) * HIP_FROM_NECK);

  // ── 腿的上緣：從腳往上（跳過腳掌），一路走到輪廓明顯比小腿寬的那一列 ──
  // 寬出來的就是裙子、短褲、長版上衣，腿從它底下露出來。
  // 試過「由下往上找輪廓突然變寬的那一列」當裙襬：手垂在下襬旁邊時下襬那一列
  // 不會突然變寬（手補上了寬度），找不到，腿的範圍一路包進上衣和手
  // 寬度看這一列最寬的那一段（一條腿），不看整列的外框：兩腿張開站時外框是
  // 兩條腿加起來，量出來的「小腿」比裙子還寬，腿的上緣一路爬進上衣
  const width = (r) => rowRuns(g, r).reduce((m, [a0, a1]) => Math.max(m, a1 - a0 + 1), 0);
  const feetTop = bottom - Math.round(H * FEET_RATIO);
  const shinRows = [];
  for (let r = feetTop - 1; r >= feetTop - Math.round(H * SHIN_RATIO); r--) if (width(r)) shinRows.push(width(r));
  const shinW = median(shinRows) ?? 0;
  // 寬度擋不住窄裙：側面的窄裙、短裙只比大腿寬一點，腿的上緣一路爬進裙子，
  // 整件裙子被當成腿剪開擺動（現場回報「裙子側面變褲子」）。所以再看顏色：
  // 腿是小腿那一段的顏色（褲管、絲襪、靴子）或膚色，往上碰到別的顏色就是
  // 下襬 —— 長裙、短裙、短褲都一樣，腿從下襬底下開始擺。褲子一路同色，
  // 找不到下襬，照舊靠寬度停在腰
  const legColors = shinPalette(g, feetTop - Math.round(H * SHIN_RATIO), feetTop - 1);
  if (skin) legColors.push(skin);
  const ceiling = Math.round(H * LEG_TOP_MIN);
  const hem = findHem(g, feetTop - 1, ceiling, legColors);
  let legTop = feetTop;
  while (legTop - 1 >= ceiling && legTop - 1 > hem && width(legTop - 1)
    && width(legTop - 1) <= shinW * LEG_WIDTH_RATIO) legTop--;

  // ── 腿 ──
  // 有東西蓋住大腿時（裙子、短褲、長版上衣）腿從它底下擺（關節就是腿露出來的
  // 第一列），不從被蓋住的髖部：從髖部算的話，腿在下襬那一列已經偏了好幾格，
  // 腿的上端會從衣服側邊露出來。第一列本身不動：我們取樣的格子與模型畫的格子
  // 差幾個像素，下襬最底下那幾排像素常落在這一列，跟著腿走會撕下一條。
  // 褲子一路到腰時 legTop 在髖部以上，關節仍是髖部，髖部以上那段不動
  const pivot = Math.max(legTop, hip);
  const rigid = feetTop;   // 腳踝以下是腳掌，整塊跟著腳踝移，不跟著斜
  const swing = Math.max(1, Math.round((bottom - hip) * SIDE_LEG_SWING));
  if (bottom - legTop >= 2) {
    // 兩條腿分得開（有縫的列夠多）才各自擺；側面常常兩腿完全疊在一起，
    // 硬從中間切開會把一條腿撕成兩半。疊在一起時把看得到的腿複製一份當
    // 遠側的腳（稍暗），兩份反向擺 —— 像素遊戲側面走路本來就這樣畫
    const gaps = [];
    for (let r = pivot; r < feetTop; r++) {
      const rs = rowRuns(g, r);
      if (rs.length >= 2) gaps.push((rs[0][1] + rs[rs.length - 1][0]) / 2);
    }
    const twoLegs = gaps.length >= Math.max(2, (feetTop - pivot) * 0.4);
    if (twoLegs) {
      const split = median(gaps);
      const back = add({ name: 'legBack', pivot, bottom, rigid, swing, sign: -1, z: -2 });
      const front = add({ name: 'legFront', pivot, bottom, rigid, swing, sign: 1, z: -1 });
      for (let r = legTop; r <= bottom; r++) {
        for (let c = 0; c < W; c++) if (solidCell(g, c, r)) label[r * W + c] = c < split ? back : front;
      }
    } else {
      const legs = add({ name: 'legFront', pivot, bottom, rigid, swing, sign: 1, z: -1 });
      regions.push({ name: 'legFar', alias: legs, shade: FAR_LEG_SHADE, pivot, bottom, rigid, swing, sign: -1, z: -2 });
      for (let r = legTop; r <= bottom; r++) {
        for (let c = 0; c < W; c++) if (solidCell(g, c, r)) label[r * W + c] = legs;
      }
    }
  }

  // 裙子不動：試過讓裙襬跟著腳晃，整格位移在裙襬邊緣切出階梯，現場回報
  // 「很破碎」；真人走路裙襬本來也幾乎不動，動的是腳

  // ── 手：膚色、在手的高度、最大的一塊 ──
  // 露出大腿時（短褲、短裙）手只在腿的上方找：大腿也是膚色，而且比手大。
  // 腿沒露出來（長褲）就不限：褲子的上緣在腰，手掌垂在骨盆旁、落在腿的範圍
  // 裡，限在腿的上方會把手掌切掉，只擺上半截手臂（現場回報「手臂截肢」）
  // 看膝蓋一帶（手掌垂不到的高度），不看腿的最上面：長褲前面垂著手掌時，
  // 最上面幾列一半是手，會被當成光腿
  const kneeTop = Math.max(legTop, Math.round(H * SIDE_HAND_ROWS[1]) + 1);
  let bare = 0, knee = 0;
  if (skin) for (let r = kneeTop; r < feetTop; r++, knee++) if (bareRow(g, r, skin)) bare++;
  const bareLegs = bare * 2 > knee;
  let arm = null;
  if (given) {
    // 換裝角色：手臂範圍是事先在素體上做好的。整條袖子（長袖外套）一樣只小幅擺 ——
    // 袖子底下的身體不存在，擺開後原地要補布料的顏色
    const g0 = givenArm(g, given, 'arm');
    if (g0) {
      const cols = [];
      for (let r = g0.top; r <= g0.bottom; r++) {
        const rs = g0.rows.filter(([rr]) => rr === r);
        cols.push(rs.length ? [Math.min(...rs.map((x) => x[1])), Math.max(...rs.map((x) => x[2]))] : [1, 0]);
      }
      const swing = g0.small ? SLEEVE_SWING : Math.max(1, Math.round((g0.bottom - g0.top) * SIDE_ARM_SWING));
      arm = { top: g0.top, bottom: g0.bottom, cols, swing };
    }
  } else if (skin) {
    arm = sideArm(g, skin, bareLegs ? legTop - 1 : H - 1, body.handRow);
  }
  if (arm) {
    // fillBehind：手擺開後露出的身體要補顏色（pixelLabels 逐像素列算）
    const idx = add({ name: 'arm', pivot: arm.top, bottom: arm.bottom, swing: arm.swing, sign: -1, z: 1, fillBehind: true });
    for (let r = arm.top; r <= arm.bottom; r++) {
      const [a, b] = arm.cols[r - arm.top];
      for (let c = a; c <= b; c++) if (solidCell(g, c, r)) label[r * W + c] = idx;
    }
  }

  return { kind: 'swing', label, regions };
}

function sideArm(g, skin, maxRow, handRow = null) {
  const H = g.height;
  const W = g.width;
  // 找手的範圍：脖子以下（大頭的角色下巴在 45% 上下，固定從 45% 找會把臉與脖子
  // 當成手），到正面量到的手掌再往下幾格（手垂到 77% 的大頭角色，固定停在 74%
  // 會把手掌切掉，原地留下一團殘影）。正面量不到才用固定比例
  const neckRow = findNeckRow(g);
  const r0 = Math.max(Math.round(H * SIDE_HAND_ROWS[0]), neckRow + 2);
  const r1 = Math.min(maxRow, handRow != null ? handRow + HAND_ROW_PAD : Math.round(H * SIDE_HAND_ROWS[1]));
  const match = new Uint8Array(W * H);
  for (let r = r0; r <= r1; r++) {
    for (let c = 0; c < W; c++) if (solidCell(g, c, r) && near(cellColor(g, c, r), skin, SKIN_TOL)) match[r * W + c] = 1;
  }
  // 最大的 8 連通塊
  const seen = new Uint8Array(W * H);
  let best = null;
  for (let i = 0; i < match.length; i++) {
    if (!match[i] || seen[i]) continue;
    const cells = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      const c = j % W, r = Math.floor(j / W);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= W || rr >= H) continue;
        const k = rr * W + cc;
        if (match[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (!best || cells.length > best.length) best = cells;
  }
  if (!best || best.length < 4) return null;

  // 每一列手的範圍（膚色），左右再吃進緊鄰的深色描邊（最多 ARM_PAD 格）。
  // 不固定多拿幾格：手臂在側面常貼著衣服的前緣，多拿的那幾格是衣服，
  // 會跟著手一起被拉走（實測裙子前緣被撕下一塊）。手以上（袖子）沿用最上面
  // 那一列的寬度
  // 深色只在 ARM_PAD 格內就結束時才是描邊；再往外還是深色的是黑衣服（手掌
  // 垂在黑褲子前面），收進來的話整條褲管跟著手走，原地兩側都沒有衣服可補色
  const dark = (c, r) => solidCell(g, c, r) && luma(...cellColor(g, c, r)) < OUTLINE_LUMA;
  const outline = (r, from, step) => {
    let k = 0;
    while (k <= ARM_PAD && dark(from + step * k, r)) k++;
    return k <= ARM_PAD ? k : 0;
  };
  // 描邊之前先收背光的那一條陰影（最多 ARM_PAD 格）：手臂的帶子是照膚色的中心
  // 擬的，偏向亮的那一側，陰影與它外面的描邊都在帶子外 —— 手一擺，一條陰影加
  // 一條描邊黏在身上（2026-10-20 回報「手臂一部分黏在軀幹上」）
  const shaded = (c, r) => solidCell(g, c, r) && skinShade(cellColor(g, c, r), skin);
  const shadow = (r, from, step) => {
    let k = 0;
    while (k < ARM_PAD && shaded(from + step * k, r)) k++;
    return k;
  };
  const grow = (r, [a, b]) => {
    a -= shadow(r, a - 1, -1);
    b += shadow(r, b + 1, 1);
    return [a - outline(r, a - 1, -1), b + outline(r, b + 1, 1)];
  };
  const rows = new Map();
  for (const j of best) {
    const c = j % W, r = Math.floor(j / W);
    const e = rows.get(r);
    rows.set(r, e ? [Math.min(e[0], c), Math.max(e[1], c)] : [c, c]);
  }
  // 往上沿著膚色接回肩膀：找手只從手的高度開始找，無袖的手臂上半截在範圍外，
  // 量長度、擬直線都要用整隻手臂
  for (let r = Math.min(...rows.keys()) - 1; r > neckRow + 1; r--) {
    const below = rows.get(r + 1);
    let lo = -1, hi = -1;
    for (let c = below[0] - 1; c <= below[1] + 1; c++) {
      if (solidCell(g, c, r) && (near(cellColor(g, c, r), skin, SKIN_TOL) || skinShade(cellColor(g, c, r), skin))) {
        if (lo < 0) lo = c;
        hi = c;
      }
    }
    if (lo < 0) break;
    rows.set(r, [lo, hi]);
  }
  const handTop = Math.min(...rows.keys());
  // 只看得到手掌（長袖）：手臂的範圍不能從手掌往上猜一條同寬的帶子 —— 比袖子窄，
  // 一擺就把袖子撕成一條（實測長袖毛衣）。改沿著袖子兩側的描邊找出整條袖子；
  // 找不到（描邊不比布料暗）才不擺
  if (Math.max(...rows.keys()) - handTop + 1 < H * SIDE_MIN_ARM) {
    const sleeve = traceSleeve(g, rows.get(handTop), handTop, neckRow + SLEEVE_TOP_BELOW_NECK);
    if (!sleeve) return null;
    const handBottom = Math.min(H - 1, Math.max(...rows.keys()) + 1);
    const cols = [...sleeve.cols];
    for (let r = handTop; r <= handBottom; r++) {
      const hand = rows.get(r) ?? rows.get(r - 1) ?? rows.get(handTop);
      cols.push(grow(r, hand));
    }
    // 長袖只小幅擺：袖子擺開後原地要補布料的顏色，擺得越開補得越大塊，袖子上的
    // 明暗、花紋也被扯得越斜（實測灰毛衣擺 6 格，原地補出一塊深灰）
    return { top: sleeve.top, bottom: handBottom, cols, swing: SLEEVE_SWING };
  }
  // 往下多一列：手掌底下那一列是描邊，不是膚色，留在原地會變成一條橫線
  const bottom = Math.min(H - 1, Math.max(...rows.keys()) + 1);
  // 從露出膚色的第一列開始擺：無袖的手臂上面接回了肩膀，就從肩膀擺；有袖子的
  // 從袖口底下擺，袖子不動。以前帶子一路延伸到脖子，但帶子只有手臂寬、比袖子窄，
  // 袖子被撕成兩半，袖口那條深色的邊一半跟著手走、一半留在身上
  const top = handTop;
  // 手臂是一條直的帶子：每一列膚色的中心拿來擬一條直線，寬度取各列的上四分位。
  // 不直接用每一列找到的膚色：手臂背光的那一側比膚色暗，落在容差外，
  // 那幾格會留在原地，手一擺就碎成一截一截
  const rs = [...rows.keys()];
  const centers = rs.map((r) => (rows.get(r)[0] + rows.get(r)[1]) / 2);
  const widths = rs.map((r) => rows.get(r)[1] - rows.get(r)[0] + 1).sort((a, b) => a - b);
  const armW = widths[Math.floor(widths.length * 0.75)];
  const mr = rs.reduce((a, b) => a + b, 0) / rs.length;
  const mc = centers.reduce((a, b) => a + b, 0) / centers.length;
  let num = 0, den = 0;
  rs.forEach((r, i) => { num += (r - mr) * (centers[i] - mc); den += (r - mr) ** 2; });
  const slope = den ? num / den : 0;
  const cols = [];
  for (let r = top; r <= bottom; r++) {
    const c = mc + slope * (r - mr);
    let a = Math.max(0, Math.round(c - (armW - 1) / 2));
    let b = Math.min(W - 1, a + armW - 1);
    // 手掌比手臂寬：那幾列再併進實際找到的膚色範圍，否則手掌的外緣留在原地
    const hand = rows.get(r);
    if (hand) { a = Math.min(a, hand[0]); b = Math.max(b, hand[1]); }
    cols.push(grow(r, [a, b]));
  }
  const swing = Math.max(1, Math.round((bottom - top) * SIDE_ARM_SWING));
  return { top, bottom, cols, swing };
}

// 長袖：袖子從脖子往下幾格開始（肩膀），兩側描邊要比袖子裡面暗這麼多才算找到
const SLEEVE_TOP_BELOW_NECK = 3;
const SLEEVE_EDGE_DARKER = 0.8;
// 袖子寬度相對手掌（袖子常比手掌窄一點或寬一點）；路徑每偏一格的罰分（描邊多半是直的）
const SLEEVE_MIN_W = 0.5;
const SLEEVE_MAX_W = 1.4;
const SLEEVE_BEND = 24;
const SLEEVE_SWING = 2;

/**
 * 長袖的手臂：從手腕往上到肩膀，找袖子兩側的描邊。
 *
 * 像素畫的袖子兩側各有一條連續的深色描邊，但布料常有花紋、摺痕，一格一格看
 * 「暗不暗」分不出描邊與花紋。所以一次找一對路徑：每往上一列左右各最多偏一格、
 * 兩條之間的寬度在手掌的 SLEEVE_MIN_W–SLEEVE_MAX_W 倍，取兩條加起來最暗的那一對，
 * 偏一格罰 SLEEVE_BEND。透明格算最亮：算暗的話路徑直接滑到身體外面去。
 * 描邊沒有比中間的布料明顯暗（黑衣服上的黑袖子之類）就當找不到，回傳 null。
 * 回傳 { top, cols }：cols[i] 是第 top + i 列的 [左描邊, 右描邊]，到手腕上一列為止。
 */
function traceSleeve(g, wrist, handTop, shoulder) {
  const W = g.width;
  const [ha, hb] = wrist;
  const handW = hb - ha + 1;
  const minW = Math.max(2, Math.floor(handW * SLEEVE_MIN_W));
  const maxW = Math.ceil(handW * SLEEVE_MAX_W) + 1;
  const cost = (c, r) => (c < 0 || c >= W || !solidCell(g, c, r) ? 255 : luma(...cellColor(g, c, r)));
  const rowsUp = [];
  for (let r = handTop - 1; r >= shoulder; r--) rowsUp.push(r);
  if (rowsUp.length < 3) return null;

  // 動態規劃：狀態是（左描邊, 右描邊），中間至少 minW 格布料
  const key = (a, b) => (a + 1) * (W + 2) + (b + 1);
  let prev = new Map();
  // 起點：手腕兩側附近。袖口可能比手掌窄，描邊落在手掌的範圍裡
  for (let a = ha - 3; a <= ha + 2; a++) {
    for (let b = hb - 2; b <= hb + 3; b++) {
      const w = b - a - 1;
      if (w < minW || w > maxW) continue;
      prev.set(key(a, b), { a, b, cost: cost(a, rowsUp[0]) + cost(b, rowsUp[0]), back: null });
    }
  }
  const layers = [prev];
  for (let i = 1; i < rowsUp.length; i++) {
    const r = rowsUp[i];
    const next = new Map();
    for (const s of prev.values()) {
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          const a = s.a + da, b = s.b + db;
          const w = b - a - 1;
          if (w < minW || w > maxW || a < -1 || b > W) continue;
          const k = key(a, b);
          const c = s.cost + cost(a, r) + cost(b, r) + (da ? SLEEVE_BEND : 0) + (db ? SLEEVE_BEND : 0);
          const e = next.get(k);
          if (!e || c < e.cost) next.set(k, { a, b, cost: c, back: s });
        }
      }
    }
    if (!next.size) return null;
    layers.push(next);
    prev = next;
  }
  let best = null;
  for (const s of prev.values()) if (!best || s.cost < best.cost) best = s;
  const path = [];
  for (let s = best; s; s = s.back) path.push([s.a, s.b]);   // 肩膀 → 手腕
  // 袖子是一條大致直的帶子：肩膀到手腕的中心橫移超過一個手掌寬，是沿著別的線走掉了
  // （實測沿著背後的頭髮、外套前緣）
  const mid = ([a, b]) => (a + b) / 2;
  if (Math.abs(mid(path[0]) - mid(path[path.length - 1])) > handW) return null;

  // 描邊要比袖子裡面暗：兩條路徑的平均亮度 vs 中間布料的平均亮度
  let edge = 0, inner = 0, nIn = 0;
  path.forEach(([a, b], i) => {
    const r = shoulder + i;
    edge += cost(a, r) + cost(b, r);
    for (let c = a + 1; c < b; c++) if (solidCell(g, c, r)) { inner += luma(...cellColor(g, c, r)); nIn++; }
  });
  edge /= path.length * 2;
  if (!nIn || edge > (inner / nIn) * SLEEVE_EDGE_DARKER) return null;
  return { top: shoulder, cols: path.map(([a, b]) => [Math.max(0, a), Math.min(W - 1, b)]) };
}

/**
 * 給定的手臂範圍（換裝角色的 arms.json，backend/dressup.arm_cells）→ { top, bottom, rows, small }。
 * given：[{ name, cells: [[列, 起欄, 迄欄], …], small? }]，座標就是這裡的格子（同樣以不透明
 * 範圍切 GRID_ROWS 列）。超出格子的部分丟掉（兩邊的外框可能差一欄）。沒有這隻手回傳 null。
 */
function givenArm(g, given, name) {
  const arm = given.find((a) => a?.name === name);
  if (!arm || !Array.isArray(arm.cells)) return null;
  const rows = [];
  for (const cell of arm.cells) {
    if (!Array.isArray(cell) || cell.length !== 3 || !cell.every(Number.isInteger)) continue;
    const [r, a, b] = cell;
    if (r < 0 || r >= g.height || b < 0 || a >= g.width || a > b) continue;
    rows.push([r, Math.max(0, a), Math.min(g.width - 1, b)]);
  }
  if (!rows.length) return null;
  const top = Math.min(...rows.map((x) => x[0]));
  const bottom = Math.max(...rows.map((x) => x[0]));
  return { top, bottom, rows, small: arm.small === true };
}

/**
 * 分析一張圖。view：'front' | 'back' | 'side'（側面朝右）。
 * 側面需要膚色（opts.skin，從正面的 rig.skin 取）與手掌高度（opts.body =
 * { handRow }，從正面的 rig 取；沒有就用固定比例）。圖是空的回傳 null；
 * 分析不出任何會動的部位時 regions 是空的，walkFrame 會原樣照畫。
 * opts.arms：這一面的手臂範圍（換裝角色才有，見 givenArm）；給了就不從圖上找手。
 */
export function buildWalkRig(img, view, opts = {}) {
  const g = majorityAlpha(img, sampleGrid(img, GRID_ROWS));
  if (!g) return null;
  // 膚色：正面自己算；背面與側面用正面的（背面看不到臉）
  const skin = view === 'front' ? skinTone(g, findNeckRow(g)) : (opts.skin ?? null);
  const given = Array.isArray(opts.arms) ? opts.arms : null;
  const rig = view === 'side' ? sideRig(g, skin, opts.body, given) : frontRig(g, skin, given);
  rig.label = growLabels(g, rig.label);
  rig.g = g;
  rig.view = view;
  Object.assign(rig, pixelLabels(img, rig, skin));
  // 就算正面一個部位都分不出來也要給：側面與背面靠它找手
  rig.skin = skin;
  return rig;
}

/**
 * 每一格透不透明，改看整格裡過半的像素，不只看中心那一點。
 *
 * 手臂與身體之間的縫常常不到一格寬（實測約 0.8 格），只看中心點時有一半的
 * 機率踩在縫旁邊的描邊上，縫就不見了 —— 手黏在身體上，正面的手完全不動。
 * 顏色仍取中心點（取平均會把描邊與底色混成第三種顏色）。
 */
function majorityAlpha(img, g) {
  if (!g) return g;
  const data = new Uint8ClampedArray(g.data);
  const step = Math.max(1, Math.floor(g.cell / 6));
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const x0 = Math.floor(g.x0 + c * g.cell), x1 = Math.min(img.width, Math.floor(g.x0 + (c + 1) * g.cell));
      const y0 = Math.floor(g.y0 + r * g.cell), y1 = Math.min(img.height, Math.floor(g.y0 + (r + 1) * g.cell));
      let n = 0, on = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          n++;
          if (img.data[(y * img.width + x) * 4 + 3] > ALPHA_SOLID) on++;
        }
      }
      const i = (r * g.width + c) * 4 + 3;
      if (n) data[i] = on * 2 > n ? 255 : 0;
    }
  }
  return { ...g, data };
}

/**
 * 會動的區塊往外長一格，蓋住旁邊的空格。
 *
 * 輪廓邊緣有半透明的像素（去背留下的柔邊），它們所在的格子取樣時算空的，
 * 標成「不動」—— 手腳一動，那一圈柔邊留在原地，變成一條條碎屑。
 * 只長進空格，不搶身體的格子。
 */
function growLabels(g, label) {
  const W = g.width;
  const H = g.height;
  const out = new Int16Array(label);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (solidCell(g, c, r)) continue;
      let pick = -1;
      for (let dr = -1; dr <= 1 && pick < 0; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          const l = label[rr * W + cc];
          if (l >= 0) { pick = l; break; }
        }
      }
      out[r * W + c] = pick;
    }
  }
  return out;
}

/**
 * 把格子的標記落到每一個像素，並修掉格子對不準造成的殘留。
 *
 * 我們取樣的格子（外框高 ÷ 90）與模型實際畫的格子差幾個百分點，往下數三十格
 * 就差了一整格：一條描邊會跨在兩格之間，一半跟著手腳走、一半留在原地，手一擺
 * 原地就剩一條條深色的線。所以以像素為準再修一次：
 *   - 緊貼著會動區塊的深色描邊像素（半格以內、不跨過透明），歸給那個區塊；
 *   - 側面的手（fillBehind）擺開後露出的身體：每一像素列從手臂兩側往外找第一個
 *     「不是描邊、也不是膚色」的像素，就是衣服的顏色。先找身後（左）再找身前。
 *     手臂另一側也要有東西才補 —— 手若在輪廓最前緣，擺開後那裡本來就是空的。
 */
const ADOPT_CELLS = 0.6;

function pixelLabels(img, rig, skin) {
  const { width, height, data } = img;
  const { g, label, regions } = rig;
  const pix = new Int16Array(width * height).fill(-1);
  const opaque = (i) => data[i * 4 + 3] > ALPHA_SOLID;
  const pl = (i) => luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const skinPx = (i) => {
    if (!skin) return false;
    const rgb = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    return near(rgb, skin, SKIN_TOL * 2) || skinShade(rgb, skin);
  };

  for (let y = 0; y < height; y++) {
    const r = Math.floor((y - g.y0) / g.cell);
    if (r < 0 || r >= g.height) continue;
    for (let x = 0; x < width; x++) {
      const c = Math.floor((x - g.x0) / g.cell);
      if (c < 0 || c >= g.width) continue;
      const i = y * width + x;
      if (data[i * 4 + 3] > 0) pix[i] = label[r * g.width + c];
    }
  }

  // 描邊歸隊：從會動的像素往外，只走深色（側面的手也走膚色的陰影），最多半格
  const reach = Math.max(1, Math.round(g.cell * ADOPT_CELLS));
  const dist = new Int16Array(width * height).fill(-1);
  let queue = [];
  for (let i = 0; i < pix.length; i++) if (pix[i] >= 0) { dist[i] = 0; queue.push(i); }
  for (let d = 0; d < reach && queue.length; d++) {
    const next = [];
    for (const i of queue) {
      const x = i % width, y = (i - x) / width;
      const lab = pix[i];
      const arm = regions[lab]?.fillBehind;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (dist[j] >= 0 || !opaque(j) || pix[j] >= 0) continue;
        if (!(pl(j) < OUTLINE_LUMA || (arm && skinPx(j)))) continue;
        dist[j] = d + 1;
        pix[j] = lab;
        next.push(j);
      }
    }
    queue = next;
  }

  // 每個區塊實際佔到的像素列（描邊歸隊後可能超出關節列或手掌列一點）：
  // walkFrame 要畫滿這個範圍，不然歸隊的那幾排描邊誰都不畫，原地留一條空線
  const spans = regions.map(() => [height, -1]);
  for (let i = 0; i < pix.length; i++) {
    const l = pix[i];
    if (l < 0) continue;
    const y = Math.floor(i / width);
    if (y < spans[l][0]) spans[l][0] = y;
    if (y > spans[l][1]) spans[l][1] = y;
  }

  // 側面的手擺開後要補的顏色：每一像素列一個顏色 —— 手臂兩側三格內衣服像素
  // 最常見的那個顏色。不取緊鄰的第一個：常常是衣服摺痕的陰影，補出來一塊深色
  let fillRGB = null;
  const armIdx = regions.findIndex((R) => R.fillBehind);
  if (armIdx >= 0) {
    fillRGB = new Int32Array(height).fill(-1);
    const rowCounts = new Array(height);
    const search = Math.round(g.cell * 3);
    // 深色也算衣服：黑褲子整件都比描邊的門檻暗，排除的話手掌從褲子前面擺開，
    // 原地補不出顏色，留下一個洞（實測黑寬褲）。描邊只佔一兩格，取眾數不會選到它。
    // 腿的像素也算：手掌垂在骨盆旁時兩側都是褲子，而褲子標成腿
    const cloth = (i) => opaque(i) && pix[i] !== armIdx && !skinPx(i);
    for (let y = 0; y < height; y++) {
      let xa = -1, xb = -1;
      for (let x = 0; x < width; x++) {
        if (pix[y * width + x] === armIdx) { if (xa < 0) xa = x; xb = x; }
      }
      if (xa <= 0 || xb >= width - 1) continue;
      if (!opaque(y * width + xa - 1) || !opaque(y * width + xb + 1)) continue;
      const counts = new Map();
      for (let k = 1; k <= search; k++) {
        for (const x of [xa - k, xb + k]) {
          if (x < 0 || x >= width) continue;
          const i = y * width + x;
          if (!cloth(i)) continue;
          const rgb = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
          const key = rgb & 0xF0F0F0;
          const e = counts.get(key);
          if (e) e.n++; else counts.set(key, { n: 1, rgb });
        }
      }
      rowCounts[y] = counts;
    }
    // 上下各半格一起算：逐列各自取最常見的顏色，摺痕兩側的列會挑到不同的
    // 深淺，補出來一條條橫紋
    const win = Math.max(1, Math.round(g.cell / 2));
    for (let y = 0; y < height; y++) {
      if (!rowCounts[y]) continue;
      const total = new Map();
      for (let k = Math.max(0, y - win); k <= Math.min(height - 1, y + win); k++) {
        if (!rowCounts[k]) continue;
        for (const [key, e] of rowCounts[k]) {
          const t = total.get(key);
          if (t) t.n += e.n; else total.set(key, { n: e.n, rgb: e.rgb });
        }
      }
      let best = null;
      for (const e of total.values()) if (!best || e.n > best.n) best = e;
      if (best) fillRGB[y] = best.rgb;
    }
  }
  return { pix, fillRGB, fillRegion: armIdx, spans };
}

/** 第 k 格（0…WALK_FRAMES-1）的 s。第 0 格是兩腳併攏 */
export const frameS = (k) => Math.sin((k / WALK_FRAMES) * Math.PI * 2);

/**
 * 依 rig 把 img 變形成步伐的某一格（s = sin(相位)）。回傳與 img 同尺寸的新影像。
 * s = 0 時與原圖逐像素相同。
 */
export function walkFrame(img, rig, s) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const { g, regions, pix, fillRGB, fillRegion, spans } = rig;
  const cell = g.cell;
  const put = (dx, dy, sx, sy, shade = 1) => {
    if (dx < 0 || dy < 0 || dx >= width || dy >= height) return;
    const s4 = (sy * width + sx) * 4;
    if (data[s4 + 3] <= 0) return;
    const d4 = (dy * width + dx) * 4;
    for (let c = 0; c < 3; c++) out[d4 + c] = data[s4 + c] * shade + (shade < 1 ? FAR_LEG_TONE[c] * (1 - shade) : 0);
    out[d4 + 3] = data[s4 + 3];
  };
  const py = (r) => g.y0 + r * cell;     // 格的上緣（像素）

  // 依 z 排序：負的先畫（身體後面），再畫不動的身體，再畫正的
  const order = regions.map((r, i) => i).sort((a, b) => regions[a].z - regions[b].z);
  const drawStatic = () => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const lab = pix[y * width + x];
        if (lab < 0) { put(x, y, x, y); continue; }
        // 會動的區塊原本的位置：側面手臂後方的身體用同一列的衣服顏色補
        if (lab === fillRegion && fillRGB[y] >= 0) {
          const d4 = (y * width + x) * 4;
          const c = fillRGB[y];
          out[d4] = c >> 16; out[d4 + 1] = (c >> 8) & 255; out[d4 + 2] = c & 255; out[d4 + 3] = 255;
        }
      }
    }
  };

  let staticDone = false;
  for (const i of order) {
    const R = regions[i];
    if (!staticDone && R.z >= 0) { drawStatic(); staticDone = true; }
    const amt = R.sign * s;
    // alias：複製別的區塊（側面遠側的腳）；shade：往 FAR_LEG_TONE 收多少
    const own = R.alias ?? i;
    const shade = R.shade ?? 1;
    const top = py(R.pivot);
    const bot = py(R.bottom + 1);
    const span = Math.max(1, bot - top);
    // 實際要畫的列：區塊的像素範圍（描邊歸隊後可能比關節到末端寬一點）
    const [own0, own1] = spans[R.alias ?? i];
    const yFrom = Math.min(Math.floor(top), own0);
    const yTo = Math.max(Math.ceil(bot), own1 + 1);

    if (rig.kind === 'lift') {
      // 往上縮：只有與 s 同號時抬，另一隻腳踩在地上不動
      const up = Math.max(0, amt);
      const lift = Math.round(up * R.lift) * cell;
      const newSpan = span - lift;
      for (let y = yFrom; y < yTo; y++) {
        // 關節以上不動；以下整段往上縮（末端以下的那排描邊也照同一個比例跟著縮）
        const sy = lift > 0 && y > top ? Math.floor(top + (y - top) * span / newSpan) : y;
        if (sy >= yTo || sy >= height) continue;
        // 往前擺的手往內收：與側面同樣以「格的列」算位移，從肩膀 0 到手掌最大
        const r = Math.floor((sy - g.y0) / cell);
        const t = Math.max(0, Math.min(1, (r - R.pivot) / Math.max(1, R.bottom - R.pivot)));
        const dx = Math.round(up * (R.inward ?? 0) * t) * cell;
        for (let x = 0; x < width; x++) {
          if (pix[sy * width + x] === own) put(Math.round(x + dx), y, x, sy);
        }
      }
    } else {
      // 水平擺：位移從 pivot 的 0 線性增加到 bottom 的 swing 格，四捨五入到整格。
      // t 以「格的列」算、不以像素列算：同一格裡上下幾個像素位移不同，那一格
      // 就被扯成斜的，腳會碎成好幾片。腳踝以下（rigid）整塊一起移，腳掌不彎
      const rigid = R.rigid ?? R.bottom;
      const tSpan = Math.max(1, rigid - R.pivot);
      for (let y = yFrom; y < yTo; y++) {
        const r = Math.floor((y - g.y0) / cell);
        const t = Math.max(0, Math.min(1, (Math.min(r, rigid) - R.pivot) / tSpan));
        const dx = Math.round(amt * R.swing * t) * cell;
        for (let x = 0; x < width; x++) {
          if (pix[y * width + x] === own) put(Math.round(x + dx), y, x, y, shade);
        }
      }
    }
  }
  if (!staticDone) drawStatic();
  return { width, height, data: out };
}
