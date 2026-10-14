/**
 * 從正面貼圖建出體素角色的骨架（純函式，不碰 DOM 也不碰 Three.js）。
 *
 * 流程：
 *   1. sampleGrid   把貼圖降到 GRID_ROWS 格高的網格（取每格中心點，不內插）
 *   2. segment      以輪廓找脖子、胯下、手臂與身體的縫，切成六個部位
 *   3. buildRig     每個部位依「離輪廓多遠」充氣出厚度，正面的顏色取正面圖、
 *                   背面取 spriteViews 推導的背面圖
 *
 * 為什麼是充氣而不是固定厚度：固定厚度擠出來是一塊有厚度的紙板，側面看
 * 是一條直邊。以距離輪廓的遠近決定厚度，手腳是圓柱、頭是圓的、軀幹邊緣
 * 收薄 —— 側面看得到身體的弧度。
 *
 * 六個部位各自有關節（pivot），渲染端（public/screen/voxelCharacters.js）
 * 繞關節擺動手腳。拆不開的部位就併在軀幹上：手臂貼著身體的角色只有腳會動，
 * 長裙蓋到腳踝的角色腿很短 —— 少動一個部位，不能讓整個角色畫不出來。
 *
 * sampleGrid 與 segment 也被 2D 走路格（shared/walkFrames.js）使用：
 * 移除體素實驗時這兩個要搬走，不能跟著刪。
 */

import { findNeckRow, opaqueBounds, deriveBack } from './spriteViews.js';

/**
 * 角色高度切成幾格。
 *
 * 與 backend/garment_gen.py 的 PIXEL_ART_GRID_HEIGHT（90）同值：像素風
 * 的角色本來就是 90 格高，取同一個數字，一格像素正好變成一顆體素，
 * 不會有兩格擠成一格或一格拆成兩半的鋸齒。其他風格沒有格子可對齊，
 * 90 只是解析度。
 */
export const GRID_ROWS = 90;

const ALPHA_SOLID = 128;

export const PARTS = ['torso', 'head', 'armL', 'armR', 'legL', 'legR'];
const NONE = -1;
const ID = Object.fromEntries(PARTS.map((p, i) => [p, i]));

/**
 * 降採樣：外框高度切成 rows 格，每格取中心那一個像素。
 *
 * 取中心而不平均：平均會把輪廓線和底色混成第三種顏色，像素風的乾淨色塊
 * 就沒了（GENERATION.md 的「不要重新定格」是同一件事）。
 *
 * 回傳的網格附帶 frac：外框高佔整張圖高度的比例。渲染端用它維持角色之間
 * 的相對身高 —— 全部拉到 90 格會讓小孩和大人一樣高。
 */
export function sampleGrid(img, rows = GRID_ROWS) {
  const b = opaqueBounds(img);
  if (!b) return null;
  const cell = (b.y1 - b.y0 + 1) / rows;
  const cols = Math.max(1, Math.ceil((b.x1 - b.x0 + 1) / cell));
  const data = new Uint8ClampedArray(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    const sy = Math.min(img.height - 1, Math.floor(b.y0 + (r + 0.5) * cell));
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(img.width - 1, Math.floor(b.x0 + (c + 0.5) * cell));
      const s = (sy * img.width + sx) * 4;
      const d = (r * cols + c) * 4;
      const solid = img.data[s + 3] >= ALPHA_SOLID;
      data[d] = img.data[s]; data[d + 1] = img.data[s + 1]; data[d + 2] = img.data[s + 2];
      data[d + 3] = solid ? 255 : 0;
    }
  }
  return {
    width: cols, height: rows, data,
    frac: (b.y1 - b.y0 + 1) / img.height,
    // 外框中心在整張圖的水平位置（0~1）。整張圖是置中畫的，但角色本身
    // 未必在正中央（例如提著包包）；渲染端以此對齊，腳底才落在原來的位置
    cx: (b.x0 + b.x1 + 1) / 2 / img.width,
    // 網格與原圖的對應（把網格對回原圖像素時用）
    x0: b.x0, y0: b.y0, cell,
  };
}

