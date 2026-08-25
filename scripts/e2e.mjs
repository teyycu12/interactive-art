/**
 * 端對端測試：啟動真實 Gateway，模擬手機與大螢幕跑完整條資料流。
 *
 * 執行：npm run test:e2e
 *
 * 與 node --test 的單元測試分開，因為它需要真實的 WebSocket 連線與
 * 數秒等待（α 衰減、廣播頻率量測），不適合放進每次都跑的快速測試。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CLIENT_SYNC_RADIUS, STAGE, MAX_SPEED } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3199;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AVATAR = {
  head: 'head_curly_02', face: 'face_smile_glasses', body: 'body_hoodie_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

let pass = 0;
let fail = 0;
function check(label, ok, extra = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
}

// ── 啟動伺服器 ────────────────────────────────────────────
// 快照寫到暫存檔並在開始前刪掉，測試之間互不影響；
// 但持久化本身保持開啟 —— 重開後能否接續正是要驗的事情之一。
const STATE_FILE = path.join(os.tmpdir(), 'personaflow-e2e-state.json');
const KEY_PATTERN = /主辦端通行密鑰\s+([A-Z0-9]+)/;
try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* 略 */ }

let server = null;
let serverLog = [];

/**
 * 啟動一台伺服器並等到啟動訊息完整輸出，回傳通行密鑰。
 *
 * 等的是密鑰那一行而不是「已啟動」：兩者由同一段程式印出，但走的是管道，
 * 父行程可能先收到前半段。等「已啟動」就開始解析密鑰會偶發拿到 undefined，
 * 而那種失敗看起來會像是認證壞掉，非常難查。
 */
async function launch() {
  serverLog = [];
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), PERSONAFLOW_STATE_FILE: STATE_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (KEY_PATTERN.test(serverLog.join(''))) break;
  }
  const key = serverLog.join('').match(KEY_PATTERN)?.[1];
  if (!key) {
    console.error('伺服器啟動失敗：\n' + serverLog.join(''));
    server.kill();
    process.exit(1);
  }
  return key;
}

/** 正常關閉（SIGTERM），伺服器會走 shutdown 流程寫下最後一份快照 */
async function stopServer() {
  if (!server) return;
  const proc = server;
  server = null;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await Promise.race([exited, sleep(3000)]);
}

const HOST_KEY = await launch();

function finish() {
  server?.kill();
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* 略 */ }
  console.log(`\n${pass}/${pass + fail} 通過`);
  process.exit(fail ? 1 : 0);
}

// ── 大螢幕 ────────────────────────────────────────────────
const screen = new WebSocket(URL);
let meta = null;
let roster = null;
let syncs = [];
screen.on('open', () => screen.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
screen.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'STAGE_META') meta = m;
  if (m.type === 'STAGE_ROSTER') roster = m;
  if (m.type === 'STAGE_SYNC') syncs.push(m);
  if (m.type === 'QUIZ_QUESTION') screenQuiz = m.quiz;
  if (m.type === 'QUIZ_REVEAL') screenReveal = m;
  if (m.type === 'QUIZ_ENDED') screenQuiz = null;
  if (m.type === 'SCORE_BOARD') scoreBoard = m;
});
let screenQuiz = null;
let screenReveal = null;
let scoreBoard = null;
const live = () => syncs.at(-1)?.agents ?? [];

await sleep(400);
check('大螢幕收到 STAGE_META', meta?.stage?.width === 1920);

// ── 資料驗證 ──────────────────────────────────────────────
const bad = new WebSocket(URL);
let reject = null;
bad.on('open', () => bad.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '駭客',
  avatar: { ...AVATAR, head: '../../etc/passwd' },
})));
bad.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'CLIENT_REJECT') reject = m; });
await sleep(300);
check('非法 head token 被拒絕', !!reject, reject?.reason);
bad.close();

// ── 登入 ──────────────────────────────────────────────────
const phone = new WebSocket(URL);
let welcome = null;
phone.on('open', () => phone.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '冠儀', avatar: AVATAR,
})));
const phoneSyncs = [];
phone.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') welcome = m;
  if (m.type === 'CLIENT_SYNC') phoneSyncs.push(m);
});
await sleep(400);
check('手機登入成功', !!welcome?.userId, welcome?.userId);
check('CLIENT_WELCOME 帶有重連憑證', welcome?.rejoinToken?.length === 32);
check('大螢幕收到名冊，含捏臉外觀', roster?.agents?.[0]?.avatar?.head === 'head_curly_02');

