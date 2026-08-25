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
import { avatarImage } from '/shared/avatarSprite.js';
import { AvatarRenderer } from './avatarRenderer.js';

const $ = (sel) => document.querySelector(sel);

// ─────────────────────────────────────────────────────────────
// 觸覺回饋
// ─────────────────────────────────────────────────────────────
/**
 * iOS Safari **完全不支援** navigator.vibrate —— 不是降級，是沒有。
 * 現場若有 iPhone，這條路徑對他們是靜默的，因此震動只能是加分項，
 * 不能是任何互動的唯一回饋（每個震動點都另有畫面上的變化）。
 *
 * 另設開關並預設關閉腳步震動：走路時每秒約 2–3 次的持續震動
 * 對電池與體感疲勞都有實際代價，該由使用者決定要不要開。
 */
const HAPTICS_KEY = 'personaflow.haptics';
const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
let hapticsOn = false;
try { hapticsOn = localStorage.getItem(HAPTICS_KEY) === 'on'; } catch { /* 隱私模式 */ }

function vibrate(pattern) {
  if (!canVibrate || !hapticsOn) return;
  try { navigator.vibrate(pattern); } catch { /* 部分瀏覽器在背景分頁會拋錯 */ }
}

// ── 防止手機休眠 (Wake Lock) ───────────────────────────────────
let wakeLock = null;
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  }
}
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

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
const LEGO_PREFIXES = ['快樂的', '無敵', '魔法', '酷炫', '光速', '熱血', '創意', '宇宙', '調皮的', '神秘'];
const LEGO_NOUNS = ['樂高', '工程師', '積木人', '拼裝者', '方塊', '大師', '探險家', '騎士', '魔法師', '小天才'];

function generateLegoName() {
  const p = LEGO_PREFIXES[Math.floor(Math.random() * LEGO_PREFIXES.length)];
  const n = LEGO_NOUNS[Math.floor(Math.random() * LEGO_NOUNS.length)];
  return p + n;
}