const solidAt = (g, c, r) => c >= 0 && r >= 0 && c < g.width && r < g.height
  && g.data[(r * g.width + c) * 4 + 3] > 0;

/** 一列裡的不透明區段 [[起, 迄], …] */
function runs(g, r, from = 0, to = g.width - 1) {
  const out = [];
  let start = -1;
  for (let c = from; c <= to + 1; c++) {
    const s = c <= to && solidAt(g, c, r);
    if (s && start < 0) start = c;
    if (!s && start >= 0) { out.push([start, c - 1]); start = -1; }
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 切部位。回傳每格屬於哪個部位（PARTS 的索引，-1 為空）與各關節位置。
 * 座標都是網格的（欄 c、列 r，r 往下增加）。
 */
export function segment(g) {
  const { width: W, height: H } = g;
  const part = new Int8Array(W * H).fill(NONE);
  const neck = findNeckRow(g);

  const cx = (W - 1) / 2;

  // ── 手臂：軀幹高度以下，左右兩側各有一段與身體分開的列 ──
  // 那幾列最外側那段的內緣（取中位數）就是手臂與身體的分界，往上延伸到肩膀。
  // 要先找手臂再找胯下：手臂與身體之間的縫也會讓每一列「分得出兩段」，
  // 不先排除手臂，胯下會被判在胸口。
  const armTop = Math.min(H - 1, neck + 1);
  const leftEdges = [];
  const rightEdges = [];
  for (let r = armTop; r < H; r++) {
    const rs = runs(g, r);
    if (rs.length < 3) continue;
    // 最外側那段要在中線外側夠遠才是手臂（不是兩條腿中的一條）
    if (rs[0][1] < cx - W * 0.12) leftEdges.push(rs[0][1]);
    if (rs[rs.length - 1][0] > cx + W * 0.12) rightEdges.push(rs[rs.length - 1][0]);
  }
  const ARM_MIN_ROWS = 3;
  const armL = leftEdges.length >= ARM_MIN_ROWS ? median(leftEdges) : null;
  const armR = rightEdges.length >= ARM_MIN_ROWS ? median(rightEdges) : null;

  // 手臂往下到哪一列：分界線外側最後一列還有東西的地方。
  // 肩膀那幾列可能還沒伸到分界線外，所以先找到第一列有東西的再開始算斷點
  const armBottom = (outside) => {
    let last = -1;
    for (let r = armTop; r < H; r++) {
      let any = false;
      for (let c = 0; c < W; c++) if (outside(c) && solidAt(g, c, r)) { any = true; break; }
      if (any) last = r; else if (last >= 0) break;
    }
    return last;
  };
  const armLBottom = armL === null ? -1 : armBottom((c) => c <= armL);
  const armRBottom = armR === null ? -1 : armBottom((c) => c >= armR);

  // ── 胯下：只看兩隻手臂內側。從腳往上，只要每一列都還有一道靠近中線
  // 的縫，就還在腿上。只數「分得出兩段」不夠：手掌比手臂與身體的分界
  // 更往內伸，那一截手掌和身體之間的縫也算兩段，實測胯下會被判到腰上、
  // 兩腿分界落在手邊，一條腿分到全部、另一條只剩幾顆。
  // 至少要有 LEG_MIN 高才算有腿；長裙蓋到腳踝時那一小截不值得單獨擺動 ──
  const inL = armL === null ? 0 : armL + 1;
  const inR = armR === null ? W - 1 : armR - 1;
  const LEG_MIN = Math.round(H * 0.12);
  const centerGap = (r) => {
    const rs = runs(g, r, inL, inR);
    let best = null;
    for (let i = 0; i + 1 < rs.length; i++) {
      const gap = (rs[i][1] + rs[i + 1][0]) / 2;
      if (Math.abs(gap - cx) <= W * 0.15 && (best === null || Math.abs(gap - cx) < Math.abs(best - cx))) best = gap;
    }
    return best;
  };
  let crotch = H;
  let legSplit = cx;
  for (let r = H - 1; r > neck; r--) {
    const gap = centerGap(r);
    if (gap === null) break;
    crotch = r;
    legSplit = gap;   // 留下最上面那一列的縫：胯下的位置最能代表兩腿的分界
  }
  const hasLegs = H - crotch >= LEG_MIN;
  if (!hasLegs) legSplit = cx;

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!solidAt(g, c, r)) continue;
      let p;
      if (r < neck) p = ID.head;
      else if (armL !== null && c <= armL && r >= armTop && r <= armLBottom) p = ID.armL;
      else if (armR !== null && c >= armR && r >= armTop && r <= armRBottom) p = ID.armR;
      else if (hasLegs && r >= crotch) p = c < legSplit ? ID.legL : ID.legR;
      else p = ID.torso;
      part[r * W + c] = p;
    }
  }

  // 關節：網格座標（列為往下增加；建模時才翻成往上）
  const centerOf = (id) => {
    let sum = 0, n = 0;
    for (let i = 0; i < part.length; i++) if (part[i] === id) { sum += i % W; n++; }
    return n ? sum / n : cx;
  };
  const hip = hasLegs ? crotch : H;
  const pivots = {
    torso: [cx, hip],
    head: [centerOf(ID.head), neck],
    armL: [centerOf(ID.armL), armTop + 1],
    armR: [centerOf(ID.armR), armTop + 1],
    legL: [centerOf(ID.legL), hip - 1],
    legR: [centerOf(ID.legR), hip - 1],
  };

  return { part, neck, crotch: hasLegs ? crotch : null, legSplit, armL, armR, pivots };
}

