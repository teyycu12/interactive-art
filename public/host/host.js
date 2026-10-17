/**
 * 主辦端控制台（規格 v3.0 §05）
 *
 * 系統的第三個角色。與大螢幕、手機端不同，這裡握有踢人與結算全場的能力，
 * 因此需要通行密鑰認證 —— 現場所有人連在同一個區網，
 * 光靠「網址沒人知道」保護不了任何東西。
 */

import '/shared/legacyStorage.js';   // 必須排第一個：先把改名前的舊鍵搬過來
import {
  EV, MISSION_TYPES, MISSION_DURATIONS, QUIZ, QUIZ_CHOICES, QUIZ_PHASE, EVENT_INFO,
} from '/shared/protocol.js';
import { renderAvatarSVG, CV_FULL_PART } from '/shared/avatars.js';
import { COLOR_FAMILIES } from '/shared/colorFamily.js';
import { SELECTABLE_THEMES as THEMES, THEME_MAP } from '/shared/themes.js';
import { PERSONA_TYPES, PERSONA_RESULT_MAP, PERSONA_LIMITS } from '/shared/persona.js';
import { WORDCLOUD } from '/shared/wordcloud.js';
import { quizBankToText, parseQuizText, sameQuiz } from '/shared/quizText.js';
import { SCORING_FIELDS, SCORING_MAX } from '/shared/scoring.js';
import { recipesForTheme } from '/shared/recipes.js';

const $ = (s) => document.querySelector(s);
const SS_KEY = 'pixelair.hostKey';

let ws = null;
let authed = false;
/** 通行密鑰的明文，生成歷史走 REST（不是 WS），得自己帶著它做存取控制 */
let hostKeyValue = null;
let missionTypes = Object.values(MISSION_TYPES);
/** 計分規則由伺服器於認證後下發（值只存在於伺服器的調校檔） */
let scoring = null;

// ─────────────────────────────────────────────────────────────
// 連線與認證
// ─────────────────────────────────────────────────────────────
function connect(key) {
  hostKeyValue = key;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: EV.HOST_AUTH, key })));

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg, key);
  });

  ws.addEventListener('close', () => {
    if (!authed) return;
    // 送出中斷線：不知道伺服器收到沒有。重連的補送不能當成存檔回覆，
    // 草稿維持未存，讓主持人自己再按一次
    personaSaveRejected();
    setConn('連線中斷，重試中…', true);
    setTimeout(() => connect(key), 1500);
  });
}

function handle(msg, key) {
  switch (msg.type) {
    case EV.HOST_WELCOME:
      authed = true;
      try { sessionStorage.setItem(SS_KEY, key); } catch { /* 略 */ }
      if (Array.isArray(msg.missionTypes) && msg.missionTypes.length) {
        missionTypes = msg.missionTypes;
      }
      if (msg.scoring) scoring = msg.scoring;
      buildMissionTypes();
      buildThemes();
      // 先不開控制台：要等 STAGE_EVENT 才知道這場活動設定過沒有（緊接在後面送到）
      $('#auth').hidden = true;
      setConn('已連線', false);
      // 生成歷史不在這裡載入：它收在「系統」分頁，切過去才開始輪詢
      if (activeTab === 'system') startHistoryPolling();
      break;

    case EV.HOST_REJECT:
      // 認證前的拒絕代表密鑰錯誤；認證後的拒絕來自任務或問答的發布失敗
      if (!authed) { showAuthError(msg.reason ?? '通行密鑰錯誤'); ws.close(); }
      else {
        undoRunSheetStep();
        if (lastAction === 'persona') personaSaveRejected();
        if (lastAction === 'bingo') bingoFactsSaveRejected();
        showError(msg.reason ?? '操作失敗');
      }
      break;

    case EV.HOST_STATE:
      renderState(msg);
      // 場上的人或他們的標籤變了，可選的條件與「做不做得完」也跟著變
      requestMissionCheck({ quiet: true });
      break;

    case EV.HOST_MISSION_CHECK:
      renderMissionCheck(msg);
      break;

    case EV.STAGE_THEME:
      renderTheme(msg.theme);
      break;

    case EV.STAGE_EVENT:
      renderEvent(msg.event ?? null);
      break;

    case EV.SCREEN_SETTINGS:
      renderScreenSettings(msg.settings);
      break;

    case EV.HOST_SCREEN_SHOT:
      receiveScreenShot(msg);
      break;

    case EV.HOST_PERSONA_QUIZ:
      receivePersonaQuiz(msg);
      break;

    case EV.HOST_BINGO_FACTS:
      receiveBingoFacts(msg);
      break;

    case EV.HOST_SCORING:
      receiveScoring(msg);
      break;

    case EV.HOST_MSG_REPORTS:
      renderReports(Array.isArray(msg.reports) ? msg.reports : []);
      break;

    case EV.WORDCLOUD_QUESTION:
      renderWordCloud({ question: msg.cloud.question, words: [], participants: 0 });
      pushFeed(`文字雲出題「${msg.cloud.question}」`, 'ev-mission');
      break;

    case EV.WORDCLOUD_STATE:
      if (msg.cloud) renderWordCloudWords(msg.cloud);
      break;

    case EV.WORDCLOUD_CLOSED: {
      const top = (msg.result.words ?? []).slice(0, 3).map((w) => w.text).join('、');
      pushFeed(`文字雲收題「${msg.result.question}」　${msg.result.participants} 人作答${top ? `・最多：${top}` : ''}`, 'ev-mission');
      renderWordCloud(null);
      break;
    }

    case EV.MISSION_ANNOUNCE:
      pushFeed(`發布任務「${msg.mission.title}」`, 'ev-mission');
      break;

    case EV.MISSION_STATE:
      updateMission(msg.mission);
      break;

    case EV.MISSION_COMPLETE:
      pushFeed(`${msg.a.name} × ${msg.b.name} 完成配對`, 'ev-pair');
      break;

    case EV.BINGO_STATE:
      renderBingo(msg.round);
      break;

    case EV.BINGO_ENDED:
      renderBingo(null);
      pushFeed(`人物賓果結束　${msg.winners?.length ? `最多連線：${msg.winners.join('、')}` : '沒有人連成線'}`, 'ev-pair');
      break;

    case EV.MISSION_CLOSED:
      pushFeed(`${msg.by === 'time' ? '時間到，' : ''}結算「${msg.title}」，共 ${msg.totalCompletions} 次完成`, 'ev-mission');
      missionStates.delete(msg.id);
      renderMissions();
      break;

    case EV.QUIZ_QUESTION:
      quiz = msg.quiz;
      reveal = null;
      // 有討論時間的題目會送兩次：開始討論、討論結束開始作答
      pushFeed(`第 ${quiz.index} 題「${quiz.question}」${quiz.phase === QUIZ_PHASE.DISCUSS ? '開始討論' : '開始作答'}`, 'ev-quiz');
      renderQuiz();
      break;

    case EV.QUIZ_TALLY:
      if (quiz) { quiz.answered = msg.answered; renderQuizTally(); }
      break;

    case EV.QUIZ_REVEAL:
      reveal = msg;
      if (quiz) quiz.phase = QUIZ_PHASE.REVEALED;
      pushFeed(`公布正解，${msg.correctIds?.length ?? 0} / ${msg.totalAnswers} 人答對`, 'ev-quiz');
      renderQuiz();
      break;

    case EV.QUIZ_ENDED:
      quiz = null;
      reveal = null;
      renderQuiz();
      break;

    case EV.SCORE_BOARD:
      renderRanks(msg.leaderboard ?? []);
      break;

    case EV.HOST_PHOTO_STATE:
      renderPhotoState(msg);
      break;

    case EV.HOST_REPORT:
      renderReport(msg.format, msg.report);
      break;
  }
}

// ── 大合照 ───────────────────────────────────────────────────
const PHOTO_PHASES = {
  STAGING: (m) => (m.arrange === 'affinity'
    ? `正在依互動把 ${m.count ?? 0} 位角色排進隊形…`
    : `正在把 ${m.count ?? 0} 位角色帶到定位…`),
  COMPOSING: () => '角色已就位，合成中…',
};

function renderPhotoState(msg) {
  const btn = $('#btn-photo');
  const status = $('#photo-status');
  const err = $('#photo-err');
  const result = $('#photo-result');

  if (msg.phase === 'DONE') {
    btn.disabled = false;
    // 主控台裡的預覽小窗不算大螢幕（不會被拿去截圖），只開預覽時一定會走備用畫面
    status.textContent = msg.fallback
      ? '這張沒有拿到大螢幕的畫面，用的是備用舞台。要拍出場景，請先在投影電腦開好大螢幕（/screen/）再拍。'
      : '';
    status.hidden = !msg.fallback;
    err.hidden = true;
    $('#photo-img').src = msg.photoB64 || '';
    $('#photo-qr').src = msg.qrB64 || '';
    const dl = $('#photo-download');
    dl.href = msg.photoB64 || '#';
    dl.download = `${msg.photoId || 'pixelair'}.png`;
    result.hidden = false;
    return;
  }
  if (msg.phase === 'ERROR') {
    btn.disabled = false;
    status.hidden = true;
    err.textContent = `合照失敗：${msg.error ?? '未知原因'}`;
    err.hidden = false;
    return;
  }
  // 進行中
  btn.disabled = true;
  err.hidden = true;
  result.hidden = true;
  status.textContent = (PHOTO_PHASES[msg.phase] ?? (() => '處理中…'))(msg);
  status.hidden = false;
}

// 站位選擇記在這台電腦上：主持人通常整場都用同一種，重新整理不該被改回預設
const PHOTO_ARRANGE_KEY = 'pf-photo-arrange';
try {
  const saved = localStorage.getItem(PHOTO_ARRANGE_KEY);
  if (saved && [...$('#photo-arrange').options].some((o) => o.value === saved)) $('#photo-arrange').value = saved;
} catch { /* 私密視窗等情況讀不到，用預設的原地拍 */ }
$('#photo-arrange').addEventListener('change', () => {
  try { localStorage.setItem(PHOTO_ARRANGE_KEY, $('#photo-arrange').value); } catch { /* 同上 */ }
});

$('#btn-photo').addEventListener('click', () => {
  $('#btn-photo').disabled = true;
  ws?.send(JSON.stringify({ type: EV.HOST_TAKE_PHOTO, arrange: $('#photo-arrange').value }));
});

const setConn = (text, warn) => {
  const el = $('#conn-status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
};

function showAuthError(text) {
  const el = $('#auth-err');
  el.textContent = text;
  el.hidden = false;
}

/** 各面板的錯誤欄位。lastAction 決定訊息落在哪一格 */
const ERR_SLOT = {
  persona: '#persona-err',
  setup: '#setup-err',
  screen: '#screen-err',
  wordcloud: '#wordcloud-err',
  quiz: '#quiz-err',
  bingo: '#bingo-err',
  mission: '#mission-err',
  runsheet: '#rs-err',
  scoring: '#scoring-err',
  report: '#report-err',
};

/**
 * 錯誤顯示在目前操作的面板旁。
 *
 * 落錯格子的代價不小：「至少需要 2 位參與者才能開始尋寶」若顯示在
 * 任務面板，主辦端會以為是任務發布失敗，而尋寶那一格看起來毫無反應。
 */
function showError(text, where = null) {
  // 問答的錯誤只在「還沒有題目」時才歸問答面板（沿用原本的判斷）
  const slot = lastAction === 'quiz'
    ? (quiz === null ? ERR_SLOT.quiz : ERR_SLOT.mission)
    : (ERR_SLOT[lastAction] ?? ERR_SLOT.mission);
  const el = $(where ?? slot);
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

/** 最近一次操作屬於哪個面板，用來決定錯誤訊息顯示在哪 */
let lastAction = null;

$('#btn-auth').addEventListener('click', () => {
  const key = $('#key-input').value.trim().toUpperCase();
  if (!key) { $('#key-input').focus(); return; }
  $('#auth-err').hidden = true;
  connect(key);
});
$('#key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-auth').click();
});

// 重新整理不必再輸入一次密鑰。用 sessionStorage 而非 localStorage：
// 關閉分頁即失效，主辦者離開電腦時不會留下可用的憑證。
try {
  const saved = sessionStorage.getItem(SS_KEY);
  if (saved) { $('#key-input').value = saved; connect(saved); }
} catch { /* 略 */ }

// ─────────────────────────────────────────────────────────────
// 任務控制
// ─────────────────────────────────────────────────────────────

/** 目前選定的顏色。COLOR_HUNT 以外的任務型別不會用到 */
let pickedColor = COLOR_FAMILIES[0].id;

// ─────────────────────────────────────────────────────────────
// 活動設定：場景 + 活動名稱
// ─────────────────────────────────────────────────────────────
// 認證之後先到這一頁：一場活動只用一個場景，選好、命名之後才進得了活動編排。
// 伺服器記得設定（快照），所以只有「這場活動第一次開控制台」會停在這裡；
// 之後要換場景或改名，從頂欄的「修改活動設定」回來。
//
// 目前主題只由 STAGE_THEME 決定（伺服器在 HOST_AUTH 時補送）。設定頁上點場景卡
// 只是「選取」，按下「進入活動編排」才和名稱一起送出 —— 伺服器拒絕時大螢幕不會變。