// ── M2：搖桿操控 ──────────────────────────────────────────
const before = live()[0];
for (let i = 0; i < 20; i++) {
  phone.send(JSON.stringify({ type: 'INPUT_MOVE', vector: { x: 1, y: 0 }, intensity: 1 }));
  await sleep(50);
}
const moving = live()[0];
check('推桿後 α 升至 1（主動控制態）', moving.alpha === 1, `α=${moving.alpha} mode=${moving.mode}`);
check('角色確實向右移動', moving.x > before.x, `${before.x} → ${moving.x}`);
check('回報步行狀態 WALK', moving.state === 'WALK');
check('轉向鏡像 facing = 1', moving.facing === 1);

// ── 社交動作 ──────────────────────────────────────────────
phone.send(JSON.stringify({ type: 'INPUT_ACTION', action: 'CHEERS' }));
await sleep(200);
check('社交動作出現在 STAGE_SYNC', live()[0].emote === 'CHEERS');
phone.send(JSON.stringify({ type: 'INPUT_ACTION', action: 'DROP_TABLE' }));
await sleep(200);
check('白名單外的動作被丟棄', live()[0].emote === 'CHEERS');

// ── M2：閒置交還控制權 ────────────────────────────────────
await sleep(4600);
const idle = live()[0];
check('閒置後 α 衰減回 0', idle.alpha === 0, `α=${idle.alpha}`);
check('模式切換為湧現漫遊態', idle.mode === 'SWARM');

// ── 廣播頻率 ──────────────────────────────────────────────
{
  const t0 = syncs.at(-1).t;
  const n0 = syncs.length;
  await sleep(5000);
  const hz = (syncs.length - n0) / ((syncs.at(-1).t - t0) / 1000);
  check('STAGE_SYNC 達到 30 Hz（±1）', hz > 29 && hz < 31, `${hz.toFixed(1)} Hz`);
}

// ── 手機端個人視角（CLIENT_SYNC）────────────────────────────
{
  const n0 = phoneSyncs.length;
  await sleep(2000);
  const hz = (phoneSyncs.length - n0) / 2;
  // 刻意低於大螢幕的 30Hz：手機是每人一條連線，30Hz×10人 會吃掉現場頻寬
  check('CLIENT_SYNC 約 10 Hz（±2）', hz >= 8 && hz <= 12, `${hz.toFixed(1)} Hz`);

  const self = phoneSyncs.at(-1)?.self;
  check('CLIENT_SYNC 帶有自身座標與 α',
    typeof self?.x === 'number' && typeof self?.vx === 'number'
      && typeof self?.alpha === 'number' && typeof self?.facing === 'number',
    JSON.stringify(self));
  // 與 STAGE_SYNC 同一個頻寬取捨：外觀是靜態資料，不進每秒數十次的封包
  check('CLIENT_SYNC 不含捏臉外觀', self && !('avatar' in self));
  check('場上只有自己時 neighbors 為空', phoneSyncs.at(-1)?.neighbors?.length === 0,
    JSON.stringify(phoneSyncs.at(-1)?.neighbors));

  // 伺服器座標必須與大螢幕看到的同一份 —— 兩邊若不同步，
  // 使用者低頭與抬頭會看到不同的位置（issue #8 的坑）
  const onScreen = live().find((a) => a.id === welcome.userId);
  check('CLIENT_SYNC 與 STAGE_SYNC 是同一份座標',
    Math.abs(onScreen.x - self.x) < 40 && Math.abs(onScreen.y - self.y) < 40,
    `螢幕 ${onScreen.x},${onScreen.y} / 手機 ${self.x},${self.y}`);
}

