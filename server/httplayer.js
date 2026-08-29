/**
 * HTTP 層：靜態資源服務與生成服務代理
 *
 * 從 index.js 抽出。這一層與 WebSocket / 場域狀態完全無關 ——
 * 它只做兩件事：把檔案送出去，以及把請求轉給 127.0.0.1 的 Python 生成服務。
 *
 * 唯一與互動層的接點是 `/api/screen-capture`：大螢幕把合照底圖 POST 回來，
 * 而等在另一端的是主迴圈裡的 pendingCaptures。那個接點以 `onScreenCapture`
 * 回呼傳入，而不是讓這個模組去 import 場域狀態 —— 方向反過來的話，
 * 這裡就會重新黏回 index.js，抽出來的意義也就沒了。
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { RateLimiter } from './ratelimit.js';

/**
 * 建立 HTTP 層。依賴以參數注入而非 import，方向才不會繞回 index.js。
 *
 * @param {object} deps
 * @param {string} deps.root          專案根目錄（node_modules 與 shared 由此解析）
 * @param {string} deps.publicDir     靜態站台根目錄
 * @param {(input: string) => boolean} deps.keyMatches  主辦端密鑰比對（歷史代理用）
 * @param {(requestId: string, image: string|null) => boolean} deps.onScreenCapture
 *        大螢幕回傳合照底圖。回傳 false 表示 requestId 認不得。
 * @returns {{handleRequest: (req, res) => void, resolveStatic: (p: string) => string|null}}
 */
export function createHttpLayer({ root, publicDir, keyMatches, onScreenCapture, groupingId }) {
const ROOT = root;
const PUBLIC_DIR = publicDir;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
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

      // requestId 認不得就丟掉：它是伺服器剛剛才發出去的隨機值，
      // 猜不中等於這不是我們要的那張截圖。回呼回傳 false 即代表認不得。
      const accepted = onScreenCapture(
        msg?.requestId,
        typeof msg?.image === 'string' ? msg.image : null,
      );
      if (!accepted) { sendJSON(res, 200, { ok: false, error: 'unknown_request' }); return; }
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

  // 本場的分組題。手機在入場前取一次；取不到會沿用內建預設題，
  // 因此這個端點掛掉也不會擋人進場。
  if (urlPath === '/api/grouping') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, questionId: groupingId?.() ?? null }));
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

  return { handleRequest, resolveStatic };
}
