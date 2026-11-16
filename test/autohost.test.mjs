/**
 * 專展自動主持（server/autohost.js）。
 *
 * 用一個假的場地驅動它：run() 收到的訊息就是主辦端會送的那一則，
 * 由假場地決定收下或拒絕。要釘住的是「讓位」與「不卡住」：
 *   - 人不夠、主持人自己開的活動在跑、活動暫停時都不發
 *   - 被拒絕的那一項跳過，題庫不往前推
 *   - 自己發的那一項，時間到或被主持人提早收掉都能接下一項
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AutoHost } from '../server/autohost.js';
import { AUTOHOST_CONTENT } from '../server/autohostPlaylist.js';
import { QUIZ, MISSION_TYPES } from '../shared/protocol.js';

const SETTINGS = { minPeople: 2, restMs: 1000, startDelayMs: 0, retryMs: 5000 };

/** 假場地：只記狀態，訊息照主辦端的語意改它 */
function venue(over = {}) {
  const v = {
    present: 3, paused: false, quiz: false, quizRevealed: false, wordcloud: false, wordcloudResult: false, bingo: false,
    missions: [], done: new Set(), spots: [{ id: 'tbl_1', label: '1號桌' }],
    sent: [], reject: null, seq: 0,
    ...over,
  };
  v.status = () => ({
    present: v.present, paused: v.paused, quiz: v.quiz, quizRevealed: v.quizRevealed, wordcloud: v.wordcloud,
    wordcloudResult: v.wordcloudResult, bingo: v.bingo, missions: [...v.missions],
    missionDone: (id) => v.done.has(id), spots: v.spots,
  });
  v.run = (msg) => {
    v.sent.push(msg);
    const reason = v.reject?.(msg);
    if (reason) return { ok: false, reason };
    switch (msg.type) {
      case 'HOST_START_QUIZ': v.quiz = true; v.quizRevealed = false; break;
      case 'HOST_END_QUIZ': v.quiz = false; v.quizRevealed = false; break;
      case 'HOST_START_WORDCLOUD': v.wordcloud = true; break;
      case 'HOST_CLOSE_WORDCLOUD': v.wordcloud = false; v.wordcloudResult = true; break;
      case 'HOST_DISMISS_WORDCLOUD': v.wordcloudResult = false; break;
      case 'HOST_PUBLISH_MISSION': v.missions.push(`m${++v.seq}`); break;
      case 'HOST_CLOSE_MISSION': v.missions = v.missions.filter((id) => id !== msg.missionId); break;
    }
    return { ok: true };
  };
  return v;
}

function host(v, content = {}, countdowns = []) {
  const ah = new AutoHost({
    countdown: (c) => countdowns.push(c),
    content: {
      settings: SETTINGS,
      playlist: [
        { kind: 'mission', label: '配對', missionType: 'PAIRING', target: 1, limitMs: 10_000 },
        { kind: 'quiz', talkMs: 0, durationMs: 20_000 },
        { kind: 'wordcloud', answerMs: 10_000, resultMs: 3000 },
      ],
      quizPool: [{ question: 'Q1', options: ['a', 'b'], correctIndex: 0 }, { question: 'Q2', options: ['a', 'b'], correctIndex: 1 }],
      wordcloudPool: ['W1'],
      ...content,
    },
    status: v.status, run: v.run,
  });
  ah.setEnabled(true, 0);
  return ah;
}

const types = (v) => v.sent.map((m) => m.type);

