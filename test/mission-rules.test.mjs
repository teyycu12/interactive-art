/**
 * 任務條件、可行性檢查與集合判定（server/missionRules.js）
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pairRule, traitCatalog, buildRule, feasibility, GatherTracker } from '../server/missionRules.js';
import { PAIR_ERRORS, PAIR_MISSION_IDS } from '../shared/protocol.js';

// 四個人：A、B 是老虎，C 是貓頭鷹，D 沒答過進場問卷
const TRAITS = {
  A: { persona: { value: 'tiger', label: '🐯 老虎' }, chrono: { value: 'early', label: '早鳥' } },
  B: { persona: { value: 'tiger', label: '🐯 老虎' } },
  C: { persona: { value: 'owl', label: '🦉 貓頭鷹' }, chrono: { value: 'night', label: '夜貓' } },
  D: {},
};
const ctx = {
  avatarOf: () => null,
  traitOf: (id, key) => TRAITS[id]?.[key] ?? null,
};
const IDS = Object.keys(TRAITS);
const never = () => false;
const title = (k) => ({ persona: '進場人格類型', chrono: '早鳥還是夜貓' }[k] ?? k);
const catalog = traitCatalog(IDS, (id) => TRAITS[id], title);
const options = { catalog, spots: [{ id: 'tbl_1', label: '1號桌' }] };

describe('配對條件', () => {
  test('TRAIT_HUNT：被輸入碼的那一方要是指定的類型', () => {
    const rule = { type: 'TRAIT_HUNT', trait: { key: 'persona', value: 'owl' } };
    assert.equal(pairRule(rule, 'A', 'C', ctx), null);
    assert.equal(pairRule(rule, 'C', 'A', ctx), PAIR_ERRORS.TRAIT_MISMATCH);
  });

  test('DIFF_TRAIT：同類不算，不同類才算', () => {
    const rule = { type: 'DIFF_TRAIT', traitKey: 'persona' };
    assert.equal(pairRule(rule, 'A', 'B', ctx), PAIR_ERRORS.NOT_DIFFERENT);
    assert.equal(pairRule(rule, 'A', 'C', ctx), null);
  });

  test('SAME_TRAIT：只有同類才算', () => {
    const rule = { type: 'SAME_TRAIT', traitKey: 'persona' };
    assert.equal(pairRule(rule, 'A', 'B', ctx), null);
    assert.equal(pairRule(rule, 'A', 'C', ctx), PAIR_ERRORS.NOT_SAME);
  });

  test('同類／不同類：沒答過的人說清楚是誰沒答，而不是籠統的「不符合」', () => {
    const rule = { type: 'DIFF_TRAIT', traitKey: 'persona' };
    assert.equal(pairRule(rule, 'D', 'A', ctx), PAIR_ERRORS.NO_TRAIT_SELF);
    assert.equal(pairRule(rule, 'A', 'D', ctx), PAIR_ERRORS.NO_TRAIT_PEER);
  });

  test('GATHER 不是配對任務，配對碼不能拿來完成它', () => {
    assert.equal(pairRule({ type: 'GATHER' }, 'A', 'B', ctx), PAIR_ERRORS.NOT_PAIR_MISSION);
    assert.ok(!PAIR_MISSION_IDS.includes('GATHER'));
  });
});

describe('可選的條件只列場上真的有的', () => {
  test('標籤目錄依人數排序，並帶題目名稱', () => {
    const persona = catalog.find((k) => k.key === 'persona');
    assert.equal(persona.title, '進場人格類型');
    assert.equal(persona.answered, 3);
    assert.deepEqual(persona.values.map((v) => [v.value, v.count]), [['tiger', 2], ['owl', 1]]);
  });

  test('挑一個場上沒有人的類型會被拒絕', () => {
    const r = buildRule('TRAIT_HUNT', { trait: { key: 'persona', value: 'peacock' } }, options);
    assert.equal(r.ok, false);
  });

  test('規則帶著三端要顯示的文字', () => {
    const r = buildRule('TRAIT_HUNT', { trait: { key: 'persona', value: 'owl' } }, options);
    assert.deepEqual(r.rule, {
      type: 'TRAIT_HUNT', trait: { key: 'persona', value: 'owl' }, title: '進場人格類型', label: '🦉 貓頭鷹',
    });
  });

  test('集合點必須在目前的場景裡、人數在範圍內', () => {
    assert.equal(buildRule('GATHER', { spot: 'nowhere', teamSize: 3 }, options).ok, false);
    assert.equal(buildRule('GATHER', { spot: 'tbl_1', teamSize: 1 }, options).ok, false);
    assert.deepEqual(buildRule('GATHER', { spot: 'tbl_1', teamSize: 3 }, options).rule,
      { type: 'GATHER', spot: 'tbl_1', label: '1號桌', teamSize: 3 });
  });
});

describe('發布前的可行性檢查', () => {
  const check = (rule, extra = {}) => feasibility(rule, { target: 1, agents: IDS, ctx, connected: never, ...extra });

  test('場上沒有人符合時擋下', () => {
    const r = check({ type: 'COLOR_HUNT', colorFamily: 'RED', label: '紅色' });
    assert.equal(r.level, 'block');
  });

  test('有人做不完時警告，並說出幾個人沒答過', () => {
    const r = check({ type: 'DIFF_TRAIT', traitKey: 'persona', title: '進場人格類型' });
    assert.equal(r.level, 'warn');
    assert.equal(r.canFinish, 3, 'D 沒答過，跟誰都配不成');
    assert.ok(r.notes.some((n) => n.includes('1 人還沒答過')));
  });

  test('配對過的人不能再配，連續發任務之後可配的人會變少', () => {
    // A 與 C 已經配過，DIFF 任務下 A 就沒有人可以配了
    const connected = (a, b) => (a === 'A' && b === 'C') || (a === 'C' && b === 'A');
    const r = check({ type: 'DIFF_TRAIT', traitKey: 'persona', title: '進場人格類型' }, { connected });
    assert.equal(r.canFinish, 2, 'A 沒有人可配了，只剩 B × C 這一對');
    assert.ok(r.notes.some((n) => n.includes('已經配對過')));
  });

  test('目標次數超過可配的人數時，那些人做不滿', () => {
    const r = check({ type: 'SAME_TRAIT', traitKey: 'persona', title: '進場人格類型' }, { target: 2 });
    assert.equal(r.level, 'block', '每個人最多只有一個同類的人可配');
    assert.match(r.summary, /降低目標次數/);
  });

  test('一般配對：場上不到兩人時擋下', () => {
    const r = feasibility({ type: 'PAIRING' }, { target: 1, agents: ['A'], ctx, connected: never });
    assert.equal(r.level, 'block');
  });

  test('集合：人數不夠擋下，湊不成整組時警告', () => {
    assert.equal(check({ type: 'GATHER', teamSize: 5 }).level, 'block');
    const r = check({ type: 'GATHER', teamSize: 3 });
    assert.equal(r.level, 'warn');
    assert.equal(r.canFinish, 3);
  });
});

describe('集合判定', () => {
  const spot = { x: 100, y: 100, r: 10 };
  const at = (id, x = 100, y = 100) => ({ id, x, y });

  test('湊滿人數並站滿 holdMs 才算，完成的人一起記', () => {
    const g = new GatherTracker({ spot, teamSize: 2, holdMs: 2000 });
    assert.deepEqual(g.step([at('A'), at('B')], never, 0).completed, []);
    assert.deepEqual(g.step([at('A'), at('B')], never, 1999).completed, []);
    assert.deepEqual(g.step([at('A'), at('B')], never, 2000).completed.sort(), ['A', 'B']);
  });

  test('中途有人走開就重新計時', () => {
    const g = new GatherTracker({ spot, teamSize: 2, holdMs: 2000 });
    g.step([at('A'), at('B')], never, 0);
    g.step([at('A'), at('B', 900, 900)], never, 1000);
    assert.deepEqual(g.step([at('A'), at('B')], never, 2500).completed, [], '2500 時才重新湊齊了 0 秒');
    assert.equal(g.step([at('A'), at('B')], never, 4500).completed.length, 2);
  });

  test('已經完成的人不幫後來的人湊數', () => {
    const g = new GatherTracker({ spot, teamSize: 2, holdMs: 0 });
    const done = (id) => id === 'A';
    g.step([at('A'), at('C')], done, 0);
    assert.deepEqual(g.step([at('A'), at('C')], done, 10).completed, [], 'A 已完成，C 一個人不夠');
  });

  test('人數只在變動時回報', () => {
    const g = new GatherTracker({ spot, teamSize: 3, holdMs: 0 });
    assert.equal(g.step([at('A')], never, 0).changed, true);
    assert.equal(g.step([at('A')], never, 10).changed, false);
    assert.equal(g.step([at('A'), at('B')], never, 20).inside, 2);
  });
});

describe('同時開好幾個帶條件的任務', async () => {
  const { MissionBoard } = await import('../server/missions.js');
  const owl = buildRule('TRAIT_HUNT', { trait: { key: 'persona', value: 'owl' } }, options).rule;
  const tiger = buildRule('TRAIT_HUNT', { trait: { key: 'persona', value: 'tiger' } }, options).rule;

  test('條件不同就算不同的任務，可以同時開；條件相同的不行', () => {
    const board = new MissionBoard();
    assert.equal(board.publish({ type: 'TRAIT_HUNT', target: 1, rule: owl }).ok, true);
    assert.equal(board.publish({ type: 'TRAIT_HUNT', target: 1, rule: tiger }).ok, true);
    const dup = board.publish({ type: 'TRAIT_HUNT', target: 2, rule: { ...owl, label: '換個說法' } });
    assert.equal(dup.ok, false, '顯示文字不同不算不同的條件');
  });

  test('標題帶上條件，三端才分得出是哪一個', () => {
    const board = new MissionBoard();
    const a = board.publish({ type: 'TRAIT_HUNT', target: 1, rule: owl }).mission;
    const g = board.publish({
      type: 'GATHER', target: 1, rule: buildRule('GATHER', { spot: 'tbl_1', teamSize: 3 }, options).rule,
    }).mission;
    const d = board.publish({
      type: 'DIFF_TRAIT', target: 1, rule: buildRule('DIFF_TRAIT', { traitKey: 'persona' }, options).rule,
    }).mission;
    assert.match(a.title, /貓頭鷹/);
    assert.match(g.title, /3 人到1號桌集合/);
    assert.match(d.title, /進場人格類型/);
  });
});
