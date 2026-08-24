/**
 * 模組 M1 — 手機端結構化捏臉與輸入控制器
 *
 * 三段式流程：捏臉（3 步）→ CLIENT_JOIN → 搖桿控制。
 * 素材目錄與協定常數皆由 /shared/ 載入，與伺服器共用同一份定義。
 */

import {
  HEADS, FACES, BODIES, SKIN_TONES, ACCENT_COLORS,
  renderAvatarSVG, randomAvatarConfig,
} from '/shared/avatars.js';
import {
  EV, INPUT_THROTTLE_MS, IDLE_THRESHOLD_MS, PAIR_ERRORS,
  QUIZ_CHOICES, QUIZ_ERRORS,
} from '/shared/protocol.js';
import {
  allCaptureIndicatorsPassed, captureGuidanceText, captureIndicators,
} from '/shared/capture-guidance.js';

const $ = (sel) => document.querySelector(sel);

// ─────────────────────────────────────────────────────────────
// 本地狀態
// ─────────────────────────────────────────────────────────────
const LS = {
  userId: 'personaflow.userId',
  rejoinToken: 'personaflow.rejoinToken',
  name: 'personaflow.name',
  avatar: 'personaflow.avatar',
};

let step = 1;
let config = randomAvatarConfig();
let displayName = '';

// 還原上次的設定，讓現場使用者重整頁面後不必重捏
try {
  const saved = localStorage.getItem(LS.avatar);
  if (saved) {
    const parsed = JSON.parse(saved);
    // 掃描生成的外觀要整份取代，不能與隨機捏臉設定合併 —— 混在一起會得到
    // 一個同時帶著 token 與 textures 的角色，之後改用捏臉時 source 還留著
    // 'CV'，等於把人鎖在一組舊貼圖上。
    config = parsed?.source === 'CV' ? parsed : { ...config, ...parsed };
  }
  displayName = localStorage.getItem(LS.name) ?? '';
} catch { /* 隱私模式下 localStorage 可能拋錯，忽略即可 */ }

/** 切回捏臉時，先把掃描的外觀清掉，否則調整選項不會有任何效果 */
function ensureTokenConfig() {
  if (config?.source === 'CV') config = randomAvatarConfig();
}

// ─────────────────────────────────────────────────────────────
// 捏臉 UI
// ─────────────────────────────────────────────────────────────
const STEP_LABELS = ['1 / 3　髮型與膚色', '2 / 3　表情', '3 / 3　服裝與代表色'];

/** 每個選項都渲染「換上該部件後的完整角色」，比只顯示零件更易判讀 */
function buildParts(container, items, key) {
  container.replaceChildren();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';
    btn.setAttribute('aria-pressed', String(config[key] === item.id));
    btn.innerHTML = renderAvatarSVG({ ...config, [key]: item.id });
    const label = document.createElement('span');
    label.textContent = item.label;
    btn.append(label);
    btn.addEventListener('click', () => { config[key] = item.id; refresh(); });
    container.append(btn);
  }
}

function buildSwatches(container, colors, key) {
  container.replaceChildren();
  for (const color of colors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.style.background = color;
    btn.setAttribute('aria-pressed', String(config[key] === color));
    btn.setAttribute('aria-label', color);
    btn.addEventListener('click', () => { config[key] = color; refresh(); });
    container.append(btn);
  }
}

function refresh() {
  // 掃描生成的外觀沒有 token 可選，捏臉 UI 對它沒有意義
  if (config?.source === 'CV') return;
  $('#preview').innerHTML = renderAvatarSVG(config);
  buildParts($('#opt-head'), HEADS, 'head');
  buildParts($('#opt-face'), FACES, 'face');
  buildParts($('#opt-body'), BODIES, 'body');
  buildSwatches($('#opt-skin'), SKIN_TONES, 'skinTone');
  buildSwatches($('#opt-accent'), ACCENT_COLORS, 'accentColor');
  try { localStorage.setItem(LS.avatar, JSON.stringify(config)); } catch { /* 略 */ }
}

function showStep(n) {
  step = n;
  $('#step-label').textContent = STEP_LABELS[n - 1];
  document.querySelectorAll('.step-body').forEach((el) => {
    el.hidden = Number(el.dataset.step) !== n;
  });
  document.querySelectorAll('.steps i').forEach((el, i) => {
    el.classList.toggle('on', i < n);
  });
  $('#btn-prev').textContent = n === 1 ? '改名字' : '上一步';
  $('#btn-next').textContent = n === 3 ? '完成，進入現場' : '下一步';
}

/** 只切換單一畫面，其餘全部隱藏 */
function showScreen(id) {
  for (const s of ['entry', 'scan', 'builder', 'controller', 'farewell']) {
    $(`#${s}`).hidden = s !== id;
  }
}

// ── 進場命名 ──────────────────────────────────────────────
const nameInput = $('#name-input');
nameInput.value = displayName;

