/**
 * 即時問答狀態機與積分帳本測試
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { QuizSession } from '../server/quiz.js';
import { ScoreBoard } from '../server/scores.js';
import { QUIZ_TUNING, SCORING } from '../server/config.js';
import { QUIZ, QUIZ_ERRORS, QUIZ_PHASE } from '../shared/protocol.js';

const A = 'usr_aaaa';
const B = 'usr_bbbb';
const C = 'usr_cccc';

const T0 = 1_700_000_000_000;
const QUESTION = {
  question: 'Boids 的三條規則不含哪一項？',
  options: ['分離', '對齊', '凝聚', '投票'],
  correctIndex: 3,
  durationMs: 20000,
};

/** 起一題並回傳 session，時間基準固定，測試不受真實時鐘影響 */
function started(overrides = {}) {
  const q = new QuizSession();
  const result = q.start({ ...QUESTION, ...overrides }, T0);
  assert.equal(result.ok, true, result.reason);
  return q;
}

describe('出題驗證', () => {
  test('正常出題成功並編號', () => {
    const q = started();
    assert.equal(q.isActive, true);
    assert.equal(q.publicView(T0).index, 1);
  });

  test('同時只允許一題', () => {
    const q = started();
    const second = q.start(QUESTION, T0);
    assert.equal(second.ok, false);
  });

  test('題目不可為空', () => {
    const q = new QuizSession();
    assert.equal(q.start({ ...QUESTION, question: '   ' }, T0).ok, false);
  });

  test('選項少於下限即拒絕', () => {
    const q = new QuizSession();
    const r = q.start({ ...QUESTION, options: ['只有一個'], correctIndex: 0 }, T0);
    assert.equal(r.ok, false);
  });

  test('留白的選項被濾掉後不足下限也拒絕', () => {
    const q = new QuizSession();
    assert.equal(q.start({ ...QUESTION, options: ['甲', '', '  '], correctIndex: 0 }, T0).ok, false);
  });

  test('正解索引超出選項範圍即拒絕', () => {
    const q = new QuizSession();
    assert.equal(q.start({ ...QUESTION, correctIndex: 9 }, T0).ok, false);
  });

  test('作答時間超出上下限即拒絕', () => {
    const q = new QuizSession();
    assert.equal(q.start({ ...QUESTION, durationMs: 1000 }, T0).ok, false);
    assert.equal(q.start({ ...QUESTION, durationMs: QUIZ.maxDurationMs + 1 }, T0).ok, false);
  });

  test('過長的題目與選項被截斷而非拒絕', () => {
    const q = new QuizSession();
    q.start({
      ...QUESTION,
      question: '題'.repeat(QUIZ.maxQuestionLength + 40),
      options: ['選'.repeat(QUIZ.maxOptionLength + 20), '乙'],
      correctIndex: 0,
    }, T0);
    const view = q.publicView(T0);
    assert.equal(view.question.length, QUIZ.maxQuestionLength);
    assert.equal(view.options[0].length, QUIZ.maxOptionLength);
  });
});

describe('正解不外流', () => {
  test('送給客戶端的題目不含 correctIndex', () => {
    const q = started();
    const view = q.publicView(T0);
    assert.equal('correctIndex' in view, false);
    assert.equal(JSON.stringify(view).includes('correctIndex'), false);
  });

  test('送剩餘毫秒而非絕對時戳，客戶端不必對時', () => {
    const q = started();
    assert.equal(q.publicView(T0 + 5000).remainingMs, 15000);
    assert.equal(q.publicView(T0 + 999999).remainingMs, 0, '逾時後不應為負');
    assert.equal('endsAt' in q.publicView(T0), false);
  });

  test('作答分佈在揭曉前不外流', () => {
    const q = started();
    q.answer(A, 3, T0 + 100);
    const tally = q.tally();
    assert.equal(tally.answered, 1);
    assert.equal('counts' in tally, false);
    assert.equal(q.revealView(), null, '未揭曉不應有結果視圖');
  });
});