let currentTheme = null;
/** 伺服器上的活動設定。undefined＝還沒收到 STAGE_EVENT，null＝尚未設定 */
let eventInfo;
/** 設定頁上選取中的場景（尚未送出） */
let setupTheme = null;

$('#event-name').maxLength = EVENT_INFO.maxNameLength;
$('#event-subtitle').maxLength = EVENT_INFO.maxSubtitleLength;

function buildThemes() {
  const list = $('#setup-themes');
  list.replaceChildren();
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-card';
    b.dataset.theme = t.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    const name = document.createElement('b'); name.textContent = t.label;
    const occasion = document.createElement('span'); occasion.className = 'theme-occasion'; occasion.textContent = t.occasion;
    const brief = document.createElement('span'); brief.className = 'theme-brief'; brief.textContent = t.brief;
    b.append(name, occasion, brief);
    b.addEventListener('click', () => pickSetupTheme(t.id));
    list.append(b);
  }
  pickSetupTheme(setupTheme ?? currentTheme);
}

function pickSetupTheme(id) {
  setupTheme = THEME_MAP[id] ? id : null;
  const cards = [...document.querySelectorAll('#setup-themes .theme-card')];
  for (const b of cards) {
    const on = b.dataset.theme === setupTheme;
    b.setAttribute('aria-checked', String(on));
    // radiogroup 的鍵盤慣例：只有選中的那張在 Tab 順序裡（都沒選時是第一張）
    b.tabIndex = on || (!setupTheme && b === cards[0]) ? 0 : -1;
  }
}

function renderTheme(id) {
  currentTheme = id;
  renderRecipes();
  const label = THEME_MAP[id]?.label ?? '';
  $('#event-scene').textContent = label ? `場景：${label}` : '';
  // 設定頁還開著、主辦者也還沒自己挑過的話，預選目前的場景
  if (!$('#setup').hidden && setupTheme === null) pickSetupTheme(id);
}

function renderEvent(info) {
  const first = eventInfo === undefined;
  eventInfo = info;
  $('#event-title').textContent = info?.name ?? '主辦端控制台';
  document.title = info?.name ? `${info.name}｜主辦端` : 'PixelAir 主辦端';
  // 斷線重連時設定頁可能已經開著、名稱打到一半 —— 不要把它清掉重來
  if (!info) { if ($('#setup').hidden) openSetup(false); return; }
  // 剛在設定頁送出 → 進控制台的「節目單」分頁（活動編排：套範本、排流程）。
  // 一連上就已經設定過 → 直接進控制台，停在原本的分頁。
  // 其他主辦端改了設定 → 只更新名稱，不打斷這台正在做的事。
  const fromSetup = !$('#setup').hidden;
  if (first || fromSetup) {
    showConsole();
    if (fromSetup) selectTab('plan');
  }
}

function openSetup(editing) {
  $('#event-name').value = eventInfo?.name ?? '';
  $('#event-subtitle').value = eventInfo?.subtitle ?? '';
  setupTheme = null;
  pickSetupTheme(currentTheme);
  $('#btn-setup-cancel').hidden = !editing;
  $('#btn-setup').textContent = editing ? '儲存設定' : '進入活動編排';
  $('#setup-err').hidden = true;
  $('#console').hidden = true;
  $('#setup').hidden = false;
  $('#event-name').focus();
}

function showConsole() {
  $('#setup').hidden = true;
  $('#console').hidden = false;
  initPreview();
}

$('#btn-setup').addEventListener('click', () => {
  lastAction = 'setup';
  const name = $('#event-name').value.trim();
  if (!setupTheme) { showError('請先選擇一個場景'); return; }
  if (!name) { showError('請填寫活動名稱'); $('#event-name').focus(); return; }
  ws?.send(JSON.stringify({
    type: EV.HOST_SETUP_EVENT,
    theme: setupTheme,
    name,
    subtitle: $('#event-subtitle').value.trim(),
  }));
});
for (const id of ['#event-name', '#event-subtitle']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-setup').click(); });
}
$('#btn-setup-cancel').addEventListener('click', showConsole);
$('#btn-edit-event').addEventListener('click', () => openSetup(true));

// 方向鍵在場景卡之間移動（radiogroup 慣例）
$('#setup-themes').addEventListener('keydown', (e) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const i = THEMES.findIndex((t) => t.id === setupTheme);
  const next = THEMES[(Math.max(i, 0) + step + THEMES.length) % THEMES.length];
  pickSetupTheme(next.id);
  $(`#setup-themes [data-theme="${next.id}"]`).focus();
});

// ─────────────────────────────────────────────────────────────
// 大螢幕：原本是投影畫面上的按鈕與鍵盤快捷鍵
// ─────────────────────────────────────────────────────────────
// 除錯視圖（在「系統」分頁）的開關狀態只由 SCREEN_SETTINGS 決定（伺服器在 HOST_AUTH 時補送），
// 不樂觀切換：兩台主辦端同時開著時，畫面上顯示的才會是大螢幕真正的狀態。
const sendScreen = (cmd, value) => {
  lastAction = 'screen';
  ws?.send(JSON.stringify({ type: EV.HOST_SCREEN_CMD, cmd, value }));
};

let screenDebug = false;
let screenSound = true;
let screenRanks = true;

function renderScreenSettings(settings) {
  if (!settings) return;
  screenSound = settings.sound !== false;
  const sound = $('#btn-screen-sound');
  sound.setAttribute('aria-pressed', String(screenSound));
  sound.textContent = screenSound ? '🔊' : '🔇';
  sound.setAttribute('aria-label', screenSound ? '大螢幕音效：開' : '大螢幕音效：關');
  screenRanks = settings.ranks !== false;
  const ranks = $('#btn-screen-ranks');
  ranks.setAttribute('aria-pressed', String(screenRanks));
  ranks.textContent = screenRanks ? '排行榜：顯示' : '排行榜：隱藏';
  screenDebug = settings.debug === true;
  const btn = $('#btn-screen-debug');
  btn.setAttribute('aria-pressed', String(screenDebug));
  btn.textContent = screenDebug ? '除錯視圖：開（按一下關閉）' : '除錯視圖：關';
}

let screenStatusTimer = null;
function screenStatus(text) {
  const el = $('#screen-status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(screenStatusTimer);
  screenStatusTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

$('#btn-screen-ranks').addEventListener('click', () => sendScreen('ranks', !screenRanks));
$('#btn-screen-debug').addEventListener('click', () => sendScreen('debug', !screenDebug));
$('#btn-screen-sound').addEventListener('click', () => sendScreen('sound', !screenSound));

// 話題桌開關：狀態只由 HOST_STATE 決定，不樂觀切換（同上，兩台主辦端時才一致）
let topicsOn = true;
$('#btn-topics').addEventListener('click', () => {
  lastAction = 'screen';
  ws?.send(JSON.stringify({ type: EV.HOST_SET_TOPICS, enabled: !topicsOn }));
});
$('#btn-screen-shot').addEventListener('click', () => {
  $('#btn-screen-shot').disabled = true;
  screenStatus('向大螢幕要畫面中…');
  sendScreen('capture');
});

// ─────────────────────────────────────────────────────────────
// 被檢舉的私訊
// ─────────────────────────────────────────────────────────────
// 清單只由 HOST_MSG_REPORTS 驅動（伺服器在 HOST_AUTH 時補送）。
// 主辦端看不到一般私訊 —— 這裡只有參與者自己按了「檢舉」的那幾則。
let knownReportIds = null;

function renderReports(reports) {
  $('#reports-panel').hidden = reports.length === 0;
  $('#reports-count').textContent = reports.length;
  // 第一次收到（登入、重整）是補送，不算新檢舉；之後多出來的才亮紅點、進現場動態
  const fresh = knownReportIds ? reports.filter((r) => !knownReportIds.has(r.messageId)) : [];
  knownReportIds = new Set(reports.map((r) => r.messageId));
  for (const r of fresh) pushFeed(`收到檢舉：${r.toName || '參與者'} 檢舉了 ${r.fromName || '某人'} 的訊息`, 'ev-mission');
  if (fresh.length && activeTab !== 'people') $('#report-dot').hidden = false;
  if (!reports.length) $('#report-dot').hidden = true;

  const list = $('#reports-list');
  list.replaceChildren();
  for (const r of reports) {
    const li = document.createElement('li');
    const head = document.createElement('p');
    head.className = 'rp-head';
    const who = document.createElement('b');
    who.textContent = r.fromName || '（已離場）';
    const meta = document.createElement('span');
    meta.textContent = ` → ${r.toName || '參與者'}　${new Date(r.at).toLocaleTimeString('zh-TW', { hour12: false })}`;
    head.append(who, meta);
    // 內容一律 textContent：檢舉的就是參與者自由輸入的文字
    const text = document.createElement('blockquote');
    text.className = 'rp-text';
    text.textContent = r.text;
    const actions = document.createElement('div');
    actions.className = 'rp-actions';
    const kick = document.createElement('button');
    kick.className = 'btn-kick';
    kick.textContent = r.fromPresent ? `移除 ${r.fromName}` : '寄件人已不在場';
    kick.disabled = !r.fromPresent;
    kick.addEventListener('click', () => {
      if (!confirm(`確定要將「${r.fromName}」移出現場嗎？`)) return;
      ws?.send(JSON.stringify({ type: EV.HOST_KICK, agentId: r.from }));
      pushFeed(`移除參與者 ${r.fromName}（因檢舉）`, 'ev-mission');
    });
    const done = document.createElement('button');
    done.className = 'btn-ghost';
    done.textContent = '已處理';
    done.addEventListener('click', () => ws?.send(JSON.stringify({ type: EV.HOST_DISMISS_REPORT, messageId: r.messageId })));
    actions.append(kick, done);
    li.append(head, text, actions);
    list.append(li);
  }
}

function receiveScreenShot(msg) {
  $('#btn-screen-shot').disabled = false;
  if (!msg.image) {
    $('#screen-status').hidden = true;
    showError(msg.error ?? '截圖失敗', '#screen-err');
    return;
  }
  const stamp = new Date().toTimeString().slice(0, 8).replaceAll(':', '');
  const a = document.createElement('a');
  a.download = `${eventInfo?.name ?? 'pixelair'}-畫面-${stamp}.png`;
  a.href = msg.image;
  a.click();
  screenStatus('畫面已下載');
}

// ─────────────────────────────────────────────────────────────
// 文字雲
// ─────────────────────────────────────────────────────────────
// 題目由 WORDCLOUD_QUESTION 驅動、詞由 WORDCLOUD_STATE 驅動（伺服器在 HOST_AUTH 時都會補送）。
$('#wordcloud-question').maxLength = WORDCLOUD.maxQuestionLength;

/** @param {{question: string, words: object[], participants: number}|null} state */
function renderWordCloud(state) {
  $('#wordcloud-idle').hidden = !!state;
  $('#wordcloud-live').hidden = !state;
  if (!state) return;
  $('#wordcloud-live-q').textContent = state.question;   // 主持人自己輸入的題目，一律 textContent
  renderWordCloudWords(state);
}

function renderWordCloudWords(cloud) {
  $('#wordcloud-count').textContent = `${cloud.participants ?? 0} 人作答`;
  const list = $('#wordcloud-words');
  list.replaceChildren();
  $('#wordcloud-empty').hidden = (cloud.words ?? []).length > 0;
  for (const w of cloud.words ?? []) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'wc-text';
    text.textContent = w.text;   // 參與者輸入的文字，一律 textContent
    const n = document.createElement('span');
    n.className = 'wc-n';
    n.textContent = `${w.count}`;
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'btn-link wc-hide';
    hide.textContent = '隱藏';
    hide.addEventListener('click', () => {
      ws?.send(JSON.stringify({ type: EV.HOST_HIDE_WORD, word: w.text }));
      li.remove();   // 先從清單拿掉，伺服器的 WORDCLOUD_STATE 隨後會確認
    });
    li.append(text, n, hide);
    list.append(li);
  }
}

function wordcloudStep() {
  const question = $('#wordcloud-question').value.trim();
  if (!question) { lastAction = 'wordcloud'; showError('請先輸入題目'); return null; }
  return { kind: 'wordcloud', label: `文字雲：${question}`, msg: { type: EV.HOST_START_WORDCLOUD, question } };
}

$('#btn-wordcloud-start').addEventListener('click', () => {
  const step = wordcloudStep();
  if (!step) return;
  lastAction = 'wordcloud';
  ws?.send(JSON.stringify(step.msg));
});
$('#wordcloud-question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) $('#btn-wordcloud-start').click();
});
$('#btn-wordcloud-close').addEventListener('click', () => {
  lastAction = 'wordcloud';
  ws?.send(JSON.stringify({ type: EV.HOST_CLOSE_WORDCLOUD }));
});