function syncStartButton() {
  const empty = nameInput.value.trim().length === 0;
  $('#btn-start').disabled = empty;
  $('#btn-scan').disabled = empty;
}
nameInput.addEventListener('input', syncStartButton);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && nameInput.value.trim()) $('#btn-scan').click();
});
syncStartButton();

/** 兩條入場路徑共用：確認名字、收鍵盤。回傳 false 表示名字還沒填 */
function commitName() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return false; }
  displayName = name;
  try { localStorage.setItem(LS.name, name); } catch { /* 略 */ }
  nameInput.blur(); // 收起鍵盤，否則下一個畫面一開場就被鍵盤蓋掉半個螢幕
  return true;
}

$('#btn-start').addEventListener('click', () => {
  if (!commitName()) return;
  ensureTokenConfig();
  refresh();
  showScreen('builder');
  showStep(1);
});

// ── 掃描生成 ──────────────────────────────────────────────
//
// 捏臉不會被這條路徑取代，而是降級為備援：相機權限被拒、非安全情境、
// 生成失敗都會退回捏臉，參與者不會因此進不了場（整合計畫 §3.5）。

let toastTimer = null;
function showToast(text, durationMs = 3200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, durationMs);
}

let scanStream = null;

// ── 站位引導 ──────────────────────────────────────────────
//
// 每秒送幾張縮圖到 /api/preview，回來的是「還差哪一項」。這條路只跑 CV，
// 不呼叫任何付費 API，因此可以一直跑；真正花錢的只有按下快門那一次。
//
// 沒有這段引導的話，參與者只能對著一個沒有回饋的畫面猜自己站得對不對，
// 而拍歪的照片要等到生成完（約一分鐘、且已經付費）才會知道不合格。

/** 送出頻率。再高只是讓行動網路排隊，CV 本身跟不上 */
const PREVIEW_INTERVAL_MS = 250;
/** 預覽影格長邊。CV 端還會再縮到 360，送更大只是浪費上行頻寬 */
const PREVIEW_MAX_EDGE = 360;
/** 就緒後的倒數秒數，與 2D 版一致 */
const COUNTDOWN_SEC = 3;

let previewTimer = null;
let previewInFlight = false;
let previewSessionId = null;
/** 連續幾張空影格之後才提示 —— 剛開鏡頭時空一兩張是正常的 */
const BLANK_FRAME_WARN = 12;
let blankFrames = 0;
let countdownLeft = 0;
let countdownTimer = null;
let capturing = false;

function stopScanStream() {
  stopPreviewLoop();
  if (!scanStream) return;
  for (const track of scanStream.getTracks()) track.stop();
  scanStream = null;
}

function stopPreviewLoop() {
  clearInterval(previewTimer);
  previewTimer = null;
  previewInFlight = false;
  previewSessionId = null;
  blankFrames = 0;
  $('.scan-stage')?.classList.remove('ready');
  cancelCountdown();
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdownLeft = 0;
  const el = $('#scan-countdown');
  if (el) el.hidden = true;
}

/**
 * 等到 video 真的有影格為止。
 *
 * autoplay 在某些瀏覽器上不會自動觸發（尤其是動態指派 srcObject 的情況），
 * 因此明確呼叫 play()；再等 loadedmetadata 拿到實際尺寸。逾時就放行，
 * 讓後續的「拿不到影像」提示接手，而不是永遠卡在這裡。
 */
function waitForVideo(video, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    if (video.videoWidth) { done(); return; }
    video.addEventListener('loadedmetadata', done);
    video.play().catch(() => { /* 由 loadedmetadata 或逾時收尾 */ });
  });
}

/** 與代理層的 MAX_PHOTO_BYTES 一致；超過就會被 413 擋掉，不如先說 */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * 把上傳的照片縮到與拍照相同的尺寸。
 *
 * 解不開時回傳 null 而不是拋錯 —— 最常見的情況是 iPhone 的 HEIC，
 * Chrome 與 Firefox 都無法解碼，但後端有 pillow-heif 解得開。
 * 那時直接把原檔送出去，讓後端處理，而不是擋下一張其實可用的照片。
 */
