/**
 * 話題桌（server/topics.js）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TopicTables } from '../server/topics.js';

const OPTS = { questions: ['Q1', 'Q2', 'Q3'], reach: 90, dwellMs: 2000, groupCooldownMs: 90_000, tableGapMs: 15_000 };
const SPOT = [{ id: 'k_dining', x: 1000, y: 500, r: 70, label: '1號桌' }];
const at = (id, x = 1000, y = 500, disconnectedAt = null) => ({ id, x, y, disconnectedAt });

test('兩人在桌旁停留夠久才發題，在場的人拿到同一題', () => {
  const t = new TopicTables(OPTS);
  const people = [at('a', 1050), at('b', 960)];
  assert.deepEqual(t.update(SPOT, people, 0), []);
  assert.deepEqual(t.update(SPOT, people, 1999), [], '還沒停留夠久');
  const [deal] = t.update(SPOT, people, 2000);
  assert.deepEqual(deal.ids, ['a', 'b']);
  assert.equal(deal.label, '1號桌');
  assert.ok(OPTS.questions.includes(deal.question));
});

test('一個人坐在桌邊什麼都不會發生', () => {
  const t = new TopicTables(OPTS);
  assert.deepEqual(t.update(SPOT, [at('a')], 0), []);
  assert.deepEqual(t.update(SPOT, [at('a')], 10_000), []);
});

test('路過的人不算：組合一變，停留時間重算', () => {
  const t = new TopicTables(OPTS);
  t.update(SPOT, [at('a'), at('b')], 0);
  t.update(SPOT, [at('a'), at('b'), at('c')], 1500);   // c 路過
  assert.deepEqual(t.update(SPOT, [at('a'), at('b'), at('c')], 2500), [], 'c 才待了 1 秒');
  assert.equal(t.update(SPOT, [at('a'), at('b'), at('c')], 3500).length, 1);
});

test('同一組人在冷卻內不重發；有新的人加入（且過了桌子間隔）才換題', () => {
  const t = new TopicTables(OPTS);
  const ab = [at('a'), at('b')];
  t.update(SPOT, ab, 0);
  assert.equal(t.update(SPOT, ab, 2000).length, 1);
  assert.deepEqual(t.update(SPOT, ab, 60_000), [], '同一組人 90 秒內不重發');
  const abc = [...ab, at('c')];
  t.update(SPOT, abc, 60_000);
  assert.equal(t.update(SPOT, abc, 62_000).length, 1, '新組合停留夠久就發');
});

test('斷線的角色不算坐在桌邊', () => {
  const t = new TopicTables(OPTS);
  const people = [at('a'), at('b', 1000, 500, 123)];
  t.update(SPOT, people, 0);
  assert.deepEqual(t.update(SPOT, people, 5000), []);
});

test('太遠不算', () => {
  const t = new TopicTables(OPTS);
  const people = [at('a'), at('b', 1000 + 70 + 91)];
  t.update(SPOT, people, 0);
  assert.deepEqual(t.update(SPOT, people, 5000), []);
});

test('主辦端關掉時不發題', () => {
  const t = new TopicTables(OPTS);
  t.setEnabled(false);
  const people = [at('a'), at('b')];
  t.update(SPOT, people, 0);
  assert.deepEqual(t.update(SPOT, people, 5000), []);
});

test('抽完一輪才重複', () => {
  const t = new TopicTables({ ...OPTS, groupCooldownMs: 0, tableGapMs: 0 });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const people = [at('a'), at(`p${i}`)];
    t.update(SPOT, people, i * 10_000);
    seen.push(t.update(SPOT, people, i * 10_000 + 2000)[0].question);
  }
  assert.equal(new Set(seen).size, 3);
});