function buildMissionTypes() {
  const sel = $('#mission-type');
  sel.replaceChildren();
  for (const t of missionTypes) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.append(opt);
  }
  syncBrief();
  buildColorPicker();
}

function buildColorPicker() {
  const box = $('#mission-color');
  box.replaceChildren();
  for (const f of COLOR_FAMILIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.dataset.family = f.id;
    btn.style.setProperty('--swatch', f.swatch);
    btn.title = f.label;
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      pickedColor = f.id;
      syncColorPicker();
      requestMissionCheck();
    });
    box.append(btn);
  }
  syncColorPicker();
}

function syncColorPicker() {
  for (const btn of $('#mission-color').children) {
    btn.classList.toggle('is-picked', btn.dataset.family === pickedColor);
  }
}

function syncBrief() {
  const t = missionTypes.find((m) => m.id === $('#mission-type').value);
  $('#mission-brief').textContent = t?.brief ?? '';
  if (t?.defaultTarget) $('#mission-target').value = t.defaultTarget;
  // 只顯示這個型別用得到的條件，避免主辦端誤以為每種任務都要選色、選題
  $('#mission-color-field').hidden = t?.param !== 'colorFamily';
  $('#mission-trait-field').hidden = t?.param !== 'trait' && t?.param !== 'traitKey';
  $('#mission-trait-value').hidden = t?.param !== 'trait';
  $('#mission-spot-field').hidden = t?.param !== 'spot';
  // 集合任務每人只完成一次，目標次數沒有意義
  $('#mission-target-field').hidden = t?.verify === 'gather';
  if (t?.teamSize) {
    const team = $('#mission-team');
    team.min = t.teamSize.min; team.max = t.teamSize.max;
    if (!team.value) team.value = t.teamSize.default;
  }
  renderTraitValues();
  requestMissionCheck();
}
$('#mission-type').addEventListener('change', syncBrief);

// ── 任務條件的選項與發布前檢查 ─────────────────────────────
/** 伺服器回報的可選條件：場上的標籤（catalog）與目前場景的集合點（spots） */
let missionOpts = { catalog: [], spots: [] };
/** 最近一次對「目前表單」的檢查結果；發布時據此決定要不要先確認 */
let missionCheck = null;
let checkSeq = 0;
let checkTimer = null;
let lastQuietCheck = 0;

/** 依伺服器的選項重建下拉選單，盡量保留原本選的那一個 */
function fillSelect(sel, items, toOption) {
  const keep = sel.value;
  sel.replaceChildren();
  for (const item of items) {
    const [value, text] = toOption(item);
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;   // 題目與選項可能由主辦者輸入，一律 textContent
    sel.append(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function renderTraitValues() {
  const key = missionOpts.catalog.find((k) => k.key === $('#mission-trait-key').value);
  fillSelect($('#mission-trait-value'), key?.values ?? [], (v) => [v.value, `${v.label}（${v.count} 人）`]);
}

function renderMissionOptions(opts) {
  missionOpts = opts ?? missionOpts;
  fillSelect($('#mission-trait-key'), missionOpts.catalog, (k) => [k.key, `${k.title}（${k.answered} 人答過）`]);
  $('#mission-trait-empty').hidden = missionOpts.catalog.length > 0;
  renderTraitValues();
  fillSelect($('#mission-spot'), missionOpts.spots, (sp) => [sp.id, sp.label]);
  $('#mission-spot-empty').hidden = missionOpts.spots.length > 0;
}

/**
 * 請伺服器檢查目前表單。表單一變就問（稍微延遲，連續打字只問一次）；
 * 參與者名冊每次更新也問，但最多兩秒一次 —— HOST_STATE 一秒可能來好幾則。
 */
function requestMissionCheck({ quiet = false } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !authed) return;
  if (quiet && Date.now() - lastQuietCheck < 2000) return;
  if (quiet) lastQuietCheck = Date.now();
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    checkSeq += 1;
    ws.send(JSON.stringify({ ...missionStep().msg, type: EV.HOST_CHECK_MISSION, seq: checkSeq }));
  }, quiet ? 0 : 200);
}

function renderMissionCheck(msg) {
  renderMissionOptions(msg.options);
  // 晚到的舊結果不要蓋掉新的（連續改表單時，回覆順序不保證）
  if (msg.seq !== null && msg.seq !== checkSeq) return;
  missionCheck = msg.check;
  const box = $('#mission-check');
  if (!msg.check && !msg.error) { box.hidden = true; return; }
  box.hidden = false;
  const level = msg.error ? 'block' : msg.check.level;
  box.className = `mission-check ${level}`;
  $('#mission-check-summary').textContent = msg.error
    ?? `${{ ok: '✓', warn: '⚠', block: '✕' }[level]} ${msg.check.summary}`;
  const ul = $('#mission-check-notes');
  ul.replaceChildren();
  for (const note of msg.check?.notes ?? []) {
    const li = document.createElement('li');
    li.textContent = note;
    ul.append(li);
  }
}

for (const id of ['#mission-target', '#mission-team']) $(id).addEventListener('input', () => requestMissionCheck());
for (const id of ['#mission-trait-value', '#mission-spot', '#mission-duration']) {
  $(id).addEventListener('change', () => requestMissionCheck());
}
$('#mission-trait-key').addEventListener('change', () => { renderTraitValues(); requestMissionCheck(); });

(function buildMissionDurations() {
  const sel = $('#mission-duration');
  for (const ms of MISSION_DURATIONS) {
    const o = document.createElement('option');
    o.value = String(ms);
    o.textContent = ms ? `${ms / 60000} 分鐘後自動結算` : '不限時（手動結算）';
    sel.append(o);
  }
})();

/** 依目前表單組出發布訊息。直接發布與「加入節目單」共用，兩邊才不會漂移。 */
function missionStep() {
  const t = missionTypes.find((m) => m.id === $('#mission-type').value);
  const target = Number($('#mission-target').value);
  const durationMs = Number($('#mission-duration').value);
  const color = t?.param === 'colorFamily'
    ? COLOR_FAMILIES.find((f) => f.id === pickedColor) : null;
  const key = $('#mission-trait-key').value;
  const keyInfo = missionOpts.catalog.find((k) => k.key === key);
  const value = $('#mission-trait-value').value;
  const valueLabel = keyInfo?.values.find((v) => v.value === value)?.label;
  const spot = $('#mission-spot').value;
  const spotLabel = missionOpts.spots.find((sp) => sp.id === spot)?.label;
  const teamSize = Number($('#mission-team').value);
  // 節目單上的那一行要看得出條件：「找某一類的人・🦉 貓頭鷹」
  const detail = {
    colorFamily: color?.label,
    trait: valueLabel,
    traitKey: keyInfo?.title,
    spot: spotLabel && `${spotLabel}・${teamSize} 人一組`,
  }[t?.param];
  return {
    kind: 'mission',
    label: [t?.label ?? '任務', detail, t?.verify === 'gather' ? null : `每人 ${target} 次`,
      durationMs ? `${durationMs / 60000} 分鐘` : null].filter(Boolean).join('・'),
    msg: {
      type: EV.HOST_PUBLISH_MISSION,
      missionType: $('#mission-type').value,
      target,
      // 用不到的條件送 null，伺服器只看這個型別需要的那一項
      colorFamily: color ? pickedColor : null,
      trait: t?.param === 'trait' && key && value ? { key, value } : null,
      traitKey: t?.param === 'traitKey' && key ? key : null,
      spot: t?.param === 'spot' ? spot : null,
      teamSize: t?.param === 'spot' ? teamSize : null,
      durationMs,
    },
  };
}

$('#btn-publish').addEventListener('click', () => {
  lastAction = 'mission';
  const step = missionStep().msg;
  // 檢查結果是「沒有人做得完」時先問一句，確認了才帶 force 送出
  // （例如人還沒到齊、想先把任務掛上去）。伺服器端同樣會擋，這裡只是先講清楚。
  if (missionCheck?.level === 'block') {
    if (!confirm(`現在沒有人做得完這個任務：\n${missionCheck.summary}\n\n仍要發布嗎？`)) return;
    step.force = true;
  }
  ws?.send(JSON.stringify(step));
});

/**
 * 進行中的任務：id → 狀態（MISSION_STATE）加上換算好的截止時刻。可以同時好幾個（2026-10-17）。
 * @type {Map<string, object>}
 */
const missionStates = new Map();

/** 收到一個任務的最新狀態。倒數以收到的當下 + remainingMs 換算（同問答），每次更新都重新對齊 */
function updateMission(m) {
  if (!m?.id) return;
  missionStates.set(m.id, { ...m, endAt: m.remainingMs == null ? null : Date.now() + m.remainingMs });
  renderMissions();
}

/** HOST_STATE 帶的是全部進行中任務的清單：以它為準整個重設 */
function syncMissions(list) {
  missionStates.clear();
  for (const m of Array.isArray(list) ? list : []) {
    missionStates.set(m.id, { ...m, endAt: m.remainingMs == null ? null : Date.now() + m.remainingMs });
  }
  renderMissions();
}

const missionLeft = (m) => (m.endAt ? Math.max(0, Math.ceil((m.endAt - Date.now()) / 1000)) : null);
const fmtLeft = (sec) => `剩 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** 結算某個任務。還有人沒達標時多問一句：結算之後進度就收掉了，現場沒有「取消結算」 */
function closeMissionAsk(id) {
  const m = missionStates.get(id);
  const left = m ? m.totalAgents - m.finished : 0;
  if (left > 0 && !confirm(`「${m.title}」還有 ${left} 人沒達標，確定要現在結算嗎？`)) return;
  lastAction = 'mission';
  ws?.send(JSON.stringify({ type: EV.HOST_CLOSE_MISSION, missionId: id }));
}

function renderMissions() {
  const list = $('#mission-list');
  $('#mission-live').hidden = missionStates.size === 0;
  list.replaceChildren(...[...missionStates.values()].map((m) => {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'live-head';
    const tags = Object.assign(document.createElement('span'), { className: 'tags-inline' });
    const sec = missionLeft(m);
    if (sec != null) {
      const timer = Object.assign(document.createElement('span'), { className: 'tag tag-timer', textContent: fmtLeft(sec) });
      timer.dataset.missionTimer = m.id;
      timer.classList.toggle('urgent', sec <= 30);
      tags.append(timer);
    }
    tags.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: `每人 ${m.target} 次` }));
    head.append(Object.assign(document.createElement('b'), { textContent: m.title }), tags);

    const row = Object.assign(document.createElement('div'), { className: 'progress-row' });
    const bar = Object.assign(document.createElement('div'), { className: 'bar' });
    const fill = document.createElement('i');
    fill.style.width = `${m.totalAgents > 0 ? Math.round((m.finished / m.totalAgents) * 100) : 0}%`;
    bar.append(fill);
    row.append(bar, Object.assign(document.createElement('span'), { className: 'mono', textContent: `${m.finished} / ${m.totalAgents}` }));

    const detail = Object.assign(document.createElement('p'), {
      className: 'hint', textContent: `${m.participating} 人已開始，累計完成 ${m.totalCompletions} 次`,
    });
    const close = Object.assign(document.createElement('button'), { className: 'btn-danger', textContent: '結算並關閉' });
    close.addEventListener('click', () => closeMissionAsk(m.id));
    li.append(head, row, detail, close);
    return li;
  }));
}

// 倒數每秒更新文字就好，不整個重建（重建會讓滑鼠下的「結算」按鈕閃一下）
setInterval(() => {
  for (const el of document.querySelectorAll('[data-mission-timer]')) {
    const m = missionStates.get(el.dataset.missionTimer);
    const sec = m ? missionLeft(m) : null;
    if (sec == null) continue;
    el.textContent = fmtLeft(sec);
    el.classList.toggle('urgent', sec <= 30);
  }
}, 1000);

// ─────────────────────────────────────────────────────────────
// 參與者列表
// ─────────────────────────────────────────────────────────────

/**
 * 名冊縮圖。
 *
 * 掃描生成的角色用未切割的整張圖，不用 head.png —— 切線在全身高度的 0.30，
 * 而實測肩線落在 0.490，head 貼圖裡只有額頭到鼻子，當縮圖反而認不出人
 * （見 backend/slicer.py 的 CUTS 與 test_slicer 的量測）。
 *
 * 改版前生成的資產沒有整張圖，退回用取樣色堆出的色塊：認不出五官，
 * 但衣服顏色仍能對上大螢幕上的人，比一格空白有用。
 */
function avatarThumb(avatar) {
  if (!avatar) return document.createTextNode('');

  if (avatar.source === 'CV') {
    const url = avatar.textures?.[CV_FULL_PART];
    if (url) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      img.src = url;
      return img;
    }
    const c = avatar.fallbackColors ?? {};
    const box = document.createElement('span');
    box.className = 'swatch';
    // 比例與 shared/avatars.js 的 CV_CUTS 一致，讓色塊對得上大螢幕的角色
    for (const [hex, frac] of [[c.hair, 0.12], [c.skin, 0.18], [c.torso, 0.34], [c.legs, 0.36]]) {
      const band = document.createElement('i');
      band.style.height = `${frac * 100}%`;
      band.style.background = hex ?? 'transparent';
      box.append(band);
    }
    return box;
  }

  // 捏臉角色：沿用大螢幕那支 SVG 產生器，兩邊不會畫出不同的人
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderAvatarSVG(avatar, { width: 34, height: 44 }))}`;
  return img;
}

