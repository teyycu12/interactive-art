import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERSONA_QUIZ, PERSONA_LIMITS, PERSONA_RESULTS, CHAMELEON, PERSONA_TYPES,
  validatePersonaQuiz, scorePersona, personaQuizVersion,
} from '../shared/persona.js';

const quiz = DEFAULT_PERSONA_QUIZ;
// 預設題目每題的選項順序都是 D, I, S, C
const pick = (...types) => types.map((t) => 'DISC'.indexOf(t));

test('預設題目本身合格，而且每一題四型都選得到', () => {
  const r = validatePersonaQuiz(quiz);
  assert.equal(r.ok, true, r.reason);
  assert.ok(quiz.questions.length >= PERSONA_LIMITS.minQuestions && quiz.questions.length <= PERSONA_LIMITS.maxQuestions);
  for (const q of quiz.questions) assert.deepEqual(q.options.map((o) => o.type).sort(), ['C', 'D', 'I', 'S']);
});

test('明顯偏向某一型時判定為該型', () => {
  assert.equal(scorePersona(quiz, pick('D', 'D', 'D', 'D')), PERSONA_TYPES.D);
  assert.equal(scorePersona(quiz, pick('I', 'I', 'S', 'C')), PERSONA_TYPES.I);
  assert.equal(scorePersona(quiz, pick('S', 'C', 'S', 'D')), PERSONA_TYPES.S);
  assert.equal(scorePersona(quiz, pick('C', 'C', 'C', 'I')), PERSONA_TYPES.C);
});

test('打平或沒有任何一型拿到 2 票時判定為變色龍', () => {
  assert.equal(scorePersona(quiz, pick('D', 'I', 'S', 'C')), CHAMELEON, '四型各一票');
  assert.equal(scorePersona(quiz, pick('D', 'D', 'I', 'I')), CHAMELEON, '兩型打平');
});

test('作答不完整或不合格時不判定（不要給人一個亂猜的標籤）', () => {
  assert.equal(scorePersona(quiz, pick('D', 'D', 'D')), null, '少一題');
  assert.equal(scorePersona(quiz, [0, 0, 0, 9]), null, '選項超出範圍');
  assert.equal(scorePersona(quiz, [0, 0, 0, 1.5]), null);
  assert.equal(scorePersona(quiz, 'DDDD'), null);
  assert.equal(scorePersona(null, [0]), null);
});

test('五種結果的 id 不重複，且都有完整說明', () => {
  assert.equal(new Set(PERSONA_RESULTS.map((t) => t.id)).size, 5);
  for (const t of PERSONA_RESULTS) for (const k of ['emoji', 'name', 'style', 'strengths', 'cautions']) assert.ok(t[k], `${t.id}.${k}`);
});

test('主辦端改的題目：題數、選項數、字數、類型都要驗', () => {
  const q = (n, opts = 4) => ({ questions: Array.from({ length: n }, (_, i) => ({ text: `題${i}`, options: Array.from({ length: opts }, (_, j) => ({ label: `選${j}`, type: 'DISC'[j % 4] })) })) });
  assert.equal(validatePersonaQuiz(q(3)).ok, true);
  assert.equal(validatePersonaQuiz(q(5)).ok, true);
  assert.equal(validatePersonaQuiz(q(2)).ok, false, '少於 3 題');
  assert.equal(validatePersonaQuiz(q(6)).ok, false, '多於 5 題');
  assert.equal(validatePersonaQuiz(q(3, 1)).ok, false, '選項太少');
  assert.equal(validatePersonaQuiz(q(3, 5)).ok, false, '選項太多');
  const long = q(3); long.questions[0].text = '長'.repeat(PERSONA_LIMITS.maxQuestionLength + 1);
  assert.equal(validatePersonaQuiz(long).ok, false, '題目超長不截斷');
  const badType = q(3); badType.questions[1].options[0].type = 'X';
  assert.equal(validatePersonaQuiz(badType).ok, false, '變色龍不是選項');
  const proto = q(3); proto.questions[1].options[0].type = '__proto__';
  assert.equal(validatePersonaQuiz(proto).ok, false);
  const blank = q(3); blank.questions[2].options[1].label = '   ';
  assert.equal(validatePersonaQuiz(blank).ok, false);
  assert.equal(validatePersonaQuiz(null).ok, false);
});

test('驗證會剝除控制字元、去頭尾空白，只留白名單欄位', () => {
  const raw = { questions: DEFAULT_PERSONA_QUIZ.questions.map((q) => ({ ...q, extra: '<script>' })) };
  raw.questions[0] = { ...raw.questions[0], text: '  你好\n嗎  ' };
  const r = validatePersonaQuiz(raw);
  assert.equal(r.value.questions[0].text, '你好嗎');
  assert.equal('extra' in r.value.questions[1], false);
});

test('題目一改，版本就不同（手機用它判斷答的是不是現在這份）', () => {
  const a = personaQuizVersion(quiz);
  const edited = structuredClone(quiz); edited.questions[0].text = '換個題目';
  assert.equal(personaQuizVersion(structuredClone(quiz)), a);
  assert.notEqual(personaQuizVersion(edited), a);
});
