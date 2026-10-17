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
// 事件紀錄同理：寫到暫存目錄，不能落進專案的 data/events/ 混進真正的場次
const EVENTS_DIR = path.join(os.tmpdir(), `personaflow-e2e-events-${process.pid}`);
const EVENTS_FILE = path.join(EVENTS_DIR, 'e2e.jsonl');
const readEvents = () => {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch { return []; }
};

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
    env: {
      ...process.env, PORT: String(PORT), PERSONAFLOW_STATE_FILE: STATE_FILE, VISION_PORT: '9',
      PERSONAFLOW_SESSION: 'e2e', PERSONAFLOW_EVENTS_DIR: EVENTS_DIR,
    },
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
  try { fs.rmSync(EVENTS_DIR, { recursive: true, force: true }); } catch { /* 略 */ }
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
  if (m.type === 'WORDCLOUD_QUESTION') screenCloudQ = m.cloud;
  if (m.type === 'WORDCLOUD_STATE') screenCloud = m.cloud;
  if (m.type === 'WORDCLOUD_CLOSED') screenCloudClosed = m.result;
});
let screenThemes = [];
let screenCloudQ = null;
let screenCloud = null;
let screenCloudClosed = null;
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
phone.send(JSON.stringify({ type: 'INPUT_ACTION', action: 'WAVE' }));
await sleep(200);
check('社交動作出現在 STAGE_SYNC', live()[0].emote === 'WAVE');
// 場上只有一個人：揮手要有對象，手機必須被告知「身邊沒有人」，不能按了沒反應
check('獨自揮手時手機收到「身邊沒有人」',
  phoneGreets.at(-1)?.kind === 'WAVE' && phoneGreets.at(-1)?.outcome === 'NOBODY',
  JSON.stringify(phoneGreets.at(-1)));
await sleep(650);   // 動作冷卻（EMOTE_COOLDOWN_MS）
phone.send(JSON.stringify({ type: 'INPUT_ACTION', action: 'CHEERS' }));
phone.send(JSON.stringify({ type: 'INPUT_ACTION', action: 'DROP_TABLE' }));
await sleep(200);
check('白名單外的動作被丟棄（含已移除的乾杯）', live()[0].emote === 'WAVE');

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

  // 清除效果已移除（大螢幕上的物件不能點了）：舊版主辦端送來也不轉發
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'clear' }));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'debug', value: true }));
  await sleep(300);
  check('已移除的清除效果指令不再轉發', !cmds.includes('clear'), JSON.stringify(cmds));
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

  // 配分：主持人可以在節目單頁改，改的是之後的規則
  {
    const views = [];
    const onScoring = (d) => { const m = JSON.parse(d); if (m.type === 'HOST_SCORING') views.push(m); };
    host.on('message', onScoring);
    badHost.send(JSON.stringify({ type: 'HOST_SET_SCORING', scoring: { quizCorrect: 1 } }));
    await sleep(150);
    check('未認證連線不能改配分', views.length === 0);
    const rejectsBefore = hostRejects.length;
    host.send(JSON.stringify({ type: 'HOST_SET_SCORING', scoring: { quizCorrect: -5 } }));
    await sleep(150);
    check('配分填錯被拒絕並說明原因', hostRejects.length === rejectsBefore + 1 && /問答答對/.test(hostRejects.at(-1)?.reason ?? ''),
      hostRejects.at(-1)?.reason);
    host.send(JSON.stringify({ type: 'HOST_SET_SCORING', scoring: { pairCompletion: 7 } }));
    await sleep(150);
    check('主持人改的配分廣播回主辦端', views.at(-1)?.scoring?.pairCompletion === 7 && views.at(-1)?.isDefault === false,
      JSON.stringify(views.at(-1)));
    host.send(JSON.stringify({ type: 'HOST_SET_SCORING', scoring: null }));
    await sleep(150);
    check('配分可以恢復預設', views.at(-1)?.isDefault === true && views.at(-1)?.scoring?.pairCompletion === 20,
      JSON.stringify(views.at(-1)));
    host.off('message', onScoring);
  }

  // 積分排行：預設顯示；主辦端可以隱藏，重開的大螢幕也要接回這個狀態
  check('大螢幕排行榜預設顯示', settings[0]?.ranks === true, JSON.stringify(settings[0]));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'ranks', value: false }));
  await sleep(200);
  check('主辦端可以隱藏大螢幕排行榜', settings.at(-1)?.ranks === false, JSON.stringify(settings.at(-1)));
  host.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'ranks', value: true }));
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