/** 場上名冊快取，供事件文案使用 */
let roster = [];

/**
 * 賓果面板。事件驅動（HOST_STATE 不含它），重整時由 HOST_AUTH 的 BINGO_STATE 補送接回。
 * 只顯示進度前幾名 —— 卡片內容是參與者私人的，主辦端也不需要看。
 * 例外是開局勾的自我介紹（picks）：主持人要能幫忘記自己勾什麼的人查（2026-10-17 試玩回饋）。
 */
let bingoDeadlineAt = null;
let bingoCountdown = null;
function renderBingo(round) {
  $('#bingo-idle').hidden = !!round;
  $('#bingo-live').hidden = !round;
  clearInterval(bingoCountdown);
  if (!round) return;
  const asking = round.phase === 'ask';
  // ask 階段倒數的是勾自我介紹的時間，發卡之後才是本輪限時
  const left0 = asking ? round.askRemainingMs : round.remainingMs;
  bingoDeadlineAt = left0 == null ? null : Date.now() + left0;
  const who = asking ? `勾自我介紹中 ${round.answered ?? 0}/${round.players} 人` : `${round.players} 人`;
  const tick = () => {
    if (!bingoDeadlineAt) { $('#bingo-left').textContent = `${who}參加`; return; }
    const left = Math.max(0, bingoDeadlineAt - Date.now());
    $('#bingo-left').textContent = `${who}　剩 ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
  };
  tick();
  if (bingoDeadlineAt) bingoCountdown = setInterval(tick, 1000);
  const ol = $('#bingo-top');
  ol.replaceChildren(...round.top.map((t) => Object.assign(document.createElement('li'), {
    textContent: `${t.name}　連線 ${t.lines}　已填 ${t.filled}/9`,
  })));
  // <details> 本身不重建，主持人展開之後每次更新都還是展開的
  const picks = round.picks;
  $('#bingo-picks-box').hidden = !picks?.length;
  $('#bingo-picks').replaceChildren(...(picks ?? []).map((p) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('b'), { textContent: p.name || '（未命名）' }));
    const text = p.facts === null ? '還沒勾' : p.facts.length ? p.facts.join('、') : '一題都沒勾';
    li.append(Object.assign(document.createElement('span'), { textContent: text, className: p.facts?.length ? '' : 'none' }));
    return li;
  }));
}

// ── 賓果自我介紹題 ──
// 草稿保護照進場問卷的做法（見 personaSaving）：等伺服器廣播回 HOST_BINGO_FACTS 才算存好，
// 未存的草稿不會被另一台主辦端的廣播或重連補送蓋掉。
let bingoFactsDirty = false;
let bingoFactsSaving = false;

function receiveBingoFacts(view) {
  $('#bingo-facts-default').hidden = !view.isDefault;
  if (bingoFactsSaving) {
    bingoFactsSaving = false;
    bingoFactsDirty = false;
  }
  if (!bingoFactsDirty) {
    $('#bingo-facts').value = view.facts.join('\n');
    $('#btn-bingo-facts-save').disabled = true;
  }
}

function bingoFactsSaveRejected() {
  if (!bingoFactsSaving) return;
  bingoFactsSaving = false;
  $('#btn-bingo-facts-save').disabled = false;
}

$('#bingo-facts').addEventListener('input', () => {
  bingoFactsDirty = true;
  if (!bingoFactsSaving) $('#btn-bingo-facts-save').disabled = false;
});

$('#btn-bingo-facts-save').addEventListener('click', () => {
  lastAction = 'bingo';
  const facts = $('#bingo-facts').value.split('\n').map((t) => t.trim()).filter(Boolean);
  ws?.send(JSON.stringify({ type: EV.HOST_SET_BINGO_FACTS, facts }));
  bingoFactsSaving = true;
  $('#btn-bingo-facts-save').disabled = true;
});

$('#btn-bingo-facts-reset').addEventListener('click', () => {
  if (!confirm('確定要恢復成這個場景的預設題目嗎？目前的修改會消失。')) return;
  lastAction = 'bingo';
  bingoFactsDirty = false;
  bingoFactsSaving = false;
  ws?.send(JSON.stringify({ type: EV.HOST_SET_BINGO_FACTS, facts: null }));
});

$('#btn-bingo-start').addEventListener('click', () => {
  lastAction = 'bingo';
  ws?.send(JSON.stringify({ type: EV.HOST_START_BINGO, durationMs: Number($('#bingo-duration').value) }));
});

$('#btn-bingo-end').addEventListener('click', () => {
  if (!confirm('確定要結束這一輪賓果嗎？')) return;
  ws?.send(JSON.stringify({ type: EV.HOST_END_BINGO }));
});


function renderState(state) {
  roster = state.agents ?? [];
  if (state.personaSpread) renderPersonaSpread(state.personaSpread);
  $('#stat-audience').textContent = state.audience ?? 0;
  topicsOn = state.topics !== false;
  $('#btn-topics').setAttribute('aria-pressed', String(topicsOn));
  $('#btn-topics').textContent = topicsOn ? '話題桌：開' : '話題桌：關';
  $('#stat-audience-box').hidden = !state.audience;
  $('#people-count').textContent = state.agents.length;
  $('#tab-people-count').textContent = state.agents.length;
  $('#people-empty').hidden = state.agents.length > 0;
  // 沒有人時連表頭都不顯示，只剩一行「還沒有人進場」
  $('#people-wrap').hidden = state.agents.length === 0;

  const body = $('#people-body');
  body.replaceChildren();

  // 每個進行中任務各自的進度，依發布順序排（同主辦端任務卡片的順序）
  const activeMissions = Array.isArray(state.missions) ? state.missions : [];

  for (const a of state.agents) {
    const tr = document.createElement('tr');

    const face = document.createElement('td');
    face.className = 'face';
    face.append(avatarThumb(a.avatar));

    // 名稱一律以 textContent 寫入：它來自使用者輸入，
    // 伺服器只剝除控制字元並未跳脫 HTML
    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = a.name;
    if (a.offline) {
      const b = document.createElement('span');
      b.className = 'badge-off';
      b.textContent = '離線';
      name.append(b);
    }

    const score = document.createElement('td');
    score.className = 'num';
    score.textContent = a.score ?? 0;

    const prog = document.createElement('td');
    prog.className = 'num';
    if (activeMissions.length) {
      const counts = activeMissions.map((m) => ({ n: a.progress?.[m.id] ?? 0, target: m.target }));
      prog.textContent = counts.map((c) => `${c.n} / ${c.target}`).join('・');
      if (counts.every((c) => c.n >= c.target)) prog.classList.add('done');
    } else {
      prog.textContent = '—';
    }

    const conn = document.createElement('td');
    conn.className = 'num';
    conn.textContent = a.connections;

    const active = document.createElement('td');
    active.className = 'num';
    active.textContent = `${Math.round(a.activeMs / 1000)}s`;

    const act = document.createElement('td');
    act.className = 'act';
    const kick = document.createElement('button');
    kick.className = 'btn-kick';
    kick.textContent = '移除';
    kick.addEventListener('click', () => {
      if (!confirm(`確定要將「${a.name}」移出現場嗎？`)) return;
      ws?.send(JSON.stringify({ type: EV.HOST_KICK, agentId: a.id }));
      pushFeed(`移除參與者 ${a.name}`, 'ev-mission');
    });
    act.append(kick);

    // 問卷標籤：主辦端要能一眼看出「答某個選項的人湊不湊得出一隊」
    const tags = document.createElement('td');
    const tagWrap = document.createElement('div');
    tagWrap.className = 'tags';
    for (const t of Object.values(a.traits ?? {})) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = t.label;   // 標籤文字來自題庫或主辦端輸入，一律 textContent
      tagWrap.append(chip);
    }
    tags.append(tagWrap);

    tr.append(face, name, tags, score, prog, conn, active, act);
    body.append(tr);
  }

  syncMissions(state.missions);

  // 主辦端中途重新整理時，用這份現況把問答與排行榜補回畫面
  quiz = state.quiz ?? null;
  reveal = state.quiz ? (state.quizReveal ?? null) : null;
  renderQuiz();
  renderRanks(state.leaderboard ?? []);
}

// ─────────────────────────────────────────────────────────────
// 生成歷史（原始照片、生成結果、token、花費、使用模型）
//
// 走 REST 而非 WS：這批資料量比其他控制台狀態大得多（縮圖），塞進
// HOST_STATE 會讓每次狀態廣播都變重，而歷史紀錄本來就不需要即時推播，
// 用輪詢就夠。存取控制比照 HOST_AUTH 的理由帶通行密鑰，見 server/index.js
// 的 handleHostHistory。
// ─────────────────────────────────────────────────────────────
const HISTORY_LIMIT = 30;
const HISTORY_POLL_MS = 20000;
let historyPollTimer = null;

const STATUS_LABEL = {
  success: '成功', ok: '成功', base_only: '成功（未過驗證）',
  failed: '失敗', running: '處理中',
};

function startHistoryPolling() {
  if (historyPollTimer) return;
  loadHistory();
  historyPollTimer = setInterval(loadHistory, HISTORY_POLL_MS);
}

function stopHistoryPolling() {
  clearInterval(historyPollTimer);
  historyPollTimer = null;
}

async function loadHistory() {
  if (!hostKeyValue) return;
  try {
    const key = encodeURIComponent(hostKeyValue);
    const [listRes, summaryRes] = await Promise.all([
      fetch(`/api/host/history?key=${key}&limit=${HISTORY_LIMIT}`),
      fetch(`/api/host/history/summary?key=${key}`),
    ]);
    const list = await listRes.json();
    const summary = await summaryRes.json();
    renderHistory(Array.isArray(list.items) ? list.items : []);
    renderHistorySummary(summary);
  } catch {
    // 歷史紀錄是次要資訊，安靜失敗即可，不擋主控台其餘功能
  }
}

function renderHistorySummary(summary) {
  const el = $('#history-summary');
  if (!summary || typeof summary.run_count !== 'number') {
    el.textContent = '暫時讀不到生成服務的統計。';
    return;
  }
  const cost = Number(summary.cost_usd || 0).toFixed(4);
  const successRate = Math.round((summary.success_rate || 0) * 100);
  el.textContent =
    `共 ${summary.run_count} 次生成・成功率 ${successRate}%・累計花費 $${cost}・累計 ${summary.total_tokens || 0} tokens`;
}

function historyThumb(url, alt) {
  if (!url) {
    const span = document.createElement('span');
    span.className = 'swatch';
    span.style.background = 'var(--sunk)';
    return span;
  }
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = alt;
  img.loading = 'lazy';
  img.style.cursor = 'zoom-in';
  img.src = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(hostKeyValue)}`;
  img.addEventListener('click', () => window.open(img.src, '_blank'));
  // 檔案已被清掉（或紀錄本身沒有對應的檔案）時，不要顯示破圖加替代文字 ——
  // 那在窄欄裡會擠成「生成結／果」，看起來像整張表壞了。換成同一種空色塊。
  img.addEventListener('error', () => {
    const span = document.createElement('span');
    span.className = 'swatch';
    span.style.background = 'var(--sunk)';
    span.title = `${alt}：檔案已不存在`;
    img.replaceWith(span);
  }, { once: true });
  return img;
}

function renderHistory(items) {
  $('#history-count').textContent = items.length;
  $('#history-empty').hidden = items.length > 0;

  const body = $('#history-body');
  body.replaceChildren();

  for (const item of items) {
    const tr = document.createElement('tr');

    const before = document.createElement('td');
    before.className = 'face';
    before.append(historyThumb(
      item.input_path ? `/api/host/history/inputs/${encodeURIComponent(item.input_path)}` : null,
      '原始照片',
    ));

    const after = document.createElement('td');
    after.className = 'face';
    after.append(historyThumb(
      item.output_path ? `/api/host/history/outputs/${encodeURIComponent(item.output_path)}` : null,
      '生成結果',
    ));

    const time = document.createElement('td');
    time.className = 'num';
    time.textContent = item.created_at
      ? new Date(item.created_at * 1000).toLocaleTimeString('zh-TW', { hour12: false })
      : '—';

    const status = document.createElement('td');
    status.className = 'status';
    status.textContent = STATUS_LABEL[item.status] ?? item.status ?? '—';
    if (item.status === 'failed') status.style.color = 'var(--danger)';
    else if (item.status === 'success' || item.status === 'ok' || item.status === 'base_only') {
      status.style.color = 'var(--teal)';
    }

    const model = document.createElement('td');
    model.textContent = item.model ?? '—';

    const tokens = document.createElement('td');
    tokens.className = 'num';
    tokens.textContent = item.token_reported ? (item.total_tokens ?? 0) : '—';

    const cost = document.createElement('td');
    cost.className = 'num';
    cost.textContent = item.cost_usd ? `$${Number(item.cost_usd).toFixed(4)}` : '—';

    const duration = document.createElement('td');
    duration.className = 'num';
    duration.textContent = item.duration_ms != null ? `${(item.duration_ms / 1000).toFixed(1)}s` : '—';

    const exportCell = document.createElement('td');
    exportCell.className = 'export';
    // 只有成功的紀錄才有貼圖可匯出（request_id 即 public/assets/gen 下的資產目錄名）
    if (EXPORTABLE.has(item.status) && /^[0-9a-f]{32}$/.test(item.request_id ?? '')) {
      exportCell.append(
        exportButton('圖檔', '下載去背的角色 PNG', item.request_id, 'image'),
        exportButton('角色檔', '下載 .persona.json（貼圖＋外觀設定，程式可直接讀）', item.request_id, 'bundle'),
      );
    } else {
      exportCell.textContent = '—';
    }

    tr.append(before, after, time, status, model, tokens, cost, duration, exportCell);
    body.append(tr);
  }
}

const EXPORTABLE = new Set(['ok', 'success', 'base_only']);

function exportButton(label, title, requestId, kind) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-ghost btn-export';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', () => exportCharacter(b, requestId, kind));
  return b;
}

