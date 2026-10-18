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
 * 隊形的站位：一排一排、面向鏡頭，從後排往前排、蛇行排列。
 *
 * 先決定要幾排（每排最多 perRow 人），每一排從中間往兩側取位，再整排置中 ——
 * 人少的時候就是並肩站成一排。原本是「離中心最近的格子」，兩個人會剛好分到
 * 前後兩排、一個疊在另一個身後（2026-10-18 實拍）。
 *
 * 蛇行（這排由左到右、下一排由右到左）讓 orderByAffinity 排出來的相鄰兩人
 * 在畫面上也相鄰 —— 換排的地方是上下相鄰，不會從最右邊跳到最左邊。
 *
 * 間距照大螢幕上的角色大小取：角色約 170 單位高、100 單位寬，左右要留得比身寬大，
 * 前後排錯開半格，後排的人才不會整個被前排的頭擋住。
 * 站位避開道具與牆（比出生點多一點餘裕）；某一排被道具佔掉位子時，不足的人補到下一排。
 *
 * @param {number} n 人數
 * @param {object} p
 * @param {{width: number, height: number}} p.stage
 * @param {{x: number, y: number, r: number}[]} p.obstacles
 * @param {(o: object, x: number, y: number) => number} p.obstacleDistance
 * @param {number} [p.dx] 同排左右間距
 * @param {number} [p.dy] 前後排間距
 * @param {number} [p.perRow] 每排最多幾人
 * @returns {{x: number, y: number}[]} 依隊形順序（後排先）
 */
export function formationSlots(n, { stage, obstacles, obstacleDistance, dx = 130, dy = 105, perRow = 12 }) {
  if (n <= 0) return [];
  const minX = stage.width * 0.06;
  const maxX = stage.width * 0.94;
  const minY = stage.height * 0.2;
  const maxY = stage.height * 0.92;
  const free = (x, y) => !obstacles.some((o) => obstacleDistance(o, x, y) < o.r + 40);

  /**
   * 這一排最長的一段連續空位。隊形要排成一整段，不能被桌子從中間切開 ——
   * 切開的話，排序上相鄰的兩個熟人會被分到桌子兩邊。
   */
  const bestRun = (y, offset) => {
    let best = [];
    let run = [];
    const close = () => {
      const mid = (r) => (r[0] + r.at(-1)) / 2;
      if (run.length > best.length
        || (run.length === best.length && run.length && Math.abs(mid(run) - stage.width / 2) < Math.abs(mid(best) - stage.width / 2))) {
        best = run;
      }
      run = [];
    };
    for (let x = minX + offset; x <= maxX; x += dx) {
      if (free(x, y)) run.push(x); else close();
    }
    close();
    return best;
  };
  const offsetOf = (i) => (i % 2 ? dx / 2 : 0);

  /**
   * 在這一段裡取 k 個連續位置，盡量對齊 center：各排對齊同一個中心，
   * 蛇行換排時上下才接得起來（不對齊的話，熟人會在換排處被拆到畫面兩頭）。
   */
  const segment = (run, k, center) => {
    if (k >= run.length) return run.slice();
    let best = 0;
    for (let i = 0; i + k <= run.length; i++) {
      const mid = (run[i] + run[i + k - 1]) / 2;
      const bestMid = (run[best] + run[best + k - 1]) / 2;
      if (Math.abs(mid - center) < Math.abs(bestMid - center)) best = i;
    }
    return run.slice(best, best + k);
  };

  // 挑隊形放在哪幾排：每排都要塞得下 each 人、各排對得齊，越靠近地板中間越好
  const rowsWanted = Math.ceil(n / perRow);
  const each = Math.ceil(n / rowsWanted);
  const preferY = stage.height * 0.6;
  let pick = null;
  for (let y0 = minY; y0 + (rowsWanted - 1) * dy <= maxY; y0 += dy / 4) {
    const runs = [...Array(rowsWanted).keys()].map((i) => bestRun(y0 + i * dy, offsetOf(i)));
    const cap = Math.min(...runs.map((r) => r.length));
    if (!cap) continue;
    // 共同的中心：各段中點的平均；量各排實際排出來的中點離它多遠
    const center = runs.reduce((t, r) => t + (r[0] + r.at(-1)) / 2, 0) / runs.length;
    const mids = runs.map((r) => {
      const seg = segment(r, Math.min(each, r.length), center);
      return (seg[0] + seg.at(-1)) / 2;
    });
    const misalign = Math.max(...mids) - Math.min(...mids);
    const mid = y0 + ((rowsWanted - 1) * dy) / 2;
    const score = Math.min(cap, each) * 10000 - misalign * 3 - Math.abs(mid - preferY);
    if (!pick || score > pick.score) pick = { y0, runs, score, center };
  }

  const rows = [];
  let left = n;
  const place = (y, run) => {
    const k = Math.min(run.length, left, each);
    if (!k) return;
    rows.push({ y, xs: segment(run, k, pick?.center ?? stage.width / 2) });
    left -= k;
  };
  pick?.runs.forEach((run, i) => place(pick.y0 + i * dy, run));
  // 道具多到預定的排塞不下：往前、往後交替加排，直到每個人都有位置或場地用完
  const base = pick?.y0 ?? stage.height * 0.5;
  for (let k = 1; left > 0 && k < 20; k++) {
    for (const i of [rowsWanted - 1 + k, -k]) {
      const y = base + i * dy;
      if (left > 0 && y >= minY && y <= maxY) place(y, bestRun(y, offsetOf(Math.abs(i))));
    }
  }

  rows.sort((a, b) => a.y - b.y);
  const ordered = [];
  for (const row of rows) {
    // 從離上一排結尾比較近的那一頭開始（通常就是左右交替的蛇行）。
    // 各排長短、位置不一（被道具切過）時，硬性交替會在換排處跳到另一頭
    const prev = ordered.at(-1);
    const line = prev && Math.abs(prev.x - row.xs.at(-1)) < Math.abs(prev.x - row.xs[0])
      ? [...row.xs].reverse() : row.xs;
    for (const x of line) ordered.push({ x: Math.round(x), y: Math.round(row.y) });
  }
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
      // 沒有座標的（合照的臨時人物，見 guestSpots）排不進去就不出現，不會有「原地」可留
      const a = agents.find((x) => x.id === id);
      if (Number.isFinite(a?.x) && Number.isFinite(a?.y)) out.set(id, { x: a.x, y: a.y });
    }
  });
  return out;
}

