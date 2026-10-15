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
import { DOORWAYS, PROPS } from '../shared/scene.js';
import { THEME_MAP } from '../shared/themes.js';

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
    // VISION_PORT 指向一個沒人聽的 port：e2e 不能打到開發者本機正在跑的生成服務
    // （合照合成會上傳到公開圖床），而且結果不該取決於那個服務有沒有開
    env: { ...process.env, PORT: String(PORT), PERSONAFLOW_STATE_FILE: STATE_FILE, VISION_PORT: '9' },
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
  if (m.type === 'STAGE_THEME') screenThemes.push(m.theme);
  if (m.type === 'SURVEY_QUESTION') screenSurvey = m.survey;
  if (m.type === 'SURVEY_STATE') screenSurveyState = m.state;
  if (m.type === 'SURVEY_CLOSED') screenSurveyClosed = m.result;
});
let screenThemes = [];
let screenSurvey = null;
let screenSurveyState = null;
let screenSurveyClosed = null;
let screenQuiz = null;
let screenReveal = null;
let scoreBoard = null;
const live = () => syncs.at(-1)?.agents ?? [];

await sleep(400);
check('大螢幕收到 STAGE_META', meta?.stage?.width === STAGE.width, `收到 ${meta?.stage?.width}`);
check('大螢幕連線時收到目前的場景主題', screenThemes[0] === 'kitchen', `收到 ${JSON.stringify(screenThemes)}`);

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

// 不雅名稱：入場就擋，不能等它上了大螢幕才靠主辦端踢人
const rude = new WebSocket(URL);
let rudeReject = null;
let rudeWelcome = null;
rude.on('open', () => rude.send(JSON.stringify({ type: 'CLIENT_JOIN', name: '幹 你 娘', avatar: AVATAR })));
rude.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_REJECT') rudeReject = m;
  if (m.type === 'CLIENT_WELCOME') rudeWelcome = m;
});
await sleep(300);
check('不雅名稱被拒絕入場', !!rudeReject && !rudeWelcome, rudeReject?.reason);
rude.close();

// ── 登入 ──────────────────────────────────────────────────
const phone = new WebSocket(URL);
let welcome = null;
phone.on('open', () => phone.send(JSON.stringify({
  type: 'CLIENT_JOIN', name: '冠儀', avatar: AVATAR,
})));
const phoneSyncs = [];
const phoneRosters = [];
const phoneGreets = [];
phone.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') welcome = m;
  if (m.type === 'GREET_RESULT') phoneGreets.push(m);
  if (m.type === 'CLIENT_SYNC') phoneSyncs.push(m);
  if (m.type === 'CLIENT_ROSTER') phoneRosters.push(m);
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
// 場上只有一個人：乾杯要兩人一起按，手機必須被告知「身邊沒有人」，不能按了沒反應
check('獨自按乾杯時手機收到「身邊沒有人」',
  phoneGreets.at(-1)?.kind === 'CHEERS' && phoneGreets.at(-1)?.outcome === 'NOBODY',
  JSON.stringify(phoneGreets.at(-1)));
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
  // 刻意低於大螢幕的 30Hz：手機是每人一條連線，30Hz×10人 會吃掉現場頻寬。
  // 取 15 是因為它整除 30Hz 主迴圈 —— 10Hz 會落在 33.3ms 格線之間而少送一格。
  check('CLIENT_SYNC 約 15 Hz（±2）', hz >= 13 && hz <= 17, `${hz.toFixed(1)} Hz`);

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

// ── 手機端名冊（CLIENT_ROSTER）──────────────────────────────
{
  check('手機收到 CLIENT_ROSTER', phoneRosters.length > 0, `${phoneRosters.length} 則`);
  const agents = phoneRosters.at(-1)?.agents ?? [];
  check('名冊含自己的 id 與名字',
    agents.some((a) => a.id === welcome.userId && a.name === '冠儀'),
    JSON.stringify(agents));
  // 手機的 POV 鄰居只有幾十像素高，不載入貼圖 —— 外觀是白送的頻寬
  check('名冊不含捏臉外觀', agents.every((a) => !('avatar' in a)));

  // 名冊只在成員變動時送。
  // 註：本檔全程接著大螢幕，因此測不到「沒有大螢幕時每幀重送」那個情境
  //（stage.rosterDirty 會被大螢幕那段清掉）。該情境由
  // test/client-roster.test.mjs 直接對節流條件把關。
  const n0 = phoneRosters.length;
  await sleep(1500);
  check('成員沒變動時不重送名冊', phoneRosters.length === n0,
    `靜止 1.5 秒送了 ${phoneRosters.length - n0} 次`);
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

  const roster = phoneRosters.at(-1)?.agents ?? [];
  check('有人加入時名冊會更新',
    roster.some((a) => a.id === mateWelcome?.userId),
    JSON.stringify(roster.map((a) => a.name)));

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
const phone2Rosters = [];
phone2.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'CLIENT_WELCOME') welcome2 = m;
  if (m.type === 'CLIENT_ROSTER') phone2Rosters.push(m);
});
await sleep(400);
check('憑證正確時接回同一角色', welcome2?.userId === uid);
// 主迴圈那份名冊是「內容變了才廣播」，而重連時場上成員多半沒變 ——
// 少了進場當下這一次，該手機的鄰居會永遠沒有名字（重整分頁也一樣）。
//
// 註：此處只確認「有收到」。無法在這裡驗證「若不補送就收不到」——
// 上面的 hijack 角色要等 AGENT_TTL_MS（45 秒）才回收，在那之前名冊
// 一直在變動，主迴圈的廣播會蓋過差異。該條件由
// test/client-roster.test.mjs 以確定性的方式把關。
check('重連時補送 CLIENT_ROSTER', phone2Rosters.length > 0,
  `${phone2Rosters.length} 則`);

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

// ── 場景主題 ──────────────────────────────────────────────
// 主辦端依場合切換大螢幕背景。主題選單只由 STAGE_THEME 驅動，
// 所以認證時就要補送（同尋寶面板的前例），否則重整後不知道目前選的是哪個。
{
  const themeMsgs = [];
  host.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'STAGE_THEME') themeMsgs.push(m.theme); });
  const rehost = new WebSocket(URL);
  const reThemes = [];
  rehost.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'STAGE_THEME') reThemes.push(m.theme); });
  await new Promise((res) => rehost.on('open', res));
  rehost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(300);
  check('主辦端認證時補送目前的場景主題', reThemes[0] === 'kitchen', JSON.stringify(reThemes));
  rehost.close();

  badHost.send(JSON.stringify({ type: 'HOST_SET_THEME', theme: 'office' }));
  await sleep(200);
  check('未認證連線無法切換場景主題', !screenThemes.includes('office'), JSON.stringify(screenThemes));

  const rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_SET_THEME', theme: '../../etc/passwd' }));
  await sleep(200);
  check('不存在的主題被拒絕', hostRejects.length === rejectsBefore + 1 && !screenThemes.includes('../../etc/passwd'));

  const rejectsBeforeRoom = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_SET_THEME', theme: 'room' }));
  await sleep(200);
  check('不開放的 3D 客廳被拒絕', hostRejects.length === rejectsBeforeRoom + 1 && !screenThemes.includes('room'));

  host.send(JSON.stringify({ type: 'HOST_SET_THEME', theme: 'office' }));
  await sleep(300);
  check('切換主題後大螢幕收到 STAGE_THEME', screenThemes.at(-1) === 'office', JSON.stringify(screenThemes));
  check('切換主題後主辦端也收到 STAGE_THEME（多台主辦端的選單要同步）', themeMsgs.at(-1) === 'office');
}