/**
 * 下載匯出檔。用 fetch 而不是直接開連結：舊資產可能已被清掉或缺貼圖，
 * 直接開連結的話主辦端只會看到一頁 JSON 錯誤，而不是一句看得懂的說明。
 */
async function exportCharacter(button, requestId, kind) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '下載中…';
  try {
    const res = await fetch(`/api/host/history/${requestId}/${kind}?key=${encodeURIComponent(hostKeyValue)}`);
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).error ?? ''; } catch { /* 略 */ }
      throw new Error(EXPORT_ERRORS[reason] ?? `匯出失敗（${res.status}）`);
    }
    const blob = await res.blob();
    const fromHeader = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fromHeader ?? `character-${requestId.slice(0, 8)}${kind === 'image' ? '.png' : '.persona.json'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    showError(err.message || '匯出失敗', '#history-err');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const EXPORT_ERRORS = {
  asset_not_found: '找不到這個角色的貼圖（可能已被清除）',
  asset_incomplete: '這個角色的貼圖不完整，無法匯出',
  invalid_asset_id: '紀錄編號不正確',
};

$('#btn-history-refresh').addEventListener('click', loadHistory);

// ─────────────────────────────────────────────────────────────
// 分頁與玩法切換
//
// 分頁只是換顯示，不影響任何進行中的活動。玩法同理：切到別的玩法
// 不會中止正在跑的那一個，所以進行中的玩法在選單與「活動選單」分頁上
// 各有一顆亮點 —— 主辦者切走之後才找得回來。
// ─────────────────────────────────────────────────────────────
// 節目單放第一個、也是預設分頁：活動進行中主持人主要看這一頁（2026-10-17）
const TABS = ['plan', 'play', 'people', 'system'];
const TAB_KEY = 'pixelair.hostTab';
let activeTab = 'plan';

function selectTab(id, focus = false) {
  activeTab = id;
  // 記住看到哪一頁：活動進行中重新整理，要回到節目單而不是被丟回「活動選單」
  try { localStorage.setItem(TAB_KEY, id); } catch { /* 略 */ }
  if (id === 'people') $('#report-dot').hidden = true;
  for (const t of TABS) {
    const btn = $(`#tab-btn-${t}`);
    const on = t === id;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    $(`#tab-${t}`).hidden = !on;
    if (on && focus) btn.focus();
  }
  if (id === 'system' && authed) startHistoryPolling();
  else stopHistoryPolling();
}

for (const t of TABS) {
  const btn = $(`#tab-btn-${t}`);
  btn.addEventListener('click', () => selectTab(t));
  // WAI-ARIA tabs：左右鍵在分頁間移動
  btn.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    selectTab(TABS[(TABS.indexOf(t) + step + TABS.length) % TABS.length], true);
  });
}

function selectActivity(act) {
  for (const c of document.querySelectorAll('.act-chip')) {
    c.setAttribute('aria-pressed', String(c.dataset.act === act));
  }
  for (const p of document.querySelectorAll('.act-panel')) {
    p.hidden = p.dataset.act !== act;
  }
}

for (const c of document.querySelectorAll('.act-chip')) {
  c.addEventListener('click', () => selectActivity(c.dataset.act));
}

/** 各玩法「進行中」的畫面。看它的 hidden 就知道該玩法有沒有在跑。 */
const LIVE_VIEW = {
  mission: '#mission-live',
  wordcloud: '#wordcloud-live',
  bingo: '#bingo-live',
  quiz: '#quiz-live',
};

// 用 MutationObserver 而不是在每個 render 函式裡補一行：
// 新增玩法時只要在 LIVE_VIEW 登記，不必記得去改好幾個地方
const wasLive = {};
function syncLiveDots() {
  let any = false;
  const picked = $('.act-chip[aria-pressed="true"]')?.dataset.act;
  for (const [act, sel] of Object.entries(LIVE_VIEW)) {
    const live = !$(sel).hidden;
    any ||= live;
    $(`.act-chip[data-act="${act}"] .live-dot`).hidden = !live;
    // 剛開始跑的玩法自動切過去（主辦端重新整理後才接得回進行中的那一個），
    // 但目前看的玩法本身在跑時不搶畫面
    if (live && !wasLive[act] && act !== picked && !wasLive[picked]) selectActivity(act);
    wasLive[act] = live;
  }
  $('#play-live-dot').hidden = !any;
  $('#plan-live-dot').hidden = !any;
  renderLiveControl();
}
const liveObserver = new MutationObserver(syncLiveDots);
for (const sel of Object.values(LIVE_VIEW)) {
  liveObserver.observe($(sel), { attributes: true, attributeFilter: ['hidden'] });
}

// ─────────────────────────────────────────────────────────────
// 現場動態
// ─────────────────────────────────────────────────────────────
// 存在這台電腦的瀏覽器裡：原本只在記憶體，主控台一重新整理整串就沒了。
// 超過 12 小時的丟掉（隔天的活動不該看到昨天的動態）。
const FEED_KEY = 'pixelair.feed';
const FEED_MAX = 60;
const FEED_TTL_MS = 12 * 60 * 60 * 1000;
/** 重連時伺服器會補送進行中的題目等狀態，同一句話在這段時間內只記一次 */
const FEED_DEDUPE_MS = 3 * 60 * 1000;
let feedLog = [];
try {
  const saved = JSON.parse(localStorage.getItem(FEED_KEY) ?? '[]');
  if (Array.isArray(saved)) feedLog = saved.filter((e) => e && typeof e.text === 'string' && Date.now() - e.at < FEED_TTL_MS);
} catch { feedLog = []; }

function renderFeedItem({ at, text, cls }) {
  const ul = $('#feed');
  // 刪整列而不只是那段字：只刪 span 會留下一行只有時間的空白紀錄
  ul.querySelector('.ev-empty')?.closest('li')?.remove();

  const li = document.createElement('li');
  const t = document.createElement('time');
  t.textContent = new Date(at).toLocaleTimeString('zh-TW', { hour12: false });
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  li.append(t, span);
  ul.prepend(li);

  while (ul.children.length > FEED_MAX) ul.lastElementChild.remove();
}

function pushFeed(text, cls) {
  const now = Date.now();
  // 佔位字只畫不存：重新整理後有紀錄就不該再出現「等待現場活動…」
  if (cls === 'ev-empty') { renderFeedItem({ at: now, text, cls }); return; }
  if (feedLog.some((e) => e.text === text && now - e.at < FEED_DEDUPE_MS)) return;
  const entry = { at: now, text, cls };
  feedLog.unshift(entry);
  feedLog.length = Math.min(feedLog.length, FEED_MAX);
  try { localStorage.setItem(FEED_KEY, JSON.stringify(feedLog)); } catch { /* 略 */ }
  renderFeedItem(entry);
}

if (feedLog.length) for (const e of [...feedLog].reverse()) renderFeedItem(e);
else pushFeed('等待現場活動…', 'ev-empty');

// ─────────────────────────────────────────────────────────────
// 即時問答
// ─────────────────────────────────────────────────────────────
const BANK_KEY = 'pixelair.quizBank';

/** @type {object|null} 目前的題目（伺服器視圖，不含正解） */
let quiz = null;
/** @type {object|null} 揭曉結果 */
let reveal = null;
let countdownTimer = null;
/** 正在編輯的題庫題目（索引）。null＝編輯區是新題目，「存入題庫」會新增一題 */
let editingIndex = null;
/** 倒數基準：以收到題目的當下 + remainingMs 換算，不依賴這台電腦的時鐘是否準確 */
let deadlineAt = 0;

/** 題庫。存在主辦端這台電腦，活動前就能把題目都打好。 */
function loadBank() {
  try { return JSON.parse(localStorage.getItem(BANK_KEY) ?? '[]'); } catch { return []; }
}
function saveBank(items) {
  try { localStorage.setItem(BANK_KEY, JSON.stringify(items)); } catch { /* 略 */ }
  renderBank();
}

/** 選項輸入列：radio 標正解，文字框填內容。留白的選項會被忽略。 */
function buildOptionRows() {
  const wrap = $('#q-options');
  wrap.replaceChildren();
  for (let i = 0; i < QUIZ.maxOptions; i++) {
    const row = document.createElement('div');
    row.className = 'q-opt';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'q-correct';
    radio.value = String(i);
    radio.checked = i === 0;
    radio.setAttribute('aria-label', `第 ${QUIZ_CHOICES[i].label} 個選項是正確答案`);
    radio.addEventListener('change', markCorrectRow);

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = QUIZ_CHOICES[i].glyph;
    glyph.style.color = QUIZ_CHOICES[i].color;

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = QUIZ.maxOptionLength;
    input.dataset.opt = String(i);
    input.placeholder = i < QUIZ.minOptions ? `選項 ${QUIZ_CHOICES[i].label}` : '（留白＝不使用）';

    row.append(radio, glyph, input);
    wrap.append(row);
  }
  markCorrectRow();
}

function markCorrectRow() {
  document.querySelectorAll('#q-options .q-opt').forEach((row) => {
    row.classList.toggle('is-correct', row.querySelector('input[type="radio"]').checked);
  });
}

function readDraft() {
  const options = [...document.querySelectorAll('#q-options input[type="text"]')]
    .map((el) => el.value.trim());
  const correctIndex = Number(
    document.querySelector('#q-options input[type="radio"]:checked')?.value ?? 0,
  );
  return {
    question: $('#q-text').value.trim(),
    options,
    correctIndex,
    durationMs: Number($('#q-duration').value),
    talkMs: Number($('#q-talk').value),
  };
}

function writeDraft(d) {
  $('#q-text').value = d.question ?? '';
  document.querySelectorAll('#q-options input[type="text"]').forEach((el, i) => {
    el.value = d.options?.[i] ?? '';
  });
  const radio = document.querySelector('#q-options input[type="radio"][value="' + (d.correctIndex ?? 0) + '"]');
  if (radio) radio.checked = true;
  if (d.durationMs) setSelect($('#q-duration'), d.durationMs, `${d.durationMs / 1000} 秒`);
  // 舊題庫的題目沒有這個欄位：沿用表單目前的選擇，不要默默改成「不討論」
  if (d.talkMs !== undefined) setSelect($('#q-talk'), d.talkMs, `${d.talkMs / 1000} 秒`);
  markCorrectRow();
}

/**
 * 設定下拉選單；值不在選項裡就補一個。匯入的 .txt 可以寫「時間 45」，
 * 直接設 value 會變成空選，出題時作答時間就默默掉回預設。
 */
function setSelect(sel, value, label) {
  const v = String(value);
  if (![...sel.options].some((o) => o.value === v)) sel.append(new Option(label, v));
  sel.value = v;
}

/**
 * 出題前的本地檢查。
 *
 * 伺服器一定會再驗一次（客戶端的檢查永遠不算數），這裡擋的是現場最常見的手滑：
 * 正解那格是空的。等伺服器回拒絕才發現，主辦者已經對著全場說「下一題」了。
 */
function validateDraft(d) {
  if (!d.question) return '題目不可為空';
  const filled = d.options.filter(Boolean);
  if (filled.length < QUIZ.minOptions) return `至少要有 ${QUIZ.minOptions} 個選項`;
  if (!d.options[d.correctIndex]) return '被標為正解的選項是空的';
  return null;
}

/** 送出前濾掉留白的選項，正解索引要跟著位移 */
function packDraft(d) {
  const kept = [];
  let correctIndex = 0;
  d.options.forEach((text, i) => {
    if (!text) return;
    if (i === d.correctIndex) correctIndex = kept.length;
    kept.push(text);
  });
  return { question: d.question, options: kept, correctIndex, durationMs: d.durationMs, talkMs: d.talkMs ?? 0 };
}