// ── 鄰居可見性 ────────────────────────────────────────────
{
  const mate = new WebSocket(URL);
  const mateSyncs = [];
  let mateWelcome = null;
  mate.on('open', () => mate.send(JSON.stringify({
    type: 'CLIENT_JOIN', name: '鄰居', avatar: AVATAR,
  })));
  mate.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'CLIENT_WELCOME') mateWelcome = m;
    if (m.type === 'CLIENT_SYNC') mateSyncs.push(m);
  });
  await sleep(600);

  // 兩人的初始位置由 spawnPoint() 隨機決定，距離可能一開始就超過可見半徑。
  // 這裡主動把手機推向對方，讓測項驗證的是「半徑內看得見」而不是
  // 「隨機生成剛好夠近」。
  //
  // 迴圈次數必須夠走完整個場域對角線（約 2200 單位）。IDLE_MOTION 預設為
  // 'still' 之後，閒置角色不再漂移 —— 過去有一部分距離是靠 Boids 漂移
  // 湊巧拉近的，現在全得靠這個迴圈自己走完。次數不足時兩人會停在半徑外，
  // 失敗訊息卻只說「看不到鄰居」，看不出是測試沒走到位。
  const walkSteps = Math.ceil((STAGE.width + STAGE.height) / (MAX_SPEED * 0.05)) + 20;
  for (let i = 0; i < walkSteps; i++) {
    const me = phoneSyncs.at(-1)?.self;
    const you = mateSyncs.at(-1)?.self;
    if (!me || !you) break;
    const dx = you.x - me.x;
    const dy = you.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < CLIENT_SYNC_RADIUS * 0.5) break;
    phone.send(JSON.stringify({
      type: 'INPUT_MOVE', vector: { x: dx / d, y: dy / d }, intensity: 1,
    }));
    await sleep(50);
  }
  await sleep(300);

  const mine = phoneSyncs.at(-1);
  const theirs = mateSyncs.at(-1);
  const seen = mine?.neighbors?.find((n) => n.id === mateWelcome?.userId);
  check('看得到鄰近的另一位參與者', !!seen, JSON.stringify(mine?.neighbors));
  // 相對座標而非絕對：手機把自己畫在畫面中央，要的本來就是相對位移
  check('鄰居用相對座標 dx/dy', seen && 'dx' in seen && !('x' in seen));

  const back = theirs?.neighbors?.find((n) => n.id === welcome.userId);
  check('雙方互相看得見', !!back);
  check('雙方的相對座標互為反向',
    back && Math.abs(seen.dx + back.dx) < 40 && Math.abs(seen.dy + back.dy) < 40,
    `${seen?.dx},${seen?.dy} vs ${back?.dx},${back?.dy}`);
  check('鄰居距離在可見半徑內',
    seen && Math.hypot(seen.dx, seen.dy) <= CLIENT_SYNC_RADIUS,
    `${Math.hypot(seen?.dx ?? 0, seen?.dy ?? 0).toFixed(0)} / ${CLIENT_SYNC_RADIUS}`);

  mate.close();
  await sleep(2700);   // 等 TTL 回收，避免影響後續測項
}

// ── 斷線與重連 ────────────────────────────────────────────
const uid = welcome.userId;
phone.close();
await sleep(2700);
const ghost = live().find((a) => a.id === uid);
check('斷線後角色仍留在場上（不讓畫面卡死）', !!ghost);
check('斷線逾 2 秒標記為離線', ghost?.offline === true);

const hijack = new WebSocket(URL);
let stolen = null;
hijack.on('open', () => hijack.send(JSON.stringify({
  type: 'CLIENT_JOIN', userId: uid, rejoinToken: 'f'.repeat(32), name: '攻擊者', avatar: AVATAR,
})));
hijack.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'CLIENT_WELCOME') stolen = m; });
await sleep(400);
check('偽造憑證無法接管他人角色', stolen && stolen.userId !== uid, `取得 ${stolen?.userId}`);
hijack.close();

const phone2 = new WebSocket(URL);
let welcome2 = null;
phone2.on('open', () => phone2.send(JSON.stringify({
  type: 'CLIENT_JOIN', userId: uid, rejoinToken: welcome.rejoinToken, name: '冠儀', avatar: AVATAR,
})));
phone2.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'CLIENT_WELCOME') welcome2 = m; });
await sleep(400);
check('憑證正確時接回同一角色', welcome2?.userId === uid);

// ── 重複登入不得產生幽靈 ──────────────────────────────────
const countBefore = live().length;
for (let i = 0; i < 50; i++) {
  phone2.send(JSON.stringify({ type: 'CLIENT_JOIN', name: '幽靈' + i, avatar: AVATAR }));
}
await sleep(600);
check('重複 CLIENT_JOIN 不產生幽靈角色', live().length === countBefore, `${live().length} 人`);

// ── 主動退出 ──────────────────────────────────────────────
phone2.send(JSON.stringify({ type: 'CLIENT_LEAVE' }));
await sleep(500);
check('CLIENT_LEAVE 後角色立即離場', !live().some((a) => a.id === uid), `場上 ${live().length} 人`);