// ── 活動設定 ──────────────────────────────────────────────
// 主辦端進入活動編排前要先選場景、為活動命名；名稱取代大螢幕左上角的場景名。
// 主辦端靠 HOST_AUTH 補送的 STAGE_EVENT 決定先進設定頁還是直接進控制台。
{
  const probe = (type) => {
    const ws = new WebSocket(URL);
    const got = [];
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === type) got.push(m); });
    return { ws, got, open: new Promise((res) => ws.on('open', res)) };
  };

  const fresh = probe('STAGE_EVENT');
  await fresh.open;
  fresh.ws.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(300);
  check('尚未設定活動時，主辦端認證後收到 event: null（要先進設定頁）',
    fresh.got.length === 1 && fresh.got[0].event === null, JSON.stringify(fresh.got));
  fresh.ws.close();

  const screenEvents = [];
  screen.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'STAGE_EVENT') screenEvents.push(m.event); });

  badHost.send(JSON.stringify({ type: 'HOST_SETUP_EVENT', theme: 'office', name: '入侵者之夜' }));
  await sleep(200);
  check('未認證連線無法設定活動', screenEvents.length === 0, JSON.stringify(screenEvents));

  // 名稱不合格時整份設定都不生效 —— 場景也不能先換過去
  let rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_SETUP_EVENT', theme: 'kitchen', name: '   ' }));
  await sleep(200);
  check('活動名稱空白被拒絕，場景也不跟著換',
    hostRejects.length === rejectsBefore + 1 && screenThemes.at(-1) === 'office' && screenEvents.length === 0,
    hostRejects.at(-1)?.reason);

  rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_SETUP_EVENT', theme: 'office', name: '名'.repeat(21) }));
  await sleep(200);
  check('超過長度上限的活動名稱被拒絕（不默默截斷）', hostRejects.length === rejectsBefore + 1 && screenEvents.length === 0);

  rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_SETUP_EVENT', name: '沒選場景' }));
  await sleep(200);
  check('沒選場景被拒絕', hostRejects.length === rejectsBefore + 1 && screenEvents.length === 0);

  host.send(JSON.stringify({ type: 'HOST_SETUP_EVENT', theme: 'office', name: ' 新生\u0007交流夜 ', subtitle: '一起把事情做好' }));
  await sleep(300);
  check('設定活動後大螢幕收到活動名稱（剝除控制字元與頭尾空白）',
    screenEvents.at(-1)?.name === '新生交流夜' && screenEvents.at(-1)?.subtitle === '一起把事情做好',
    JSON.stringify(screenEvents));

  const again = probe('STAGE_EVENT');
  await again.open;
  again.ws.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(300);
  check('設定過後，重新登入的主辦端直接拿到活動名稱（不再被擋在設定頁）',
    again.got[0]?.event?.name === '新生交流夜', JSON.stringify(again.got));
  again.ws.close();
}

// ── 大螢幕控制 ────────────────────────────────────────────
// 原本在投影畫面上的按鈕改由主辦端操作：清除效果（一次性動作）與除錯視圖（狀態，連線時補送）。
// 光線與重置視角已拿掉。
{
  const settings = [];
  const cmds = [];
  screen.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'SCREEN_SETTINGS') settings.push(m.settings);
    if (m.type === 'SCREEN_CMD') cmds.push(m.cmd);
  });

  badHost.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'debug', value: true }));
  badHost.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'clear' }));
  await sleep(200);
  check('未認證連線無法操作大螢幕', settings.length === 0 && cmds.length === 0);

  // 已移除的指令不能還有作用（舊版主辦端頁面可能還會送）
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'light', value: 'night' }));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'reset' }));
  await sleep(150);
  check('已移除的光線與重置視角指令被忽略', settings.length === 0 && cmds.length === 0,
    JSON.stringify({ settings, cmds }));

  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'clear' }));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'debug', value: true }));
  await sleep(300);
  check('清除效果轉發給大螢幕', cmds.includes('clear'), JSON.stringify(cmds));
  check('除錯視圖可由主辦端打開', settings.at(-1)?.debug === true);

  // 投影機中途重開：要接回除錯視圖的狀態與活動名稱
  const reScreen = new WebSocket(URL);
  let reSettings = null;
  let reEvent;
  reScreen.on('open', () => reScreen.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
  reScreen.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'SCREEN_SETTINGS') reSettings = m.settings;
    if (m.type === 'STAGE_EVENT') reEvent = m.event;
  });
  await sleep(300);
  check('大螢幕重新連線時接回除錯視圖狀態與活動名稱',
    reSettings?.debug === true && reEvent?.name === '新生交流夜', JSON.stringify({ reSettings, reEvent }));
  reScreen.close();

  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'debug', value: false }));
  await sleep(100);

  // 音效：預設開；主辦端可以關（講者在台上說話時要能一鍵靜音）
  check('大螢幕音效預設開啟', settings[0]?.sound === true, JSON.stringify(settings[0]));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'sound', value: false }));
  await sleep(200);
  check('主辦端可以關掉大螢幕音效', settings.at(-1)?.sound === false, JSON.stringify(settings.at(-1)));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'sound', value: true }));
  await sleep(100);
}

