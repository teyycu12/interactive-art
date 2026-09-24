import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurveySession } from '../server/survey.js';
import { SURVEY, SURVEY_BANK, SURVEY_BANK_MAP, surveysForTheme } from '../shared/surveys.js';
import { PROPS } from '../shared/scene.js';
import { THEME_MAP } from '../shared/themes.js';

const custom = {
  key: 'drink', question: '咖啡還是茶？',
  options: [{ value: 'coffee', label: '咖啡' }, { value: 'tea', label: '茶' }],
};

test('題庫的地點指向真實存在的道具，主題也要存在', () => {
  const ids = new Set(PROPS.map((p) => p.id));
  for (const q of SURVEY_BANK) {
    assert.ok(q.options.length >= SURVEY.minOptions && q.options.length <= SURVEY.maxOptions, q.id);
    assert.ok(q.question.length <= SURVEY.maxQuestionLength, q.id);
    if (q.theme !== null) assert.ok(THEME_MAP[q.theme], `${q.id} 指向不存在的主題 ${q.theme}`);
    for (const o of q.options) {
      assert.ok(o.label.length <= SURVEY.maxOptionLength, `${q.id} ${o.label}`);
      // 指到不存在的道具，等於叫全場去一張不存在的桌子，而畫面上不會有任何錯誤
      if (o.spot) assert.ok(ids.has(o.spot), `${q.id} 的 ${o.value} 指向不存在的道具 ${o.spot}`);
    }
    assert.equal(new Set(q.options.map((o) => o.value)).size, q.options.length, `${q.id} 選項值重複`);
  }
  assert.equal(new Set(SURVEY_BANK.map((q) => q.id)).size, SURVEY_BANK.length, '題庫 id 重複');
});

test('依主題建議題目：場景專屬的排前面，通用題接在後面', () => {
  const list = surveysForTheme('kitchen');
  assert.equal(list[0].id, 'kitchen_role');
  assert.ok(list.every((q) => q.theme === 'kitchen' || q.theme === null));
  assert.ok(!list.some((q) => q.theme === 'office'));
});

test('出題會驗證選項數、時間與標籤名稱', () => {
  const s = new SurveySession();
  assert.equal(s.start({ ...custom, options: [{ value: 'a', label: '只有一個' }] }).ok, false);
  assert.equal(s.start({ ...custom, question: '   ' }).ok, false);
  assert.equal(s.start({ ...custom, durationMs: 1000 }).ok, false);
  assert.equal(s.start({ ...custom, key: '__proto__' }).ok, false);
  assert.equal(s.start({ ...custom, options: [{ value: 'x', label: '甲' }, { value: 'x', label: '乙' }] }).ok, false);
  assert.equal(s.start({ bankId: '不存在' }).ok, false);
  assert.ok(s.start(custom).ok);
  assert.equal(s.start(custom).ok, false, '同時只能有一題');
});

test('答案在作答當下就寫成標籤，不必等收題', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  assert.ok(s.answer('amy', 0).ok);
  const trait = s.traitOf('amy', 'kitchen_role');
  assert.equal(trait.value, 'cook');
  assert.equal(trait.label, '負責煮');
  // 地點跟著標籤一起存：集合任務要知道把這群人叫到哪個道具旁
  assert.equal(trait.spot, 'tbl_3');
  assert.deepEqual(s.traitsOf('amy'), { kitchen_role: { value: 'cook', label: '負責煮' } });
});

test('問卷可以改答案（與問答相反），標籤跟著換', () => {
  const s = new SurveySession();
  s.start({ bankId: 'chrono' });
  s.answer('amy', 0);
  assert.equal(s.traitOf('amy', 'chrono').value, 'early');
  assert.ok(s.answer('amy', 1).ok, '問卷沒有速度分，改答案不影響任何人');
  assert.equal(s.traitOf('amy', 'chrono').value, 'night');
  assert.equal(s.distribution().totalAnswers, 1, '改答案不應該多算一票');
  assert.deepEqual(s.distribution().counts, [0, 1]);
});

