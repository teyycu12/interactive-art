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
  TEAMS, TEAM_IDS, GROUPING_MAP, DEFAULT_GROUPING_ID,
} from '/shared/protocol.js';
import {
  allCaptureIndicatorsPassed, captureGuidanceText, captureIndicators,
} from '/shared/capture-guidance.js';
import { COLOR_FAMILY_MAP } from '/shared/colorFamily.js';
import { HEAT_MAP } from '/shared/heat.js';
import { ZONE_MAP } from '/shared/scene.js';
import { avatarImage } from '/shared/avatarSprite.js';
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

// ── 分組題與隊伍 ──────────────────────────────────────────
//
// 兩條入場路徑都要問：掃描在生成的 25 秒裡順便問完，捏臉獨立一頁。
// 少了任何一條，那條路徑進場的人就沒有隊伍。
//
// 刻意**不寫進 localStorage**：隊伍一旦決定就不可更改，而存在本機
// 等於讓人清掉儲存空間就能重選。真正的權威在伺服器 ——
// CLIENT_WELCOME 回傳的 team 才算數（沒答題的人是由伺服器補位的）。

/** 本場的分組題。伺服器在 /api/grouping 指定，取不到時用預設題 */
let groupingQuestion = GROUPING_MAP[DEFAULT_GROUPING_ID];
/** 我選的隊伍。null 代表還沒答 —— 送出時伺服器會補位，不會擋人進場 */
let myTeam = null;

/** 取本場分組題。失敗不阻斷入場，靜靜沿用預設題 */
async function loadGroupingQuestion() {
  try {
    const res = await fetch('/api/grouping');
    const body = await res.json();
    const q = GROUPING_MAP[body?.questionId];
    if (q) groupingQuestion = q;
  } catch { /* 沿用預設題 */ }
}

/**
 * 把分組題渲染進指定容器。
 * @param {HTMLElement} qEl 題目文字的容器
 * @param {HTMLElement} optsEl 選項按鈕的容器
 * @param {(team: string) => void} [onPick] 選完之後
 */