// ── 進場人格問卷（團隊分類）────────────────────────────────
// 手機在生成角色時先以 HTTP 讀題目（還沒有 WebSocket），作答隨 CLIENT_JOIN 送出，
// 伺服器判定類型並記成 persona 標籤；主持人可以改題目。
async function getJson(pathname) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      const out = []; res.on('data', (c) => out.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(out).toString())); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
const personaQuizMsgs = [];
host.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'HOST_PERSONA_QUIZ') personaQuizMsgs.push(m); });
{
  const first = await getJson('/api/persona-quiz');
  check('手機進場前讀得到進場問卷（預設 4 題）',
    first?.ok === true && first.quiz?.questions?.length === 4 && typeof first.version === 'string' && first.isDefault === true,
    JSON.stringify(first)?.slice(0, 120));

  // 依預設題目選 D, D, D, I → 老虎
  const joinWith = async (name, persona) => {
    const ws = new WebSocket(URL);
    let welcome = null;
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'CLIENT_WELCOME') welcome = m; });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'CLIENT_JOIN', name, avatar: AVATAR, persona }));
    await sleep(300);
    return { ws, id: welcome?.userId };
  };
  const tiger = await joinWith('老虎測試', { version: first.version, answers: [0, 0, 0, 1] });
  const stale = await joinWith('舊題目', { version: 'old-version', answers: [0, 0, 0, 0] });
  const junk = await joinWith('亂答', { version: first.version, answers: [9, 9, 9, 9] });
  await sleep(300);
  const agentOf = (id) => hostStates.at(-1)?.agents?.find((a) => a.id === id);
  check('作答隨進場送出，伺服器判定類型並記成標籤',
    agentOf(tiger.id)?.traits?.persona?.value === 'tiger' && agentOf(tiger.id)?.traits?.persona?.label === '🐯 老虎',
    JSON.stringify(agentOf(tiger.id)?.traits));
  check('答的是舊版題目或答案不合格時不判定（不給亂猜的標籤）',
    !agentOf(stale.id)?.traits?.persona && !agentOf(junk.id)?.traits?.persona);
  const spread = hostStates.at(-1)?.personaSpread;
  check('主辦端拿到五型分佈與未作答人數',
    spread?.counts?.length === 5 && spread.counts.find((c) => c.id === 'tiger')?.count === 1 && spread.unanswered >= 2,
    JSON.stringify(spread));
  for (const p of [tiger, stale, junk]) host.send(JSON.stringify({ type: 'HOST_KICK', agentId: p.id }));
  for (const p of [tiger, stale, junk]) p.ws.close();
  await sleep(200);

  // 主持人改題目
  const custom = { questions: [
    { text: '週末最想做什麼？', options: [{ label: '挑戰新事物', type: 'D' }, { label: '揪朋友聚會', type: 'I' }] },
    { text: '分組報告你會？', options: [{ label: '帶頭分工', type: 'D' }, { label: '整理資料', type: 'C' }] },
    { text: '旅行前你會？', options: [{ label: '排好行程', type: 'C' }, { label: '隨遇而安', type: 'S' }] },
  ] };
  badHost.send(JSON.stringify({ type: 'HOST_SET_PERSONA_QUIZ', quiz: custom }));
  await sleep(200);
  check('未認證連線不能改進場問卷', (await getJson('/api/persona-quiz'))?.quiz?.questions?.length === 4);

  let rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_SET_PERSONA_QUIZ', quiz: { questions: custom.questions.slice(0, 2) } }));
  await sleep(200);
  check('少於 3 題的問卷被拒絕', hostRejects.length === rejectsBefore + 1, hostRejects.at(-1)?.reason);

  host.send(JSON.stringify({ type: 'HOST_SET_PERSONA_QUIZ', quiz: custom }));
  await sleep(300);
  const after = await getJson('/api/persona-quiz');
  check('主持人改題目後，手機讀到的是新題目、版本也變了',
    after?.quiz?.questions?.[0]?.text === '週末最想做什麼？' && after.version !== first.version && after.isDefault === false);
  check('改題目後其他主辦端收到 HOST_PERSONA_QUIZ', personaQuizMsgs.at(-1)?.quiz?.questions?.length === 3);

  const rehost = new WebSocket(URL);
  let reQuiz = null;
  rehost.on('open', () => rehost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY })));
  rehost.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'HOST_PERSONA_QUIZ') reQuiz = m.quiz; });
  await sleep(300);
  check('主辦端重新登入時補送目前的題目', reQuiz?.questions?.length === 3);
  rehost.close();
  // 自訂題目留著，給下面「重開伺服器後題目還在」的檢查
}

// ── 轉場問卷 ──────────────────────────────────────────────
// 沒有正解的題目。答案留成參與者身上的標籤，供後續任務當條件使用。
// 這一段在參與者進場前先驗「未認證不得出題」，其餘在兩人進場後補。
{
  badHost.send(JSON.stringify({ type: 'HOST_START_SURVEY', bankId: 'chrono' }));
  await sleep(200);
  check('未認證連線無法出問卷', screenSurvey === null);

  const rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_START_SURVEY', bankId: '不存在的題目' }));
  await sleep(200);
  check('題庫裡沒有的題目被拒絕', hostRejects.length === rejectsBefore + 1, hostRejects.at(-1)?.reason);
}

