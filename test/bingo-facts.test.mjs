/**
 * 賓果自我介紹題的題庫與驗證（shared/bingoFacts.js）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultBingoFacts, validateBingoFacts, factCellLabel, BINGO_FACTS_ASK, BINGO_FACT_LIMITS,
} from '../shared/bingoFacts.js';
import { THEMES } from '../shared/themes.js';

test('每個場景的預設題都夠一輪問，而且本身就通過驗證', () => {
  for (const t of [...THEMES.map((x) => x.id), 'no-such-theme']) {
    const facts = defaultBingoFacts(t);
    assert.ok(facts.length >= BINGO_FACTS_ASK, `${t} 只有 ${facts.length} 題`);
    const r = validateBingoFacts(facts);
    assert.equal(r.ok, true, `${t}：${r.reason}`);
    assert.deepEqual(r.value, facts, `${t} 的預設題被驗證改動了（多了「的人」或重複？）`);
  }
});

test('預設題接上「的人」不會變成「……的人的人」', () => {
  for (const f of defaultBingoFacts('kitchen')) assert.ok(!f.endsWith('的人'), f);
  assert.equal(factCellLabel('會游泳'), '會游泳的人');
});

test('驗證：去空白、去重複、收掉多打的「的人」', () => {
  const r = validateBingoFacts(['  會游泳 ', '會游泳', '', '會游泳的人', '養過貓', '能吃辣的人']);
  assert.deepEqual(r, { ok: true, value: ['會游泳', '養過貓', '能吃辣'] });
});

test('驗證：題數與字數有上下限，不雅字詞擋下', () => {
  assert.equal(validateBingoFacts(['a1', 'b2']).ok, false, '太少');
  assert.equal(validateBingoFacts(Array.from({ length: BINGO_FACT_LIMITS.max + 1 }, (_, i) => `題目${i}`)).ok, false, '太多');
  assert.equal(validateBingoFacts(['會游泳', '養過貓', '一'.repeat(BINGO_FACT_LIMITS.maxLength + 1)]).ok, false, '太長');
  assert.equal(validateBingoFacts(['會游泳', '養過貓', '壞字']).ok, true);
  assert.equal(validateBingoFacts(['會游泳', '養過貓', '壞字'], (t) => t === '壞字').ok, false);
  assert.equal(validateBingoFacts('會游泳').ok, false, '不是陣列');
  assert.equal(validateBingoFacts(['會游泳', 3, '養過貓']).ok, false, '不是字串');
});
