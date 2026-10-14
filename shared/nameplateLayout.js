/**
 * 名牌避讓：人擠在一起時，讓名字錯開而不是疊成一團。
 *
 * 為什麼需要：場上 30 人時，任何兩個人站近一點名牌就會互相蓋住 —— 而最常
 * 站近的時刻正是配對任務（兩個人刻意走到一起），那也是最需要看清名字的時候。
 * 「看著大螢幕找到自己」是這件作品的前提，讀不出名字等於找不到人。
 *
 * 做法：名牌預設緊貼腳底；與已排好的名牌重疊時，依序嘗試往下錯開一格、兩格……
 * 往下塞不下時再往左右挪半個名牌寬。往旁邊挪的代價設得比往下高：往下錯開時
 * 名牌仍在角色正下方，往旁邊挪就容易被看成隔壁那個人的。
 * 離開原位的名牌由呼叫端畫一條細線連回腳底，否則看不出是誰的。
 *
 * ⚠ 排序依 id，不依畫面位置。依位置排序時，兩個人並肩走、Y 座標來回交錯，
 * 誰拿到原位每一幀都在換，兩塊名牌會上下跳個不停。依 id 則誰讓誰是固定的。
 *
 * 純函式、不碰 canvas，量字寬由呼叫端做（見 shared/character.js 的
 * measureNameplate），因此可以在 node 裡測試。
 */

/** 往旁邊挪一次，相當於往下錯開幾格的代價 */
const SIDE_COST = 1.5;

/**
 * @param {Array<{id: string, x: number, y: number, w: number, h: number}>} plates
 *   x 為名牌水平中心，y 為名牌上緣（未錯開時的位置），w/h 為名牌尺寸
 * @param {{gap?: number, maxSteps?: number, bottom?: number}} [opts]
 *   gap：名牌之間至少留的間距；maxSteps：最多往下錯開幾格；
 *   bottom：畫面下緣，錯開後超出這條線的位置不採用
 * @returns {Map<string, {dx: number, dy: number}>} id → 名牌相對原位的位移
 */
// maxSteps 預設 6：以 30 人隨機分布實測，4 格時極端擁擠（15 人貼著同一面牆）
// 仍剩約 2.4 組重疊、6 格降到 1.4 組；再多（8 格）名牌會離角色 200px 遠，
// 連線拉太長反而認不出是誰的。
export function layoutNameplates(plates, { gap = 2, maxSteps = 6, bottom = Infinity } = {}) {
  const ordered = [...plates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed = [];
  const result = new Map();

  for (const p of ordered) {
    let best = { dx: 0, dy: 0 };
    let bestOverlap = Infinity;
    for (const c of candidates(p, gap, maxSteps)) {
      if ((c.dx !== 0 || c.dy !== 0) && p.y + c.dy + p.h > bottom) continue;
      const overlap = overlapArea(p, c, placed, gap);
      if (overlap === 0) { best = c; bestOverlap = 0; break; }
      // 每個位置都撞到時，退而求其次選重疊最少的，而不是硬留在原位
      if (overlap < bestOverlap) { best = c; bestOverlap = overlap; }
    }
    const left = p.x + best.dx - p.w / 2;
    placed.push({ left, right: left + p.w, top: p.y + best.dy, bottom: p.y + best.dy + p.h });
    result.set(p.id, best);
  }
  return result;
}

/** 候選位置，依代價由低到高：原位 → 往下 → 往旁邊 */
function candidates(p, gap, maxSteps) {
  const step = p.h + gap;
  const side = p.w * 0.6;
  const list = [];
  for (let i = 0; i <= maxSteps; i++) {
    list.push({ dx: 0, dy: i * step, cost: i });
    list.push({ dx: -side, dy: i * step, cost: i + SIDE_COST });
    list.push({ dx: side, dy: i * step, cost: i + SIDE_COST });
  }
  // sort 是穩定排序，同代價時保留「左先於右」，結果才不會每幀不同
  return list.sort((a, b) => a.cost - b.cost).map(({ dx, dy }) => ({ dx, dy }));
}

function overlapArea(p, { dx, dy }, placed, gap) {
  const left = p.x + dx - p.w / 2 - gap;
  const right = p.x + dx + p.w / 2 + gap;
  const top = p.y + dy - gap;
  const bottom = p.y + dy + p.h + gap;
  let total = 0;
  for (const q of placed) {
    const w = Math.min(right, q.right) - Math.max(left, q.left);
    const h = Math.min(bottom, q.bottom) - Math.max(top, q.top);
    if (w > 0 && h > 0) total += w * h;
  }
  return total;
}