function commitName() {
  let name = nameInput.value.trim();
  if (!name) { 
    name = generateLegoName();
    nameInput.value = name;
  }
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
/** 生成成功但尚未被本人確認的外觀。按下「進場」才會寫入 config */
let pendingScanConfig = null;

/**
 * 切換掃描畫面的階段。
 *
 * 四個階段共用同一個左右分欄，只換右欄內容 —— 整塊重繪會讓畫面跳動，
 * 而左邊的取景框在拍照前後必須留在原位（拍完顯示成果圖，位置不變）。
 */
function showScanPhase(phase) {
  for (const el of document.querySelectorAll('#scan .scan-panel')) {
    el.hidden = el.dataset.phase !== phase;
  }
  // 成果階段換白底。生成中顯示的是剛拍下的照片（深色框比較合適），
  // 只有最後展示角色時才轉白 —— 角色是透明背景，白底才襯得出來。
  $('.scan-stage')?.classList.toggle('is-result', phase === 'done');

  // 名字貫穿整條流程：使用者在上一頁輸入之後就再也沒看到它，
  // 但那正是等一下會出現在大螢幕角色頭上的名字。
  for (const el of [$('#aim-name'), $('#done-name')]) {
    if (el) el.textContent = displayName || '';
  }
  // 輔助線只在取景時有意義，其餘階段會擋住成果圖。
  //
  // 這裡用 class 而不是 .hidden：`hidden` 是 HTMLElement 的屬性，
  // SVGElement 沒有 —— `svg.hidden = true` 會靜默失敗（屬性根本沒設上去，
  // 也不會拋錯），輔助線就一路留在成果圖上面。
  $('#scan-guide')?.classList.toggle('is-off', phase !== 'aim');
  // 引導只在取景階段有意義；生成中與成果階段畫面已經定格。
  if (phase !== 'aim') stopPreviewLoop();
}

// ── 站位引導 ──────────────────────────────────────────────
//
// 人形輔助線只告訴參與者「該站成什麼樣」，不會告訴他「現在站對了沒有」。
// 這裡每 250ms 送一張縮圖到 /api/preview，回來的是還差哪一項。
// 只跑 CV，不呼叫任何付費 API，因此可以一直跑；錢只花在快門那一次。
//
// 送出的影格必須與實際拍攝走同一套裁切（cropToPortraitJpeg 的 9:16），
// 否則 CV 分析的取景與最後送去生成的不是同一塊畫面 —— 引導會指著一個
// 不存在的問題，而真正被裁掉的部分沒有人檢查。

const PREVIEW_INTERVAL_MS = 250;
/** 引導用的長邊。CV 端還會再縮到 360，送更大只是浪費上行頻寬 */
const PREVIEW_MAX_EDGE = 360;
/** 連續幾張空影格才提示 —— 剛開鏡頭時空一兩張是正常的 */
const BLANK_FRAME_WARN = 12;

let previewTimer = null;
let previewInFlight = false;
let previewSessionId = null;
let blankFrames = 0;

function stopPreviewLoop() {
  clearInterval(previewTimer);
  previewTimer = null;
  previewInFlight = false;
  blankFrames = 0;
  document.querySelector('.scan-stage')?.classList.remove('is-ready');
  const text = $('#aim-guide');
  if (text) text.textContent = '';
  $('#aim-lights')?.replaceChildren();
}

function renderAimGuide(features) {
  const text = $('#aim-guide');
  if (text) text.textContent = captureGuidanceText(features, '✓ 全身已入鏡，可以按拍照了');
  const list = $('#aim-lights');
  if (!list) return;
  list.replaceChildren();
  for (const item of captureIndicators(features)) {
    const li = document.createElement('li');
    li.textContent = item.label;
    if (item.ok) li.classList.add('ok');
    list.append(li);
  }
}

async function previewTick() {
  // 上一張還沒回來就跳過這一輪：排隊只會讓引導越來越落後於現實，
  // 參與者照著三秒前的畫面調整站位，永遠對不上。
  // 倒數與生成期間也不送 —— 那時畫面已經定格，引導沒有意義。
  if (previewInFlight || counting || !scanStream) return;
  const video = $('#scan-video');
  if (!video?.videoWidth) {
    blankFrames += 1;
    if (blankFrames === BLANK_FRAME_WARN && $('#aim-guide')) {
      $('#aim-guide').textContent = '讀不到相機畫面，請確認沒有其他程式正在使用鏡頭';
    }
    return;
  }
  blankFrames = 0;

  previewInFlight = true;
  try {
    const image = cropToPortraitJpeg(video, video.videoWidth, video.videoHeight,
                                     PREVIEW_MAX_EDGE, 0.6);
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, sessionId: previewSessionId }),
    });
    const features = await res.json();
    if (!scanStream) return;   // 期間已經離開取景階段

    if (typeof features?.sessionId === 'string') previewSessionId = features.sessionId;

    if (!features?.ok) {
      // 限流、逾時、服務未啟動都只是這一幀沒有結果，不是錯誤 ——
      // 引導維持原狀，下一幀補上；只有確定偵測不到人時才更新文字。
      if (features?.guidance_reason) renderAimGuide(features);
      document.querySelector('.scan-stage')?.classList.remove('is-ready');
      return;
    }

    renderAimGuide(features);
    // 就緒只是「可以按了」的提示，不自動拍 —— 何時按下快門由參與者決定，
    // 那是這個流程刻意保留的控制權（見拍照鍵的 5 秒倒數）。
    document.querySelector('.scan-stage')
      ?.classList.toggle('is-ready', allCaptureIndicatorsPassed(features));
  } catch {
    // 網路瞬斷：下一輪會再試
  } finally {
    previewInFlight = false;
  }
}

