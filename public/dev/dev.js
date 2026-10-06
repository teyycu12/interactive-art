/**
 * 人物匯入台（開發工具）
 *
 * 要驗「場上有 10 個人時遊戲玩不玩得起來」，得真的有 10 個角色。但那意味著
 * 10 支手機、10 張照片、10 次約 25 秒的生成 —— 開發時湊不出來。這一頁把過去
 * 生成過的角色重新放回場上，並給每一個一組操控鈕。
 *
 * ── 為什麼不在伺服器上做假角色 ──
 * 每個傀儡都是一條真正的 WebSocket，走完整的 CLIENT_JOIN → INPUT_MOVE 流程，
 * 與手機端沒有任何差別。伺服器上不加任何「開發模式」分支 ——
 * 一旦加了，測到的就不是現場會跑的那條路，而「在測試環境好好的」正是
 * 這類旁路最常見的結局。代價是每個傀儡佔一條連線，而那恰好也是真實的成本。
 *
 * ── 為什麼需要「前往某個道具」 ──
 * 集合類任務（答某個選項的人到 3號桌集合）要驗的是十個人同時擠向一張桌子時
 * 擠不擠得下、名牌會不會疊成一團。用方向鍵一個一個推過去根本測不完，
 * 所以傀儡自己會依伺服器回報的座標往目標走。
 *
 * ⚠ 現場請勿使用：匯入的角色會佔用 MAX_AGENTS 名額，把真的要進場的人擋在外面
 *   （與 scripts/bots.mjs 同一個理由）。
 */

import { EV, EMOTE_GLYPH, ACTIONS } from '/shared/protocol.js';
import { PROPS } from '/shared/scene.js';
import { THEMES, THEME_MAP, DEFAULT_THEME } from '/shared/themes.js';
import { propLabel } from '../screen/scenes/registry.js';

const $ = (sel, root = document) => root.querySelector(sel);

/** 與主辦端共用同一把密鑰，也共用同一個 sessionStorage 鍵 —— 開完主辦端就不必再輸一次 */
const SS_KEY = 'personaflow.hostKey';

/** 傀儡的顯示名稱。開發用，取好認的短名，與 scripts/bots.mjs 同一個用意。 */
const NAMES = [
  '阿一', '阿二', '阿三', '阿四', '阿五', '阿六', '阿七', '阿八', '阿九', '阿十',
  '小白', '小黑', '小紅', '小藍', '小綠', '小黃', '小紫', '小橘', '小灰', '小青',
  '阿吉', '阿美', '阿勇', '阿花', '阿明', '阿芳', '阿豪', '阿娟', '阿宏', '阿雲',
];

/** 抵達判定餘裕：道具本身有 r，再加一點，否則傀儡會在目標旁邊來回抖動 */
const ARRIVE_SLACK = 40;
/** 轉向頻率。協定上限 20Hz，這裡遠低於上限，單純是夠用 */
const STEER_MS = 200;

const DIRS = [
  ['↖', -1, -1], ['↑', 0, -1], ['↗', 1, -1],
  ['←', -1, 0], null, ['→', 1, 0],
  ['↙', -1, 1], ['↓', 0, 1], ['↘', 1, 1],
];

let pool = [];              // 可匯入的歷史角色
const picked = new Set();   // 使用者勾選的 assetId
const puppets = [];         // 已進場的傀儡
let themeForLabels = DEFAULT_THEME;

// ── 密鑰與角色池 ─────────────────────────────────────────

async function loadPool(key) {
  const msg = $('#auth-msg');
  msg.textContent = '讀取中…';
  let body;
  try {
    const res = await fetch(`/api/host/avatars?key=${encodeURIComponent(key)}`);
    body = await res.json();
  } catch {
    msg.textContent = '連不上伺服器。';
    return;
  }
  if (!body?.ok) {
    msg.textContent = body?.error === 'invalid_key' ? '密鑰不對。' : '讀不到歷史角色。';
    return;
  }

  try { sessionStorage.setItem(SS_KEY, key); } catch { /* 略 */ }
  pool = body.avatars ?? [];
  msg.textContent = '';
  renderPool();
  $('#pool').hidden = false;
  $('#stageops').hidden = false;
}

