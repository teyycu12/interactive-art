/**
 * 任務生命週期、配對狀態機與社交圖譜測試（規格 v3.0 §03、§04）
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MissionBoard } from '../server/missions.js';
import { SocialGraph } from '../server/socialgraph.js';
import { PairingSession } from '../server/pairing.js';
import { PAIRING } from '../server/config.js';
import { PAIR_ERRORS } from '../shared/protocol.js';

const A = 'usr_aaaa';
const B = 'usr_bbbb';
const C = 'usr_cccc';

describe('社交圖譜', () => {
  test('邊與方向無關，A→B 與 B→A 是同一條', () => {
    const g = new SocialGraph();
    assert.equal(g.connect(A, B), true);
    assert.equal(g.connect(B, A), false, '反向重複不應新增');
    assert.equal(g.size, 1);
  });

  test('同一對重複配對不重複計邊', () => {
    const g = new SocialGraph();
    g.connect(A, B);
    assert.equal(g.connect(A, B), false);
    assert.equal(g.size, 1);
  });

  test('不能和自己配對', () => {
    const g = new SocialGraph();
    assert.equal(g.connect(A, A), false);
    assert.equal(g.size, 0);
  });

  test('鄰接表雙向可查，供 Boids 凝聚偏置使用', () => {
    const g = new SocialGraph();
    g.connect(A, B);
    g.connect(A, C);
    assert.equal(g.degree(A), 2);
    assert.equal(g.degree(B), 1);
    assert.ok(g.neighbors(B).has(A));
  });

  test('匯出不含姓名，維持研究資料假名化', () => {
    const g = new SocialGraph();
    g.connect(A, B, 'msn_1');
    const dump = JSON.stringify(g.export());
    assert.ok(dump.includes(A) && dump.includes('msn_1'));
    assert.ok(!dump.includes('name'), '匯出不應含姓名欄位');
  });
});

describe('任務生命週期', () => {
  test('同時只允許一項任務', () => {
    const b = new MissionBoard();
    assert.equal(b.publish({ type: 'PAIRING', target: 2 }).ok, true);
    const second = b.publish({ type: 'PAIRING', target: 2 });
    assert.equal(second.ok, false, '不應允許第二項任務同時進行');
  });

  test('結算後可再發布', () => {
    const b = new MissionBoard();
    b.publish({ type: 'PAIRING', target: 2 });
    assert.ok(b.close());
    assert.equal(b.isActive, false);
    assert.equal(b.publish({ type: 'PAIRING', target: 3 }).ok, true);
  });

  test('拒絕未知型別與不合理的目標次數', () => {
    const b = new MissionBoard();
    assert.equal(b.publish({ type: 'QUIZ', target: 2 }).ok, false);
    assert.equal(b.publish({ type: 'PAIRING', target: 0 }).ok, false);
    assert.equal(b.publish({ type: 'PAIRING', target: 999 }).ok, false);
    assert.equal(b.publish({ type: 'PAIRING', target: 1.5 }).ok, false);
    assert.equal(b.isActive, false, '全部失敗後不應留下任務');
  });

  test('記帳並在達標時回報完成', () => {
    const b = new MissionBoard();
    b.publish({ type: 'PAIRING', target: 2 });
    assert.deepEqual(b.credit(A), { count: 1, done: false });
    assert.deepEqual(b.credit(A), { count: 2, done: true });
    assert.deepEqual(b.credit(A), { count: 3, done: true }, '超額仍可繼續累計');
  });

  test('無進行中任務時記帳無效', () => {
    const b = new MissionBoard();
    assert.equal(b.credit(A), null);
  });

  test('全場進度摘要正確', () => {
    const b = new MissionBoard();
    b.publish({ type: 'PAIRING', target: 2 });
    b.credit(A); b.credit(A);   // A 達標
    b.credit(B);                // B 進行中
    const s = b.state(5);
    assert.equal(s.finished, 1);
    assert.equal(s.participating, 2);
    assert.equal(s.totalCompletions, 3);
    assert.equal(s.totalAgents, 5);
  });

  test('結算後的任務進入歷史，可供匯出', () => {
    const b = new MissionBoard();
    b.publish({ type: 'PAIRING', target: 1 });
    b.credit(A, { with: B });
    b.close();
    const dump = b.export();
    assert.equal(dump.active, null);
    assert.equal(dump.history.length, 1);
    assert.equal(dump.history[0].events[0].with, B);
  });
});

describe('配對狀態機', () => {
  /** 建立一組已註冊配對碼的測試環境 */
  function setup() {
    const graph = new SocialGraph();
    const p = new PairingSession(graph);
    p.register(A); p.register(B); p.register(C);
    return { graph, p };
  }

  test('配對碼為指定長度的數字且互不相同', () => {
    const { p } = setup();
    const codes = [A, B, C].map((id) => p.codeOf(id));
    for (const c of codes) {
      assert.match(c, new RegExp(`^\\d{${PAIRING.codeLength}}$`));
    }
    assert.equal(new Set(codes).size, 3, '同時在場者的配對碼不可重複');
  });

  test('完整流程：提交 → 確認 → 建立關係', () => {
    const { graph, p } = setup();
    const claim = p.claim(A, p.codeOf(B));
    assert.equal(claim.ok, true);
    assert.equal(claim.target, B);

    const confirm = p.confirm(B, true);
    assert.equal(confirm.ok, true);
    assert.equal(graph.connected(A, B), true);
  });

  test('對方拒絕則不建立關係', () => {
    const { graph, p } = setup();
    p.claim(A, p.codeOf(B));
    const r = p.confirm(B, false);
    assert.equal(r.ok, false);
    assert.equal(r.reason, PAIR_ERRORS.DECLINED);
    assert.equal(r.from, A, '需回報發起方，否則他會一直空等');
    assert.equal(graph.connected(A, B), false);
  });

  test('不能配對自己', () => {
    const { p } = setup();
    const r = p.claim(A, p.codeOf(A));
    assert.equal(r.reason, PAIR_ERRORS.SELF);
  });

  test('已配對過的兩人不能重複配對', () => {
    const { graph, p } = setup();
    graph.connect(A, B);
    const now = Date.now() + PAIRING.claimCooldownMs;
    const r = p.claim(A, p.codeOf(B), now);
    assert.equal(r.reason, PAIR_ERRORS.ALREADY_PAIRED);
  });

  test('格式錯誤或不存在的配對碼一律被拒絕', () => {
    const { p } = setup();
    let t = 1_000_000;
    const tryClaim = (code) => {
      t += PAIRING.claimCooldownMs + 1; // 每次都跨過冷卻，隔離出格式判定
      return p.claim(A, code, t);
    };

    // 用一組確定沒人持有的碼
    const inUse = new Set([A, B, C].map((id) => p.codeOf(id)));
    let unused = '0000';
    for (let i = 0; inUse.has(unused); i++) unused = String(i).padStart(4, '0');

    assert.equal(tryClaim(unused).reason, PAIR_ERRORS.NOT_FOUND, '無人持有的碼');
    assert.equal(tryClaim('abcd').reason, PAIR_ERRORS.NOT_FOUND, '非數字');
    assert.equal(tryClaim('12').reason, PAIR_ERRORS.NOT_FOUND, '位數不足');
    assert.equal(tryClaim('123456').reason, PAIR_ERRORS.NOT_FOUND, '位數過多');
    assert.equal(tryClaim('').reason, PAIR_ERRORS.NOT_FOUND, '空字串');
    assert.equal(tryClaim(null).reason, PAIR_ERRORS.NOT_FOUND, 'null');
  });

  test('提交有冷卻，防止窮舉 4 位碼', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.claim(A, '1234', t);
    const second = p.claim(A, '1235', t + 100);
    assert.equal(second.reason, PAIR_ERRORS.COOLDOWN);
    // 冷卻結束後可再試
    const third = p.claim(A, '1236', t + PAIRING.claimCooldownMs + 1);
    assert.notEqual(third.reason, PAIR_ERRORS.COOLDOWN);
  });

  test('一人同時只處理一組確認', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.claim(A, p.codeOf(C), t);
    // B 想找同一個 C，C 正在確認中
    const r = p.claim(B, p.codeOf(C), t);
    assert.equal(r.reason, PAIR_ERRORS.BUSY);
  });

  test('發起方在等待確認期間不能再發起', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.claim(A, p.codeOf(B), t);
    const r = p.claim(A, p.codeOf(C), t + PAIRING.claimCooldownMs + 1);
    assert.equal(r.reason, PAIR_ERRORS.BUSY);
  });

  test('逾時未確認會被清除，且兩邊都能收到結果', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.claim(A, p.codeOf(B), t);
    const expired = p.sweep(t + PAIRING.confirmTimeoutMs + 1);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].from, A);
    assert.equal(expired[0].to, B);
    // 已清除，再確認應回報逾時
    assert.equal(p.confirm(B, true, t + 99999).reason, PAIR_ERRORS.EXPIRED);
  });

  test('輪換後舊碼在寬限期內仍有效', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.rotate(t); // 建立基準
    const oldCode = p.codeOf(B);
    p.rotate(t + PAIRING.rotateMs);
    const newCode = p.codeOf(B);
    assert.notEqual(oldCode, newCode, '應已輪換');

    // 寬限期內：舊碼仍可用，避免「剛唸完碼就輪換」造成無法理解的失敗
    const within = p.claim(A, oldCode, t + PAIRING.rotateMs + 1000);
    assert.equal(within.ok, true);
    assert.equal(within.target, B);
  });

  test('寬限期過後舊碼失效', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.rotate(t);
    const oldCode = p.codeOf(B);
    p.rotate(t + PAIRING.rotateMs);
    const late = t + PAIRING.rotateMs + PAIRING.graceMs + 1;
    assert.equal(p.claim(A, oldCode, late).reason, PAIR_ERRORS.NOT_FOUND);
  });

  test('輪換有最小間隔，不會每個 tick 都換', () => {
    const { p } = setup();
    const t = 1_000_000;
    assert.equal(p.rotate(t), true);
    assert.equal(p.rotate(t + 100), false, '未達間隔不應輪換');
    assert.equal(p.rotate(t + PAIRING.rotateMs), true);
  });

  test('離場者的配對碼被釋放，且其待確認一併清除', () => {
    const { p } = setup();
    const t = 1_000_000;
    p.claim(A, p.codeOf(B), t);
    p.release(A);
    assert.equal(p.codeOf(A), null);
    // A 已離場，B 手上的確認請求不應還能成立
    assert.equal(p.confirm(B, true, t + 100).ok, false);
  });
});
