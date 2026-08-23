/**
 * 通訊與狀態調度層 (Gateway & State Manager)
 *
 * 技術文件架構第 2 層。負責：
 *   1. 靜態資源服務（手機控制器 / 大螢幕）
 *   2. WebSocket 連線生命週期管理
 *   3. 入站訊息驗證
 *   4. 30 Hz 模擬 tick，驅動 M2 並廣播 STAGE_SYNC
 *
 * HTTP 與 WebSocket 共用同一個 port，現場只需開放一個連接埠，
 * 手機掃碼後也能直接由 location.host 推導出 WebSocket 位址，免設定。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  EV, ACTIONS, STAGE, SYNC_FPS, PAIR_ERRORS, MISSION_TYPES,
  SCORE_SOURCES,
} from '../shared/protocol.js';
import { validateAvatarConfig } from '../shared/avatars.js';
import {
  TICK_MS, MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, RATE_LIMIT, HOST_KEY_LENGTH, SCORING,
  PERSISTENCE,
} from './config.js';
import { Stage } from './state.js';
import { RateLimiter } from './ratelimit.js';
import { startTicker } from './scheduler.js';
import { MissionBoard } from './missions.js';
import { SocialGraph } from './socialgraph.js';
import { PairingSession } from './pairing.js';
import { QuizSession } from './quiz.js';
import { ScoreBoard } from './scores.js';
import { SnapshotStore, Directory } from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const stage = new Stage();
const missions = new MissionBoard();
const graph = new SocialGraph();
const pairing = new PairingSession(graph);
const quiz = new QuizSession();
const scores = new ScoreBoard();

// ─────────────────────────────────────────────────────────────
// 狀態還原
//
// 場上角色的座標與速度不存也不還原 —— 它們每秒變動 30 次，
// 而且伺服器重開後角色本來就該重新入場。還原的是重來一次會心痛的東西：
// 積分、社交圖譜、任務與問答紀錄，以及讓參與者認領回自己角色的身分目錄。
// ─────────────────────────────────────────────────────────────
const store = new SnapshotStore(
  path.isAbsolute(PERSISTENCE.file) ? PERSISTENCE.file : path.join(ROOT, PERSISTENCE.file),
  { enabled: PERSISTENCE.enabled },
);
const directory = new Directory({
  limit: PERSISTENCE.directoryLimit,
  ttlMs: PERSISTENCE.directoryTtlMs,
});

const snapshot = store.load();
if (snapshot) {
  scores.hydrate(snapshot.scores);
  graph.hydrate(snapshot.graph);
  missions.hydrate(snapshot.missions);
  quiz.hydrate(snapshot.quiz);
  directory.hydrate(snapshot.directory);
}

/** 快照內容。集中在一處，新增要落地的東西時只改這裡與還原段。 */
const snapshotData = () => ({
  version: 1,
  savedAt: Date.now(),
  hostKey: HOST_KEY,
  scores: scores.export(),
  graph: graph.export(),
  missions: missions.export(),
  quiz: quiz.export(),
  directory: directory.export(),
});

/** 狀態有變動，等下一次自動存檔 */
const markDirty = () => store.touch();

/**
 * 主辦端通行密鑰。
 *
 * 控制台不能只靠「網址沒人知道」來保護：現場所有人連在同一個區網，
 * 路徑可被掃出，而控制台握有踢人與結算全場的能力。
 * 避開易混淆字元（0/O、1/I），因為主辦者要從終端機讀出來手動輸入。
 *
 * 取用順序：環境變數 → 快照裡的舊密鑰 → 重新產生。
 * 中間那一步是關鍵：伺服器重開後密鑰若跟著換，主辦端就得在活動進行中
 * 重新讀一組新號碼再登入一次，而那通常正好是最忙亂的時刻。
 */
function resolveHostKey() {
  const fromEnv = process.env.PERSONAFLOW_HOST_KEY?.trim().toUpperCase();
  if (fromEnv) {
    if (fromEnv.length === HOST_KEY_LENGTH) return fromEnv;
    console.warn(`[host] 環境變數指定的密鑰長度不是 ${HOST_KEY_LENGTH} 碼，已忽略`);
  }
  const fromSnapshot = snapshot?.hostKey;
  if (typeof fromSnapshot === 'string' && fromSnapshot.length === HOST_KEY_LENGTH) {
    return fromSnapshot;
  }
  return Array.from(randomBytes(HOST_KEY_LENGTH))
    .map((b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31])
    .join('');
}

const HOST_KEY = resolveHostKey();
const HOST_KEY_SOURCE = process.env.PERSONAFLOW_HOST_KEY ? '環境變數'
  : (snapshot?.hostKey === HOST_KEY ? '沿用上次啟動' : '本次啟動產生');