describe('作答規則', () => {
  test('一人一題只能作答一次，且不可更改', () => {
    const q = started();
    assert.equal(q.answer(A, 0, T0 + 100).ok, true);
    const again = q.answer(A, 3, T0 + 200);
    assert.equal(again.ok, false);
    assert.equal(again.reason, QUIZ_ERRORS.ALREADY_ANSWERED);

    const revealed = q.reveal(T0 + 1000);
    assert.equal(revealed.awards[0].choice, 0, '改答案不應生效');
  });

  test('選項索引不合法即拒絕，且不佔掉那個人的作答機會', () => {
    const q = started();
    assert.equal(q.answer(A, 9, T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    assert.equal(q.answer(A, -1, T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    assert.equal(q.answer(A, 1.5, T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    assert.equal(q.answer(A, '甲', T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    assert.equal(q.answer(A, null, T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    // 被拒的作答不算數，本人仍可正常作答
    assert.equal(q.answer(A, 3, T0 + 200).ok, true);
  });

  test('不做型別寬容轉換：null 不該被當成選了第一個選項', () => {
    const q = started();
    assert.equal(q.answer(A, null, T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    assert.equal(q.answer(A, '3', T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
    assert.equal(q.answer(A, true, T0 + 100).reason, QUIZ_ERRORS.BAD_CHOICE);
  });

  test('沒有進行中的題目時作答被拒', () => {
    const q = new QuizSession();
    assert.equal(q.answer(A, 0, T0).reason, QUIZ_ERRORS.NO_QUIZ);
  });

  test('寬限期內的遲到作答仍被接受', () => {
    const q = started();
    const late = q.answer(A, 3, T0 + 20000 + QUIZ_TUNING.lateGraceMs - 50);
    assert.equal(late.ok, true, '網路延遲不該吃掉使用者的答案');
    assert.equal(late.elapsedMs, 20000, '遲到者以完整時長計，不因晚到而多拿速度分');
  });

  test('超過寬限期即截止', () => {
    const q = started();
    const tooLate = q.answer(A, 3, T0 + 20000 + QUIZ_TUNING.lateGraceMs + 1);
    assert.equal(tooLate.reason, QUIZ_ERRORS.CLOSED);
  });

  test('揭曉後不再接受作答', () => {
    const q = started();
    q.reveal(T0 + 5000);
    assert.equal(q.answer(A, 3, T0 + 5100).reason, QUIZ_ERRORS.CLOSED);
  });
});

describe('判分', () => {
  test('立刻答對拿到滿額速度分', () => {
    const q = started();
    q.answer(A, 3, T0);
    const award = q.reveal(T0 + 1000).awards[0];
    assert.equal(award.correct, true);
    assert.equal(award.points, SCORING.quizCorrect + SCORING.quizSpeedBonus);
  });

  test('鈴響前一刻答對只拿基本分', () => {
    const q = started();
    q.answer(A, 3, T0 + 20000);
    const award = q.reveal(T0 + 20500).awards[0];
    assert.equal(award.points, SCORING.quizCorrect);
  });

  test('速度分隨作答時間線性遞減', () => {
    const q = started();
    q.answer(A, 3, T0 + 5000);
    q.answer(B, 3, T0 + 15000);
    const { awards } = q.reveal(T0 + 20000);
    const fast = awards.find((a) => a.agentId === A).points;
    const slow = awards.find((a) => a.agentId === B).points;
    assert.equal(fast, SCORING.quizCorrect + Math.round(SCORING.quizSpeedBonus * 0.75));
    assert.equal(slow, SCORING.quizCorrect + Math.round(SCORING.quizSpeedBonus * 0.25));
  });

  test('答錯零分 —— 亂按搶時間沒有期望值', () => {
    const q = started();
    q.answer(A, 0, T0);
    const award = q.reveal(T0 + 1000).awards[0];
    assert.equal(award.correct, false);
    assert.equal(award.points, 0);
  });

  test('沒作答的人不出現在 awards 裡', () => {
    const q = started();
    q.answer(A, 3, T0 + 100);
    const { awards } = q.reveal(T0 + 1000);
    assert.equal(awards.length, 1);
  });

  test('揭曉回報各選項人數', () => {
    const q = started();
    q.answer(A, 3, T0 + 100);
    q.answer(B, 3, T0 + 200);
    q.answer(C, 0, T0 + 300);
    const result = q.reveal(T0 + 1000);
    assert.deepEqual(result.counts, [1, 0, 0, 2]);
    assert.equal(result.totalAnswers, 3);
    assert.equal(result.correctIndex, 3);
  });

  test('重複揭曉不會重複給分', () => {
    const q = started();
    q.answer(A, 3, T0 + 100);
    assert.ok(q.reveal(T0 + 1000));
    assert.equal(q.reveal(T0 + 1100), null);
  });
});

describe('時間推進', () => {
  test('逾時（含寬限）才自動揭曉', () => {
    const q = started();
    assert.equal(q.shouldAutoReveal(T0 + 20000), false, '寬限期內不該提前收掉');
    assert.equal(q.shouldAutoReveal(T0 + 20000 + QUIZ_TUNING.lateGraceMs + 1), true);
  });

  test('揭曉後逾時自動收題，題目不會卡在大螢幕上', () => {
    const q = started();
    q.reveal(T0 + 5000);
    assert.equal(q.shouldAutoEnd(T0 + 5000 + QUIZ_TUNING.revealHoldMs - 1), false);
    assert.equal(q.shouldAutoEnd(T0 + 5000 + QUIZ_TUNING.revealHoldMs + 1), true);
    assert.equal(q.shouldAutoReveal(T0 + 999999), false, '已揭曉的題不該再被自動揭曉');
  });

  test('收題後題號繼續遞增', () => {
    const q = started();
    q.reveal(T0 + 1000);
    q.end();
    assert.equal(q.isActive, false);
    q.start(QUESTION, T0 + 2000);
    assert.equal(q.publicView(T0 + 2000).index, 2);
  });

  test('未揭曉就收題等同作廢，不產生任何分數', () => {
    const q = started();
    q.answer(A, 3, T0 + 100);
    const closed = q.end();
    assert.equal(closed.phase, QUIZ_PHASE.ASKING);
    assert.equal(q.export().history[0].revealedAt, null);
  });
});

describe('匯出（WP-C 行為資料）', () => {
  test('保留每個人的選擇與作答耗時', () => {
    const q = started();
    q.answer(A, 3, T0 + 4200);
    q.reveal(T0 + 20000);
    q.end();
    const dump = q.export();
    assert.equal(dump.history.length, 1);
    assert.deepEqual(dump.history[0].answers, [{ agentId: A, choice: 3, elapsedMs: 4200 }]);
  });
});

describe('積分帳本', () => {
  test('分數跨來源累計', () => {
    const s = new ScoreBoard();
    s.award(A, 20, { source: 'PAIR' });
    s.award(A, 150, { source: 'QUIZ' });
    assert.equal(s.totalOf(A), 170);
    assert.deepEqual(s.breakdownOf(A), { PAIR: 20, QUIZ: 150 });
  });

  test('沒得過分的人是 0 分而非 undefined', () => {
    const s = new ScoreBoard();
    assert.equal(s.totalOf('查無此人'), 0);
  });

  test('負數與非數值一律歸零，不會扣分', () => {
    const s = new ScoreBoard();
    s.award(A, -50, { source: 'QUIZ' });
    s.award(A, NaN, { source: 'QUIZ' });
    assert.equal(s.totalOf(A), 0);
  });

  test('名次由高到低，同分同名次', () => {
    const s = new ScoreBoard();
    s.award(A, 100, { source: 'QUIZ' });
    s.award(B, 100, { source: 'QUIZ' });
    s.award(C, 50, { source: 'QUIZ' });
    const rows = s.standings();
    assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3]);
    assert.equal(s.rankOf(C), 3);
  });

  test('同分時先達到的人排前面', () => {
    const s = new ScoreBoard();
    s.award(B, 100, { source: 'QUIZ' });
    s.ledger.get(B).lastAt = T0 + 5000;   // 後到
    s.award(A, 100, { source: 'QUIZ' });
    s.ledger.get(A).lastAt = T0;          // 先到
    assert.equal(s.standings()[0].id, A);
  });

  test('離場者不佔排行榜，但分數留在帳本供匯出', () => {
    const s = new ScoreBoard();
    s.award(A, 100, { source: 'QUIZ' });
    s.award(B, 80, { source: 'QUIZ' });
    const present = (id) => id !== A;
    assert.deepEqual(s.leaderboard(5, () => '', present).map((r) => r.id), [B]);
    assert.equal(s.totalOf(A), 100);
    assert.ok(s.export().totals[A]);
  });

  test('排行榜取名字由呼叫端提供，帳本不存第二份姓名', () => {
    const s = new ScoreBoard();
    s.award(A, 100, { source: 'QUIZ' });
    const rows = s.leaderboard(3, (id) => (id === A ? '小美' : ''));
    assert.equal(rows[0].name, '小美');
    assert.equal(JSON.stringify(s.export()).includes('小美'), false, '匯出應維持假名化');
  });

  test('排行榜長度受限', () => {
    const s = new ScoreBoard();
    for (let i = 0; i < 20; i++) s.award(`usr_${i}`, i, { source: 'QUIZ' });
    assert.equal(s.leaderboard(5).length, 5);
  });

  test('得分流水保留來源與出處，供事後分析', () => {
    const s = new ScoreBoard();
    s.award(A, 180, { source: 'QUIZ', ref: 'qz_1234', detail: { correct: true } });
    const [event] = s.export().events;
    assert.equal(event.source, 'QUIZ');
    assert.equal(event.ref, 'qz_1234');
    assert.equal(event.correct, true);
  });
});
