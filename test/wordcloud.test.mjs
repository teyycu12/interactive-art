import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WordCloudSession, WORDCLOUD_ERRORS as E } from '../server/wordcloud.js';
import { WORDCLOUD, cleanAnswer, wordKey } from '../shared/wordcloud.js';
import { TraitStore } from '../server/traits.js';

const started = () => { const w = new WordCloudSession(); w.start({ question: '用一個詞形容今天' }); return w; };

test('出題：題目必填、有長度上限、同時只能一題', () => {
  const w = new WordCloudSession();
  assert.equal(w.start({ question: '  ' }).ok, false);
  assert.equal(w.start({ question: '長'.repeat(WORDCLOUD.maxQuestionLength + 1) }).ok, false);
  const r = w.start({ question: ' 今天\n心情 ' });
  assert.equal(r.ok, true);
  assert.equal(r.round.question, '今天 心情');
  assert.equal(w.start({ question: '第二題' }).ok, false);
});

test('同一個詞的不同寫法彙整成一個：全形、大小寫、空白、標點', () => {
  assert.equal(wordKey('開心！'), wordKey('開 心'));
  assert.equal(wordKey('ＨＡＰＰＹ'), wordKey('happy'));
  const w = started();
  w.answer('a', '開心');
  w.answer('b', '開心！');
  w.answer('c', ' 開 心 ');
  w.answer('d', '累');
  assert.deepEqual(w.cloud().words, [{ text: '開心', count: 3 }, { text: '累', count: 1 }]);
  assert.equal(w.cloud().participants, 4);
});

test('每人最多 maxPerPerson 個、自己不能重複送同一個詞', () => {
  const w = started();
  for (let i = 0; i < WORDCLOUD.maxPerPerson; i++) assert.equal(w.answer('a', `詞${i}`).ok, true);
  assert.equal(w.answer('a', '再一個').reason, E.LIMIT);
  const w2 = started();
  w2.answer('a', '開心');
  const dup = w2.answer('a', '開心!!');
  assert.equal(dup.reason, E.DUPLICATE);
  assert.deepEqual(dup.mine, ['開心']);
});

test('空白、超長、不雅字、沒有題目時都被拒絕', () => {
  const w = started();
  assert.equal(w.answer('a', '   ').reason, E.EMPTY);
  assert.equal(w.answer('a', '!!!').reason, E.EMPTY, '只有標點等於沒寫');
  assert.equal(w.answer('a', '字'.repeat(WORDCLOUD.maxAnswerLength + 1)).reason, E.TOO_LONG);
  assert.equal(w.answer('a', '幹你娘').reason, E.BLOCKED);
  assert.equal(w.cloud().words.length, 0);
  assert.equal(new WordCloudSession().answer('a', '嗨').reason, E.NO_ROUND);
});

test('控制字元與零寬字元被剝除（答案會投到大螢幕）', () => {
  assert.equal(cleanAnswer('開​心\n'), '開心');
  assert.equal(cleanAnswer(42), '');
});

test('主持人隱藏的詞不再出現，之後有人再送也一樣；送的人不知道被藏', () => {
  const w = started();
  w.answer('a', '討厭鬼');
  w.answer('b', '開心');
  assert.equal(w.hide('討厭鬼'), true);
  assert.equal(w.hide('討厭鬼'), false, '重複隱藏不算');
  assert.deepEqual(w.cloud().words.map((x) => x.text), ['開心']);
  const r = w.answer('c', '討厭鬼！');
  assert.equal(r.ok, true, '對送的人仍是成功');
  assert.equal(r.added, false);
  assert.deepEqual(w.cloud().words.map((x) => x.text), ['開心']);
});

test('大螢幕只拿票數最高的 maxShown 個，同票先送先排', () => {
  const w = started();
  for (let i = 0; i < WORDCLOUD.maxShown + 10; i++) w.answer(`p${i}`, `詞${i}`);
  w.answer('x', '詞5');
  const words = w.cloud().words;
  assert.equal(words.length, WORDCLOUD.maxShown);
  assert.deepEqual(words[0], { text: '詞5', count: 2 });
  assert.equal(words[1].text, '詞0');
});

test('收題留下摘要（給活動報告），重連可查回自己送過的答案', () => {
  const w = started();
  w.answer('a', '開心'); w.answer('a', '期待');
  assert.deepEqual(w.mineOf('a'), ['開心', '期待']);
  const s = w.close();
  assert.equal(s.question, '用一個詞形容今天');
  assert.equal(s.participants, 1);
  assert.equal(w.isActive, false);
  assert.deepEqual(w.mineOf('a'), []);
  const restored = new WordCloudSession().hydrate(JSON.parse(JSON.stringify(w.export())));
  assert.equal(restored.history.length, 1);
  assert.equal(restored.isActive, false);
});

test('標籤儲存：寫入、查詢、分佈、遺忘，存檔格式沿用舊的 survey.traits', () => {
  const t = new TraitStore();
  t.setTrait('a', 'persona', { value: 'tiger', label: '🐯 老虎' });
  t.setTrait('b', 'persona', { value: 'tiger', label: '🐯 老虎' });
  t.setTrait('c', 'persona', { value: 'owl', label: '🦉 貓頭鷹' });
  assert.deepEqual(t.traitsOf('a'), { persona: { value: 'tiger', label: '🐯 老虎' } });
  assert.deepEqual(t.agentsWith('persona', 'tiger'), ['a', 'b']);
  assert.equal(t.spread('persona', (id) => id !== 'b').get('tiger'), 1);
  t.forget('a');
  assert.equal(t.traitOf('a', 'persona'), null);
  const old = [{ agentId: 'z', tags: { persona: { value: 'koala', label: '🐨 無尾熊' } } }];
  assert.equal(new TraitStore().hydrate(old).traitOf('z', 'persona').value, 'koala');
  assert.deepEqual(new TraitStore().hydrate(t.export()).export(), t.export());
});

test('顯示用的文字保留中文全形標點，只有彙整時才正規化', () => {
  assert.equal(cleanAnswer('今天最難忘的一刻？'), '今天最難忘的一刻？');
  assert.equal(wordKey('ＯＫ！'), wordKey('ok'));
});