function downscaleDataUrl(dataUrl, maxEdge, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * 讓參考圈貼齊影片實際顯示的矩形。
 *
 * video 用 contain，容器通常比影像大（手機直式、桌機橫式都會留黑邊）。
 * 參考圈若鋪滿容器，腳印會落在黑邊上，指到的位置與 CV 分析的影格對不上 ——
 * 這正是 2D 版把 (ix, iy, vw, vh) 傳給 _drawCaptureGuide 的原因。
 */
function layoutStencil() {
  const stage = document.querySelector('.scan-stage');
  const video = $('#scan-video');
  const svg = $('#scan-stencil');
  if (!stage || !video?.videoWidth || !svg) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const scale = Math.min(sw / video.videoWidth, sh / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  svg.style.left = `${Math.round((sw - w) / 2)}px`;
  svg.style.top = `${Math.round((sh - h) / 2)}px`;
  svg.style.width = `${Math.round(w)}px`;
  svg.style.height = `${Math.round(h)}px`;

  // 頭部參考圈在 2D 版是 ellipse(cx, cy, vh*0.12, vh*0.15) —— 寬與高都取自
  // 影片「高度」，所以它在畫面上是圓的。viewBox 的 x 單位是寬度百分比，
  // 直接寫死 rx 會讓它隨畫面比例被拉扁，因此換算後在執行期設定。
  svg.querySelector('.st-head')?.setAttribute('rx', String((h * 0.06 / w) * 100));
}

window.addEventListener('resize', layoutStencil);

/** 把 video 目前的畫面縮成小張 JPEG */
function grabFrame(maxEdge, quality) {
  const video = $('#scan-video');
  if (!video?.videoWidth) return null;
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function renderGuide(features) {
  $('#scan-guide-text').textContent =
    captureGuidanceText(features, '✓ 全身已入鏡，準備拍攝');
  const list = $('#scan-lights');
  list.replaceChildren();
  for (const item of captureIndicators(features)) {
    const li = document.createElement('li');
    li.textContent = item.label;
    if (item.ok) li.classList.add('ok');
    list.append(li);
  }
}

function startCountdown() {
  if (countdownTimer) return;
  countdownLeft = COUNTDOWN_SEC;
  const box = $('#scan-countdown');
  box.hidden = false;
  $('#scan-count').textContent = String(countdownLeft);
  countdownTimer = setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft <= 0) {
      cancelCountdown();
      doCapture();
      return;
    }
    $('#scan-count').textContent = String(countdownLeft);
  }, 1000);
}

async function previewTick() {
  // 上一張還沒回來就跳過這一輪：排隊只會讓引導越來越落後於現實，
  // 參與者照著三秒前的畫面調整站位，永遠對不上。
  if (previewInFlight || capturing || !scanStream) return;
  const image = grabFrame(PREVIEW_MAX_EDGE, 0.6);
  if (!image) {
    // 相機開著卻拿不到影格（虛擬鏡頭、被其他程式佔用）。靜靜什麼都不做的話
    // 參與者只會看到一個沒有反應的黑畫面，不知道該等還是該重來。
    blankFrames += 1;
    if (blankFrames === BLANK_FRAME_WARN) {
      $('#scan-guide-text').textContent = '讀不到相機畫面，請確認沒有其他程式正在使用鏡頭';
    }
    return;
  }
  blankFrames = 0;

  previewInFlight = true;
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, sessionId: previewSessionId }),
    });
    const features = await res.json();
    if (!scanStream) return;   // 期間已經離開拍攝頁

    if (typeof features?.sessionId === 'string') previewSessionId = features.sessionId;

    if (!features?.ok) {
      // 限流、逾時、服務未啟動都只是這一幀沒有結果，不是錯誤 ——
      // 引導維持原狀，下一幀補上；只有確定偵測不到人時才更新文字。
      if (features?.guidance_reason) renderGuide(features);
      $('.scan-stage').classList.remove('ready');
      cancelCountdown();
      return;
    }

    renderGuide(features);
    const ready = allCaptureIndicatorsPassed(features);
    $('.scan-stage').classList.toggle('ready', ready);
    if (ready) startCountdown();
    else cancelCountdown();
  } catch {
    // 網路瞬斷：下一輪會再試
  } finally {
    previewInFlight = false;
  }
}

function startPreviewLoop() {
  stopPreviewLoop();
  $('#scan-guide-text').textContent = '請站遠一點，讓全身與雙腳入鏡';
  $('#scan-lights').replaceChildren();
  previewTimer = setInterval(previewTick, PREVIEW_INTERVAL_MS);
}

/**
 * 相機用不了時，留在拍攝頁的純上傳模式。
 *
 * 原本這兩種情況（非安全情境、權限被拒）都直接跳去捏臉 —— 但上傳按鈕就在
 * 拍攝頁上，等於在最需要它的時候把它藏起來。捏臉沒有被拿掉，「改用捏臉」
 * 仍然在同一排。
 */
function showScanUploadOnly(reason) {
  stopScanStream();
  showScreen('scan');
  document.querySelector('.scan-stage')?.classList.add('upload-only');
  $('#btn-capture').disabled = true;
  $('#scan-guide-text').textContent = `${reason}可以改上傳一張全身照片，或改用捏臉。`;
  $('#scan-lights').replaceChildren();
}

function fallbackToBuilder(message) {
  stopScanStream();
  if (message) showToast(message);
  ensureTokenConfig();
  refresh();
  showScreen('builder');
  showStep(1);
}


$('#btn-scan').addEventListener('click', async () => {
  if (!commitName()) return;

  // getUserMedia 要求安全情境。場館用 http://192.168.x.x 時瀏覽器會直接
  // 拒絕，且錯誤訊息相當隱晦 —— 這裡先明講，免得現場以為是相機壞了。
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showScanUploadOnly('這個網址無法使用相機（需要 HTTPS）。');
    return;
  }

  showScreen('scan');
  document.querySelector('.scan-stage')?.classList.remove('upload-only');
  $('#btn-capture').disabled = false;
  $('#scan-overlay').hidden = true;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      // ideal 而非固定值：桌機通常只有前鏡頭，寫死 environment 在某些裝置上
      // 會挑到輸出黑畫面的虛擬鏡頭。
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = $('#scan-video');
    video.srcObject = scanStream;
    // srcObject 設好不代表已經有影格。少了這一步，預覽迴圈每次都在
    // videoWidth === 0 提早 return，畫面全黑而且一盞指示燈都不會亮 ——
    // 看起來像引導壞了，其實是還沒開始播。
    await waitForVideo(video);
    layoutStencil();
    startPreviewLoop();
  } catch {
    showScanUploadOnly('沒有取得相機權限。');
  }
});