function keyMatches(input) {
  if (typeof input !== 'string') return false;
  const a = Buffer.from(input.toUpperCase(), 'utf8');
  const b = Buffer.from(HOST_KEY, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────
// 靜態資源服務
// ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 把 URL 路徑解析成實體檔案路徑。
 * 解析後強制檢查結果仍位於允許的根目錄下，阻斷 ../ 路徑穿越。
 */
function resolveStatic(urlPath) {
  // 前端相依一律由 node_modules 直出，不依賴 CDN —— 現場網路不穩時仍能載入（§6 風險 1）
  if (urlPath === '/vendor/nipplejs.js') {
    return path.join(ROOT, 'node_modules', 'nipplejs', 'dist', 'nipplejs.js');
  }
  if (urlPath === '/vendor/rough.esm.js') {
    return path.join(ROOT, 'node_modules', 'roughjs', 'bundled', 'rough.esm.js');
  }

  // NUL 位元組會讓底層 fs 呼叫的路徑在 C 層被截斷，先擋掉
  if (urlPath.includes('\0')) return null;

  let base = PUBLIC_DIR;
  let rel;
  if (urlPath.startsWith('/shared/')) {
    // 根目錄必須是 ROOT/shared 而不是 ROOT。
    // 用 ROOT 當根時，`/shared/..%2f.env` 解碼後是 `/shared/../.env`，
    // 解析結果 ROOT/.env 仍在 ROOT 底下 —— 包含性檢查會放行，
    // 於是 .env 與 data/state.json（內含主辦密鑰與重連憑證）全都讀得到。
    base = path.join(ROOT, 'shared');
    rel = urlPath.slice('/shared/'.length);
  } else {
    rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    if (rel.endsWith('/')) rel += 'index.html';
  }

  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

// ─────────────────────────────────────────────────────────────
// 角色資產生成代理（整合計畫階段 4）
//
// 手機端不直接打 Python 服務，而是經由這裡轉發，理由有三：
//   1. 同源 —— 免去 CORS，也免去 HTTPS 頁面打 http 服務的混合內容封鎖
//   2. Python 服務只綁 127.0.0.1，不暴露在場館網路上
//   3. 生成服務掛掉時，這裡能回一個結構化的降級結果，而不是讓手機端看到
//      連線錯誤 —— 對參與者而言那應該是「用預設外觀進場」，不是故障
// ─────────────────────────────────────────────────────────────
const VISION_HOST = process.env.VISION_HOST ?? '127.0.0.1';
const VISION_PORT = Number(process.env.VISION_PORT ?? 5055);

/** 手機照片經 base64 後可達數 MB；超過此上限直接拒收，不讓記憶體被灌爆 */
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

/** 生成走兩次外部 API（VLM + 生圖），比一般請求慢得多 */
const GENERATE_TIMEOUT_MS = 150_000;

const DEFAULT_FALLBACK_COLORS = {
  skin: '#F4C08A', hair: '#4A2C1A', torso: '#8FA05E', legs: '#B7A98A',
};

function sendJSON(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function proxyGenerate(req, res) {
  if (req.method !== 'POST') {
    sendJSON(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_PHOTO_BYTES) {
      aborted = true;
      sendJSON(res, 413, { ok: false, error: 'photo_too_large', fallbackColors: DEFAULT_FALLBACK_COLORS });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const upstream = http.request({
      host: VISION_HOST,
      port: VISION_PORT,
      path: '/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: GENERATE_TIMEOUT_MS,
    }, (up) => {
      const out = [];
      up.on('data', (c) => out.push(c));
      up.on('end', () => {
        res.writeHead(up.statusCode ?? 200, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(Buffer.concat(out));
      });
    });

    // 生成服務沒開或逾時，都回降級結果讓參與者仍能進場（整合計畫 §3.5）
    const degrade = (error) => {
      if (res.headersSent) return;
      sendJSON(res, 200, { ok: false, error, fallbackColors: DEFAULT_FALLBACK_COLORS });
    };
    upstream.on('timeout', () => { upstream.destroy(); degrade('generation_timeout'); });
    upstream.on('error', () => degrade('vision_service_unavailable'));

    upstream.end(body);
  });
}

// ─────────────────────────────────────────────────────────────
// TLS
//
// 手機瀏覽器的 getUserMedia 要求安全情境（HTTPS 或 localhost）。
// 場館用 http://192.168.x.x 時相機會被瀏覽器直接拒絕，掃描進場等於不存在
// —— 這是瀏覽器的硬規則，不是可以繞過的設定。
//
// 提供 TLS_CERT / TLS_KEY 就以 HTTPS 啟動，未提供則維持 HTTP（本機開發用）。
// 憑證產生見 scripts/make-cert.sh。
// ─────────────────────────────────────────────────────────────
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

function readTLSOptions() {
  if (!TLS_CERT || !TLS_KEY) return null;
  try {
    return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
  } catch (err) {
    // 現場最怕的是「以為開了 HTTPS，其實悄悄退回 HTTP」——
    // 那會等到有人要拍照才發現。這裡直接讓啟動失敗。
    console.error(`\n  ✗ 讀不到 TLS 憑證：${err.message}`);
    console.error('    請確認 TLS_CERT 與 TLS_KEY 指向正確的檔案，或不要設定這兩個變數以 HTTP 啟動。\n');
    process.exit(1);
  }
}

const tlsOptions = readTLSOptions();
const SCHEME = tlsOptions ? 'https' : 'http';

function handleRequest(req, res) {
  // decodeURIComponent 對不完整的百分比編碼（如 /%E0%A4%A）會同步拋 URIError。
  // 這個例外會從 request handler 冒出去成為 uncaughtException，直接終止行程 ——
  // 現場任何一支手機送出一個壞掉的網址，整個裝置就下線了。
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  // 解碼後的路徑會被放進 302 的 Location 標頭。含 CR/LF 時 writeHead 會丟
  // ERR_INVALID_CHAR，而那是在 fs.readFile 的非同步回呼裡拋出的 ——
  // 沒有任何 try 接得到，整個 Gateway 直接結束。
  // 控制字元對合法的靜態資源路徑一律無用，在入口擋掉最乾淨。
  if (/[\u0000-\u001f\u007f]/.test(urlPath)) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (urlPath === '/api/generate') {
    proxyGenerate(req, res);
    return;
  }

  const filePath = resolveStatic(urlPath);

  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 目錄請求少了尾斜線時，補上再試一次（/controller → /controller/）
      if (err.code === 'EISDIR' || (err.code === 'ENOENT' && !path.extname(filePath))) {
        res.writeHead(302, { Location: encodeURI(`${urlPath.replace(/\/$/, '')}/`) }).end();
        return;
      }
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = tlsOptions
  ? https.createServer(tlsOptions, handleRequest)
  : http.createServer(handleRequest);

// ─────────────────────────────────────────────────────────────
// WebSocket 連線與訊息處理
// ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

/** @type {Set<import('ws').WebSocket>} 已註冊的大螢幕連線 */
const screens = new Set();
/** @type {Set<import('ws').WebSocket>} 已通過認證的主辦端連線 */
const hosts = new Set();
/** @type {Map<string, import('ws').WebSocket>} agentId → 該參與者的連線，用於定向推送 */
const controllers = new Map();

const send = (ws, type, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
};

/** 對指定參與者推送（如配對碼、確認請求） */
function sendToAgent(agentId, type, payload) {
  const ws = controllers.get(agentId);
  if (ws) send(ws, type, payload);
}

/** 對一組連線廣播同一份已序列化的訊息 */
function blast(targets, type, payload) {
  const raw = JSON.stringify({ type, ...payload });
  for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(raw);
}

/** 推送給所有人：參與者、大螢幕、主辦端 */
function blastAll(type, payload) {
  blast(controllers.values(), type, payload);
  blast(screens, type, payload);
  blast(hosts, type, payload);
}

/** 角色是否仍在場。排行榜據此排除已離場者（分數仍留在帳本裡供匯出） */
const isPresent = (id) => stage.agents.has(id);
const nameOf = (id) => stage.get(id)?.name ?? '';

/** 主辦端的現況面板資料 */
function hostState() {
  return {
    agents: [...stage.agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      offline: a.offline,
      progress: missions.progressOf(a.id),
      connections: graph.degree(a.id),
      activeMs: Math.round(a.activeMs),
      score: scores.totalOf(a.id),
    })),
    mission: missions.state(stage.agents.size),
    graphEdges: graph.size,
    quiz: quiz.publicView(),
    quizReveal: quiz.revealView(),
    leaderboard: scores.leaderboard(SCORING.leaderboardSize, nameOf, isPresent),
  };
}

const pushHostState = () => blast(hosts, EV.HOST_STATE, hostState());

/**
 * 積分帳本的單一寫入點。
 *
 * 所有得分來源（配對、任務達標、問答）都走這裡，好處有兩個：
 * 個人端的 SCORE_SELF 不會漏送，而排行榜的重算與廣播只需標記一次髒旗標。
 */
let scoresDirty = false;

function award(agentId, points, meta) {
  if (points <= 0) return null;
  const { total, delta } = scores.award(agentId, points, meta);
  scoresDirty = true;
  markDirty();
  sendToAgent(agentId, EV.SCORE_SELF, {
    score: total,
    delta,
    source: meta.source,
    rank: scores.rankOf(agentId, isPresent),
  });
  return total;
}

/** 排行榜有變動時才重算並廣播，節流由主迴圈負責（scoresDirty 為髒旗標） */
function broadcastScoreBoard() {
  blast([...screens, ...hosts], EV.SCORE_BOARD, {
    leaderboard: scores.leaderboard(SCORING.leaderboardSize, nameOf, isPresent),
    players: stage.agents.size,
  });
}

/** 任務進度變動時，同步通知全場 */
function broadcastMissionState() {
  const state = missions.state(stage.agents.size);
  if (state) blastAll(EV.MISSION_STATE, { mission: state });
  pushHostState();
}

/** 顯示名稱驗證：長度限制並剝除控制字元，避免大螢幕排版被破壞 */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  // 逐字元過濾，避免在原始碼中嵌入字面控制字元
  const name = [...raw]
    .filter((ch) => { const c = ch.codePointAt(0); return c > 0x1f && c !== 0x7f; })
    .join('')
    .trim();
  if (name.length === 0) return null;
  return name.slice(0, MAX_NAME_LENGTH);
}

/** 取有限數值，非數值一律歸零，防止 NaN 汙染整個物理模擬 */
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const clamp01 = (n) => Math.max(0, Math.min(1, n));

function handleJoin(ws, msg) {
  // 一條連線只能綁定一個角色。
  // 初版未設此限，重複送出 CLIENT_JOIN 會不斷新建角色並覆寫 ws.agentId，
  // 舊角色因為沒有任何連線指向它，disconnectedAt 永遠是 null，
  // AGENT_TTL 也就永遠不會回收 —— 單一連線即可製造無限個永久幽靈。
  if (ws.agentId) {
    const existing = stage.get(ws.agentId);
    if (existing) {
      // 允許在同一連線內更新暱稱與造型，但不另建角色
      const rename = sanitizeName(msg.name);
      const restyle = validateAvatarConfig(msg.avatar ?? msg.avatarConfig);
      if (rename) existing.name = rename;
      if (restyle.ok) existing.avatar = restyle.value;
      stage.rosterDirty = true;
      send(ws, EV.CLIENT_WELCOME, {
        userId: existing.id,
        rejoinToken: existing.rejoinToken,
        name: existing.name,
        stage: STAGE,
      });
      return;
    }
    ws.agentId = null; // 角色已被回收，往下走正常入場流程
  }

  const name = sanitizeName(msg.name);
  if (!name) {
    send(ws, EV.CLIENT_REJECT, { reason: '顯示名稱不可為空' });
    return;
  }
  const avatar = validateAvatarConfig(msg.avatar ?? msg.avatarConfig);
  if (!avatar.ok) {
    send(ws, EV.CLIENT_REJECT, { reason: avatar.reason });
    return;
  }

  // 優先嘗試斷線重連。憑證不符或角色不存在都會回傳 null，兩者不可區分，
  // 因此無法用來探測某個 userId 是否存在於場上。
  let agent = typeof msg.userId === 'string'
    ? stage.reattach(msg.userId, msg.rejoinToken)
    : null;

  // 伺服器重開後場上是空的，reattach 一定失敗。此時改用身分目錄認領：
  // 憑證相符就以原本的 id 重建角色，積分與社交圖譜自動接回（見 state.claimAgent）。
  if (!agent && typeof msg.userId === 'string') {
    agent = stage.claimAgent(directory.get(msg.userId), msg.rejoinToken);
    if (agent) {
      agent.name = name;
      agent.avatar = avatar.value;
      console.log(`[claim] ${agent.name} (${agent.id}) 於重開後認領回原角色　${scores.totalOf(agent.id)} 分`);
    }
  }

  if (agent) {
    agent.name = name;
    agent.avatar = avatar.value;
  } else {
    agent = stage.addAgent({ name, avatar: avatar.value });
    if (!agent) {
      send(ws, EV.CLIENT_REJECT, { reason: '現場人數已滿，請稍候再試' });
      return;
    }
  }

  ws.role = 'controller';
  ws.agentId = agent.id;
  controllers.set(agent.id, ws);
  // 記進身分目錄，讓這個人在伺服器重開後還認得回自己的角色與分數
  directory.remember(agent);
  markDirty();

  // rejoinToken 只在此處單獨回傳給角色本人，不會出現在任何廣播訊息中
  send(ws, EV.CLIENT_WELCOME, {
    userId: agent.id,
    rejoinToken: agent.rejoinToken,
    name: agent.name,
    stage: STAGE,
  });

  // 補送目前的任務狀態與配對碼，讓中途進場的人立刻能參與
  send(ws, EV.PAIR_CODE, { code: pairing.register(agent.id) });
  if (missions.isActive) {
    send(ws, EV.MISSION_ANNOUNCE, {
      mission: missions.announcement(),
      progress: missions.progressOf(agent.id),
    });
  }
  // 問答進行中就補送題目。剩餘時間由伺服器算，所以晚到的人拿到的是
  // 真正剩下的秒數，而不是從頭開始的完整倒數。
  if (quiz.isActive) sendQuestion(ws);
  send(ws, EV.SCORE_SELF, {
    score: scores.totalOf(agent.id),
    delta: 0,
    source: null,
    rank: scores.rankOf(agent.id, isPresent),
  });
  pushHostState();
  console.log(`[join] ${agent.name} (${agent.id})　場上人數 ${stage.agents.size}`);
}

/**
 * 參與者離開場域時的共用清理。
 *
 * forget 用於「明確的離場」（主動退出、被主辦端移除）：
 * 連身分目錄裡的憑證一併撤銷，這個 userId 就再也認領不回來。
 * 沒有這一步，主動離場的人只要重送舊憑證就能接回原角色與積分，
 * 而「離場後重新進場是全新角色」是既有的設計承諾；
 * 被踢的人也會因此能自己走回來。
 *
 * 單純的斷線不走這裡（見 ws.on('close')）—— 那是網路瞬斷，
 * 憑證必須留著，否則就沒有重連可言。
 */
function detachAgent(agentId, { forget = false } = {}) {
  controllers.delete(agentId);
  pairing.release(agentId);
  if (forget) {
    directory.forget(agentId);
    markDirty();
  }
}

// ─────────────────────────────────────────────────────────────
// 配對任務處理
// ─────────────────────────────────────────────────────────────
function handlePairClaim(ws, msg) {
  if (!missions.isActive || missions.active.type !== 'PAIRING') {
    send(ws, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.NO_MISSION });
    return;
  }
  const result = pairing.claim(ws.agentId, msg.code, Date.now(),
    missions.active?.id ?? null);
  if (!result.ok) {
    send(ws, EV.PAIR_RESULT, { ok: false, reason: result.reason });
    return;
  }
  const me = stage.get(ws.agentId);
  // 推送確認請求給被指定的一方，附上發起人的外觀讓他能對照眼前的人
  sendToAgent(result.target, EV.PAIR_CONFIRM_REQ, {
    from: ws.agentId,
    name: me?.name ?? '',
    avatar: me?.avatar ?? null,
    expiresInMs: 30000,
  });
  send(ws, EV.PAIR_RESULT, { ok: true, pending: true, waitingFor: result.target });
}

function handlePairConfirm(ws, msg) {
  const result = pairing.confirm(ws.agentId, msg.accept === true);
  if (!result.ok) {
    send(ws, EV.PAIR_RESULT, { ok: false, reason: result.reason });
    if (result.from) {
      sendToAgent(result.from, EV.PAIR_RESULT, { ok: false, reason: result.reason });
    }
    return;
  }

  const a = stage.get(result.from);
  const b = stage.get(result.to);
  // 邀請發出後、確認送達前，主辦端可能已經結算舊任務並發布新的。
  // 那筆互動屬於舊任務，不該被算進新任務的進度。
  const sameMission = (missions.active?.id ?? null) === result.missionId;
  const creditA = sameMission ? missions.credit(result.from, { with: result.to }) : null;
  const creditB = sameMission ? missions.credit(result.to, { with: result.from }) : null;
  const target = missions.active?.target ?? 0;

  for (const [id, credit, partner] of [
    [result.from, creditA, b],
    [result.to, creditB, a],
  ]) {
    // 配對本身就給分。達標獎勵只在「剛好踏到目標次數」的那一次發，
    // 用 count === target 而不是 done —— done 在超過目標後每次都為真，
    // 拿它當條件會讓達標的人每多配對一次就再領一次獎勵。
    // 兩筆分數分開寫入帳本。合成一筆會讓配對的 20 分被記成 MISSION_DONE，
    // bySource 統計、得分流水與手機上的來源文案就全都算錯了。
    let total = scores.totalOf(id);
    let earned = 0;
    if (credit) {
      const ref = missions.active?.id ?? null;
      const detail = { with: partner?.id ?? null };
      earned = SCORING.pairCompletion;
      total = award(id, SCORING.pairCompletion, {
        source: SCORE_SOURCES.PAIR, ref, detail,
      });
      if (credit.count === target) {
        earned += SCORING.missionFinish;
        total = award(id, SCORING.missionFinish, {
          source: SCORE_SOURCES.MISSION_DONE, ref, detail,
        });
      }
    }

    sendToAgent(id, EV.PAIR_RESULT, {
      ok: true,
      partnerName: partner?.name ?? '',
      progress: credit?.count ?? 0,
      done: credit?.done ?? false,
      points: earned,
      score: total,
    });
  }

  // 第 05 步「回饋」不可省略：完成必須在共享畫布上被看見，
  // 否則任務退化成手機小遊戲，與打破個人螢幕封閉性的核心命題相悖
  blastAll(EV.MISSION_COMPLETE, {
    a: { id: result.from, name: a?.name ?? '' },
    b: { id: result.to, name: b?.name ?? '' },
    edgeCount: graph.size,
  });
  markDirty();
  broadcastMissionState();
  console.log(`[pair] ${a?.name} × ${b?.name}　社交圖譜 ${graph.size} 條連結`);
}

// ─────────────────────────────────────────────────────────────
// 即時問答
// ─────────────────────────────────────────────────────────────

/** 送出題目。remainingMs 於送出當下計算，中途進場的人也能接上正確的倒數。 */
function sendQuestion(target) {
  const view = quiz.publicView();
  if (!view) return;
  if (target) send(target, EV.QUIZ_QUESTION, { quiz: view });
  else blastAll(EV.QUIZ_QUESTION, { quiz: view });
}

/**
 * 公布正解、算分、推播結果。
 *
 * 分數要在「全部記完」之後才推個人結果 —— 名次是相對的，
 * 邊記邊推會讓先被處理到的人看到還沒算完的名次。
 */
function revealQuiz(now = Date.now()) {
  const result = quiz.reveal(now);
  if (!result) return;

  for (const a of result.awards) {
    if (a.points > 0) {
      award(a.agentId, a.points, {
        source: SCORE_SOURCES.QUIZ,
        ref: result.id,
        detail: { choice: a.choice, correct: a.correct, elapsedMs: a.elapsedMs },
      });
    }
  }

  const answered = new Set(result.awards.map((a) => a.agentId));
  for (const a of result.awards) {
    sendToAgent(a.agentId, EV.QUIZ_RESULT, {
      answered: true,
      correct: a.correct,
      correctIndex: result.correctIndex,
      choice: a.choice,
      points: a.points,
      score: scores.totalOf(a.agentId),
      rank: scores.rankOf(a.agentId, isPresent),
    });
  }
  // 沒作答的人也必須收到結果，否則手機會一直停在「等待公布」
  for (const id of controllers.keys()) {
    if (answered.has(id)) continue;
    sendToAgent(id, EV.QUIZ_RESULT, {
      answered: false,
      correct: false,
      correctIndex: result.correctIndex,
      choice: null,
      points: 0,
      score: scores.totalOf(id),
      rank: scores.rankOf(id, isPresent),
    });
  }

  blastAll(EV.QUIZ_REVEAL, {
    id: result.id,
    correctIndex: result.correctIndex,
    counts: result.counts,
    totalAnswers: result.totalAnswers,
    // 大螢幕據此讓答對者的角色擴散光環 —— 問答的結果必須回到共享畫布上，
    // 否則它就只是三十個人各自低頭玩手機（規格 v3.0 §3.1 第 05 步）
    correctIds: result.awards.filter((a) => a.correct).map((a) => a.agentId),
  });
  scoresDirty = true;
  markDirty();
  pushHostState();
  console.log(`[quiz] 公布正解　作答 ${result.totalAnswers} 人　答對 ${result.awards.filter((a) => a.correct).length} 人`);
}

/** 收題。未揭曉就收掉等同作廢，不計分。 */
function endQuiz() {
  const closed = quiz.end();
  if (!closed) return;
  blastAll(EV.QUIZ_ENDED, { id: closed.id });
  markDirty();
  pushHostState();
}

/** 作答人數變動後才廣播，節流由主迴圈負責 */
let quizTallyDirty = false;

function handleQuizAnswer(ws, msg) {
  const result = quiz.answer(ws.agentId, msg.choice);
  if (!result.ok) {
    send(ws, EV.QUIZ_ACK, { ok: false, reason: result.reason });
    return;
  }
  // 只回「已鎖定」，不回對錯 —— 倒數期間任何一位參與者都不該提前知道答案
  send(ws, EV.QUIZ_ACK, { ok: true, choice: result.choice });
  quizTallyDirty = true;
}

// ─────────────────────────────────────────────────────────────
// 主辦端處理
// ─────────────────────────────────────────────────────────────
function handleHostMessage(ws, msg) {
  switch (msg.type) {
    case EV.HOST_PUBLISH_MISSION: {
      const result = missions.publish({ type: msg.missionType, target: msg.target });
      if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
      console.log(`[mission] 發布「${result.mission.title}」目標 ${result.mission.target} 次`);
      markDirty();
      // 公告同時推送至手機與大螢幕
      for (const [id, sock] of controllers) {
        send(sock, EV.MISSION_ANNOUNCE, {
          mission: missions.announcement(),
          progress: missions.progressOf(id),
        });
      }
      blast(screens, EV.MISSION_ANNOUNCE, { mission: missions.announcement() });
      broadcastMissionState();
      break;
    }

    case EV.HOST_CLOSE_MISSION: {
      const closed = missions.close();
      if (!closed) return;
      console.log(`[mission] 結算「${closed.title}」`);
      markDirty();
      blastAll(EV.MISSION_CLOSED, {
        id: closed.id,
        title: closed.title,
        totalCompletions: closed.events.length,
        graphEdges: graph.size,
      });
      pushHostState();
      break;
    }

    case EV.HOST_START_QUIZ: {
      const result = quiz.start({
        question: msg.question,
        options: msg.options,
        correctIndex: msg.correctIndex,
        durationMs: msg.durationMs,
      });
      if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
      markDirty();
      console.log(`[quiz] 第 ${result.quiz.index} 題「${result.quiz.question}」${result.quiz.durationMs / 1000} 秒`);
      sendQuestion();
      pushHostState();
      break;
    }

    case EV.HOST_REVEAL_QUIZ:
      revealQuiz();
      break;

    case EV.HOST_END_QUIZ:
      endQuiz();
      break;

    case EV.HOST_KICK: {
      const target = stage.get(msg.agentId);
      if (!target) return;
      console.log(`[kick] 主辦端移除 ${target.name} (${target.id})`);
      const sock = controllers.get(target.id);
      detachAgent(target.id, { forget: true });
      stage.removeAgent(target.id);
      if (sock) {
        send(sock, EV.CLIENT_REJECT, { reason: '你已被主辦方請出現場' });
        sock.agentId = null;
        sock.role = null;
      }
      pushHostState();
      break;
    }
  }
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.agentId = null;
  ws.isAlive = true;
  ws.closing = false;
  ws.limiter = new RateLimiter(RATE_LIMIT, performance.now());
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // close() 只是開始關閉交握，已在緩衝區中的訊息仍會繼續觸發本事件。
    // 沒有這道防護，一次洪水攻擊會重複記錄數千筆 abuse 日誌。
    if (ws.closing) return;

    // 速率限制先於解析：JSON.parse 本身就是攻擊者可放大的成本
    const verdict = ws.limiter.check(performance.now());
    if (verdict === 'abuse') {
      ws.closing = true;
      console.warn(`[abuse] ${ws.agentId ?? '未登入連線'} 持續超出速率上限，已中斷`);
      ws.close(1008, 'rate limit exceeded');
      return;
    }
    if (verdict === 'drop') return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 格式錯誤直接忽略，不回應也不斷線
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case EV.CLIENT_JOIN:
        // SCREEN_HELLO / HOST_AUTH 的鏡像情況：大螢幕或主辦端連線若送出
        // CLIENT_JOIN，ws.role 會被改成 'controller'，關閉時
        // screens/hosts 的清理就不會執行，死掉的 socket 永遠留在集合裡。
        if (screens.has(ws) || hosts.has(ws)) break;
        handleJoin(ws, msg);
        break;

      case EV.SCREEN_HELLO:
        // 已綁定角色的連線不可改註冊為大螢幕。
        // 允許的話 ws.role 會變成 'screen'，但 controllers 映射沒清、
        // agent 也沒標記斷線；此連線關閉時只會走 screen 的清理分支，
        // 角色就永久留在場上。反覆操作即可耗盡 120 人上限，
        // 讓真正的參與者再也進不來。
        if (ws.agentId) break;
        ws.role = 'screen';
        screens.add(ws);
        send(ws, EV.STAGE_META, { stage: STAGE, fps: SYNC_FPS });
        send(ws, EV.STAGE_ROSTER, { agents: stage.roster() });
        // 投影機在活動中途被重開是常態，補送當下的問答與排行榜，
        // 大螢幕才不會停在空白畫面等下一題
        if (quiz.isActive) {
          sendQuestion(ws);
          const revealed = quiz.revealView();
          if (revealed) send(ws, EV.QUIZ_REVEAL, { ...revealed, correctIds: [] });
        }
        send(ws, EV.SCORE_BOARD, {
          leaderboard: scores.leaderboard(SCORING.leaderboardSize, nameOf, isPresent),
          players: stage.agents.size,
        });
        console.log(`[screen] 大螢幕已連線　共 ${screens.size} 台`);
        break;

      case EV.INPUT_MOVE: {
        if (ws.role !== 'controller') return;
        // 相容技術文件的兩種 payload 形狀：{vector,intensity} 與 {vx,vy}
        const vec = msg.vector ?? { x: msg.vx, y: msg.vy };
        const x = finite(vec.x);
        const y = finite(vec.y);
        // 未給 intensity 時，由向量長度推得（§3 協定表的 vx/vy 形式）
        const intensity = msg.intensity === undefined
          ? clamp01(Math.hypot(x, y))
          : clamp01(finite(msg.intensity));
        stage.applyMove(ws.agentId, { x, y, intensity });
        break;
      }

      case EV.INPUT_ACTION: {
        if (ws.role !== 'controller') return;
        if (!ACTIONS.includes(msg.action)) return; // 白名單外的動作直接丟棄
        stage.applyAction(ws.agentId, msg.action);
        break;
      }

      case EV.CLIENT_LEAVE: {
        if (ws.role !== 'controller' || !ws.agentId) return;
        // 主動退出與被動斷線不同：使用者已明確表達離開意圖，
        // 因此立即移除角色，而非讓它轉入 Boids 漫遊等待重連。
        console.log(`[leave] ${ws.agentId} 主動離場`);
        detachAgent(ws.agentId, { forget: true });
        stage.removeAgent(ws.agentId);
        ws.agentId = null;
        ws.role = null;
        pushHostState();
        break;
      }

      case EV.PAIR_CLAIM:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handlePairClaim(ws, msg);
        break;

      case EV.PAIR_CONFIRM:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handlePairConfirm(ws, msg);
        break;

      case EV.QUIZ_ANSWER:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleQuizAnswer(ws, msg);
        break;

      case EV.HOST_AUTH: {
        // 與 SCREEN_HELLO 同一個理由：已綁定角色的連線改註冊為主辦端後，
        // 關閉時只會走 hosts 的清理分支，agent 的 disconnectedAt 永遠是 null，
        // AGENT_TTL 不會回收它，人數上限就被永久佔用。
        if (ws.agentId) {
          send(ws, EV.HOST_REJECT, { reason: '已入場的裝置不能改登入主辦端' });
          return;
        }
        if (!keyMatches(msg.key)) {
          console.warn('[host] 通行密鑰錯誤，拒絕連線');
          send(ws, EV.HOST_REJECT, { reason: '通行密鑰錯誤' });
          return;
        }
        ws.role = 'host';
        hosts.add(ws);
        // 一併帶上計分規則：主辦端要能在畫面上說明「答對幾分、配對幾分」，
        // 而這些值只存在於伺服器的調校檔，不在共用的協定層
        send(ws, EV.HOST_WELCOME, {
          missionTypes: Object.values(MISSION_TYPES),
          scoring: SCORING,
        });
        send(ws, EV.HOST_STATE, hostState());
        console.log(`[host] 主辦端已連線　共 ${hosts.size} 台`);
        break;
      }

      case EV.HOST_PUBLISH_MISSION:
      case EV.HOST_CLOSE_MISSION:
      case EV.HOST_START_QUIZ:
      case EV.HOST_REVEAL_QUIZ:
      case EV.HOST_END_QUIZ:
      case EV.HOST_KICK:
        // 未通過認證的連線一律忽略，不回應也不透露任何狀態
        if (ws.role !== 'host') return;
        handleHostMessage(ws, msg);
        break;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'screen') {
      screens.delete(ws);
    } else if (ws.role === 'host') {
      hosts.delete(ws);
    } else if (ws.agentId) {
      // 不立即移除角色：讓它先無縫轉入 Boids 漫遊（§6 風險 1）。
      // 但要解除定向推送對映，否則會對著已關閉的 socket 送配對碼。
      controllers.delete(ws.agentId);
      stage.markDisconnected(ws.agentId);
      console.log(`[leave] ${ws.agentId} 斷線，轉入漫遊態`);
      pushHostState();
    }
  });
});