describe('什麼時候不發', () => {
  test('關著的時候什麼都不送', () => {
    const v = venue();
    const ah = host(v);
    ah.setEnabled(false, 0);
    ah.tick(10_000);
    assert.deepEqual(v.sent, []);
    assert.equal(ah.view().phase, 'off');
  });

  test('人不夠時等人，來了才發', () => {
    const v = venue({ present: 1 });
    const ah = host(v);
    ah.tick(100);
    assert.deepEqual(v.sent, []);
    assert.equal(ah.view().phase, 'waiting');
    v.present = 2;
    ah.tick(200);
    assert.deepEqual(types(v), ['HOST_PUBLISH_MISSION']);
  });

  test('主持人自己開的活動還在跑：讓位，結束後才接', () => {
    for (const busy of ['quiz', 'wordcloud', 'bingo']) {
      const v = venue({ [busy]: true });
      const ah = host(v);
      ah.tick(100);
      assert.deepEqual(v.sent, [], busy);
      assert.equal(ah.view().phase, 'manual');
      v[busy] = false;
      ah.tick(200);
      assert.equal(v.sent.length, 1, busy);
    }
    const v = venue({ missions: ['manual'] });
    const ah = host(v);
    ah.tick(100);
    assert.deepEqual(v.sent, []);
  });

  test('活動暫停時不發', () => {
    const v = venue({ paused: true });
    const ah = host(v);
    ah.tick(100);
    assert.deepEqual(v.sent, []);
    assert.equal(ah.view().phase, 'paused');
  });

  test('打開後先等 startDelayMs', () => {
    const v = venue();
    const ah = new AutoHost({
      content: { ...AUTOHOST_CONTENT, settings: { ...SETTINGS, startDelayMs: 5000 } },
      status: v.status, run: v.run,
    });
    ah.setEnabled(true, 0);
    ah.tick(4000);
    assert.deepEqual(v.sent, []);
    ah.tick(5000);
    assert.equal(v.sent.length, 1);
  });
});

describe('一項接一項', () => {
  test('任務：時間到自己結算，休息後接問答', () => {
    const v = venue();
    const ah = host(v);
    ah.tick(0);
    assert.equal(v.sent[0].durationMs, 0, '不用伺服器的限時（最短 3 分鐘）');
    ah.tick(9_999);
    assert.equal(v.missions.length, 1);
    ah.tick(10_000);
    assert.deepEqual(v.sent.at(-1), { type: 'HOST_CLOSE_MISSION', missionId: 'm1' });
    ah.tick(10_500);                   // 還在休息
    assert.equal(v.sent.length, 2);
    ah.tick(11_000);
    assert.equal(v.sent.at(-1).type, 'HOST_START_QUIZ');
    assert.equal(v.sent.at(-1).question, 'Q1');
  });

  test('任務：場上每個人都做完就提早結算', () => {
    const v = venue();
    const ah = host(v);
    ah.tick(0);
    v.done.add('m1');
    ah.tick(500);
    assert.deepEqual(v.sent.at(-1), { type: 'HOST_CLOSE_MISSION', missionId: 'm1' });
  });

  test('被主持人提早收掉也算結束，不會再送一次結算', () => {
    const v = venue();
    const ah = host(v);
    ah.tick(0);
    v.missions = [];
    ah.tick(500);
    assert.equal(ah.view().phase, 'rest');
    assert.ok(!types(v).includes('HOST_CLOSE_MISSION'));
  });

  test('問答：等它自己公布、收題（主迴圈推進），不代按', () => {
    const v = venue();
    const ah = host(v, { playlist: [{ kind: 'quiz', durationMs: 20_000 }] });
    ah.tick(0);
    ah.tick(60_000);
    assert.deepEqual(types(v), ['HOST_START_QUIZ']);
    v.quiz = false;
    ah.tick(60_100);
    ah.tick(61_100);
    assert.equal(v.sent.at(-1).question, 'Q2', '題庫依序往下');
  });

  test('文字雲：收題 → 結果停 resultMs → 收起', () => {
    const v = venue();
    const ah = host(v, { playlist: [{ kind: 'wordcloud', answerMs: 10_000, resultMs: 3000 }] });
    ah.tick(0);
    ah.tick(10_000);
    assert.equal(v.sent.at(-1).type, 'HOST_CLOSE_WORDCLOUD');
    ah.tick(12_000);
    assert.equal(v.sent.at(-1).type, 'HOST_CLOSE_WORDCLOUD');
    ah.tick(13_000);
    assert.equal(v.sent.at(-1).type, 'HOST_DISMISS_WORDCLOUD');
    assert.equal(ah.view().phase, 'rest');
  });

  test('跑完從頭再來', () => {
    const v = venue();
    const ah = host(v, { playlist: [{ kind: 'wordcloud', answerMs: 1000, resultMs: 0 }, { kind: 'quiz', durationMs: 20_000 }] });
    let t = 0;
    for (let i = 0; i < 200; i++) {
      ah.tick(t += 500);
      if (v.quiz && i % 7 === 0) v.quiz = false;   // 問答在某個時間點自己收掉
    }
    const starts = types(v).filter((x) => x.startsWith('HOST_START'));
    assert.ok(starts.length >= 4);
    assert.deepEqual(starts.slice(0, 4), ['HOST_START_WORDCLOUD', 'HOST_START_QUIZ', 'HOST_START_WORDCLOUD', 'HOST_START_QUIZ']);
  });
});