$('#btn-scan-back').addEventListener('click', () => fallbackToBuilder(null));

/** 快門。倒數結束與手動按鈕走同一條路，避免兩份幾乎相同的流程各自演化。 */
async function doCapture() {
  if (capturing) return;
  // 先把畫面定格成 JPEG。長邊限制在 1280：再大只是讓上傳變慢，
  // 生圖模型看到的解析度並不會因此提升。
  const image = grabFrame(1280, 0.85);
  if (!image) return;
  // sessionId：預覽期間跨影格量到的身高比快門那一瞬間的單張估計可信，
  // 後端會優先採用它。上傳的照片沒有預覽階段，因此沒有這個。
  await submitImage(image, previewSessionId, '正在生成你的角色…');
}

/**
 * 把一張照片送去生成。拍照與上傳共用 —— 兩者的差別只有影像從哪裡來，
 * 之後的等待、失敗降級與進場流程完全相同，沒有理由寫成兩份。
 */
async function submitImage(image, sessionId, statusText) {
  if (capturing) return;
  capturing = true;
  stopScanStream();
  $('#scan-overlay').hidden = false;
  $('#scan-status').textContent = statusText;

  let body;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, sessionId }),
    });
    body = await res.json();
  } catch {
    capturing = false;
    fallbackToBuilder('生成服務連不上，先用捏臉進場。');
    return;
  }

  if (!body?.ok) {
    // 生成服務在驗證不過時會附上重拍理由（缺腿、出框、輪廓不清…）。
    // 沒有它，參與者能做的就只是再拍一張一模一樣的照片。
    // 理由是伺服器端寫死的固定字串，不含使用者輸入。
    const why = typeof body?.guidance === 'string' && body.guidance ? body.guidance : null;
    capturing = false;
    fallbackToBuilder(why ? `${why}先用捏臉進場，也可以重拍再試。`
                          : '這張照片沒能生成角色，先用捏臉進場。');
    return;
  }

  config = { source: 'CV', textures: body.textures, fallbackColors: body.fallbackColors };
  // 與捏臉路徑一致：存下外觀後由 enterStage 統一處理進場
  // （縮圖、搖桿初始化、舊 socket 清理都在那裡）
  try { localStorage.setItem(LS.avatar, JSON.stringify(config)); } catch { /* 略 */ }
  capturing = false;
  enterStage();
}

$('#btn-capture').addEventListener('click', doCapture);

// ── 上傳既有照片 ──────────────────────────────────────────
//
// 現場不是每個人都適合站到定點拍：抱小孩、坐輪椅、或單純不想被當場拍。
// 上傳走的是同一條生成管線，只是少了站位引導那一段。
$('#btn-upload').addEventListener('click', () => $('#file-input').click());

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  // 先清空 value：同一個檔案連選兩次時 change 不會再觸發，
  // 生成失敗想重試同一張照片就會像是按鈕壞了。
  e.target.value = '';
  if (!file || capturing) return;

  if (file.size > MAX_UPLOAD_BYTES) {
    showToast('這張照片太大了，請選一張小一點的。');
    return;
  }

  const original = await readFileAsDataUrl(file);
  if (!original) {
    showToast('讀不到這個檔案，請換一張照片。');
    return;
  }

  // 縮到與拍照相同的長邊。解不開多半是 HEIC —— 瀏覽器不會，但後端會，
  // 因此原檔照送，不擋下一張其實可用的照片。
  const scaled = await downscaleDataUrl(original, 1280, 0.85);
  await submitImage(scaled ?? original, null, '正在辨識這張照片…');
});

// ── 捏臉 ──────────────────────────────────────────────────
$('#btn-random').addEventListener('click', () => { config = randomAvatarConfig(); refresh(); });
$('#btn-prev').addEventListener('click', () => {
  if (step === 1) { showScreen('entry'); return; } // 第一步再往回即回到命名畫面
  showStep(step - 1);
});
$('#btn-next').addEventListener('click', () => {
  if (step < 3) { showStep(step + 1); return; }
  try { localStorage.setItem(LS.avatar, JSON.stringify(config)); } catch { /* 略 */ }
  enterStage();
});

refresh();
showScreen('entry');

// ─────────────────────────────────────────────────────────────
// WebSocket 連線
// ─────────────────────────────────────────────────────────────
let ws = null;
let reconnectDelay = 500;
let joystick = null;

