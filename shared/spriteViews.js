/**
 * 從正面貼圖推導側面與背面 —— 大螢幕與手機端 POV 共用。
 *
 * 生成管線只產出一張正面圖。側面與背面不再呼叫生圖 API，而是在瀏覽器
 * 端由程式就地推導，理由是成本：每多一面就是每人多一次付費呼叫、多約
 * 25 秒（見 FIELD-OPS.md）。代價是推導出來的不是「真的」側臉與後腦勺，
 * 只是讓走路方向讀得出來的近似：
 *
 *   背面  整張水平鏡像；臉塗成後腦勺（取樣頭頂的頭髮往下鋪，保留輪廓線）；
 *         上衣中央的圖案、鈕扣抹成上衣主色。
 *   側面  頭部重新取樣成兩段：後段是正面頭的左側（頭髮、耳朵），前段是
 *         右半張臉（一隻眼睛）；身體壓到 BODY_SQUASH。全部是最近鄰取樣，
 *         不塗任何顏色 —— 像素風的格子不會被糊掉，也不會出現塗出來的切面。
 *         只產朝右的一張，朝左由 drawCharacter 依 facing 鏡像。
 *
 * 頭與身體的分界不寫死比例，而是找脖子：頭部下緣附近輪廓最窄的那一列。
 * 三種風格的頭身比不同（像素 3 頭身、樂高、皮克斯），寫死的比例只會對
 * 其中一種成立；找不到明顯的脖子時才退回 FALLBACK_HEAD_RATIO。
 *
 * 推導只在貼圖到齊時做一次（每個角色約 3 次 getImageData 的量級），
 * 不是每幀做。
 */

import { AGENT_VIEW } from './protocol.js';

// alpha 高於此值才算角色的一部分（去背邊緣有半透明的反鋸齒）
const ALPHA_SOLID = 40;
// 頭部塗髮色時，距離透明處這麼多像素以內、且夠暗的視為輪廓線，保留
const OUTLINE_PX = 3;
const OUTLINE_LUMA = 90;

const HEAD_SQUASH = 0.84;
// 側面的頭由兩段重新取樣拼成（見 deriveSide）：目的地後段 0~SIDE_REAR_DST
// 取正面頭的 0~SIDE_REAR_SRC（左側頭髮與耳朵），其餘取 SIDE_FRONT_SRC~1（右半張臉）
const SIDE_REAR_DST = 0.42;
const SIDE_REAR_SRC = 0.17;
const SIDE_FRONT_SRC = 0.5;
const BODY_SQUASH = 0.58;
// 與髮色（或上衣主色）距離小於此值的像素視為「本來就是頭髮／布料」，
// 保留原樣不塗 —— 原圖的髮絲、陰影、像素格紋都靠這條留下來
const KEEP_DIST = 70;
// 與膚色距離小於此值算臉
const SKIN_DIST = 55;
// 脖子搜尋範圍（以角色外框高度為單位）與找不到時的退路
const NECK_SEARCH = [0.18, 0.46];
const FALLBACK_HEAD_RATIO = 0.31;
// 看不出脖子時，頭高約為頭頂寬度的幾倍
const HEAD_ASPECT = 1.3;
// 背面上衣只抹中央這麼寬（以該列寬度為單位），兩側的手臂不動
const BACK_TORSO_BAND = 0.5;
const BACK_TORSO_RATIO = 0.62;

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 角色外框（不透明像素的範圍）。全透明時回傳 null。 */
export function opaqueBounds(img) {
  const { data, width, height } = img;
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA_SOLID) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 };
}

/** 每一列的不透明範圍 [左, 右]；整列透明為 null */
function rowSpans(img) {
  const { data, width, height } = img;
  const spans = new Array(height).fill(null);
  for (let y = 0; y < height; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > ALPHA_SOLID) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) spans[y] = [l, r];
  }
  return spans;
}

/**
 * 頭部下緣（脖子）所在的列。
 *
 * 在 NECK_SEARCH 範圍內找輪廓最窄的一列；那一列要比頭部最寬處窄上一截
 * 才算數，否則（例如長髮蓋過肩膀、樂高的方頭直接接身體）退回固定比例。
 */
