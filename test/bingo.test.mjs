/**
 * 人物賓果（server/bingo.js）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BingoRound, BINGO_ERRORS, BINGO_LINES, STRANGER } from '../server/bingo.js';

// 測試用的人與條件：每個人身上有一組條件 id
const PEOPLE = {
  a: ['RED', 'tiger'],
  b: ['RED', 'owl'],
  c: ['BLUE', 'owl'],
  d: ['BLUE', 'koala'],
  e: ['GREEN', 'tiger'],
};
const POOL = ['RED', 'BLUE', 'GREEN', 'tiger', 'owl', 'koala', 'peacock'].map((id) => ({ id, label: id }));
const test_ = (who, cond, from) => (cond === STRANGER ? who !== from : (PEOPLE[who] ?? []).includes(cond));
const fixedRng = () => 0.42;

function started() {
  const g = new BingoRound();
  const r = g.start(Object.keys(PEOPLE), POOL, test_, { rng: fixedRng, now: 0 });
  assert.equal(r.ok, true, r.reason);
  return g;
}

describe('發卡', () => {
  test('每人一張 9 格的卡，條件不重複', () => {
    const g = started();
    const card = g.cardOf('a');
    assert.equal(card.cells.length, 9);
    const ids = card.cells.map((c) => c.cond.id).filter((id) => id !== STRANGER);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('不放場上沒人符合的條件（peacock 沒有人是）', () => {
    const g = started();
    for (const id of Object.keys(PEOPLE)) {
      assert.ok(!g.cardOf(id).cells.some((c) => c.cond.id === 'peacock'), id);
    }
  });

  test('只有自己符合的條件也不放：e 是唯一穿 GREEN 的，e 的卡上不能有 GREEN', () => {
    const g = started();
    assert.ok(!g.cardOf('e').cells.some((c) => c.cond.id === 'GREEN'));
  });

  test('條件不夠 9 格時用「還不認識的人」補', () => {
    const g = started();
    assert.ok(g.cardOf('a').cells.some((c) => c.cond.id === STRANGER));
  });

  test('至少要兩個人才能開始', () => {
    const g = new BingoRound();
    assert.equal(g.start(['a'], POOL, test_).ok, false);
  });

  test('中途進場的人也拿得到卡', () => {
    const g = started();
    PEOPLE.f = ['RED'];
    const card = g.dealCard('f', [...Object.keys(PEOPLE)]);
    assert.equal(card.cells.length, 9);
    delete PEOPLE.f;
  });
});

describe('填格', () => {
  const cellOf = (g, who, condId) => g.cardOf(who).cells.findIndex((c) => c.cond.id === condId);

  test('符合條件就填上', () => {
    const g = started();
    const i = cellOf(g, 'a', 'owl');
    const r = g.claim('a', i, 'b');
    assert.equal(r.ok, true);
    assert.equal(g.cardOf('a').cells[i].by, 'b');
  });

  test('不符合條件被拒', () => {
    const g = started();
    assert.equal(g.claim('a', cellOf(g, 'a', 'owl'), 'd').reason, BINGO_ERRORS.MISMATCH);
  });

  test('同一個人在一張卡上只能填一格 —— 逼你去認識不同的人', () => {
    const g = started();
    g.claim('a', cellOf(g, 'a', 'owl'), 'c');
    assert.equal(g.claim('a', cellOf(g, 'a', 'BLUE'), 'c').reason, BINGO_ERRORS.USED);
  });

  test('不能填自己、不能重填、格子編號要合法', () => {
    const g = started();
    const i = cellOf(g, 'a', STRANGER);
    assert.equal(g.claim('a', i, 'a').reason, BINGO_ERRORS.SELF);
    g.claim('a', i, 'b');
    assert.equal(g.claim('a', i, 'c').reason, BINGO_ERRORS.FILLED);
    assert.equal(g.claim('a', 9, 'c').reason, BINGO_ERRORS.BAD_CELL);
    assert.equal(g.claim('a', '1', 'c').reason, BINGO_ERRORS.BAD_CELL);
  });

  test('連成一線時回報新的連線數', () => {
    const g = new BingoRound();
    // 每格都是 STRANGER：任何其他人都符合，方便湊線
    g.start(['a', 'b', 'c', 'd', 'e'], [], test_, { now: 0 });
    const [l0] = BINGO_LINES;   // 第一橫列 0,1,2
    assert.equal(g.claim('a', l0[0], 'b').newLines, 0);
    assert.equal(g.claim('a', l0[1], 'c').newLines, 0);
    const r = g.claim('a', l0[2], 'd');
    assert.equal(r.newLines, 1);
    assert.equal(r.full, false);
  });

  test('沒有進行中的一輪時拒絕', () => {
    const g = new BingoRound();
    assert.equal(g.claim('a', 0, 'b').reason, BINGO_ERRORS.NO_ROUND);
  });
});

test('限時到點自動結束', () => {
  const g = new BingoRound();
  g.start(['a', 'b'], POOL, test_, { durationMs: 1000, now: 0 });
  assert.equal(g.shouldAutoEnd(999), false);
  assert.equal(g.shouldAutoEnd(1000), true);
});

test('8 條線：三橫三直兩斜', () => {
  assert.equal(BINGO_LINES.length, 8);
  assert.deepEqual(BINGO_LINES[6], [0, 4, 8]);
  assert.deepEqual(BINGO_LINES[7], [2, 4, 6]);
});
