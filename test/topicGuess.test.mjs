/**
 * 話題桌的猜對方（server/topicGuess.js）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TopicGuess } from '../server/topicGuess.js';
import { TOPIC_QUESTIONS, askFor } from '../shared/topics.js';

const Q = { ask: '{who}的早餐通常吃什麼？', options: ['中式', '西式', '不吃'] };
const make = () => new TopicGuess({ roundMs: 180_000 });

test('分配是一個圈：兩人互猜，三人每人恰好猜一個、被一個猜', () => {
  const g = make();
  assert.deepEqual(g.start(['a', 'b'], Q, 0).assignments, [{ id: 'a', target: 'b' }, { id: 'b', target: 'a' }]);
  const { assignments } = g.start(['a', 'b', 'c'], Q, 0);
  assert.deepEqual(assignments.map((x) => x.target), ['b', 'c', 'a']);
});

test('猜的人與被猜的人都送出後才揭曉，先後順序不影響', () => {
  const g = make();
  const { round } = g.start(['a', 'b'], Q, 0);
  // a 先猜，b 還沒答自己的
  assert.deepEqual(g.guess('a', round, 1, 10).reveals, []);
  const r = g.answerSelf('b', round, 1, 20);
  assert.deepEqual(r.reveals, [{ round, guesser: 'a', target: 'b', guess: 1, answer: 1, correct: true }]);
  // b 的自己答案先到、b 再猜 a
  assert.deepEqual(g.answerSelf('a', round, 0, 30).reveals, []);
  const r2 = g.guess('b', round, 2, 40);
  assert.equal(r2.reveals[0].correct, false);
  assert.equal(r2.reveals[0].answer, 0);
});

test('只能猜一次、自己的答案也只能選一次', () => {
  const g = make();
  const { round } = g.start(['a', 'b'], Q, 0);
  assert.equal(g.guess('a', round, 0, 1).ok, true);
  assert.equal(g.guess('a', round, 1, 2).reason, 'ALREADY');
  assert.equal(g.answerSelf('b', round, 0, 3).ok, true);
  assert.equal(g.answerSelf('b', round, 1, 4).reason, 'ALREADY');
});

test('不在這回合的人、亂給的選項、過期的回合都擋下', () => {
  const g = make();
  const { round } = g.start(['a', 'b'], Q, 0);
  assert.equal(g.guess('x', round, 0, 1).reason, 'GONE');
  assert.equal(g.guess('a', 999, 0, 1).reason, 'GONE');
  assert.equal(g.guess('a', round, 3, 1).reason, 'BAD_CHOICE');
  assert.equal(g.guess('a', round, '1', 1).reason, 'BAD_CHOICE');
  assert.equal(g.guess('a', round, 0, 180_001).reason, 'GONE');
});

test('還沒做完的人算忙碌（話題桌不換題）；做完或過期就不算', () => {
  const g = make();
  const { round } = g.start(['a', 'b'], Q, 0);
  assert.equal(g.isBusy('a', 1), true);
  g.answerSelf('a', round, 0, 2);
  g.guess('a', round, 0, 3);
  assert.equal(g.isBusy('a', 4), true, '還在等 b 答自己的');
  g.answerSelf('b', round, 0, 5);
  assert.equal(g.isBusy('a', 6), false);
  assert.equal(g.isBusy('b', 6), true, 'b 還沒猜');
  assert.equal(g.isBusy('b', 180_001), false, '過期就放掉');
});

test('過期時回報還沒做完的回合給手機收卡，做完的就不吵', () => {
  const g = make();
  const r1 = g.start(['a', 'b'], Q, 0).round;
  const r2 = g.start(['c', 'd'], Q, 0).round;
  g.answerSelf('a', r1, 0, 1); g.answerSelf('b', r1, 0, 1);
  g.guess('a', r1, 0, 1); g.guess('b', r1, 0, 1);
  assert.deepEqual(g.expire(180_001), [{ round: r2, ids: ['c', 'd'] }]);
  assert.equal(g.rounds.size, 0);
});

test('題庫：每題 {who} 兩種讀法都通、選項 3～4 個且不重複', () => {
  for (const q of TOPIC_QUESTIONS) {
    assert.ok(q.ask.includes('{who}'), q.ask);
    assert.ok(!askFor(q, '你').includes('{who}'));
    assert.ok(q.options.length >= 3 && q.options.length <= 4, q.ask);
    assert.equal(new Set(q.options).size, q.options.length, q.ask);
  }
});