// ── 文字雲（參與者進場前的部分）────────────────────────────
// 主持人提問、參與者用手機輸入、大螢幕即時呈現。這一段先驗「未認證不得出題」
// 與題目驗證，完整流程在兩人進場後。
{
  badHost.send(JSON.stringify({ type: 'HOST_START_WORDCLOUD', question: '入侵者的題目' }));
  await sleep(200);
  check('未認證連線無法出文字雲題目', screenCloudQ === null);

  const rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_START_WORDCLOUD', question: '   ' }));
  await sleep(200);
  check('空白的文字雲題目被拒絕', hostRejects.length === rejectsBefore + 1 && screenCloudQ === null, hostRejects.at(-1)?.reason);
}

// ── 兩位參與者進場 ────────────────────────────────────────
function joinPhone(name) {
  const ws = new WebSocket(URL);
  const box = {
    ws, name, welcome: null, code: null, mission: null, results: [], confirmReq: null,
    quiz: null, acks: [], quizResult: null, scores: [],
    cloudQ: null, cloudAcks: [], cloudClosed: null, social: null,
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
    if (m.type === 'WORDCLOUD_QUESTION') box.cloudQ = m.cloud;
    if (m.type === 'WORDCLOUD_ACK') box.cloudAcks.push(m);
    if (m.type === 'WORDCLOUD_CLOSED') box.cloudClosed = m.result;
    if (m.type === 'SOCIAL_SELF') box.social = m;
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

// 文字雲的完整流程：出題 → 手機作答（彙整、上限、不雅字）→ 主持人隱藏 → 補送 → 收題
{
  const words = () => (screenCloud?.words ?? []).map((w) => `${w.text}:${w.count}`).join(',');
  const say = (phone, text) => phone.ws.send(JSON.stringify({ type: 'WORDCLOUD_ANSWER', text }));

  host.send(JSON.stringify({ type: 'HOST_START_WORDCLOUD', question: '用一個詞形容今天' }));
  await sleep(350);
  check('手機與大螢幕都收到文字雲題目',
    amy.cloudQ?.question === '用一個詞形容今天' && screenCloudQ?.id === amy.cloudQ?.id, amy.cloudQ?.question);

  say(amy, '開心');
  say(ben, '開心！');   // 不同寫法要彙整成同一個詞
  await sleep(150);
  say(amy, '期待');
  await sleep(500);
  check('同一個詞的不同寫法彙整，大螢幕即時收到票數', words() === '開心:2,期待:1', words());
  check('手機收到自己送過的答案', amy.cloudAcks.at(-1)?.mine?.join() === '開心,期待', JSON.stringify(amy.cloudAcks.at(-1)));
  check('大螢幕的雲不帶是誰寫的', !JSON.stringify(screenCloud).includes(amy.welcome.userId));

  say(amy, '幹你娘');
  await sleep(300);
  check('不雅字被擋下，不會出現在大螢幕', amy.cloudAcks.at(-1)?.reason === 'BLOCKED' && !words().includes('幹'),
    JSON.stringify(amy.cloudAcks.at(-1)));

  say(amy, '好玩');
  await sleep(150);
  say(amy, '第四個');
  await sleep(300);
  check('每人最多 3 個答案', amy.cloudAcks.at(-1)?.reason === 'LIMIT' && amy.cloudAcks.at(-2)?.ok === true);

  amy.ws.send(JSON.stringify({ type: 'HOST_HIDE_WORD', word: '期待' }));
  await sleep(200);
  check('手機不能隱藏詞', words().includes('期待'));
  host.send(JSON.stringify({ type: 'HOST_HIDE_WORD', word: '期待' }));
  await sleep(200);
  check('主持人隱藏的詞立刻從大螢幕消失', !words().includes('期待'), words());
  say(ben, '期待');
  await sleep(450);
  check('被隱藏的詞之後有人再送也不會出現', !words().includes('期待') && ben.cloudAcks.at(-1)?.ok === true, words());

  // 主辦端重整：文字雲面板只由 WORDCLOUD_* 事件驅動，認證時要補送題目與雲
  const rehost = new WebSocket(URL);
  const reMsgs = [];
  await new Promise((res) => rehost.on('open', res));
  rehost.on('message', (d) => reMsgs.push(JSON.parse(d)));
  rehost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(400);
  check('主辦端重連後補送進行中的文字雲',
    reMsgs.some((m) => m.type === 'WORDCLOUD_QUESTION') && reMsgs.find((m) => m.type === 'WORDCLOUD_STATE')?.cloud?.words?.length > 0);
  rehost.close();

  // 大螢幕重開：要接回題目與雲
  const reScreen = new WebSocket(URL);
  const reScreenMsgs = [];
  reScreen.on('open', () => reScreen.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
  reScreen.on('message', (d) => reScreenMsgs.push(JSON.parse(d)));
  await sleep(400);
  check('大螢幕重連後補送進行中的文字雲', reScreenMsgs.some((m) => m.type === 'WORDCLOUD_STATE'));
  reScreen.close();

  // 節目單接著出下一題：上一題自動收掉，不會卡在「上一題還沒收」
  const rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_START_WORDCLOUD', question: '今天最難忘的一刻？' }));
  await sleep(400);
  check('出新題時上一題自動收掉', amy.cloudClosed?.question === '用一個詞形容今天' && hostRejects.length === rejectsBefore,
    JSON.stringify(amy.cloudClosed));
  check('收題時帶著最終的詞（給大螢幕停留與活動報告）', amy.cloudClosed?.words?.[0]?.text === '開心');
  check('新題目送到手機', amy.cloudQ?.question === '今天最難忘的一刻？');

  host.send(JSON.stringify({ type: 'HOST_CLOSE_WORDCLOUD' }));
  await sleep(300);
  check('收題後大螢幕與手機都收到結束', screenCloudClosed?.question === '今天最難忘的一刻？' && amy.cloudClosed?.question === '今天最難忘的一刻？');
  say(amy, '太晚了');
  await sleep(200);
  check('收題後送答案被拒', amy.cloudAcks.at(-1)?.reason === 'NO_ROUND');
}

// ── 清場：只留小美與阿賓 ────────────────────────────────────
//
// 前面的安全性測試（偽造憑證、角色轉換）留下了幾個角色，而**關掉 socket
// 不等於角色離場** —— 那是刻意的設計（賓客關分頁角色仍留 AGENT_TTL_MS＝45 秒），
// 遠長於整套 e2e。後面的任務、私訊、賓果都假設場上只有這兩位，在這裡明確清場。
// （原本這一步寫在已移除的尋寶測試開頭。）
{
  host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION' }));
  await sleep(300);
  const keep = new Set([amy.welcome.userId, ben.welcome.userId]);
  for (const a of hostStates.at(-1)?.agents ?? []) {
    if (!keep.has(a.id)) host.send(JSON.stringify({ type: 'HOST_KICK', agentId: a.id }));
  }
  await sleep(300);
  check('清場後場上只剩兩位參與者',
    (hostStates.at(-1)?.agents ?? []).length === 2,
    (hostStates.at(-1)?.agents ?? []).map((a) => a.name).join(', '));
}

// ── COLOR_HUNT 任務 ───────────────────────────────────────
{
  hostRejects = [];
  host.send(JSON.stringify({
    type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1,
  }));
  await sleep(300);
  check('COLOR_HUNT 缺少顏色時被拒絕', hostRejects.length > 0);

  // 場上沒有人是紅色的：沒有人做得完的任務預設擋下，主辦端確認後（force）才發
  hostRejects = [];
  host.send(JSON.stringify({
    type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1,
    colorFamily: 'RED',
  }));
  await sleep(300);
  check('沒有人做得完的任務預設擋下，並說明原因',
    hostRejects.at(-1)?.check?.level === 'block' && /做得完/.test(hostRejects.at(-1)?.reason ?? ''),
    hostRejects.at(-1)?.reason);
  host.send(JSON.stringify({
    type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1,
    colorFamily: 'RED', force: true,
  }));
  await sleep(400);
  check('手機收到帶顏色的任務公告',
    amy.mission?.mission?.colorFamily === 'RED',
    amy.mission?.mission?.colorFamily);

  // 投影機在任務進行中重開：要接回任務橫幅（原本漏了，要等下一個任務才會出現）
  {
    const late = new WebSocket(URL);
    const got = [];
    late.on('message', (d) => got.push(JSON.parse(d).type));
    late.on('open', () => late.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
    await sleep(400);
    check('大螢幕中途連上時補送進行中的任務', got.includes('MISSION_ANNOUNCE') && got.includes('MISSION_STATE'));
    late.close();
  }

  host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION' }));
  await sleep(200);
}

// ── 發布前檢查（server/missionRules.js 的 feasibility）──────────
{
  const replies = [];
  host.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'HOST_MISSION_CHECK') replies.push(m);
  });
  host.send(JSON.stringify({ type: 'HOST_CHECK_MISSION', missionType: 'PAIRING', target: 1, seq: 41 }));
  await sleep(300);
  const r = replies.find((m) => m.seq === 41);
  check('發布前檢查回報做不做得完', ['ok', 'warn', 'block'].includes(r?.check?.level) && typeof r?.check?.summary === 'string',
    JSON.stringify(r?.check));
  check('發布前檢查附上可選的條件（標籤、集合點）',
    Array.isArray(r?.options?.catalog) && Array.isArray(r?.options?.spots));

  host.send(JSON.stringify({ type: 'HOST_CHECK_MISSION', missionType: 'GATHER', spot: 'nowhere', teamSize: 3, seq: 42 }));
  await sleep(300);
  check('集合點不在目前場景時，檢查直接說明原因', /集合點/.test(replies.find((m) => m.seq === 42)?.error ?? ''));

  hostRejects = [];
  host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'DIFF_TRAIT', traitKey: 'no_such_key', target: 1 }));
  await sleep(300);
  check('沒人答過的題目不能拿來發同類／不同類任務', hostRejects.length > 0, hostRejects.at(-1)?.reason);
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
    // force：這時場上的人彼此都配對過了，主辦端確認後照樣發（見上面 COLOR_HUNT 那段）
    host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'PAIRING', target: 2, force: true }));
    return true;
  })());
