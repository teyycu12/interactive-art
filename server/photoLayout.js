/**
 * 大合照的「依互動排位」：今天互動越多的人，合照裡站得越近。
 *
 * 預設的合照是原地拍（見 server/index.js 的大合照段落）——記錄大家自己走出來的樣子。
 * 這是主辦端可選的另一種：把人排成一個面向鏡頭的隊形，熟的人排在隔壁。
 * 兩種各有用處，所以做成選項而不是取代。
 *
 * 全部是純函式：場上資料（誰跟誰互動過、道具在哪）由呼叫端傳入，測試可以直接餵假資料。
 */

import { ENCOUNTER_KINDS, VIA } from '../shared/encounters.js';

/** 單方面的互動（賓果填格）算得比較輕：碼可能是偷看來的，不代表兩人真的聊過 */
const ONE_WAY = new Set(ENCOUNTER_KINDS.filter((k) => k.oneWay).map((k) => k.id));

/**
 * 兩人的熟悉度。
 *
 * 「今天遇見的人」記的是互動的**種類**（配對、揮手、同桌、私訊…），不是次數，
 * 所以這裡數的是「兩人之間有幾種互動」：只揮過手的 < 配對過又同桌聊過的。
 * 配對經雙方確認、是最強的證據，算兩種；單方面的只算半種。兩個方向合併計算。
 *
 * @param {(id: string) => {id: string, via: string[]}[]} peersOf Encounters.peersOf
 * @returns {(a: string, b: string) => number}
 */
export function affinityFrom(peersOf) {
  /** @type {Map<string, Set<string>>} 「a b」（id 排序後）→ 兩人之間出現過的互動種類 */
  const kinds = new Map();
  const cache = new Map();
  return (a, b) => {
    if (a === b) return 0;
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    if (cache.has(key)) return cache.get(key);
    let set = kinds.get(key);
    if (!set) {
      set = new Set();
      for (const [from, to] of [[a, b], [b, a]]) {
        const p = peersOf(from).find((x) => x.id === to);
        for (const v of p?.via ?? []) set.add(v);
      }
      kinds.set(key, set);
    }
    let score = 0;
    for (const v of set) score += v === VIA.PAIR ? 2 : ONE_WAY.has(v) ? 0.5 : 1;
    cache.set(key, score);
    return score;
  };
}

/**
 * 把人排成一列，讓相鄰的兩人盡量是熟的。
 *
 * 貪婪法：先拿全場最熟的一對當起點，每次把「跟這一串頭或尾最熟」的人接上去，
 * 接不下去（剩下的人跟這串都不熟）就從剩下的人裡最熟的一對另起一串。
 * 誰都不認識的人排在最後 —— 隊形從後排開始蛇行填，最後的人會落在前排的一端，
 * 不會把一群熟人從中間切開。
 *
 * 不是最佳解（那是 NP-hard 的線性排列問題），但幾十個人以內又快又穩定，
 * 而現場要的是「熟的人站在一起」，不是全域最佳。
 *
 * @param {string[]} ids
 * @param {(a: string, b: string) => number} strength
 * @returns {string[]}
 */
export function orderByAffinity(ids, strength) {
  const left = new Set([...ids].sort());
  const out = [];
  while (left.size) {
    let best = null;
    let bestS = 0;
    const arr = [...left];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const s = strength(arr[i], arr[j]);
        if (s > bestS) { bestS = s; best = [arr[i], arr[j]]; }
      }
    }
    if (!best) {
      out.push(...arr);   // 剩下的人彼此都沒互動過
      break;
    }
    const chain = [...best];
    left.delete(best[0]);
    left.delete(best[1]);
    for (;;) {
      let pick = null;
      let pickS = 0;
      let atHead = false;
      for (const w of left) {
        const sh = strength(chain[0], w);
        const st = strength(chain[chain.length - 1], w);
        if (st > pickS) { pickS = st; pick = w; atHead = false; }
        if (sh > pickS) { pickS = sh; pick = w; atHead = true; }
      }
      if (!pick) break;
      left.delete(pick);
      if (atHead) chain.unshift(pick); else chain.push(pick);
    }
    out.push(...chain);
  }
  return out;
}

/**
 * 隊形的站位：一個面向鏡頭、寬比高長的人群，從後排往前排、蛇行排列。
 *
 * 蛇行（這排由左到右、下一排由右到左）讓 orderByAffinity 排出來的相鄰兩人
 * 在畫面上也相鄰 —— 換排的地方是上下相鄰，不會從最右邊跳到最左邊。
 *
 * 站位避開道具與牆（與出生點同樣的餘裕），彼此間距大於角色的身體距離，
 * 角色到位後就不會互相推擠。
 *
 * @param {number} n 人數
 * @param {object} p
 * @param {{width: number, height: number}} p.stage
 * @param {{x: number, y: number, r: number}[]} p.obstacles
 * @param {(o: object, x: number, y: number) => number} p.obstacleDistance
 * @param {number} [p.dx] 同排左右間距
 * @param {number} [p.dy] 前後排間距
 * @returns {{x: number, y: number}[]} 依隊形順序（後排先）
 */
export function formationSlots(n, { stage, obstacles, obstacleDistance, dx = 88, dy = 78 }) {
  if (n <= 0) return [];
  const cx = stage.width / 2;
  const cy = stage.height * 0.55;
  const minX = stage.width * 0.08;
  const maxX = stage.width * 0.92;
  const minY = stage.height * 0.22;
  const maxY = stage.height * 0.92;

  const candidates = [];
  for (let row = 0, y = minY; y <= maxY; row++, y += dy) {
    // 前後排錯開半格：後排的人才不會整個被前排的頭擋住
    const offset = row % 2 ? dx / 2 : 0;
    for (let x = minX + offset; x <= maxX; x += dx) {
      if (obstacles.some((o) => obstacleDistance(o, x, y) < o.r + 40)) continue;
      // 橫向拉長的距離：合照是寬的，往左右排比往前後排自然
      candidates.push({ x, y, row, d: Math.hypot((x - cx) / 1.8, y - cy) });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  const chosen = candidates.slice(0, n);

  const rows = new Map();
  for (const c of chosen) {
    if (!rows.has(c.row)) rows.set(c.row, []);
    rows.get(c.row).push(c);
  }
  const ordered = [];
  [...rows.keys()].sort((a, b) => a - b).forEach((row, i) => {
    const line = rows.get(row).sort((a, b) => a.x - b.x);
    if (i % 2) line.reverse();
    for (const c of line) ordered.push({ x: Math.round(c.x), y: Math.round(c.y) });
  });
  return ordered;
}

/**
 * 依互動排位：每個人要站到哪裡。
 * 站位不夠（場地被道具佔滿、人太多）時，排不進去的人留在原地 —— 寧可少排幾個，
 * 也不要把人塞進沙發裡。
 *
 * @param {{id: string, x: number, y: number}[]} agents
 * @param {(a: string, b: string) => number} strength
 * @param {Parameters<typeof formationSlots>[1]} field
 * @returns {Map<string, {x: number, y: number}>}
 */
export function arrangeByAffinity(agents, strength, field) {
  const order = orderByAffinity(agents.map((a) => a.id), strength);
  const slots = formationSlots(order.length, field);
  const out = new Map();
  order.forEach((id, i) => {
    const slot = slots[i];
    if (slot) out.set(id, slot);
    else {
      const a = agents.find((x) => x.id === id);
      out.set(id, { x: a.x, y: a.y });
    }
  });
  return out;
}
