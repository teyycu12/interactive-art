/**
 * 主辦端控制台（規格 v3.0 §05）
 *
 * 系統的第三個角色。與大螢幕、手機端不同，這裡握有踢人與結算全場的能力，
 * 因此需要通行密鑰認證 —— 現場所有人連在同一個區網，
 * 光靠「網址沒人知道」保護不了任何東西。
 */

import {
  EV, MISSION_TYPES, QUIZ, QUIZ_CHOICES, QUIZ_PHASE,
  GROUPING_QUESTIONS,
} from '/shared/protocol.js';
import { renderAvatarSVG, CV_FULL_PART } from '/shared/avatars.js';
import { COLOR_FAMILIES } from '/shared/colorFamily.js';
import { HEAT_LEVELS } from '/shared/heat.js';

const $ = (s) => document.querySelector(s);
const SS_KEY = 'personaflow.hostKey';

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
      if (msg.scoring) { scoring = msg.scoring; renderScoringRule(); }
      buildMissionTypes();
      buildGroupingSelect();
      $('#auth').hidden = true;
      $('#console').hidden = false;
      setConn('已連線', false);
      loadHistory();
      startHistoryPolling();
      break;

    case EV.HOST_REJECT:
      // 認證前的拒絕代表密鑰錯誤；認證後的拒絕來自任務或問答的發布失敗
      if (!authed) { showAuthError(msg.reason ?? '通行密鑰錯誤'); ws.close(); }
      else showError(msg.reason ?? '操作失敗');
      break;

    case EV.HOST_STATE:
      renderState(msg);
      break;

    case EV.MISSION_ANNOUNCE:
      pushFeed(`發布任務「${msg.mission.title}」`, 'ev-mission');
      break;

    case EV.MISSION_STATE:
      renderMission(msg.mission);
      break;

    case EV.MISSION_COMPLETE:
      pushFeed(`${msg.a.name} × ${msg.b.name} 完成配對`, 'ev-pair');
      break;

    case EV.TREASURE_START:
      renderTreasure(msg.round);
      pushFeed(`尋寶開始，先知＝${nameOfAgent(msg.round.prophetId)}`, 'ev-mission');
      break;

    case EV.TREASURE_HEAT:
      $('#treasure-heat').textContent = heatLabel(msg.heat);
      break;

    case EV.TREASURE_FOUND:
      pushFeed(`${msg.byName} 找到寶藏（先知 ${msg.prophetName}）`, 'ev-pair');
      renderTreasure(null);
      break;

    case EV.TREASURE_ENDED:
      pushFeed('尋寶中止', 'ev-mission');
      renderTreasure(null);
      break;

    case EV.MISSION_CLOSED:
      pushFeed(`結算「${msg.title}」，共 ${msg.totalCompletions} 次完成`, 'ev-mission');
      renderMission(null);
      break;

    case EV.QUIZ_QUESTION:
      quiz = msg.quiz;
      reveal = null;
      pushFeed(`第 ${quiz.index} 題「${quiz.question}」開始作答`, 'ev-quiz');
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
  }
}

// ── 大合照 ───────────────────────────────────────────────────
const PHOTO_PHASES = {
  STAGING: (m) => `正在把 ${m.count ?? 0} 位角色帶到定位…`,
  COMPOSING: () => '角色已就位，合成中…',
};

