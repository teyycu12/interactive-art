/**
 * 場域佈局（技術文件 M3 §手繪風格場景管線）
 *
 * 本檔同時被大螢幕與伺服器載入，因為技術文件明訂裝飾物件要
 *「作為物理剛體障礙物加入避障清單」—— 若佈局只存在於前端，
 * 伺服器的 Boids 就不知道桌椅在哪，角色會直接穿過沙發。
 *
 * 座標為 2596×1080 的邏輯空間，與 STAGE 一致，而且**就是像素場景那張圖的座標**
 * （畫面 x = 本檔 x，畫面 y = 本檔 y + 270）。室內地板是其中的 x 338–2258 那一段，
 * 左右兩側各 338 寬的是室外（菜園／露台、大廳／遊戲間）—— 它們一直都畫在圖上，
 * 只是以前沒有人走得進去，見 `shared/protocol.js` 的 STAGE 註解。
 *
 * ⚠ 道具的視覺以 rough.js 的基本圖形組合而成，屬風格對齊的佔位素材。
 *   要換成官方 Open Doodles 向量資產時，只需替換 props.js 的繪製函式，
 *   本檔的座標與碰撞半徑無須更動。
 */

import { STAGE } from './protocol.js';

/**
 * 功能分區。這些是「可行走」的區域，不是障礙物 ——
 * 分區的意義在於引導人群聚集，擋住反而失去作用。
 */
export const ZONES = [
  {
    id: 'stage',
    label: '舞台區',
    x: 978, y: 56, w: 640, h: 210,
    fill: '#E9C46A',
  },
  {
    id: 'bar',
    label: '暢飲區',
    x: 434, y: 360, w: 380, h: 430,
    fill: '#2A9D8F',
  },
  {
    id: 'lounge',
    label: '聊天沙發區',
    x: 1658, y: 500, w: 520, h: 470,
    fill: '#457B9D',
  },
];

/**
 * 裝飾物件兼物理障礙。
 * r 為碰撞半徑，通常略大於視覺尺寸，讓角色不會擦著邊緣走。
 */
export const PROPS = [
  // Kitchen additions use existing prop types so the alternate room also renders them.
  { id: 'k_cart', type: 'table', x: 1098, y: 160, r: 48 },
  { id: 'k_island', type: 'table', x: 1318, y: 160, r: 62 },
  { id: 'k_dining', type: 'lowtable', x: 1498, y: 1010, r: 70 },
  { id: 'k_stool_l', type: 'lowtable', x: 1378, y: 990, r: 28 },
  { id: 'k_stool_r', type: 'lowtable', x: 1638, y: 990, r: 28 },
  { id: 'k_pantry', type: 'table', x: 1858, y: 240, r: 60 },
  { id: 'k_dishes', type: 'table', x: 2048, y: 240, r: 50 },
  { id: 'k_market', type: 'table', x: 898, y: 960, r: 54 },
  // 舞台兩側的音箱
  { id: 'spk_l', type: 'speaker', x: 938, y: 210, r: 46, ry: Math.PI / 4 },
  { id: 'spk_r', type: 'speaker', x: 1658, y: 210, r: 46, ry: -Math.PI / 4 },

  // 暢飲區的高腳桌
  { id: 'tbl_1', type: 'table', x: 524, y: 452, r: 62 },
  { id: 'tbl_2', type: 'table', x: 524, y: 636, r: 62 },
  { id: 'tbl_3', type: 'table', x: 724, y: 548, r: 62 },

  // 聊天區的沙發與矮桌
  { id: 'sofa_1', type: 'sofa', x: 1790, y: 622, r: 84, ry: Math.PI / 2 },
  { id: 'sofa_2', type: 'sofa', x: 2054, y: 812, r: 84, ry: 0 },
  { id: 'ctbl_1', type: 'lowtable', x: 1898, y: 856, r: 54 },

  // 室外西側的三格（廚房是菜畦，辦公室是電話亭與置物櫃）。
  //
  // 室外變成可行走之後，裡面的東西就不能只是背景畫上去的 —— 有 id 才能當
  // 集合點、任務目標與顏色任務的指示物，與「1號桌」走的是同一套機制。
  //
  // x = 160、r = 54 是倒推出來的：西側可站的範圍是 0–293（牆從 293 開始擋），
  // 道具佔掉 106–214，於是靠牆那條走道留下 79、靠圍籬那側留下 106。
  // 再往右擺，靠牆的走道會窄到角色擠不過去（道具的閃避緩衝帶就有 55）；
  // 再往左擺就會掉進 BOUNDARY_MARGIN（140）裡，變成「圈畫得出來但沒人站得住」。
  { id: 'grd_1', type: 'table', x: 160, y: 150, r: 54 },
  { id: 'grd_2', type: 'table', x: 160, y: 420, r: 54 },
  { id: 'grd_3', type: 'table', x: 160, y: 690, r: 54 },

  // 散落的植栽
  { id: 'plt_1', type: 'plant', x: 878, y: 470, r: 40 },
  { id: 'plt_2', type: 'plant', x: 1578, y: 400, r: 40 },
  { id: 'plt_3', type: 'plant', x: 638, y: 930, r: 40 },
  { id: 'plt_4', type: 'plant', x: 1238, y: 940, r: 40 },
  { id: 'plt_5', type: 'plant', x: 2168, y: 300, r: 40 },
];

