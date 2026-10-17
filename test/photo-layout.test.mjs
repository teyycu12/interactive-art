/**
 * 大合照「依互動排位」（server/photoLayout.js）
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { affinityFrom, orderByAffinity, formationSlots, arrangeByAffinity } from '../server/photoLayout.js';
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
    const slots = formationSlots(30, FIELD);
    for (let i = 1; i < slots.length; i++) {
      const d = Math.hypot(slots[i].x - slots[i - 1].x, slots[i].y - slots[i - 1].y);
      assert.ok(d < 300, `第 ${i - 1}→${i} 個站位隔了 ${d.toFixed(0)}`);
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
  assert.ok(stage.allArrived(), `12 秒內沒有全部到位（合照的等待上限是 12 秒）`);
});