// ── 兩位參與者進場 ────────────────────────────────────────
function joinPhone(name) {
  const ws = new WebSocket(URL);
  const box = {
    ws, name, welcome: null, code: null, mission: null, results: [], confirmReq: null,
    quiz: null, acks: [], quizResult: null, scores: [],
    treasureStart: null, heats: [], treasureFound: null, raw: [],
    survey: null, surveyAcks: [], surveyClosed: null, social: null,
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
    if (m.type === 'TREASURE_START') box.treasureStart = m;
    if (m.type === 'TREASURE_HEAT') box.heats.push(m);
    if (m.type === 'TREASURE_FOUND') box.treasureFound = m;
    if (m.type === 'SURVEY_QUESTION') box.survey = m.survey;
    if (m.type === 'SURVEY_ACK') box.surveyAcks.push(m);
    if (m.type === 'SURVEY_CLOSED') box.surveyClosed = m.result;
    if (m.type === 'SOCIAL_SELF') box.social = m;
    // 保留原始字串，供「座標絕不外洩到手機」的檢查
    if (m.type?.startsWith('TREASURE')) box.raw.push(d.toString());
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
// 以「出題前的拒絕數」為基準，不寫死 1 —— 前面的測試（如場景主題）也會合法地收到拒絕
const rejectsBeforeQuiz = hostRejects.length;
host.send(JSON.stringify({
  type: 'HOST_START_QUIZ', question: '插隊的題目', options: ['一', '二'],
  correctIndex: 0, durationMs: 10000,
}));
await sleep(300);
check('同時只允許一題', hostRejects.length === rejectsBeforeQuiz + 1, hostRejects.at(-1)?.reason);

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

// 討論時間（team talk）：題目先亮、還不能作答；時間到由主迴圈切到作答並重送題目
{
  host.send(JSON.stringify({
    type: 'HOST_START_QUIZ', question: '討論題', options: ['甲', '乙'],
    correctIndex: 1, durationMs: 5000, talkMs: 1500,
  }));
  await sleep(300);
  check('有討論時間的題目先進入討論', amy.quiz?.phase === 'DISCUSS' && amy.quiz?.talkMs === 1500,
    `phase=${amy.quiz?.phase}`);
  amy.ws.send(JSON.stringify({ type: 'QUIZ_ANSWER', choice: 1 }));
  await sleep(200);
  check('討論中作答被拒', amy.acks.at(-1)?.ok === false && amy.acks.at(-1)?.reason === 'NOT_YET',
    JSON.stringify(amy.acks.at(-1)));
  await sleep(1500);
  check('討論時間到自動切到作答', amy.quiz?.phase === 'ASKING', `phase=${amy.quiz?.phase}`);
  amy.ws.send(JSON.stringify({ type: 'QUIZ_ANSWER', choice: 1 }));
  await sleep(200);
  check('切到作答後可以作答', amy.acks.at(-1)?.ok === true, JSON.stringify(amy.acks.at(-1)));
  host.send(JSON.stringify({ type: 'HOST_END_QUIZ' }));
  await sleep(300);
}

// 問卷的完整流程：出題 → 手機作答 → 改答案 → 收題 → 標籤留在身上
{
  host.send(JSON.stringify({ type: 'HOST_START_SURVEY', bankId: 'kitchen_role', durationMs: 8000 }));
  await sleep(350);
  check('手機收到問卷題目', amy.survey?.key === 'kitchen_role', amy.survey?.question);
  check('大螢幕收到問卷題目', screenSurvey?.id === amy.survey?.id);
  check('問卷選項帶地點，供之後的集合任務使用',
    screenSurvey?.options?.[0]?.spot === 'tbl_3', JSON.stringify(screenSurvey?.options?.[0]));

  amy.ws.send(JSON.stringify({ type: 'SURVEY_ANSWER', choice: 0 }));
  ben.ws.send(JSON.stringify({ type: 'SURVEY_ANSWER', choice: 2 }));
  await sleep(400);
  check('作答後手機收到自己的標籤文字', amy.surveyAcks.at(-1)?.label === '負責煮', JSON.stringify(amy.surveyAcks.at(-1)));
  check('大螢幕收到即時分佈', screenSurveyState?.totalAnswers === 2, JSON.stringify(screenSurveyState?.counts));

  // 問卷沒有速度分，改答案不影響任何人 —— 按錯卻不能改，標籤就會一直是錯的
  amy.ws.send(JSON.stringify({ type: 'SURVEY_ANSWER', choice: 1 }));
  await sleep(400);
  check('問卷可以改答案', amy.surveyAcks.at(-1)?.label === '負責洗');
  check('改答案不會多算一票', screenSurveyState?.totalAnswers === 2, JSON.stringify(screenSurveyState?.counts));

  // 主辦端重整：問卷面板只由 SURVEY_* 事件驅動，認證時要補送題目與分佈
  const rehost = new WebSocket(URL);
  const reMsgs = [];
  await new Promise((res) => rehost.on('open', res));
  rehost.on('message', (d) => reMsgs.push(JSON.parse(d)));
  rehost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(400);
  check('主辦端重連後補送進行中的問卷',
    reMsgs.some((m) => m.type === 'SURVEY_QUESTION') && reMsgs.some((m) => m.type === 'SURVEY_STATE'));
  rehost.close();

  host.send(JSON.stringify({ type: 'HOST_CLOSE_SURVEY' }));
  await sleep(350);
  check('收題後全場收到最終分佈', amy.surveyClosed?.totalAnswers === 2 && screenSurveyClosed !== null);

  // 標籤留在身上，才可能有「答某個選項的人到某張桌子集合」這種任務
  const tagged = hostStates.at(-1)?.agents?.find((a) => a.name === '小美');
  check('收題後標籤留在參與者身上', tagged?.traits?.kitchen_role?.value === 'wash',
    JSON.stringify(tagged?.traits));
}

// ── 尋寶（先知模式）────────────────────────────────────────
//
// 這個玩法完全建立在資訊不對稱上，而「座標有沒有外洩到手機」
// 是單元測試看不到的 —— 它取決於伺服器實際送出的封包內容。
{
  // 先收掉進行中的任務，避免與尋寶的公告互相干擾
  host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION' }));
  await sleep(300);

  // 場上只留小美與阿賓。
  //
  // 前面的安全性測試（偽造憑證、角色轉換）留下了幾個角色，而**關掉 socket
  // 不等於角色離場** —— 那是刻意的設計（賓客關分頁角色仍留 AGENT_TTL_MS＝45 秒，
  // 見 CLAUDE.md），遠長於整套 e2e。
  //
  // 而 `treasure.check()` 掃的是場上**所有**非先知角色，不管有沒有連線。
  // 於是藏寶點若隨機落在那個殘留角色附近，它會在阿賓走到之前就「找到」寶藏，
  // 一次讓四條測試同時失敗（找到者不是阿賓、阿賓沒拿到分數、
  // 冷熱因本輪已結束而一則都沒送出）。實測抓到的兇手正是叫「攻擊者」的那一個。
  //
  // 這是測試的前置條件沒清乾淨，不是伺服器的錯 —— 因此在這裡明確清場，
  // 而不是把 TTL 調短或讓尋寶忽略離線角色（後者會改掉現場真正想要的行為）。
  const keep = new Set([amy.welcome.userId, ben.welcome.userId]);
  for (const a of hostStates.at(-1)?.agents ?? []) {
    if (!keep.has(a.id)) host.send(JSON.stringify({ type: 'HOST_KICK', agentId: a.id }));
  }
  await sleep(300);
  check('尋寶開始前場上只剩兩位參與者',
    (hostStates.at(-1)?.agents ?? []).length === 2,
    (hostStates.at(-1)?.agents ?? []).map((a) => a.name).join(', '));

  const treasureHostMsgs = [];
  const onHost = (d) => {
    const m = JSON.parse(d);
    if (m.type?.startsWith('TREASURE')) treasureHostMsgs.push(m);
  };
  host.on('message', onHost);

  // 指定小美當先知
  host.send(JSON.stringify({
    type: 'HOST_START_TREASURE', prophetId: amy.welcome.userId,
  }));
  await sleep(500);

  check('尋寶開始後兩支手機都收到通知',
    !!amy.treasureStart && !!ben.treasureStart);
  check('手機知道誰是先知',
    amy.treasureStart?.round?.prophetId === amy.welcome.userId);

  // 最關鍵的一條：座標絕不能出現在手機收到的任何一則訊息裡。
  // 手機端只要拿得到座標，開發者工具就能直接看到答案。
  const spot = treasureHostMsgs.find((m) => m.type === 'TREASURE_START')?.spot;
  check('主辦端拿得到藏寶座標', Number.isFinite(spot?.x) && Number.isFinite(spot?.y));
  // TREASURE_FOUND 例外：本輪已經結束，那時公布座標是刻意的
  // （見 CLAUDE.md「中止尋寶不公布座標，找到才公布」）。少了這個排除，
  // 這條檢查會在阿賓踩中得夠快時誤判「正確行為」為外洩。
  const phoneSawCoords = [...amy.raw, ...ben.raw].some((raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'TREASURE_FOUND') return false;
    return m.round?.x !== undefined || m.spot !== undefined;
  });
  check('藏寶座標不會外洩給手機', !phoneSawCoords);

  // 主辦端中途重整／斷線重連，必須補送進行中的那一輪。
  // HOST_STATE 不含尋寶，而主辦端的尋寶面板只由 TREASURE_* 事件驅動：
  // 少了補送，重整後的畫面會停在「開始尋寶」，#treasure-live 仍是 hidden，
  // 「中止本輪」按鈕根本不在畫面上 —— 本輪就再也停不掉了，
  // 而現場只會看到「這個按鈕壞了」。
  {
    const rehost = new WebSocket(URL);
    const reMsgs = [];
    await new Promise((res) => rehost.on('open', res));
    rehost.on('message', (d) => reMsgs.push(JSON.parse(d)));
    rehost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
    await sleep(400);
    const caught = reMsgs.find((m) => m.type === 'TREASURE_START');
    check('主辦端重連後補送進行中的尋寶', !!caught,
      caught ? `先知 ${caught.round?.prophetId}` : '沒收到 TREASURE_START');
    check('補送給主辦端的尋寶帶座標（主辦端是公開畫面）',
      Number.isFinite(caught?.spot?.x) && Number.isFinite(caught?.spot?.y));
    rehost.close();
    await sleep(150);
  }

  // 把阿賓推到寶藏上：先知（小美）應收到冷熱，阿賓不該收到
  // ⚠ payload 形狀必須是 {vector:{x,y}}：伺服器讀的是
  //   `msg.vector ?? {x: msg.vx, y: msg.vy}`，寫成裸的 {x,y} 會兩邊都拿到
  //   undefined，角色完全不動 —— 而這條測試仍然會過（它斷言的是先知收到
  //   冷熱，那與角色有沒有移動無關），所以錯了也看不出來。
  const nudge = (box, x, y) => box.ws.send(JSON.stringify({
    type: 'INPUT_MOVE', vector: { x, y }, intensity: 1,
  }));
  // 一路把阿賓推向寶藏，直到踩中為止。
  //
  // 圈數必須由「實際還要走多遠」算出，不能寫死。原本寫死 120 圈 × 40ms＝4.8 秒，
  // 而 MAX_SPEED 是 190 px/s，等於最遠只走得了約 912px —— 但藏寶點是在
  // 1920×1080（對角線約 2200px）裡隨機挑的，且要繞開道具。
  // 於是這條測試實際上是在擲骰子：藏寶點剛好落在附近才過得了，
  // 落在對角就必然「未踩中」，一次帶垮四條斷言。
  //
  // 這裡改成依起始距離估算所需時間再乘 3 倍餘裕（繞道具、α 爬升、
  // 對齊誤差都會讓實際路徑長於直線），並保留上限避免真的壞掉時無限空轉。
  //
  // **隔著牆要先走到門口。** 場景左右各有一道牆，只有門走得過去；藏寶點可能
  // 落在室外。直直往寶藏推的話會頂在牆上：以伺服器的物理模擬 500 輪，
  // 同一側 430/430 踩中，隔牆 70 輪只踩中 7 輪 —— 這正是 e2e 約兩成機率
  // 「未踩中」、一次帶垮四條斷言的原因。先走到門外 60px 再轉向寶藏後 500/500。
  const doorFor = (me) => DOORWAYS.find((dw) => {
    const wx = dw.x + dw.w / 2;
    return (me.x - wx) * (spot.x - wx) < 0;   // 這道牆正好隔在我與寶藏之間
  });
  {
    const start = live().find((a) => a.id === ben.welcome.userId);
    const startDist = Math.hypot(spot.x - start.x, spot.y - start.y);
    const needMs = (startDist / MAX_SPEED) * 1000 * 3 + 2000;
    const maxTicks = Math.min(600, Math.ceil(needMs / 40));

    let ticks = 0;
    for (; ticks < maxTicks && !ben.treasureFound; ticks++) {
      const me = live().find((a) => a.id === ben.welcome.userId);
      if (!me) break;
      let tx = spot.x;
      let ty = spot.y;
      const door = doorFor(me);
      if (door) {
        tx = door.x + door.w / 2 + Math.sign(spot.x - me.x) * 60;
        ty = door.y + door.h / 2;
      }
      const dx = tx - me.x;
      const dy = ty - me.y;
      const d = Math.hypot(dx, dy) || 1;
      nudge(ben, dx / d, dy / d);
      await sleep(40);
    }
    // 沒踩到時要說得出「差多遠」，否則下面四條失敗看起來像功能壞掉，
    // 實際上只是走的時間不夠。
    if (!ben.treasureFound) {
      const me = live().find((a) => a.id === ben.welcome.userId);
      console.log(`   [尋寶] 走了 ${ticks}/${maxTicks} 圈仍未踩中；`
        + `起始距離 ${startDist.toFixed(0)}px，`
        + `目前距離 ${me ? Math.hypot(spot.x - me.x, spot.y - me.y).toFixed(0) : '?'}px`);
    }
  }

  check('只有先知收得到冷熱提示',
    amy.heats.length > 0 && ben.heats.length === 0,
    `先知 ${amy.heats.length} 則 / 非先知 ${ben.heats.length} 則`);

  // 走完整條「踩中 → 廣播 → 記分」。單元測試只驗規則，這裡驗真的接起來了。
  check('非先知踩到寶藏即完成本輪', !!ben.treasureFound,
    ben.treasureFound ? `由 ${ben.treasureFound.byName} 找到` : '未踩中');
  check('找到者就是走過去的那個人，不是先知',
    ben.treasureFound?.by === ben.welcome.userId
    && ben.treasureFound?.prophetId === amy.welcome.userId);
  check('找到之後才公布座標',
    Number.isFinite(ben.treasureFound?.spot?.x),
    JSON.stringify(ben.treasureFound?.spot));
  check('找到者拿到分數',
    ben.scores.some((s) => s.source === 'TREASURE'),
    ben.scores.map((s) => s.source).join(', '));
  check('先知拿 0 分（不能得分是這個玩法的前提）',
    !amy.scores.some((s) => s.source === 'TREASURE'));

  host.send(JSON.stringify({ type: 'HOST_STOP_TREASURE' }));
  await sleep(300);
  host.off('message', onHost);
}

// ── COLOR_HUNT 任務 ───────────────────────────────────────
{
  hostRejects = [];
  host.send(JSON.stringify({
    type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1,
  }));
  await sleep(300);
  check('COLOR_HUNT 缺少顏色時被拒絕', hostRejects.length > 0);

  host.send(JSON.stringify({
    type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1,
    colorFamily: 'RED',
  }));
  await sleep(400);
  check('手機收到帶顏色的任務公告',
    amy.mission?.mission?.colorFamily === 'RED',
    amy.mission?.mission?.colorFamily);

  host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION' }));
  await sleep(200);
}

// ── 私訊 ──────────────────────────────────────────────────
// 點手機畫面上的角色傳文字。只送給收件人；封鎖靜默丟棄；檢舉的那一則才進主辦端。
const dmReports = [];
let hostSawPrivateMessage = false;
host.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'HOST_MSG_REPORTS') dmReports.push(m.reports);
  if (m.type === 'MSG_RECEIVE') hostSawPrivateMessage = true;
});
{
  const inboxA = []; const inboxB = []; const resA = []; const resB = []; const benBlocks = [];
  ben.ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'MSG_BLOCKS') benBlocks.push(m.userIds); });
  for (const [phone, inbox, res] of [[amy, inboxA, resA], [ben, inboxB, resB]]) {
    phone.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'MSG_RECEIVE') inbox.push(m.message);
      if (m.type === 'MSG_RESULT') res.push(m);
    });
  }
  const aId = amy.welcome.userId;
  const bId = ben.welcome.userId;
  const dm = (phone, to, text) => phone.ws.send(JSON.stringify({ type: 'MSG_SEND', to, text }));

  dm(amy, bId, ' 我在\n籃球架旁邊 ');
  await sleep(300);
  check('私訊送到收件人（剝除換行與頭尾空白）',
    inboxB[0]?.text === '我在籃球架旁邊' && inboxB[0]?.fromName === '小美' && inboxB[0]?.from === aId,
    JSON.stringify(inboxB));
  check('寄件人收到送出成功', resA[0]?.ok === true && resA[0]?.to === bId, JSON.stringify(resA));
  check('私訊不會送到寄件人自己或主辦端', inboxA.length === 0 && !hostSawPrivateMessage && dmReports.length <= 1);

  dm(amy, aId, '自言自語');
  dm(amy, bId, '長'.repeat(61));
  dm(amy, 'usr_ghost', '在嗎');
  await sleep(300);
  check('傳給自己、超過 60 字、對象不存在都被拒絕',
    resA.slice(1).map((r) => r.reason).join() === 'SELF,TOO_LONG,NOT_FOUND', JSON.stringify(resA.slice(1)));

  await sleep(2100);
  dm(amy, bId, '第二則');
  dm(amy, bId, '第三則（太快）');
  await sleep(300);
  check('連續送出會被頻率限制擋下', resA.at(-2)?.ok === true && resA.at(-1)?.reason === 'RATE_LIMITED',
    JSON.stringify(resA.slice(-2)));

  screen.send(JSON.stringify({ type: 'MSG_SEND', to: bId, text: '我是大螢幕' }));
  await sleep(200);
  check('大螢幕連線不能傳私訊', !inboxB.some((m) => m.text === '我是大螢幕'));

  // 檢舉：只有收件人能檢舉，主辦端拿到原文與名字
  amy.ws.send(JSON.stringify({ type: 'MSG_REPORT', messageId: inboxB[0].id }));
  await sleep(200);
  check('寄件人不能檢舉自己送出的訊息', !dmReports.some((list) => list.length > 0));
  ben.ws.send(JSON.stringify({ type: 'MSG_REPORT', messageId: inboxB[0].id }));
  await sleep(300);
  const reported = dmReports.at(-1)?.[0];
  check('收件人檢舉後，主辦端收到那一則的原文與雙方名字',
    reported?.text === '我在籃球架旁邊' && reported?.fromName === '小美' && reported?.toName === '阿賓' && reported?.fromPresent === true,
    JSON.stringify(reported));

  // 主辦端重整：檢舉清單只由事件驅動，認證時要補送（SERVER-AND-TESTS「主辦端的面板狀態只由事件驅動」）
  const rehost = new WebSocket(URL);
  let reReports = null;
  rehost.on('open', () => rehost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY })));
  rehost.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'HOST_MSG_REPORTS') reReports = m.reports; });
  await sleep(300);
  check('主辦端重新登入時補送檢舉清單', reReports?.length === 1, JSON.stringify(reReports));
  rehost.close();

  host.send(JSON.stringify({ type: 'HOST_DISMISS_REPORT', messageId: inboxB[0].id }));
  await sleep(200);
  check('主辦端按「已處理」後檢舉從清單移除', dmReports.at(-1)?.length === 0);

  // 「今天遇見的人」：兩人前面配對過；阿賓還沒回過私訊，只有小美傳不算聊過
  const viaOf = (phone, id) => phone.social?.peers?.find((p) => p.id === id)?.via ?? null;
  check('配對過的人在「今天遇見的人」名單上', viaOf(amy, bId)?.join() === 'pair', JSON.stringify(amy.social));

  // 封鎖：之後的訊息靜默丟棄，寄件人看到的仍是成功；封鎖是單向的
  ben.ws.send(JSON.stringify({ type: 'MSG_BLOCK', userId: aId }));
  await sleep(2100);
  check('封鎖後雙方的「今天遇見的人」都拿掉對方（紀念卡會被分享出去）',
    viaOf(amy, bId) === null && viaOf(ben, aId) === null, JSON.stringify([amy.social, ben.social]));
  const before = inboxB.length;
  dm(amy, bId, '被封鎖後還在傳');
  await sleep(300);
  check('被封鎖後訊息不再送達，但寄件人看到的仍是送出成功',
    inboxB.length === before && resA.at(-1)?.ok === true, JSON.stringify({ got: inboxB.length - before, last: resA.at(-1) }));
  check('封鎖後伺服器把封鎖名單同步給封鎖者的手機', benBlocks.at(-1)?.join() === aId, JSON.stringify(benBlocks));
  dm(ben, aId, '封鎖中還想傳');
  await sleep(300);
  check('封鎖的人自己也不能傳給對方（要先解除封鎖）', resB.at(-1)?.reason === 'BLOCKED' && !inboxA.some((m) => m.text === '封鎖中還想傳'),
    JSON.stringify(resB.at(-1)));

  ben.ws.send(JSON.stringify({ type: 'MSG_UNBLOCK', userId: aId }));
  await sleep(300);
  check('解除封鎖後名單同步清空', benBlocks.at(-1)?.length === 0, JSON.stringify(benBlocks.at(-1)));
  dm(ben, aId, '我還是可以傳給你');
  await sleep(300);
  check('解除封鎖後可以再傳給對方', inboxA.at(-1)?.text === '我還是可以傳給你');
  check('解除封鎖後名單回來；對方回過私訊才記成「傳過訊息」',
    viaOf(amy, bId)?.join() === 'pair,message' && viaOf(ben, aId)?.join() === 'pair,message',
    JSON.stringify([viaOf(amy, bId), viaOf(ben, aId)]));

  // 留一則檢舉給下面的踢人測試：被踢之後 fromPresent 要變成 false
  dm(amy, bId, '');   // 空訊息不送出、不吃額度
  inboxA.length && amy.ws.send(JSON.stringify({ type: 'MSG_REPORT', messageId: inboxA.at(-1).id }));
  await sleep(300);
}