await sleep(400);
check('新任務已生效', hostStates.at(-1)?.missions?.[0]?.target === 2, `target=${hostStates.at(-1)?.missions?.[0]?.target}`);

// ── 同時好幾個任務；問答、文字雲、賓果一次只能一個 ──────────
{
  const { COLOR_FAMILIES, avatarMatchesFamily } = await import('../shared/colorFamily.js');
  const mine = COLOR_FAMILIES.find((f) => avatarMatchesFamily(AVATAR, f.id));
  const other = COLOR_FAMILIES.find((f) => !avatarMatchesFamily(AVATAR, f.id));
  const missionsNow = () => hostStates.at(-1)?.missions ?? [];

  // force：這時場上的人彼此都配對過了，發布前檢查會擋（見上面 COLOR_HUNT 那段）
  host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1, colorFamily: mine.id, force: true }));
  await sleep(300);
  check('可以同時發布第二個任務', missionsNow().length === 2, missionsNow().map((m) => m.title).join('、'));
  let rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'PAIRING', target: 3, force: true }));
  await sleep(200);
  check('同樣的任務不能重複開', hostRejects.length === rejectsBefore + 1 && missionsNow().length === 2
    && /已經在進行中/.test(hostRejects.at(-1)?.reason ?? ''), hostRejects.at(-1)?.reason);

  // 一次配對同時算進符合的兩個任務；配對分只給一次，達標獎勵每個任務各給一次
  const tA = joinPhone('任務甲');
  const tB = joinPhone('任務乙');
  await sleep(700);
  tA.ws.send(JSON.stringify({ type: 'PAIR_CLAIM', code: tB.code }));
  await sleep(300);
  tB.ws.send(JSON.stringify({ type: 'PAIR_CONFIRM', accept: true }));
  await sleep(400);
  const r1 = tA.results.at(-1);
  check('一次配對同時算進符合的兩個任務', r1?.ok && r1.missions?.length === 2, JSON.stringify(r1?.missions));
  check('配對分只給一次，達標獎勵照任務各算（20 ＋ 顏色任務達標 50）', r1?.points === 70, `points=${r1?.points}`);

  // 顏色不符的任務不算進去，但同時開著的一般配對任務照算
  host.send(JSON.stringify({ type: 'HOST_PUBLISH_MISSION', missionType: 'COLOR_HUNT', target: 1, colorFamily: other.id, force: true }));
  await sleep(300);
  const otherId = missionsNow().find((m) => m.colorFamily === other.id)?.id;
  const tC = joinPhone('任務丙');
  await sleep(700);
  await sleep(2100);   // 配對提交的冷卻
  tA.ws.send(JSON.stringify({ type: 'PAIR_CLAIM', code: tC.code }));
  await sleep(300);
  tC.ws.send(JSON.stringify({ type: 'PAIR_CONFIRM', accept: true }));
  await sleep(400);
  const r2 = tA.results.at(-1);
  check('顏色不符的任務不算，同時開著的其他任務照算',
    r2?.ok && r2.missions?.length === 2 && !r2.missions.some((m) => m.id === otherId), JSON.stringify(r2));

  host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION', missionId: otherId }));
  await sleep(300);
  check('可以只結算其中一個任務', missionsNow().length === 2 && !missionsNow().some((m) => m.id === otherId),
    missionsNow().map((m) => m.title).join('、'));

  // 一次只能進行一個活動（任務除外）
  host.send(JSON.stringify({ type: 'HOST_START_WORDCLOUD', question: '一次一個？' }));
  await sleep(300);
  rejectsBefore = hostRejects.length;
  host.send(JSON.stringify({ type: 'HOST_START_QUIZ', question: '插進來的問答', options: ['一', '二'], correctIndex: 0, durationMs: 10000 }));
  await sleep(200);
  check('文字雲進行中不能開問答', hostRejects.length === rejectsBefore + 1 && /文字雲/.test(hostRejects.at(-1)?.reason ?? ''),
    hostRejects.at(-1)?.reason);
  host.send(JSON.stringify({ type: 'HOST_START_BINGO' }));
  await sleep(200);
  check('文字雲進行中不能開賓果', hostRejects.length === rejectsBefore + 2, hostRejects.at(-1)?.reason);
  check('任務不受「一次一個」限制，照常進行', missionsNow().length === 2);
  host.send(JSON.stringify({ type: 'HOST_CLOSE_WORDCLOUD' }));
  await sleep(200);

  for (const t of [tA, tB, tC]) { t.ws.send(JSON.stringify({ type: 'CLIENT_LEAVE' })); t.ws.close(); }
  // 收回只剩原本那一個配對任務，後面的測試照原樣進行
  const colorId = missionsNow().find((m) => m.colorFamily === mine.id)?.id;
  host.send(JSON.stringify({ type: 'HOST_CLOSE_MISSION', missionId: colorId }));
  await sleep(300);
}

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
  check('預設的合照是原地拍', photoStates.find((x) => x.phase === 'STAGING')?.arrange === 'stay');

  // 依互動排位：主辦端選了才換站位，流程其餘不變
  photoStates.length = 0;
  host.send(JSON.stringify({ type: 'HOST_TAKE_PHOTO', arrange: 'affinity' }));
  const deadline2 = Date.now() + 25000;
  while (Date.now() < deadline2 && !photoStates.some((x) => x.phase === 'DONE' || x.phase === 'ERROR')) {
    await sleep(200);
  }
  check('選「依互動排位」時伺服器照著排', photoStates.find((x) => x.phase === 'STAGING')?.arrange === 'affinity',
    JSON.stringify(photoStates.map((x) => [x.phase, x.arrange])));
  check('依互動排位的合照同樣會結束（不卡在定位）',
    photoStates.some((x) => x.phase === 'ERROR' || x.phase === 'DONE'));
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