function renderPhotoState(msg) {
  const btn = $('#btn-photo');
  const status = $('#photo-status');
  const err = $('#photo-err');
  const result = $('#photo-result');

  if (msg.phase === 'DONE') {
    btn.disabled = false;
    status.hidden = true;
    err.hidden = true;
    $('#photo-img').src = msg.photoB64 || '';
    $('#photo-qr').src = msg.qrB64 || '';
    const dl = $('#photo-download');
    dl.href = msg.photoB64 || '#';
    dl.download = `${msg.photoId || 'personaflow'}.png`;
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

$('#btn-photo').addEventListener('click', () => {
  $('#btn-photo').disabled = true;
  ws?.send(JSON.stringify({ type: EV.HOST_TAKE_PHOTO }));
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
  quiz: '#quiz-err',
  treasure: '#treasure-err',
  mission: '#mission-err',
  grouping: '#grouping-err',
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

// ── 分組 ──────────────────────────────────────────────────
function buildGroupingSelect() {
  const sel = $('#grouping-select');
  if (!sel) return;
  sel.replaceChildren();
  for (const q of GROUPING_QUESTIONS) {
    const opt = document.createElement('option');
    opt.value = q.id;
    opt.textContent = `${q.text}（${q.options.join(' / ')}）`;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    // 標記來源，讓伺服器的拒絕訊息落在分組面板自己的欄位上，
    // 而不是預設的任務面板（沿用既有的 lastAction / ERR_SLOT 機制）
    lastAction = 'grouping';
    send(EV.HOST_SET_GROUPING, { questionId: sel.value });
  });
}

/** 兩隊比分。人數一併顯示，讓主辦端看得出分差是不是人數造成的 */
function renderTeams(teams = [], groupingId = null) {
  // 選單一律跟隨伺服器的值：換題被拒時（已有人入場）選單會停在被拒的那一項，
  // 看起來像換成功了，下一則 HOST_STATE 會把它撥回真正生效的題目。
  const sel = $('#grouping-select');
  if (sel && groupingId && sel.value !== groupingId) sel.value = groupingId;

  const box = $('#team-score');
  if (!box) return;
  if (teams.length === 0) { box.replaceChildren(); return; }

  const top = Math.max(1, ...teams.map((t) => t.score));
  box.replaceChildren();
  for (const t of teams) {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.style.setProperty('--team-color', t.color);
    row.style.setProperty('--team-ink', t.ink);

    const name = document.createElement('b');
    name.textContent = t.label;
    const meter = document.createElement('div');
    meter.className = 'team-meter';
    const fill = document.createElement('i');
    fill.style.width = `${(t.score / top) * 100}%`;
    meter.append(fill);
    const val = document.createElement('span');
    val.className = 'team-val';
    val.textContent = `${t.score} 分・${t.members} 人`;

    row.append(name, meter, val);
    box.append(row);
  }
}

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
  // 只有需要顏色參數的型別才顯示選單，避免主辦端誤以為每種任務都要選色
  $('#mission-color-field').hidden = t?.param !== 'colorFamily';
}
$('#mission-type').addEventListener('change', syncBrief);

$('#btn-publish').addEventListener('click', () => {
  lastAction = 'mission';
  const t = missionTypes.find((m) => m.id === $('#mission-type').value);
  ws?.send(JSON.stringify({
    type: EV.HOST_PUBLISH_MISSION,
    missionType: $('#mission-type').value,
    target: Number($('#mission-target').value),
    // 不需要顏色的型別送 null，伺服器會忽略
    colorFamily: t?.param === 'colorFamily' ? pickedColor : null,
  }));
});

$('#btn-close').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: EV.HOST_CLOSE_MISSION }));
});

function renderMission(m) {
  const idle = $('#mission-idle');
  const live = $('#mission-live');
  if (!m) { idle.hidden = false; live.hidden = true; return; }

  idle.hidden = true;
  live.hidden = false;
  $('#live-title').textContent = m.title;
  $('#live-target').textContent = `每人 ${m.target} 次`;

  const pct = m.totalAgents > 0 ? Math.round((m.finished / m.totalAgents) * 100) : 0;
  $('#live-bar').style.width = `${pct}%`;
  $('#live-frac').textContent = `${m.finished} / ${m.totalAgents}`;
  $('#live-detail').textContent =
    `${m.participating} 人已開始，累計完成 ${m.totalCompletions} 次`;
}

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

// ── 尋寶 ──────────────────────────────────────────────────
/** 場上名冊快取，供先知下拉選單與事件文案使用 */
let roster = [];
const nameOfAgent = (id) => roster.find((a) => a.id === id)?.name ?? id;
const heatLabel = (id) => {
  const h = HEAT_LEVELS.find((x) => x.id === id);
  return h ? `${h.glyph} ${h.label}` : '—';
};

function renderTreasure(round) {
  $('#treasure-idle').hidden = !!round;
  $('#treasure-live').hidden = !round;
  if (round) {
    $('#treasure-prophet-name').textContent = nameOfAgent(round.prophetId);
    $('#treasure-heat').textContent = '—';
  }
}

function syncProphetOptions() {
  const sel = $('#treasure-prophet');
  const keep = sel.value;
  sel.replaceChildren();
  const any = document.createElement('option');
  any.value = '';
  any.textContent = '隨機指定';
  sel.append(any);
  for (const a of roster) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    sel.append(o);
  }
  // 保留主辦端已經選好的人，重新渲染名冊不該把選擇清掉
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

$('#btn-treasure-start').addEventListener('click', () => {
  lastAction = 'treasure';
  ws?.send(JSON.stringify({
    type: EV.HOST_START_TREASURE,
    prophetId: $('#treasure-prophet').value || null,
  }));
});

$('#btn-treasure-stop').addEventListener('click', () => {
  ws?.send(JSON.stringify({ type: EV.HOST_STOP_TREASURE }));
});