test('拒收不合法的選擇，且不會留下半截標籤', () => {
  const s = new SurveySession();
  s.start({ bankId: 'chrono' });
  for (const bad of [null, undefined, '0', 1.5, -1, 2, NaN]) {
    assert.equal(s.answer('amy', bad).ok, false, String(bad));
  }
  assert.equal(s.traitOf('amy', 'chrono'), null);
});

test('時間到之後截止，並由 shouldAutoClose 推進', () => {
  const s = new SurveySession();
  const t0 = 1_000_000;
  s.start({ bankId: 'chrono', durationMs: 5000 }, t0);
  assert.equal(s.shouldAutoClose(t0 + 4000), false);
  assert.ok(s.answer('amy', 0, t0 + 4000).ok);
  assert.equal(s.answer('bob', 0, t0 + 9000).ok, false, '寬限期之後不再收');
  assert.ok(s.shouldAutoClose(t0 + 9000));
  const result = s.close(t0 + 9000);
  assert.equal(result.totalAnswers, 1);
  assert.equal(s.isActive, false);
});

test('收題不會動到標籤 —— 標籤是問卷的產物，題目只是取得它的手段', () => {
  const s = new SurveySession();
  s.start({ bankId: 'chrono' });
  s.answer('amy', 0);
  s.close();
  assert.equal(s.traitOf('amy', 'chrono').value, 'early');
  assert.deepEqual(s.agentsWith('chrono', 'early'), ['amy']);
});

test('查詢供後續任務使用：符合條件的人、在場分佈', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  s.answer('amy', 0); s.answer('bob', 0); s.answer('cody', 2);
  assert.deepEqual(s.agentsWith('kitchen_role', 'cook').sort(), ['amy', 'bob']);
  assert.deepEqual(s.agentsWith('kitchen_role', 'wash'), []);
  // 已離場的人不該讓任務以為條件湊得出來
  const present = new Set(['amy', 'cody']);
  assert.deepEqual([...s.spread('kitchen_role', (id) => present.has(id))].sort(),
    [['cook', 1], ['eat', 1]]);
});

test('主動離場會忘掉標籤', () => {
  const s = new SurveySession();
  s.start({ bankId: 'chrono' });
  s.answer('amy', 0);
  s.forget('amy');
  assert.equal(s.traitOf('amy', 'chrono'), null);
});

test('重開伺服器：標籤要還原，進行中的那一題則作廢', () => {
  const s = new SurveySession();
  s.start({ bankId: 'chrono' });
  s.answer('amy', 1);
  const dump = JSON.parse(JSON.stringify(s.export()));

  const back = new SurveySession().hydrate(dump);
  // 標籤是「這個人是誰」，重開後以原憑證接回同一個角色 id 時必須還在，
  // 否則以標籤為條件的任務會把所有人都判成不符合
  assert.equal(back.traitOf('amy', 'chrono').value, 'night');
  // 進行中的那一題不還原：倒數是相對於重開前算的，那個截止時間已經沒有意義
  assert.equal(back.isActive, false);
  assert.equal(back.history.length, 1);
  assert.equal(back.asked, 1, '題號繼續往下數，匯出時不會出現兩個「第 1 題」');
});

test('publicView 與 distribution 的形狀足夠三端顯示', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  const view = s.publicView();
  assert.equal(view.key, 'kitchen_role');
  assert.equal(view.options.length, SURVEY_BANK_MAP.kitchen_role.options.length);
  assert.ok(view.remainingMs > 0 && view.remainingMs <= SURVEY.defaultDurationMs);
  assert.ok(view.options.every((o) => 'label' in o && 'value' in o && 'spot' in o));
  const dist = s.distribution();
  assert.equal(dist.counts.length, view.options.length);
});