describe('任務倒數', () => {
  test('結束前 countdownMs 送一次倒數，只送一次', () => {
    const v = venue();
    const cds = [];
    const ah = host(v, { settings: { ...SETTINGS, countdownMs: 3000 } }, cds);
    ah.tick(0);
    ah.tick(6_999);
    assert.equal(cds.length, 0);
    ah.tick(7_000);
    ah.tick(8_000);
    assert.deepEqual(cds, [{ id: 'm1', title: '配對', ms: 3000 }]);
  });

  test('大家提早做完就不倒數', () => {
    const v = venue();
    const cds = [];
    const ah = host(v, { settings: { ...SETTINGS, countdownMs: 3000 } }, cds);
    ah.tick(0);
    v.done.add('m1');
    ah.tick(1000);
    ah.tick(9000);
    assert.equal(cds.length, 0);
  });
});

describe('輪替型任務', () => {
  const step = {
    kind: 'mission', missionType: ['SAME_TRAIT', 'DIFF_TRAIT'], traitKey: 'persona', target: 1, limitMs: 1000,
    label: { SAME_TRAIT: '同類', DIFF_TRAIT: '不同類' },
  };

  test('每一輪換下一種', () => {
    const v = venue();
    const ah = host(v, { playlist: [step] });
    const sent = [];
    let t = 0;
    for (let i = 0; i < 40; i++) ah.tick(t += 300);
    for (const m of v.sent) if (m.type === 'HOST_PUBLISH_MISSION') sent.push(m.missionType);
    assert.deepEqual(sent.slice(0, 4), ['SAME_TRAIT', 'DIFF_TRAIT', 'SAME_TRAIT', 'DIFF_TRAIT']);
    assert.equal(v.sent[0].traitKey, 'persona');
  });

  test('輪到的那種做不完（全場同一種動物），就換另一種', () => {
    const v = venue({ reject: (m) => (m.missionType === 'DIFF_TRAIT' ? '現在沒有人做得完' : null) });
    const ah = host(v, { playlist: [step] });
    ah.tick(0);
    ah.tick(1000);                  // 結算第一個（同類）
    ah.tick(2000);                  // 輪到不同類 → 被拒 → 改發同類
    const pubs = v.sent.filter((m) => m.type === 'HOST_PUBLISH_MISSION').map((m) => m.missionType);
    assert.deepEqual(pubs, ['SAME_TRAIT', 'DIFF_TRAIT', 'SAME_TRAIT']);
    assert.equal(ah.view().current, '同類');
  });
});

describe('連續問答', () => {
  test('一段連續出 count 題；公布後停 revealMs 收題接下一題', () => {
    const v = venue();
    const ah = host(v, {
      playlist: [{ kind: 'quiz', count: 2, talkMs: 5000, talkKind: 'read', durationMs: 10_000, revealMs: 6000 }],
      quizPool: [{ question: 'Q1', options: ['a', 'b'], correctIndex: 0 }, { question: 'Q2', options: ['a', 'b'], correctIndex: 1, multiplier: 2 }],
    });
    ah.tick(0);
    assert.equal(v.sent[0].talkKind, 'read');
    assert.equal(v.sent[0].multiplier, 1);
    v.quizRevealed = true;          // 主迴圈公布了
    ah.tick(15_000);
    ah.tick(20_999);
    assert.ok(!types(v).includes('HOST_END_QUIZ'));
    ah.tick(21_000);
    assert.equal(v.sent.at(-1).type, 'HOST_END_QUIZ');
    ah.tick(21_250);                // 收掉了 → 馬上接第 2 題，不休息
    assert.equal(v.sent.at(-1).question, 'Q2');
    assert.equal(v.sent.at(-1).multiplier, 2);
    assert.equal(v.sent[0].number, 1);
    assert.equal(v.sent.at(-1).number, 2);
    assert.equal(ah.view().phase, 'running');
    v.quiz = false;                 // 第 2 題結束 → 這一段結束
    ah.tick(40_000);
    assert.equal(ah.view().phase, 'rest');
    ah.tick(41_000);                // 下一輪：題號從 1 重新數（題庫接著往下輪）
    assert.equal(v.sent.at(-1).question, 'Q1');
    assert.equal(v.sent.at(-1).number, 1);
  });
});