export function findNeckRow(img, bounds = opaqueBounds(img), spans = rowSpans(img)) {
  if (!bounds) return 0;
  const h = bounds.y1 - bounds.y0 + 1;
  const fallback = bounds.y0 + Math.round(h * FALLBACK_HEAD_RATIO);
  const from = bounds.y0 + Math.round(h * NECK_SEARCH[0]);
  const to = bounds.y0 + Math.round(h * NECK_SEARCH[1]);

  let headMax = 0;
  for (let y = bounds.y0; y < from; y++) {
    if (spans[y]) headMax = Math.max(headMax, spans[y][1] - spans[y][0] + 1);
  }
  let best = -1, bestW = Infinity;
  for (let y = from; y <= to; y++) {
    if (!spans[y]) continue;
    const w = spans[y][1] - spans[y][0] + 1;
    if (w < bestW) { bestW = w; best = y; }
  }
  if (best >= 0 && bestW <= headMax * 0.8) return best;

  // 看不出脖子（長髮蓋過肩膀，輪廓從頭到肩一樣寬）：頭大約與頭頂一樣寬
  // 再高一些。固定比例只對 3 頭身成立，7 頭身的角色會把胸口當成臉。
  let topW = 0;
  for (let y = bounds.y0; y < bounds.y0 + Math.round(h * 0.08); y++) {
    if (spans[y]) topW = Math.max(topW, spans[y][1] - spans[y][0] + 1);
  }
  return topW > 0 ? Math.min(fallback, bounds.y0 + Math.round(topW * HEAD_ASPECT)) : fallback;
}

/**
 * 一塊區域裡最常見的顏色（每通道量化成 16 階統計，再取該格的平均）。
 * 太暗的像素（輪廓線）不算。回傳 [r, g, b] 或 null。
 */
export function dominantColor(img, y0, y1, x0 = 0, x1 = img.width - 1) {
  const { data, width } = img;
  const bins = new Map();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] <= ALPHA_SOLID) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (luma(r, g, b) < OUTLINE_LUMA * 0.5) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++; bin.r += r; bin.g += g; bin.b += b;
      bins.set(key, bin);
    }
  }
  let top = null;
  for (const bin of bins.values()) if (!top || bin.n > top.n) top = bin;
  return top ? [top.r / top.n, top.g / top.n, top.b / top.n].map(Math.round) : null;
}

/**
 * 每個不透明像素離最近透明處的距離（只算到 OUTLINE_PX 為止，以上一律
 * 視為內部）。用來分辨輪廓線與內部，塗色時保留輪廓。
 */
function edgeDistance(img) {
  const { data, width, height } = img;
  const dist = new Uint8Array(width * height);
  const solid = (x, y) => x >= 0 && y >= 0 && x < width && y < height
    && data[(y * width + x) * 4 + 3] > ALPHA_SOLID;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      let d = OUTLINE_PX + 1;
      for (let k = 1; k <= OUTLINE_PX && d > OUTLINE_PX; k++) {
        if (!solid(x - k, y) || !solid(x + k, y) || !solid(x, y - k) || !solid(x, y + k)) d = k;
      }
      dist[y * width + x] = d;
    }
  }
  return dist;
}

const shade = (c, k) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));

const colorDist = (data, i, c) => Math.hypot(data[i] - c[0], data[i + 1] - c[1], data[i + 2] - c[2]);

/**
 * 臉在每一列的範圍：該列第一個到最後一個「像膚色」的像素之間。
 *
 * 用膚色圈範圍、而不是「不像頭髮就塗」：眼睛、眉毛常與髮色很接近
 * （黑髮配深棕眼），以顏色逐點判斷會把眼睛留下來，背面變成一張蒙面的臉。
 * 夾在兩側膚色之間的東西（五官、眼鏡）一律算臉。
 */
function faceSpans(img, top, bottom, x0, x1, skin) {
  const { data, width } = img;
  const spans = [];
  for (let y = top; y < bottom; y++) {
    let l = -1, r = -1;
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > ALPHA_SOLID && colorDist(data, i, skin) < SKIN_DIST) {
        if (l < 0) l = x;
        r = x;
      }
    }
    spans.push(l < 0 ? null : [l, r]);
  }
  return spans;
}

/**
 * 把臉塗成後腦勺，保留輪廓線。
 *
 * 不平塗單色：從頭頂那一段真的頭髮取樣，往下來回鋪（ping-pong），原圖的
 * 髮絲、陰影與像素格紋都跟著過來 —— 平塗的色塊實測像貼了一張紙。
 * 越往下越暗一點，讓後腦勺讀起來是圓的。
 *
 * @param {(x:number, y:number) => boolean} [where]  只塗符合條件的像素
 */