// 心跳偵測：手機息屏或離開 Wi-Fi 範圍時 TCP 常不會正常關閉，
// 沒有心跳就會留下永遠「在線」卻毫無輸入的殭屍連線。
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

// ─────────────────────────────────────────────────────────────
// 模擬主迴圈
// ─────────────────────────────────────────────────────────────
// 排程器對齊絕對截止時間，消除 setInterval 在 Windows 上的累積漂移
// （實測有效頻率由 27.3 Hz 修正為 30.0 Hz，詳見 scheduler.js）
let lastTallyAt = 0;
let lastScoreAt = 0;

const loop = startTicker({
  intervalMs: TICK_MS,
  onTick(dt) {
    // 傳入社交圖譜：配對過的角色之間凝聚力較強，關係會表現為畫面上的群聚
    stage.tick(dt, graph);

    // 配對碼輪換。舊碼在寬限期內仍有效，因此輪換不會打斷正在進行的交換。
    if (pairing.rotate()) {
      for (const [id, sock] of controllers) {
        send(sock, EV.PAIR_CODE, { code: pairing.codeOf(id) });
      }
    }

    // 逾時未回應的配對請求：兩邊都要收到結果，否則發起方會一直空等
    for (const p of pairing.sweep()) {
      sendToAgent(p.from, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.EXPIRED });
      sendToAgent(p.to, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.EXPIRED });
    }

    // 角色被 TTL 回收時一併釋放其配對碼，避免碼池累積失效項目
    if (stage.rosterDirty) {
      for (const id of [...pairing.codes.keys()]) {
        if (!stage.agents.has(id)) pairing.release(id);
      }
    }

    // 問答的時間推進由主迴圈負責，不用 setTimeout ——
    // 定時器在事件迴圈被拖慢時會延後觸發，而這裡的時間到必須與
    // 大螢幕上的倒數一致；主迴圈本來就對齊絕對截止時間（scheduler.js）。
    const now = Date.now();
    if (quiz.shouldAutoReveal(now)) revealQuiz(now);
    else if (quiz.shouldAutoEnd(now)) endQuiz();

    // 作答人數：只送給大螢幕與主辦端。參與者不需要知道，
    // 而倒數期間送給所有人等於每次有人按就廣播三十份。
    if (quizTallyDirty && now - lastTallyAt >= 250) {
      lastTallyAt = now;
      quizTallyDirty = false;
      blast([...screens, ...hosts], EV.QUIZ_TALLY, quiz.tally());
    }

    if (scoresDirty && now - lastScoreAt >= SCORING.broadcastMs) {
      lastScoreAt = now;
      scoresDirty = false;
      broadcastScoreBoard();
    }

    if (screens.size === 0) return;
    // 沒有大螢幕連線時不廣播，rosterDirty 保持為 true，待螢幕接上後補送

    if (stage.rosterDirty) {
      const roster = JSON.stringify({ type: EV.STAGE_ROSTER, agents: stage.roster() });
      for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(roster);
      stage.rosterDirty = false;
    }
    const sync = JSON.stringify({
      type: EV.STAGE_SYNC, agents: stage.snapshot(), t: Date.now(),
    });
    for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(sync);
  },
});

