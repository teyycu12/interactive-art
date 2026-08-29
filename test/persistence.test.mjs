/**
 * 快照落地、身分目錄與各模組還原的測試
 *
 * 執行：node --test
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SnapshotStore, Directory } from '../server/persistence.js';
import { ScoreBoard } from '../server/scores.js';
import { SocialGraph } from '../server/socialgraph.js';
import { MissionBoard } from '../server/missions.js';
import { QuizSession } from '../server/quiz.js';
import { Stage } from '../server/state.js';

const A = 'usr_aaaa';
const B = 'usr_bbbb';

const TMP = path.join(os.tmpdir(), `personaflow-test-${process.pid}`);
const fileFor = (name) => path.join(TMP, name);

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const AVATAR = {
  head: 'head_curly_02', face: 'face_smile_glasses', body: 'body_hoodie_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

describe('快照存取', () => {
  test('沒有檔案時載入回傳 null，而不是拋錯', () => {
    const store = new SnapshotStore(fileFor('missing.json'));
    assert.equal(store.load(), null);
  });

  test('寫入會自動建立目錄，並可原樣讀回', () => {
    const store = new SnapshotStore(fileFor('deep/nested/state.json'));
    store.touch();
    assert.equal(store.save({ hello: '世界', n: 42 }), true);
    assert.deepEqual(new SnapshotStore(fileFor('deep/nested/state.json')).load(),
      { hello: '世界', n: 42 });
  });

  test('沒有變動就不寫檔，閒置的場域不會一直磨磁碟', () => {
    const store = new SnapshotStore(fileFor('idle.json'));
    assert.equal(store.save({ a: 1 }), false, '未標記髒旗標不該寫入');
    assert.equal(fs.existsSync(fileFor('idle.json')), false);
    assert.equal(store.save({ a: 1 }, { force: true }), true, '關機前的強制寫入應照寫');
  });

  test('寫入後髒旗標歸零，下一次不重複寫', () => {
    const store = new SnapshotStore(fileFor('once.json'));
    store.touch();
    assert.equal(store.save({ a: 1 }), true);
    assert.equal(store.save({ a: 2 }), false);
  });

  test('不留下暫存檔（原子改名）', () => {
    const store = new SnapshotStore(fileFor('atomic.json'));
    store.touch();
    store.save({ a: 1 });
    assert.equal(fs.existsSync(`${fileFor('atomic.json')}.tmp`), false);
  });

  test('壞掉的快照不擋啟動，並保留成 .bad 供事後查', () => {
    const file = fileFor('broken.json');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(file, '{ 這不是 JSON', 'utf8');
    const store = new SnapshotStore(file);
    assert.equal(store.load(), null);
    assert.equal(fs.existsSync(`${file}.bad`), true);
  });

  test('關閉持久化時不讀也不寫', () => {
    const store = new SnapshotStore(fileFor('off.json'), { enabled: false });
    store.touch();
    assert.equal(store.save({ a: 1 }, { force: true }), false);
    assert.equal(store.load(), null);
    assert.equal(fs.existsSync(fileFor('off.json')), false);
  });
});

describe('身分目錄', () => {
  const agent = (id, name) => ({ id, name, avatar: AVATAR, rejoinToken: 'a'.repeat(32) });

  test('記住後可依 id 取回憑證', () => {
    const dir = new Directory();
    dir.remember(agent(A, '小美'));
    assert.equal(dir.get(A).name, '小美');
    assert.equal(dir.get('查無此人'), null);
  });

  test('超過保留上限時汰換最久沒出現的', () => {
    const dir = new Directory({ limit: 2 });
    dir.remember(agent('u1', '一'));
    dir.entries.get('u1').lastSeenAt = 1000;
    dir.remember(agent('u2', '二'));
    dir.entries.get('u2').lastSeenAt = 2000;
    dir.remember(agent('u3', '三'));
    assert.equal(dir.get('u1'), null, '最久沒出現的應被汰換');
    assert.ok(dir.get('u3'));
  });

  test('超過保留時間的項目會被清掉', () => {
    const dir = new Directory({ ttlMs: 1000 });
    dir.remember(agent('u1', '一'));
    dir.entries.get('u1').lastSeenAt = Date.now() - 5000;
    dir.remember(agent('u2', '二'));   // 任何一次寫入都會順手清理
    assert.equal(dir.get('u1'), null);
  });

  test('再次 remember 會覆蓋舊資料（改名要落地）', () => {
    // 同一條連線內改名走的是 handleJoin 的早退分支，那裡曾經只改記憶體裡的
    // 角色而不呼叫 remember —— 伺服器重開後認領回來的是改名前的舊名字，
    // 而且不會有任何錯誤訊息。
    const dir = new Directory();
    dir.remember(agent(A, '原本的名字'));
    dir.remember({ ...agent(A, '改過的名字'), team: 'B' });
    assert.equal(dir.get(A).name, '改過的名字');
    assert.equal(dir.get(A).team, 'B');
    assert.equal(dir.entries.size, 1, '同一個 id 不該產生第二筆');
  });

  test('可原樣還原，缺憑證的項目直接略過', () => {
    const dir = new Directory();
    dir.remember(agent(A, '小美'));
    const restored = new Directory().hydrate([
      ...dir.export(),
      { id: 'usr_broken' },   // 沒有憑證，無法用來認領
    ]);
    assert.equal(restored.get(A).rejoinToken, 'a'.repeat(32));
    assert.equal(restored.get('usr_broken'), null);
  });
});

describe('重開後的角色認領', () => {
  test('憑證相符即以原 id 重建角色，積分自動接回', () => {
    const before = new Stage();
    const agent = before.addAgent({ name: '小美', avatar: AVATAR });
    const scores = new ScoreBoard();
    scores.award(agent.id, 250, { source: 'QUIZ' });

    const dir = new Directory();
    dir.remember(agent);

    // ── 伺服器重開：Stage 全新，帳本與目錄由快照還原 ──
    const after = new Stage();
    const restoredScores = new ScoreBoard().hydrate(scores.export());
    const restoredDir = new Directory().hydrate(dir.export());

    const claimed = after.claimAgent(restoredDir.get(agent.id), agent.rejoinToken);
    assert.equal(claimed.id, agent.id);
    assert.equal(restoredScores.totalOf(claimed.id), 250);
  });

  test('憑證不符者拿不到別人的角色', () => {
    const stage = new Stage();
    const agent = stage.addAgent({ name: '小美', avatar: AVATAR });
    const dir = new Directory();
    dir.remember(agent);

    const after = new Stage();
    assert.equal(after.claimAgent(dir.get(agent.id), 'f'.repeat(32)), null);
    assert.equal(after.claimAgent(dir.get(agent.id), undefined), null);
    assert.equal(after.claimAgent(null, agent.rejoinToken), null);
  });

  test('該 id 已經在場上時不得重複認領', () => {
    const stage = new Stage();
    const agent = stage.addAgent({ name: '小美', avatar: AVATAR });
    const dir = new Directory();
    dir.remember(agent);
    assert.equal(stage.claimAgent(dir.get(agent.id), agent.rejoinToken), null);
  });

  test('認領回來的是全新的空間狀態，只有身分沿用', () => {
    const stage = new Stage();
    const agent = stage.addAgent({ name: '小美', avatar: AVATAR });
    agent.alpha = 1;
    agent.vx = 120;
    const dir = new Directory();
    dir.remember(agent);

    const after = new Stage();
    const claimed = after.claimAgent(dir.get(agent.id), agent.rejoinToken);
    assert.equal(claimed.alpha, 0, '座標與速度不落地，重來即可');
    assert.equal(claimed.vx, 0);
    assert.equal(claimed.rejoinToken, agent.rejoinToken, '憑證必須沿用，否則下次就認不回來');
  });
});

describe('各模組的還原', () => {
  test('積分帳本：總分、來源明細與排序依據都保住', () => {
    const s = new ScoreBoard();
    s.award(A, 100, { source: 'QUIZ' });
    s.award(A, 20, { source: 'PAIR' });
    s.award(B, 60, { source: 'QUIZ' });

    const r = new ScoreBoard().hydrate(s.export());
    assert.equal(r.totalOf(A), 120);
    assert.deepEqual(r.breakdownOf(A), { QUIZ: 100, PAIR: 20 });
    assert.deepEqual(r.standings().map((x) => x.id), [A, B]);
    assert.equal(r.export().events.length, 3, '得分流水一併保留');
  });

  test('社交圖譜：邊與鄰接表都回得來，重開不會讓兩人變回陌生人', () => {
    const g = new SocialGraph();
    g.connect(A, B, 'msn_1');
    const r = new SocialGraph().hydrate(g.export());
    assert.equal(r.size, 1);
    assert.equal(r.connected(B, A), true);
    assert.equal(r.degree(A), 1);
    assert.ok(r.neighbors(B).has(A), '鄰接表要能供 Boids 凝聚偏置查詢');
  });

  test('社交圖譜：還原後重複連線仍然去重', () => {
    const g = new SocialGraph();
    g.connect(A, B);
    const r = new SocialGraph().hydrate(g.export());
    assert.equal(r.connect(A, B), false);
    assert.equal(r.size, 1);
  });

  test('任務：進行中的任務連同每個人的進度一起還原', () => {
    const m = new MissionBoard();
    m.publish({ type: 'PAIRING', target: 2 });
    m.credit(A, { with: B });
    m.credit(A, { with: 'usr_cccc' });
    m.credit(B, { with: A });

    const r = new MissionBoard().hydrate(m.export());
    assert.equal(r.isActive, true);
    assert.equal(r.progressOf(A), 2);
    assert.equal(r.progressOf(B), 1);
    assert.equal(r.state(2).finished, 1);
    assert.equal(r.announcement().title, '找一個人配對');
  });

  test('任務：還原後可以繼續記帳與結算', () => {
    const m = new MissionBoard();
    m.publish({ type: 'PAIRING', target: 2 });
    m.credit(A);
    const r = new MissionBoard().hydrate(m.export());
    assert.deepEqual(r.credit(A), { count: 2, done: true });
    assert.ok(r.close());
    assert.equal(r.isActive, false);
    assert.equal(r.history.length, 1);
  });

  test('問答：進行中的那一題併入歷史而不還原，題號繼續往下數', () => {
    const q = new QuizSession();
    const spec = {
      question: '第一題', options: ['甲', '乙'], correctIndex: 0, durationMs: 10000,
    };
    q.start(spec);
    q.reveal();
    q.end();
    q.start({ ...spec, question: '第二題' });   // 這題還在進行中

    const r = new QuizSession().hydrate(q.export());
    assert.equal(r.isActive, false, '倒數在重開後已無意義，不該還原');
    assert.equal(r.history.length, 2, '未收掉的題目仍進歷史，資料不遺失');
    assert.equal(r.asked, 2);

    r.start({ ...spec, question: '第三題' });
    assert.equal(r.publicView().index, 3, '題號不該出現重複');
  });

  test('問答：歷史裡的作答紀錄還原成可查詢的形狀', () => {
    const q = new QuizSession();
    q.start({ question: '題', options: ['甲', '乙'], correctIndex: 0, durationMs: 10000 });
    q.answer(A, 0);
    q.reveal();
    q.end();

    const r = new QuizSession().hydrate(q.export());
    assert.equal(r.history[0].answers.get(A).choice, 0);
  });

  test('整份快照 JSON 化後仍能還原（實際落地會經過序列化）', () => {
    const s = new ScoreBoard();
    s.award(A, 100, { source: 'QUIZ' });
    const g = new SocialGraph();
    g.connect(A, B);
    const m = new MissionBoard();
    m.publish({ type: 'PAIRING', target: 2 });
    m.credit(A);

    const roundTrip = JSON.parse(JSON.stringify({
      scores: s.export(), graph: g.export(), missions: m.export(),
    }));

    assert.equal(new ScoreBoard().hydrate(roundTrip.scores).totalOf(A), 100);
    assert.equal(new SocialGraph().hydrate(roundTrip.graph).size, 1);
    assert.equal(new MissionBoard().hydrate(roundTrip.missions).progressOf(A), 1);
  });
});