function paintBackOfHead(img, dist, a, where = () => true) {
  const { data, width } = img;
  const { headTop, neck, hair, skin, texTop, texRows, headX0, headX1 } = a;
  const spans = faceSpans(img, headTop, neck, headX0, headX1, skin);
  const faceRows = Math.max(1, neck - headTop);

  for (let y = headTop; y < neck; y++) {
    const span = spans[y - headTop];
    if (!span) continue;
    const k = 1 - 0.22 * ((y - headTop) / faceRows);
    // 來回鋪：0,1,…,n-1,n-1,…,1,0,… 接縫處不會有一條斷線
    const step = (y - headTop) % (texRows * 2 || 1);
    const ty = texTop + (step < texRows ? step : texRows * 2 - 1 - step);

    for (let x = span[0]; x <= span[1]; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (data[i + 3] <= ALPHA_SOLID || !where(x, y)) continue;
      if (dist[p] <= OUTLINE_PX && luma(data[i], data[i + 1], data[i + 2]) < OUTLINE_LUMA) continue;

      let c = hair;
      if (texRows > 0) {
        const j = (ty * width + x) * 4;
        // 取樣點不是頭髮（透明、輪廓、或剛好是一撮別的顏色）就退回髮色
        if (data[j + 3] > ALPHA_SOLID && colorDist(data, j, hair) < KEEP_DIST) {
          c = [data[j], data[j + 1], data[j + 2]];
        }
      }
      const [r, g, b] = shade(c, k);
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
}

function cloneImage(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** 背面：鏡像、臉塗成後腦勺、上衣中央的圖案抹掉。回傳新的影像，不改動輸入。 */
export function deriveBack(img, analysis = analyze(img)) {
  const { width, height } = img;
  const out = cloneImage(img);
  if (!analysis) return out;

  // 水平鏡像：從背後看，左右對調
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + (width - 1 - x)) * 4;
      const d = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = img.data[s + c];
    }
  }

  const { bounds, neck } = analysis;
  const dist = edgeDistance(out);
  if (analysis.hair && analysis.skin) {
    paintBackOfHead(out, dist, {
      ...analysis,
      headX0: width - 1 - analysis.headX1,
      headX1: width - 1 - analysis.headX0,
    });
  }

  // 上衣正面的圖案、拉鍊、鈕扣、敞開外套露出的內搭：背面不該有。
  // 只動每一列的中央帶，兩側的手臂與手不碰（手的膚色與上衣差很多，
  // 整列抹會把手抹掉）；中央帶裡也只換掉與上衣主色差很多的像素 ——
  // 整塊換掉會留下一個邊緣筆直的平塗方塊，布料的陰影與格紋全沒了。
  const H = bounds.y1 - bounds.y0;
  const torsoTop = neck + Math.round(H * 0.04);
  const cx = Math.round((width - 1) - analysis.cx);
  const band = Math.round((bounds.x1 - bounds.x0) * BACK_TORSO_BAND * 0.5);
  const bx0 = Math.max(0, cx - band);
  const bx1 = Math.min(width - 1, cx + band);
  const guess = bounds.y0 + Math.round(H * BACK_TORSO_RATIO);
  // 主色取整列（含兩側），不取中央帶：敞開的外套中間露出的是內搭，
  // 中央帶的最多數會是內搭的白色
  const torso = dominantColor(out, torsoTop, guess);
  if (!torso) return out;

  // 上衣的下緣：往下找到整列幾乎沒有上衣顏色的地方為止。固定比例會在
  // 短版上衣時把褲頭也塗成上衣色。
  let torsoBottom = guess;
  for (let y = torsoTop + Math.round(H * 0.1); y < Math.min(bounds.y1, guess + H * 0.1); y++) {
    let solid = 0, match = 0;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const i = (y * width + x) * 4;
      if (out.data[i + 3] <= ALPHA_SOLID) continue;
      solid++;
      if (colorDist(out.data, i, torso) < KEEP_DIST) match++;
    }
    if (solid && match / solid < 0.3) { torsoBottom = y; break; }
  }

  for (let y = torsoTop; y < torsoBottom; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (out.data[i + 3] <= ALPHA_SOLID || dist[p] <= OUTLINE_PX) continue;
      if (colorDist(out.data, i, torso) < KEEP_DIST) continue;
      out.data[i] = torso[0]; out.data[i + 1] = torso[1]; out.data[i + 2] = torso[2];
    }
  }
  return out;
}

