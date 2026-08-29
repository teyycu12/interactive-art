/**
 * 場域佈局（技術文件 M3 §手繪風格場景管線）
 *
 * 本檔同時被大螢幕與伺服器載入，因為技術文件明訂裝飾物件要
 *「作為物理剛體障礙物加入避障清單」—— 若佈局只存在於前端，
 * 伺服器的 Boids 就不知道桌椅在哪，角色會直接穿過沙發。
 *
 * 座標為 1920×1080 的邏輯空間，與 STAGE 一致。
 *
 * ⚠ 道具的視覺以 rough.js 的基本圖形組合而成，屬風格對齊的佔位素材。
 *   要換成官方 Open Doodles 向量資產時，只需替換 props.js 的繪製函式，
 *   本檔的座標與碰撞半徑無須更動。
 */

/**
 * 功能分區。這些是「可行走」的區域，不是障礙物 ——
 * 分區的意義在於引導人群聚集，擋住反而失去作用。
 */
export const ZONES = [
  {
    id: 'stage',
    label: '舞台區',
    x: 640, y: 56, w: 640, h: 210,
    fill: '#E9C46A',
  },
  {
    id: 'bar',
    label: '暢飲區',
    x: 96, y: 360, w: 380, h: 430,
    fill: '#2A9D8F',
  },
  {
    id: 'lounge',
    label: '聊天沙發區',
    x: 1320, y: 500, w: 520, h: 470,
    fill: '#457B9D',
  },
];

/**
 * 裝飾物件兼物理障礙。
 * r 為碰撞半徑，通常略大於視覺尺寸，讓角色不會擦著邊緣走。
 */
export const PROPS = [
  // 舞台兩側的音箱
  { id: 'spk_l', type: 'speaker', x: 600, y: 210, r: 46, ry: Math.PI / 4 },
  { id: 'spk_r', type: 'speaker', x: 1320, y: 210, r: 46, ry: -Math.PI / 4 },

  // 暢飲區的高腳桌
  { id: 'tbl_1', type: 'table', x: 186, y: 452, r: 62 },
  { id: 'tbl_2', type: 'table', x: 186, y: 636, r: 62 },
  { id: 'tbl_3', type: 'table', x: 386, y: 548, r: 62 },

  // 聊天區的沙發與矮桌
  { id: 'sofa_1', type: 'sofa', x: 1452, y: 622, r: 84, ry: Math.PI / 2 },
  { id: 'sofa_2', type: 'sofa', x: 1716, y: 812, r: 84, ry: 0 },
  { id: 'ctbl_1', type: 'lowtable', x: 1560, y: 856, r: 54 },

  // 散落的植栽
  { id: 'plt_1', type: 'plant', x: 540, y: 470, r: 40 },
  { id: 'plt_2', type: 'plant', x: 1240, y: 400, r: 40 },
  { id: 'plt_3', type: 'plant', x: 300, y: 930, r: 40 },
  { id: 'plt_4', type: 'plant', x: 900, y: 940, r: 40 },
  { id: 'plt_5', type: 'plant', x: 1830, y: 300, r: 40 },
];

/** 供 Boids 避障使用的精簡清單 */
export const OBSTACLES = PROPS.map((p) => ({ x: p.x, y: p.y, r: p.r }));

/**
 * 角色目前站在哪一區。
 *
 * 分區原本只是地板上的色塊 —— 伺服器完全不知道它們存在，走進暢飲區
 * 與走到空地對系統毫無差別。有了這個判定，「站到某個地方就會發生事」
 * 才成立，而那是展場裡最容易被觀眾自己發現的互動語言：不需要說明牌。
 *
 * 放在 shared/ 而非伺服器：大螢幕要把所在分區高亮、手機要顯示
 * 「你在暢飲區」，三端必須用同一套判定，否則會出現
 * 「畫面說你在區內、伺服器說不在」而兩邊都不報錯。
 *
 * 重疊時取先定義的那一區。ZONES 目前互不重疊（test/scene.test.mjs
 * 有把關），這條規則只是讓行為在未來新增分區時仍然確定。
 *
 * @returns {string|null} 分區 id；不在任何分區內回傳 null
 */
export function zoneAt(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const z of ZONES) {
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.id;
  }
  return null;
}

/** 依 id 取分區定義，供三端顯示名稱與顏色 */
/** 依 id 取分區。null 原型的理由同 COLOR_FAMILY_MAP */
export const ZONE_MAP = Object.assign(Object.create(null),
  Object.fromEntries(ZONES.map((z) => [z.id, z])));