phone2.send(JSON.stringify({ type: 'INPUT_MOVE', vector: { x: 1, y: 0 }, intensity: 1 }));
await sleep(300);
check('退出後的輸入不會讓角色復活', !live().some((a) => a.id === uid));

// ── 重新進場為全新角色 ────────────────────────────────────
const phone3 = new WebSocket(URL);
let welcome3 = null;
phone3.on('open', () => phone3.send(JSON.stringify({
  type: 'CLIENT_JOIN', userId: uid, rejoinToken: welcome.rejoinToken, name: '冠儀', avatar: AVATAR,
})));
phone3.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'CLIENT_WELCOME') welcome3 = m; });
await sleep(400);
check('可重新進場', !!welcome3?.userId);
check('重新進場是全新角色，非接回已離場的', welcome3.userId !== uid, `${uid} → ${welcome3?.userId}`);

// ─────────────────────────────────────────────────────────
// P2：主辦端與配對任務
// ─────────────────────────────────────────────────────────
check('啟動時印出主辦端通行密鑰', /^[A-Z0-9]{6}$/.test(HOST_KEY ?? ''), HOST_KEY);

// 錯誤密鑰必須被拒絕
const badHost = new WebSocket(URL);
let hostRejected = false;
let badHostWelcomed = false;
badHost.on('open', () => badHost.send(JSON.stringify({ type: 'HOST_AUTH', key: 'ZZZZZZ' })));
badHost.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'HOST_REJECT') hostRejected = true;
  if (m.type === 'HOST_WELCOME') badHostWelcomed = true;
});
await sleep(400);
check('錯誤的通行密鑰被拒絕', hostRejected && !badHostWelcomed);

// 未認證的連線不得發布任務
badHost.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'PAIRING', target: 2 }));
await sleep(300);

// 正確密鑰
const host = new WebSocket(URL);
let hostOk = false;
let hostStates = [];
let missionStates = [];
let completions = [];
let hostRejects = [];
let hostScoring = null;
host.on('open', () => host.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY })));
host.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'HOST_WELCOME') hostOk = true;
  if (m.type === 'HOST_WELCOME') hostScoring = m.scoring;
  if (m.type === 'HOST_STATE') hostStates.push(m);
  if (m.type === 'HOST_REJECT') hostRejects.push(m);
  if (m.type === 'MISSION_STATE') missionStates.push(m);
  if (m.type === 'MISSION_COMPLETE') completions.push(m);
});
await sleep(400);
check('正確密鑰通過認證', hostOk);
check('未認證連線無法發布任務', missionStates.length === 0, `收到 ${missionStates.length} 則`);

// ── 兩位參與者進場 ────────────────────────────────────────
function joinPhone(name) {
  const ws = new WebSocket(URL);
  const box = {
    ws, name, welcome: null, code: null, mission: null, results: [], confirmReq: null,
    quiz: null, acks: [], quizResult: null, scores: [],
  };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'CLIENT_JOIN', name, avatar: AVATAR })));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'CLIENT_WELCOME') box.welcome = m;
    if (m.type === 'PAIR_CODE') box.code = m.code;
    if (m.type === 'MISSION_ANNOUNCE') box.mission = m;
    if (m.type === 'PAIR_CONFIRM_REQ') box.confirmReq = m;
    if (m.type === 'PAIR_RESULT') box.results.push(m);
    if (m.type === 'QUIZ_QUESTION') box.quiz = m.quiz;
    if (m.type === 'QUIZ_ACK') box.acks.push(m);
    if (m.type === 'QUIZ_RESULT') box.quizResult = m;
    if (m.type === 'SCORE_SELF') box.scores.push(m);
  });
  return box;
}

const amy = joinPhone('小美');
const ben = joinPhone('阿賓');
await sleep(500);
check('兩位參與者都拿到配對碼', /^\d{4}$/.test(amy.code ?? '') && /^\d{4}$/.test(ben.code ?? ''),
  `${amy.code} / ${ben.code}`);
check('兩人的配對碼不相同', amy.code !== ben.code);

// ── 發布任務 ──────────────────────────────────────────────
host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'PAIRING', target: 1 }));
await sleep(500);
check('手機收到任務公告', amy.mission?.mission?.type === 'PAIRING', amy.mission?.mission?.title);
check('主辦端收到任務進度', missionStates.length > 0);

// 尚未配對前，社交圖譜為空
check('任務剛發布時社交圖譜為空', hostStates.at(-1)?.graphEdges === 0);