function renderGrouping(qEl, optsEl, onPick) {
  if (!qEl || !optsEl) return;
  qEl.textContent = groupingQuestion.text;
  optsEl.replaceChildren();

  groupingQuestion.options.forEach((label, i) => {
    const team = TEAM_IDS[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'team-opt';
    btn.textContent = label;
    // 隊伍色只當色塊用，文字另有 ink —— 直接拿 color 當文字色只有 3.7:1，
    // 投影與場地光線下讀不清（見 docs/notes/UI-STYLING.md）
    btn.style.setProperty('--team-color', TEAMS[team].color);
    btn.style.setProperty('--team-ink', TEAMS[team].ink);
    btn.setAttribute('aria-pressed', String(myTeam === team));
    btn.addEventListener('click', () => {
      myTeam = team;
      for (const el of optsEl.querySelectorAll('.team-opt')) {
        el.setAttribute('aria-pressed', String(el === btn));
      }
      onPick?.(team);
    });
    optsEl.append(btn);
  });
}

/** 隊名（取自當場那道題的選項文字），伺服器補位時也叫得出名字 */
function teamLabel(team) {
  const i = TEAM_IDS.indexOf(team);
  return i >= 0 ? groupingQuestion.options[i] : '';
}

/** 把隊伍畫進控制器頂端的狀態列 */
function renderMyTeam() {
  const el = $('#my-team');
  if (!el || !myTeam) return;
  el.textContent = teamLabel(myTeam);
  el.style.setProperty('--team-color', TEAMS[myTeam].color);
  el.style.setProperty('--team-ink', TEAMS[myTeam].ink);
  el.hidden = false;
}

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
  for (const s of ['entry', 'scan', 'builder', 'grouping', 'controller', 'farewell']) {
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
  let label = '';
  for (const btn of $('#style-pick-options').children) {
    const on = btn.dataset.styleId === styleId;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
    if (on) label = btn.textContent;
  }
  $('#aim-lede').textContent = label
    ? `照片會被轉譯成你的${label}角色。`
    : '照片會被轉譯成你的角色。';
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
  };
  // previewPng 優先：確認頁把角色放進 74vh 的直式框，手機 dpr=3 時顯示高度
  // 接近 2000 實際像素，而 fullPng 是為場上渲染縮過的貼圖（1024），
  // 在這裡會被放大近兩倍。previewPng 是模型輸出的原始尺寸，專供這一頁。
  // 舊版伺服器沒有這個欄位，因此保留 fullPng 作為後備。
  const shot = body.previewPng || body.fullPng;
  if (shot) $('#scan-result').src = shot;
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

  // 這 25 秒是整條動線上唯一的空檔，順便把分組題問完 ——
  // 答過的人（重拍、或先前已選）不再重問。
  const teamEl = $('#scan-team');
  if (teamEl) {
    teamEl.hidden = myTeam !== null;
    const paint = () => renderGrouping($('#scan-team-q'), $('#scan-team-opts'), () => {
      // 答完就收起來，把版面讓回給提示
      teamEl.hidden = true;
      $('#scan')?.classList.remove('asking-team');
    });
    if (!myTeam) {
      paint();
      // 分組題與提示卡不同時出現：小螢幕（iPhone SE 級）上兩者並存會超出
      // 可用高度約 120px，而 html 是 overflow:hidden —— 被切掉的按鈕
      // 捲不出來也按不到。標記由 CSS 收掉提示並縮小取景框。
      $('#scan')?.classList.add('asking-team');
      // 主辦端可能在這支手機開著的期間才選題，重取一次再重畫。
      // 已經答過就不動，免得選項在手指底下換掉。
      loadGroupingQuestion().then(() => { if (!myTeam) paint(); });
    }
  }

  const bar = $('#scan-progress');
  const statusEl = $('#scan-status');
  const elapsedEl = $('#scan-elapsed');
  const tipEl = $('#scan-tip');
  const tipTextEl = $('#scan-tip-text');
  const t0 = Date.now();

  // 從隨機一則開始，否則現場一整排手機會顯示同一句，看起來像罐頭
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  let lastTipAt = 0;

  const tick = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    const pct = Math.min(92, (sec / 25) * 100);
    bar.style.width = `${pct}%`;
    const step = STEPS.filter(([p]) => pct >= p).at(-1);
    if (step) statusEl.textContent = step[1];
    elapsedEl.textContent = sec < 30
      ? `已等待 ${Math.floor(sec)} 秒　約需 25 秒`
      : `已等待 ${Math.floor(sec)} 秒　比平常久一些，請再等等`;

    // 3 秒後才出現：太早跳出來會蓋過「正在分析服裝特徵」那句，
    // 讓人以為系統要他做什麼才會繼續。之後每 6 秒換一則。
    if (sec >= 3 && sec - lastTipAt >= (lastTipAt === 0 ? 0 : 6)) {
      if (tipEl) tipEl.hidden = false;
      if (tipTextEl) tipTextEl.textContent = TIPS[tipIndex % TIPS.length];
      tipIndex += 1;
      lastTipAt = sec;
    }
  }, 250);

  return () => {
    clearInterval(tick);
    bar.style.width = '100%';
    // 收起提示，否則它會殘留到「確認角色」那一頁
    if (tipEl) tipEl.hidden = true;
    if (teamEl) teamEl.hidden = true;
    $('#scan')?.classList.remove('asking-team');
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
// 開場就取本場的分組題。不 await —— 取題失敗或很慢都不該擋住命名畫面，
// 沿用內建預設題即可（與「掃描失敗一律降級，不擋人進場」同一個原則）。
loadGroupingQuestion();

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
    // team 由伺服器最終裁定：沒答題或送了非法值時它會補位，
    // 重連時則一律沿用原隊（客戶端無法靠重送換隊）
    sendMsg(EV.CLIENT_JOIN, {
      userId, rejoinToken, name: displayName, avatar: config, team: myTeam,
    });
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === EV.CLIENT_WELCOME) {
      try {
        localStorage.setItem(LS.userId, msg.userId);
        if (msg.rejoinToken) localStorage.setItem(LS.rejoinToken, msg.rejoinToken);
      } catch { /* 略 */ }
      myId = msg.userId;
      // 伺服器指派的隊伍才算數：沒答題的人是被補位的，重連的人一律沿用原隊。
      // 以本地選擇為準會讓這兩種情況顯示成錯的隊伍。
      if (msg.team) {
        myTeam = msg.team;
        renderMyTeam();
      }
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
      // id → 名字。只在成員變動時送，供 POV 畫布標示鄰居是誰。
      renderer?.setNames(msg.agents ?? []);
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
  [PAIR_ERRORS.COLOR_MISMATCH]: '這位的身上沒有指定的顏色，再找找看。',
  [PAIR_ERRORS.SAME_TEAM]: '這位跟你同一隊，去找對面那隊的人。',
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

  // COLOR_HUNT：把要找的顏色放在最顯眼的位置。
  // 只寫在 brief 裡不夠 —— 那行字在小螢幕上會被當成說明略過，
  // 而顏色是這個任務唯一需要記住的東西。
  const fam = mission.colorFamily ? COLOR_FAMILY_MAP[mission.colorFamily] : null;
  const chip = $('#mission-color-chip');
  if (chip) {
    chip.hidden = !fam;
    if (fam) {
      chip.textContent = `${fam.glyph} 找身上有${fam.label}的人`;
      chip.style.setProperty('--chip', fam.swatch);
    }
  }

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
  $('#pair-confirm-avatar').innerHTML = msg.avatar ? renderAvatarSVG(msg.avatar) : '';
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
    el.textContent = active ? '你正在操控' : '推動搖桿即可操控你的角色';
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
/**
 * 還沒答分組題的話，先問完再進場。
 *
 * 掛在 enterStage 之前而非各個按鈕上：捏臉與掃描兩條路徑最後都會匯流到
 * enterStage，擋在這裡等於一次涵蓋兩條，日後新增入場路徑也不會漏掉
 * （與伺服器把不變式集中在 addAgent 是同一個思路）。
 *
 * @returns {boolean} true 代表已攔下（畫面已切到分組題）
 */
function requireGrouping() {
  if (myTeam) return false;
  // 再取一次：手機可能在主辦端選題之前就開著了，開場那次拿到的是舊題。
  // 非同步回來後重畫，不阻塞畫面切換。
  loadGroupingQuestion().then(() => {
    if (!myTeam) renderGrouping($('#grouping-q'), $('#grouping-opts'), () => enterStage());
  });
  renderGrouping($('#grouping-q'), $('#grouping-opts'), () => {
    // 選完立刻進場，不再多一個「下一步」——
    // 這一題只有兩個選項，多一次點擊只是拖慢入場
    enterStage();
  });
  showScreen('grouping');
  return true;
}

function enterStage() {
  if (requireGrouping()) return;
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