/**
 * 每格離所屬部位邊緣多遠（近似歐氏距離的兩趟 chamfer，邊緣那一格為 1）。
 * 以部位為單位算：手臂貼著身體時，手臂自己仍然是圓的，不會跟軀幹黏成一塊。
 */
function partDistance(g, part) {
  const { width: W, height: H } = g;
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = part[i] === NONE ? 0 : INF;
  const same = (i, j) => part[i] === part[j];
  const relax = (i, c2, r2, w) => {
    if (c2 < 0 || r2 < 0 || c2 >= W || r2 >= H) { d[i] = Math.min(d[i], w); return; }
    const j = r2 * W + c2;
    d[i] = Math.min(d[i], (same(i, j) ? d[j] : 0) + w);
  };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (part[i] === NONE) continue;
      relax(i, c - 1, r, 1); relax(i, c, r - 1, 1);
      relax(i, c - 1, r - 1, 1.4); relax(i, c + 1, r - 1, 1.4);
    }
  }
  for (let r = H - 1; r >= 0; r--) {
    for (let c = W - 1; c >= 0; c--) {
      const i = r * W + c;
      if (part[i] === NONE) continue;
      relax(i, c + 1, r, 1); relax(i, c, r + 1, 1);
      relax(i, c + 1, r + 1, 1.4); relax(i, c - 1, r + 1, 1.4);
    }
  }
  return d;
}

/**
 * 側壁用的顏色：輪廓線（深色）換成同部位附近的非輪廓色。
 *
 * 側壁的每一顆體素沿用它那一格在正面圖的顏色，而像素畫的輪廓是一圈墨線 ——
 * 不換的話，手臂和身體的側面會出現一條條深色紋，看起來像髒了。
 * 正面最外層與背面最外層仍用原色：觀眾正對時看到的必須是原圖。
 */
const INK_LUMA = 70;
function sideColors(g, part) {
  const { width: W, height: H, data } = g;
  const out = new Uint8ClampedArray(data);
  const dark = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_LUMA;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (part[i] === NONE || !dark(i * 4)) continue;
      let found = -1;
      for (let k = 1; k <= 3 && found < 0; k++) {
        for (let dr = -k; dr <= k && found < 0; dr++) {
          for (let dc = -k; dc <= k && found < 0; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
            const j = rr * W + cc;
            if (part[j] === part[i] && !dark(j * 4)) found = j;
          }
        }
      }
      if (found >= 0) for (let k = 0; k < 3; k++) out[i * 4 + k] = data[found * 4 + k];
    }
  }
  return out;
}