function renderPool() {
  $('#pool-count').textContent = `共 ${pool.length} 個`;

  // 沒有色票的角色仍然可以上場，但顏色任務會判錯 —— 說清楚原因與解法，
  // 而不是安靜地補一組假顏色（見 server/devAvatars.js 的說明）
  const missing = pool.filter((a) => !a.colors).length;
  const warn = $('#pool-warn');
  warn.hidden = missing === 0;
  if (missing) {
    warn.textContent = `${missing} 個角色還沒有取樣色票。它們可以上場，`
      + '但顏色任務會依假色判定（畫面上是藍的，任務卻把它當成另一色）。'
      + '執行 python scripts/asset_colors.py 可以補齊。';
  }

  const grid = $('#pool-grid');
  grid.textContent = '';
  for (const a of pool) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pool-item';
    btn.setAttribute('aria-pressed', 'false');
    btn.title = a.assetId;

    const img = document.createElement('img');
    img.src = a.textures.full;
    img.alt = `歷史角色 ${a.assetId.slice(0, 6)}`;
    img.loading = 'lazy';
    btn.append(img);

    if (a.colors) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      for (const key of ['hair', 'skin', 'torso', 'legs']) {
        const i = document.createElement('i');
        i.style.background = a.colors[key];
        sw.append(i);
      }
      btn.append(sw);
    } else {
      const no = document.createElement('span');
      no.className = 'nocolor';
      no.textContent = '無色票';
      btn.append(no);
    }

    btn.addEventListener('click', () => {
      const on = !picked.has(a.assetId);
      if (on) picked.add(a.assetId); else picked.delete(a.assetId);
      btn.setAttribute('aria-pressed', String(on));
    });
    grid.append(btn);
  }
}

// ── 目標下拉 ─────────────────────────────────────────────

/**
 * 道具的顯示名稱。
 *
 * 名稱唯一來源是場景的 ITEMS（經 registry.propLabel）與主題的 spots ——
 * 在這裡自己抄一份桌子名字，換主題或改名時就會與大螢幕、主辦端不一致，
 * 而症狀是三個畫面各自說一個地點名，兩邊都不報錯。
 */
function targetLabel(themeId, prop) {
  const spot = THEME_MAP[themeId]?.spots?.[prop.id];
  const name = propLabel(themeId, prop.id);
  if (spot && name && name !== prop.id) return `${spot}・${name}`;
  return spot ?? name ?? prop.id;
}

function buildTargetOptions(select, themeId) {
  const prev = select.value;
  select.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（不指定）';
  select.append(none);

  // 有編號的地點排前面：任務指定的集合點都是那幾個
  const spots = THEME_MAP[themeId]?.spots ?? {};
  const ordered = [...PROPS].sort((a, b) => (spots[b.id] ? 1 : 0) - (spots[a.id] ? 1 : 0));
  for (const p of ordered) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = targetLabel(themeId, p);
    select.append(o);
  }
  if (prev) select.value = prev;
}

// ── 傀儡 ─────────────────────────────────────────────────

function sendTo(p, type, payload = {}) {
  if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ type, ...payload }));
}

/** 設定移動方向。applyMove 的語意是「持續到下一次輸入」，因此按一下就會一直走。 */
function setDir(p, dx, dy) {
  const stop = dx === 0 && dy === 0;
  p.dir = stop ? null : [dx, dy];
  const mag = Math.hypot(dx, dy) || 1;
  sendTo(p, EV.INPUT_MOVE, {
    vector: { x: dx / mag, y: dy / mag },
    intensity: stop ? 0 : 1,
  });
  refreshPad(p);
}

/**
 * 沒有取樣色票時的替代色。
 *
 * 依 assetId 推出一組固定顏色，而不是隨機或全灰：隨機的話每次重新匯入
 * 同一個角色都會換色族，顏色任務的結果就無法重現。這組色是假的，
 * 角色池上已明確警告。
 */
function neutralColors(assetId) {
  let h = 0;
  for (let i = 0; i < assetId.length; i++) h = (h * 31 + assetId.charCodeAt(i)) >>> 0;
  const hex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  return {
    skin: '#D8B49A', hair: '#3A2E27',
    torso: hex(h * 2654435761), legs: hex(h * 40503),
  };
}