// ── 主辦端踢人 ────────────────────────────────────────────
const benId = ben.welcome.userId;
host.send(JSON.stringify({ type: 'HOST_KICK', agentId: benId }));
await sleep(500);
check('主辦端可移除參與者', !live().some((a) => a.id === benId), `場上 ${live().length} 人`);
check('被檢舉的人被移除後，檢舉清單標示寄件人已不在場',
  dmReports.at(-1)?.[0]?.fromName === '阿賓' && dmReports.at(-1)?.[0]?.fromPresent === false,
  JSON.stringify(dmReports.at(-1)));

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

// ── 大合照 ──────────────────────────────────────────────
// 曾因 index.js 引用已搬到 httplayer.js 的 VISION_HOST，一按「拍大合照」
// 就 ReferenceError，整個互動層行程結束、全場斷線。生成服務沒開（這裡就是）
// 時，合照應該回報 ERROR，伺服器照常運作。
{
  const photoStates = [];
  host.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'HOST_PHOTO_STATE') photoStates.push(m); });
  // 大螢幕立刻交出（空的）底圖，省掉 8 秒的截圖逾時
  screen.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'SCREEN_CAPTURE_REQ') {
      sendPost('/api/screen-capture', Buffer.from(JSON.stringify({ requestId: m.requestId, image: null })));
    }
  });
  host.send(JSON.stringify({ type: 'HOST_TAKE_PHOTO' }));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !photoStates.some((x) => x.phase === 'DONE' || x.phase === 'ERROR')) {
    await sleep(200);
  }
  const final = photoStates.find((x) => x.phase === 'DONE' || x.phase === 'ERROR');
  check('拍大合照時生成服務沒開，主辦端收到失敗而不是伺服器當掉',
    final?.phase === 'ERROR', JSON.stringify(photoStates.map((x) => x.phase)));
  check('拍完大合照伺服器仍存活', (await httpStatus('/screen/')) === 200);
}

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