/**
 * 室內與室外之間的牆，以及牆上刻意留的門。
 *
 * ── 為什麼牆要進物理 ──
 * 以前房間的牆純屬裝飾，因為可行走區剛好等於室內地板，走不到牆邊。舞台一旦
 * 擴張到整張圖，牆的兩側都站得了人 —— 不擋的話角色會直接穿牆進出菜園，
 * 而畫面上只會看起來「怪怪的」，不會有任何錯誤。
 *
 * ── 為什麼是線段而不是一排圓 ──
 * 障礙原本只有圓形。用一排圓拼出一道牆，角色沿牆滑行時會一格一格卡進圓與圓
 * 之間的凹處；而且一道牆要二十幾顆圓才夠密。因此 `server/boids.js` 的三個
 * 迴圈改成支援「線段 + 半徑」（膠囊）：圓形仍是沒有 x2/y2 的那一種，
 * 既有行為完全不變。
 *
 * ── 門為什麼由同一份資料推導 ──
 * 牆段與門是同一件事的兩面：牆段之間的空隙就是門。分開寫的話，美術把門畫在
 * 一個地方、物理把缺口留在另一個地方，現場會看到角色對著一扇畫出來的門撞牆。
 * `kitchenArt` / `officeArt` 直接讀 `DOORWAYS` 來挖那個洞。
 */
export const WALL_THICKNESS = 38;
/** 牆的碰撞半徑。略大於實際厚度的一半，角色才不會把身體壓進牆面。 */
const WALL_R = 26;

/** 牆的中心線與門的 y 範圍。門高 240，扣掉兩端的碰撞半徑後淨寬約 188。 */
const WALL_LINES = [
  { side: 'w', x: 319, door: [120, 360] },
  { side: 'e', x: 2277, door: [400, 640] },
];

export const DOORWAYS = WALL_LINES.map(({ side, x, door }) => ({
  id: `door_${side}`,
  x: x - WALL_THICKNESS / 2, y: door[0], w: WALL_THICKNESS, h: door[1] - door[0],
}));

export const WALLS = WALL_LINES.flatMap(({ side, x, door }) => [
  { id: `wall_${side}_n`, x, y: 0, x2: x, y2: door[0], r: WALL_R },
  { id: `wall_${side}_s`, x, y: door[1], x2: x, y2: STAGE.height, r: WALL_R },
]);

/**
 * 供 Boids 避障使用的精簡清單。
 * 道具在前、牆在後 —— 有幾組測試以 `OBSTACLES[n]` 取「某個道具」，
 * 把牆插在前面會讓它們改成測到一道牆。
 */
export const OBSTACLES = [
  ...PROPS.map((p) => ({ x: p.x, y: p.y, r: p.r })),
  ...WALLS.map((w) => ({ x: w.x, y: w.y, x2: w.x2, y2: w.y2, r: w.r })),
];

/**
 * 障礙表面上離 (x, y) 最近的那一點。
 *
 * 圓形道具（沒有 x2/y2）就是圓心；牆是「線段 + 半徑」，取投影到線段上、
 * 夾在兩端之間的那一點。取到之後，所有「離障礙多遠」的計算與圓形完全相同。
 *
 * **放在 shared/ 而不是 boids.js 裡**：除了避障，還有三個地方要問同一件事 ——
 * 角色的出生點（`state.js`）、寶藏的落點（`treasure.js`）、以及測試裡的
 * 「有沒有人陷進障礙裡」。它們原本都寫成 `hypot(x - o.x, y - o.y) < o.r`，
 * 那個式子對線段障礙量的是「到線段起點的距離」—— 寶藏會落在牆裡面，
 * 而現場的症狀是這一輪尋寶永遠沒有人找得到，畫面上沒有任何異常。
 */
export function nearestOnObstacle(o, x, y) {
  if (o.x2 === undefined) return [o.x, o.y];
  const ex = o.x2 - o.x;
  const ey = o.y2 - o.y;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return [o.x, o.y];
  const t = Math.max(0, Math.min(1, ((x - o.x) * ex + (y - o.y) * ey) / len2));
  return [o.x + ex * t, o.y + ey * t];
}

/** (x, y) 到障礙中心線的距離。小於 o.r 代表陷在障礙裡。 */
export function obstacleDistance(o, x, y) {
  const [ox, oy] = nearestOnObstacle(o, x, y);
  return Math.hypot(x - ox, y - oy);
}

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
export const ZONE_MAP = Object.fromEntries(ZONES.map((z) => [z.id, z]));