// ── 主控台的大螢幕預覽 ────────────────────────────────────
// 預覽小窗也是一台大螢幕（收同樣的廣播），但絕不能被挑去截圖：它比投影機先連上時，
// 「儲存畫面」與大合照底圖就會變成主持人電腦上那張縮小的預覽。真的大螢幕已在上面關掉。
{
  const preview = new WebSocket(URL);
  const pvMsgs = [];
  preview.on('open', () => preview.send(JSON.stringify({ type: 'SCREEN_HELLO', preview: true })));
  preview.on('message', (d) => pvMsgs.push(JSON.parse(d)));
  const pvHost = new WebSocket(URL);
  const pvHostMsgs = [];
  await new Promise((res) => pvHost.on('open', res));
  pvHost.on('message', (d) => pvHostMsgs.push(JSON.parse(d)));
  pvHost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  await sleep(400);
  check('預覽連線照樣收到大螢幕的資料', pvMsgs.some((m) => m.type === 'STAGE_ROSTER'));
  pvHost.send(JSON.stringify({ type: 'HOST_SCREEN_CMD', cmd: 'capture' }));
  await sleep(400);
  check('只有預覽時「儲存畫面」回報大螢幕沒連線，不會跟預覽要截圖',
    pvHostMsgs.find((m) => m.type === 'HOST_SCREEN_SHOT')?.error === '大螢幕沒有連線'
      && !pvMsgs.some((m) => m.type === 'SCREEN_CAPTURE_REQ'),
    JSON.stringify(pvHostMsgs.find((m) => m.type === 'HOST_SCREEN_SHOT')));
  preview.close();
  pvHost.close();
  await sleep(200);
}