function setStatus(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function sendMsg(type, payload = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  // 事件處理器必須指向「當初綁定的那條連線」，不能讀模組層的 ws ——
  // 重新進場時 ws 已被指向新連線，舊連線的 close 事件才姍姍來遲，
  // 屆時讀到的會是新連線的狀態。
  const sock = ws;

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    setStatus('登入中…');
    // 帶上舊 userId 與重連憑證：若伺服器上的角色還在（斷線 45 秒內），
    // 且憑證相符，就會接回同一個角色而非新建
    let userId = null;
    let rejoinToken = null;
    try {
      userId = localStorage.getItem(LS.userId);
      rejoinToken = localStorage.getItem(LS.rejoinToken);
    } catch { /* 略 */ }
    sendMsg(EV.CLIENT_JOIN, { userId, rejoinToken, name: displayName, avatar: config });
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === EV.CLIENT_WELCOME) {
      try {
        localStorage.setItem(LS.userId, msg.userId);
        if (msg.rejoinToken) localStorage.setItem(LS.rejoinToken, msg.rejoinToken);
      } catch { /* 略 */ }
      $('#my-name').textContent = msg.name;
      $('#my-id').textContent = msg.userId;
      setStatus('已連線', 'ok');
    } else if (msg.type === EV.CLIENT_REJECT) {
      setStatus('資料有誤', 'warn');
      showToast(`登入失敗：${msg.reason}`);
      backToBuilder();
    } else {
      handleMissionMessage(msg);
    }
  });

  ws.addEventListener('close', () => {
    // 主動離場時不重連，否則角色會立刻又出現在大螢幕上
    if (hasLeft) return;
    // 已被新連線取代的舊 socket 也不重連（見 enterStage）
    if (sock.superseded) return;
    setStatus('重新連線中…', 'warn');
    // 指數退避上限 5 秒：現場 Wi-Fi 壅塞時避免所有手機同頻重連加劇擁塞
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  });
}

function backToBuilder() {
  showScreen('builder');
  showStep(3);
}

// ─────────────────────────────────────────────────────────────
// 任務與配對（規格 v3.0 §3.3）
// ─────────────────────────────────────────────────────────────
let mission = null;
let myCode = '----';
let myProgress = 0;

const banner = $('#mission-banner');
const sheet = $('#pair-sheet');
const pairInput = $('#pair-input');
const pairMsg = $('#pair-msg');

/** 配對失敗原因對應的說明。集中在此，避免文案散落在各處。 */
const PAIR_MESSAGES = {
  [PAIR_ERRORS.NO_MISSION]: '目前沒有進行中的任務。',
  [PAIR_ERRORS.NOT_FOUND]: '找不到這組配對碼，請再確認一次。',
  [PAIR_ERRORS.SELF]: '那是你自己的配對碼喔。',
  [PAIR_ERRORS.ALREADY_PAIRED]: '你們已經配對過了，去找別人吧。',
  [PAIR_ERRORS.BUSY]: '有一組配對正在確認中，請稍候。',
  [PAIR_ERRORS.COOLDOWN]: '太快了，休息一下再試。',
  [PAIR_ERRORS.DECLINED]: '對方沒有確認這次配對。',
  [PAIR_ERRORS.EXPIRED]: '配對逾時，請重新輸入。',
};

function showPairMsg(text, ok = false) {
  pairMsg.textContent = text;
  pairMsg.classList.toggle('ok', ok);
  pairMsg.hidden = false;
}

function renderMission() {
  if (!mission) { banner.hidden = true; return; }
  banner.hidden = false;
  $('#mb-title').textContent = mission.title;
  $('#mb-code').textContent = myCode;
  $('#pair-mycode').textContent = myCode;
  $('#pair-title').textContent = mission.title;
  $('#pair-brief').textContent = mission.brief ?? '';

  const done = myProgress >= mission.target;
  const frac = `${myProgress} / ${mission.target}`;
  $('#mb-prog').textContent = done ? `${frac} ✓` : frac;
  $('#mb-prog').classList.toggle('done', done);
  $('#pair-progress').textContent = done
    ? `你已經完成任務了（${frac}），還可以繼續認識新的人`
    : `你的進度　${frac}`;
}

function handleMissionMessage(msg) {
  // 問答與積分自成一組，先讓它們處理；沒接走的才往下當任務訊息
  if (handleQuizMessage(msg)) return;

  switch (msg.type) {
    case EV.PAIR_CODE:
      myCode = msg.code;
      renderMission();
      break;

    case EV.MISSION_ANNOUNCE:
      mission = msg.mission;
      myProgress = msg.progress ?? 0;
      renderMission();
      break;

    case EV.MISSION_CLOSED:
      mission = null;
      renderMission();
      closeSheet();
      break;

    case EV.PAIR_CONFIRM_REQ:
      openConfirmPair(msg);
      break;

    case EV.PAIR_RESULT:
      handlePairResult(msg);
      break;
  }
}