// 活動中途重開，投影畫面不能自己跳回預設主題
{
  const reScreen = new WebSocket(URL);
  let reTheme = null;
  reScreen.on('open', () => reScreen.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
  reScreen.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'STAGE_THEME') reTheme = m.theme; });
  await sleep(400);
  check('重開後場景主題維持主辦端上次的選擇', reTheme === 'office', `收到 ${reTheme}`);
  reScreen.close();
}

// 活動中途重開，主持人改過的進場問卷不能悄悄換回預設
{
  const q = await getJson('/api/persona-quiz');
  check('重開後主持人改過的進場問卷還在', q?.quiz?.questions?.[0]?.text === '週末最想做什麼？' && q.isDefault === false);
}

// 活動中途重開，主辦端不能被趕回設定頁、投影的標題與光線也不能跳掉
{
  const reHost = new WebSocket(URL);
  let reEvent;
  let reSettings = null;
  reHost.on('open', () => reHost.send(JSON.stringify({ type: 'HOST_AUTH', key: keyAfterRestart })));
  reHost.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'STAGE_EVENT') reEvent = m.event;
    if (m.type === 'SCREEN_SETTINGS') reSettings = m.settings;
  });
  await sleep(400);
  check('重開後活動名稱還在，主辦端直接進控制台', reEvent?.name === '新生交流夜', JSON.stringify(reEvent));
  check('重開後除錯視圖自動關閉', reSettings?.debug === false, JSON.stringify(reSettings));
  reHost.close();
}

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