function startPreviewLoop() {
  stopPreviewLoop();
  previewSessionId = null;
  if ($('#aim-guide')) $('#aim-guide').textContent = '請站遠一點，讓全身與雙腳入鏡';
  previewTimer = setInterval(previewTick, PREVIEW_INTERVAL_MS);
}

function stopScanStream() {
  stopPreviewLoop();
  if (!scanStream) return;
  for (const track of scanStream.getTracks()) track.stop();
  scanStream = null;
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

  showScreen('scan');

  // getUserMedia 要求安全情境。場館用 http://192.168.x.x 時瀏覽器會直接
  // 拒絕，且錯誤訊息相當隱晦 —— 這裡先明講，免得現場以為是相機壞了。
  //
  // 但沒有相機**不等於**不能生成角色：從相簿上傳這條路徑完全不需要相機。
  // 因此這裡不再直接踢回捏臉，而是停在失敗畫面上 —— 那個畫面同時放了
  // 「從相簿選」與「改用捏臉」，由使用者自己選，而不是系統代為決定。
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showScanFailure(
      '這個網址無法使用相機（需要 HTTPS）。',
      '你仍然可以從相簿選一張全身照來生成角色，或改用捏臉。',
      { title: '相機無法使用', emptyStage: true, noRetry: true },
    );
    return;
  }

  await openCamera();
});

/** 開啟相機並回到取景階段。重拍會再次呼叫，因此不能寫在事件處理器裡。 */
async function openCamera() {
  stopScanStream();
  pendingScanConfig = null;
  $('#scan-result').hidden = true;
  $('#scan-video').hidden = false;
  $('#btn-capture').disabled = false;
  $('#btn-capture').textContent = '拍照';
  // 上一次若是相機失敗，取景框被藏起來了，重試時要收回來
  $('.scan-stage')?.classList.remove('is-empty', 'shutter', 'is-result');
  showScanPhase('aim');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 720 }, height: { ideal: 1280 } },
      audio: false,
    });
    $('#scan-video').srcObject = scanStream;
    startPreviewLoop();
    return true;
  } catch (err) {
    // 不直接踢回捏臉：使用者可能只是誤按拒絕，或想去設定裡開啟。
    // 捏臉仍在，但那是「他選的」而不是「系統替他決定的」。
    const denied = err?.name === 'NotAllowedError';
    showScanFailure(
      denied ? '沒有取得相機權限。' : '開不起相機。',
      denied
        ? '請在網址列左側的權限圖示允許使用相機，再按重新嘗試。'
        : '相機可能正被其他程式使用（視訊軟體、另一個分頁）。',
      { title: '相機無法使用', retryLabel: '重新嘗試', emptyStage: true },
    );
    return false;
  }
}

$('#btn-scan-back').addEventListener('click', () => fallbackToBuilder(null));

/** 倒數中被按下取消時設為 true，讓倒數迴圈中止。
    宣告必須排在下方上傳處理器之前 —— let 不會提升，放在後面會落入
    暫時性死區（TDZ）。 */
let countdownCancelled = false;
let counting = false;

// ── 從相簿選一張照片 ─────────────────────────────────────────
//
// 與拍照並存而非取代：現場有人不想當場被拍、光線不夠、或相機權限被拒，
// 上傳既有照片仍能走完同一條生成流程。
//
// 這條路徑**不需要相機**，因此在 getUserMedia 不可用時（http 非安全情境、
// 權限被拒、相機被其他程式占用）依然成立 —— 相機失敗畫面上也放了這個入口。
$('#btn-upload')?.addEventListener('click', () => $('#upload-input').click());
$('#btn-upload-alt')?.addEventListener('click', () => $('#upload-input').click());