function spawn(avatar, name) {
  const p = {
    avatar, name,
    id: null, pos: null, dir: null, target: null,
    ask: null, answered: null, note: '連線中…',
    ws: null, el: null, refs: null, gone: false,
  };
  puppets.push(p);
  p.el = buildCard(p);
  $('#puppets').append(p.el);
  renderStatus(p);
  renderAsk(p);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  p.ws = ws;

  ws.addEventListener('open', () => {
    // 不帶 userId／rejoinToken：每次匯入都當成新角色進場。開發時想要的是
    // 「十個互不相干的人」，接回舊角色反而會讓場上只剩一個人。
    sendTo(p, EV.CLIENT_JOIN, {
      userId: null,
      rejoinToken: null,
      name,
      avatar: {
        source: 'CV',
        textures: avatar.textures,
        fallbackColors: avatar.colors ?? neutralColors(avatar.assetId),
      },
    });
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(p, msg);
  });

  ws.addEventListener('close', () => {
    p.gone = true;
    p.note = '已離線';
    p.el.classList.add('gone');
    renderStatus(p);
    updateLiveCount();
  });

  return p;
}

function handle(p, msg) {
  switch (msg.type) {
    case EV.CLIENT_WELCOME:
      p.id = msg.userId;
      p.note = '';
      break;
    case EV.CLIENT_REJECT:
      // 外觀驗證失敗最可能的原因是貼圖缺件或色票格式不對，印出原因才找得到是哪一組
      p.note = `被拒：${msg.reason ?? '未知原因'}`;
      break;
    case EV.CLIENT_SYNC:
      if (msg.self) p.pos = { x: msg.self.x, y: msg.self.y };
      break;
    case EV.SURVEY_QUESTION:
      p.ask = normalizeAsk(msg.survey, 'SURVEY');
      p.answered = null;
      renderAsk(p);
      break;
    case EV.QUIZ_QUESTION:
      p.ask = normalizeAsk(msg.quiz, 'QUIZ');
      p.answered = null;
      renderAsk(p);
      break;
    case EV.SURVEY_ACK:
      p.note = `已記錄：${msg.label ?? ''}`;
      break;
    case EV.QUIZ_ACK:
      p.note = '已送出';
      break;
    case EV.SURVEY_CLOSED:
    case EV.QUIZ_ENDED:
      p.ask = null;
      p.answered = null;
      renderAsk(p);
      break;
    default:
      return;   // 其餘事件開發台不需要，安靜忽略
  }
  renderStatus(p);
}

/** 問答的 options 是字串、問卷的是物件。攤成字串再渲染，否則會畫出 [object Object]。 */
function normalizeAsk(q, kind) {
  if (!q) return null;
  return {
    kind,
    index: q.index,
    question: q.question,
    options: (q.options ?? []).map((o) => (typeof o === 'string' ? o : o.label)),
  };
}

// ── 卡片 ─────────────────────────────────────────────────