function renderState(state) {
  roster = state.agents ?? [];
  syncProphetOptions();
  renderTeams(state.teams ?? [], state.groupingId ?? null);
  // 有人入場後就鎖住選題 —— 伺服器也會擋，但先在 UI 上講清楚，
  // 免得主辦端選了才被退回
  const gsel = $('#grouping-select');
  if (gsel) gsel.disabled = (state.agents?.length ?? 0) > 0;
  $('#stat-people').textContent = state.agents.length;
  $('#stat-edges').textContent = state.graphEdges;
  $('#people-count').textContent = state.agents.length;
  $('#people-empty').hidden = state.agents.length > 0;

  const body = $('#people-body');
  body.replaceChildren();

  const target = state.mission?.target ?? 0;

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
    if (target > 0) {
      prog.textContent = `${a.progress} / ${target}`;
      if (a.progress >= target) prog.classList.add('done');
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

    tr.append(face, name, score, prog, conn, active, act);
    body.append(tr);
  }

  renderMission(state.mission);

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
  historyPollTimer = setInterval(loadHistory, HISTORY_POLL_MS);
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

    tr.append(before, after, time, status, model, tokens, cost, duration);
    body.append(tr);
  }
}

$('#btn-history-refresh').addEventListener('click', loadHistory);

const historyToggle = $('#btn-history-toggle');
const historyWrap = $('#history-wrap');
historyToggle.addEventListener('click', () => {
  const nowCollapsed = historyWrap.classList.toggle('is-collapsed');
  historyToggle.textContent = nowCollapsed ? '展開列表' : '收合列表';
  historyToggle.setAttribute('aria-expanded', String(!nowCollapsed));
});

// ─────────────────────────────────────────────────────────────
// 現場動態
// ─────────────────────────────────────────────────────────────
function pushFeed(text, cls) {
  const ul = $('#feed');
  const empty = ul.querySelector('.ev-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  const t = document.createElement('time');
  t.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  li.append(t, span);
  ul.prepend(li);

  while (ul.children.length > 60) ul.lastElementChild.remove();
}

pushFeed('等待現場活動…', 'ev-empty');

// ─────────────────────────────────────────────────────────────
// 即時問答
// ─────────────────────────────────────────────────────────────
const BANK_KEY = 'personaflow.quizBank';

/** @type {object|null} 目前的題目（伺服器視圖，不含正解） */
let quiz = null;
/** @type {object|null} 揭曉結果 */
let reveal = null;
let countdownTimer = null;
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
  };
}

function writeDraft(d) {
  $('#q-text').value = d.question ?? '';
  document.querySelectorAll('#q-options input[type="text"]').forEach((el, i) => {
    el.value = d.options?.[i] ?? '';
  });
  const radio = document.querySelector('#q-options input[type="radio"][value="' + (d.correctIndex ?? 0) + '"]');
  if (radio) radio.checked = true;
  if (d.durationMs) $('#q-duration').value = String(d.durationMs);
  markCorrectRow();
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
  return { question: d.question, options: kept, correctIndex, durationMs: d.durationMs };
}

$('#btn-quiz-start').addEventListener('click', () => {
  const draft = readDraft();
  const err = validateDraft(draft);
  if (err) { showError(err, '#quiz-err'); return; }
  lastAction = 'quiz';
  ws?.send(JSON.stringify({ type: EV.HOST_START_QUIZ, ...packDraft(draft) }));
});

$('#btn-quiz-save').addEventListener('click', () => {
  const draft = readDraft();
  const err = validateDraft(draft);
  if (err) { showError(err, '#quiz-err'); return; }
  saveBank([...loadBank(), draft]);
});

$('#btn-bank-clear').addEventListener('click', () => {
  if (!loadBank().length) return;
  if (!confirm('確定要清空題庫嗎？此動作無法復原。')) return;
  saveBank([]);
});

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

  items.forEach((item, i) => {
    const li = document.createElement('li');

    const q = document.createElement('span');
    q.className = 'q';
    q.textContent = item.question;  // 主辦者自己打的字，仍一律走 textContent

    const use = document.createElement('button');
    use.textContent = '載入';
    use.addEventListener('click', () => writeDraft(item));

    const del = document.createElement('button');
    del.className = 'btn-kick';
    del.textContent = '刪除';
    del.addEventListener('click', () => {
      const next = loadBank();
      next.splice(i, 1);
      saveBank(next);
    });

    li.append(q, use, del);
    ul.append(li);
  });
}

function renderScoringRule() {
  if (!scoring) return;
  $('#quiz-rule').textContent =
    `答對 ${scoring.quizCorrect} 分，愈快答對速度分愈高（最多再 +${scoring.quizSpeedBonus}）；`
    + `配對成功每次 ${scoring.pairCompletion} 分，任務達標再 +${scoring.missionFinish}。`;
}

function renderQuizTally() {
  if (!quiz) return;
  const total = Number($('#stat-people').textContent) || 0;
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
  $('#stat-questions').textContent = quiz.index;
  $('#quiz-live-q').textContent = quiz.question;
  renderQuizTally();

  const revealed = quiz.phase === QUIZ_PHASE.REVEALED || reveal !== null;
  $('#btn-quiz-reveal').hidden = revealed;
  $('#btn-quiz-end').hidden = !revealed;

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
    el.textContent = `${(left / 1000).toFixed(1)} 秒`;
    el.classList.toggle('urgent', left < 5000);
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