/**
 * 合照的臨時人物要站哪裡（原地拍時）。
 *
 * 有參與、但按快門時不在場上的人（先走的、斷線的）也要在合照裡（2026-10-19）。
 * 原地拍時在場的人不動，臨時人物補進人群旁邊的空位：離人群中心越近越先選，
 * 與在場的人、彼此之間都保持一個身位，避開道具與牆。
 * 依互動排位時不用這個 —— 臨時人物直接一起排進隊形（arrangeByAffinity）。
 *
 * 間距：角色在大螢幕上約 100 寬、150 高，名牌在腳下。並排時左右至少 115；
 * 不並排（左右重疊）時前後要差 175 以上 —— 只差半個身位的話，後面那人的
 * 名牌與下半身會被前面那人擋住（2026-10-19 實拍：臨時人物的名字被蓋掉）。
 *
 * @param {number} n 臨時人物的人數
 * @param {{x: number, y: number}[]} occupied 在場的人站的位置
 * @param {Parameters<typeof formationSlots>[1] & {gapX?: number, gapY?: number, step?: number}} field
 * @returns {{x: number, y: number}[]} 最多 n 個；場地塞滿時會少於 n
 */
export function guestSpots(n, occupied, { stage, obstacles, obstacleDistance, gapX = 115, gapY = 175, step = 40 }) {
  if (n <= 0) return [];
  const minX = stage.width * 0.06;
  const maxX = stage.width * 0.94;
  const minY = stage.height * 0.2;
  const maxY = stage.height * 0.92;
  const center = occupied.length
    ? {
      x: occupied.reduce((t, p) => t + p.x, 0) / occupied.length,
      y: occupied.reduce((t, p) => t + p.y, 0) / occupied.length,
    }
    : { x: stage.width / 2, y: stage.height * 0.6 };

  const candidates = [];
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (obstacles.some((o) => obstacleDistance(o, x, y) < o.r + 40)) continue;
      // 縱向權重大一點：人群往左右延伸比往前後疊好看，臉才不會被擋
      candidates.push({ x, y, d: Math.hypot(x - center.x, (y - center.y) * 1.4) });
    }
  }
  candidates.sort((a, b) => a.d - b.d);

  const taken = occupied.map((p) => ({ x: p.x, y: p.y }));
  const clear = (c) => taken.every((p) => Math.abs(c.x - p.x) >= gapX || Math.abs(c.y - p.y) >= gapY);
  const out = [];
  for (const c of candidates) {
    if (out.length >= n) break;
    if (!clear(c)) continue;
    const spot = { x: Math.round(c.x), y: Math.round(c.y) };
    out.push(spot);
    taken.push(spot);
  }
  return out;
}