$('#upload-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  // 先清空 value，否則連續選同一個檔案不會再次觸發 change
  e.target.value = '';
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showToast('請選擇圖片檔。');
    return;
  }

  // 倒數中切走會讓倒數繼續跑並拍下空畫面，先中止它
  if (counting) countdownCancelled = true;

  let img;
  try {
    img = await loadImageFromFile(file);
  } catch {
    showScanFailure('讀不到這張照片。', '換一張圖片試試，或改用拍照。', {
      title: '照片打不開', retryLabel: '重新選擇',
    });
    return;
  }

  // 相機若正開著就關掉：接下來取景框顯示的是選來的照片，
  // 讓串流繼續跑只是白耗電。
  stopScanStream();
  const image = cropToPortraitJpeg(img, img.naturalWidth, img.naturalHeight);
  await submitScanImage(image);
});

/** 讀取本機圖片檔成 <img>。用完必須釋放 objectURL，否則整張原檔會留在記憶體裡。 */
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode_failed')); };
    img.src = url;
  });
}

$('#btn-capture').addEventListener('click', async () => {
  const btn = $('#btn-capture');

  // 倒數期間再按一次＝取消。
  // 少了這條，發現站錯位置或有人闖進畫面時只能眼睜睜看它拍下去，
  // 然後再等 25 秒生成完才能重拍。
  if (counting) {
    countdownCancelled = true;
    return;
  }

  const video = $('#scan-video');
  if (!video.videoWidth) return;
  if (btn.disabled) return;

  const display = $('#countdown-display');
  const stage = $('.scan-stage');
  counting = true;
  countdownCancelled = false;
  display.hidden = false;
  $('#btn-scan-back').disabled = true;

  for (let i = 5; i > 0; i--) {
    display.textContent = i;
    // 每一秒重播一次縮放動畫，讓數字有「跳動」感而不是靜止著換數字
    display.classList.remove('tick');
    void display.offsetWidth;
    display.classList.add('tick');
    btn.textContent = `取消（${i}）`;
    await new Promise(r => setTimeout(r, 1000));
    if (countdownCancelled) break;
  }

  display.hidden = false;
  display.classList.remove('tick');
  counting = false;
  $('#btn-scan-back').disabled = false;
  btn.textContent = '拍照';

  if (countdownCancelled) {
    display.hidden = true;
    showToast('已取消');
    return;
  }

  display.hidden = true;
  btn.disabled = true;
  // 快門：白閃一下，給「有拍到」的即時回饋
  stage.classList.remove('shutter');
  void stage.offsetWidth;
  stage.classList.add('shutter');

  const image = cropToPortraitJpeg(video, video.videoWidth, video.videoHeight);

  stopScanStream();
  await submitScanImage(image);
});

/**
 * 把來源（<video> 或 <img>）裁成 9:16 並編成 JPEG data URL。
 *
 * 相機與相簿上傳共用這一份：兩者送進 /api/generate 的格式必須一致，
 * 否則後端 slicer 的切片比例會對不上其中一邊（見 CLAUDE.md 的跨語言耦合）。
 */
function cropToPortraitJpeg(source, sw0, sh0, maxEdge = 1280, quality = 0.85) {
  // 裁切成 9:16 長方細長型：聚焦在人物，捨棄無用的左右背景，減少 API 負擔與上傳成本
  const TARGET_RATIO = 9 / 16;
  let sx = 0, sy = 0, sw = sw0, sh = sh0;

  if (sw0 / sh0 > TARGET_RATIO) {
    sw = sh0 * TARGET_RATIO;
    sx = (sw0 - sw) / 2;
  } else {
    sh = sw0 / TARGET_RATIO;
    sy = (sh0 - sh) / 2;
  }

  // 長邊限制在 maxEdge（拍攝 1280），再大只是讓上傳變慢，生圖模型看到的
  // 解析度並不會因此提升。上傳的相簿原檔可能是好幾千萬畫素，這一步同時
  // 把它壓回伺服器收得下的大小。站位引導用小很多的尺寸，見 previewTick()。
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);

  canvas.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 送出照片並走完生成流程。相機與上傳共用。 */