// ── 配對流程 ──────────────────────────────────────────────
amy.ws.send(JSON.stringify({ type: 'PAIR_CLAIM', code: ben.code }));
await sleep(400);
check('提交配對碼後對方收到確認請求', ben.confirmReq?.name === '小美', ben.confirmReq?.name);
check('確認請求附帶發起人的捏臉外觀', !!ben.confirmReq?.avatar);
check('發起方收到「等待確認」', amy.results.at(-1)?.pending === true);

ben.ws.send(JSON.stringify({ type: 'PAIR_CONFIRM', accept: true }));
await sleep(500);
check('雙方都收到配對成功', amy.results.at(-1)?.ok === true && ben.results.at(-1)?.ok === true);
check('配對成功回報對方姓名', amy.results.at(-1)?.partnerName === '阿賓', amy.results.at(-1)?.partnerName);
check('達標時回報 done', amy.results.at(-1)?.done === true);
check('大螢幕與主辦端收到完成事件', completions.length === 1, `${completions.length} 則`);
check('社交圖譜寫入一條邊', hostStates.at(-1)?.graphEdges === 1);

// ── 重複配對應被拒絕 ──────────────────────────────────────
await sleep(3100); // 跨過提交冷卻
amy.ws.send(JSON.stringify({ type: 'PAIR_CLAIM', code: ben.code }));
await sleep(400);
check('已配對過的兩人不能重複配對',
  amy.results.at(-1)?.reason === 'ALREADY_PAIRED', amy.results.at(-1)?.reason);

// ── 配對自己 ──────────────────────────────────────────────
await sleep(3100);
amy.ws.send(JSON.stringify({ type: 'PAIR_CLAIM', code: amy.code }));
await sleep(400);
check('不能和自己配對', amy.results.at(-1)?.reason === 'SELF', amy.results.at(-1)?.reason);

// ── 積分：配對得分 ────────────────────────────────────────
check('主辦端拿到計分規則', hostScoring?.quizCorrect > 0, `答對 ${hostScoring?.quizCorrect} 分`);
const amyAfterPair = amy.scores.at(-1);
check('配對成功會加分', (amyAfterPair?.score ?? 0) > 0, `${amyAfterPair?.score} 分`);
check('配對回應帶有本次得分', (amy.results.find((r) => r.ok && !r.pending)?.points ?? 0) > 0);

// ── 即時問答 ──────────────────────────────────────────────
host.send(JSON.stringify({
  type: 'HOST_START_QUIZ',
  question: 'Boids 的三條規則不含下列哪一項？',
  options: ['分離', '對齊', '凝聚', '投票'],
  correctIndex: 3,
  durationMs: 10000,
}));
await sleep(500);
check('兩支手機都收到題目', amy.quiz?.id && ben.quiz?.id === amy.quiz.id);
check('大螢幕也收到題目', screenQuiz?.question?.includes('Boids'));
check('題目不含正解（正解不離開伺服器）',
  amy.quiz && !('correctIndex' in amy.quiz), JSON.stringify(Object.keys(amy.quiz ?? {})));
check('題目帶有剩餘時間而非絕對時戳',
  amy.quiz?.remainingMs > 0 && amy.quiz?.remainingMs <= 10000, `${amy.quiz?.remainingMs}ms`);

// 出題期間不能再出下一題
host.send(JSON.stringify({
  type: 'HOST_START_QUIZ', question: '插隊的題目', options: ['一', '二'],
  correctIndex: 0, durationMs: 10000,
}));
await sleep(300);
check('同時只允許一題', hostRejects.length === 1, hostRejects.at(-1)?.reason);

amy.ws.send(JSON.stringify({ type: 'QUIZ_ANSWER', choice: 3 }));
ben.ws.send(JSON.stringify({ type: 'QUIZ_ANSWER', choice: 0 }));
await sleep(400);
check('作答被鎖定', amy.acks.at(-1)?.ok === true && amy.acks.at(-1)?.choice === 3);
check('鎖定回應不透露對錯', amy.acks.at(-1) && !('correct' in amy.acks.at(-1)));

amy.ws.send(JSON.stringify({ type: 'QUIZ_ANSWER', choice: 0 }));
await sleep(300);
check('同一題不能改答案', amy.acks.at(-1)?.reason === 'ALREADY_ANSWERED', amy.acks.at(-1)?.reason);

const scoreBeforeQuiz = amy.scores.at(-1)?.score ?? 0;
host.send(JSON.stringify({ type: 'HOST_REVEAL_QUIZ' }));
await sleep(500);
check('答對者得分', amy.quizResult?.correct === true && amy.quizResult?.points > 0,
  `+${amy.quizResult?.points}`);