function buildCard(p) {
  const el = document.createElement('article');
  el.className = 'puppet';

  const head = document.createElement('div');
  head.className = 'puppet-head';
  const img = document.createElement('img');
  img.src = p.avatar.textures.full;
  img.alt = '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const h3 = document.createElement('h3');
  h3.textContent = p.name;
  const idEl = document.createElement('div');
  idEl.className = 'id';
  const posEl = document.createElement('div');
  posEl.className = 'pos';
  meta.append(h3, idEl, posEl);
  head.append(img, meta);

  const pad = document.createElement('div');
  pad.className = 'pad';
  for (const d of DIRS) {
    const b = document.createElement('button');
    b.type = 'button';
    if (d === null) {
      b.textContent = '站住';
      b.className = 'stop';
      b.addEventListener('click', () => { clearTarget(p); setDir(p, 0, 0); });
    } else {
      b.textContent = d[0];
      b.setAttribute('aria-pressed', 'false');
      b.dataset.dx = String(d[1]);
      b.dataset.dy = String(d[2]);
      b.addEventListener('click', () => { clearTarget(p); setDir(p, d[1], d[2]); });
    }
    pad.append(b);
  }

  const emotes = document.createElement('div');
  emotes.className = 'emotes';
  for (const action of ACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = EMOTE_GLYPH[action] ?? action;
    b.title = action;
    b.addEventListener('click', () => sendTo(p, EV.INPUT_ACTION, { action }));
    emotes.append(b);
  }

  const goto = document.createElement('label');
  goto.className = 'field goto';
  const gotoLabel = document.createElement('span');
  gotoLabel.textContent = '前往';
  const sel = document.createElement('select');
  buildTargetOptions(sel, themeForLabels);
  sel.addEventListener('change', () => {
    p.target = sel.value || null;
    if (!p.target) setDir(p, 0, 0);
  });
  goto.append(gotoLabel, sel);

  const ask = document.createElement('div');
  ask.className = 'ask';
  ask.hidden = true;

  const note = document.createElement('p');
  note.className = 'note';

  const foot = document.createElement('div');
  foot.className = 'puppet-foot';
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.className = 'danger';
  leave.textContent = '離場';
  leave.addEventListener('click', () => leavePuppet(p));
  foot.append(leave);

  el.append(head, pad, emotes, goto, ask, note, foot);
  p.refs = { idEl, posEl, pad, ask, note, sel };
  return el;
}

function clearTarget(p) {
  p.target = null;
  if (p.refs) p.refs.sel.value = '';
}

function refreshPad(p) {
  if (!p.refs) return;
  for (const b of p.refs.pad.querySelectorAll('button[aria-pressed]')) {
    const on = !!p.dir && Number(b.dataset.dx) === p.dir[0] && Number(b.dataset.dy) === p.dir[1];
    b.setAttribute('aria-pressed', String(on));
  }
}

/**
 * 座標與狀態列。CLIENT_SYNC 是 15Hz，因此這裡只改文字，不碰 DOM 結構。
 *
 * 題目面板刻意不在這裡重畫：那會讓選項按鈕每 66ms 被換掉一次，
 * 按下去的瞬間按鈕可能已經是新的那一顆，點擊因此落空 ——
 * 而畫面上看起來完全正常，只是「怎麼按都沒反應」。
 */
function renderStatus(p) {
  const { idEl, posEl, note } = p.refs;
  idEl.textContent = p.id ?? '（尚未取得 id）';
  posEl.textContent = p.pos
    ? `x ${Math.round(p.pos.x)}　y ${Math.round(p.pos.y)}${p.target ? `　→ ${p.target}` : ''}`
    : '—';
  note.textContent = p.note;
}

/** 題目面板。只在題目本身或自己的選擇變動時呼叫。 */
function renderAsk(p) {
  const { ask } = p.refs;
  if (!p.ask) {
    ask.hidden = true;
    ask.textContent = '';
    return;
  }
  ask.hidden = false;
  ask.textContent = '';
  const q = document.createElement('div');
  q.className = 'q';
  q.textContent = `${p.ask.kind === 'SURVEY' ? '問卷' : '問答'} ${p.ask.index}：${p.ask.question}`;
  const opts = document.createElement('div');
  opts.className = 'opts';
  p.ask.options.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(p.answered === i));
    // 問答答過就鎖住（伺服器也會拒），問卷可以改 —— 與手機端同一套規則
    b.disabled = p.ask.kind === 'QUIZ' && p.answered !== null;
    b.addEventListener('click', () => {
      p.answered = i;
      sendTo(p, p.ask.kind === 'SURVEY' ? EV.SURVEY_ANSWER : EV.QUIZ_ANSWER, { choice: i });
      renderAsk(p);
    });
    opts.append(b);
  });
  ask.append(q, opts);
}

function leavePuppet(p) {
  // 主動送 CLIENT_LEAVE 才會讓角色立即離場並忘掉標籤；
  // 只 close 的話會留一個 45 秒內還能被接回的幽靈角色，佔著名額。
  sendTo(p, EV.CLIENT_LEAVE, {});
  clearTarget(p);
  try { p.ws?.close(); } catch { /* 略 */ }
}

function updateLiveCount() {
  const live = puppets.filter((p) => !p.gone).length;
  $('#live-count').textContent = `場上 ${live} 個`;
}