/**
 * 各部位最厚可以到多少（半厚，以該部位寬度為單位）。
 *
 * 頭接近球；軀幹比寬度薄（胸厚約為肩寬的六成）。手腳以自己最粗處為準，
 * 即成圓柱。
 */
const MAX_HALF_DEPTH = { head: 0.46, torso: 0.3 };

/**
 * 建出體素骨架。
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img  正面貼圖（原解析度）
 * @returns {null | {
 *   rows:number, cols:number, frac:number, cx:number,
 *   parts: Record<string, {pivot:[number,number,number], voxels:number[]}>
 * }}
 *   voxels 每 6 個數字一顆：x, y, z（世界座標，y 往上、腳底為 0、z 朝觀眾）
 *   與 r, g, b（0~255）。一顆體素佔 [x, x+1] × [y, y+1] × [z, z+1]。
 */
export function buildRig(img, rows = GRID_ROWS) {
  const g = sampleGrid(img, rows);
  if (!g) return null;
  const { width: W, height: H } = g;
  const seg = segment(g);
  const dist = partDistance(g, seg.part);
  // 背面圖是鏡像的（從背後看左右對調），取色時要翻回來
  const back = deriveBack(g);
  const segPart = seg.part;
  const frontSide = sideColors(g, segPart);
  // 背面圖是鏡像的：部位表也要鏡像才對得上
  const mirroredPart = new Int8Array(segPart.length);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) mirroredPart[r * W + c] = segPart[r * W + (W - 1 - c)];
  const backSide = sideColors(back, mirroredPart);

  // 每個部位的寬度，給 MAX_HALF_DEPTH 用
  const minC = new Array(PARTS.length).fill(Infinity);
  const maxC = new Array(PARTS.length).fill(-Infinity);
  const maxD = new Array(PARTS.length).fill(0);
  for (let i = 0; i < seg.part.length; i++) {
    const p = seg.part[i];
    if (p === NONE) continue;
    minC[p] = Math.min(minC[p], i % W);
    maxC[p] = Math.max(maxC[p], i % W);
    maxD[p] = Math.max(maxD[p], dist[i]);
  }

  // 網格中線落在 x = 0 附近。取整數：體素座標全是整數，渲染端才能用
  // 數字當鍵查鄰格（偏移最多半格，看不出來）
  const ox = Math.floor(W / 2);
  const parts = {};
  for (const name of PARTS) {
    const [pc, pr] = seg.pivots[name];
    parts[name] = { pivot: [pc - ox + 0.5, H - pr, 0], voxels: [] };
  }

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const p = seg.part[i];
      if (p === NONE) continue;
      const name = PARTS[p];
      // 圓弧斷面：從邊緣往內，厚度沿四分之一圓長到 R。直接拿距離當厚度
      // 會是菱形斷面，側面看是一個尖角，實測像一根棍子。
      const limit = MAX_HALF_DEPTH[name];
      const R = limit ? Math.max(1, (maxC[p] - minC[p] + 1) * limit) : Math.max(1, maxD[p]);
      const t = Math.min(dist[i], R) / R;
      const half = Math.max(1, Math.round(R * Math.sqrt(1 - (1 - t) ** 2)));

      const f = i * 4;
      const b = (r * W + (W - 1 - c)) * 4;
      const x = c - ox;
      const y = H - 1 - r;
      const out = parts[name].voxels;
      for (let z = -half; z < half; z++) {
        const outer = z === half - 1 || z === -half;
        const src = z >= 0 ? (outer ? g.data : frontSide) : (outer ? back.data : backSide);
        const k = z >= 0 ? f : b;
        out.push(x, y, z, src[k], src[k + 1], src[k + 2]);
      }
    }
  }

  return { rows: H, cols: W, frac: g.frac, cx: g.cx, parts };
}