/** 題目 → 節目單步驟。不合法時回傳 null 並把原因顯示在問答面板 */
function quizStep(draft) {
  const err = validateDraft(draft);
  if (err) { showError(err, '#quiz-err'); return null; }
  return {
    kind: 'quiz',
    label: draft.question,   // 只放題目不放正解：節目單常常整個被看到
    msg: { type: EV.HOST_START_QUIZ, ...packDraft(draft) },
  };
}

function startQuiz(draft) {
  const step = quizStep(draft);
  if (!step) return;
  lastAction = 'quiz';
  ws?.send(JSON.stringify(step.msg));
}

// ── 連續問答：題庫一次跑完 ────────────────────────────────
// 進度存在這台電腦（localStorage）：主控台中途重整，回來仍按得到「下一題」。
// 伺服器只知道「現在這一題」，題目順序是主辦端的事 —— 跟節目單同一個做法。
const RUN_KEY = 'pixelair.quizRun';
/** @type {{items: object[], index: number}|null} */
let quizRun = null;
try { quizRun = JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null'); } catch { quizRun = null; }

function saveRun() {
  try {
    if (quizRun) localStorage.setItem(RUN_KEY, JSON.stringify(quizRun));
    else localStorage.removeItem(RUN_KEY);
  } catch { /* 略 */ }
}

/** 題庫裡的題目補上出題需要的欄位（舊題庫的題目可能沒有時間設定） */
const bankDraft = (item) => ({ durationMs: QUIZ.defaultDurationMs, talkMs: Number($('#q-talk').value), ...item });

/** 現在台上這題是不是連續問答裡的那一題（節目單或別台主辦端出的題不算） */
const inRun = () => !!(quizRun && quiz && quizRun.items[quizRun.index]
  && quizRun.items[quizRun.index].question.replace(/\s+/g, ' ').trim() === quiz.question);

function startRun() {
  const items = loadBank();
  if (!items.length) return;
  quizRun = { items, index: 0 };
  saveRun();
  startQuiz(bankDraft(items[0]));
}

/** 收掉這題、接著出下一題；最後一題時結束整輪 */
function nextInRun() {
  if (!quizRun) return;
  ws?.send(JSON.stringify({ type: EV.HOST_END_QUIZ }));
  const next = quizRun.index + 1;
  if (next >= quizRun.items.length) {
    pushFeed(`問答結束，共 ${quizRun.items.length} 題`, 'ev-quiz');
    quizRun = null;
    saveRun();
    return;
  }
  quizRun.index = next;
  saveRun();
  // 伺服器依序處理同一條連線的訊息：上面的收題一定先於這裡的出題
  startQuiz(bankDraft(quizRun.items[next]));
}

$('#btn-quiz-run').addEventListener('click', startRun);
$('#btn-quiz-next').addEventListener('click', nextInRun);
$('#btn-quiz-stop').addEventListener('click', () => {
  if (!confirm('中止這一輪問答？目前這題會直接收掉，後面的題目不再出。')) return;
  quizRun = null;
  saveRun();
  ws?.send(JSON.stringify({ type: EV.HOST_END_QUIZ }));
});

$('#btn-quiz-save').addEventListener('click', () => {
  const draft = readDraft();
  const err = validateDraft(draft);
  if (err) { showError(err, '#quiz-err'); return; }
  const bank = loadBank();
  if (editingIndex !== null && bank[editingIndex]) {
    bank[editingIndex] = draft;
    setEditing(null);
    saveBank(bank);
    writeDraft({ question: '', options: [], correctIndex: 0 });
  } else {
    saveBank([...bank, draft]);
  }
});

/** 進入／離開「編輯題庫裡的某一題」。編輯中「存入題庫」改成覆蓋原題，不再多存一份 */
function setEditing(index) {
  editingIndex = index;
  $('#quiz-editing').hidden = index === null;
  $('#btn-quiz-save').textContent = index === null ? '存入題庫' : '更新這題';
  $('#quiz-add-title').textContent = index === null ? '新增題目' : `編輯第 ${index + 1} 題`;
  if (index !== null) $('#quiz-add').open = true;
  renderBank();
}

$('#btn-quiz-edit-cancel').addEventListener('click', () => {
  setEditing(null);
  writeDraft({ question: '', options: [], correctIndex: 0 });
});

$('#btn-bank-clear').addEventListener('click', () => {
  if (!loadBank().length) return;
  if (!confirm('確定要清空題庫嗎？此動作無法復原。')) return;
  setEditing(null);
  saveBank([]);
});

// ── 題庫 ⇄ .txt ──────────────────────────────────────────
// 主持人多半是在活動前用記事本整理題目、或從別台電腦帶過來；題庫只存在這台
// 瀏覽器裡，沒有匯出入就只能在現場一題一題重打。
$('#btn-bank-export').addEventListener('click', () => {
  const bank = loadBank();
  // 題庫是空的也給檔案：裡面的格式說明就是給第一次寫題目的人看的範本
  const text = '﻿' + quizBankToText(bank).replace(/\n/g, '\r\n');   // BOM＋CRLF：舊版記事本才不會亂碼、擠成一行
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `問答題庫-${bank.length}題.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#btn-bank-import').addEventListener('click', () => $('#bank-file').click());

$('#bank-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';   // 同一個檔案改完再選一次也要觸發 change
  if (!file) return;
  if (file.size > 512 * 1024) { showBankMsg('檔案太大，不像是題庫（上限 512KB）。'); return; }
  const { items, errors } = parseQuizText(await file.text());
  // 加在題庫後面，已經有的題目略過：匯入同一份兩次不會變兩倍
  const bank = loadBank();
  const fresh = items.filter((q) => !bank.some((b) => sameQuiz(b, q)));
  if (fresh.length) saveBank([...bank, ...fresh]);
  const parts = [`匯入 ${fresh.length} 題`];
  if (items.length > fresh.length) parts.push(`${items.length - fresh.length} 題已在題庫裡，略過`);
  if (errors.length) parts.push(`${errors.length} 題有問題沒匯入`);
  if (!items.length && !errors.length) parts.splice(0, parts.length, '檔案裡沒有找到題目。格式可以先按「下載 .txt」參考。');
  showBankMsg(parts.join('，') + '。', errors);
});

function showBankMsg(text, errors = []) {
  const el = $('#bank-msg');
  el.replaceChildren(text);
  if (errors.length) {
    const ul = document.createElement('ul');
    for (const err of errors) {
      const li = document.createElement('li');
      li.textContent = err;   // 檔案內容是外部輸入，一律 textContent
      ul.append(li);
    }
    el.append(ul);
  }
  el.hidden = false;
  clearTimeout(showBankMsg.timer);
  // 有錯誤時留著讓人對照檔案修改；沒錯誤的提示幾秒後收掉
  if (!errors.length) showBankMsg.timer = setTimeout(() => { el.hidden = true; }, 5000);
}

$('#btn-quiz-reveal').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: EV.HOST_REVEAL_QUIZ }));
});

$('#btn-quiz-end').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: EV.HOST_END_QUIZ }));
});

function renderBank() {
  const items = loadBank();
  const ul = $('#quiz-bank');
  $('#bank-count').textContent = items.length;
  ul.replaceChildren();

  $('#bank-empty').hidden = items.length > 0;
  $('#btn-quiz-run').disabled = items.length === 0;
  $('#btn-quiz-run').textContent = items.length ? `開始問答（${items.length} 題）` : '開始問答';
  // 題庫空著時直接攤開「新增題目」，不必先找到摺起來的那一塊
  if (!items.length) $('#quiz-add').open = true;

  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.classList.toggle('is-editing', i === editingIndex);

    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = String(i + 1);

    const q = document.createElement('span');
    q.className = 'q';
    q.textContent = item.question;  // 主辦者自己打的字，仍一律走 textContent

    // 連續出題依題庫順序，所以要能調順序。跟節目單同一種上下箭頭（smallBtn）
    const move = (d) => () => {
      const next = loadBank();
      const j = i + d;
      if (j < 0 || j >= next.length) return;
      [next[i], next[j]] = [next[j], next[i]];
      if (editingIndex === i) editingIndex = j;
      else if (editingIndex === j) editingIndex = i;
      saveBank(next);
    };
    const up = smallBtn('↑', `第 ${i + 1} 題往前移`, move(-1));
    const down = smallBtn('↓', `第 ${i + 1} 題往後移`, move(1));

    const use = document.createElement('button');
    use.className = 'bank-load';
    use.textContent = '編輯';
    use.addEventListener('click', () => {
      writeDraft(item);
      setEditing(i);
      $('#q-text').focus();
    });

    const del = document.createElement('button');
    del.className = 'btn-kick';
    del.textContent = '刪除';
    del.addEventListener('click', () => {
      const next = loadBank();
      next.splice(i, 1);
      // 刪掉的正是編輯中的題目就離開編輯；刪掉前面的題目，編輯中的索引要跟著往前
      if (editingIndex === i) setEditing(null);
      else if (editingIndex !== null && editingIndex > i) editingIndex--;
      saveBank(next);
    });

    li.append(no, q, up, down, use, del);
    ul.append(li);
  });
}

function renderQuizTally() {
  if (!quiz) return;
  const total = roster.length;
  $('#quiz-answered').textContent = `${quiz.answered ?? 0} / ${total}`;
  $('#quiz-bar').style.width = total > 0
    ? `${Math.round(((quiz.answered ?? 0) / total) * 100)}%`
    : '0%';
}

function renderQuiz() {
  const compose = $('#quiz-compose');
  const live = $('#quiz-live');
  clearInterval(countdownTimer);
  countdownTimer = null;

  if (!quiz) {
    compose.hidden = false;
    live.hidden = true;
    return;
  }

  compose.hidden = true;
  live.hidden = false;
  $('#quiz-live-q').textContent = quiz.question;
  renderQuizTally();

  const revealed = quiz.phase === QUIZ_PHASE.REVEALED || reveal !== null;
  const run = inRun();
  const last = run && quizRun.index === quizRun.items.length - 1;
  $('#quiz-run-prog').hidden = !run;
  if (run) $('#quiz-run-prog').textContent = `連續問答　第 ${quizRun.index + 1} / ${quizRun.items.length} 題`;
  $('#btn-quiz-reveal').hidden = revealed;
  // 連續問答：公布後只有一顆「下一題」（最後一題是「結束問答」）；單題（節目單出的）照舊收題
  $('#btn-quiz-next').hidden = !(revealed && run);
  $('#btn-quiz-next').textContent = last ? '結束問答' : `下一題（${quizRun?.index + 2} / ${quizRun?.items.length}）`;
  $('#btn-quiz-end').hidden = !revealed || run;
  $('#btn-quiz-stop').hidden = !run || last;

  const list = $('#quiz-result');
  list.replaceChildren();

  if (revealed && reveal) {
    const el = $('#quiz-countdown');
    el.textContent = '已公布';
    el.classList.remove('urgent');

    const max = Math.max(1, ...reveal.counts);
    quiz.options.forEach((text, i) => {
      const li = document.createElement('li');
      if (i === reveal.correctIndex) li.className = 'right';

      const top = document.createElement('div');
      top.className = 'top';
      const label = document.createElement('span');
      label.className = 'txt';
      label.textContent = `${QUIZ_CHOICES[i].glyph}　${text}`;
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = `${reveal.counts[i]} 人`;
      top.append(label, cnt);

      const track = document.createElement('div');
      track.className = 'track';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round((reveal.counts[i] / max) * 100)}%`;
      track.append(fill);

      li.append(top, track);
      list.append(li);
    });
    return;
  }

  // 作答中只列選項，不顯示分佈 —— 主辦端的螢幕在現場常常也被投影出去
  quiz.options.forEach((text, i) => {
    const li = document.createElement('li');
    const top = document.createElement('div');
    top.className = 'top';
    const label = document.createElement('span');
    label.className = 'txt';
    label.textContent = `${QUIZ_CHOICES[i].glyph}　${text}`;
    top.append(label);
    li.append(top);
    list.append(li);
  });

  deadlineAt = Date.now() + (quiz.remainingMs ?? 0);
  const tick = () => {
    const left = Math.max(0, deadlineAt - Date.now());
    const el = $('#quiz-countdown');
    const talking = quiz.phase === QUIZ_PHASE.DISCUSS;
    el.textContent = `${talking ? '討論中　' : ''}${(left / 1000).toFixed(1)} 秒`;
    el.classList.toggle('urgent', !talking && left < 5000);
    if (left <= 0) { clearInterval(countdownTimer); countdownTimer = null; }
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

// ─────────────────────────────────────────────────────────────
// 排行榜
// ─────────────────────────────────────────────────────────────
function renderRanks(rows) {
  const ol = $('#ranks');
  ol.replaceChildren();
  $('#ranks-empty').hidden = rows.length > 0;

  for (const r of rows) {
    const li = document.createElement('li');
    if (r.rank <= 3) li.className = 'top';

    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = r.rank;

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.name || r.id;

    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = r.score;

    li.append(no, who, pts);
    ol.append(li);
  }
}

buildOptionRows();
renderBank();

// ─────────────────────────────────────────────────────────────
// 節目單
//
// 主持人在現場要一邊對著全場講話一邊操作，少想一步就少出一次錯。
// 活動前在各玩法按「加入節目單」，把當下的設定原封不動存成一則訊息；
// 現場按「下一項」就是把那則訊息送出去，與直接按該玩法的按鈕完全相同。
// 存在這台電腦的瀏覽器裡（同題庫），伺服器重開也不會掉。
// ─────────────────────────────────────────────────────────────
const RS_KEY = 'pixelair.runSheet';
const RS_KIND = {
  mission: '任務', wordcloud: '文字雲',
  quiz: '問答', photo: '合照', theme: '場景', bingo: '賓果',
  // 已移除的玩法：舊節目單裡若還存著，至少看得出是什麼（按下一項會被伺服器忽略）
  survey: '問卷（已移除）', treasure: '尋寶（已移除）', harvest: '採水果（已移除）',
};

function loadRunSheet() {
  try {
    const v = JSON.parse(localStorage.getItem(RS_KEY) ?? 'null');
    if (v && Array.isArray(v.steps)) return { steps: v.steps, pointer: Number(v.pointer) || 0 };
  } catch { /* 略 */ }
  return { steps: [], pointer: 0 };
}
function saveRunSheet(rs) {
  try { localStorage.setItem(RS_KEY, JSON.stringify(rs)); } catch { /* 略 */ }
  renderRunSheet();
}

function addStep(step) {
  if (!step) return;
  const rs = loadRunSheet();
  rs.steps.push(step);
  saveRunSheet(rs);
  pushFeed(`節目單加入：${RS_KIND[step.kind]}　${step.label}`, 'ev-plan');
}

const STEP_BUILDERS = {
  mission: missionStep,
  wordcloud: wordcloudStep,
  // 整份題庫連續問答。步驟裡不存題目：跑到這一項時才讀當下的題庫（見 runNextStep）
  quizrun: () => {
    const n = loadBank().length;
    if (!n) { showError('題庫是空的，先存幾題再加入節目單', '#quiz-err'); return null; }
    return { kind: 'quiz', label: `連續問答（題庫，目前 ${n} 題）`, run: true };
  },
  bingo: () => {
    const durationMs = Number($('#bingo-duration').value);
    return {
      kind: 'bingo',
      label: `人物賓果・${durationMs ? `${durationMs / 60000} 分鐘` : '不限時'}`,
      msg: { type: EV.HOST_START_BINGO, durationMs },
    };
  },
};

/** 配方範本選單：跟著目前場景換（專屬的在前，通用的在後） */
function renderRecipes() {
  const sel = $('#rs-recipe');
  const list = recipesForTheme(currentTheme);
  sel.replaceChildren(...list.map((r) => Object.assign(document.createElement('option'), {
    value: r.id, textContent: r.name,
  })));
  renderRecipeBrief();
}
function renderRecipeBrief() {
  const r = recipesForTheme(currentTheme).find((x) => x.id === $('#rs-recipe').value);
  $('#rs-recipe-brief').textContent = r ? `${r.brief}（${r.steps.map((s) => RS_KIND[s.kind]).join(' → ')}）` : '';
}
$('#rs-recipe').addEventListener('change', renderRecipeBrief);
$('#btn-rs-recipe').addEventListener('click', () => {
  const r = recipesForTheme(currentTheme).find((x) => x.id === $('#rs-recipe').value);
  if (!r) return;
  const cur = loadRunSheet();
  if (cur.steps.length && !confirm(`會取代目前節目單上的 ${cur.steps.length} 項，確定嗎？`)) return;
  saveRunSheet({ steps: structuredClone(r.steps), pointer: 0 });
  pushFeed(`節目單套用範本：${r.name}`, 'ev-plan');
});
for (const btn of document.querySelectorAll('[data-rs-add]')) {
  btn.addEventListener('click', () => addStep(STEP_BUILDERS[btn.dataset.rsAdd]()));
}


/** 剛送出的那一項。伺服器拒絕時要把指標退回來，否則那一項就被跳過了 */
let rsPending = null;
let rsPendingTimer = null;

function runNextStep() {
  const rs = loadRunSheet();
  const step = rs.steps[rs.pointer];
  if (!step || !ws) return;
  lastAction = 'runsheet';
  rsPending = rs.pointer;
  clearTimeout(rsPendingTimer);
  // 拒絕會在一個來回內到；過了這段時間就當作成功
  rsPendingTimer = setTimeout(() => { rsPending = null; }, 1500);

  if (step.kind === 'photo') {
    $('#btn-photo').click();   // 合照結果出現在側欄的大螢幕底下，哪一頁都看得到
  } else if (step.run) {
    // 連續問答：跟按「開始問答」一樣，從題庫第 1 題開始，之後每題按「下一題」
    const items = loadBank();
    if (!items.length) { showError('題庫是空的，這一項跳過', '#quiz-err'); }
    else {
      quizRun = { items, index: 0 };
      saveRun();
      ws.send(JSON.stringify({ type: EV.HOST_START_QUIZ, ...packDraft(bankDraft(items[0])) }));
    }
    selectActivity('quiz');
  } else {
    ws.send(JSON.stringify(step.msg));
    if (LIVE_VIEW[step.kind]) selectActivity(step.kind);
  }
  saveRunSheet({ ...rs, pointer: rs.pointer + 1 });
}

function undoRunSheetStep() {
  if (rsPending === null) return;
  const rs = loadRunSheet();
  saveRunSheet({ ...rs, pointer: rsPending });
  rsPending = null;
}

$('#btn-rs-next').addEventListener('click', runNextStep);
$('#btn-rs-reset').addEventListener('click', () => saveRunSheet({ ...loadRunSheet(), pointer: 0 }));

function smallBtn(text, label, onClick) {
  const b = document.createElement('button');
  b.className = 'rs-mini';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function renderRunSheet() {
  const rs = loadRunSheet();
  const ol = $('#rs-list');
  ol.replaceChildren();
  $('#rs-count').textContent = rs.steps.length;
  $('#rs-empty').hidden = rs.steps.length > 0;
  $('#btn-rs-reset').hidden = rs.pointer === 0;

  rs.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = i < rs.pointer ? 'done' : i === rs.pointer ? 'next' : '';

    // 點文字＝下一項從這裡開始（跳過或重來某一項都靠它）
    const label = document.createElement('button');
    label.className = 'rs-label';
    label.title = '下一項從這裡開始';
    const kind = document.createElement('span');
    kind.className = 'rs-kind';
    kind.textContent = RS_KIND[step.kind] ?? step.kind;
    const text = document.createElement('span');
    text.className = 'rs-text';
    text.textContent = step.label;   // 可能含主辦者打的題目，一律 textContent
    label.append(kind, text);
    label.addEventListener('click', () => saveRunSheet({ ...loadRunSheet(), pointer: i }));

    const move = (d) => () => {
      const cur = loadRunSheet();
      const j = i + d;
      if (j < 0 || j >= cur.steps.length) return;
      [cur.steps[i], cur.steps[j]] = [cur.steps[j], cur.steps[i]];
      saveRunSheet(cur);
    };
    const del = () => {
      const cur = loadRunSheet();
      cur.steps.splice(i, 1);
      if (i < cur.pointer) cur.pointer--;
      saveRunSheet(cur);
    };

    li.append(
      label,
      smallBtn('↑', `把「${step.label}」往前移`, move(-1)),
      smallBtn('↓', `把「${step.label}」往後移`, move(1)),
      smallBtn('✕', `從節目單刪除「${step.label}」`, del),
    );
    ol.append(li);
  });

  const next = rs.steps[rs.pointer];
  const btn = $('#btn-rs-next');
  btn.hidden = rs.steps.length === 0;
  btn.disabled = !next;
  btn.textContent = next
    ? `下一項：${RS_KIND[next.kind]}　${next.label}`
    : '節目單已經跑完';
}