check('答錯者不得分', ben.quizResult?.correct === false && ben.quizResult?.points === 0);
check('答錯者仍收到正解', ben.quizResult?.correctIndex === 3);
check('積分累加而非取代', amy.quizResult?.score === scoreBeforeQuiz + amy.quizResult.points,
  `${scoreBeforeQuiz} + ${amy.quizResult?.points} = ${amy.quizResult?.score}`);
check('速度分：立刻作答接近滿額',
  amy.quizResult?.points >= hostScoring.quizCorrect + hostScoring.quizSpeedBonus * 0.8,
  `${amy.quizResult?.points} / ${hostScoring.quizCorrect + hostScoring.quizSpeedBonus}`);
check('大螢幕收到答案分佈', screenReveal?.counts?.[3] === 1 && screenReveal?.counts?.[0] === 1,
  JSON.stringify(screenReveal?.counts));
check('大螢幕拿到答對者名單以繪製光環', screenReveal?.correctIds?.length === 1);

await sleep(700);
check('排行榜由伺服器計算並廣播', (scoreBoard?.leaderboard?.length ?? 0) >= 2);
check('排行榜第一名分數最高',
  scoreBoard?.leaderboard?.[0]?.score >= scoreBoard?.leaderboard?.[1]?.score,
  scoreBoard?.leaderboard?.map((r) => `${r.name} ${r.score}`).join('　'));
check('主辦端現況帶有每人積分',
  (hostStates.at(-1)?.agents ?? []).every((a) => typeof a.score === 'number'));
// 名冊縮圖靠這個欄位。少了它，主辦端只剩一串自填的名字 ——
// 現場那些名字常常重複或看不懂，等於認不出要踢的是誰。
check('主辦端現況帶有每人外觀',
  (hostStates.at(-1)?.agents ?? []).every((a) => a.avatar && typeof a.avatar === 'object'));

host.send(JSON.stringify({ type: 'HOST_END_QUIZ' }));
await sleep(400);
check('收題後題目自畫面撤下', screenQuiz === null);
check('收題後可以出下一題', (() => {
  host.send(JSON.stringify({
    type: 'HOST_START_QUIZ', question: '第二題', options: ['甲', '乙'],
    correctIndex: 0, durationMs: 5000,
  }));
  return true;
})());
await sleep(400);
check('第二題的題號遞增', amy.quiz?.index === 2, `index=${amy.quiz?.index}`);

// 時間到自動揭曉，主辦端不必手動按
await sleep(6200);
check('時間到自動公布正解', amy.quizResult?.correctIndex === 0 && amy.quizResult?.answered === false,
  `answered=${amy.quizResult?.answered}`);
host.send(JSON.stringify({ type: 'HOST_END_QUIZ' }));
await sleep(300);

// ── 主辦端踢人 ────────────────────────────────────────────
const benId = ben.welcome.userId;
host.send(JSON.stringify({ type: 'HOST_KICK', agentId: benId }));
await sleep(500);
check('主辦端可移除參與者', !live().some((a) => a.id === benId), `場上 ${live().length} 人`);

// ── 結算任務 ──────────────────────────────────────────────
host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION' }));
await sleep(400);
check('任務結算後可再發布新任務',
  (() => {
    host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'PAIRING', target: 2 }));
    return true;
  })());
await sleep(400);
check('新任務已生效', hostStates.at(-1)?.mission?.target === 2, `target=${hostStates.at(-1)?.mission?.target}`);

amy.ws.close();
ben.ws.close();
host.close();
badHost.close();
await sleep(300);

// ── 速率限制 ──────────────────────────────────────────────
const flood = new WebSocket(URL);
flood.on('open', () => flood.send(JSON.stringify({ type: 'CLIENT_JOIN', name: '洪水', avatar: AVATAR })));
await sleep(300);
for (let i = 0; i < 20000; i++) {
  if (flood.readyState !== WebSocket.OPEN) break;
  flood.send(JSON.stringify({ type: 'INPUT_MOVE', vector: { x: 1, y: 0 }, intensity: 1 }));
}
await sleep(800);
check('持續洪水的連線被中斷', flood.readyState !== WebSocket.OPEN);

phone3.close();
screen.close();
flood.close();
await sleep(200);