// 自動存檔。刻意不放進 30Hz 主迴圈：磁碟寫入是同步呼叫，
// 放在模擬迴圈裡會讓每次落地都推遲當幀的 STAGE_SYNC 廣播。
// 只有標記過髒旗標時才真的寫，閒置的場域不會空轉磨損磁碟。
const autosave = setInterval(() => {
  store.save(snapshotData());
}, PERSISTENCE.autosaveMs);

// 每分鐘回報實際模擬頻率，讓現場能即時發現時脈掉速
const monitor = setInterval(() => {
  const s = loop.stats();
  if (s.hz < 29 || s.resyncs > 0) {
    console.warn(`[tick] 實際 ${s.hz.toFixed(1)} Hz（目標 30）　重新對齊 ${s.resyncs} 次`);
  }
}, 60000);

// ─────────────────────────────────────────────────────────────
// 啟動
// ─────────────────────────────────────────────────────────────
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n  PersonaFlow Gateway 已啟動\n');
  console.log(`  大螢幕　  ${SCHEME}://localhost:${PORT}/screen/`);
  console.log(`  手機控制  ${SCHEME}://localhost:${PORT}/controller/`);
  console.log(`  主辦端　  ${SCHEME}://localhost:${PORT}/host/`);
  console.log(`\n  主辦端通行密鑰　${HOST_KEY}　（${HOST_KEY_SOURCE}）`);
  if (!PERSISTENCE.enabled) {
    console.log('  ⚠ 已關閉狀態存檔（PERSONAFLOW_PERSIST=0），重開後資料不保留');
  } else if (snapshot) {
    console.log(`  已接續上次的活動資料　${scores.standings().length} 人有積分`
      + `　社交連結 ${graph.size} 條　問答 ${quiz.asked} 題`);
  }
  // 啟動當下就先落地一次。自動存檔只在狀態有變動時才寫，
  // 但通行密鑰是「還沒有人做任何事」就已經需要保住的東西 ——
  // 沒有這一次寫入，開機後尚無人進場就當機的話，重開會換一組新密鑰，
  // 而主辦者手上那張寫著號碼的紙就作廢了。
  store.save(snapshotData(), { force: true });

  if (addrs.length) {
    console.log('\n  同一區網的手機請改用下列位址（現場請用這個做 QR Code）：');
    for (const a of addrs) console.log(`            ${SCHEME}://${a}:${PORT}/controller/`);
  }
  if (!tlsOptions) {
    console.log('\n  ⚠ 目前是 HTTP：手機在區網位址上無法使用相機，掃描進場會自動退回捏臉。');
    console.log('    要啟用掃描請先產生憑證：bash scripts/make-cert.sh');
  }
  console.log('');
});

const shutdown = () => {
  loop.stop();
  clearInterval(heartbeat);
  clearInterval(monitor);
  clearInterval(autosave);
  // 強制寫入最後一份快照。Ctrl+C 與活動結束的正常關閉都會走到這裡，
  // 因此正常收工不會掉最後幾秒的資料；只有整台機器斷電會退回上一次自動存檔。
  if (store.save(snapshotData(), { force: true })) {
    console.log(`\n  狀態已存檔　${store.file}`);
  }
  // 必須逐一 terminate：wss.close() 只停止接受新連線，不會結束既有連線，
  // 而 server.close() 會等所有連線結束才回呼 —— 大螢幕連著時，
  // 現場按 Ctrl+C 會像沒反應一樣一直卡住。
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close(() => process.exit(0));
  // 最後的保險：仍有殘留 handle 時不要讓收工的人卡在終端機前面。
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