// ─────────────────────────────────────────────────────────────
// 活動報告
// ─────────────────────────────────────────────────────────────
for (const [id, format] of [['#btn-report-people', 'people'], ['#btn-report-activities', 'activities']]) {
  $(id).addEventListener('click', () => {
    lastAction = 'report';
    ws?.send(JSON.stringify({ type: EV.HOST_REQUEST_REPORT, format }));
  });
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false }) : '');

/** CSV 欄位跳脫。名字是參與者自填的，可能含逗號、引號或換行 */
function csvCell(v) {
  const s = String(v ?? '');
  // 以 = + - @ 開頭的內容在 Excel 裡會被當成公式執行（CSV injection），前面墊一個單引號
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function downloadCsv(name, rows) {
  // BOM：沒有它 Excel 會用系統編碼開檔，中文全變亂碼
  const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderReport(format, report) {
  if (!report) return;
  const s = report.summary;
  const sum = $('#report-summary');
  sum.textContent = `共 ${s.participants} 人參與（目前在場 ${s.present}）・社交連結 ${s.edges} 條・`
    + `${s.isolated} 人整場沒有配對過・任務 ${s.missions} 輪、問答 ${s.quizzes} 題、文字雲 ${s.wordclouds} 題`;
  sum.hidden = false;

  const d = new Date(report.generatedAt);
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  if (format === 'activities') {
    downloadCsv(`pixelair-活動紀錄-${stamp}.csv`, [
      ['類型', '內容', '開始', '結束', '參與人數', '結果'],
      ...report.activities.map((a) => [a.kind, a.title, fmtTime(a.startedAt), fmtTime(a.endedAt), a.participants, a.result]),
    ]);
  } else {
    downloadCsv(`pixelair-參與者-${stamp}.csv`, [
      ['名稱', '目前在場', '積分', '社交連結', '任務完成次數', '問答作答', '問答答對', '問卷標籤'],
      ...report.people.map((p) => [
        p.name || '（已離場）', p.present ? '是' : '否', p.score, p.connections,
        p.missionCompletions, p.quizAnswered, p.quizCorrect, p.tags.join('、'),
      ]),
    ]);
  }
}

// ─────────────────────────────────────────────────────────────
// 大螢幕預覽
// ─────────────────────────────────────────────────────────────
// 直接嵌入真的大螢幕頁面（?preview=1：不出聲、不被挑去截圖），而不是在主控台重畫一份 ——
// 重畫的版本遲早會跟投影幕不一樣，主持人看到的就不是觀眾看到的。
const spFrame = $('#sp-frame');
let spIframe = null;

function fitPreview() {
  if (!spIframe) return;
  const { width, height } = spFrame.getBoundingClientRect();
  const k = Math.min(width / 1920, height / 1080);
  // 容器不是剛好 16:9 時置中，不裁切畫面
  spIframe.style.transform = `translate(${(width - 1920 * k) / 2}px, ${(height - 1080 * k) / 2}px) scale(${k})`;
}
new ResizeObserver(fitPreview).observe(spFrame);

/** 進到控制台才開預覽：登入頁與活動設定頁不必先跑一份 3D */
function initPreview() {
  if (spIframe) return;
  spIframe = document.createElement('iframe');
  spIframe.src = '/screen/?preview=1';
  spIframe.title = '大螢幕即時畫面';
  spIframe.tabIndex = -1;
  spFrame.prepend(spIframe);
  fitPreview();
}

// 投影模式已移除（2026-10-17）：清掉舊版留下的開關，免得哪天又被讀到
try { localStorage.removeItem('pixelair.projector'); } catch { /* 略 */ }

// ─────────────────────────────────────────────────────────────
// 現在進行中（節目單頁）
// ─────────────────────────────────────────────────────────────
// 活動進行中主持人只看節目單這一頁就能操作：每個正在跑的玩法一列，附上它此刻該按的那一顆
// （提前公布／下一題、收題、結算、結束）。按鈕直接觸發「活動選單」裡同一顆按鈕，確認對話框、
// 錯誤處理、連續問答的進度都跟在那邊按一模一樣，不另寫一份。
// 狀態文字（倒數、作答人數）讀「活動選單」面板上已經算好的字，每半秒刷新一次。
function liveItems() {
  const items = [];
  const text = (sel) => $(sel)?.textContent ?? '';
  if (quiz) {
    const revealed = quiz.phase === QUIZ_PHASE.REVEALED || reveal !== null;
    const run = inRun();
    const last = run && quizRun.index === quizRun.items.length - 1;
    items.push({
      key: 'quiz', tag: '問答', title: quiz.question,
      status: `${run ? `第 ${quizRun.index + 1} / ${quizRun.items.length} 題　` : ''}${text('#quiz-countdown')}　作答 ${text('#quiz-answered')}`,
      actions: !revealed
        ? [{ label: '提前公布答案', target: '#btn-quiz-reveal', primary: true }]
        : run
          ? [{ label: last ? '結束問答' : `下一題（${quizRun.index + 2} / ${quizRun.items.length}）`, target: '#btn-quiz-next', primary: true }]
          : [{ label: '收題', target: '#btn-quiz-end' }],
    });
  }
  if (!$('#wordcloud-live').hidden) {
    items.push({ key: 'wordcloud', tag: '文字雲', title: text('#wordcloud-live-q'), status: text('#wordcloud-count'),
      actions: [{ label: '收題', target: '#btn-wordcloud-close' }] });
  }
  for (const m of missionStates.values()) {
    const sec = missionLeft(m);
    items.push({ key: `mission-${m.id}`, tag: '任務', title: m.title,
      status: `${m.finished} / ${m.totalAgents} 人完成${sec == null ? '' : `　${fmtLeft(sec)}`}`,
      actions: [{ label: '結算任務', onClick: () => closeMissionAsk(m.id) }] });
  }
  if (!$('#bingo-live').hidden) {
    items.push({ key: 'bingo', tag: '人物賓果', title: '賓果進行中', status: text('#bingo-left'),
      actions: [{ label: '結束賓果', target: '#btn-bingo-end' }] });
  }
  return items;
}

let lcSignature = '';
function renderLiveControl() {
  const items = liveItems();
  $('#lc-empty').hidden = items.length > 0;
  const list = $('#lc-list');
  // 玩法或按鈕變了才重建（重建會讓滑鼠下的按鈕閃一下、焦點跑掉），只有文字變就只改文字
  const sig = items.map((i) => `${i.key}:${i.actions.map((a) => a.label).join('|')}`).join(';');
  if (sig !== lcSignature) {
    lcSignature = sig;
    list.replaceChildren(...items.map((it) => {
      const li = document.createElement('li');
      li.dataset.key = it.key;
      const head = document.createElement('div');
      head.className = 'lc-head';
      head.append(
        Object.assign(document.createElement('span'), { className: 'lc-tag', textContent: it.tag }),
        Object.assign(document.createElement('b'), { className: 'lc-title' }),
      );
      const status = Object.assign(document.createElement('p'), { className: 'lc-status' });
      const acts = document.createElement('div');
      acts.className = 'lc-actions';
      for (const a of it.actions) {
        const b = document.createElement('button');
        b.className = a.primary ? 'btn-primary' : 'btn-ghost';
        b.textContent = a.label;
        b.addEventListener('click', () => (a.onClick ? a.onClick() : $(a.target).click()));
        acts.append(b);
      }
      li.append(head, status, acts);
      return li;
    }));
  }
  for (const it of items) {
    const li = list.querySelector(`li[data-key="${it.key}"]`);
    if (!li) continue;
    li.querySelector('.lc-title').textContent = it.title;   // 主持人自己輸入的題目，一律 textContent
    li.querySelector('.lc-status').textContent = it.status;
  }
}
setInterval(renderLiveControl, 500);

// ─────────────────────────────────────────────────────────────
// 配分（節目單頁）
// ─────────────────────────────────────────────────────────────
// 值只由 HOST_SCORING 決定（伺服器在 HOST_AUTH 時補送、修改後廣播）；不樂觀更新。
let scoringServer = null;

function buildScoringFields() {
  const wrap = $('#scoring-fields');
  wrap.replaceChildren(...SCORING_FIELDS.map(({ key, label }) => {
    const row = document.createElement('label');
    row.className = 'scoring-row';
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: '0', max: String(SCORING_MAX), step: '1', inputMode: 'numeric' });
    input.dataset.key = key;
    input.addEventListener('input', syncScoringDirty);
    row.append(Object.assign(document.createElement('span'), { textContent: label }), input,
      Object.assign(document.createElement('small'), { textContent: '分' }));
    return row;
  }));
}