// ── 重開伺服器後的資料保留 ────────────────────────────────
// 現場最真實的災難情境：主辦筆電當掉，或有人誤觸 Ctrl+C。
const amyId = amy.welcome.userId;
const amyToken = amy.welcome.rejoinToken;
const amyScoreBefore = amy.scores.at(-1)?.score ?? 0;

await stopServer();
const keyAfterRestart = await launch();

check('重開後通行密鑰不變，主辦端不必重讀新號碼',
  keyAfterRestart === HOST_KEY, `${HOST_KEY} → ${keyAfterRestart}`);
check('重開後終端機顯示已接續上次的活動資料',
  serverLog.join('').includes('已接續上次的活動資料'));

const back = new WebSocket(URL);
let backWelcome = null;
let backScore = null;
back.on('open', () => back.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '小美', avatar: AVATAR, userId: amyId, rejoinToken: amyToken,
})));
back.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') backWelcome = m;
  if (m.type === 'SCORE_SELF') backScore = m;
});
await sleep(700);
check('重開後帶原憑證回來會認領回同一個角色',
  backWelcome?.userId === amyId, `${amyId} → ${backWelcome?.userId}`);
check('積分跟著角色一起回來',
  backScore?.score === amyScoreBefore && amyScoreBefore > 0,
  `${amyScoreBefore} → ${backScore?.score}`);

// 憑證不符的人不能冒領別人的分數
const thief = new WebSocket(URL);
let thiefWelcome = null;
thief.on('open', () => thief.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '冒領者', avatar: AVATAR,
  userId: amyId, rejoinToken: 'f'.repeat(32),
})));
thief.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') thiefWelcome = m;
});
await sleep(500);
check('憑證不符者拿不到別人的角色與積分',
  !!thiefWelcome?.userId && thiefWelcome.userId !== amyId, thiefWelcome?.userId);

back.close();
thief.close();
await sleep(200);

// ── 安全性回歸 ────────────────────────────────────────────
//
// 以下三項都曾是實際可利用的漏洞，且單元測試抓不到（它們發生在
// HTTP 路由與連線角色轉換上）。任一項回歸都會直接危及現場運作，
// 因此固定在端對端測試裡把守。

/** 對 Gateway 發一個 HTTP 請求，回傳狀態碼；連線失敗回傳 0 */
function httpStatus(rawPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

function httpBody(pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', () => resolve(''));
    req.end();
  });
}

// 曾可讀到 .env 與 data/state.json（內含主辦密鑰與所有重連憑證）
check('路徑穿越讀不到 .env',
  (await httpStatus('/shared/..%2f.env')) === 403);
check('路徑穿越讀不到活動快照',
  (await httpStatus('/shared/..%2fdata%2fstate.json')) === 403);
check('正常的 /shared/ 資源仍可載入',
  (await httpStatus('/shared/avatars.js')) === 200);

// three 一度指向 jsdelivr CDN：本機開發正常，但展場網路不通時大螢幕的
// 整個 3D 背景會消失 —— 而那是本機永遠測不出來的故障。
check('three 由本機直出，不依賴 CDN',
  (await httpStatus('/vendor/three.module.js')) === 200);
check('three addons 由本機直出',
  (await httpStatus('/vendor/three-addons/controls/OrbitControls.js')) === 200);
check('大螢幕頁面不含任何 CDN 連結',
  !(await httpBody('/screen/')).includes('jsdelivr'));

// addons 走目錄映射而非逐檔白名單，穿越防護是該分支自己做的，
// 不受下方那套只涵蓋 PUBLIC_DIR 與 shared 的通用檢查保護。
check('addons 路徑穿越讀不到 .env',
  (await httpStatus('/vendor/three-addons/..%2f..%2f..%2f.env')) === 403);
check('addons 路徑穿越讀不到活動快照',
  (await httpStatus('/vendor/three-addons/..%2f..%2f..%2f..%2fdata%2fstate.json')) !== 200);

// 曾可用一個壞掉的網址讓整個 Gateway 行程結束
check('無效百分比編碼回 400 而非終止行程',
  (await httpStatus('/%E0%A4%A')) === 400);
check('送出無效網址之後伺服器仍存活',
  (await httpStatus('/screen/')) === 200);

