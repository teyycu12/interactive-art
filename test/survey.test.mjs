import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurveySession } from '../server/survey.js';
import { SURVEY, SURVEY_BANK, SURVEY_BANK_MAP, surveysForTheme } from '../shared/surveys.js';
import { PROPS } from '../shared/scene.js';
import { STAGE } from '../shared/protocol.js';
import { BOUNDARY_MARGIN } from '../server/config.js';
import { THEME_MAP } from '../shared/themes.js';

/** 題目選項指向的道具座標，供到位測試用 */
const propAt = (id) => PROPS.find((p) => p.id === id);

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
  assert.equal(trait.spot, 'tbl_3');   // 負責煮 → 湯鍋
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

// ── 到場才算 ────────────────────────────────────────────────

/**
 * 兩群人之間至少要留的距離（邏輯單位）。
 *
 * 不重疊只是最低標：圈圈相切時兩群人仍舊肩並肩站成一片，大螢幕上看不出
 * 是兩群還是一群。150 大約是三個人的身體寬度，投影出去看得出中間有條縫。
 */
const COMFORTABLE_GAP = 150;

test('同一題的集合點要分得夠開，不只是不重疊', () => {
  // 擠在一起的話，站在中間的人會落在兩個答案的範圍邊緣，兩群人也會黏成一團，
  // 而「去跟答案一樣的人站在一起」正是這個玩法的全部意義。
  for (const q of SURVEY_BANK) {
    const spots = q.options.map((o) => o.spot).filter(Boolean).map(propAt);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i]; const b = spots[j];
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + SURVEY.arriveRadius) - (b.r + SURVEY.arriveRadius);
        assert.ok(gap >= COMFORTABLE_GAP,
          `${q.id}：${a.id} 與 ${b.id} 的集合範圍只隔 ${Math.round(gap)}，至少要 ${COMFORTABLE_GAP}`);
      }
    }
  }
});

test('集合點要走得到，不能落在場域邊界之外', () => {
  // 角色被邊界力推回 BOUNDARY_MARGIN 以內，而道具的座標是美術擺的 ——
  // 擺在邊界外的道具，圈圈畫得出來卻永遠沒有人進得去，
  // 現場看到的是「那一欄的到位數停在 0」，看不出原因。
  for (const q of SURVEY_BANK) {
    for (const o of q.options) {
      if (!o.spot) continue;
      const p = propAt(o.spot);
      const reach = p.r + SURVEY.arriveRadius;
      const nearestX = Math.min(Math.max(p.x, BOUNDARY_MARGIN), STAGE.width - BOUNDARY_MARGIN);
      const nearestY = Math.min(Math.max(p.y, BOUNDARY_MARGIN), STAGE.height - BOUNDARY_MARGIN);
      const d = Math.hypot(p.x - nearestX, p.y - nearestY);
      assert.ok(d < reach, `${q.id}：${o.spot} 離可走動範圍 ${Math.round(d)}，超過判定半徑 ${reach}`);
    }
  }
});

test('選項沒有全部綁地點時，不能要求到場', () => {
  const s = new SurveySession();
  // chrono 是純手機題，硬要求到場的話，答題的人會永遠到不了位，
  // 而畫面上只會看到到位數停在 0，看不出原因
  s.start({ bankId: 'chrono', requireArrival: true });
  assert.equal(s.current.requireArrival, false);
  assert.equal(s.publicView().requireArrival, false);
  s.close();
  s.start({ bankId: 'kitchen_role' });
  assert.equal(s.current.requireArrival, true, '選項都綁了地點時預設就要到場');
});

test('到位由伺服器的座標判定，走進走出都會回報', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  s.answer('amy', 0);                       // 負責煮 → tbl_3
  const spot = propAt('tbl_3');
  const far = { x: spot.x + 900, y: spot.y };
  let pos = far;

  assert.deepEqual(s.syncArrivals(() => pos), [], '還沒走到就不算');
  assert.equal(s.isArrived('amy'), false);

  pos = { x: spot.x + spot.r + SURVEY.arriveRadius - 1, y: spot.y };
  assert.deepEqual(s.syncArrivals(() => pos), ['amy'], '踏進圈子要回報一次');
  assert.equal(s.isArrived('amy'), true);
  assert.deepEqual(s.syncArrivals(() => pos), [], '沒變就不再回報');
  assert.equal(s.distribution().arrived[0], 1);
  assert.equal(s.distribution().totalArrived, 1);

  pos = far;
  assert.deepEqual(s.syncArrivals(() => pos), ['amy'], '走掉也要回報');
  assert.equal(s.isArrived('amy'), false);
  // arrivedAt 是「完成過」的證據，走開不該抹掉，否則先到先走的人結算時全不算
  assert.ok(s.traitOf('amy', 'kitchen_role').arrivedAt > 0);
});

test('查不到座標的人維持原狀，不會被判成離開', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  s.answer('amy', 0);
  const spot = propAt('tbl_3');
  s.syncArrivals(() => ({ x: spot.x, y: spot.y }));
  assert.equal(s.isArrived('amy'), true);
  // 離場那一瞬間若判成離開，大螢幕的到位數會閃一下，而現場會以為自己走錯了
  assert.deepEqual(s.syncArrivals(() => null), []);
  assert.equal(s.isArrived('amy'), true);
});

test('改答案會把到位狀態歸零', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  s.answer('amy', 0);
  const cook = propAt('tbl_3');
  s.syncArrivals(() => ({ x: cook.x, y: cook.y }));
  assert.equal(s.isArrived('amy'), true);
  // 人還站在原地，但答案改成別的地點 —— 不歸零的話他會以「已到位」的身分
  // 出現在新選項的統計裡，而人根本沒動
  s.answer('amy', 1);
  assert.equal(s.isArrived('amy'), false);
  assert.equal(s.distribution().arrived[1], 0);
});

test('還沒走到的人要列進 pending，供大螢幕標在他們頭上', () => {
  const s = new SurveySession();
  s.start({ bankId: 'kitchen_role' });
  s.answer('amy', 0); s.answer('bob', 0); s.answer('cody', 1);
  const cook = propAt('tbl_3');
  // 只有 amy 走到了
  s.syncArrivals((id) => (id === 'amy' ? { x: cook.x, y: cook.y } : { x: 0, y: 0 }));

  const d = s.distribution();
  assert.deepEqual(d.pending.map((p) => p.id).sort(), ['bob', 'cody']);
  assert.equal(d.pending.find((p) => p.id === 'cody').choice, 1, '要帶選項索引，大螢幕才知道標什麼顏色');
  assert.ok(!d.pending.some((p) => p.id === 'amy'), '到了的人不該繼續被標記');
});

test('不要求到場的題目沒有 pending —— 那個記號在這種題目上沒有意義', () => {
  const s = new SurveySession();
  s.start({ bankId: 'chrono' });
  s.answer('amy', 0);
  assert.deepEqual(s.distribution().pending, []);
});
