/**
 * 大合照「依互動排位」（server/photoLayout.js）
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { affinityFrom, orderByAffinity, formationSlots, arrangeByAffinity, guestSpots } from '../server/photoLayout.js';
import { Stage } from '../server/state.js';
import { STAGE } from '../shared/protocol.js';
import { OBSTACLES, obstacleDistance } from '../shared/scene.js';
import { AGENT_BODY_DISTANCE } from '../server/config.js';

const AVATAR = { head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01', accentColor: '#E76F51', skinTone: '#F4A261' };
const FIELD = { stage: STAGE, obstacles: OBSTACLES, obstacleDistance };

/** 兩兩之間的互動種類 → peersOf */
function peersFrom(pairs) {
  const by = new Map();
  for (const [a, b, ...via] of pairs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!by.has(x)) by.set(x, []);
      by.get(x).push({ id: y, via });
    }
  }
  return (id) => by.get(id) ?? [];
}

describe('熟悉度', () => {
  test('互動種類越多越熟；配對算得比揮手重', () => {
    const s = affinityFrom(peersFrom([['A', 'B', 'pair', 'topic'], ['A', 'C', 'wave'], ['B', 'C', 'pair']]));
    assert.equal(s('A', 'B'), 3);
    assert.equal(s('B', 'C'), 2);
    assert.equal(s('A', 'C'), 1);
    assert.equal(s('A', 'D'), 0);
    assert.equal(s('A', 'B'), s('B', 'A'), '兩個方向一樣');
  });

  test('只有單方面的互動（賓果填格）算得比較輕', () => {
    const s = affinityFrom((id) => (id === 'A' ? [{ id: 'B', via: ['bingo'] }] : []));
    assert.equal(s('A', 'B'), 0.5);
  });
});

describe('排順序', () => {
  test('熟的人排在隔壁，互不認識的兩群不會交錯', () => {
    // A-B-C 一群、D-E 一群，F 誰都不認識
    const s = affinityFrom(peersFrom([
      ['A', 'B', 'pair', 'topic'], ['B', 'C', 'pair'], ['D', 'E', 'pair', 'wave'],
    ]));
    const order = orderByAffinity(['F', 'E', 'D', 'C', 'B', 'A'], s);
    const at = (id) => order.indexOf(id);
    assert.equal(Math.abs(at('A') - at('B')), 1);
    assert.equal(Math.abs(at('B') - at('C')), 1);
    assert.equal(Math.abs(at('D') - at('E')), 1);
    assert.equal(at('F'), order.length - 1, '誰都不認識的人排在最後，不切開熟人');
  });

  test('同樣的輸入排出同樣的結果（重拍一次隊形不會亂跳）', () => {
    const s = affinityFrom(peersFrom([['A', 'B', 'pair'], ['C', 'D', 'pair']]));
    assert.deepEqual(orderByAffinity(['D', 'C', 'B', 'A'], s), orderByAffinity(['A', 'B', 'C', 'D'], s));
  });
});

describe('隊形站位', () => {
  test('站位不落在道具或牆裡，彼此不會擠在一起', () => {
    const slots = formationSlots(40, FIELD);
    assert.equal(slots.length, 40);
    for (const p of slots) {
      assert.ok(!OBSTACLES.some((o) => obstacleDistance(o, p.x, p.y) < o.r + 30), `(${p.x}, ${p.y}) 在道具裡`);
      assert.ok(p.x > 0 && p.x < STAGE.width && p.y > 0 && p.y < STAGE.height);
    }
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i].x - slots[j].x, slots[i].y - slots[j].y);
        assert.ok(d >= AGENT_BODY_DISTANCE, `站位 ${i}、${j} 只隔 ${d.toFixed(0)}`);
      }
    }
  });

  test('隊形順序上相鄰的兩個站位，在畫面上也相鄰（蛇行，換排不跳到另一頭）', () => {
    // 20 人以內一律接得起來；再多時地板被家具切開，容許少數幾處斷開
    for (const [n, breaks] of [[8, 0], [16, 0], [20, 0], [30, 3], [40, 3]]) {
      const slots = formationSlots(n, FIELD);
      let jumps = 0;
      for (let i = 1; i < slots.length; i++) {
        if (Math.hypot(slots[i].x - slots[i - 1].x, slots[i].y - slots[i - 1].y) > 300) jumps++;
      }
      assert.ok(jumps <= breaks, `${n} 人有 ${jumps} 處換排跳到遠處`);
    }
  });

  test('人少時並肩站成一排，不會一前一後疊在一起（2026-10-18 實拍）', () => {
    for (const n of [2, 3, 6]) {
      const slots = formationSlots(n, FIELD);
      assert.equal(new Set(slots.map((p) => p.y)).size, 1, `${n} 人應該在同一排`);
    }
  });

  test('同一排是連續的一段，不會被桌子從中間切開', () => {
    for (const n of [8, 12, 24, 40]) {
      const rows = new Map();
      for (const p of formationSlots(n, FIELD)) rows.set(p.y, [...(rows.get(p.y) ?? []), p.x]);
      for (const [y, xs] of rows) {
        xs.sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) {
          assert.ok(xs[i] - xs[i - 1] <= 131, `${n} 人：y=${y} 那排在 ${xs[i - 1]}～${xs[i]} 之間斷開`);
        }
      }
    }
  });

  test('隊形置中，不會剩兩三個人另起一排（2026-10-19 30 人實拍）', () => {
    for (const n of [16, 20, 30]) {
      const rows = new Map();
      for (const p of formationSlots(n, FIELD)) rows.set(p.y, [...(rows.get(p.y) ?? []), p.x]);
      const sizes = [...rows.values()].map((xs) => xs.length);
      assert.ok(Math.min(...sizes) >= Math.max(...sizes) - 2, `${n} 人排成 ${sizes.join('／')}`);
      for (const [y, xs] of rows) {
        const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
        assert.ok(Math.abs(mid - STAGE.width / 2) <= 200, `${n} 人：y=${y} 那排中點偏了 ${Math.round(mid - STAGE.width / 2)}`);
      }
    }
  });

  test('前後排左右錯開半格，後排的名牌露在前排兩人之間', () => {
    const slots = formationSlots(30, FIELD);
    for (const b of slots) {
      for (const f of slots) {
        if (f.y > b.y && f.y - b.y < 175) assert.ok(Math.abs(f.x - b.x) >= 60, `(${b.x}, ${b.y}) 正後方有人擋著名牌`);
      }
    }
  });

  test('排位結果每個人都有位置；站位不夠的人留在原地', () => {
    const agents = ['A', 'B', 'C'].map((id, i) => ({ id, x: 100 + i, y: 100 }));
    const out = arrangeByAffinity(agents, () => 0, FIELD);
    assert.equal(out.size, 3);
    const none = arrangeByAffinity(agents, () => 0, { ...FIELD, obstacles: [{ x: 0, y: 0, r: 1e6 }] });
    assert.deepEqual(none.get('A'), { x: 100, y: 100 });
  });
});

