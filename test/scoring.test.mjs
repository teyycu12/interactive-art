import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScoring, editableScoring, SCORING_FIELDS, SCORING_MAX } from '../shared/scoring.js';
import { SCORING } from '../server/config.js';

const base = editableScoring(SCORING);

test('只改幾項時，其餘沿用目前的值', () => {
  const r = normalizeScoring({ quizCorrect: 50 }, base);
  assert.equal(r.ok, true);
  assert.equal(r.value.quizCorrect, 50);
  assert.equal(r.value.pairCompletion, base.pairCompletion);
  assert.deepEqual(Object.keys(r.value), SCORING_FIELDS.map((f) => f.key));
});

test('負數、小數、超過上限、不是數字都被拒絕，並說出是哪一項', () => {
  for (const bad of [-1, 1.5, SCORING_MAX + 1, 'abc', null]) {
    const r = normalizeScoring({ bingoLine: bad }, base);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.reason, /賓果每連一線/);
  }
  assert.equal(normalizeScoring(null, base).ok, false);
  assert.equal(normalizeScoring([1, 2], base).ok, false);
});

test('數字字串可以（輸入框送來的是字串），0 分可以（關掉某項加分）', () => {
  const r = normalizeScoring({ quizCorrect: '80', quizSpeedBonus: 0 }, base);
  assert.equal(r.ok, true);
  assert.equal(r.value.quizCorrect, 80);
  assert.equal(r.value.quizSpeedBonus, 0);
});

test('不認得的欄位不會被帶進去（排行榜長度、廣播節流不能從主辦端改）', () => {
  const r = normalizeScoring({ leaderboardSize: 999, broadcastMs: 1 }, base);
  assert.equal(r.ok, true);
  assert.equal('leaderboardSize' in r.value, false);
  assert.equal('broadcastMs' in r.value, false);
});