/** 側面（朝右）：頭與身體各自橫向壓縮，後半張臉塗成後腦勺。 */
export function deriveSide(img, analysis = analyze(img)) {
  const { width, height, data } = img;
  const out = { width, height, data: new Uint8ClampedArray(data.length) };
  if (!analysis) { out.data.set(data); return out; }

  const { neck, cx, headX0, headX1, headTop } = analysis;
  const srcW = Math.max(1, headX1 - headX0 + 1);
  const hcx = (headX0 + headX1) / 2;
  const dstW = srcW * HEAD_SQUASH;
  const dstL = hcx - dstW / 2;

  // 頭：不塗任何顏色，只重新排列正面頭部的像素（最近鄰）。
  //   後段（目的地 0 ~ SIDE_REAR_DST）取正面頭的左側 0 ~ SIDE_REAR_SRC：
  //     側邊的頭髮與耳朵 —— 側面時耳朵本來就在頭的中後方
  //   前段（SIDE_REAR_DST ~ 1）取正面臉的右半邊 SIDE_FRONT_SRC ~ 1：
  //     從鼻子到右臉頰，一隻眼睛、半個嘴巴，落在臉的前方
  // 試過在臉上塗頭髮（逐列找膚色範圍、畫髮際線、把五官往前挪）：每一列的
  // 範圍不同，塗出來是階梯狀的切面、五官被錯切，現場回報「臉有切面」。
  // 重新取樣沒有任何一格是畫出來的，輪廓與五官都是原圖的像素。
  const headSrcX = (x) => {
    const u = (x - dstL) / dstW;
    if (u < 0 || u > 1) return -1;
    const v = u < SIDE_REAR_DST
      ? (u / SIDE_REAR_DST) * SIDE_REAR_SRC
      : SIDE_FRONT_SRC + ((u - SIDE_REAR_DST) / (1 - SIDE_REAR_DST)) * (1 - SIDE_FRONT_SRC);
    return Math.round(headX0 + v * (srcW - 1));
  };

  // 下巴往往延伸到脖子那一列以下；頭部的取樣往下多帶一段，臉才不會在
  // 脖子那一列被橫切（實測過）。多帶的那幾列只取頭部寬度內的像素。
  const chinBottom = Math.min(height, neck + Math.round((neck - headTop) * 0.12));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx;
      if (y < neck) sx = headSrcX(x);
      else if (y < chinBottom && x >= dstL && x <= dstL + dstW) sx = headSrcX(x);
      else sx = Math.round(cx + (x - cx) / BODY_SQUASH);
      if (sx < 0 || sx >= width) continue;
      const s = (y * width + sx) * 4;
      const d = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = data[s + c];
    }
  }
  return out;
}

/**
 * 推導所需的共同量測：外框、脖子、頭部範圍、髮色、膚色、頭髮取樣帶。
 * 全透明（貼圖還沒到、或根本是空圖）時回傳 null，推導函式會原樣複製。
 */
export function analyze(img) {
  const bounds = opaqueBounds(img);
  if (!bounds) return null;
  const spans = rowSpans(img);
  const neck = findNeckRow(img, bounds, spans);
  const headTop = bounds.y0;
  const headH = Math.max(1, neck - headTop);

  // 頭部自己的左右範圍。不能用整個角色的外框 —— 外框被肩膀與手撐寬，
  // 拿它壓縮頭部會把臉擠到一邊、頭和脖子接不上。
  let headX0 = Infinity, headX1 = -1;
  for (let y = headTop; y < neck; y++) {
    if (!spans[y]) continue;
    headX0 = Math.min(headX0, spans[y][0]);
    headX1 = Math.max(headX1, spans[y][1]);
  }
  if (headX1 < 0) { headX0 = bounds.x0; headX1 = bounds.x1; }
  const hcx = (headX0 + headX1) / 2;
  const hw = headX1 - headX0;

  // 膚色取臉的正中央（頭部高度 45~75%、寬度中間 30%）：兩眼之間到嘴巴
  const skin = dominantColor(img,
    headTop + Math.round(headH * 0.45), headTop + Math.round(headH * 0.75),
    Math.round(hcx - hw * 0.15), Math.round(hcx + hw * 0.15));

  // 頭髮：臉以上的那一段。臉從哪一列開始，以中央那條找第一個膚色像素
  let faceTop = headTop + Math.round(headH * 0.35);
  if (skin) {
    const fs = faceSpans(img, headTop, neck, Math.round(hcx - hw * 0.1), Math.round(hcx + hw * 0.1), skin);
    const first = fs.findIndex(Boolean);
    if (first >= 0) faceTop = headTop + first;
  }
  const hair = dominantColor(img, headTop, Math.max(headTop + 1, faceTop - 1));
  // 取樣帶：臉上方那一截（頭頂最上緣是圓弧，太窄，不取）
  const texRows = Math.max(0, Math.min(Math.round(headH * 0.12), faceTop - headTop - 2));
  const texTop = faceTop - 1 - texRows;

  return {
    bounds, neck, hair, skin, headTop, headX0, headX1, texTop, texRows,
    cx: (bounds.x0 + bounds.x1) / 2,
  };
}

/** 一次算出三面。回傳 { front, back, side } 三份影像資料。 */
export function deriveViews(img) {
  const analysis = analyze(img);
  return {
    [AGENT_VIEW.FRONT]: img,
    [AGENT_VIEW.BACK]: deriveBack(img, analysis),
    [AGENT_VIEW.SIDE]: deriveSide(img, analysis),
  };
}