function handlePairResult(msg) {
  if (msg.ok && msg.pending) {
    showPairMsg('已送出，等待對方確認…', true);
    return;
  }
  if (msg.ok) {
    myProgress = msg.progress ?? myProgress;
    renderMission();
    const bonus = msg.points > 0 ? `　+${msg.points} 分` : '';
    showPairMsg(`配對成功！你和 ${msg.partnerName} 建立了連結。${bonus}`, true);
    pairInput.value = '';
    closeConfirmPair();
    // 讓成功訊息停留一下再收起面板，使用者才看得到結果
    setTimeout(() => { if (!sheet.hidden) closeSheet(); }, 1800);
    return;
  }
  showPairMsg(PAIR_MESSAGES[msg.reason] ?? '配對失敗，請再試一次。');
  closeConfirmPair();
}

// ── 配對面板 ──────────────────────────────────────────────
function openSheet() {
  if (!mission) return;
  pairMsg.hidden = true;
  pairInput.value = '';
  sheet.hidden = false;
  renderMission();
  setTimeout(() => pairInput.focus(), 80);
}
function closeSheet() {
  sheet.hidden = true;
  pairInput.blur();
}

banner.addEventListener('click', openSheet);
$('#btn-pair-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

// 只允許數字，避免使用者貼上奇怪內容
pairInput.addEventListener('input', () => {
  pairInput.value = pairInput.value.replace(/\D/g, '').slice(0, 4);
});
pairInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-pair-submit').click();
});

$('#btn-pair-submit').addEventListener('click', () => {
  const code = pairInput.value.trim();
  if (code.length !== 4) { showPairMsg('請輸入 4 位數字。'); return; }
  pairMsg.hidden = true;
  sendMsg(EV.PAIR_CLAIM, { code });
});

// ── 對方發起的配對確認 ────────────────────────────────────
const confirmPair = $('#pair-confirm');

function openConfirmPair(msg) {
  $('#pair-confirm-title').textContent = `${msg.name} 想和你配對`;
  $('#pair-confirm-text').textContent = '請確認對方就站在你面前，再按下確認。';
  $('#pair-confirm-avatar').innerHTML = msg.avatar ? renderAvatarSVG(msg.avatar) : '';
  confirmPair.hidden = false;
}
function closeConfirmPair() {
  confirmPair.hidden = true;
}

$('#btn-pair-accept').addEventListener('click', () => {
  sendMsg(EV.PAIR_CONFIRM, { accept: true });
  closeConfirmPair();
});
$('#btn-pair-decline').addEventListener('click', () => {
  sendMsg(EV.PAIR_CONFIRM, { accept: false });
  closeConfirmPair();
});

// ─────────────────────────────────────────────────────────────
// 主動退出
// ─────────────────────────────────────────────────────────────
let hasLeft = false;

const confirmBox = $('#confirm-exit');
const openConfirm = () => { confirmBox.hidden = false; };
const closeConfirm = () => { confirmBox.hidden = true; };

$('#btn-exit').addEventListener('click', openConfirm);
$('#btn-cancel-exit').addEventListener('click', closeConfirm);
// 點擊對話框外的遮罩等同取消
confirmBox.addEventListener('click', (e) => { if (e.target === confirmBox) closeConfirm(); });

$('#btn-confirm-exit').addEventListener('click', () => {
  closeConfirm();
  hasLeft = true;
  joyEngaged = false;

  // 清掉任務狀態，重新進場時會由伺服器重新公告
  mission = null;
  myProgress = 0;
  renderMission();
  closeSheet();
  closeConfirmPair();
  quiz = null;
  myChoice = null;
  closeQuiz();
  setScore(0);

  sendMsg(EV.CLIENT_LEAVE);
  // 讓退出訊息送達後才關閉連線，避免它被 close 交握截斷
  setTimeout(() => ws?.close(), 120);

  // 清除身分憑證：重新進場時應建立全新角色，而不是接回剛剛離場的那個
  try {
    localStorage.removeItem(LS.userId);
    localStorage.removeItem(LS.rejoinToken);
  } catch { /* 略 */ }

  $('#farewell-avatar').innerHTML = renderAvatarSVG(config);
  showScreen('farewell');
});

$('#btn-rejoin').addEventListener('click', () => {
  hasLeft = false;
  reconnectDelay = 500;
  showScreen('entry');
  syncStartButton();
});

// ─────────────────────────────────────────────────────────────
// 搖桿與社交動作
// ─────────────────────────────────────────────────────────────
let joyVec = { x: 0, y: 0 };
let joyIntensity = 0;
let joyEngaged = false;
let lastInputAt = 0;

function initJoystick() {
  if (joystick) return;
  joystick = nipplejs.create({
    zone: $('#joystick-zone'),
    mode: 'static',
    position: { left: '50%', top: '50%' },
    color: '#2F2A26',
    size: 130,
    restJoystick: true,
  });

  joystick.on('move', (_evt, data) => {
    if (!data?.vector) return;
    // nipplejs 的 y 軸向上為正，場域座標則向下為正，故取負號對齊
    joyVec = { x: data.vector.x, y: -data.vector.y };
    joyIntensity = Math.min(1, data.force ?? 0);
    joyEngaged = true;
    lastInputAt = Date.now();
  });

  joystick.on('end', () => {
    joyEngaged = false;
    joyVec = { x: 0, y: 0 };
    joyIntensity = 0;
    // 補送一則歸零封包，讓伺服器立即停止施加手動速度，
    // 而不必等 3 秒閒置逾時才發現使用者已放手
    sendMsg(EV.INPUT_MOVE, { vector: joyVec, intensity: 0 });
  });
}

