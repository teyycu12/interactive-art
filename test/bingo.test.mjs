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

  test('10 人以上：同一個人在一張卡上只能填一格 —— 逼你去認識不同的人', () => {
    const g = new BingoRound();
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    g.start(ids, [], test_, { now: 0 });   // 全部 STRANGER，誰都符合
    g.claim('p0', 0, 'p1');
    assert.equal(g.claim('p0', 1, 'p1').reason, BINGO_ERRORS.USED);
  });

  describe('稀有的格子可以重複找同一個人（2026-10-19）', () => {
    // 12 人：上限一人一格。只有 r0、r1 會樂器（稀有，≤ 2 人）；人人都符合 STRANGER（常見）
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const RARE = { id: 'fact:0', label: '會樂器的人' };
    const tester = (who, cond, from) => (cond === RARE.id ? ['p1', 'p2'].includes(who) : who !== from);
    function round12(present = () => ids) {
      const g = new BingoRound();
      g.start(ids, [RARE], tester, { now: 0, rng: fixedRng, present });
      return g;
    }
    const rareCell = (g, owner) => g.cardOf(owner).cells.findIndex((c) => c.cond.id === RARE.id);
    const commonCell = (g, owner, skip = -1) => g.cardOf(owner).cells.findIndex((c, i) => i !== skip && c.cond.id === STRANGER && !c.by);

    test('符合的人 ≤ 2：已經填過別格的人也可以填這格', () => {
      const g = round12();
      const rare = rareCell(g, 'p0');
      assert.ok(rare >= 0);
      assert.equal(g.claim('p0', commonCell(g, 'p0', rare), 'p1').ok, true);
      assert.equal(g.claim('p0', rare, 'p1').ok, true, '全場只有兩個人會樂器，不能因為他填過別格就擋');
    });

    test('符合的人多的格子照舊擋下，逼你去找別人', () => {
      const g = round12();
      const rare = rareCell(g, 'p0');
      const first = commonCell(g, 'p0', rare);
      assert.equal(g.claim('p0', first, 'p1').ok, true);
      assert.equal(g.claim('p0', commonCell(g, 'p0', rare), 'p1').reason, BINGO_ERRORS.USED);
    });

    test('稀不稀有只算在線的人：會樂器的第三人斷線了，這格就算稀有', () => {
      const tester3 = (who, cond, from) => (cond === RARE.id ? ['p1', 'p2', 'p3'].includes(who) : who !== from);
      const online = ids.filter((id) => id !== 'p3');
      const g = new BingoRound();
      g.start(ids, [RARE], tester3, { now: 0, rng: fixedRng, present: () => online });
      const rare = rareCell(g, 'p0');
      assert.equal(g.matchCount(RARE.id, 'p0'), 2);
      assert.equal(g.claim('p0', commonCell(g, 'p0', rare), 'p1').ok, true);
      assert.equal(g.claim('p0', rare, 'p1').ok, true);
    });

    test('沒給 present 時不放寬（照舊只看人數上限）', () => {
      const g = new BingoRound();
      g.start(ids, [RARE], tester, { now: 0, rng: fixedRng });
      const rare = rareCell(g, 'p0');
      assert.equal(g.claim('p0', commonCell(g, 'p0', rare), 'p1').ok, true);
      assert.equal(g.claim('p0', rare, 'p1').reason, BINGO_ERRORS.USED);
    });
  });

  test('人少時同一個人可以填不只一格，否則 9 格永遠填不滿', () => {
    const g = new BingoRound();
    const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);   // 其他人 7 位 → 一人最多 2 格
    g.start(ids, [], test_, { now: 0 });
    assert.equal(g.maxUses(), 2);
    assert.equal(g.claim('p0', 0, 'p1').ok, true);
    assert.equal(g.claim('p0', 1, 'p1').ok, true);
    assert.equal(g.claim('p0', 2, 'p1').reason, BINGO_ERRORS.USED);
    // 其他 6 位各填一格就湊滿 9 格
    // 剩下 7 格給其他 6 位（p2 填兩格）
    for (const [k, who] of ['p2', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].entries()) {
      assert.equal(g.claim('p0', 2 + k, who).ok, true, `第 ${2 + k} 格`);
    }
    assert.equal(g.cardOf('p0').cells.every((c) => c.by), true);
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

describe('每類格子最多 3 格', () => {
  test('同一類的條件再多，一張卡上也最多 3 格；不夠時才放寬', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `color:${i}`, label: `c${i}` }));
    const few = [{ id: 'persona:x', label: 'x' }, { id: 'fact:0', label: 'f' }];
    const everyone = () => true;
    const g = new BingoRound();
    g.start(['a', 'b', 'c'], [...many, ...few], everyone, { now: 0, rng: fixedRng });
    const kinds = g.cardOf('a').cells.map((c) => c.cond.id.split(':')[0]);
    assert.ok(kinds.includes('persona') && kinds.includes('fact'), '少數類別一定要放進來');
    // 只有 2 格非顏色，所以顏色要放寬到 7 格補滿，而不是留成 STRANGER
    assert.equal(kinds.filter((k) => k === 'color').length, 7);

    const balanced = [...many, ...Array.from({ length: 4 }, (_, i) => ({ id: `persona:${i}`, label: `p${i}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `fact:${i}`, label: `f${i}` }))];
    const h = new BingoRound();
    h.start(['a', 'b'], balanced, everyone, { now: 0, rng: fixedRng });
    const k2 = h.cardOf('a').cells.map((c) => c.cond.id.split(':')[0]);
    for (const kind of ['color', 'persona', 'fact']) assert.equal(k2.filter((k) => k === kind).length, 3, kind);
  });
});

describe('開局先問自我介紹題', () => {
  const FACTS = ['今天是第一次來', '會一種樂器'];
  // fact:<題號> 由 BingoRound 自己記，判定時要回頭問它
  const withFacts = (g) => (who, cond, from) => {
    if (cond.startsWith('fact:')) return g.hasFact(who, cond.slice(5));
    return test_(who, cond, from);
  };

  function asking(ids = ['a', 'b', 'c']) {
    const g = new BingoRound();
    g.start(ids, [], withFacts(g), { now: 0, facts: FACTS, askMs: 30_000, durationMs: 60_000 });
    return g;
  }

  test('有題目時先問、不發卡；全部答完就發，計時從發卡算起', () => {
    const g = asking();
    assert.equal(g.phase, 'ask');
    assert.equal(g.cardOf('a'), null);
    g.answerFacts('a', ['0']);
    g.answerFacts('b', []);
    assert.equal(g.readyToPlay(['a', 'b', 'c'], 1000), false);
    g.answerFacts('c', ['0', '1']);
    assert.equal(g.readyToPlay(['a', 'b', 'c'], 1000), true);
    g.beginPlay(['a', 'b', 'c'], 1000);
    assert.equal(g.phase, 'play');
    assert.equal(g.round.endsAt, 61_000);
    assert.equal(g.shouldAutoEnd(60_999), false);
  });

  test('預設不限時（2026-10-19）：沒給 askMs 時，等多久都要大家答完才發卡', () => {
    const g = new BingoRound();
    g.start(['a', 'b'], [], withFacts(g), { now: 0, facts: FACTS });
    assert.equal(g.round.askEndsAt, null);
    g.answerFacts('a', ['0']);
    assert.equal(g.readyToPlay(['a', 'b'], 10 * 60 * 1000), false, '十分鐘後也不自己發卡');
    g.answerFacts('b', []);
    assert.equal(g.readyToPlay(['a', 'b'], 10 * 60 * 1000), true);
  });

  test('有人沒答，時間到也照樣發卡', () => {
    const g = asking();
    g.answerFacts('a', ['0']);
    assert.equal(g.readyToPlay(['a', 'b', 'c'], 29_999), false);
    assert.equal(g.readyToPlay(['a', 'b', 'c'], 30_000), true);
  });

  test('卡上出現「〔題目〕的人」，只放場上有別人勾過的題目', () => {
    const g = asking();
    g.answerFacts('a', []);
    g.answerFacts('b', ['0']);   // 只有 b 勾了「第一次來」，沒有人勾「會樂器」
    g.answerFacts('c', []);
    g.beginPlay(['a', 'b', 'c'], 0);
    const labels = g.cardOf('a').cells.map((c) => c.cond.label);
    assert.ok(labels.includes('今天是第一次來的人'));
    assert.ok(!labels.includes('會一種樂器的人'), '沒人勾的題目不該出現');
    assert.ok(!g.cardOf('b').cells.some((c) => c.cond.label === '今天是第一次來的人'), 'b 自己勾的對 b 沒有別人可找');
    const i = g.cardOf('a').cells.findIndex((c) => c.cond.label === '今天是第一次來的人');
    assert.equal(g.claim('a', i, 'c').reason, BINGO_ERRORS.MISMATCH);
    assert.equal(g.claim('a', i, 'b').ok, true);
  });

  test('只收這一輪有的題號', () => {
    const g = asking();
    g.answerFacts('a', ['0', '99', 5, null]);
    assert.equal(g.hasFact('a', '0'), true);
    assert.equal(g.hasFact('a', '99'), false);
  });

  test('沒有題目就直接發卡', () => {
    const g = new BingoRound();
    g.start(['a', 'b'], POOL, test_, { now: 0 });
    assert.equal(g.phase, 'play');
    assert.ok(g.cardOf('a'));
  });
});

describe('被找的人順便填', () => {
  // b 的卡：第 0 格「RED」，其餘都是 a 不符合的條件；a 是 RED
  const PEOPLE2 = { a: ['RED'], b: [], c: ['BLUE'] };
  const t2 = (who, cond) => (PEOPLE2[who] ?? []).includes(cond);
  function setup() {
    const g = new BingoRound();
    g.start(['a', 'b', 'c'], [{ id: 'RED', label: 'r' }, { id: 'BLUE', label: 'b' }], t2, { now: 0, rng: fixedRng });
    // 直接排好 b 的卡，不靠洗牌
    g.cardOf('b').cells = [{ id: 'RED' }, { id: 'BLUE' }, ...Array(7).fill({ id: 'BLUE' })]
      .map((cond) => ({ cond: { ...cond, label: cond.id }, by: null }));
    return g;
  }

  test('a 符合 b 卡上空著的一格：b 收到邀請，收下就填上，只能收一次', () => {
    const g = setup();
    assert.deepEqual(g.offerFor('b', 'a', 0), { cell: 0, label: 'RED' });
    const r = g.acceptOffer('b', 1000);
    assert.equal(r.ok, true);
    assert.equal(r.from, 'a');
    assert.equal(g.cardOf('b').cells[0].by, 'a');
    assert.equal(g.acceptOffer('b', 1000).reason, BINGO_ERRORS.NO_OFFER);
  });

  test('a 不符合 b 任何空格時沒有邀請', () => {
    const g = setup();
    assert.equal(g.offerFor('b', 'c', 0)?.label, 'BLUE');
    g.cardOf('b').cells[0].by = 'c';   // RED 那格先被填掉
    assert.equal(g.offerFor('b', 'a', 0), null);
  });

  test('邀請會過期；這段時間格子被填掉了就收不了', () => {
    const g = setup();
    g.offerFor('b', 'a', 0);
    assert.equal(g.acceptOffer('b', 91_000).reason, BINGO_ERRORS.NO_OFFER);
    g.offerFor('b', 'a', 0);
    g.cardOf('b').cells[0].by = 'c';
    assert.equal(g.acceptOffer('b', 1000).reason, BINGO_ERRORS.FILLED);
  });

  test('優先邀請填了會連成線的那一格', () => {
    const g = new BingoRound();
    g.start(['a', 'b', 'c', 'd'], [], test_, { now: 0 });   // 全部 STRANGER，誰都符合
    g.claim('b', 0, 'c');
    g.claim('b', 1, 'd');
    assert.equal(g.offerFor('b', 'a', 0).cell, 2, '第一橫列只差第 2 格');
  });
});