// ── 轉向迴圈 ─────────────────────────────────────────────

setInterval(() => {
  for (const p of puppets) {
    if (p.gone || !p.target || !p.pos) continue;
    const prop = PROPS.find((x) => x.id === p.target);
    if (!prop) continue;
    const dx = prop.x - p.pos.x;
    const dy = prop.y - p.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= (prop.r ?? 0) + ARRIVE_SLACK) {
      clearTarget(p);
      p.note = '已抵達';
      setDir(p, 0, 0);
      renderStatus(p);
      continue;
    }
    p.dir = null;          // 自動轉向時方向鍵不該亮著
    sendTo(p, EV.INPUT_MOVE, { vector: { x: dx / dist, y: dy / dist }, intensity: 1 });
    refreshPad(p);
    renderStatus(p);
  }
}, STEER_MS);

// ── 全體操作 ─────────────────────────────────────────────

$('#btn-auth').addEventListener('click', () => {
  const key = $('#key-input').value.trim().toUpperCase();
  if (!key) { $('#key-input').focus(); return; }
  loadPool(key);
});
$('#key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-auth').click();
});

function doSpawn(list) {
  const msg = $('#spawn-msg');
  if (!list.length) { msg.textContent = '沒有可匯入的角色。'; return; }
  const taken = puppets.filter((p) => !p.gone).length;
  list.forEach((a, i) => spawn(a, NAMES[(taken + i) % NAMES.length]));
  msg.textContent = `已匯入 ${list.length} 個。若有角色顯示「被拒」且訊息是場上已滿，`
    + '代表超過 MAX_AGENTS（server/config.js，目前 30）。';
  updateLiveCount();
}

$('#btn-spawn').addEventListener('click', () => {
  const n = Math.max(1, Math.min(30, Number($('#spawn-count').value) || 1));
  doSpawn(pool.slice(0, n));
});

$('#btn-spawn-picked').addEventListener('click', () => {
  doSpawn(pool.filter((a) => picked.has(a.assetId)));
});

$('#btn-all-stop').addEventListener('click', () => {
  for (const p of puppets) {
    if (p.gone) continue;
    clearTarget(p);
    setDir(p, 0, 0);
    renderStatus(p);
  }
});

$('#btn-all-scatter').addEventListener('click', () => {
  for (const p of puppets) {
    if (p.gone) continue;
    clearTarget(p);
    const a = Math.random() * Math.PI * 2;
    setDir(p, Math.cos(a), Math.sin(a));
  }
});

$('#btn-all-leave').addEventListener('click', () => {
  for (const p of puppets) if (!p.gone) leavePuppet(p);
});

$('#all-target').addEventListener('change', (e) => {
  const id = e.target.value;
  for (const p of puppets) {
    if (p.gone) continue;
    p.target = id || null;
    p.refs.sel.value = id;
    if (!p.target) setDir(p, 0, 0);
  }
});

// 地點名稱依主題而不同（同一張桌子在廚房與辦公室叫法不一樣），
// 但傀儡是控制器角色，收不到 STAGE_THEME，因此由這裡自己選。
const themeSel = document.createElement('select');
for (const t of THEMES) {
  const o = document.createElement('option');
  o.value = t.id;
  o.textContent = t.name ?? t.id;
  themeSel.append(o);
}
themeSel.value = DEFAULT_THEME;
themeSel.addEventListener('change', () => {
  themeForLabels = themeSel.value;
  buildTargetOptions($('#all-target'), themeForLabels);
  for (const p of puppets) buildTargetOptions(p.refs.sel, themeForLabels);
});
const themeField = document.createElement('label');
themeField.className = 'field inline';
const themeLabel = document.createElement('span');
themeLabel.textContent = '地點名稱依主題';
themeField.append(themeLabel, themeSel);
$('#stageops .row').prepend(themeField);

buildTargetOptions($('#all-target'), themeForLabels);
updateLiveCount();

// 開完主辦端再開這一頁時，密鑰已經在 sessionStorage 裡
try {
  const saved = sessionStorage.getItem(SS_KEY);
  if (saved) { $('#key-input').value = saved; loadPool(saved); }
} catch { /* 略 */ }