// 20 Hz 節流發送（技術文件 M1 §操控輸入發送規格）。
// 僅在推桿期間發送，閒置時保持靜默以節省現場無線頻寬。
setInterval(() => {
  if (!joyEngaged) return;
  sendMsg(EV.INPUT_MOVE, { vector: joyVec, intensity: joyIntensity });
}, INPUT_THROTTLE_MS);

$('#emotes').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  sendMsg(EV.INPUT_ACTION, { action: btn.dataset.action });
  btn.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(0.9)' }, { transform: 'scale(1)' }],
    { duration: 220 },
  );
});

/**
 * 操控權提示。
 * 這是純本地的顯示邏輯，鏡射伺服器 M2 的閒置門檻，用意是讓使用者理解
 * 「放手後角色會自己走」是設計而非故障。它不是控制權的真實來源 ——
 * 真正的 α 權重永遠由伺服器計算。
 */
setInterval(() => {
  const el = $('#agency');
  if (!el || $('#controller').hidden) return;
  const active = Date.now() - lastInputAt < IDLE_THRESHOLD_MS;
  el.classList.toggle('active', active);
  el.textContent = active
    ? '你正在操控'
    : '角色正在自由漫遊中 — 推動搖桿即可接手';
}, 200);

// 手機息屏或切換到其他 App 時主動歸零，避免角色維持在最後的推桿方向
document.addEventListener('visibilitychange', () => {
  if (document.hidden && joyEngaged) {
    joyEngaged = false;
    sendMsg(EV.INPUT_MOVE, { vector: { x: 0, y: 0 }, intensity: 0 });
  }
});

// ─────────────────────────────────────────────────────────────
// 進場
// ─────────────────────────────────────────────────────────────
function enterStage() {
  showScreen('controller');
  $('#mini-avatar').innerHTML = renderAvatarSVG(config);
  $('#my-name').textContent = displayName;
  $('#my-id').textContent = '—';
  setStatus('連線中…');
  // nipplejs 建立時需要量測 zone 尺寸，因此必須在區塊顯示之後才初始化
  requestAnimationFrame(initJoystick);
  // 重新進場時可能還留著上一個已關閉的 socket，先確保它不會干擾。
  // 只呼叫 close() 不夠：它的 close 監聽器仍會依退避排程再 connect() 一次，
  // 於是同一支手機開出第二條連線、用同一個 userId 再送一次 CLIENT_JOIN。
  // 此時舊角色還連著，reattach 與 claim 都會失敗，伺服器只好新建一個角色
  // —— 場上就多出一隻永遠不會斷線的分身。
  if (ws) {
    ws.superseded = true;
    if (ws.readyState !== WebSocket.CLOSED) ws.close();
  }
  connect();
}

// ─────────────────────────────────────────────────────────────
// 即時問答與積分
// ─────────────────────────────────────────────────────────────
const quizPanel = $('#quiz-panel');

/** @type {object|null} 目前題目（伺服器視圖，不含正解） */
let quiz = null;
/** 自己這題選了哪一個，null 代表尚未作答 */
let myChoice = null;
let quizTimer = null;
/** 倒數基準：收到題目當下 + remainingMs。手機時鐘常常不準，不能用絕對時戳。 */
let quizDeadline = 0;

function setScore(score) {
  $('#score-chip').replaceChildren(
    document.createTextNode(String(score)),
    Object.assign(document.createElement('small'), { textContent: '分' }),
  );
}

/** 加分浮標。重播動畫要先移除節點的 hidden 再強制回流，否則同一個元素連兩次不會重播。 */
function popScore(delta) {
  if (!delta || delta <= 0) return;
  const el = $('#score-pop');
  el.textContent = `+${delta}`;
  el.hidden = true;
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(popScore.timer);
  popScore.timer = setTimeout(() => { el.hidden = true; }, 1600);
}

function openQuiz() {
  quizPanel.hidden = false;
  // 進入問答時鬆開搖桿：角色交還給 Boids，不會停在最後的推桿方向上
  if (joyEngaged) {
    joyEngaged = false;
    sendMsg(EV.INPUT_MOVE, { vector: { x: 0, y: 0 }, intensity: 0 });
  }
}

function closeQuiz() {
  quizPanel.hidden = true;
  clearInterval(quizTimer);
  quizTimer = null;
}

