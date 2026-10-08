/**
 * 活動報告彙整（server/report.js）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport } from '../server/report.js';
import { MissionBoard } from '../server/missions.js';
import { SocialGraph } from '../server/socialgraph.js';

const names = { a: '小明', b: '小華', c: '小美' };

function sample() {
  const missions = new MissionBoard();
  missions.publish({ type: 'PAIRING', target: 1, now: 100 });
  missions.credit('a'); missions.credit('b');
  missions.close();

  const graph = new SocialGraph();
  graph.connect('a', 'b');

  return buildReport({
    missions: missions.export(),
    graph: graph.export(),
    quiz: {
      current: null,
      history: [{
        question: '1+1？', options: ['1', '2'], correctIndex: 1, startedAt: 200, revealedAt: 300,
        answers: [{ agentId: 'a', choice: 1 }, { agentId: 'c', choice: 0 }],
      }],
    },
    survey: {
      current: null,
      history: [{
        question: '喜歡哪個？', options: [{ label: '貓' }, { label: '狗' }], startedAt: 50, closedAt: 80,
        answers: [{ agentId: 'a', choice: 0 }, { agentId: 'b', choice: 0 }, { agentId: 'c', choice: 1 }],
      }],
      traits: [{ agentId: 'c', tags: { pet: { value: 'dog', label: '狗派' } } }],
    },
    scores: { totals: { a: { total: 120 }, b: { total: 20 } } },
    nameOf: (id) => names[id] ?? '',
    isPresent: (id) => id !== 'c',
  });
}

test('每個出現過的人都有一列，沒配對過的人算成孤島', () => {
  const r = sample();
  assert.equal(r.summary.participants, 3);
  assert.equal(r.summary.present, 2);
  assert.equal(r.summary.isolated, 1);
  const c = r.people.find((p) => p.id === 'c');
  assert.equal(c.connections, 0);
  assert.deepEqual(c.surveyTags, ['狗派']);
  assert.equal(c.present, false);
});

test('問答只在公布後計對錯', () => {
  const r = sample();
  const a = r.people.find((p) => p.id === 'a');
  assert.equal(a.quizAnswered, 1);
  assert.equal(a.quizCorrect, 1);
  assert.equal(a.missionCompletions, 1);
  assert.equal(r.people[0].id, 'a', '依積分排序');
});

test('活動紀錄依開始時間排序，各自帶結果', () => {
  const r = sample();
  assert.deepEqual(r.activities.map((x) => x.kind), ['問卷', '任務', '問答']);
  assert.match(r.activities[0].result, /貓 2・狗 1/);
  assert.match(r.activities[2].result, /1 \/ 2 人答對/);
});