// ── 重開伺服器後的資料保留 ────────────────────────────────
// 現場最真實的災難情境：主辦筆電當掉，或有人誤觸 Ctrl+C。
const amyId = amy.welcome.userId;
const amyToken = amy.welcome.rejoinToken;
const amyScoreBefore = amy.scores.at(-1)?.score ?? 0;

await stopServer();

// ── 事件紀錄 ──────────────────────────────────────────────
// 實測的停留時間、操控時間、配對成功率全靠這份檔案。這裡驗的是真的伺服器
// 跑完前半段之後實際寫出了什麼，而不是 EventLog 類別本身（那在單元測試）。
{
  const evs = readEvents();
  const kinds = new Set(evs.map((e) => e.ev));
  check('事件紀錄每一行都帶場次與伺服器時間',
    evs.length > 0 && evs.every((e) => e.session === 'e2e' && Number.isFinite(e.t)),
    `${evs.length} 筆`);
  check('事件紀錄以 session_start 開頭、正常關機寫下 session_end',
    evs[0]?.ev === 'session_start' && evs[0]?.kind === 'test'
    && evs.some((e) => e.ev === 'session_end' && e.reason === 'shutdown'),
    `${evs[0]?.ev} … ${evs.at(-1)?.ev}`);
  const missing = ['join', 'disconnect', 'leave', 'mode_change', 'pair_claim', 'pair_confirm',
    'mission_publish', 'mission_progress', 'mission_close', 'quiz_start', 'quiz_answer',
    'quiz_reveal', 'wordcloud_start', 'wordcloud_answer', 'wordcloud_close', 'theme_change',
    'message', 'persona', 'message_report']
    .filter((k) => !kinds.has(k));
  check('前半段走過的玩法都留下事件', missing.length === 0, `缺 ${missing.join('、')}`);
  const joins = evs.filter((e) => e.ev === 'join');
  check('捏臉入場記為 builder 且沒有生成 id',
    joins.length > 0 && joins.every((e) => e.entry === 'builder' && e.genReq === undefined
      && typeof e.name === 'string'),
    JSON.stringify(joins[0]));
  check('配對成功的確認事件帶雙方 id',
    evs.some((e) => e.ev === 'pair_confirm' && e.ok === true && e.agent && e.peer && e.agent !== e.peer));
  check('問答作答事件帶伺服器算的作答時間',
    evs.some((e) => e.ev === 'quiz_answer' && Number.isFinite(e.elapsedMs)));
  check('事件紀錄不含照片或重連憑證',
    !fs.readFileSync(EVENTS_FILE, 'utf8').match(/rejoinToken|data:image/));
}