test('排位之後角色真的走得到（會繞過道具，不會卡在沙發前面）', () => {
  const stage = new Stage();
  for (let i = 0; i < 16; i++) stage.addAgent({ name: `p${i}`, avatar: AVATAR });
  const agents = [...stage.agents.values()];
  // 全部擠到右上角起跑，離隊形中心遠、中間隔著家具
  agents.forEach((a, i) => { a.x = STAGE.width * 0.9 - (i % 4) * 70; a.y = STAGE.height * 0.25 + Math.floor(i / 4) * 70; });
  const spots = arrangeByAffinity(agents, () => 0, FIELD);
  stage.lockStage(new Map([...spots].map(([id, p]) => [id, { ...p, heading: Math.PI / 2 }])));
  let t = 0;
  while (!stage.allArrived() && t < 12) { stage.tick(1 / 30); t += 1 / 30; }
  // 合照等待上限 12 秒，時間到照樣拍。最後一段是減速接近（速度與剩餘距離成正比），
  // 不一定剛好在 12 秒內「算到位」，但那時人已經站在位置上了 —— 驗的是這件事
  for (const a of agents) {
    const d = Math.hypot(a.x - a.targetX, a.y - a.targetY);
    assert.ok(d < 20, `${a.name} 12 秒後離位置還有 ${d.toFixed(0)}，卡住了`);
  }
});

describe('合照的臨時人物站位（guestSpots，2026-10-19）', () => {
  const field = { stage: STAGE, obstacles: OBSTACLES, obstacleDistance };
  const crowd = [{ x: 1300, y: 640 }, { x: 1430, y: 640 }];

  test('補進人群旁邊，不疊在在場的人或彼此身上、不進家具', () => {
    const spots = guestSpots(6, crowd, field);
    assert.equal(spots.length, 6);
    const all = [...crowd, ...spots];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        // 並排（左右至少一個身位）或前後差一整個身位＋名牌，不能斜斜地疊在後面
        const ok = Math.abs(all[i].x - all[j].x) >= 115 || Math.abs(all[i].y - all[j].y) >= 175;
        assert.ok(ok, `${JSON.stringify(all[i])} 與 ${JSON.stringify(all[j])} 太近`);
      }
    }
    for (const s of spots) {
      assert.ok(OBSTACLES.every((o) => obstacleDistance(o, s.x, s.y) >= o.r + 40), `${s.x},${s.y} 在家具裡`);
    }
    // 離人群不遠：都在人群中心 700 單位內
    for (const s of spots) assert.ok(Math.hypot(s.x - 1365, s.y - 640) < 700);
  });

  test('場上沒人時從地板中間開始排', () => {
    const spots = guestSpots(3, [], field);
    assert.equal(spots.length, 3);
    for (const s of spots) assert.ok(Math.abs(s.x - STAGE.width / 2) < 500);
  });

  test('人數為 0 回傳空陣列；場地塞不下時少給，不硬塞', () => {
    assert.deepEqual(guestSpots(0, crowd, field), []);
    const many = guestSpots(500, crowd, field);
    assert.ok(many.length > 40 && many.length < 500);
  });

  test('依互動排位：沒有座標的臨時人物排不進隊形就不出現', () => {
    const tiny = { ...field, stage: { width: 300, height: 300 }, obstacles: [] };
    const out = arrangeByAffinity([{ id: 'a', x: 100, y: 100 }, { id: 'ghost' }], () => 0, { ...tiny, perRow: 1, dx: 1000 });
    assert.ok(out.has('a'));
    for (const [, p] of out) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  });
});
