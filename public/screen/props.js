/**
 * 場景道具的手繪繪製（技術文件 M3 §裝飾物件）
 *
 * 全部以 rough.js 的基本圖形組合而成，而非載入 SVG 圖檔。這樣做的好處：
 *   1. 風格與 rough.js 繪製的功能分區天然一致，不會有兩種手繪語彙打架
 *   2. 同步繪製，場景不必等圖片非同步載入完成
 *   3. 每個道具都吃同一組 seed，重繪結果完全一致（見 scene.js 的說明）
 *
 * ⚠ 風格對齊的佔位素材。要換成官方 Open Doodles 資產時，
 *   替換本檔的繪製函式即可，shared/scene.js 的座標與碰撞半徑無須更動。
 */

const INK = '#2F2A26';

/** rough.js 的共用筆觸設定。seed 由呼叫端指定，確保每次重繪結果相同。 */
const stroke = (seed, extra = {}) => ({
  seed,
  stroke: INK,
  strokeWidth: 2.4,
  roughness: 1.5,
  bowing: 1.4,
  ...extra,
});

/** 帶手繪填色的設定。hachure 是 rough.js 的斜線填法，最貼近手帳筆觸。 */
const filled = (seed, fill, extra = {}) => stroke(seed, {
  fill,
  fillStyle: 'hachure',
  fillWeight: 1.6,
  hachureGap: 6,
  ...extra,
});

// ─────────────────────────────────────────────────────────────
// 各類道具
// ─────────────────────────────────────────────────────────────

/** 盆栽：三片葉子 + 梯形花盆 */
function plant(rc, { x, y }, seed) {
  rc.polygon([
    [x - 22, y + 6], [x + 22, y + 6], [x + 16, y + 40], [x - 16, y + 40],
  ], filled(seed, '#C68642'));
  rc.ellipse(x - 16, y - 16, 34, 46, filled(seed + 1, '#84A98C'));
  rc.ellipse(x + 16, y - 12, 32, 42, filled(seed + 2, '#84A98C'));
  rc.ellipse(x, y - 34, 30, 44, filled(seed + 3, '#6E9075'));
  rc.line(x, y + 6, x, y - 24, stroke(seed + 4, { strokeWidth: 2 }));
}

/** 高腳桌：橢圓桌面 + 單腳 + 底盤 */
function table(rc, { x, y }, seed) {
  rc.line(x, y - 10, x, y + 34, stroke(seed, { strokeWidth: 4 }));
  rc.ellipse(x, y + 38, 44, 14, filled(seed + 1, '#D8D0C6'));
  rc.ellipse(x, y - 14, 92, 34, filled(seed + 2, '#E9C46A'));
}

/** 矮桌：圓桌面 + 四隻短腳 */
function lowtable(rc, { x, y }, seed) {
  rc.ellipse(x, y, 104, 44, filled(seed, '#C68642'));
  for (const [i, dx] of [-34, 34].entries()) {
    rc.line(x + dx, y + 12, x + dx, y + 32, stroke(seed + 1 + i, { strokeWidth: 3 }));
  }
}

/** 沙發：椅背 + 座墊 + 兩側扶手 */
function sofa(rc, { x, y }, seed) {
  rc.rectangle(x - 76, y - 42, 152, 44, filled(seed, '#B56576'));       // 椅背
  rc.rectangle(x - 76, y - 6, 152, 38, filled(seed + 1, '#C97F8E'));    // 座墊
  rc.rectangle(x - 88, y - 14, 20, 46, filled(seed + 2, '#B56576'));    // 左扶手
  rc.rectangle(x + 68, y - 14, 20, 46, filled(seed + 3, '#B56576'));    // 右扶手
  rc.line(x, y - 4, x, y + 30, stroke(seed + 4, { strokeWidth: 1.8 })); // 座墊分隔
}

/** 音箱：直立長方體 + 兩個喇叭單體 */
function speaker(rc, { x, y }, seed) {
  rc.rectangle(x - 30, y - 62, 60, 104, filled(seed, '#6D6875'));
  rc.circle(x, y - 32, 34, stroke(seed + 1, { strokeWidth: 2 }));
  rc.circle(x, y + 14, 22, stroke(seed + 2, { strokeWidth: 2 }));
}

const RENDERERS = { plant, table, lowtable, sofa, speaker };

/**
 * 繪製單一道具。
 * @param {object} rc rough.js canvas 實例
 * @param {object} prop shared/scene.js 中的道具定義
 */
export function drawProp(rc, prop) {
  const draw = RENDERERS[prop.type];
  if (!draw) return;
  // 以 id 推導出穩定的 seed，讓同一個道具每次重繪的手繪抖動完全一致
  let seed = 0;
  for (const ch of prop.id) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
  draw(rc, prop, seed + 1);
}