const keyAfterRestart = await launch();
check('同一場次重開後接著寫，不覆蓋前半場',
  readEvents().filter((e) => e.ev === 'session_start').length === 2
  && readEvents().at(-1)?.resumed === true);

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
    box.bingo = { ask: null, card: null, results: [], tagged: [], ended: null };
    box.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'BINGO_ASK') box.bingo.ask = m;
      if (m.type === 'BINGO_CARD') { box.bingo.card = m.card; box.bingo.myFacts = m.myFacts; }
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
  let bingoRound = null;
  let factBank = null;
  bHost.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'BINGO_STATE') bingoRound = m.round;
    if (m.type === 'HOST_BINGO_FACTS') factBank = m;
  });
  bHost.send(JSON.stringify({ type: 'HOST_AUTH', key: HOST_KEY }));
  // 大螢幕也開一條：每個人勾了什麼只給主辦端，不能出現在全場看得到的畫面上
  const bScreen = new WebSocket(URL);
  const screenBingo = [];
  bScreen.on('open', () => bScreen.send(JSON.stringify({ type: 'SCREEN_HELLO' })));
  bScreen.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'BINGO_STATE') screenBingo.push(m.round); });
  await sleep(300);
  check('主辦端認證時收到自我介紹題（依場景預設）', factBank?.isDefault === true && factBank.facts.length >= 3, JSON.stringify(factBank));
  bHost.send(JSON.stringify({ type: 'HOST_START_BINGO' }));
  await sleep(400);
  const facts = pA.bingo.ask?.facts ?? [];
  check('開局先問自我介紹，還不發卡', facts.length === 6 && pB.bingo.ask?.facts?.length === 6 && pA.bingo.card === null,
    JSON.stringify(pA.bingo.ask));
  check('主辦端看到「勾自我介紹中」', bingoRound?.phase === 'ask', JSON.stringify(bingoRound));

  // 乙勾了第一題、甲什麼都沒勾。場上在線的只有這兩支手機，兩人答完就發卡
  pA.ws.send(JSON.stringify({ type: 'BINGO_FACTS', yes: [] }));
  pB.ws.send(JSON.stringify({ type: 'BINGO_FACTS', yes: [facts[0].id, 'bogus'] }));
  await sleep(600);
  check('大家都答完就發卡，每人一張 9 格的卡', pA.bingo.card?.cells?.length === 9 && pB.bingo.card?.cells?.length === 9);
  const factLabel = `${facts[0]?.text}的人`;
  check('甲的卡上有乙勾的那一題', pA.bingo.card?.cells?.some((c) => c.label === factLabel),
    JSON.stringify(pA.bingo.card?.cells?.map((c) => c.label)));
  check('乙自己勾的題目不會出現在乙的卡上（場上沒有別人符合）', !pB.bingo.card?.cells?.some((c) => c.label === factLabel));
  check('手機上看得到自己開局勾了什麼（不認得的題號略過）',
    JSON.stringify(pB.bingo.myFacts) === JSON.stringify([facts[0]?.text]) && Array.isArray(pA.bingo.myFacts) && pA.bingo.myFacts.length === 0,
    JSON.stringify([pA.bingo.myFacts, pB.bingo.myFacts]));
  const pickOf = (name) => bingoRound?.picks?.find((p) => p.name === name);
  check('主辦端看得到每個人勾了哪幾題', JSON.stringify(pickOf('賓果乙')?.facts) === JSON.stringify([facts[0]?.text])
    && pickOf('賓果甲')?.facts?.length === 0, JSON.stringify(bingoRound?.picks));
  check('大螢幕收不到每個人勾了什麼', screenBingo.length > 0 && screenBingo.every((r) => r?.picks === undefined),
    JSON.stringify(screenBingo.at(-1)));
  bScreen.close();

  const first = pA.bingo.card.cells.findIndex((c) => c.label === factLabel);
  pA.ws.send(JSON.stringify({ type: 'BINGO_CLAIM', cell: first, code: pB.code }));
  await sleep(300);
  check('輸入對方的碼、對方勾過這一題就填上', pA.bingo.results.at(-1)?.ok === true && pA.bingo.card.cells[first].name === '賓果乙',
    JSON.stringify(pA.bingo.results.at(-1)));
  // 甲的衣服是紅色、兩人也沒有配對連線：乙卡上「衣服有紅色」或「還不認識的人」甲一定符合
  check('被填進去的人收到通知，並被邀請順便把對方填上', pB.bingo.tagged.at(-1)?.byName === '賓果甲' && !!pB.bingo.tagged.at(-1)?.offer?.label,
    JSON.stringify(pB.bingo.tagged.at(-1)));
  pB.ws.send(JSON.stringify({ type: 'BINGO_ACCEPT' }));
  await sleep(300);
  check('收下邀請不必輸碼就填上，並通知對方', pB.bingo.results.at(-1)?.ok === true
    && pB.bingo.card.cells.some((c) => c.name === '賓果甲') && pA.bingo.tagged.at(-1)?.byName === '賓果乙'
    && pA.bingo.tagged.at(-1)?.offer === null, JSON.stringify([pB.bingo.results.at(-1), pA.bingo.tagged.at(-1)]));
  pB.ws.send(JSON.stringify({ type: 'BINGO_ACCEPT' }));
  await sleep(200);
  check('同一個邀請不能收兩次', pB.bingo.results.at(-1)?.reason === 'NO_OFFER', JSON.stringify(pB.bingo.results.at(-1)));

  // 立刻再送：冷卻擋下（防枚舉配對碼）
  const second = pA.bingo.card.cells.findIndex((c, i) => i !== first && !c.filled);
  pA.ws.send(JSON.stringify({ type: 'BINGO_CLAIM', cell: second, code: pB.code }));
  await sleep(200);
  check('連續填格受配對冷卻限制', pA.bingo.results.at(-1)?.reason === 'COOLDOWN', JSON.stringify(pA.bingo.results.at(-1)));

  // 冷卻過後再填同一個人：10 人以上不行；人少時可以（否則 9 格永遠填不滿）
  await sleep(3100);
  const fitsB = (c) => !c.filled && (c.label === '衣服有紅色的人' || c.label === '找一個你還不認識的人');
  const third = pA.bingo.card.cells.findIndex(fitsB);
  pA.ws.send(JSON.stringify({ type: 'BINGO_CLAIM', cell: third, code: pB.code }));
  await sleep(300);
  const many = (bingoRound?.players ?? 0) - 1 >= 9;
  check(many ? '10 人以上：同一個人只能填一格' : '不到 10 人：同一個人可以再填一格',
    many ? pA.bingo.results.at(-1)?.reason === 'USED' : pA.bingo.results.at(-1)?.ok === true,
    JSON.stringify({ players: bingoRound?.players, third, r: pA.bingo.results.at(-1) }));

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


// 重開之後才走到的玩法（賓果、候補、話題桌）也要留下事件。
// 揮手／乾杯的成功（greet）這套 e2e 走不到：只有一個人對空氣乾杯
{
  const kinds = new Set(readEvents().map((e) => e.ev));
  const missing = ['bingo_start', 'bingo_claim', 'bingo_end',
    'waitlist_join', 'topic_card'].filter((k) => !kinds.has(k));
  check('後半段走過的玩法也都留下事件', missing.length === 0, `缺 ${missing.join('、')}`);
  check('私訊事件不含內容',
    readEvents().filter((e) => e.ev === 'message').every((e) => !('text' in e)));
}

finish();