// 曾可讓已入場的控制器改註冊為大螢幕，使角色永久留在場上、耗盡人數上限
const shifty = new WebSocket(URL);
let shiftyGotScreenData = false;
shifty.on('open', () => shifty.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '轉職者', avatar: AVATAR,
})));
shifty.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') shifty.send(JSON.stringify({ type: 'SCREEN_HELLO' }));
  // STAGE_META 只發給註冊成功的大螢幕，收到就代表角色轉換確實發生了
  if (m.type === 'STAGE_META') shiftyGotScreenData = true;
});
await sleep(600);
check('已入場的控制器不能改註冊為大螢幕', !shiftyGotScreenData);
shifty.close();
await sleep(200);

// 曾可用路徑裡的 CR/LF 讓 302 的 Location 標頭拋錯而終止行程
check('路徑含 CRLF 回 400 而非終止行程',
  (await httpStatus('/a%0d%0ab')) === 400);
check('送出 CRLF 之後伺服器仍存活',
  (await httpStatus('/screen/')) === 200);
check('正常的目錄轉址不受影響',
  (await httpStatus('/controller')) === 302);

// 與大螢幕同一類的角色轉換：已入場的裝置不得改登入主辦端
const shiftyHost = new WebSocket(URL);
let shiftyHostWelcome = false;
let shiftyHostRejected = false;
shiftyHost.on('open', () => shiftyHost.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '想當主辦', avatar: AVATAR,
})));
shiftyHost.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') {
    shiftyHost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  }
  if (m.type === 'HOST_WELCOME') shiftyHostWelcome = true;
  if (m.type === 'HOST_REJECT') shiftyHostRejected = true;
});
await sleep(600);
check('已入場的裝置不能改登入主辦端', !shiftyHostWelcome && shiftyHostRejected);
shiftyHost.close();
await sleep(200);

// 反向：大螢幕連線不得再送 CLIENT_JOIN 變成控制器
const shiftyScreen = new WebSocket(URL);
let screenGotWelcome = false;
shiftyScreen.on('open', () => {
  shiftyScreen.send(JSON.stringify({ type: 'SCREEN_HELLO' }));
  shiftyScreen.send(JSON.stringify({
    type: 'CLIENT_JOIN', name: '大螢幕變身', avatar: AVATAR,
  }));
});
shiftyScreen.on('message', (d) => {
  if (JSON.parse(d).type === 'CLIENT_WELCOME') screenGotWelcome = true;
});
await sleep(600);
check('大螢幕連線不能改註冊為控制器', !screenGotWelcome);
shiftyScreen.close();
await sleep(200);

// 生成端點是唯一會花錢的路徑（每次兩支 Gemini 加一次生圖），
// 原本沒有任何速率限制 —— 場館 Wi-Fi 上一台裝置寫個迴圈就能把額度燒光。
function postApi(path, body = Buffer.from('{}')) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(out).toString()).error); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

const postGenerate = () => postApi('/api/generate');

/** 同 postApi，但回傳整包 body 而非只取 error 欄位 */
function postApiBody(path, body = Buffer.from('{}')) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(out).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

// 容量 3：前三次會被放行（生成服務沒開，因此回 vision_service_unavailable），
// 第四次起應被限流擋下。
const genResults = [];
for (let i = 0; i < 4; i++) genResults.push(await postGenerate());
check('生成端點在爆量時會限流',
  genResults.slice(0, 3).every((r) => r !== 'rate_limited')
  && genResults[3] === 'rate_limited',
  genResults.join(', '));

// 站位引導：每秒會被打數次，因此額度必須遠寬於生成 —— 但不能沒有，
// 否則一台裝置的迴圈就能把 Python 端的執行緒池塞滿，排擠正在報到的人。
const previewResults = [];
for (let i = 0; i < 6; i++) previewResults.push(await postApi('/api/preview'));
check('引導端點的額度遠寬於生成端點',
  previewResults.slice(0, 5).every((r) => r !== 'rate_limited'),
  previewResults.join(', '));

// 引導失敗時不該回降級外觀 —— 那是生成才需要的東西。少一幀引導沒有代價，
// 下一幀就補上；把 fallbackColors 塞進來只會讓手機端誤以為該退回捏臉。
// 這裡不假設生成服務開著或關著，兩種情況都必須成立。
const previewBody = await postApiBody('/api/preview');
check('引導失敗時不回降級外觀',
  previewBody !== null && previewBody.ok === false && !('fallbackColors' in previewBody),
  JSON.stringify(previewBody));

// 引導影格是縮圖，不該有生成那種數 MB 的尺寸。
const huge = Buffer.alloc(2 * 1024 * 1024, 0x20);
check('引導端點擋下過大的影格',
  await postApi('/api/preview', huge) === 'frame_too_large');

finish();