async function submitScanImage(image) {
  // 凍結送出的那張照片留在取景框裡 —— 等待的 25 秒有東西可看，
  // 也讓人知道系統正在處理的是哪一張。
  $('#scan-video').hidden = true;
  $('#scan-result').src = image;
  $('#scan-result').hidden = false;
  $('.scan-stage')?.classList.remove('is-empty');
  showScanPhase('working');

  const stopProgress = startScanProgress();

  let body;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // sessionId：取景期間跨影格量到的身高比快門那一瞬間的單張估計可信，
      // 後端會優先採用它。相簿上傳沒有取景階段，因此是 null。
      body: JSON.stringify({ image, sessionId: previewSessionId }),
    });
    body = await res.json();
  } catch {
    stopProgress();
    showScanFailure('生成服務連不上。');
    return;
  }

  stopProgress();

  if (!body?.ok) {
    const known = SCAN_ERRORS[body?.error];
    showScanFailure(
      known ?? '這張照片沒能生成角色。',
      // 沒有對應錯誤碼時多半是照片本身的問題（人太小、背光、多人入鏡），
      // 給具體可行動的建議，而不是只說「失敗了」。
      known ? '' : '照片裡的人要夠大、光線夠亮，並且只有一個人入鏡。',
    );
    return;
  }

  // 生成完成不直接進場：讓本人看過再決定。
  // 「數位轉譯成什麼樣子」正是這件作品的核心體驗，跳過等於白等 25 秒。
  pendingScanConfig = {
    source: 'CV', textures: body.textures, fallbackColors: body.fallbackColors,
  };
  if (body.fullPng) $('#scan-result').src = body.fullPng;
  showScanPhase('done');
}

/**
 * 失敗畫面：保留重試的機會，而不是逕自把人踢回捏臉。
 *
 * 降級到捏臉是刻意保留的保底路徑（整合計畫 §3.5），但「自動降級」與
 * 「讓使用者選」是兩回事 —— 等了 25 秒換來一句 toast 然後被丟去捏臉，
 * 挫折感遠大於再按一次重拍。
 */
function showScanFailure(message, hint = '', opts = {}) {
  // 相機開不起來時左邊沒有東西可看，留一個空黑框只是佔位。
  // 生成失敗則相反 —— 剛拍的那張照片正是使用者要判斷「哪裡不對」的依據。
  $('.scan-stage')?.classList.toggle('is-empty', !!opts.emptyStage);
  $('#fail-title').textContent = opts.title ?? '沒能生成角色';
  $('#scan-error').textContent = hint ? message : `${message}再試一次通常就好了。`;
  const hintEl = $('#fail-hint');
  hintEl.textContent = hint;
  hintEl.hidden = !hint;
  // 非安全情境下相機永遠開不起來（那個檢查是同步且必然的），
  // 留一個按了必定再次失敗的「重新嘗試」只是在浪費現場的時間。
  const retryBtn = $('#btn-retry');
  retryBtn.textContent = opts.retryLabel ?? '重拍一次';
  retryBtn.hidden = !!opts.noRetry;
  showScanPhase('failed');
}

/** 後端回報的錯誤碼 → 看得懂的說明 */
const SCAN_ERRORS = {
  too_busy: '現在同時生成的人太多。',
  rate_limited: '太快連續拍照了，稍等一下。',
  photo_too_large: '照片檔案太大。',
  generation_timeout: '生成等太久逾時了。',
  vision_service_unavailable: '生成服務連不上。',
  imagegen_unavailable: '生成服務尚未就緒。',
  circuit_open: '生成服務暫時過載。',
  no_person: '照片裡沒有偵測到人。',
};

/**
 * 生成進度提示。
 *
 * 後端沒有回報真實進度，這裡是依實測耗時（約 25 秒）推進的估計值，
 * 因此刻意在 92% 前停住 —— 進度條先滿了卻還沒好，比沒有進度條更糟。
 */
