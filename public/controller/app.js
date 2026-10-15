/**
 * 模組 M1 — 手機端結構化捏臉與輸入控制器
 *
 * 三段式流程：捏臉（3 步）→ CLIENT_JOIN → 搖桿控制。
 * 素材目錄與協定常數皆由 /shared/ 載入，與伺服器共用同一份定義。
 */

import { scorePersona, PERSONA_RESULT_MAP } from '/shared/persona.js';
import {
  HEADS, FACES, BODIES, SKIN_TONES, ACCENT_COLORS,
  renderAvatarSVG, randomAvatarConfig,
} from '/shared/avatars.js';
import {
  EV, INPUT_THROTTLE_MS, IDLE_THRESHOLD_MS, PAIR_ERRORS, DIRECT_MESSAGE, MSG_ERRORS,
  QUIZ_CHOICES, QUIZ_ERRORS, QUIZ_PHASE, GREET_OUTCOME,
} from '/shared/protocol.js';
import {
  allCaptureIndicatorsPassed, captureGuidanceText, captureIndicators,
} from '/shared/capture-guidance.js';
import { HEAT_MAP } from '/shared/heat.js';
import { ZONE_MAP } from '/shared/scene.js';
import { avatarImage, avatarPortrait } from '/shared/avatarSprite.js';
import { makeKeepsake, saveKeepsake } from './keepsake.js';
import { encounterLabel } from '/shared/encounters.js';
import { AvatarRenderer } from './avatarRenderer.js';

const $ = (sel) => document.querySelector(sel);

// ─────────────────────────────────────────────────────────────
// 覆蓋層的鍵盤行為
// ─────────────────────────────────────────────────────────────
/**
 * 四個覆蓋層（配對面板、配對確認、退出確認、問答）在視覺上都是
 * `position: fixed; inset: 0` 加一層遮罩，看起來蓋住了整個畫面 ——
 * 但**擋不住鍵盤**。用藍牙鍵盤或行動輔助裝置時，Tab 會直接穿過遮罩
 * 走到底下的搖桿與表情鍵上：焦點框出現在一塊看不見的區域裡，
 * 使用者不知道自己選到了什麼，按下去卻真的會送出動作。
 *
 * `inert` 讓底下整棵樹同時退出焦點順序與輔助技術，一個屬性解決兩件事。
 * 這裡對 #app 下 inert（覆蓋層都是 #app 的兄弟節點，不受影響）。
 *
 * 另外兩件事一併在這裡處理，避免四個地方各寫一份：
 *   1. Esc 關閉 —— 對應 escape-routes；沒有它，鍵盤使用者進得去出不來。
 *   2. 關閉後把焦點還給觸發的那顆按鈕 —— 否則焦點掉回 <body>，
 *      下一次 Tab 得從整個頁面的最開頭重走一遍。
 */
const appRoot = $('#app');

/** 目前開著的覆蓋層堆疊。問答可能疊在配對面板上，所以用堆疊而非單一變數。 */
const overlayStack = [];