// 匯出角色：角色檔內嵌整組貼圖（參與者照片的轉譯結果），與生成紀錄同樣要主辦端密鑰
{
  const id = '0123456789abcdef0123456789abcdef';
  check('沒有密鑰不能匯出角色圖檔',
    (await httpStatus(`/api/host/history/${id}/image`)) === 403);
  check('密鑰錯誤不能匯出角色檔',
    (await httpStatus(`/api/host/history/${id}/bundle?key=WRONG1`)) === 403);
  check('匯出路徑不接受資產編號以外的字元',
    (await httpStatus(`/api/host/history/..%2f..%2f.env/bundle?key=${HOST_KEY}`)) === 400);
}

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
/**
 * 對 Gateway 發一個 POST，回傳回應 body 裡的 error 欄位。
 *
 * ⚠ 送出過大的 body 時會與伺服器的 `req.destroy()` 賽跑，見下方 sendPost 的說明。
 */
function postApi(path, body = Buffer.from('{}')) {
  return sendPost(path, body).then((json) => (json === null ? null : json.error));
}

/**
 * POST 的共用實作。回傳解析後的 JSON，解析不出來回 null。
 *
 * **為什麼要自己接 socket 的 error**：伺服器對超過上限的 body 會在讀到一半時
 * 直接 `req.destroy()` 把連線切掉（這是對的，不能為了讓客戶端寫完而先收下
 * 一個 2MB 的 body）。但此時客戶端往往還沒把 body 寫完，於是那個 write 會
 * 收到 EPIPE —— 而且它是在 **socket** 上觸發，不是在 request 物件上，
 * `req.on('error')` 接不到。未處理的 'error' 事件會讓整個 e2e 行程直接崩潰。
 *
 * 這是這支測試長期間歇性失敗的真正原因：伺服器的行為一直是對的
 * （單獨用 curl 連打 20 次，20 次都正確回 frame_too_large），
 * 壞的是測試客戶端 —— 它在賽跑輸掉時不是回報失敗，而是整個行程被 EPIPE 帶走。
 *
 * 因此：socket 的錯誤一律吞掉，並且**以伺服器真的回了什麼為準** ——
 * 回應先到就用回應，連線先斷才回 null。
 */
function sendPost(path, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      const out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => {
        try { done(JSON.parse(Buffer.concat(out).toString())); }
        catch { done(null); }
      });
    });

    // 伺服器切線導致的寫入失敗不是測試失敗，交由上面的回應處理決定結果。
    req.on('socket', (s) => s.on('error', () => {}));
    req.on('error', () => done(null));
    req.end(body);
  });
}

const postGenerate = () => postApi('/api/generate');

/** 同 postApi，但回傳整包 body 而非只取 error 欄位 */
function postApiBody(path, body = Buffer.from('{}')) {
  return sendPost(path, body);
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

// ── 話題桌 ────────────────────────────────────────────────
// 兩人走到同一張號碼牌桌旁、停留一下，兩支手機拿到同一題，大螢幕也收到。
// 前面的段落已經把 screen 關掉了，這裡自己開一條大螢幕連線看座標與題目。
{
  const tScreen = new WebSocket(URL);
  let tTheme = null;
  let tAgents = [];
  const screenTopics = [];
  tScreen.on('open', () => tScreen.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
  tScreen.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'STAGE_THEME') tTheme = m.theme;
    if (m.type === 'STAGE_SYNC') tAgents = m.agents;
    if (m.type === 'STAGE_TOPIC') screenTopics.push(m);
  });
  const seat = (name) => {
    const box = joinPhone(name);
    box.topics = [];
    box.ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'TOPIC_CARD') box.topics.push(m); });
    return box;
  };
  const t1 = seat('話題甲');
  const t2 = seat('話題乙');
  await sleep(600);
  const spotId = Object.keys(THEME_MAP[tTheme]?.spots ?? {})[0];
  const table = PROPS.find((p) => p.id === spotId);
  // 走到桌子下緣外側（兩人左右錯開），到了就放開搖桿
  const goal = (dx) => ({ x: table.x + dx, y: table.y + table.r + 45 });
  const near = (me, g) => Math.hypot(me.x - g.x, me.y - g.y) < 30;
  for (let i = 0; i < 400; i++) {
    let moving = false;
    for (const [box, g] of [[t1, goal(-40)], [t2, goal(40)]]) {
      const me = tAgents.find((a) => a.id === box.welcome?.userId);
      if (!me) { moving = true; continue; }
      if (near(me, g)) { box.ws.send(JSON.stringify({ type: 'INPUT_MOVE', vector: { x: 0, y: 0 }, intensity: 0 })); continue; }
      moving = true;
      const dx = g.x - me.x;
      const dy = g.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      box.ws.send(JSON.stringify({ type: 'INPUT_MOVE', vector: { x: dx / d, y: dy / d }, intensity: 1 }));
    }
    if (!moving) break;
    await sleep(40);
  }
  await sleep(3000);
  if (!t1.topics.length) {
    const pos = [t1, t2].map((b) => tAgents.find((a) => a.id === b.welcome?.userId))
      .map((a) => (a ? Math.round(Math.hypot(a.x - table.x, a.y - table.y)) : '?'));
    console.log(`   [話題] 沒拿到題目；主題 ${tTheme} 桌 ${spotId}，離桌中心 ${pos.join(', ')}（桌半徑 ${table.r}＋90）`);
  }
  check('同桌兩人拿到同一題聊天題',
    t1.topics.length > 0 && t2.topics.length > 0 && t1.topics.at(-1).question === t2.topics.at(-1).question,
    JSON.stringify({ spotId, t1: t1.topics.at(-1)?.question, t2: t2.topics.at(-1)?.question }));
  check('題目卡寫著和誰同桌', t1.topics.at(-1)?.withNames?.includes('話題乙'), JSON.stringify(t1.topics.at(-1)?.withNames));
  // 桌子可能相鄰（office 的 1、2 號工作桌）：兩人同時在兩張桌的範圍內時，題目發在哪一張都對，
  // 而同一組人只會拿到一題。所以比對的是「大螢幕顯示的就是手機上那一題」
  check('大螢幕在桌旁顯示同一題', screenTopics.some((m) => m.question === t1.topics.at(-1)?.question),
    JSON.stringify(screenTopics));
  t1.ws.close();
  t2.ws.close();
  tScreen.close();
  await sleep(200);
}