function startScanProgress() {
  const STEPS = [
    [0, '正在分析服裝特徵…'],
    [22, '正在辨識臉部特徵…'],
    [45, 'AI 正在挑選樂高積木…'],
    [68, '積木拼裝與上色中…'],
    [86, '即將完成，準備登場…'],
  ];
  const bar = $('#scan-progress');
  const statusEl = $('#scan-status');
  const elapsedEl = $('#scan-elapsed');
  const t0 = Date.now();

  const tick = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    const pct = Math.min(92, (sec / 25) * 100);
    bar.style.width = `${pct}%`;
    const step = STEPS.filter(([p]) => pct >= p).at(-1);
    if (step) statusEl.textContent = step[1];
    elapsedEl.textContent = sec < 30
      ? `已等待 ${Math.floor(sec)} 秒　約需 25 秒`
      : `已等待 ${Math.floor(sec)} 秒　比平常久一些，請再等等`;
  }, 250);

  return () => { clearInterval(tick); bar.style.width = '100%'; };
}

// 確認、重拍、放棄
$('#btn-accept').addEventListener('click', () => {
  if (!pendingScanConfig) return;
  config = pendingScanConfig;
  pendingScanConfig = null;
  // 與捏臉路徑一致：存下外觀後由 enterStage 統一處理進場
  // （縮圖、搖桿初始化、舊 socket 清理都在那裡）
  try { localStorage.setItem(LS.avatar, JSON.stringify(config)); } catch { /* 略 */ }
  enterStage();
});
$('#btn-retake').addEventListener('click', () => openCamera());
$('#btn-retry').addEventListener('click', () => openCamera());
$('#btn-give-up').addEventListener('click', () => fallbackToBuilder(null));

/**
 * 顯示「你認識了誰」。
 *
 * 這場活動真正在累積的是人與人的連結，但手機端進場後原本只有搖桿、
 * 任務與分數 —— 那份累積完全看不見。這裡把它變成參與者自己的收藏。
 */
function renderSocialStrip(msg) {
  const strip = $('#links-strip');
  const peers = Array.isArray(msg?.peers) ? msg.peers : [];
  if (peers.length === 0) { strip.hidden = true; return; }

  $('#ls-count').textContent = String(msg.count ?? peers.length);

  const faces = $('#ls-faces');
  faces.textContent = '';
  // 只畫最近幾位：手機橫幅放不下更多，而數字已經說明了總數
  for (const peer of peers.slice(-6)) {
    const sprite = peer.avatar ? avatarImage(peer.avatar) : null;
    const cell = document.createElement('span');
    cell.className = 'ls-face';
    cell.title = peer.name || '';
    if (sprite) {
      // avatarImage 回傳的是 canvas，直接放進 DOM 即可，不必再編碼一次
      sprite.className = 'ls-face-img';
      cell.append(sprite);
    } else {
      cell.textContent = (peer.name || '?').slice(0, 1);
    }
    faces.append(cell);
  }
  strip.hidden = false;
}

$('#links-strip').addEventListener('click', () => {
  // 目前只做提示；完整名單留待有需求時再展開成面板
  showToast('這些是你在現場實際碰面並互相確認過的人');
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
    const overlay = $('#reconnect-overlay');
    if (overlay) overlay.hidden = true;
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
    } else if (msg.type === EV.CLIENT_SYNC) {
      // 個人視角座標（10Hz）。畫布可能還沒建立（剛連上、尚未進場），
      // 此時直接丟棄即可 —— 下一則 100ms 後就到。
      renderer?.applySync(msg);
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
    
    const overlay = $('#reconnect-overlay');
    if (overlay) overlay.hidden = false;

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

  // 停掉 POV 畫布的 rAF 迴圈。離場畫面看不到它，繼續跑只是白白耗電。
  renderer?.stop();
  renderer = null;

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

/** @type {AvatarRenderer|null} 個人視角畫布。進場時建立，離場時停止。 */
let renderer = null;

/**
 * 建立或更新 POV 畫布。
 * 掃描生成完成後外觀會變，因此重複呼叫時只換貼圖，不重建畫布 ——
 * 重建會把累積的網格位移歸零，畫面看起來像瞬移。
 */
function initRenderer() {
  const canvas = $('#pov-canvas');
  if (!canvas) return;
  if (renderer) { renderer.setAvatar(config); return; }

  renderer = new AvatarRenderer(canvas, config);
  // 腳步震動：由步態相位驅動，與畫面上的落腳完全同步（見 avatarRenderer._detectFootstep）
  renderer.onFootstep(() => vibrate(15));
  renderer.start();
}

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
    renderer?.setInput(joyVec, joyIntensity);
  });

  joystick.on('end', () => {
    joyEngaged = false;
    joyVec = { x: 0, y: 0 };
    joyIntensity = 0;
    renderer?.setInput(joyVec, 0);
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
  vibrate([30, 40, 30]);
  btn.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(0.9)' }, { transform: 'scale(1)' }],
    { duration: 220 },
  );
});

