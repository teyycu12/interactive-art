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

import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';

import {
  EV, ACTIONS, STAGE, SYNC_FPS, PAIR_ERRORS, MISSION_TYPES,
  CLIENT_SYNC_MS, CLIENT_SYNC_RADIUS,
  SCORE_SOURCES,
} from '../shared/protocol.js';
import { validateAvatarConfig } from '../shared/avatars.js';
import { avatarMatchesFamily } from '../shared/colorFamily.js';
import {
  TICK_MS, MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, RATE_LIMIT, HOST_KEY_LENGTH, SCORING,
  PERSISTENCE, TREASURE,
} from './config.js';
import { Stage } from './state.js';
import { RateLimiter } from './ratelimit.js';
import { certificateReport } from './certcheck.js';
import { startTicker } from './scheduler.js';
import { MissionBoard } from './missions.js';
import { TreasureHunt } from './treasure.js';
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
const treasure = new TreasureHunt();
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
  '.webp': 'image/webp',
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
  if (urlPath === '/vendor/three.module.js') {
    return path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  }
  // three 的 addons 是整棵目錄樹：OrbitControls 等檔案會再 import 同目錄下的
  // 其他模組，逐檔白名單列不完，因此整個目錄開放。但也因為是目錄映射，
  // 這裡必須自己做穿越防護 —— 下方那套通用檢查只涵蓋 PUBLIC_DIR 與 shared。
  if (urlPath.startsWith('/vendor/three-addons/')) {
    if (urlPath.includes('\0')) return null;
    const addonsRoot = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
    const target = path.resolve(addonsRoot, urlPath.slice('/vendor/three-addons/'.length));
    if (target !== addonsRoot && !target.startsWith(addonsRoot + path.sep)) return null;
    return target;
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
// 用 || 而非 ??：?? 只接住 null/undefined，接不到空字串，
// 而 .env 裡留一行 VISION_PORT= 正是會產生空字串的寫法。
const VISION_HOST = process.env.VISION_HOST || '127.0.0.1';
const VISION_PORT = Number(process.env.VISION_PORT || 5055);

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

// 生成是整套系統唯一會花錢的路徑：每次要兩支 Gemini 加一次生圖。
// WebSocket 那端有 token bucket，這個 HTTP 端點原本什麼都沒有 ——
// 場館 Wi-Fi 上任何一台裝置寫個迴圈就能把 API 額度燒光，也會讓
// Python 服務的執行緒池被塞滿而排擠正在報到的人。
const GENERATE_RATE = { capacity: 3, refillPerSec: 1 / 30, violationLimit: Infinity };

/** 同時進行中的生成上限。Python 端每個請求要 4 個 worker（共 16 個）。 */
const MAX_CONCURRENT_GENERATES = 4;
let inFlightGenerates = 0;

/** @type {Map<string, {limiter: RateLimiter, seenAt: number}>} 依來源位址計費 */
const generateLimiters = new Map();
const LIMITER_TTL_MS = 10 * 60 * 1000;

/**
 * 取得該來源的限流器，並順手清掉久未出現的條目。
 * 少了清理，這個 Map 會隨著到訪過的位址無限成長 —— 修掉一個資源耗盡問題
 * 卻換來另一個並不划算。
 */
function limiterFor(ip, now) {
  if (generateLimiters.size > 256) {
    for (const [key, entry] of generateLimiters) {
      if (now - entry.seenAt > LIMITER_TTL_MS) generateLimiters.delete(key);
    }
  }
  let entry = generateLimiters.get(ip);
  if (!entry) {
    entry = { limiter: new RateLimiter(GENERATE_RATE, performance.now()), seenAt: now };
    generateLimiters.set(ip, entry);
  }
  entry.seenAt = now;
  return entry.limiter;
}

// ── 站位引導的代理 ──────────────────────────────────────────
//
// 預覽每秒會被打數次，不能沿用生成那條 3 次 / 30 秒的限流；但也不能沒有限流，
// 否則場館裡任何一台裝置寫個迴圈就能把 Python 端的執行緒池塞滿，排擠正在
// 報到的人。預覽只跑 CV、不呼叫任何付費 API，因此額度可以放寬得多。
const PREVIEW_RATE = { capacity: 12, refillPerSec: 8, violationLimit: Infinity };

/** 預覽影格是縮圖，不該有生成那種數 MB 的尺寸 */
const MAX_PREVIEW_BYTES = 1024 * 1024;

/** 預覽逾時要短：慢到這個程度的引導已經沒有意義，不如讓下一幀補上 */
const PREVIEW_TIMEOUT_MS = 4000;

/** 同時進行中的預覽上限。超過就直接丟棄，引導少一幀不影響體驗 */
const MAX_CONCURRENT_PREVIEWS = 6;
let inFlightPreviews = 0;

/** @type {Map<string, {limiter: RateLimiter, seenAt: number}>} 預覽獨立計費 */
const previewLimiters = new Map();

function previewLimiterFor(ip, now) {
  if (previewLimiters.size > 256) {
    for (const [key, entry] of previewLimiters) {
      if (now - entry.seenAt > LIMITER_TTL_MS) previewLimiters.delete(key);
    }
  }
  let entry = previewLimiters.get(ip);
  if (!entry) {
    entry = { limiter: new RateLimiter(PREVIEW_RATE, performance.now()), seenAt: now };
    previewLimiters.set(ip, entry);
  }
  entry.seenAt = now;
  return entry.limiter;
}

function proxyPreview(req, res) {
  if (req.method !== 'POST') {
    sendJSON(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  // 引導丟一幀沒有代價，下一幀就補上了 —— 因此逾量、滿載、逾時一律安靜丟棄，
  // 不回降級外觀（那是生成才需要的東西）。
  if (previewLimiterFor(ip, Date.now()).check() !== 'ok') {
    sendJSON(res, 200, { ok: false, error: 'rate_limited' });
    return;
  }
  if (inFlightPreviews >= MAX_CONCURRENT_PREVIEWS) {
    sendJSON(res, 200, { ok: false, error: 'too_busy' });
    return;
  }

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_PREVIEW_BYTES) {
      aborted = true;
      sendJSON(res, 413, { ok: false, error: 'frame_too_large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    inFlightPreviews += 1;
    let settled = false;
    const release = () => { if (settled) return; settled = true; inFlightPreviews -= 1; };

    const upstream = http.request({
      host: VISION_HOST, port: VISION_PORT, path: '/preview', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: PREVIEW_TIMEOUT_MS,
    }, (up) => {
      const out = [];
      up.on('data', (c) => out.push(c));
      up.on('end', () => {
        release();
        res.writeHead(up.statusCode ?? 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(Buffer.concat(out));
      });
    });

    const degrade = (error) => {
      release();
      if (res.headersSent) return;
      sendJSON(res, 200, { ok: false, error });
    };
    upstream.on('timeout', () => { upstream.destroy(); degrade('preview_timeout'); });
    upstream.on('error', () => degrade('vision_service_unavailable'));
    res.on('close', release);
    upstream.end(body);
  });
}

// 風格清單。手機端的選單不寫死，否則某個風格的參考圖集沒放進去時，
// 選項照樣出現在畫面上，選了就靜默退回預設 —— 參與者只會覺得沒作用。
let stylesCache = null;
let stylesCacheAt = 0;
const STYLES_TTL_MS = 60_000;

function proxyStyles(req, res) {
  if (req.method !== 'GET') {
    sendJSON(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  if (stylesCache && Date.now() - stylesCacheAt < STYLES_TTL_MS) {
    sendJSON(res, 200, stylesCache);
    return;
  }

  const upstream = http.request({
    host: VISION_HOST,
    port: VISION_PORT,
    path: '/health',
    method: 'GET',
    timeout: 3000,
  }, (up) => {
    const out = [];
    up.on('data', (c) => out.push(c));
    up.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(out).toString('utf8')); } catch { /* 見下 */ }
      const payload = {
        ok: true,
        styles: Array.isArray(body?.styles) ? body.styles : [],
        defaultStyle: typeof body?.default_style === 'string' ? body.default_style : null,
      };
      stylesCache = payload;
      stylesCacheAt = Date.now();
      sendJSON(res, 200, payload);
    });
  });

  // 生成服務還沒起來時**不要快取空清單** —— 佈場時先開手機、後開生成服務
  // 是常態，快取下去就要等 TTL 過了選單才會出現。
  const degrade = () => {
    if (!res.headersSent) sendJSON(res, 200, { ok: false, styles: [], defaultStyle: null });
  };
  upstream.on('timeout', () => { upstream.destroy(); degrade(); });
  upstream.on('error', degrade);
  upstream.end();
}

// ── 主辦端生成歷史代理 ──────────────────────────────────────
//
// 原始照片、生成結果、token、花費、使用模型都已經由生成服務記在
// backend/logs/generation_history.sqlite3，這裡只是開一條讀取路徑給主辦端
// 控制台。資料含參與者照片與花費，比一般靜態頁面敏感，因此比照 HOST_AUTH
// 的理由（同一區網、路徑可被掃出，不能只靠「網址沒人知道」）比對通行密鑰，
// 而不是直接開放讀取。
const HISTORY_TIMEOUT_MS = 8000;

function proxyHostHistory(req, res, upstreamPath, isBinary) {
  const upstream = http.request({
    host: VISION_HOST, port: VISION_PORT, path: upstreamPath, method: 'GET',
    timeout: HISTORY_TIMEOUT_MS,
  }, (up) => {
    if (isBinary) {
      res.writeHead(up.statusCode ?? 200, {
        'Content-Type': up.headers['content-type'] ?? 'application/octet-stream',
      });
      up.pipe(res);
      return;
    }
    const out = [];
    up.on('data', (c) => out.push(c));
    up.on('end', () => {
      res.writeHead(up.statusCode ?? 200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(Buffer.concat(out));
    });
  });

  const degrade = () => {
    if (res.headersSent) return;
    if (isBinary) { res.writeHead(502).end(); return; }
    sendJSON(res, 200, { ok: false, error: 'vision_service_unavailable' });
  };
  upstream.on('timeout', () => { upstream.destroy(); degrade(); });
  upstream.on('error', degrade);
  upstream.end();
}

/** 落地檔名一律是 generation_history 自己 sanitize 過的 [A-Za-z0-9_.-]，見這裡防禦性再擋一次 */
const SAFE_FILENAME = /^[A-Za-z0-9_.-]+$/;
/** request_id 是 uuid4().hex，只會有小寫十六進位 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

function handleHostHistory(req, res, urlPath, searchParams) {
  if (req.method !== 'GET') {
    sendJSON(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!keyMatches(searchParams.get('key'))) {
    sendJSON(res, 403, { ok: false, error: 'invalid_key' });
    return;
  }

  const suffix = urlPath.slice('/api/host/history'.length);
  if (suffix === '' || suffix === '/') {
    const limit = searchParams.get('limit');
    const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    proxyHostHistory(req, res, `/api/dev/generations${qs}`, false);
    return;
  }
  if (suffix === '/summary') {
    proxyHostHistory(req, res, '/api/dev/summary', false);
    return;
  }
  if (suffix.startsWith('/outputs/')) {
    const filename = suffix.slice('/outputs/'.length);
    if (!SAFE_FILENAME.test(filename)) { res.writeHead(400).end('Bad Request'); return; }
    proxyHostHistory(req, res, `/api/dev/outputs/${filename}`, true);
    return;
  }
  if (suffix.startsWith('/inputs/')) {
    const filename = suffix.slice('/inputs/'.length);
    if (!SAFE_FILENAME.test(filename)) { res.writeHead(400).end('Bad Request'); return; }
    proxyHostHistory(req, res, `/api/dev/inputs/${filename}`, true);
    return;
  }
  const requestId = suffix.slice(1);
  if (!SAFE_REQUEST_ID.test(requestId)) { res.writeHead(400).end('Bad Request'); return; }
  proxyHostHistory(req, res, `/api/dev/generations/${requestId}`, false);
}

function proxyGenerate(req, res) {
  if (req.method !== 'POST') {
    sendJSON(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  // 逾量與滿載都回降級結果而非 429/503：對手機端而言這兩種情況與
  // 「生成失敗」沒有差別，都應該安靜地退回捏臉，不是彈出錯誤。
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (limiterFor(ip, Date.now()).check() !== 'ok') {
    sendJSON(res, 200, { ok: false, error: 'rate_limited', fallbackColors: DEFAULT_FALLBACK_COLORS });
    return;
  }
  if (inFlightGenerates >= MAX_CONCURRENT_GENERATES) {
    sendJSON(res, 200, { ok: false, error: 'too_busy', fallbackColors: DEFAULT_FALLBACK_COLORS });
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

    inFlightGenerates += 1;
    let settled = false;
    const release = () => {
      if (settled) return;   // 成功、逾時、錯誤只能還一次計數
      settled = true;
      inFlightGenerates -= 1;
    };

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
        release();
        res.writeHead(up.statusCode ?? 200, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(Buffer.concat(out));
      });
    });

    // 生成服務沒開或逾時，都回降級結果讓參與者仍能進場（整合計畫 §3.5）
    const degrade = (error) => {
      release();
      if (res.headersSent) return;
      sendJSON(res, 200, { ok: false, error, fallbackColors: DEFAULT_FALLBACK_COLORS });
    };
    upstream.on('timeout', () => { upstream.destroy(); degrade('generation_timeout'); });
    upstream.on('error', () => degrade('vision_service_unavailable'));
    // 手機在生成途中關掉分頁時 upstream 不一定會收到 error，
    // 沒有這一條，名額會被這類中斷請求一個個吃掉直到永遠滿載。
    res.on('close', release);

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

/**
 * 憑證健檢：SAN 是否涵蓋當下的 LAN IP，以及是否過期。
 *
 * 為什麼需要：憑證是按「產生當下的 IP」簽發的，而區網 IP 多半由 DHCP 配發，
 * 筆電重連 Wi-Fi 或隔天再來就可能換號。憑證一旦與實際位址不符，
 * 手機上會多跳一個「網域不符」的錯誤 —— 而現場只會看到「掃不進來」，
 * 完全看不出跟 IP 有關。這種故障必須在啟動時就講清楚，不能等到現場。
 *
 * 只警告、不阻擋啟動：憑證不符仍然可以用（使用者點過警告即可），
 * 而展演進行到一半時，「能跑但有警告」永遠優於「直接不給啟動」。
 *
 * @returns {{expired: boolean, daysLeft: number, missing: string[]}|null}
 */
function inspectCertificate(addrs) {
  if (!tlsOptions) return null;
  try {
    const cert = new X509Certificate(tlsOptions.cert);
    return certificateReport(cert.subjectAltName, cert.validTo, addrs);
  } catch {
    // 憑證讀得到但解析不了：不是啟動的阻礙，交由 TLS 層自己去報錯
    return null;
  }
}

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

  // 大螢幕上傳合照底圖。走 HTTP 而非 WebSocket：一張 1080p 截圖遠大於
  // MAX_MESSAGE_BYTES(4KB)，而那個上限是擋惡意客戶端灌爆記憶體用的，
  // 不該為了單一功能對所有連線放寬。
  if (urlPath === '/api/screen-capture' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_PHOTO_BYTES) {
        aborted = true;
        sendJSON(res, 413, { ok: false, error: 'capture_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { sendJSON(res, 400, { ok: false, error: 'bad_json' }); return; }

      const pending = pendingCaptures.get(msg?.requestId);
      // requestId 認不得就丟掉：它是伺服器剛剛才發出去的隨機值，
      // 猜不中等於這不是我們要的那張截圖。
      if (!pending) { sendJSON(res, 200, { ok: false, error: 'unknown_request' }); return; }
      pendingCaptures.delete(msg.requestId);
      clearTimeout(pending.timer);
      pending.resolve(typeof msg.image === 'string' ? msg.image : null);
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (urlPath === '/api/generate') {
    proxyGenerate(req, res);
    return;
  }

  if (urlPath === '/api/preview') {
    proxyPreview(req, res);
    return;
  }

  if (urlPath === '/api/styles') {
    proxyStyles(req, res);
    return;
  }

  if (urlPath === '/api/host/history' || urlPath.startsWith('/api/host/history/')) {
    handleHostHistory(req, res, urlPath, new URL(req.url, 'http://localhost').searchParams);
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
/**
 * 送出手機端名冊給單一連線。
 *
 * 進場與重連都必須送 —— 主迴圈那份是「內容變了才廣播」，
 * 而新連上的手機碰到的常常正是「名冊沒變」的情況（例如重整分頁、
 * 或斷線後在 AGENT_TTL 內接回原角色）。少了這裡，那支手機的
 * renderer.names 會一直是空的，鄰居全部沒有名字直到有人進出為止。
 */
function sendClientRoster(ws) {
  send(ws, EV.CLIENT_ROSTER, { agents: stage.nameRoster() });
}

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
      // 主辦端要能認出「這一列是誰」—— 名字是自填的，現場常常重複或看不懂，
      // 頭像才是參與者在大螢幕上實際的樣子。CV 角色只帶 URL，捏臉只帶 token，
      // 兩者都很小，不會讓這份狀態訊息膨脹。
      avatar: a.avatar,
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

/**
 * 補送進行中的尋寶給單一連線（中途進場與斷線重連都要）。
 *
 * ⚠ 送的是 publicView（不含座標）—— 補送給手機的東西一樣不能夾帶答案。
 */
function sendTreasureCatchUp(ws, agentId) {
  if (!treasure.isActive) return;
  send(ws, EV.TREASURE_START, { round: treasure.publicView() });
  // 回來的若正好是先知，強制下一幀重送冷熱：否則要等到等級**變動**
  // 才收得到，而隊伍恰好停在原地時那可以是好幾十秒。
  if (agentId === treasure.round.prophetId) treasure.resendHeat();
}

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
      // 重連的人可能已經累積了社交連結（邊是既成事實，不隨斷線消失）
      sendSocialSelf(existing.id);
      sendClientRoster(ws);
      // 尋寶進行中就補送。這個分支會 return，走不到下面正常入場的補送 ——
      // 少了這裡，瞬斷重連的先知會在剩下的整輪裡看著一片空白，
      // 而他正是所有人都在等著聽他喊話的那一個。
      sendTreasureCatchUp(ws, existing.id);
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

  sendClientRoster(ws);

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
  // 尋寶同理：中途進場的人若什麼都沒收到，會在其他人都在跑的時候
  // 盯著一片空白的畫面。⚠ 送的是 publicView（不含座標）——
  // 補送給手機的東西一樣不能夾帶答案。
  sendTreasureCatchUp(ws, agent.id);
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
/** 走配對流程的任務型別。COLOR_HUNT 只是多一道顏色條件，驗證模型與 PAIRING 相同 */
const PAIR_MISSION_TYPES = new Set(['PAIRING', 'COLOR_HUNT']);

function handlePairClaim(ws, msg) {
  if (!missions.isActive || !PAIR_MISSION_TYPES.has(missions.active.type)) {
    send(ws, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.NO_MISSION });
    return;
  }

  // 顏色條件在「提交碼」這一步就擋下，而不是等對方確認 ——
  // 讓 A 白等 30 秒才被告知「他不是紅色的」是很差的體驗，
  // 而且會佔用雙方的 pending 名額。
  //
  // ⚠ 這條路徑必須自己處理冷卻（peekTarget 不含冷卻，見該方法的說明）：
  //   直接 return 而不記冷卻的話，攻擊者可從 COLOR_MISMATCH ↔ NOT_FOUND
  //   的差異無限次試碼，把 claim() 的防枚舉冷卻整套繞過去。
  if (missions.active.colorFamily) {
    if (pairing.inCooldown(ws.agentId)) {
      send(ws, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.COOLDOWN });
      return;
    }
    const targetAgent = stage.get(pairing.peekTarget(msg.code));
    if (targetAgent && !avatarMatchesFamily(targetAgent.avatar, missions.active.colorFamily)) {
      // 顏色不符是正當使用者會遇到的情況（走向了不對的人），
      // 因此刻意不記冷卻 —— 讓他能馬上改找正確的人。
      send(ws, EV.PAIR_RESULT, {
        ok: false,
        reason: PAIR_ERRORS.COLOR_MISMATCH,
        colorFamily: missions.active.colorFamily,
      });
      return;
    }
    // 沒有命中「顏色不符」的情況（查無此碼、或對方符合條件）一律記冷卻，
    // 使這條預檢路徑的成本與正常的 claim() 相同
    if (!targetAgent) pairing.noteClaim(ws.agentId);
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
  // 大螢幕的連線圖要重畫
  linksDirty = true;
  // 雙方各自看到「我認識了誰」—— 手機端在進場後除了搖桿與分數之外
  // 看不到任何社交狀態，但那正是這場活動真正在累積的東西。
  sendSocialSelf(result.from);
  sendSocialSelf(result.to);
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
      const result = missions.publish({
        type: msg.missionType,
        target: msg.target,
        colorFamily: msg.colorFamily ?? null,
      });
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

    case EV.HOST_START_TREASURE: {
      const result = treasure.start([...stage.agents.keys()], {
        prophetId: msg.prophetId ?? null,
      });
      if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
      const view = treasure.publicView();
      console.log(`[treasure] 開始，先知＝${nameOf(view.prophetId)}`);
      // 公開狀態不含座標（見 treasure.js 的 publicView 說明）。
      // 大螢幕與主辦端另外收到座標，因為它們是「公開的畫面」，
      // 不在參與者手上 —— 大螢幕要畫出寶箱，主辦端要知道自己藏了哪。
      blast(controllers.values(), EV.TREASURE_START, { round: view });
      blast([...screens, ...hosts], EV.TREASURE_START, {
        round: view, spot: treasure.spot(),
      });
      pushHostState();
      break;
    }

    case EV.HOST_STOP_TREASURE: {
      const r = treasure.stop();
      if (!r) return;
      console.log('[treasure] 本輪中止');
      // ⚠ 中止不公布座標。沒有人找到，那個點就還是秘密 ——
      //   主辦端可能馬上重開一輪（甚至同一個點），先講出來等於直接送答案。
      //   只有 TREASURE_FOUND 才公布，因為那時本輪已經真的結束了。
      //   大螢幕與主辦端另外收到座標：它們是公開畫面，不在參與者手上。
      blast(controllers.values(), EV.TREASURE_ENDED, { id: r.id });
      blast([...screens, ...hosts], EV.TREASURE_ENDED, {
        id: r.id, spot: { x: r.x, y: r.y },
      });
      pushHostState();
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

    case EV.HOST_TAKE_PHOTO:
      // 刻意不 await：合照要等角色就定位，await 會讓這條 WebSocket 的
      // 訊息處理停擺數秒，期間主辦端的其他操作全部沒有回應。
      takeGroupPhoto(ws);
      break;

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
        // 連線圖是累積了整場的資料，投影機中途重開必須補送，
        // 否則大螢幕會停在「一條線都沒有」的狀態直到下一次配對
        send(ws, EV.STAGE_LINKS, { edges: graphEdges() });
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
      case EV.HOST_START_TREASURE:
      case EV.HOST_STOP_TREASURE:
      case EV.HOST_START_QUIZ:
      case EV.HOST_REVEAL_QUIZ:
      case EV.HOST_END_QUIZ:
      case EV.HOST_KICK:
      case EV.HOST_TAKE_PHOTO:
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
/** CLIENT_SYNC 的節流基準。主迴圈是 30Hz，個人視角只需 15Hz。 */
let lastClientSyncAt = 0;
/** 手機名冊待重送。與 stage.rosterDirty 分開，理由見主迴圈內的說明。 */
let clientRosterDirty = false;
/** 上次送給手機的名冊內容指紋，用來判斷是否真的變了 */
let lastClientRosterSig = '';

const loop = startTicker({
  intervalMs: TICK_MS,
  onTick(dt) {
    // 傳入社交圖譜：配對過的角色之間凝聚力較強，關係會表現為畫面上的群聚
    const zoneMoves = stage.tick(dt, graph);

    // 分區進出。只在換區時送，不是每幀 ——
    // 每幀回報所在分區的話，30Hz × 10 人是每秒 300 則重複訊息。
    //
    // ⚠ 與 CLIENT_SYNC 同樣放在 `screens.size === 0` 早退之前，
    //   否則投影機還沒接上時手機完全收不到分區提示。
    if (zoneMoves.length) {
      for (const mv of zoneMoves) {
        sendToAgent(mv.id, EV.ZONE_SELF, { from: mv.from, to: mv.to });
      }
      // 大螢幕與主辦端要的是「哪一區現在有幾人」，不是逐筆進出
      blast([...screens, ...hosts], EV.ZONE_STATE, {
        zones: stage.zoneOccupancy(),
      });
    }

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

    // 手機端的名冊（id → 名字）。與 CLIENT_SYNC 分開送：
    // 名字是靜態資料，隨 15Hz 的座標重送等於每秒多耗十幾 KB 的重複字串。
    //
    // 觸發沿用 stage.rosterDirty（state.js 的五個變動點已統一維護它，
    // 另設一份鏡射旗標只要漏掉一處，手機名冊就會默默過期）。
    //
    // 但**不能**只寫 `if (stage.rosterDirty) clientRosterDirty = true`：
    // stage.rosterDirty 要等下面大螢幕那段才清除，而那段在
    // `screens.size === 0` 早退之後 —— 沒有大螢幕連線時它會一直是 true，
    // 於是每一幀都重新舉旗，名冊變成 30Hz 廣播（實測 2 秒送了 60 次）。
    // 因此改為比對「上次送出的名冊內容」，與大螢幕的清除時機完全脫鉤。
    const rosterSig = stage.agents.size
      ? `${stage.agents.size}:${[...stage.agents.values()].map((a) => `${a.id}~${a.name}`).join('|')}`
      : '';
    if (rosterSig !== lastClientRosterSig) clientRosterDirty = true;
    if (controllers.size && clientRosterDirty) {
      clientRosterDirty = false;
      lastClientRosterSig = rosterSig;
      const payload = JSON.stringify({
        type: EV.CLIENT_ROSTER, agents: stage.nameRoster(),
      });
      for (const sock of controllers.values()) {
        if (sock.readyState === sock.OPEN) sock.send(payload);
      }
    }

    // 手機端個人視角（15Hz）。
    //
    // 必須放在下面那道 `screens.size === 0` 早退之前 ——
    // 放在後面的話，大螢幕沒連上時所有手機的畫面會整個凍結，
    // 而這正是佈場與除錯時最常見的狀態（先開手機、投影機還沒接）。
    // 半個 tick 的容差：主迴圈是 30Hz（33.3ms），若頻率不整除 tick，
    // 嚴格比較會讓某些格子差零點幾毫秒被擋下，實際頻率掉一整格
    // （10Hz 曾因此實測只有 7.5Hz）。15Hz 整除 30，這裡是雙重保險。
    if (controllers.size && now - lastClientSyncAt >= CLIENT_SYNC_MS - TICK_MS / 2) {
      lastClientSyncAt = now;
      for (const [id, sock] of controllers) {
        if (sock.readyState !== sock.OPEN) continue;
        const view = stage.personalSnapshot(id, CLIENT_SYNC_RADIUS);
        // 角色可能已被 TTL 回收，但連線還在（下一次 CLIENT_JOIN 會重建）
        if (view) send(sock, EV.CLIENT_SYNC, view);
      }
    }

    // 尋寶：冷熱推播與踩中判定。
    //
    // 與 CLIENT_SYNC 同樣必須放在下面那道 `screens.size === 0` 早退**之前** ——
    // 放在後面的話，投影機還沒接上時整場尋寶會完全沒有反應，
    // 而先知會以為是自己的手機壞了。
    // 先確認本輪還成立：先知離場、或除了先知沒有別人時，
    // 這一輪已經永遠不可能結束（見 treasure.js 的 viability 說明）。
    //
    // ⚠ 不能在這裡 return —— 下面還有大螢幕的整段廣播，
    //   提早跳出會讓投影畫面停一幀。改以旗標往下讓它自然跳過。
    if (treasure.isActive) {
      const viable = treasure.viability(stage.agents);
      if (!viable.ok) {
        const r = treasure.stop();
        console.log(`[treasure] 本輪中止：${viable.reason}`);
        // 同上：中止不對手機公布座標
        blast(controllers.values(), EV.TREASURE_ENDED, {
          id: r.id, reason: viable.reason,
        });
        blast([...screens, ...hosts], EV.TREASURE_ENDED, {
          id: r.id, reason: viable.reason, spot: { x: r.x, y: r.y },
        });
        pushHostState();
      }
    }

    if (treasure.isActive) {
      const found = treasure.check(stage.agents);
      if (found) {
        const r = treasure.round;
        const name = nameOf(found.id);
        console.log(`[treasure] ${name} 找到寶藏`);
        // 找到之後座標才公布 —— 在那之前它是本輪唯一的秘密
        blastAll(EV.TREASURE_FOUND, {
          id: r.id,
          by: found.id,
          byName: name,
          prophetId: r.prophetId,
          prophetName: nameOf(r.prophetId),
          spot: { x: r.x, y: r.y },
          points: TREASURE.points,
        });
        if (TREASURE.points > 0) {
          award(found.id, TREASURE.points, { source: SCORE_SOURCES.TREASURE });
        }
        treasure.stop();
        pushHostState();
      } else {
        // 冷熱只送先知一個人。這是整個玩法的核心：
        // 送給所有人就退化成普通尋寶，沒有人需要開口講話。
        const heat = treasure.heatFor(stage.agents);
        // 只在等級變動時推送，而非每幀 —— 先知要的是「變熱了」這個事件，
        // 每幀重送同一個字只是白白佔用現場頻寬。
        if (heat && heat.changed) {
          sendToAgent(treasure.round.prophetId, EV.TREASURE_HEAT, { heat: heat.heat });
          blast([...screens, ...hosts], EV.TREASURE_HEAT, { heat: heat.heat });
        }
      }
    }

    if (screens.size === 0) return;
    // 沒有大螢幕連線時不廣播，rosterDirty 保持為 true，待螢幕接上後補送

    if (stage.rosterDirty) {
      const roster = JSON.stringify({ type: EV.STAGE_ROSTER, agents: stage.roster() });
      for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(roster);
      stage.rosterDirty = false;
    }
    // 社交圖譜與名冊一樣走「變動才送」，不塞進 30Hz 的 sync ——
    // 邊只在有人配對成功時增加，每幀重送整張圖是純粹的浪費。
    if (linksDirty) {
      const links = JSON.stringify({ type: EV.STAGE_LINKS, edges: graphEdges() });
      for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(links);
      linksDirty = false;
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
    console.log('\n  手機必須與這台電腦連在同一個 Wi-Fi —— 上面是私有位址，'
      + '手機用行動網路或別的網路都連不到。');
  }
  if (!tlsOptions) {
    console.log('\n  ⚠ 目前是 HTTP：手機在區網位址上無法使用相機，掃描進場會自動退回捏臉。');
    console.log('    要啟用掃描請先產生憑證：bash scripts/make-cert.sh');
  } else {
    const cert = inspectCertificate(addrs);
    if (cert?.expired) {
      // daysLeft 可能是 NaN（到期時間解析不出來），此時不報天數
      console.log(Number.isFinite(cert.daysLeft)
        ? `\n  ⚠ 憑證已於 ${-cert.daysLeft} 天前過期，手機會擋下連線。`
        : '\n  ⚠ 讀不出憑證的到期時間，無法確認是否仍然有效。');
      console.log('    請重新產生：bash scripts/make-cert.sh');
    } else if (cert && cert.daysLeft <= 14) {
      console.log(`\n  ⚠ 憑證再 ${cert.daysLeft} 天到期，建議在展演前重新產生。`);
    }
    if (cert?.missing.length) {
      // 這是最容易在現場才爆炸的一種：位址看起來正常、服務也活著，
      // 只有手機端會說憑證有問題，而錯誤訊息完全不提 IP。
      console.log(`\n  ⚠ 憑證不涵蓋目前的區網位址：${cert.missing.join('、')}`);
      console.log('    IP 多半是 DHCP 配發的，換過網路或重開機就會變。');
      console.log('    手機會多跳一個「網域不符」錯誤，請重新產生：bash scripts/make-cert.sh');
    }
  }
  console.log('');
});

// ── 大合照（M6）─────────────────────────────────────────────
//
// 流程：鎖定場域把角色定住並全部面向鏡頭 → 輪詢到位 → 帶著場上座標
// 呼叫生成服務合成 → 解除鎖定。
//
// 排版採角色的實際座標而非重排隊形：這件作品要記錄的是集體共創的
// 當下樣貌，誰跟誰聚在一起正是重點，排整齊會把那個訊息抹掉。
// 因此 lockStage() 這裡的用途是「原地定住並轉向鏡頭」，不是排隊形。
const PHOTO_TIMEOUT_MS = 60000;   // 合成含外部圖床上傳，比生成寬鬆
const PHOTO_SETTLE_MS = 12000;    // 等到位的上限；逾時就照現況拍，不卡住現場
const PHOTO_POLL_MS = 200;
let photoInFlight = false;

/** 面向鏡頭（畫面下方＝觀眾席）的朝向角 */
const FACING_CAMERA = Math.PI / 2;

// 大螢幕交回的截圖暫存區：requestId → { resolve, timer }
// 只在一次合照流程中短暫存在，用完即刪。
const pendingCaptures = new Map();
const CAPTURE_TIMEOUT_MS = 8000;

/**
 * 向大螢幕要一張當下畫面。
 *
 * 為什麼是「跟大螢幕要」而不是伺服器自己畫：3D 房間跑在瀏覽器的 WebGL 上，
 * 伺服器端沒有等價的渲染路徑。要在 Node 端重畫一次，等於把 RoomScene、
 * 光照、GLTF 載入與角色貼圖疊合全部再實作一遍 —— 而且兩份必然會漂移，
 * 合照裡的場景會跟觀眾前一秒看到的不一樣（arbiter.js 的註解警告過同一件事）。
 *
 * 沒有大螢幕連線時回 null，呼叫端會退回 Python 端的舞台底圖。
 */
const requestScreenCapture = () => new Promise((resolve) => {
  const screen = [...screens].find((ws) => ws.readyState === ws.OPEN);
  if (!screen) { resolve(null); return; }

  const requestId = randomBytes(8).toString('hex');
  const timer = setTimeout(() => {
    pendingCaptures.delete(requestId);
    resolve(null);          // 逾時就用沒有底圖的版本，不要卡住現場
  }, CAPTURE_TIMEOUT_MS);

  pendingCaptures.set(requestId, { resolve, timer });
  send(screen, EV.SCREEN_CAPTURE_REQ, { requestId });
});

/**
 * 社交圖譜的邊，供大螢幕繪製連線。
 *
 * 只帶 id：姓名已經在名冊裡，重複送會讓訊息無謂變大；
 * `at` 讓前端能把剛建立的邊畫得亮一些，隨時間淡成常駐細線。
 */
const graphEdges = () => graph.export().edges.map((e) => ({ a: e.a, b: e.b, at: e.at }));

/** 圖譜有變動、待廣播。與 stage.rosterDirty 同樣的節流策略 */
let linksDirty = true;

/** 推送「我認識了誰」給單一參與者。帶對方姓名，手機端才顯示得出來。 */
function sendSocialSelf(agentId) {
  const ids = [...graph.neighbors(agentId)];
  sendToAgent(agentId, EV.SOCIAL_SELF, {
    count: ids.length,
    peers: ids.map((id) => {
      const peer = stage.agents.get(id);
      return { id, name: peer?.name ?? '', avatar: peer?.avatar ?? null };
    }),
  });
}

const photoRoster = () => {
  const byId = new Map(stage.roster().map((a) => [a.id, a]));
  return stage.snapshot().map((s) => {
    const meta = byId.get(s.id) || {};
    const avatar = meta.avatar || {};
    const out = { id: s.id, name: meta.name || '', x: s.x, y: s.y };
    // CV 角色：直接取未切片的全身圖。
    // 這裡原本是從 head 的路徑字串推導出 full 的路徑 —— 因為當時 full 不在
    // shared/avatars.js 的驗證白名單裡，取不到也不敢直接信。現在 full 與其他
    // 三張走同一條路徑驗證（含「必須同屬一個資產目錄」），可以直接用，
    // 不必再靠字串替換，也不會因為副檔名改動而悄悄失效。
    const full = avatar.textures?.full;
    if (typeof full === 'string') out.fullPng = full;
    // 捏臉角色沒有生成圖，交給 photo_composer 程式化繪製樂高人偶
    if (avatar.fallbackColors) {
      out.outfit = {
        inner_color: avatar.fallbackColors.torso,
        lower_color: avatar.fallbackColors.legs,
      };
      out.face = {
        skin_tone: avatar.fallbackColors.skin,
        hair_color: avatar.fallbackColors.hair,
      };
    }
    return out;
  });
};

const requestCompose = (characters, backdrop) => new Promise((resolve) => {
  const body = Buffer.from(JSON.stringify({
    characters,
    backdrop,
    photoUrlBase: `http://${VISION_HOST}:${VISION_PORT}/photos`,
  }), 'utf8');
  const up = http.request({
    host: VISION_HOST, port: VISION_PORT, path: '/compose', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    timeout: PHOTO_TIMEOUT_MS,
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({ ok: false, error: 'bad_response' }); }
    });
  });
  up.on('timeout', () => { up.destroy(); resolve({ ok: false, error: 'compose_timeout' }); });
  up.on('error', () => resolve({ ok: false, error: 'vision_service_unavailable' }));
  up.end(body);
});

const takeGroupPhoto = async (ws) => {
  // 合成期間場域是鎖住的，重入會讓第二次的 unlockStage 提前解鎖第一次
  if (photoInFlight) {
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'ERROR', error: '合照進行中' });
    return;
  }
  const agents = stage.snapshot();
  if (agents.length === 0) {
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'ERROR', error: '場上沒有角色' });
    return;
  }
  photoInFlight = true;
  try {
    // 原地定住並全部轉向鏡頭
    const assignments = new Map(
      agents.map((a) => [a.id, { x: a.x, y: a.y, heading: FACING_CAMERA }]),
    );
    const n = stage.lockStage(assignments);
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'STAGING', count: n });
    console.log(`[photo] 定位 ${n} 位角色…`);

    // 輪詢到位而非固定秒數等待：移動時間取決於角色原本散得多開。
    // 但仍設上限 —— 現場不能因為某個角色卡住就永遠拍不成。
    const deadline = Date.now() + PHOTO_SETTLE_MS;
    while (!stage.allArrived() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PHOTO_POLL_MS));
    }

    // 先跟大螢幕要一張當下畫面當底圖，角色與 3D 房間都已經在上面了。
    // 拿不到（沒有大螢幕連線、逾時）就傳 null，Python 端會退回自己畫的舞台。
    const backdrop = await requestScreenCapture();
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'COMPOSING' });
    const res = await requestCompose(photoRoster(), backdrop);
    if (res && res.ok) {
      console.log(`[photo] 完成　${res.character_count} 人　${res.photo_id}`);
      send(ws, EV.HOST_PHOTO_STATE, {
        phase: 'DONE',
        photoId: res.photo_id,
        photoUrl: res.photo_url,
        photoB64: res.photo_b64,
        qrB64: res.qr_b64,
        count: res.character_count,
      });
    } else {
      const error = res?.error || 'compose_failed';
      console.warn(`[photo] 失敗：${error}`);
      send(ws, EV.HOST_PHOTO_STATE, { phase: 'ERROR', error });
    }
  } finally {
    // 無論成功或失敗都必須解鎖，否則場域永遠卡在 STAGED、所有人都動不了
    stage.unlockStage();
    photoInFlight = false;
  }
};

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

const handleCrash = (type, err) => {
  console.error(`\n[fatal] 未處理的例外 (${type})：`, err);
  try {
    store.save(snapshotData(), { force: true });
    console.error(`  崩潰前已緊急保存狀態快照　${store.file}`);
  } catch (saveErr) {
    console.error('  快照緊急存檔失敗：', saveErr);
  }
  process.exit(1);
};
process.on('uncaughtException', (err) => handleCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleCrash('unhandledRejection', reason));