function focusablesIn(el) {
  return [...el.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((n) => n.offsetParent !== null);
}

/**
 * @param {HTMLElement} el     覆蓋層本身
 * @param {object}      opts
 * @param {() => void}  opts.onEscape  Esc 或關閉時要跑的收尾（通常就是 closeXxx）
 * @param {HTMLElement} opts.restoreTo 關閉後把焦點還給誰
 */
function pushOverlay(el, { onEscape, restoreTo } = {}) {
  if (overlayStack.some((o) => o.el === el)) return;
  overlayStack.push({ el, onEscape, restoreTo: restoreTo ?? document.activeElement });
  appRoot.inert = true;
  // 其他已開啟的覆蓋層也要退出焦點順序，否則 Tab 會走到被蓋住的那一層
  for (const o of overlayStack) if (o.el !== el) o.el.inert = true;
  el.inert = false;
}

function popOverlay(el) {
  const i = overlayStack.findIndex((o) => o.el === el);
  if (i === -1) return;
  const [gone] = overlayStack.splice(i, 1);
  el.inert = false;

  const top = overlayStack[overlayStack.length - 1];
  if (top) {
    top.el.inert = false;
  } else {
    appRoot.inert = false;
  }

  // 焦點還給觸發者。它可能已經被隱藏（例如離開現場後整個 section 收起來），
  // 這時候不要硬搶焦點，交給瀏覽器預設行為。
  const back = gone.restoreTo;
  if (back && back.isConnected && back.offsetParent !== null) back.focus();
}

// Esc 關閉最上層；Tab 在最上層內部循環（focus trap）
document.addEventListener('keydown', (e) => {
  const top = overlayStack[overlayStack.length - 1];
  if (!top) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    top.onEscape?.();
    return;
  }

  if (e.key !== 'Tab') return;
  const items = focusablesIn(top.el);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  // inert 已擋掉往外走的路，但焦點若還在覆蓋層外（剛開啟的那一瞬間）
  // 仍需把它拉回來，否則第一次 Tab 會沒有反應。
  if (!top.el.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

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
/** 只提示一次就好，每次進場都閃會變成噪音 */
const HAPTICS_HINT_KEY = 'personaflow.hapticsHint';
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
/** 伺服器指派的角色 id。尋寶要用它判斷「先知是不是我」 */
let myId = null;
/** 本輪尋寶我是不是先知。只有先知收得到冷熱 */
let isProphet = false;

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
  setStepBar('#builder-steps', n);
  $('#btn-prev').textContent = n === 1 ? '改名字' : '上一步';
  $('#btn-next').textContent = n === 3 ? '完成，進入現場' : '下一步';
}

/**
 * 角色肖像放進容器：與場上同一格像素畫格（shared/avatarSprite.js 的 avatarPortrait）。
 * 拍照角色不能用 renderAvatarSVG —— 那只會畫出取樣色的通用角色，
 * 左上角的「自己」就會跟大螢幕上的自己長得不一樣。
 */
function showPortrait(el, avatar) {
  if (!el) return;
  el.replaceChildren();
  if (!avatar) return;
  avatarPortrait(avatar).then((c) => {
    c.className = 'portrait';
    c.setAttribute('aria-hidden', 'true');
    el.replaceChildren(c);
  });
}

/** 三段進度條（捏臉與拍照共用同一個元件） */
function setStepBar(selector, n) {
  document.querySelectorAll(`${selector} i`).forEach((el, i) => {
    el.classList.toggle('on', i < n);
  });
}

/** 只切換單一畫面，其餘全部隱藏 */
function showScreen(id) {
  for (const s of ['entry', 'return', 'scan', 'builder', 'controller', 'farewell']) {
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
// 沒填名字時的隨機名。用詞跟著畫風走：現在只有像素風格，原本的
// 「樂高」「積木人」「拼裝者」會讓人以為選錯了風格。
const NAME_PREFIXES = ['快樂的', '無敵', '魔法', '酷炫', '光速', '熱血', '創意', '宇宙', '調皮的', '神秘'];
const NAME_NOUNS = ['像素人', '小方塊', '玩家', '勇者', '大師', '探險家', '騎士', '魔法師', '小天才', '冒險者'];

function generateRandomName() {
  const p = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
  const n = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  return p + n;
}

function commitName() {
  let name = nameInput.value.trim();
  if (!name) { 
    name = generateRandomName();
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
const SCAN_STEPS = {
  aim: [1, '拍照'],
  working: [2, '生成中'],
  failed: [2, '沒能生成'],
  done: [3, '確認角色'],
};

function showScanPhase(phase) {
  if (phase === 'done') renderDonePersona();
  // 直式版面依階段調整取景框大小（style.css 的 #scan[data-phase]）
  $('#scan').dataset.phase = phase;
  // 生成中不給回前一頁：生成還在跑，離開了結果也沒地方放
  $('#btn-scan-back').hidden = phase === 'working';
  for (const el of document.querySelectorAll('#scan .scan-panel')) {
    el.hidden = el.dataset.phase !== phase;
  }
  // 成果階段換白底。生成中顯示的是剛拍下的照片（深色框比較合適），
  // 只有最後展示角色時才轉白 —— 角色是透明背景，白底才襯得出來。
  $('.scan-stage')?.classList.toggle('is-result', phase === 'done');
  // 與捏臉同一套三段進度：拍照 → 生成 → 確認。失敗停在第二段（卡在生成這一步）
  const [stepNo, stepName] = SCAN_STEPS[phase] ?? SCAN_STEPS.aim;
  $('#scan-step-label').textContent = `${stepNo} / 3　${stepName}`;
  setStepBar('#scan-steps', stepNo);

  // 名字貫穿整條流程：使用者在上一頁輸入之後就再也沒看到它，
  // 但那正是等一下會出現在大螢幕角色頭上的名字。
  for (const el of [$('#aim-name'), $('#done-name')]) {
    if (el) el.textContent = displayName || '';
  }
  renderAimCopy();
  // 切換鏡頭只在取景時有意義；生成中與成果階段相機已經關了
  $('#btn-flip').hidden = !(canFlipCamera && phase === 'aim');
  // 輔助線只在取景時有意義，其餘階段會擋住成果圖。
  //
  // 這裡用 class 而不是 .hidden：`hidden` 是 HTMLElement 的屬性，
  // SVGElement 沒有 —— `svg.hidden = true` 會靜默失敗（屬性根本沒設上去，
  // 也不會拋錯），輔助線就一路留在成果圖上面。
  // 引導只在取景階段有意義；生成中與成果階段畫面已經定格。
  if (phase !== 'aim') stopPreviewLoop();
}

// ── 站位引導 ──────────────────────────────────────────────
//
// 告訴參與者「現在站對了沒有」：每 250ms 送一張縮圖到 /api/preview，回來的是還差哪一項。
// （取景框原本還有一個虛線人形，已拿掉；引導文字一律以「畫面」為準，不再提人形。）
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
  if (text) {
    text.textContent = captureGuidanceText(features, '✓ 全身已入鏡，可以按拍照了', { mirrored: cameraFacing === 'user' });
  }
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
                                     PREVIEW_MAX_EDGE, 0.6, digitalZoom);
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
    // 那是這個流程刻意保留的控制權（見拍照鍵的倒數，CAPTURE_COUNTDOWN_SEC）。
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
  if ($('#aim-guide')) {
    $('#aim-guide').textContent = cameraFacing === 'user'
      ? '請站遠一點，讓全身與雙腳入鏡'
      : '請對方站遠一點，讓全身與雙腳入鏡';
  }
  previewTimer = setInterval(previewTick, PREVIEW_INTERVAL_MS);
}

/**
 * 每次開相機的序號。stopScanStream() 會遞增它，讓還在等 getUserMedia 的那一次作廢。
 *
 * 連點兩下切換鏡頭時，兩次 openCamera() 都會在對方的 getUserMedia 回來之前
 * 執行 stopScanStream()，於是兩條串流都開成功，先回來的那條被覆寫掉、永遠沒人關 ——
 * 相機一直被佔著，iOS 上下一次開啟會直接 NotReadableError（「開不起相機」）。
 */
let cameraOpenSeq = 0;

function stopScanStream() {
  cameraOpenSeq++;
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


/**
 * 生成風格選單。
 *
 * 清單向伺服器要，不寫死：某個風格的參考圖集沒放進去時，後端的 /health 會
 * 據實回報，選項就不該出現在畫面上 —— 寫死的話選項照樣在，選了卻靜默退回
 * 預設，參與者只會覺得這個按鈕沒作用。
 *
 * 生成服務沒起來就整個藏起來，走活動層級的預設風格。這是「掃描失敗一律
 * 降級，不擋人進場」的同一條原則：選不了風格不該讓人拍不了照。
 */
let selectedStyleId = null;
let stylesLoaded = false;

async function loadStyles() {
  if (stylesLoaded) return;

  let body;
  try {
    const res = await fetch('/api/styles');
    body = await res.json();
  } catch {
    return;   // 沒有 stylesLoaded = true，下次進拍照頁會再試一次
  }

  const styles = Array.isArray(body?.styles) ? body.styles : [];
  // 只有一種風格時選單沒有意義，藏起來比給一個只能選同一項的控制項好。
  if (styles.length < 2) return;

  stylesLoaded = true;
  selectedStyleId = styles.some((s) => s.id === body.defaultStyle)
    ? body.defaultStyle
    : styles[0].id;

  const container = $('#style-pick-options');
  container.textContent = '';
  for (const style of styles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-opt';
    btn.dataset.styleId = style.id;
    btn.textContent = style.displayName || style.id;
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', () => selectStyle(style.id));
    container.appendChild(btn);
  }
  $('#style-pick').hidden = false;
  selectStyle(selectedStyleId);
}

function selectStyle(styleId) {
  selectedStyleId = styleId;
  for (const btn of $('#style-pick-options').children) {
    const on = btn.dataset.styleId === styleId;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
  }
}

$('#btn-scan').addEventListener('click', async () => {
  if (!commitName()) return;

  showScreen('scan');
  // 不 await：選單晚幾百毫秒出現無妨，但相機不該為了它慢一步開起來。
  loadStyles();

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

/**
 * 送出裁切的目標比例。
 *
 * 取景框（style.css 的 .scan-stage）也用同一個比例，且影像以 object-fit:cover
 * 填滿它 —— cover 的裁切方式與下方 cropToPortraitJpeg 一致，因此框裡看到的
 * 就是會送出的。改動任一邊都要同時改另一邊。
 */
const SUBMIT_RATIO = 9 / 16;
/** 按下拍照後倒數幾秒。原本 5 秒，改成 3 秒：站好位之後多等的那兩秒只會讓人動來動去 */
const CAPTURE_COUNTDOWN_SEC = 3;

/**
 * 目前用哪一顆鏡頭。預設後鏡頭：拍全身得站到 2–3 公尺外，一定要有人拿著手機，
 * 而「請旁邊的人幫我拍」正好是進場的第一次交談（CLAUDE.md 新玩法第 3 條）。
 * 前鏡頭留給只有自己一個人、要把手機立起來自拍的情況。
 *
 * 前鏡頭的預覽鏡像顯示（像照鏡子，自拍時才找得到自己往哪邊站）；送出的照片仍是原始影像。
 * 站位指示提到「畫面左右」的句子會依鏡像對調（captureGuidanceText 的 mirrored），
 * 否則畫面一翻轉，指示就跟眼睛看到的左右相反。
 */
let cameraFacing = 'environment';
/** 有兩顆以上鏡頭才顯示切換鍵。筆電只有一顆，facingMode 兩個值拿到的是同一顆。 */
let canFlipCamera = false;

/** 取景階段的標題與提示。後鏡頭時看螢幕的是幫忙拍的人，前鏡頭時是本人。 */
function renderAimCopy() {
  const selfie = cameraFacing === 'user';
  $('#aim-pre').textContent = !selfie && displayName ? '幫 ' : '';
  $('#aim-post').textContent = selfie ? '自拍一張全身照' : '拍一張全身照';
}

/** 權限取得之後 enumerateDevices 才會列出全部鏡頭，因此在相機開成功後才呼叫 */
async function updateFlipAvailability() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    canFlipCamera = devices.filter((d) => d.kind === 'videoinput').length >= 2;
  } catch {
    canFlipCamera = false;
  }
  $('#btn-flip').hidden = !canFlipCamera;
  renderAimCopy();
}

/** 開啟相機並回到取景階段。重拍會再次呼叫，因此不能寫在事件處理器裡。 */
async function openCamera() {
  stopScanStream();
  pendingScanConfig = null;
  $('#scan-result').hidden = true;
  $('#scan-video').hidden = false;
  $('#btn-capture').disabled = false;
  $('#btn-capture').textContent = '拍照';
  // 上一次若是相機失敗，取景框被藏起來了，重試時要收回來
  $('.scan-stage')?.classList.remove('is-empty', 'shutter', 'is-result', 'is-pixel');
  showScanPhase('aim');
  const seq = cameraOpenSeq;
  try {
    // 兩軸都要 1280 而不是指定 720×1280：後者等於向瀏覽器要一個 9:16 的
    // 直式串流，但筆電鏡頭是橫式且感光元件不會轉向，瀏覽器只能從中央裁掉
    // 大半的左右視野再放大 —— 而那正是要把一個人塞進畫面所需要的視野。
    // 兩軸同值讀作「給我最接近這個大小的原生模式」，不暗示任何方向，
    // 筆電拿到完整的 16:9、手機拿到完整的直式，兩邊都是最大視野。
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    // 等待期間又開了一次、或已經離開掃描頁：這條串流沒有人要了，立刻關掉
    if (seq !== cameraOpenSeq) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    scanStream = stream;
    $('#scan-video').srcObject = scanStream;
    initZoom(stream);
    // 自拍預覽鏡像（style.css 的 .is-selfie）。只翻顯示，不翻送出的影像
    $('.scan-stage')?.classList.toggle('is-selfie', cameraFacing === 'user');
    startPreviewLoop();
    updateFlipAvailability();
    return true;
  } catch (err) {
    // 已被後來的那一次取代：失敗畫面由後來那一次決定，這裡不要蓋上去
    if (seq !== cameraOpenSeq) return false;
    // 切到前鏡頭才失敗的話，重試要回到後鏡頭，否則「重新嘗試」會一直撞同一顆
    cameraFacing = 'environment';
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

// 右上角「回前一頁」：關掉相機回命名畫面（名字還留著，可以改走捏臉或重新拍照）
$('#btn-scan-back').addEventListener('click', () => {
  stopScanStream();
  stopPersonaDuringScan();
  showScreen('entry');
});
$('#btn-flip').addEventListener('click', () => {
  if (counting) return;   // 倒數中換鏡頭，拍下來的會是另一個方向
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  openCamera();
});
// 捏臉頁的反向切換。名字在命名頁就存好了，直接走同一個入口
$('#btn-to-scan').addEventListener('click', () => $('#btn-scan').click());

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
  $('#btn-flip').disabled = true;
  setZoomLocked(true);

  for (let i = CAPTURE_COUNTDOWN_SEC; i > 0; i--) {
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
  $('#btn-flip').disabled = false;
  setZoomLocked(false);
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

  const image = cropToPortraitJpeg(video, video.videoWidth, video.videoHeight, undefined, undefined, digitalZoom);

  stopScanStream();
  await submitScanImage(image);
});

/**
 * 把來源（<video> 或 <img>）裁成 9:16 並編成 JPEG data URL。
 *
 * 相機與相簿上傳共用這一份，站位引導的 previewTick() 也走同一套裁切 ——
 * 三者必須一致，否則 CV 判定的取景與最後送去生成的不是同一塊畫面。
 *
 * 注意：這個比例**不是**後端要求的。slicer.py 處理的是生成出來的去背 PNG
 * （依 alpha 邊界正規化後才套 CUTS），從來沒看過這張輸入照片。裁成 9:16 的
 * 理由只有「聚焦人物、少傳無用背景」，而且它砍的是左右、完整保留上下，
 * 所以不會讓全身入不了鏡。取景框上的裁切範圍框畫的就是這一塊。
 */
function cropToPortraitJpeg(source, sw0, sh0, maxEdge = 1280, quality = 0.85, zoom = 1) {
  const TARGET_RATIO = SUBMIT_RATIO;
  let sx = 0, sy = 0, sw = sw0, sh = sh0;

  if (sw0 / sh0 > TARGET_RATIO) {
    sw = sh0 * TARGET_RATIO;
    sx = (sw0 - sw) / 2;
  } else {
    sh = sw0 / TARGET_RATIO;
    sy = (sh0 - sh) / 2;
  }
  // 數位放大：取景框以中心放大（CSS scale），這裡就從同一塊 9:16 的中央再裁一圈 ——
  // 送出的與站位偵測看到的，都必須是框裡看得到的那一塊
  if (zoom > 1) {
    const zw = sw / zoom, zh = sh / zoom;
    sx += (sw - zw) / 2; sy += (sh - zh) / 2;
    sw = zw; sh = zh;
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

/**
 * 每 2 秒問一次自己排第幾，結果交給 onQueue（null 代表已經在生成）。
 *
 * 查不到（照片還在上傳、舊版伺服器沒有這個端點、網路抖一下）就維持原狀，
 * 不當成錯誤 —— 這只是顯示用的，生成結果仍以 /api/generate 的回應為準。
 */
function pollQueue(ticket, onQueue) {
  let stopped = false;
  const poll = async () => {
    try {
      const res = await fetch(`/api/generate/status?ticket=${ticket}`);
      const s = await res.json();
      if (stopped || !s?.ok) return;
      onQueue(s.state === 'queued' ? { ahead: s.ahead, etaSec: s.etaSec } : null);
    } catch { /* 略 */ }
  };
  const timer = setInterval(poll, 2000);
  setTimeout(poll, 600);   // 第一次稍等一下，讓照片先上傳完、排進隊伍
  return () => { stopped = true; clearInterval(timer); };
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
  startPersonaDuringScan();

  const progress = startScanProgress();
  // 號碼牌：生成請求會一直掛著等結果，排第幾要另外問。
  const ticket = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, '0')).join('');
  const stopPolling = pollQueue(ticket, progress.setQueue);
  const stopProgress = () => { stopPolling(); progress.stop(); };

  let body;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gen-Ticket': ticket },
      // sessionId：取景期間跨影格量到的身高比快門那一瞬間的單張估計可信，
      // 後端會優先採用它。相簿上傳沒有取景階段，因此是 null。
      // styleId：選單沒載入時是 null，後端會退回活動層級的預設風格。
      body: JSON.stringify({ image, sessionId: previewSessionId, styleId: selectedStyleId }),
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
    ...(body.pixelParts && { pixelParts: body.pixelParts }),
  };
  // previewPng 優先：確認頁把角色放進 74vh 的直式框，手機 dpr=3 時顯示高度
  // 接近 2000 實際像素，而 fullPng 是為場上渲染縮過的貼圖（1024），
  // 在這裡會被放大近兩倍。previewPng 是模型輸出的原始尺寸，專供這一頁。
  // 舊版伺服器沒有這個欄位，因此保留 fullPng 作為後備。
  const shot = body.previewPng || body.fullPng;
  if (shot) $('#scan-result').src = shot;
  // 接著換成場上實際的樣子（兩頭身的像素角色）：確認的應該是等一下
  // 出現在大螢幕上的那個角色，而不是轉換前的原圖
  const confirming = pendingScanConfig;
  avatarPortrait(confirming).then((c) => {
    if (pendingScanConfig !== confirming) return;   // 期間已經重拍
    $('#scan-result').src = c.toDataURL();
    $('.scan-stage')?.classList.add('is-pixel');
  });
  showScanDone();
}

/**
 * 失敗畫面：保留重試的機會，而不是逕自把人踢回捏臉。
 *
 * 降級到捏臉是刻意保留的保底路徑（整合計畫 §3.5），但「自動降級」與
 * 「讓使用者選」是兩回事 —— 等了 25 秒換來一句 toast 然後被丟去捏臉，
 * 挫折感遠大於再按一次重拍。
 */
function showScanFailure(message, hint = '', opts = {}) {
  stopPersonaDuringScan();
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
  too_busy: '排隊的人太多了。',
  rate_limited: '太快連續拍照了，稍等一下。',
  photo_too_large: '照片檔案太大。',
  generation_timeout: '生成等太久逾時了。',
  vision_service_unavailable: '生成服務連不上。',
  imagegen_unavailable: '生成服務尚未就緒。',
  circuit_open: '生成服務暫時過載。',
  // 402：等一下不會好，要有人去儲值。寫明「通知工作人員」，現場才不會一直重拍
  insufficient_credits: '生成額度用完了，請通知工作人員。',
  no_person: '照片裡沒有偵測到人。',
};

/**
 * 生成進度提示。
 *
 * 後端沒有回報真實進度，這裡是依實測耗時（約 25 秒）推進的估計值，
 * 因此刻意在 92% 前停住 —— 進度條先滿了卻還沒好，比沒有進度條更糟。
 *
 * 人多時會先排隊（server/generateQueue.js）。排隊期間進度條不動、改顯示
 * 前面還有幾人；輪到時才從頭開始跑那 25 秒。排隊時照樣跑「約需 25 秒」
 * 的話，排第 20 位的人會看著進度條停在 92% 好幾分鐘，以為系統壞了。
 *
 * @returns {{stop: () => void, setQueue: (q: {ahead: number, etaSec: number}|null) => void}}
 */
function startScanProgress() {
  const STEPS = [
    [0, '正在分析服裝特徵…'],
    [22, '正在辨識臉部特徵…'],
    // 不提任何特定風格：參與者可能選了像素或皮克斯，寫「樂高積木」
    // 會讓人以為自己的選擇沒被採用。
    [45, 'AI 正在畫出你的角色…'],
    [68, '上色與細節修飾中…'],
    [86, '即將完成，準備登場…'],
  ];
  // 等待時的提示。每一則的通關路徑上都有「跟另一個人講話」這一步 ——
  // 這件作品要的不是參與者操控角色，而是操控角色的人彼此開始交流
  // （見 docs/notes/INTERACTION-DESIGN.md 的判準）。單純的小知識或
  // 進度文案會讓人繼續低頭，那正是現場最不需要的東西。
  const TIPS = [
    '抬頭看看旁邊的人今天穿什麼顏色 —— 待會的任務用得上。',
    '問問旁邊的人是第幾個進場的。',
    '看看大螢幕，猜猜哪一個角色是你旁邊那個人。',
    '待會可以找人交換編號配對，先想好要找誰。',
    '問問身邊的人，他的角色被生成成什麼樣子。',
  ];

  const bar = $('#scan-progress');
  const statusEl = $('#scan-status');
  const elapsedEl = $('#scan-elapsed');
  const tipEl = $('#scan-tip');
  const tipTextEl = $('#scan-tip-text');
  const tStart = Date.now();   // 提示輪播用，排隊也算在內
  let t0 = Date.now();         // 生成進度用，輪到時重設
  /** @type {{ahead: number, etaSec: number}|null} */
  let queue = null;

  // 從隨機一則開始，否則現場一整排手機會顯示同一句，看起來像罐頭
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  let lastTipAt = 0;

  const tick = setInterval(() => {
    if (queue) {
      bar.style.width = '0%';
      statusEl.textContent = queue.ahead === 0
        ? '排隊中，下一個就是你'
        : `排隊中，前面還有 ${queue.ahead} 人`;
      elapsedEl.textContent = `預計約 ${Math.max(5, queue.etaSec)} 秒後開始生成`;
    } else {
      const sec = (Date.now() - t0) / 1000;
      const pct = Math.min(92, (sec / 25) * 100);
      bar.style.width = `${pct}%`;
      const step = STEPS.filter(([p]) => pct >= p).at(-1);
      if (step) statusEl.textContent = step[1];
      elapsedEl.textContent = sec < 30
        ? `已等待 ${Math.floor(sec)} 秒　約需 25 秒`
        : `已等待 ${Math.floor(sec)} 秒　比平常久一些，請再等等`;
    }

    // 3 秒後才出現：太早跳出來會蓋過「正在分析服裝特徵」那句，
    // 讓人以為系統要他做什麼才會繼續。之後每 6 秒換一則。
    const sec = (Date.now() - tStart) / 1000;
    // 問卷在作答時不出提示：兩個都要人看，疊在一起反而都不看
    if (!personaScanActive && sec >= 3 && sec - lastTipAt >= (lastTipAt === 0 ? 0 : 6)) {
      if (tipEl) tipEl.hidden = false;
      // 答完問卷的人，結果本身就是開口的理由：每隔一則換成「找同類型的人」。
      // 問卷作答那幾題是低頭的，這一句把它接回「抬頭看人」。
      const persona = PERSONA_RESULT_MAP[personaAnswers?.resultId];
      const text = persona && tipIndex % 2 === 0
        ? `找找看身邊誰也是${persona.emoji} ${persona.name}，問問他怎麼答的。`
        : TIPS[tipIndex % TIPS.length];
      if (tipTextEl) tipTextEl.textContent = text;
      tipIndex += 1;
      lastTipAt = sec;
    }
  }, 250);

  return {
    stop() {
      clearInterval(tick);
      bar.style.width = '100%';
      // 收起提示，否則它會殘留到「確認角色」那一頁
      if (tipEl) tipEl.hidden = true;
    },
    setQueue(next) {
      if (queue && !next) t0 = Date.now();   // 剛輪到：生成的 25 秒從現在開始算
      queue = next;
    },
  };
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
 * 顯示「今天遇見了誰」。
 *
 * 這場活動真正在累積的是人與人的連結，但手機端進場後原本只有搖桿、
 * 任務與分數 —— 那份累積完全看不見。這裡把它變成參與者自己的收藏。
 * 名單不只配對：揮手、乾杯、同桌、交接籃子都算（server/encounters.js）。
 */
/** 最近一次的「今天遇見的人」，伺服器已排好序。離場之後紀念卡還要用，所以留在這裡 */
let lastPeers = [];

function renderSocialStrip(msg) {
  const strip = $('#links-strip');
  const peers = Array.isArray(msg?.peers) ? msg.peers : [];
  lastPeers = peers;
  if (peers.length === 0) { strip.hidden = true; return; }

  $('#ls-count').textContent = String(msg.count ?? peers.length);

  const faces = $('#ls-faces');
  faces.textContent = '';
  // 只畫前幾位（關係最實的）：手機橫幅放不下更多，而數字已經說明了總數
  for (const peer of peers.slice(0, 6)) {
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

// ── 今天認識的人與紀念卡（public/controller/keepsake.js）────────
const linksSheet = $('#links-sheet');

function openLinks() {
  const list = $('#links-list');
  list.replaceChildren();
  for (const peer of lastPeers) {
    const li = document.createElement('li');
    const face = Object.assign(document.createElement('span'), { className: 'lf' });
    if (peer.avatar) avatarPortrait(peer.avatar).then((c) => face.append(c)).catch(() => {});
    const who = Object.assign(document.createElement('span'), { className: 'lw' });
    who.append(document.createTextNode(peer.name || '（已離場）'));
    const how = encounterLabel(peer.via);
    if (how) who.append(Object.assign(document.createElement('small'), { textContent: how }));
    li.append(face, who);
    list.append(li);
  }
  $('#keepsake-msg').hidden = true;
  linksSheet.hidden = false;
  pushOverlay(linksSheet, { onEscape: closeLinks, restoreTo: $('#links-strip') });
}

function closeLinks() {
  if (linksSheet.hidden) return;
  linksSheet.hidden = true;
  popOverlay(linksSheet);
}

/** 畫紀念卡並交給系統分享或下載。兩顆按鈕（名單面板、離場頁）共用 */
async function saveTodayCard(btn, msgEl) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '製作中…';
  try {
    const card = await makeKeepsake({
      name: displayName,
      avatar: config,
      persona: PERSONA_RESULT_MAP[personaAnswers?.resultId] ?? null,
      peers: lastPeers,
    });
    const how = await saveKeepsake(card, `紀念卡-${displayName}.png`);
    if (how === 'downloaded') (msgEl ? showKeepsakeMsg : showToast)('已下載紀念卡。iPhone 會開新分頁，長按圖片即可儲存。');
  } catch {
    (msgEl ? showKeepsakeMsg : showToast)('紀念卡沒做成，請再試一次。');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function showKeepsakeMsg(text) {
  const el = $('#keepsake-msg');
  el.textContent = text;
  el.hidden = false;
}

$('#links-strip').addEventListener('click', openLinks);
$('#btn-links-close').addEventListener('click', closeLinks);
linksSheet.addEventListener('click', (e) => { if (e.target === linksSheet) closeLinks(); });
$('#btn-keepsake').addEventListener('click', (e) => saveTodayCard(e.currentTarget, $('#keepsake-msg')));
$('#btn-keepsake-farewell').addEventListener('click', (e) => saveTodayCard(e.currentTarget, null));

// ── 捏臉 ──────────────────────────────────────────────────
$('#btn-random').addEventListener('click', () => { config = randomAvatarConfig(); refresh(); });
$('#btn-prev').addEventListener('click', () => {
  if (step === 1) { showScreen('entry'); return; } // 第一步再往回即回到命名畫面
  showStep(step - 1);
});
$('#btn-next').addEventListener('click', () => {
  if (step < 3) { showStep(step + 1); return; }
  try { localStorage.setItem(LS.avatar, JSON.stringify(config)); } catch { /* 略 */ }
  // 捏臉沒有生成的等待時間，問卷改在進場前跳出（答過、略過或題目讀不到就直接進場）
  askPersonaThen(enterStage);
});

refresh();
showScreen(hasSavedCharacter() ? 'return' : 'entry');

/**
 * 上次有沒有真的進過場。
 *
 * 看 userId 而不是看 LS.avatar：refresh() 一載入就會寫 avatar，
 * 第一次來的人也有。userId 只在伺服器回 CLIENT_WELCOME 後才寫，
 * 而主動離場會清掉它 —— 離場的人本來就該從頭建立新角色。
 */
function hasSavedCharacter() {
  try {
    return !!(localStorage.getItem(LS.userId) && displayName);
  } catch { return false; }
}

if (hasSavedCharacter()) {
  // 與場上同一格像素肖像（理由見 showPortrait）：拍照角色用 renderAvatarSVG 會畫成通用角色
  showPortrait($('#return-avatar'), config);
  $('#return-name').textContent = displayName;   // 自填的名字，一律 textContent
}

// 伺服器還記得這個人（12 小時內、沒被移除）就接回同一個角色，分數與配對都在；
// 記不得也沒關係 —— CLIENT_JOIN 帶著名字與外觀，會以同樣的樣子重新建立。
$('#btn-return').addEventListener('click', enterStage);

$('#btn-new-character').addEventListener('click', () => {
  // 一定要清掉憑證：帶著舊憑證進場，伺服器會認領回舊角色、
  // 沿用舊的外觀，新拍的照片等於白拍
  try {
    retireOldCharacter(localStorage.getItem(LS.userId), localStorage.getItem(LS.rejoinToken));
    localStorage.removeItem(LS.userId);
    localStorage.removeItem(LS.rejoinToken);
  } catch { /* 略 */ }
  showScreen('entry');
  syncStartButton();
});

/**
 * 請舊角色離場。只清掉手機上的憑證的話，舊角色會以離線狀態在大螢幕上多站
 * 45 秒、佔一個名額，新角色進場後場上還會同時有兩個同名的人。
 *
 * 這時還沒進場、沒有連線，所以開一條臨時連線送完就關。失敗不用處理 ——
 * 最壞情況就是舊角色照原本的 45 秒回收。
 */
function retireOldCharacter(userId, rejoinToken) {
  if (!userId || !rejoinToken) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}`);
  sock.addEventListener('open', () => {
    sock.send(JSON.stringify({ type: EV.CLIENT_RETIRE, userId, rejoinToken }));
    sock.close();
  });
}

// ─────────────────────────────────────────────────────────────
// WebSocket 連線
// ─────────────────────────────────────────────────────────────
let ws = null;
let reconnectDelay = 500;
let joystick = null;
/** 目前的場景主題（EV.STAGE_THEME）。可能比 POV 畫布更早送達，先記下來。 */
let stageTheme = null;
/** 最近一次的手機名冊。進場時名冊常比畫布先到，畫布建立後要補套。 */
let rosterAgents = [];

function setStatus(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `pill ${cls}`;
}

/**
 * 伺服器回報的真實仲裁狀態（CLIENT_SYNC）。null 代表尚未收到。
 *
 * 宣告放在 connect() 之前：ws 的 message callback 會寫入這幾個變數，
 * 雖然 callback 實際執行時模組早已載入完畢，但把 let 留在檔案更下方
 * 等於依賴那個時序 —— 萬一有訊息在載入途中抵達就會踩進暫時死區。
 */
let serverAlpha = null;
let serverMode = null;
let lastSyncSeenAt = 0;

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
    sendMsg(EV.CLIENT_JOIN, {
      userId, rejoinToken, name: displayName, avatar: config,
      // 進場問卷的作答（沒答或略過就不帶）。伺服器依目前題目判定類型，見 server/index.js 的 applyPersona
      ...(personaAnswers && { persona: { version: personaAnswers.version, answers: personaAnswers.answers } }),
    });
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === EV.CLIENT_WELCOME) {
      // 斷線期間可能錯過 BINGO_ENDED：先把舊卡清掉。還在進行的話，
      // 伺服器在 WELCOME 之後會補送一張（sendBingoCatchUp），不會因此看不到卡
      if (bingoCard || bingoAsk) {
        bingoCard = null;
        bingoPick = null;
        clearInterval(bingoTimer);
        clearBingoAsk();
        hideBingoOffer();
        closeBingo();
        renderBingo();
      }
      // 從候補名單進場：伺服器直接送 WELCOME，不必手機重新操作
      if (closeAudienceWait()) {
        showToast('輪到你了！已經進場');
        vibrate([60, 40, 60, 40, 120]);
      }
      try {
        localStorage.setItem(LS.userId, msg.userId);
        if (msg.rejoinToken) localStorage.setItem(LS.rejoinToken, msg.rejoinToken);
      } catch { /* 略 */ }
      myId = msg.userId;
      $('#my-name').textContent = msg.name;
      $('#my-id').textContent = msg.userId;
      setStatus('已連線', 'ok');
    } else if (msg.type === EV.CLIENT_SYNC) {
      // 個人視角座標（10Hz）。畫布可能還沒建立（剛連上、尚未進場），
      // 此時直接丟棄即可 —— 下一則 100ms 後就到。
      renderer?.applySync(msg);
      // 分區以 CLIENT_SYNC 的狀態為準，而非只靠 ZONE_SELF 事件 ——
      // 重連的人已經錯過了進場那一則事件，只有狀態拿得到
      if (msg.self) renderZone(msg.self.zone);
      // α 是伺服器仲裁的真實結果，比本地計時器準確（見下方 #agency）
      serverAlpha = msg.self?.alpha ?? null;
      serverMode = msg.self?.mode ?? null;
      lastSyncSeenAt = Date.now();
    } else if (msg.type === EV.CLIENT_ROSTER) {
      // id → 名字與外觀。只在成員變動時送，供 POV 畫布畫出鄰居、標示是誰。
      rosterAgents = msg.agents ?? [];
      renderer?.setNames(rosterAgents);
    } else if (msg.type === EV.STAGE_THEME) {
      // 個人視角畫的是大螢幕同一個場景的局部，主題要跟著主辦端切換
      stageTheme = msg.theme;
      renderer?.setTheme(stageTheme);
    } else if (msg.type === EV.AUDIENCE_WAIT) {
      showAudienceWait(msg.ahead);
    } else if (msg.type === EV.CLIENT_REJECT) {
      closeAudienceWait();
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

// ── 候補名單（人滿時）────────────────────────────────────
const audienceWait = $('#audience-wait');

function showAudienceWait(ahead) {
  $('#audience-ahead').textContent = ahead > 0 ? `前面還有 ${ahead} 人` : '下一個就是你';
  setStatus('候補中', 'warn');
  if (!audienceWait.hidden) return;
  audienceWait.hidden = false;
  pushOverlay(audienceWait, { onEscape: leaveAudience });
}

/** @returns {boolean} 原本是否開著 */
function closeAudienceWait() {
  if (audienceWait.hidden) return false;
  audienceWait.hidden = true;
  popOverlay(audienceWait);
  return true;
}

/** 不等了：斷開這條連線（伺服器會把他移出名單），回到捏臉頁 */
function leaveAudience() {
  closeAudienceWait();
  if (ws) {
    ws.superseded = true;
    ws.close();
  }
  backToBuilder();
}

$('#btn-audience-leave').addEventListener('click', leaveAudience);

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

// ── 分區 ──────────────────────────────────────────────────
/** 目前顯示中的分區，避免每幀重寫 DOM */
let shownZone;

/**
 * 顯示所在分區。
 *
 * 分區原本只是地板色塊，走進去沒有任何回饋 —— 參與者不會知道
 * 「這裡跟別處不一樣」。這一行字是最低限度的提示。
 */
function renderZone(zoneId) {
  if (zoneId === shownZone) return;
  shownZone = zoneId;
  const el = $('#zone-chip');
  if (!el) return;
  const z = zoneId ? ZONE_MAP[zoneId] : null;
  el.hidden = !z;
  if (z) {
    el.textContent = `📍 ${z.label}`;
    el.style.setProperty('--zone', z.fill);
  }
}

// ── 尋寶（先知模式）──────────────────────────────────────
/**
 * 尋寶面板。
 *
 * 兩種身分的畫面刻意差很多：
 *   先知　看得到冷熱，但畫面明說「你不能自己去撿」
 *   其他人　完全沒有提示，只寫「聽先知的指令」
 * 若兩邊長得像，先知會以為自己也在找，整個玩法就散掉。
 */
/** 採收：本輪狀態與「我現在按不按得到籃子」。兩者都由伺服器說了算 */
let harvestRound = null;
let canTakeBasket = false;

/**
 * 採收面板。
 *
 * **刻意不寫家具名稱** —— 名稱只存在大螢幕的場景設定裡（換主題會變），
 * 手機再存一份必然漂移。而且這題本來就要人抬頭找地方，指向螢幕比在手機上
 * 描述位置更有用（同問卷的到場題）。
 */
function renderHarvest() {
  const box = $('#harvest-box');
  if (!box) return;
  box.hidden = !harvestRound;
  if (!harvestRound) return;

  const r = harvestRound;
  const left = r.beds.filter((b) => b.pickedBy === null).length;
  const holding = r.holder === myId;
  const iPicked = r.picked.includes(myId);
  box.classList.toggle('is-holder', holding);
  $('#harvest-left').textContent = left > 0 ? `還差 ${left} 處` : '可以送回去了';

  let hint;
  if (holding && left === 0) hint = '全部採完了！把籃子送回出發的地方。';
  else if (holding && iPicked) hint = '你這一輪採過了 —— 叫一個還沒採的人過來，請他接走籃子。';
  else if (holding) hint = '你拿著籃子。看大螢幕，走到還沒採的那一處。';
  else if (iPicked) hint = '你這一輪採過了。有人需要籃子時幫忙喊一聲。';
  else hint = '看大螢幕找籃子在誰手上，走過去跟他要。';
  $('#harvest-hint').textContent = hint;

  const btn = $('#btn-harvest');
  btn.hidden = !(holding || canTakeBasket);
  btn.textContent = holding ? '把籃子放下' : '接過籃子';
}

$('#btn-harvest')?.addEventListener('click', () => {
  if (!harvestRound) return;
  // 接的人發起，不是給的人 —— 「叫他過來」才是這個玩法要的那一步。
  // 距離由伺服器判定，手機只有搖桿，根本不知道自己在房間的哪裡。
  sendMsg(harvestRound.holder === myId ? EV.HARVEST_DROP : EV.HARVEST_TAKE);
});

function showHarvestNote(text) {
  const el = $('#harvest-hint');
  if (!el) return;
  el.textContent = text;
}

function renderTreasure(round) {
  const box = $('#treasure-box');
  if (!box) return;
  box.hidden = !round;
  if (!round) return;

  box.classList.toggle('is-prophet', isProphet);
  $('#treasure-role').textContent = isProphet ? '🔮 你是先知' : '🔍 尋寶中';
  $('#treasure-hint').textContent = isProphet
    ? '只有你看得到冷熱。大聲喊出來，帶大家過去 —— 你自己撿不算分。'
    : '你看不到提示。聽先知喊的方向走。';
  $('#treasure-heat').textContent = isProphet ? '等待中…' : '—';
  $('#treasure-heat').hidden = !isProphet;
}

function renderHeat(id) {
  const h = HEAT_MAP[id];
  if (!h) return;
  const el = $('#treasure-heat');
  el.textContent = `${h.glyph} ${h.label}`;
  el.style.setProperty('--heat', h.color);
  // 震動只是加分項：iOS 完全不支援，因此顏色與文字本身已經足夠傳達
  if (id === 'BURNING') navigator.vibrate?.(60);
}

function showTreasureResult(text) {
  showToast(text);
}

// ─────────────────────────────────────────────────────────────
// 人物賓果（server/bingo.js）
// ─────────────────────────────────────────────────────────────
// 卡是私人的：條件寫在自己手機上，要找的人得自己去問。
// 填格用的是對方的配對碼 —— 與配對任務同一組碼，因此也受同一份冷卻限制。

/** @type {{cells: {label: string, filled: boolean, name: string|null}[], lines: number}|null} */
let bingoCard = null;
let bingoDeadline = null;
let bingoPick = null;
let bingoTimer = null;
const bingoSheet = $('#bingo-sheet');
const bingoInput = $('#bingo-input');

// ── 開局的自我介紹（shared/bingoFacts.js）──
/** @type {{facts: {id: string, text: string}[], deadline: number, sent: boolean}|null} */
let bingoAsk = null;
let bingoAskTimer = null;
const bingoAskSheet = $('#bingo-ask-sheet');

function openBingoAsk() {
  if (!bingoAsk) return;
  renderBingoAsk();
  if (!bingoAskSheet.hidden) return;
  bingoAskSheet.hidden = false;
  pushOverlay(bingoAskSheet, { onEscape: closeBingoAsk, restoreTo: $('#bingo-banner') });
}

function closeBingoAsk() {
  if (bingoAskSheet.hidden) return;
  bingoAskSheet.hidden = true;
  popOverlay(bingoAskSheet);
}

function renderBingoAsk() {
  const box = $('#bingo-facts');
  // 已經畫過就只更新狀態，不要重建（重建會把勾到一半的選擇洗掉）
  if (box.dataset.round !== String(bingoAsk.key)) {
    box.dataset.round = String(bingoAsk.key);
    box.replaceChildren(...bingoAsk.facts.map((f) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'bingo-fact', textContent: f.text });
      b.dataset.id = f.id;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      });
      return b;
    }));
  }
  $('#btn-bingo-facts-done').textContent = bingoAsk.sent ? '改好了，重新送出' : '好了';
}

function tickBingoAsk() {
  if (!bingoAsk) return;
  const left = Math.max(0, Math.ceil((bingoAsk.deadline - Date.now()) / 1000));
  $('#bingo-ask-timer').textContent = bingoAsk.sent
    ? `已送出，等大家答完就發卡（最多 ${left} 秒）`
    : `${left} 秒後發卡，沒勾的就當作都不符合`;
}

function clearBingoAsk() {
  bingoAsk = null;
  clearInterval(bingoAskTimer);
  closeBingoAsk();
}

$('#btn-bingo-facts-done').addEventListener('click', () => {
  if (!bingoAsk) return;
  const yes = [...$('#bingo-facts').querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.id);
  sendMsg(EV.BINGO_FACTS, { yes });
  bingoAsk.sent = true;
  renderBingoAsk();
  tickBingoAsk();
  vibrate(20);
  closeBingoAsk();
  renderBingo();
});
$('#btn-bingo-ask-close').addEventListener('click', closeBingoAsk);
bingoAskSheet.addEventListener('click', (e) => { if (e.target === bingoAskSheet) closeBingoAsk(); });

// ── 「順便填」：剛把你填進賓果的人，也符合你卡上空著的一格 ──
let bingoOfferTimer = null;
function showBingoOffer(byName, label) {
  $('#bingo-offer-text').textContent = `${byName || '對方'}是「${label}」`;
  $('#bingo-offer').hidden = false;
  clearTimeout(bingoOfferTimer);
  // 比伺服器的 OFFER_TTL_MS（90 秒）早收：按下去才說過期，比看不到按鈕更讓人困惑
  bingoOfferTimer = setTimeout(hideBingoOffer, 60_000);
}
function hideBingoOffer() {
  $('#bingo-offer').hidden = true;
  clearTimeout(bingoOfferTimer);
}
$('#btn-bingo-accept').addEventListener('click', () => {
  sendMsg(EV.BINGO_ACCEPT, {});
  hideBingoOffer();
});

const BINGO_ERROR_TEXT = {
  NO_ROUND: '這一輪已經結束了。',
  NO_CARD: '你還沒有賓果卡，稍等一下再試。',
  BAD_CELL: '請先點選要填的那一格。',
  FILLED: '這一格已經填過了。',
  SELF: '不能填自己喔。',
  USED: '這個人在你卡上已經填夠多格了，去找別人吧。',
  NO_OFFER: '這次的「順便填」已經過期了，請直接輸入他的配對碼。',
  ACT_ONLY: '這一格要真的一起做到才會自動填上，不能輸碼。',
  MISMATCH: '這個人不符合這一格的條件，再問問別人。',
  NOT_FOUND: '查無這組配對碼，請對方再唸一次（碼每分鐘會換）。',
  COOLDOWN: '慢一點，等 3 秒再送。',
};

function renderBingo() {
  const banner = $('#bingo-banner');
  if (!bingoCard) {
    // 開局還在勾自我介紹：橫幅先出來，點了打開勾選畫面
    banner.hidden = !bingoAsk;
    if (bingoAsk) {
      $('#bingo-prog').textContent = bingoAsk.sent ? '等發卡' : '準備中';
      $('#bingo-banner-hint').textContent = bingoAsk.sent ? '已送出自我介紹，等大家答完就發卡' : '先勾一下符合你的自我介紹　·　點此打開';
    }
    return;
  }
  $('#bingo-banner-hint').textContent = '找符合條件的人、問他的配對碼　·　點此打開賓果卡';
  const filled = bingoCard.cells.filter((c) => c.filled).length;
  banner.hidden = false;
  $('#bingo-prog').textContent = `${filled} / 9${bingoCard.lines ? `　連線 ${bingoCard.lines}` : ''}`;
  $('#bingo-mycode').textContent = myCode;

  const grid = $('#bingo-grid');
  grid.replaceChildren();
  bingoCard.cells.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `bingo-cell${c.filled ? ' filled' : ''}`;
    btn.setAttribute('aria-pressed', String(bingoPick === i));
    if (c.filled) {
      btn.disabled = true;
      btn.append(
        Object.assign(document.createElement('span'), { className: 'who', textContent: c.name || '已填' }),
        Object.assign(document.createElement('span'), { className: 'cond', textContent: c.label }),
      );
    } else if (c.auto) {
      // 「一起做一件事」：不給輸碼，做到了伺服器會自動填上
      btn.classList.add('auto');
      btn.append(
        Object.assign(document.createElement('span'), { className: 'cond', textContent: c.label }),
        Object.assign(document.createElement('span'), { className: 'hint', textContent: '一起做到就自動填上' }),
      );
      btn.addEventListener('click', () => showBingoMsg('這一格不用輸碼：找個人一起做到，就會自動填上。'));
    } else {
      btn.textContent = c.label;
      btn.addEventListener('click', () => pickBingoCell(i));
    }
    grid.append(btn);
  });
}

function pickBingoCell(i) {
  bingoPick = i;
  $('#bingo-msg').hidden = true;
  $('#bingo-entry-label').textContent = `「${bingoCard.cells[i].label}」：輸入他的配對碼`;
  $('#bingo-entry').hidden = false;
  bingoInput.value = '';
  renderBingo();
  setTimeout(() => bingoInput.focus(), 50);
}

function showBingoMsg(text) {
  const el = $('#bingo-msg');
  el.textContent = text;
  el.hidden = !text;
}

function openBingo() {
  if (!bingoCard) { openBingoAsk(); return; }
  bingoSheet.hidden = false;
  renderBingo();
  pushOverlay(bingoSheet, { onEscape: closeBingo, restoreTo: $('#bingo-banner') });
}

function closeBingo() {
  if (bingoSheet.hidden) return;
  bingoSheet.hidden = true;
  bingoInput.blur();
  popOverlay(bingoSheet);
}

function tickBingoTimer() {
  const el = $('#bingo-timer');
  if (!bingoDeadline) { el.textContent = ''; return; }
  const left = Math.max(0, bingoDeadline - Date.now());
  el.textContent = `剩 ${Math.floor(left / 60000)} 分 ${String(Math.floor(left / 1000) % 60).padStart(2, '0')} 秒`;
}

$('#bingo-banner').addEventListener('click', openBingo);
$('#btn-bingo-close').addEventListener('click', closeBingo);
bingoSheet.addEventListener('click', (e) => { if (e.target === bingoSheet) closeBingo(); });
bingoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#btn-bingo-submit').click(); }
});
$('#btn-bingo-submit').addEventListener('click', () => {
  const code = bingoInput.value.trim();
  if (bingoPick === null) { showBingoMsg(BINGO_ERROR_TEXT.BAD_CELL); return; }
  if (!/^\d{4}$/.test(code)) { showBingoMsg('配對碼是 4 位數字。'); return; }
  sendMsg(EV.BINGO_CLAIM, { cell: bingoPick, code });
});

/** @returns {boolean} 是否處理了這則訊息 */
function handleBingoMessage(msg) {
  switch (msg.type) {
    case EV.BINGO_ASK:
      bingoAsk = {
        key: Date.now(), facts: Array.isArray(msg.facts) ? msg.facts : [],
        deadline: Date.now() + (msg.remainingMs ?? 30_000), sent: false,
      };
      clearInterval(bingoAskTimer);
      bingoAskTimer = setInterval(tickBingoAsk, 1000);
      tickBingoAsk();
      // 主持人剛宣布開始，大家都在看手機：直接打開，不要讓人找橫幅
      openBingoAsk();
      vibrate([30, 40, 30]);
      renderBingo();
      return true;

    case EV.BINGO_CARD:
      if (bingoAsk) {
        const wasOpen = !bingoAskSheet.hidden;
        clearBingoAsk();
        if (wasOpen || !bingoCard) showToast('賓果卡發下來了！點上方的橫幅打開');
      }
      bingoCard = msg.card;
      bingoDeadline = msg.remainingMs == null ? null : Date.now() + msg.remainingMs;
      clearInterval(bingoTimer);
      if (bingoDeadline) bingoTimer = setInterval(tickBingoTimer, 1000);
      tickBingoTimer();
      renderBingo();
      return true;

    case EV.BINGO_RESULT:
      if (msg.ok && msg.auto) {
        // 一起做到而自動填上：只提示，不動輸碼欄 —— 使用者可能正在輸別格的碼
        vibrate([30, 40, 30]);
        showToast(msg.full ? '全卡完成！🎉'
          : msg.newLines ? `連成一線！和 ${msg.name} 一起做到了`
          : `和 ${msg.name} 一起做到了，賓果自動填上一格`);
        return true;
      }
      if (msg.ok) {
        bingoPick = null;
        $('#bingo-entry').hidden = true;
        showBingoMsg('');
        vibrate([30, 40, 30]);
        showToast(msg.full ? '全卡完成！🎉'
          : msg.newLines ? `連成一線！和 ${msg.name} 填好了`
          : `填好了：${msg.name}`);
      } else {
        showBingoMsg(BINGO_ERROR_TEXT[msg.reason] ?? '沒填成功，請再試一次。');
      }
      return true;

    case EV.BINGO_TAGGED:
      // 被填的人知道「剛剛那個人原來在玩賓果」—— 通常就是下一段對話的開頭
      showToast(`${msg.byName} 把你填進了賓果：「${msg.label}」`);
      vibrate([20, 60, 20]);
      // 他也符合我卡上空著的一格：給一顆按鈕，按下去就填上
      if (msg.offer?.label && bingoCard) showBingoOffer(msg.byName, msg.offer.label);
      return true;

    case EV.BINGO_ENDED:
      clearBingoAsk();
      hideBingoOffer();
      bingoCard = null;
      bingoPick = null;
      clearInterval(bingoTimer);
      closeBingo();
      renderBingo();
      showToast(msg.winners?.length ? `賓果結束！${msg.winners.join('、')} 最多連線` : '賓果結束！');
      return true;

    default:
      return false;
  }
}

function handleMissionMessage(msg) {
  // 問答與積分自成一組，先讓它們處理；沒接走的才往下當任務訊息
  if (handleQuizMessage(msg)) return;
  if (handleBingoMessage(msg)) return;

  switch (msg.type) {
    case EV.TOPIC_CARD:
      showTopic(msg);
      return;

    case EV.GREET_INVITE:
      showGreetInvite(msg.fromId, msg.fromName);
      return;

    case EV.GREET_RESULT:
      showGreetResult(msg);
      return;

    case EV.PAIR_CODE:
      myCode = msg.code;
      renderMission();
      // 賓果卡上也印著自己的碼（別人要填你時用），每分鐘輪換時要跟著換
      renderBingo();
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

    case EV.MSG_RESULT:
      onMessageResult(msg);
      break;

    case EV.MSG_RECEIVE:
      if (msg.message) receiveMessage(msg.message);
      break;

    case EV.MSG_BLOCKS:
      setBlocked(msg.userIds);
      break;

    case EV.PAIR_RESULT:
      handlePairResult(msg);
      break;

    // ── 採水果（籃子接力）────────────────────────────────
    case EV.HARVEST_STATE:
      harvestRound = msg.round;
      if (!msg.round) canTakeBasket = false;
      renderHarvest();
      break;

    case EV.HARVEST_REACH:
      canTakeBasket = !!msg.canTake;
      if (msg.note) showHarvestNote(msg.note);
      renderHarvest();
      break;

    case EV.HARVEST_DONE:
      harvestRound = null;
      canTakeBasket = false;
      renderHarvest();
      showToast(msg.helpers.includes(myId)
        ? `採收完成！你也有出力　+${msg.points} 分`
        : `${msg.helperNames.join('、')} 把籃子送回去了`);
      break;

    // ── 尋寶 ──────────────────────────────────────────────
    case EV.TREASURE_START:
      isProphet = msg.round.prophetId === myId;
      renderTreasure(msg.round);
      break;

    case EV.TREASURE_HEAT:
      // 只有先知會收到這則訊息（伺服器單獨送給他），
      // 其他人的手機上不會有任何冷熱資訊 —— 這是玩法的核心。
      renderHeat(msg.heat);
      break;

    case EV.TREASURE_FOUND:
      showTreasureResult(
        msg.by === myId
          ? `你找到寶藏了！　+${msg.points} 分`
          : `${msg.byName} 找到了寶藏（先知 ${msg.prophetName}）`,
      );
      isProphet = false;
      renderTreasure(null);
      break;

    case EV.TREASURE_ENDED:
      isProphet = false;
      renderTreasure(null);
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
  pushOverlay(sheet, { onEscape: closeSheet, restoreTo: banner });
  setTimeout(() => pairInput.focus(), 80);
}
function closeSheet() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  pairInput.blur();
  popOverlay(sheet);
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
  showPortrait($('#pair-confirm-avatar'), msg.avatar);
  confirmPair.hidden = false;
  // Esc 一律當成「不是這個人」：這是對方發起的，靜默關掉會讓對方一直等。
  pushOverlay(confirmPair, {
    onEscape: () => $('#btn-pair-decline').click(),
  });
  $('#btn-pair-accept').focus();
}
function closeConfirmPair() {
  if (confirmPair.hidden) return;
  confirmPair.hidden = true;
  popOverlay(confirmPair);
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
const openConfirm = () => {
  confirmBox.hidden = false;
  pushOverlay(confirmBox, { onEscape: closeConfirm, restoreTo: $('#btn-exit') });
  // 預設焦點放在「取消」而非「確定離開」：這是破壞性操作，
  // 不該讓一個 Enter 就把人送出場。
  $('#btn-cancel-exit').focus();
};
const closeConfirm = () => {
  if (confirmBox.hidden) return;
  confirmBox.hidden = true;
  popOverlay(confirmBox);
};

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
  // 賓果卡也要收：漏關任何一層，#app 的 inert 解不開，離場畫面就不能操作（UI-STYLING）
  bingoCard = null;
  bingoPick = null;
  clearInterval(bingoTimer);
  closeBingo();
  renderBingo();
  closeLinks();
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

  showPortrait($('#farewell-avatar'), config);
  showScreen('farewell');
});

$('#btn-rejoin').addEventListener('click', () => {
  hasLeft = false;
  reconnectDelay = 500;
  // 重新進場是全新的角色：上一個角色認識的人不能留在新角色的名單與紀念卡上
  renderSocialStrip({ peers: [] });
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
/** 上次真的送出 INPUT_MOVE 的時間，供節流與「第一幀立即送出」協調 */
let lastSentAt = 0;

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
  // 角色站在搖桿區的中央；主題可能在畫布建立前就已送達
  renderer.setAnchorElement($('#joystick-zone'));
  if (stageTheme) renderer.setTheme(stageTheme);
  if (rosterAgents.length) renderer.setNames(rosterAgents);
  renderer.start();
}

/**
 * 搖桿擺在哪裡：直式、橫式都在左下角。
 * 原本在搖桿區正中央，而角色也站在那裡 —— 推桿的手指與搖桿底座正好蓋住自己的臉。
 * 直式曾經放在正中間下方，但手機直拿時那仍在畫面正中、擋住角色腳下與前方的路；
 * 左下角則是左手拇指自然的位置，右手留給表情鍵（直式在下方一排、橫式在右側一欄）。
 */
const landscapeQuery = matchMedia('(orientation: landscape)');
function joystickPosition() {
  return landscapeQuery.matches
    ? { left: '96px', top: 'calc(100% - 96px)' }
    : { left: '84px', top: 'calc(100% - 84px)' };
}
// 轉向時重建：nipplejs 的 static 位置在建立時就固定了
landscapeQuery.addEventListener('change', () => {
  if (!joystick) return;
  joystick.destroy();
  joystick = null;
  initJoystick();
});

function initJoystick() {
  if (joystick) return;
  joystick = nipplejs.create({
    zone: $('#joystick-zone'),
    mode: 'static',
    position: joystickPosition(),
    color: '#3A2E27',
    size: 130,
    restJoystick: true,
  });

  joystick.on('move', (_evt, data) => {
    if (!data?.vector) return;
    // nipplejs 的 y 軸向上為正，場域座標則向下為正，故取負號對齊
    joyVec = { x: data.vector.x, y: -data.vector.y };
    joyIntensity = Math.min(1, data.force ?? 0);
    const first = !joyEngaged;
    joyEngaged = true;
    lastInputAt = Date.now();
    renderer?.setInput(joyVec, joyIntensity);

    // 按下的第一幀立刻送出，不等節流計時器。
    //
    // 20Hz 節流的下一格最遠在 50ms 之後，而那 50ms 正好落在使用者
    // 最期待回應的瞬間（手指剛碰到搖桿）。後續的連續推桿仍走節流，
    // 因此頻寬幾乎不變 —— 只多了每次觸碰的第一則封包。
    if (first) sendInput();
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

function sendInput() {
  sendMsg(EV.INPUT_MOVE, { vector: joyVec, intensity: joyIntensity });
  lastSentAt = Date.now();
}

// 20 Hz 節流發送（技術文件 M1 §操控輸入發送規格）。
// 僅在推桿期間發送，閒置時保持靜默以節省現場無線頻寬。
//
// 帶上 lastSentAt 檢查是為了配合「第一幀立即送出」：
// 剛在 move 事件送過的話，這一格就跳過，避免兩則封包擠在一起。
setInterval(() => {
  if (!joyEngaged) return;
  if (Date.now() - lastSentAt < INPUT_THROTTLE_MS / 2) return;
  sendInput();
}, INPUT_THROTTLE_MS);

// ── 話題桌（server/topics.js）──────────────────────────────
// 跟同一桌的人拿到同一題。題目是要念出來跟旁邊的人聊的，不是作答 ——
// 所以不給輸入框，只給一句「和誰同桌」，提醒他抬頭找人。
let topicTimer = null;

function showTopic(msg) {
  $('#topic-head').textContent = `💬 ${msg.spot ?? '話題桌'}的話題`;
  $('#topic-q').textContent = msg.question;
  $('#topic-with').textContent = msg.withNames?.length ? `和 ${msg.withNames.join('、')} 同桌，聊聊看` : '';
  $('#topic-card').hidden = false;
  vibrate([20, 40, 20]);
  clearTimeout(topicTimer);
  topicTimer = setTimeout(hideTopic, 25_000);
}

function hideTopic() {
  clearTimeout(topicTimer);
  $('#topic-card').hidden = true;
}

$('#topic-card').addEventListener('click', hideTopic);

// ── 揮手與乾杯的回應（server/greetings.js）─────────────────
//
// 揮手要對方回揮、乾杯要兩人一起按才算數。這裡只負責顯示：
// 誰在跟你揮手、你揮出去了沒、碰杯成功沒。

let greetFrom = null;
let greetTimer = null;

function showGreetInvite(fromId, fromName) {
  greetFrom = fromId;
  $('#greet-text').textContent = `${fromName || '有人'} 在跟你揮手`;
  $('#greet-invite').hidden = false;
  vibrate([60, 60, 60]);
  clearTimeout(greetTimer);
  // 與伺服器的 GREET.waveWindowMs 相同：過了這個時間回揮也不算數了
  greetTimer = setTimeout(hideGreetInvite, 8000);
}

function hideGreetInvite() {
  greetFrom = null;
  $('#greet-invite').hidden = true;
  clearTimeout(greetTimer);
}

$('#btn-wave-back').addEventListener('click', () => {
  if (!greetFrom) return;
  sendMsg(EV.INPUT_ACTION, { action: 'WAVE', target: greetFrom });
  vibrate([30, 40, 30]);
  hideGreetInvite();
});

const GREET_TEXT = {
  WAVE: {
    [GREET_OUTCOME.SENT]: (n) => `你向 ${n} 揮手了，等對方回揮`,
    [GREET_OUTCOME.MUTUAL]: (n) => `你和 ${n} 打了招呼 👋`,
    [GREET_OUTCOME.NOBODY]: () => '身邊沒有人，走近一點再揮手',
  },
  CHEERS: {
    [GREET_OUTCOME.WAITING]: () => '找身邊的人一起按乾杯！3 秒內',
    [GREET_OUTCOME.CLINK]: (n) => `和 ${n} 碰杯 🍻`,
    [GREET_OUTCOME.NOBODY]: () => '身邊沒有人可以碰杯，走近一點',
  },
};

function showGreetResult(msg) {
  const text = GREET_TEXT[msg.kind]?.[msg.outcome];
  if (!text) return;
  const done = msg.outcome === GREET_OUTCOME.MUTUAL || msg.outcome === GREET_OUTCOME.CLINK;
  if (done) {
    hideGreetInvite();
    vibrate([40, 30, 40, 30, 80]);
  }
  showToast(text(msg.otherName || '對方'), done ? 3200 : 2400);
}

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
    const sync = () => {
      btn.setAttribute('aria-pressed', String(hapticsOn));
      // 文字說明「按下去會發生什麼」，而不是只標示目前狀態。
      // 單看「震動」兩個字，使用者無從判斷那是開關還是現在的狀態。
      btn.textContent = hapticsOn ? '震動 開' : '震動 關';
    };
    sync();

    // 第一次進場時讓開關搏動幾下。腳步震動是沉浸感最強的一環，
    // 但預設關閉（電池與體感疲勞的取捨），不主動指出就幾乎不會有人發現。
    // 只做一次並記住 —— 每次進場都閃會變成噪音。
    let hinted = true;
    try { hinted = localStorage.getItem(HAPTICS_HINT_KEY) === 'seen'; } catch { /* 略 */ }
    if (!hinted && !hapticsOn) {
      btn.classList.add('nudge');
      setTimeout(() => btn.classList.remove('nudge'), 6000);
      try { localStorage.setItem(HAPTICS_HINT_KEY, 'seen'); } catch { /* 略 */ }
    }

    btn.addEventListener('click', () => {
      hapticsOn = !hapticsOn;
      try { localStorage.setItem(HAPTICS_KEY, hapticsOn ? 'on' : 'off'); } catch { /* 略 */ }
      sync();
      btn.classList.remove('nudge');
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

  // 優先採用伺服器的 α —— 那是控制權的真實來源。
  // 本地計時器只在還沒收到同步（剛進場）或同步中斷時當備援：
  // 兩者不一致時（例如伺服器因合照鎖定場域而收回控制權），
  // 本地計時器會顯示「你正在操控」，而角色其實動不了。
  const fresh = serverAlpha !== null && Date.now() - lastSyncSeenAt < 1000;
  const active = fresh
    ? serverAlpha > 0.5
    : Date.now() - lastInputAt < IDLE_THRESHOLD_MS;

  el.classList.toggle('active', active);

  // STAGED 代表場域被鎖定（正在拍大合照），此時推桿不會有任何效果 ——
  // 不說清楚的話，使用者會以為是自己的手機壞了。
  if (fresh && serverMode === 'STAGED') {
    el.textContent = '正在拍大合照，請看大螢幕';
  } else {
    el.textContent = active ? '你正在操控' : '推動搖桿移動・點別人的角色可以傳訊息';
  }
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
  showPortrait($('#mini-avatar'), config);
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
/** 目前面板上是哪一種題目：'QUIZ'（有正解、計分）或 'SURVEY'（問卷，可改答案） */
let askKind = 'QUIZ';
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
  // 問答沒有 onEscape：它由伺服器控制開始與結束，使用者不能自己關掉。
  // 但仍要 pushOverlay —— 否則 Tab 會穿過去按到底下的搖桿與表情鍵。
  pushOverlay(quizPanel);
  // 進入問答時鬆開搖桿：角色交還給 Boids，不會停在最後的推桿方向上
  if (joyEngaged) {
    joyEngaged = false;
    sendMsg(EV.INPUT_MOVE, { vector: { x: 0, y: 0 }, intensity: 0 });
  }
}

function closeQuiz() {
  if (!quizPanel.hidden) popOverlay(quizPanel);
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
      if (i === revealed) btn.style.borderColor = '#3A2E27';
    } else if (locked) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        // 先在本地鎖定，不等伺服器回應 —— 現場網路有延遲，
        // 按下去沒有立即反應會讓人以為沒按到而狂點
        myChoice = i;
        if (askKind === 'SURVEY') {
          // 問卷沒有正解也沒有速度分，因此**允許改**：按錯卻不能改，
          // 那個人身上的標籤就會一直是錯的，而標籤正是問卷的產物。
          renderQuizOptions();
          showQuizMsg('已記錄，想改隨時可以再選。');
          sendMsg(EV.SURVEY_ANSWER, { choice: i });
        } else {
          renderQuizOptions({ locked: true });
          showQuizMsg('已送出，等待公布答案…');
          sendMsg(EV.QUIZ_ANSWER, { choice: i });
        }
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
    el.classList.toggle('urgent', left < 5000 && quiz?.phase !== QUIZ_PHASE.DISCUSS);
    if (left <= 0) {
      clearInterval(quizTimer);
      quizTimer = null;
      // 討論結束時不說「時間到」：伺服器馬上會重送題目、解鎖選項
      if (quiz?.phase === QUIZ_PHASE.DISCUSS) showQuizMsg('開始作答！');
      else if (myChoice === null) showQuizMsg('時間到，等待公布答案…');
    }
  };
  tick();
  quizTimer = setInterval(tick, 100);
}

/** 這一題要不要走到地點、自己到了沒。只影響手機上那一行提示。 */
let surveyNeedsArrival = false;
let surveyArrived = false;
let lastSurveyLabel = '';

/**
 * 作答之後那一行提示。
 *
 * 不寫家具名稱，而是叫人看大螢幕上同名的那個標記 —— 家具的顯示名稱只存在於
 * 大螢幕的場景設定裡（換主題會變），手機再存一份必然漂移。而且這題本來就要
 * 人抬頭看大螢幕才找得到地方，指向螢幕比在手機上描述位置更有用。
 */
function showSurveyAck(label, arrived) {
  lastSurveyLabel = label ?? lastSurveyLabel;
  if (!surveyNeedsArrival) {
    showQuizMsg(`已記錄：${lastSurveyLabel}　想改隨時可以再選`);
    return;
  }
  showQuizMsg(arrived
    ? `已到位 ✓　你站在「${lastSurveyLabel}」那一圈裡了`
    : `已選「${lastSurveyLabel}」—— 看大螢幕，走到同名的那一圈才算完成`);
}

function showQuestion(q, kind = 'QUIZ') {
  // 問答的 options 是字串，問卷的是 {label, value, spot} 物件。
  // 這裡統一攤成字串再交給共用的選項渲染 —— 少了這一步，
  // 問卷的四個選項會全部顯示成 [object Object]，而且不會有任何錯誤。
  quiz = kind === 'SURVEY'
    ? { ...q, options: q.options.map((o) => (typeof o === 'string' ? o : o.label)) }
    : q;
  askKind = kind;
  myChoice = null;
  // 新題目把上一題的到位狀態清掉，否則上一題「已到位 ✓」會留在畫面上
  surveyNeedsArrival = kind === 'SURVEY' && !!q.requireArrival;
  surveyArrived = false;
  lastSurveyLabel = '';
  $('#quiz-no').textContent = kind === 'SURVEY' ? `問卷 ${q.index}` : `第 ${q.index} 題`;
  $('#quiz-q').textContent = q.question;
  $('#quiz-result-card').hidden = true;
  $('#btn-quiz-hide').hidden = true;
  // 討論時間：選項先亮出來但鎖住。這段時間要的是轉頭跟旁邊的人商量，
  // 不是盯著手機 —— 提示寫在最顯眼的那一行
  const talking = kind === 'QUIZ' && q.phase === QUIZ_PHASE.DISCUSS;
  showQuizMsg(talking ? '先跟身邊的人討論！倒數結束才能作答' : '');
  $('#quiz-timer').classList.toggle('talk', talking);
  renderQuizOptions({ locked: talking });
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
  [QUIZ_ERRORS.NOT_YET]: '還在討論時間，等倒數結束再作答。',
};

/**
 * 問卷收題。
 *
 * 刻意不在手機上顯示全場分佈 —— 那是大螢幕的工作（見規劃：手機是私人資訊、
 * 大螢幕是公共資訊）。手機只留下「你自己選了什麼」。
 */
function showSurveyClosed(result) {
  if (!quiz || quiz.id !== result.id) return;
  clearInterval(quizTimer);
  quizTimer = null;
  $('#quiz-timer').textContent = '—';
  $('#quiz-timer').classList.remove('urgent');
  renderQuizOptions({ locked: true });
  showQuizMsg(myChoice === null ? '這題沒作答。' : '已記錄，看大螢幕。');
  $('#btn-quiz-hide').hidden = false;
}

function handleQuizMessage(msg) {
  switch (msg.type) {
    case EV.SURVEY_QUESTION:
      showQuestion(msg.survey, 'SURVEY');
      return true;

    case EV.SURVEY_ACK:
      if (msg.ok) {
        // 伺服器回傳的標籤文字才是權威值（例如「負責煮」），
        // 而且重連補送時這是唯一能還原「我剛才選了什麼」的來源
        myChoice = msg.choice;
        surveyNeedsArrival = !!msg.requireArrival;
        renderQuizOptions();
        showSurveyAck(msg.label, !!msg.arrived);
      } else {
        myChoice = null;
        surveyNeedsArrival = false;
        renderQuizOptions();
        showQuizMsg(msg.reason === 'CLOSED' ? '時間到了，這題已經截止。' : '這次作答沒有被接受。');
      }
      return true;

    // 要到場才算的題目：人走進／走出自己選的那一圈時伺服器會通知。
    case EV.SURVEY_ARRIVED:
      surveyArrived = !!msg.arrived;
      showSurveyAck(lastSurveyLabel, surveyArrived);
      return true;

    case EV.SURVEY_CLOSED:
      showSurveyClosed(msg.result);
      return true;

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

// ─────────────────────────────────────────────────────────────
// 私訊：點手機畫面上別人的角色，傳一句話給對方
// ─────────────────────────────────────────────────────────────
// 畫布本身是 pointer-events:none 的背景層，蓋在上面的是搖桿區 —— 而搖桿是 static 模式，
// 搖桿區裡任何一點按下去都會被 nipplejs 接走、角色朝那個方向衝一下。
// 因此在捕獲階段先攔：點到角色就自己處理並擋下事件，沒點到才放行給搖桿。
// 三種事件都要擋：nipplejs 依瀏覽器支援挑 pointer / touch / mouse 其中一種來聽，
// 而觸控裝置上同一下會先後觸發 pointerdown 與 touchstart。

/** 搖桿底座附近不判定點人：想走路的手指落在角色上時，走路優先 */
const JOYSTICK_GUARD_PX = 85;
let lastPickAt = 0;

function pickTarget(e) {
  if (!renderer || $('#controller').hidden) return null;
  // 只攔落在搖桿區（畫布的可點區）上的觸控；按鈕、橫幅等照常運作
  if (!e.target.closest?.('#joystick-zone') || e.target.closest('button')) return null;
  const pt = e.touches?.[0] ?? e;
  const base = document.querySelector('#joystick-zone .back')?.getBoundingClientRect();
  if (base && Math.hypot(pt.clientX - (base.left + base.width / 2), pt.clientY - (base.top + base.height / 2)) < JOYSTICK_GUARD_PX) {
    return null;
  }
  return renderer.pickAt(pt.clientX, pt.clientY);
}

for (const type of ['pointerdown', 'touchstart', 'mousedown']) {
  $('#controller').addEventListener(type, (e) => {
    const id = pickTarget(e);
    if (!id) return;
    e.stopPropagation();
    if (e.cancelable && type !== 'pointerdown') e.preventDefault();
    // 同一下觸控會依序來 pointerdown → touchstart（→ mousedown），只開一次
    if (Date.now() - lastPickAt < 600) return;
    lastPickAt = Date.now();
    openComposer(id);
  }, { capture: true, passive: false });
}

const msgSheet = $('#msg-sheet');
const msgInput = $('#msg-input');
msgInput.maxLength = DIRECT_MESSAGE.maxLength;
/** 正在寫給誰 */
let composeTo = null;
let composeSending = false;

const lookOf = (id) => rosterAgents.find((a) => a.id === id) ?? null;

function openComposer(id, { restoreTo } = {}) {
  const who = lookOf(id);
  if (!who) return;
  composeTo = id;
  composeSending = false;
  $('#msg-title').textContent = `傳訊息給 ${who.name}`;   // 自填的名字，一律 textContent
  showPortrait($('#msg-avatar'), who.look);
  msgInput.value = '';
  updateMsgCount();
  $('#msg-error').hidden = true;
  $('#btn-msg-send').disabled = true;
  msgSheet.hidden = false;
  pushOverlay(msgSheet, { onEscape: closeComposer, restoreTo });
  renderComposerBlockState();
}

/** 寫信面板依「對方是否被我封鎖」切換：封鎖中只顯示解除封鎖，不給輸入框 */
function renderComposerBlockState() {
  if (!composeTo) return;
  const blocked = blockedHere.has(composeTo);
  $('#msg-blocked').hidden = !blocked;
  $('#msg-field').hidden = blocked;
  $('#btn-msg-send').hidden = blocked;
  if (blocked) {
    $('#msg-blocked-text').textContent =
      `你已封鎖 ${lookOf(composeTo)?.name ?? '這個人'}。解除封鎖後才能傳訊息給他，也會重新收到他的訊息。`;
    $('#btn-msg-unblock').disabled = false;
    $('#btn-msg-unblock').focus();
  } else {
    msgInput.focus();
  }
}

$('#btn-msg-unblock').addEventListener('click', () => {
  if (!composeTo) return;
  $('#btn-msg-unblock').disabled = true;
  sendMsg(EV.MSG_UNBLOCK, { userId: composeTo });
  // 畫面等伺服器回 MSG_BLOCKS 才切換，與伺服器的名單保持一致
});

/** 伺服器的封鎖名單（MSG_BLOCKS）是唯一來源 */
function setBlocked(userIds) {
  const before = new Set(blockedHere);
  blockedHere.clear();
  for (const id of Array.isArray(userIds) ? userIds : []) blockedHere.add(id);
  if (composeTo && before.has(composeTo) && !blockedHere.has(composeTo)) {
    showToast(`已解除封鎖 ${lookOf(composeTo)?.name ?? ''}`.trim());
  }
  if (!msgSheet.hidden) renderComposerBlockState();
}

function closeComposer() {
  if (msgSheet.hidden) return;
  msgSheet.hidden = true;
  composeTo = null;
  popOverlay(msgSheet);
  // 寫信期間收到的訊息先排著，寫完（或取消）才接著顯示
  if (inboxQueue.length && !showing) showNextMessage();
}

function updateMsgCount() {
  const n = [...msgInput.value].length;
  $('#msg-count').textContent = `${n} / ${DIRECT_MESSAGE.maxLength}`;
  $('#btn-msg-send').disabled = composeSending || msgInput.value.trim().length === 0;
}

msgInput.addEventListener('input', updateMsgCount);
// Enter 送出、Shift+Enter 不換行（伺服器本來就會把換行剝掉，單行比較誠實）
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#btn-msg-send').click(); }
});
$('#btn-msg-close').addEventListener('click', closeComposer);
$('#btn-msg-send').addEventListener('click', () => {
  const text = msgInput.value.trim();
  if (!composeTo || !text || composeSending) return;
  composeSending = true;
  $('#btn-msg-send').disabled = true;
  sendMsg(EV.MSG_SEND, { to: composeTo, text, ref: trackSend('composer') });
});

const MSG_ERROR_TEXT = {
  [MSG_ERRORS.EMPTY]: '寫點什麼再送出吧。',
  [MSG_ERRORS.TOO_LONG]: `訊息最多 ${DIRECT_MESSAGE.maxLength} 個字。`,
  [MSG_ERRORS.NOT_FOUND]: '對方已經離開現場了。',
  [MSG_ERRORS.OFFLINE]: '對方的手機目前沒有連線，晚點再試，或直接走過去找他。',
  [MSG_ERRORS.SELF]: '那是你自己喔。',
  [MSG_ERRORS.RATE_LIMITED]: '傳太快了，等幾秒再送。',
  [MSG_ERRORS.BLOCKED]: '你封鎖了對方，要先解除封鎖才能傳訊息。',
};

/**
 * 送出中的訊息：請求編號 → 從哪裡送的（'composer' 點角色寫的、'reply' 收件畫面的回應）。
 *
 * 原本只有一個全域的 sendingFrom：從寫訊息畫面送出後、結果回來前，剛好跳出一則
 * 新訊息而他立刻回覆，第一個結果就會被當成回覆的 —— 收件畫面在回覆還沒確認前
 * 就被關掉，第二個結果則把錯誤顯示到錯的那一格。伺服器會原樣帶回 ref。
 */
const pendingSends = new Map();
let sendSeq = 0;

function trackSend(from) {
  const ref = String(++sendSeq);
  pendingSends.set(ref, from);
  // 等不到結果（連線層限流丟掉、斷線）時不能讓送出鍵永遠鎖著
  setTimeout(() => {
    if (pendingSends.has(ref)) onMessageResult({ ok: false, ref, reason: null });
  }, 8000);
  return ref;
}

function onMessageResult(msg) {
  // 已經逾時處理過的遲到結果：忽略，否則可能把他正在寫的下一則關掉
  if (msg.ref && !pendingSends.has(msg.ref)) return;
  // 舊版伺服器不帶 ref：退回「最早送出的那一則」
  const ref = msg.ref ?? pendingSends.keys().next().value;
  const from = pendingSends.get(ref) ?? null;
  pendingSends.delete(ref);
  if (from === 'reply') replySending = false;
  else composeSending = false;
  if (msg.ok) {
    showToast('訊息已送出');
    if (from === 'reply') showNextMessage();
    else if (msg.to === composeTo) closeComposer();
    return;
  }
  const text = MSG_ERROR_TEXT[msg.reason] ?? '訊息沒有送出，請再試一次。';
  const el = $(from === 'reply' ? '#reply-error' : '#msg-error');
  el.textContent = text;
  el.hidden = false;
  updateMsgCount();
  updateReplyCount();
}

// ── 收件 ──────────────────────────────────────────────────
const inbox = $('#msg-inbox');
/** 還沒看的訊息，依收到順序 */
const inboxQueue = [];
let showing = null;
/** 自己封鎖了哪些人。由伺服器的 MSG_BLOCKS 同步（進場時補送），手機重整也不會忘 */
const blockedHere = new Set();

function receiveMessage(m) {
  if (blockedHere.has(m.from)) return;
  inboxQueue.push(m);
  vibrate([20, 60, 20]);
  // 正在打字時不跳出來打斷，只震動；送出或取消後才顯示
  if (!showing && msgSheet.hidden) showNextMessage();
  else updateInboxMore();
}

function showNextMessage() {
  showing = inboxQueue.shift() ?? null;
  if (!showing) {
    if (!inbox.hidden) { inbox.hidden = true; popOverlay(inbox); }
    return;
  }
  $('#inbox-title').textContent = `${showing.fromName || '有人'} 傳訊息給你`;
  $('#inbox-text').textContent = showing.text;   // 對方自由輸入的文字，一律 textContent
  showPortrait($('#inbox-avatar'), lookOf(showing.from)?.look ?? null);
  replyInput.value = '';
  $('#reply-error').hidden = true;
  updateReplyCount();
  updateInboxMore();
  if (inbox.hidden) {
    inbox.hidden = false;
    pushOverlay(inbox, { onEscape: () => showNextMessage() });
  }
  // 焦點放在「知道了」而不是回應框：直接聚焦輸入框會在手機上立刻彈出鍵盤，
  // 蓋住對方的訊息，而多數時候人只是想看一眼
  $('#btn-inbox-close').focus();
}

function updateInboxMore() {
  const more = $('#inbox-more');
  more.hidden = inboxQueue.length === 0;
  more.textContent = `還有 ${inboxQueue.length} 則訊息`;
}

$('#btn-inbox-close').addEventListener('click', () => showNextMessage());
const replyInput = $('#reply-input');
replyInput.maxLength = DIRECT_MESSAGE.maxLength;
let replySending = false;

function updateReplyCount() {
  $('#reply-count').textContent = `${[...replyInput.value].length} / ${DIRECT_MESSAGE.maxLength}`;
  $('#btn-inbox-reply').disabled = replySending || replyInput.value.trim().length === 0;
}
replyInput.addEventListener('input', updateReplyCount);
replyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#btn-inbox-reply').click(); }
});
$('#btn-inbox-reply').addEventListener('click', () => {
  const text = replyInput.value.trim();
  if (!showing || !text || replySending) return;
  replySending = true;
  $('#btn-inbox-reply').disabled = true;
  // 回應直接送給寄件人。不需要他還在名冊上 —— 伺服器會判斷他還在不在場、手機有沒有連線
  sendMsg(EV.MSG_SEND, { to: showing.from, text, ref: trackSend('reply') });
});
$('#btn-inbox-block').addEventListener('click', () => {
  if (!showing) return;
  const { from, fromName } = showing;
  sendMsg(EV.MSG_BLOCK, { userId: from });
  blockedHere.add(from);
  for (let i = inboxQueue.length - 1; i >= 0; i--) if (inboxQueue[i].from === from) inboxQueue.splice(i, 1);
  showToast(`已封鎖 ${fromName || '對方'}，不會再收到他的訊息`);
  showNextMessage();
});
$('#btn-inbox-report').addEventListener('click', () => {
  if (!showing) return;
  sendMsg(EV.MSG_REPORT, { messageId: showing.id });
  showToast('已檢舉給主辦方，謝謝你告訴我們');
  showNextMessage();
});

// ─────────────────────────────────────────────────────────────
// 進場問卷（團隊分類用，見 shared/persona.js）
// ─────────────────────────────────────────────────────────────
// 拍照路徑：嵌在「生成中」那一頁，利用二十幾秒的等待作答。
// 捏臉路徑：沒有等待，按「完成，進入現場」後跳出同一份題目。
// 一律可以略過 —— 掃描失敗都不擋人進場了，一份問卷更不該擋。

const PERSONA_LS = 'pf.persona';
/** 主辦端設定的題目 {quiz, version}；讀不到時是 null，整個問卷就不出現 */
let personaQuiz = null;
/** 這支手機的作答 {version, answers, resultId}。跟著 CLIENT_JOIN 送出 */
let personaAnswers = null;
try { personaAnswers = JSON.parse(localStorage.getItem(PERSONA_LS) ?? 'null'); } catch { personaAnswers = null; }

async function loadPersonaQuiz() {
  try {
    const res = await fetch('/api/persona-quiz', { cache: 'no-store' });
    const body = await res.json();
    if (body?.ok && body.quiz?.questions?.length) personaQuiz = { quiz: body.quiz, version: body.version };
  } catch { /* 讀不到就不問，不影響進場 */ }
  return personaQuiz;
}
loadPersonaQuiz();

/** 已經答過「現在這份」題目了嗎（主持人改了題目的話要重答） */
const personaAnsweredCurrent = () => !!(personaQuiz && personaAnswers?.version === personaQuiz.version);

/**
 * 在容器裡跑一輪問卷。
 * @param {HTMLElement} box
 * @param {{onFinish: (result: object|null) => void, finishLabel?: string}} opts
 *   onFinish 在按下結果卡的按鈕、或略過時呼叫；略過時 result 為 null
 */
function runPersonaQuiz(box, { onFinish, finishLabel = '繼續', autoFinish = false }) {
  const { quiz, version } = personaQuiz;
  const answers = [];

  const renderQuestion = () => {
    const i = answers.length;
    const q = quiz.questions[i];
    box.replaceChildren();
    const head = document.createElement('p');
    head.className = 'pq-head';
    head.textContent = `順便答 ${quiz.questions.length} 題，幫你找到合適的隊友　${i + 1} / ${quiz.questions.length}`;
    const title = document.createElement('h2');
    title.className = 'pq-question';
    title.textContent = q.text;   // 主持人輸入的文字，一律 textContent
    const list = document.createElement('div');
    list.className = 'pq-options';
    q.options.forEach((o, j) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pq-option';
      b.textContent = o.label;
      b.addEventListener('click', () => {
        answers.push(j);
        if (answers.length < quiz.questions.length) renderQuestion();
        else finish();
      });
      list.append(b);
    });
    const foot = document.createElement('div');
    foot.className = 'pq-foot';
    // 上一題：按錯了可以回去改，不必整份略過或答完再重答
    if (i > 0) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn-link pq-back';
      back.textContent = '← 上一題';
      back.addEventListener('click', () => { answers.pop(); renderQuestion(); });
      foot.append(back);
    }
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn-link pq-skip';
    skip.textContent = '略過問卷';
    skip.addEventListener('click', () => onFinish(null));
    foot.append(skip);
    box.append(head, title, list, foot);
    list.querySelector('button')?.focus({ preventScroll: true });
    // 小螢幕上問卷可能落在畫面下緣之外：換題時把整份題目捲進畫面
    box.scrollIntoView({ block: 'nearest' });
  };

  const finish = () => {
    const result = scorePersona(quiz, answers);
    if (!result) { onFinish(null); return; }
    personaAnswers = { version, answers, resultId: result.id };
    try { localStorage.setItem(PERSONA_LS, JSON.stringify(personaAnswers)); } catch { /* 略 */ }
    box.replaceChildren();
    const card = document.createElement('div');
    card.className = 'pq-result';
    const emoji = document.createElement('span');
    emoji.className = 'pq-emoji';
    emoji.setAttribute('aria-hidden', 'true');
    emoji.textContent = result.emoji;
    const name = document.createElement('h2');
    name.textContent = `你是${result.name}（${result.style}）`;
    const strengths = document.createElement('p');
    strengths.textContent = result.strengths;
    // 拍照路徑不放按鈕：答完直接交給呼叫端（角色好了就進確認頁，還沒好就留著結果陪他等）
    if (autoFinish) {
      card.append(emoji, name, strengths);
      box.append(card);
      onFinish(result);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary pq-continue';
    btn.textContent = finishLabel;
    btn.addEventListener('click', () => onFinish(result));
    card.append(emoji, name, strengths, btn);
    box.append(card);
    btn.focus({ preventScroll: true });
    box.dispatchEvent(new CustomEvent('persona-result', { detail: result }));
  };

  renderQuestion();
}

// ── 拍照路徑：嵌在生成中 ────────────────────────────────────
let personaScanActive = false;   // 題目還在作答中（結果卡出現後就算答完）
let scanReady = false;           // 角色已生成好，等問卷答完才顯示

async function startPersonaDuringScan() {
  scanReady = false;
  const box = $('#persona-scan');
  box.hidden = true;
  // 頁面載入時沒讀到題目（例如剛好碰上伺服器重啟）就在這裡再讀一次 ——
  // 只在載入時讀一次的話，那支手機之後每次生成都不會出現問卷
  if (!personaQuiz) await loadPersonaQuiz();
  if (!personaQuiz || $('#scan .scan-panel[data-phase="working"]').hidden) return;
  // 答過現在這份題目：不再整份重問，但要讓人看得到自己的結果、想改可以重答。
  // 整個不顯示的話，看起來就像問卷壞掉了
  if (personaAnsweredCurrent()) { showPersonaSummary(box); return; }
  runPersonaInScan(box);
}

function showPersonaSummary(box) {
  const result = PERSONA_RESULT_MAP[personaAnswers.resultId];
  if (!result) { runPersonaInScan(box); return; }
  box.replaceChildren();
  const line = document.createElement('p');
  line.className = 'pq-summary';
  line.textContent = `${result.emoji} 你是${result.name}（${result.style}）`;
  const redo = document.createElement('button');
  redo.type = 'button';
  redo.className = 'btn-link';
  redo.textContent = '重新作答';
  redo.addEventListener('click', () => runPersonaInScan(box));
  line.append(redo);
  box.append(line);
  box.hidden = false;
}

function runPersonaInScan(box) {
  personaScanActive = true;
  $('#scan-tip').hidden = true;
  box.hidden = false;
  runPersonaQuiz(box, {
    autoFinish: true,
    onFinish: (result) => {
      personaScanActive = false;
      // 角色已經好了：直接進確認頁（類型顯示在那一頁）。
      // 還沒好：結果卡留在這裡陪他等，showScanDone 會自動換頁。略過（result 為 null）就收起來。
      if (scanReady) { box.hidden = true; showScanPhase('done'); }
      else if (!result) box.hidden = true;
    },
  });
}

function stopPersonaDuringScan() {
  personaScanActive = false;
  $('#persona-scan').hidden = true;
}

/** 生成完成。問卷還在作答就先等，答完（或略過）才換到確認頁 */
function showScanDone() {
  scanReady = true;
  const box = $('#persona-scan');
  // 沒有在作答（沒出題、只顯示結果小卡，或已答完在等）就直接換到確認頁
  if (!personaScanActive) { box.hidden = true; showScanPhase('done'); return; }
  $('#scan-status').textContent = '角色已經好了！答完就能看到';
}

// ── 捏臉路徑：進場前跳出 ────────────────────────────────────
async function askPersonaThen(next) {
  if (!personaQuiz) await loadPersonaQuiz();
  if (!personaQuiz || personaAnsweredCurrent()) { next(); return; }
  const overlay = $('#persona-overlay');
  overlay.hidden = false;
  const close = () => { overlay.hidden = true; popOverlay(overlay); };
  pushOverlay(overlay, { onEscape: () => { close(); next(); } });
  runPersonaQuiz($('#persona-builder'), {
    finishLabel: '進入現場',
    onFinish: () => { close(); next(); },
  });
}

/** 確認頁上的類型。只顯示「現在這份題目」答出來的結果 */
function renderDonePersona() {
  const el = $('#done-persona');
  const result = personaAnsweredCurrent() ? PERSONA_RESULT_MAP[personaAnswers.resultId] : null;
  el.hidden = !result;
  if (result) el.textContent = `${result.emoji} 你是${result.name}（${result.style}）：${result.strengths}`;
}

// 問卷出現時，直式版面把生成中的照片縮成小縮圖，讓題目不必捲動就看得完（style.css 的 .quiz-on）
new MutationObserver(() => {
  $('#scan').classList.toggle('quiz-on', !$('#persona-scan').hidden);
}).observe($('#persona-scan'), { attributes: true, attributeFilter: ['hidden'] });

// ─────────────────────────────────────────────────────────────
// 鏡頭縮放（取景時）
// ─────────────────────────────────────────────────────────────
// 支援變焦的鏡頭（多數 Android）用硬體縮放：串流本身就放大了，畫質好，裁切照舊。
// 不支援的（iPhone 的網頁大多是）用數位放大：取景框以中心 CSS 放大，送出與站位偵測時
// cropToPortraitJpeg 從中央裁同一塊 —— 框裡看到的就是送出的。
// 只能放大：網頁切不到超廣角鏡頭，比 1× 更廣做不到。

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
let zoomTrack = null;        // 支援硬體變焦時的那條 video track
let zoomHw = null;           // 硬體變焦的 {min, max}
let zoomLevel = 1;           // 目前倍率（相對於 1×）
let digitalZoom = 1;         // 數位放大倍率；用硬體縮放時恆為 1
let zoomLocked = false;      // 倒數中不給縮放：拍下來的要是倒數開始時看到的畫面

function initZoom(stream) {
  zoomTrack = null;
  zoomHw = null;
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.();
  if (caps?.zoom && caps.zoom.max > caps.zoom.min) {
    zoomTrack = track;
    zoomHw = { min: caps.zoom.min, max: caps.zoom.max };
  }
  $('#zoom-pick').hidden = false;
  setZoom(1);
}

function setZoom(level) {
  if (zoomLocked) return;
  zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  if (zoomTrack && zoomHw) {
    // 硬體倍率以鏡頭的最小值為 1×，上限取兩者較小者
    const hw = Math.min(zoomHw.max, zoomHw.min * zoomLevel);
    zoomTrack.applyConstraints({ advanced: [{ zoom: hw }] }).catch(() => {});
    digitalZoom = 1;
  } else {
    digitalZoom = zoomLevel;
  }
  $('.scan-stage')?.style.setProperty('--zoom', String(digitalZoom));
  for (const b of $('#zoom-pick').children) {
    b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.zoom) - zoomLevel) < 0.05));
  }
}

function setZoomLocked(locked) {
  zoomLocked = locked;
  for (const b of $('#zoom-pick').children) b.disabled = locked;
}

$('#zoom-pick').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-zoom]');
  if (b) setZoom(Number(b.dataset.zoom));
});

// 雙指捏合：以開始捏時的倍率為基準，依兩指距離的比例縮放
{
  const stageEl = $('.scan-stage');
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  stageEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || $('#scan-video').hidden) return;
    pinch = { d0: dist(e.touches), z0: zoomLevel };
  }, { passive: true });
  stageEl.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();   // 不讓瀏覽器把它當成整頁縮放
    setZoom(pinch.z0 * (dist(e.touches) / pinch.d0));
  }, { passive: false });
  stageEl.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
}