// ── 震動開關 ──────────────────────────────────────────────
{
  const btn = $('#btn-haptics');
  // 不支援的裝置（iOS Safari）直接不顯示，而不是顯示一個按了沒反應的開關
  if (btn && canVibrate) {
    btn.hidden = false;
    const sync = () => btn.setAttribute('aria-pressed', String(hapticsOn));
    sync();
    btn.addEventListener('click', () => {
      hapticsOn = !hapticsOn;
      try { localStorage.setItem(HAPTICS_KEY, hapticsOn ? 'on' : 'off'); } catch { /* 略 */ }
      sync();
      // 開啟的當下震一下，讓使用者立刻確認它真的有作用
      if (hapticsOn) vibrate(20);
    });
  }
}

/**
 * 操控權提示。
 * 這是純本地的顯示邏輯，鏡射伺服器 M2 的閒置門檻。它不是控制權的真實來源
 * —— 真正的 α 權重永遠由伺服器計算。
 *
 * 文案刻意不描述「放手之後角色會做什麼」：那由伺服器的 IDLE_MOTION 決定
 * （預設 'still' 靜止待機，可改為 'wander' 自由漫遊），而手機端讀不到那個值。
 * 寫死其中一種，另一種模式下就會變成假訊息 —— 使用者看著站著不動的角色，
 * 卻被告知它正在漫遊。因此只陳述這端能確定的事：現在是不是你在操控。
 */
setInterval(() => {
  const el = $('#agency');
  if (!el || $('#controller').hidden) return;
  const active = Date.now() - lastInputAt < IDLE_THRESHOLD_MS;
  el.classList.toggle('active', active);
  el.textContent = active
    ? '你正在操控'
    : '推動搖桿即可操控你的角色';
}, 200);

// 手機息屏或切換到其他 App 時主動歸零，避免角色維持在最後的推桿方向
document.addEventListener('visibilitychange', () => {
  if (document.hidden && joyEngaged) {
    joyEngaged = false;
    sendMsg(EV.INPUT_MOVE, { vector: { x: 0, y: 0 }, intensity: 0 });
  }
  // 畫布同步歸零，回到前景時角色不會延續息屏前的推桿方向繼續走
  if (document.hidden) renderer?.setInput({ x: 0, y: 0 }, 0);
});

// ─────────────────────────────────────────────────────────────
// 進場
// ─────────────────────────────────────────────────────────────
function enterStage() {
  showScreen('controller');
  requestWakeLock();
  $('#mini-avatar').innerHTML = renderAvatarSVG(config);
  $('#my-name').textContent = displayName;
  $('#my-id').textContent = '—';
  setStatus('連線中…');
  // nipplejs 與畫布都需要量測已顯示區塊的尺寸，因此必須在 showScreen 之後才初始化
  requestAnimationFrame(() => { initJoystick(); initRenderer(); });
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

    case EV.SOCIAL_SELF:
      renderSocialStrip(msg);
      break;

    case EV.SCORE_SELF:
      setScore(msg.score);
      popScore(msg.delta);
      return true;

    default:
      return false;
  }
}