function renderQuizOptions({ locked = false, revealed = null } = {}) {
  // QUIZ_ENDED 會把 quiz 設為 null。若在那之後才收到伺服器的 QUIZ_ACK
  // （作答與主辦端結束問答同時發生），這裡會對 null 取 .options 而丟
  // TypeError，整個訊息處理迴圈就斷了。
  if (!quiz) return;

  const wrap = $('#quiz-opts');
  wrap.replaceChildren();

  quiz.options.forEach((text, i) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-opt';
    btn.style.background = QUIZ_CHOICES[i].color;
    btn.style.borderColor = QUIZ_CHOICES[i].color;

    const g = document.createElement('span');
    g.className = 'g';
    g.textContent = QUIZ_CHOICES[i].glyph;
    const t = document.createElement('span');
    t.textContent = text;
    btn.append(g, t);

    if (i === myChoice) btn.classList.add('chosen');

    if (revealed !== null) {
      btn.disabled = true;
      btn.classList.add(i === revealed ? 'right' : 'wrong');
      if (i === revealed) btn.style.borderColor = '#2F2A26';
    } else if (locked) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        // 先在本地鎖定，不等伺服器回應 —— 現場網路有延遲，
        // 按下去沒有立即反應會讓人以為沒按到而狂點
        myChoice = i;
        renderQuizOptions({ locked: true });
        showQuizMsg('已送出，等待公布答案…');
        sendMsg(EV.QUIZ_ANSWER, { choice: i });
      });
    }

    wrap.append(btn);
  });
}

function showQuizMsg(text) {
  const el = $('#quiz-msg');
  el.textContent = text;
  el.hidden = !text;
}

function startQuizCountdown() {
  clearInterval(quizTimer);
  quizDeadline = Date.now() + (quiz.remainingMs ?? 0);
  const tick = () => {
    const left = Math.max(0, quizDeadline - Date.now());
    const el = $('#quiz-timer');
    el.textContent = (left / 1000).toFixed(1);
    el.classList.toggle('urgent', left < 5000);
    if (left <= 0) {
      clearInterval(quizTimer);
      quizTimer = null;
      if (myChoice === null) showQuizMsg('時間到，等待公布答案…');
    }
  };
  tick();
  quizTimer = setInterval(tick, 100);
}

function showQuestion(q) {
  quiz = q;
  myChoice = null;
  $('#quiz-no').textContent = `第 ${q.index} 題`;
  $('#quiz-q').textContent = q.question;
  $('#quiz-result-card').hidden = true;
  $('#btn-quiz-hide').hidden = true;
  showQuizMsg('');
  renderQuizOptions();
  startQuizCountdown();
  openQuiz();
}

function showQuizResult(msg) {
  if (!quiz) return;
  clearInterval(quizTimer);
  quizTimer = null;
  $('#quiz-timer').textContent = '—';
  $('#quiz-timer').classList.remove('urgent');
  renderQuizOptions({ revealed: msg.correctIndex });
  showQuizMsg('');

  const card = $('#quiz-result-card');
  card.hidden = false;
  card.classList.toggle('miss', !msg.correct);
  $('#quiz-verdict').textContent = msg.answered
    ? (msg.correct ? '答對了！' : '答錯了')
    : '這題沒作答';
  $('#quiz-points').textContent = msg.points > 0 ? `+${msg.points} 分` : '沒有得分';
  $('#quiz-standing').textContent = msg.rank
    ? `目前 ${msg.score} 分，第 ${msg.rank} 名`
    : `目前 ${msg.score} 分`;

  $('#btn-quiz-hide').hidden = false;
  // 加分浮標一律由 SCORE_SELF 觸發，這裡只更新數字，避免同一筆分數跳兩次
  setScore(msg.score);
  openQuiz();  // 收起過的人也要把結果看到
}

$('#btn-quiz-hide').addEventListener('click', closeQuiz);

/** 作答被拒的原因文案 */
const QUIZ_MESSAGES = {
  [QUIZ_ERRORS.NO_QUIZ]: '這題已經結束了。',
  [QUIZ_ERRORS.CLOSED]: '時間到了，這題已經截止。',
  [QUIZ_ERRORS.ALREADY_ANSWERED]: '你已經作答過了，答案不能更改。',
  [QUIZ_ERRORS.BAD_CHOICE]: '選項不正確，請重新選擇。',
};

function handleQuizMessage(msg) {
  switch (msg.type) {
    case EV.QUIZ_QUESTION:
      showQuestion(msg.quiz);
      return true;

    case EV.QUIZ_ACK:
      // 伺服器不接受這次作答（重複、逾時、選項不合法）時把本地鎖定放掉
      if (!msg.ok) {
        myChoice = null;
        renderQuizOptions();
        showQuizMsg(QUIZ_MESSAGES[msg.reason] ?? '這次作答沒有被接受。');
      }
      return true;

    case EV.QUIZ_RESULT:
      showQuizResult(msg);
      return true;

    case EV.QUIZ_REVEAL:
      // 分佈資訊目前只在大螢幕呈現，手機端不重複顯示；
      // 個人的對錯與得分走 QUIZ_RESULT
      return true;

    case EV.QUIZ_ENDED:
      quiz = null;
      myChoice = null;
      closeQuiz();
      return true;

    case EV.SCORE_SELF:
      setScore(msg.score);
      popScore(msg.delta);
      return true;

    default:
      return false;
  }
}