function readScoringDraft() {
  return Object.fromEntries([...document.querySelectorAll('#scoring-fields input')].map((el) => [el.dataset.key, el.value.trim()]));
}

function syncScoringDirty() {
  if (!scoringServer) return;
  const draft = readScoringDraft();
  $('#btn-scoring-save').disabled = SCORING_FIELDS.every(({ key }) => String(scoringServer[key]) === draft[key]);
}

function receiveScoring(msg) {
  scoringServer = msg.scoring;
  scoring = { ...scoring, ...msg.scoring };
  $('#scoring-default').hidden = !msg.isDefault;
  for (const el of document.querySelectorAll('#scoring-fields input')) el.value = String(msg.scoring[el.dataset.key] ?? '');
  $('#scoring-err').hidden = true;
  syncScoringDirty();
}

$('#btn-scoring-save').addEventListener('click', () => {
  const draft = readScoringDraft();
  // 本地先擋空白與明顯打錯的值（伺服器會再驗一次）
  for (const { key, label } of SCORING_FIELDS) {
    const n = Number(draft[key]);
    if (draft[key] === '' || !Number.isInteger(n) || n < 0 || n > SCORING_MAX) {
      showError(`「${label}」要是 0～${SCORING_MAX} 的整數`, '#scoring-err');
      return;
    }
  }
  lastAction = 'scoring';
  const values = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)]));
  ws?.send(JSON.stringify({ type: EV.HOST_SET_SCORING, scoring: values }));
});
$('#btn-scoring-reset').addEventListener('click', () => {
  if (!confirm('配分恢復成預設值？')) return;
  lastAction = 'scoring';
  ws?.send(JSON.stringify({ type: EV.HOST_SET_SCORING, scoring: null }));
});
buildScoringFields();

renderRunSheet();
renderRecipes();
try {
  const savedTab = localStorage.getItem(TAB_KEY);
  if (savedTab && TABS.includes(savedTab)) selectTab(savedTab);
} catch { /* 略 */ }

// ─────────────────────────────────────────────────────────────
// 進場問卷・團隊分類
// ─────────────────────────────────────────────────────────────
// 分佈跟著 HOST_STATE；題目只由 HOST_PERSONA_QUIZ 驅動（認證時補送）。
// 編輯中的草稿與伺服器上的題目分開：別台主辦端存了新題目時，
// 這台正在改的內容不能被蓋掉。

function renderPersonaSpread(spread) {
  const list = $('#persona-spread');
  list.replaceChildren();
  const total = spread.counts.reduce((a, c) => a + c.count, 0);
  for (const { id, count } of spread.counts) {
    const t = PERSONA_RESULT_MAP[id];
    if (!t) continue;
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'ps-head';
    const name = document.createElement('b');
    name.textContent = `${t.emoji} ${t.name}`;
    const style = document.createElement('span');
    style.className = 'ps-style';
    style.textContent = t.style;
    const n = document.createElement('span');
    n.className = 'ps-count';
    n.textContent = `${count} 人`;
    head.append(name, style, n);
    const bar = document.createElement('div');
    bar.className = 'ps-track';
    const fill = document.createElement('i');
    fill.style.width = total ? `${(count / total) * 100}%` : '0%';
    bar.append(fill);
    const desc = document.createElement('p');
    desc.className = 'ps-desc';
    desc.textContent = `${t.strengths}；需留意：${t.cautions}`;
    li.append(head, bar, desc);
    list.append(li);
  }
  $('#persona-unanswered').textContent = spread.unanswered
    ? `另有 ${spread.unanswered} 人沒有作答（略過問卷，或在題目修改前進場）`
    : '';
}

let personaServer = null;   // 伺服器上的題目
let personaDraft = null;    // 編輯中的草稿
let personaDirty = false;
/**
 * 已送出、還沒等到伺服器回覆。
 *
 * 原本按下儲存就把 personaDirty 清掉、按鈕鎖住。伺服器拒絕（例如有選項沒填）時，
 * 草稿已經不受保護、按鈕也按不了 —— 主持人得隨便改一個字才能重送；這段期間
 * 任何一則 HOST_PERSONA_QUIZ（另一位主持人存檔、重連補送）都會用伺服器上的舊版
 * 把草稿蓋掉，而且沒有任何提示。現在等伺服器真的收下（廣播回 HOST_PERSONA_QUIZ）
 * 才算存好。
 */
let personaSaving = false;

function receivePersonaQuiz(view) {
  personaServer = view;
  $('#persona-default-badge').hidden = !view.isDefault;
  // 伺服器只在接受之後才廣播，所以送出中收到這則就是「存好了」
  if (personaSaving) {
    personaSaving = false;
    personaDirty = false;
  }
  if (!personaDirty) {
    personaDraft = structuredClone(view.quiz);
    renderPersonaEditor();
  }
}

function markPersonaDirty() {
  personaDirty = true;
  if (!personaSaving) $('#btn-persona-save').disabled = false;
}

/** 伺服器拒絕：草稿仍是未存的，讓主持人改完直接再按一次儲存 */
function personaSaveRejected() {
  if (!personaSaving) return;
  personaSaving = false;
  $('#btn-persona-save').disabled = !personaDirty;
}

const TYPE_LABEL = Object.fromEntries(Object.values(PERSONA_TYPES).map((t) => [t.key, `${t.emoji} ${t.name}`]));

function renderPersonaEditor() {
  const root = $('#persona-questions');
  root.replaceChildren();
  if (!personaDraft) return;
  const L = PERSONA_LIMITS;
  personaDraft.questions.forEach((q, qi) => {
    const box = document.createElement('fieldset');
    box.className = 'pq-edit';
    const legend = document.createElement('legend');
    legend.textContent = `第 ${qi + 1} 題`;
    const text = document.createElement('input');
    text.value = q.text;
    text.maxLength = L.maxQuestionLength;
    text.setAttribute('aria-label', `第 ${qi + 1} 題題目`);
    text.addEventListener('input', () => { q.text = text.value; markPersonaDirty(); });
    box.append(legend, text);

    q.options.forEach((o, oi) => {
      const row = document.createElement('div');
      row.className = 'pq-edit-opt';
      const label = document.createElement('input');
      label.value = o.label;
      label.maxLength = L.maxOptionLength;
      label.setAttribute('aria-label', `第 ${qi + 1} 題選項 ${oi + 1}`);
      label.addEventListener('input', () => { o.label = label.value; markPersonaDirty(); });
      const type = document.createElement('select');
      type.setAttribute('aria-label', `選項 ${oi + 1} 對應的類型`);
      for (const [key, text] of Object.entries(TYPE_LABEL)) {
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = text;
        type.append(opt);
      }
      type.value = o.type;
      type.addEventListener('change', () => { o.type = type.value; markPersonaDirty(); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-link';
      del.textContent = '刪除';
      del.disabled = q.options.length <= L.minOptions;
      del.addEventListener('click', () => { q.options.splice(oi, 1); markPersonaDirty(); renderPersonaEditor(); });
      row.append(label, type, del);
      box.append(row);
    });

    const foot = document.createElement('div');
    foot.className = 'pq-edit-foot';
    const addOpt = document.createElement('button');
    addOpt.type = 'button';
    addOpt.className = 'btn-link';
    addOpt.textContent = '＋ 選項';
    addOpt.disabled = q.options.length >= L.maxOptions;
    addOpt.addEventListener('click', () => {
      // 預設對應目前這題還沒用到的類型，省得主持人每次都要改
      const used = new Set(q.options.map((x) => x.type));
      const type = Object.keys(PERSONA_TYPES).find((k) => !used.has(k)) ?? 'D';
      q.options.push({ label: '', type });
      markPersonaDirty(); renderPersonaEditor();
    });
    const delQ = document.createElement('button');
    delQ.type = 'button';
    delQ.className = 'btn-link';
    delQ.textContent = '刪除這題';
    delQ.disabled = personaDraft.questions.length <= L.minQuestions;
    delQ.addEventListener('click', () => { personaDraft.questions.splice(qi, 1); markPersonaDirty(); renderPersonaEditor(); });
    foot.append(addOpt, delQ);
    box.append(foot);
    root.append(box);
  });
  $('#btn-persona-add-q').disabled = personaDraft.questions.length >= L.maxQuestions;
}

$('#btn-persona-add-q').addEventListener('click', () => {
  if (!personaDraft || personaDraft.questions.length >= PERSONA_LIMITS.maxQuestions) return;
  personaDraft.questions.push({
    text: '',
    options: Object.keys(PERSONA_TYPES).map((type) => ({ label: '', type })),
  });
  markPersonaDirty();
  renderPersonaEditor();
});

$('#btn-persona-save').addEventListener('click', () => {
  lastAction = 'persona';
  // 不先當作已存：等伺服器廣播回 HOST_PERSONA_QUIZ 才清掉 dirty（見 personaSaving）
  ws?.send(JSON.stringify({ type: EV.HOST_SET_PERSONA_QUIZ, quiz: personaDraft }));
  personaSaving = true;
  $('#btn-persona-save').disabled = true;
});

$('#btn-persona-reset').addEventListener('click', () => {
  if (!confirm('確定要恢復成預設題目嗎？目前的修改會消失。')) return;
  lastAction = 'persona';
  personaDirty = false;
  personaSaving = false;
  ws?.send(JSON.stringify({ type: EV.HOST_SET_PERSONA_QUIZ, quiz: null }));
});