describe('發不出去時', () => {
  test('被拒絕的那一項跳過，接著試下一項', () => {
    const v = venue({ reject: (m) => (m.type === 'HOST_PUBLISH_MISSION' ? '現在沒有人做得完' : null) });
    const ah = host(v);
    ah.tick(0);
    assert.deepEqual(types(v), ['HOST_PUBLISH_MISSION', 'HOST_START_QUIZ']);
    assert.match(ah.view().lastReason, /做得完/);
  });

  test('被拒絕的題目不把題庫往前推', () => {
    let rejectQuiz = true;
    const v = venue({ reject: (m) => (m.type === 'HOST_START_QUIZ' && rejectQuiz ? '不行' : null) });
    const ah = host(v, { playlist: [{ kind: 'quiz', durationMs: 20_000 }] });
    ah.tick(0);
    rejectQuiz = false;
    ah.tick(10_000);
    assert.equal(v.sent.at(-1).question, 'Q1');
  });

  test('人數不符的項目跳過；整份都不行時隔 retryMs 再試，不是每格都重試', () => {
    const v = venue({ present: 2 });
    const ah = host(v, { playlist: [{ kind: 'mission', label: '集合', missionType: 'GATHER', teamSize: 'all', limitMs: 1000, minPeople: 3 }] });
    ah.tick(0);
    ah.tick(100);
    ah.tick(4_000);
    assert.deepEqual(v.sent, []);
    v.present = 3;
    ah.tick(4_100);
    assert.deepEqual(v.sent, [], '還在 retryMs 裡');
    ah.tick(5_000);
    assert.equal(v.sent[0].teamSize, 3, "'all' = 現在場上的人數");
    assert.equal(v.sent[0].spot, 'tbl_1');
  });

  test('題庫是空的：問答、文字雲跳過', () => {
    const v = venue();
    const ah = host(v, { quizPool: [], wordcloudPool: [], playlist: [{ kind: 'quiz' }, { kind: 'wordcloud' }] });
    ah.tick(0);
    assert.deepEqual(v.sent, []);
    assert.equal(ah.view().quizCount, 0);
  });
});

describe('節目內容檔', () => {
  test('每一項都是伺服器收得下的參數', () => {
    const { playlist, quizPool, wordcloudPool, settings } = AUTOHOST_CONTENT;
    assert.ok(settings.minPeople >= 2);
    for (const step of playlist) {
      assert.ok(['mission', 'quiz', 'wordcloud'].includes(step.kind), step.kind);
      if (step.kind === 'mission') {
        const kinds = Array.isArray(step.missionType) ? step.missionType : [step.missionType];
        for (const k of kinds) {
          assert.ok(MISSION_TYPES[k], k);
          assert.ok(typeof step.label === 'string' || step.label?.[k], `${k} 沒有名稱`);
        }
        assert.ok(step.limitMs > settings.countdownMs, '任務要比倒數長');
      }
      if (step.kind === 'quiz') {
        assert.ok(step.durationMs >= QUIZ.minDurationMs && step.durationMs <= QUIZ.maxDurationMs);
        assert.ok((step.talkMs ?? 0) <= QUIZ.maxTalkMs);
      }
    }
    for (const q of quizPool) {
      assert.ok(q.question.length <= QUIZ.maxQuestionLength, q.question);
      assert.ok(q.options.length >= QUIZ.minOptions && q.options.length <= QUIZ.maxOptions, q.question);
      assert.ok(q.options.every((o) => o.length <= QUIZ.maxOptionLength), q.question);
      assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < q.options.length, q.question);
      assert.ok([undefined, 1, 2, 3].includes(q.multiplier), q.question);
    }
    for (const w of wordcloudPool) assert.ok(typeof w === 'string' && w.trim());
  });
});
