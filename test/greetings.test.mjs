/**
 * 揮手：要對方回應才算數（server/greetings.js）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Greetings } from '../server/greetings.js';

const OPTS = { radius: 240, waveWindowMs: 8000 };
const agent = (id, x, y = 500, disconnectedAt = null) => ({ id, x, y, disconnectedAt });
const field = (...list) => new Map(list.map((a) => [a.id, a]));

describe('揮手', () => {
  test('對準最近的人，對方回揮才算互相打招呼', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 200), agent('C', 300));
    assert.deepEqual(g.wave('A', agents, 0), { kind: 'invite', from: 'A', to: 'B' });
    assert.deepEqual(g.wave('B', agents, 1000, 'A'), { kind: 'mutual', a: 'A', b: 'B' });
    // 用掉了：B 再揮一次是新的邀請，不會再算一次成功
    assert.equal(g.wave('B', agents, 1500, 'A').kind, 'invite');
  });

  test('身邊沒有人時回報 nobody，不送邀請', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 900));
    assert.deepEqual(g.wave('A', agents, 0), { kind: 'nobody' });
  });

  test('超過時限才回揮不算', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 200));
    g.wave('A', agents, 0);
    assert.equal(g.wave('B', agents, 9000, 'A').kind, 'invite');
  });

  test('不揮給斷線的人：他的手機收不到邀請', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 150, 500, 123), agent('C', 300));
    assert.deepEqual(g.wave('A', agents, 0), { kind: 'invite', from: 'A', to: 'C' });
  });

  test('指定的回揮對象已經走遠時，改找身邊最近的人', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 900), agent('C', 150));
    assert.deepEqual(g.wave('A', agents, 0, 'B'), { kind: 'invite', from: 'A', to: 'C' });
  });

  test('A 揮給 B、B 卻揮給 C，不算 A 與 B 互相打招呼', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 300), agent('C', 330));
    g.wave('A', agents, 0);                       // A → B
    assert.deepEqual(g.wave('B', agents, 500, 'C'), { kind: 'invite', from: 'B', to: 'C' });
  });

  test('離場的人留下的邀請一併清掉', () => {
    const g = new Greetings(OPTS);
    const agents = field(agent('A', 100), agent('B', 200));
    g.wave('A', agents, 0);
    g.drop('A');
    assert.equal(g.wave('B', agents, 500, 'A').kind, 'invite');
  });
});

test('prune 清掉過期登記', () => {
  const g = new Greetings(OPTS);
  const agents = field(agent('A', 100), agent('B', 200));
  g.wave('A', agents, 0);
  g.prune(10_000);
  assert.equal(g.waves.size, 0);
});

test('替對方補圖示（force）不重設他的冷卻：剛被回揮就按愛心不能被吞掉', async () => {
  const { Stage } = await import('../server/state.js');
  const stage = new Stage();
  const a = stage.addAgent({
    name: 'A',
    avatar: { head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01', accentColor: '#E76F51', skinTone: '#F4A261' },
  });
  a.lastEmoteAt = 0;
  const count = a.emoteCount;
  assert.equal(stage.applyAction(a.id, 'WAVE', { force: true }), true);
  assert.equal(a.emote.action, 'WAVE');
  assert.equal(a.emoteCount, count, '補的圖示不計次');
  assert.equal(stage.applyAction(a.id, 'HEART'), true, '使用者自己的下一次按鍵不受影響');
});

describe('尊重私訊的封鎖', () => {
  // blocks: [by, target] —— by 封鎖了 target
  const withBlocks = (...blocks) => new Greetings({
    ...OPTS,
    isBlocked: (by, target) => blocks.some(([b, t]) => b === by && t === target),
  });

  test('對方封鎖了我：照樣回「已揮出」但標記 silent，且他回揮也湊不成', () => {
    const g = withBlocks(['B', 'A']);
    const agents = field(agent('A', 100), agent('B', 200));
    assert.deepEqual(g.wave('A', agents, 0), { kind: 'invite', from: 'A', to: 'B', silent: true });
    // B 自己封鎖了 A，所以 B 揮手不會選到 A
    assert.deepEqual(g.wave('B', agents, 500), { kind: 'nobody' });
  });

  test('我封鎖了對方：揮手跳過他，改找下一個人', () => {
    const g = withBlocks(['A', 'B']);
    const agents = field(agent('A', 100), agent('B', 150), agent('C', 250));
    assert.deepEqual(g.wave('A', agents, 0), { kind: 'invite', from: 'A', to: 'C' });
    assert.deepEqual(g.wave('A', agents, 1000, 'B'), { kind: 'invite', from: 'A', to: 'C' });
  });
});