// ── 人物賓果 ──────────────────────────────────────────────
{
  const capture = (box) => {
    box.bingo = { card: null, results: [], tagged: [], ended: null };
    box.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'BINGO_CARD') box.bingo.card = m.card;
      if (m.type === 'BINGO_RESULT') box.bingo.results.push(m);
      if (m.type === 'BINGO_TAGGED') box.bingo.tagged.push(m);
      if (m.type === 'BINGO_ENDED') box.bingo.ended = m;
    });
    return box;
  };
  const pA = capture(joinPhone('賓果甲'));
  const pB = capture(joinPhone('賓果乙'));
  await sleep(500);
  // 前面的段落已經把 host 關掉了，這裡自己開一條
  const bHost = new WebSocket(URL);
  await new Promise((res) => bHost.on('open', res));
  bHost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(300);
  bHost.send(JSON.stringify({ type: 'HOST_START_BINGO' }));
  await sleep(400);
  check('開局時每人拿到一張 9 格的卡', pA.bingo.card?.cells?.length === 9 && pB.bingo.card?.cells?.length === 9);

  // 測試角色的衣服是 #E76F51（紅色族），兩人之間也沒有連線：這兩種格子乙一定符合
  const fits = (c) => !c.filled && (c.label === '衣服有紅色的人' || c.label === '找一個你還不認識的人');
  const first = pA.bingo.card.cells.findIndex(fits);
  pA.ws.send(JSON.stringify({ type: 'BINGO_CLAIM', cell: first, code: pB.code }));
  await sleep(300);
  check('輸入對方的碼、對方符合就填上', pA.bingo.results.at(-1)?.ok === true && pA.bingo.card.cells[first].name === '賓果乙',
    JSON.stringify(pA.bingo.results.at(-1)));
  check('被填進去的人收到通知', pB.bingo.tagged.at(-1)?.byName === '賓果甲');

  // 立刻再送：冷卻擋下（防枚舉配對碼）
  const second = pA.bingo.card.cells.findIndex((c, i) => i !== first && !c.filled);
  pA.ws.send(JSON.stringify({ type: 'BINGO_CLAIM', cell: second, code: pB.code }));
  await sleep(200);
  check('連續填格受配對冷卻限制', pA.bingo.results.at(-1)?.reason === 'COOLDOWN', JSON.stringify(pA.bingo.results.at(-1)));

  // 冷卻過後，同一個人不能再填第二格
  await sleep(3100);
  pA.ws.send(JSON.stringify({ type: 'BINGO_CLAIM', cell: second, code: pB.code }));
  await sleep(300);
  check('同一個人在一張卡上只能填一格', pA.bingo.results.at(-1)?.reason === 'USED', JSON.stringify(pA.bingo.results.at(-1)));

  bHost.send(JSON.stringify({ type: 'HOST_END_BINGO' }));
  await sleep(300);
  bHost.close();
  check('結束時全場收到結果', pA.bingo.ended !== null && Array.isArray(pB.bingo.ended?.winners), JSON.stringify(pA.bingo.ended));

  // 一格都沒人填就結束：不能把全場 0 格同分的人都唸成贏家
  const h2 = new WebSocket(URL);
  await new Promise((res) => h2.on('open', res));
  h2.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(300);
  h2.send(JSON.stringify({ type: 'HOST_START_BINGO' }));
  await sleep(300);
  h2.send(JSON.stringify({ type: 'HOST_END_BINGO' }));
  await sleep(300);
  check('沒人填任何一格就沒有贏家', pA.bingo.ended?.winners?.length === 0, JSON.stringify(pA.bingo.ended));
  h2.close();
  pA.ws.close();
  pB.ws.close();
  await sleep(200);
}

// ── 候補名單（人滿時）──────────────────────────────────────
// 放在最後：會把場上補滿到上限，不能影響前面的任何一段。
{
  const crowd = [];
  const join = (name) => {
    const w = new WebSocket(URL);
    const box = { w, log: [], welcomed: false };
    w.on('open', () => w.send(JSON.stringify({ type: 'CLIENT_JOIN', name, avatar: AVATAR })));
    w.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'CLIENT_WELCOME') box.welcomed = true;
      if (m.type === 'AUDIENCE_WAIT') box.log.push(m.ahead);
    });
    return box;
  };
  // 補到有人開始排候補為止（場上原本有幾個人不重要）
  let first = null;
  for (let i = 0; i < 40 && !first; i++) {
    const b = join(`湊數${i}`);
    await sleep(40);
    if (b.log.length) first = b; else crowd.push(b);
  }
  await sleep(200);
  check('人滿時排進候補而不是被拒絕', first !== null && first.log.at(-1) === 0, JSON.stringify(first?.log));
  const second = join('候補乙');
  await sleep(300);
  check('候補名單依先後排序', second.log.at(-1) === 1, JSON.stringify(second.log));

  // 有人離場：排第一的自動進場，手機不必再操作
  crowd.find((b) => b.welcomed).w.send(JSON.stringify({ type: 'CLIENT_LEAVE' }));
  await sleep(400);
  check('有空位時排第一的人自動進場', first.welcomed === true);
  check('後面的人遞補到第一位', second.log.at(-1) === 0, JSON.stringify(second.log));

  // 有人在排隊時，新來的人不能趁空位插隊
  crowd.filter((b) => b.welcomed).at(-1).w.send(JSON.stringify({ type: 'CLIENT_LEAVE' }));
  const late = join('插隊者');
  await sleep(500);
  check('空位給排隊的人，不給剛來的人', second.welcomed === true && late.welcomed === false && late.log.at(-1) === 0,
    JSON.stringify({ second: second.welcomed, late: late.log }));
  for (const b of [...crowd, first, second, late]) b.w.close();
  await sleep(200);
}

finish();
