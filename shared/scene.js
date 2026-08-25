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
