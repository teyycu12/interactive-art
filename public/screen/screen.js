/**
 * 模組 M3 — 大螢幕公共畫布
 *
 * 渲染分兩層：
 *   靜態場景　由 scene.js 離屏渲染一次，每幀貼圖（見該檔的說明）
 *   角色　　　由 character.js 逐幀以變換矩陣算出步態
 *
 * 除錯視圖（按 D）保留自 M2 開發期，用於檢查 α 權重、避障半徑與速度向量。
 */

import { EV, STAGE, MAX_SPEED, QUIZ_CHOICES } from '/shared/protocol.js';
import { renderAvatarSVG, CV_CUTS, CV_PARTS } from '/shared/avatars.js';
import { OBSTACLES, PROPS } from '/shared/scene.js';
import { RoomScene, populateProps } from './3d/RoomScene.js';
import { drawCharacter, drawNameplate, drawEmote, drawOffline } from './character.js';

let roomScene = null;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const metaEl = document.getElementById('meta');
const listEl = document.getElementById('list');

const COLOR_ACTIVE = '#E76F51';
const COLOR_SWARM = '#457B9D';
const CHARACTER_HEIGHT = 150;   // 邏輯座標下的角色高度

let debug = false;
addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    debug = !debug;
    document.getElementById('hud').hidden = !debug;
  }
});

// ─────────────────────────────────────────────────────────────
// 畫布縮放與場景圖層
// ─────────────────────────────────────────────────────────────
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let dpr = 1;

function resize() {
  dpr = devicePixelRatio || 1;
  canvas.width = Math.ceil(innerWidth * dpr);
  canvas.height = Math.ceil(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;

  scale = Math.min(innerWidth / STAGE.width, innerHeight / STAGE.height);
  offsetX = (innerWidth - STAGE.width * scale) / 2;
  offsetY = (innerHeight - STAGE.height * scale) / 2;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';
}
addEventListener('resize', resize);
resize();

// 初始化 3D 背景
roomScene = new RoomScene(document.getElementById('bg3d'));
populateProps(roomScene, PROPS);

// ─────────────────────────────────────────────────────────────
// 連線狀態
// ─────────────────────────────────────────────────────────────
/** 名冊：id → { name, avatar, img } */
const roster = new Map();
/** 內插後的顯示座標：伺服器 30Hz，畫面 60Hz，直接套用會有階梯感 */
const view = new Map();
/** 剛完成配對的角色，用於畫面上的短暫強調 */
const pulse = new Map();
const PULSE_MS = 2600;

let latest = [];
let syncCount = 0;
let lastSyncAt = 0;
let syncHz = 0;

const AVATAR_W = 200;
const AVATAR_H = 260;

/**
 * 掃描生成的角色：把三張貼圖依 CV_CUTS 的比例疊回一張畫布。
 *
 * 回傳 canvas 而非 Image —— drawCharacter 只要求 sprite 有 complete 與
 * naturalWidth（character.js:82），canvas 兩者都能自行掛上，
 * 這樣就不必為了取得 Image 物件多繞一次 toDataURL 編解碼。
 *
 * 貼圖尚未載入時先用取樣色畫一個替身：現場的參與者在生成完成的瞬間
 * 就會看著大螢幕找自己，不能讓角色有一段時間是空白的。
 */
function cvAvatarImage(avatar) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_W;
  canvas.height = AVATAR_H;
  const ctx = canvas.getContext('2d');

  const paintPlaceholder = () => {
    const c = avatar.fallbackColors;
    for (const part of CV_PARTS) {
      const [top, bottom] = CV_CUTS[part];
      ctx.fillStyle = part === 'head' ? c.skin : (part === 'torso' ? c.torso : c.legs);
      ctx.fillRect(AVATAR_W * 0.25, AVATAR_H * top, AVATAR_W * 0.5, AVATAR_H * (bottom - top));
    }
    // 頭部上緣的髮色帶，比例與 slicer 取樣 hair 的區域一致
    const [, headBottom] = CV_CUTS.head;
    ctx.fillStyle = c.hair;
    ctx.fillRect(AVATAR_W * 0.25, 0, AVATAR_W * 0.5, AVATAR_H * headBottom * 0.35);
  };

  paintPlaceholder();
  // 先讓替身可被繪製；貼圖到齊後原地重畫，roster 不需要重新建立條目
  canvas.complete = true;
  canvas.naturalWidth = canvas.width;

  const loaded = {};
  let pending = CV_PARTS.length;
  const composite = () => {
    if (!CV_PARTS.some((p) => loaded[p])) return; // 三張都載入失敗就留著替身
    // 清空後必須先把替身畫回去，再疊上載入成功的貼圖。
    // 少了這一步，只要有一張載入失敗（單一資產讀取失敗、網路瞬斷），
    // 該部位就會變成全透明 —— 角色在大螢幕上缺頭或缺腿，
    // 比維持取樣色的替身難看得多。
    ctx.clearRect(0, 0, AVATAR_W, AVATAR_H);
    paintPlaceholder();
    
    // 視覺強化：增加投影大螢幕上的對比度與飽和度
    ctx.filter = 'contrast(1.15) saturate(1.15) brightness(1.05)';
    
    for (const part of CV_PARTS) {
      const img = loaded[part];
      if (!img) continue;
      const [top, bottom] = CV_CUTS[part];
      ctx.drawImage(img, 0, AVATAR_H * top, AVATAR_W, AVATAR_H * (bottom - top));
    }
    ctx.filter = 'none'; // reset filter
  };

  for (const part of CV_PARTS) {
    const img = new Image();
    img.addEventListener('load', () => { loaded[part] = img; if (--pending === 0) composite(); });
    img.addEventListener('error', () => { if (--pending === 0) composite(); });
    img.src = avatar.textures[part];
  }

  return canvas;
}

function avatarImage(avatar) {
  // 兩種來源：掃描生成走貼圖，模組捏臉（備援路徑）走原本的 SVG
  if (avatar?.source === 'CV') return cvAvatarImage(avatar);
  const svg = renderAvatarSVG(avatar, { width: AVATAR_W, height: AVATAR_H });
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return img;
}

let screenReconnectDelay = 1000;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);

  ws.addEventListener('open', () => {
    screenReconnectDelay = 1000;
    ws.send(JSON.stringify({ type: EV.SCREEN_HELLO }));
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case EV.STAGE_ROSTER: {
        const seen = new Set();
        for (const a of msg.agents) {
          seen.add(a.id);
          const prev = roster.get(a.id);
          // 只在捏臉設定確實改變時才重建圖像，避免每次名冊廣播都重新解碼 SVG
          if (!prev || JSON.stringify(prev.avatar) !== JSON.stringify(a.avatar)) {
            roster.set(a.id, { ...a, img: avatarImage(a.avatar) });
          } else {
            prev.name = a.name;
          }
        }
        for (const id of roster.keys()) {
          if (!seen.has(id)) { roster.delete(id); view.delete(id); pulse.delete(id); }
        }
        break;
      }

      case EV.STAGE_SYNC: {
        latest = msg.agents;
        syncCount++;
        const now = performance.now();
        if (now - lastSyncAt > 1000) {
          syncHz = Math.round((syncCount * 1000) / (now - lastSyncAt));
          syncCount = 0;
          lastSyncAt = now;
        }
        break;
      }

      case EV.MISSION_ANNOUNCE:
        showMission(msg.mission);
        break;

      case EV.MISSION_STATE:
        showMissionProgress(msg.mission);
        break;

      case EV.MISSION_COMPLETE:
        // 規格 v3.0 §3.1 第 05 步：每一次完成都必須在共享畫布上被看見，
        // 否則任務會退化成手機小遊戲
        toast(`${msg.a.name} 和 ${msg.b.name} 認識了！`);
        pulse.set(msg.a.id, performance.now());
        pulse.set(msg.b.id, performance.now());
        break;

      case EV.MISSION_CLOSED:
        showMission(null);
        toast(`任務結束　共 ${msg.totalCompletions} 次配對`);
        break;

      case EV.QUIZ_QUESTION:
        showQuestion(msg.quiz);
        break;

      case EV.QUIZ_TALLY:
        document.getElementById('q-answered').textContent = msg.answered;
        break;

      case EV.QUIZ_REVEAL:
        showReveal(msg);
        break;

      case EV.QUIZ_ENDED:
        hideQuiz();
        break;

      case EV.SCORE_BOARD:
        renderRanks(msg.leaderboard ?? []);
        break;
    }
  });

  ws.addEventListener('close', () => {
    const delay = screenReconnectDelay + Math.floor(Math.random() * 500);
    metaEl.textContent = `與伺服器斷線，${(delay / 1000).toFixed(1)} 秒後重連…`;
    setTimeout(connect, delay);
    screenReconnectDelay = Math.min(screenReconnectDelay * 1.5, 6000);
  });
}

connect();

// ─────────────────────────────────────────────────────────────
// 任務橫幅與完成回饋
// ─────────────────────────────────────────────────────────────
function showMission(m) {
  missionShown = m;
  syncBanners();
  if (!m) return;
  document.getElementById('m-title').textContent = m.title;
  document.getElementById('m-brief').textContent = m.brief ?? '';
  document.getElementById('m-prog').hidden = true;
}

function showMissionProgress(m) {
  if (!m) return;
  const el = document.getElementById('m-prog');
  el.hidden = false;
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = `${m.finished} / ${m.totalAgents}`;
  el.append(b, document.createTextNode(`　人完成　·　累計 ${m.totalCompletions} 次配對`));
}

function toast(text) {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text; // 內含使用者名稱，一律用 textContent
  wrap.append(el);
  setTimeout(() => el.remove(), 4200);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
}

// ─────────────────────────────────────────────────────────────
// 繪製
// ─────────────────────────────────────────────────────────────
const EMOTE_GLYPH = { CHEERS: '🍻', HEART: '💗', WAVE: '👋' };

/** 邏輯座標 → 螢幕座標 (3D 空間投影) */
const toScreen = (v) => {
  return roomScene ? roomScene.projectToScreen(v.x, v.y) : { x: 0, y: 0 };
};

function drawDebugOverlay(a, pos) {
  // 剛體避障半徑
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 95 * scale, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(69,123,157,.22)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // α 權重環：線寬直接編碼 α
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 46 * scale, 0, Math.PI * 2);
  ctx.strokeStyle = a.mode === 'ACTIVE' ? COLOR_ACTIVE : COLOR_SWARM;
  ctx.globalAlpha = 0.3 + a.alpha * 0.7;
  ctx.lineWidth = (1 + a.alpha * 6) * scale;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 合成後的最終速度向量
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  ctx.lineTo(pos.x + a.vx * 0.35 * scale, pos.y + a.vy * 0.35 * scale);
  ctx.strokeStyle = a.mode === 'ACTIVE' ? COLOR_ACTIVE : COLOR_SWARM;
  ctx.lineWidth = 2.5 * scale;
  ctx.stroke();
}

function render(now) {
  const time = now / 1000;

  // 3D 畫布在底層自行 render，我們只需清空 2D Canvas
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (roomScene) roomScene.render();

  if (debug) {
    ctx.strokeStyle = 'rgba(233,196,106,.9)';
    ctx.lineWidth = 2;
    for (const o of OBSTACLES) {
      const p = toScreen(o);
      ctx.beginPath();
      ctx.arc(p.x, p.y, o.r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    const m = 140 * scale;
    ctx.strokeRect(offsetX + m, offsetY + m,
      STAGE.width * scale - m * 2, STAGE.height * scale - m * 2);
  }

  // 位置內插
  for (const a of latest) {
    let v = view.get(a.id);
    if (!v) { v = { x: a.x, y: a.y }; view.set(a.id, v); }
    v.x += (a.x - v.x) * 0.35;
    v.y += (a.y - v.y) * 0.35;
  }

  // 依 Y 軸排序，讓視覺上較近（偏下）的角色蓋住較遠的（§6 風險 2）
  const sorted = [...latest].sort((p, q) => p.y - q.y);
  const height = CHARACTER_HEIGHT * scale;

  for (const a of sorted) {
    const pos = toScreen(view.get(a.id));
    const entry = roster.get(a.id);

    // 剛完成配對：向外擴散的環，讓觀眾把螢幕上的事件與
    // 現場剛剛有兩個人在講話連起來
    const pulsedAt = pulse.get(a.id);
    if (pulsedAt !== undefined) {
      const t = (now - pulsedAt) / PULSE_MS;
      if (t >= 1) {
        pulse.delete(a.id);
      } else {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y - height * 0.4, height * (0.35 + t * 0.85), 0, Math.PI * 2);
        ctx.strokeStyle = '#2A8C80';
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.lineWidth = 4 * scale;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    if (debug) drawDebugOverlay(a, pos);

    drawCharacter(ctx, a, pos, entry?.img, { time, maxSpeed: MAX_SPEED, height });
    drawNameplate(ctx, pos, entry?.name ?? a.id, { fontSize: Math.max(11, 17 * scale) });
    if (a.emote) drawEmote(ctx, pos, EMOTE_GLYPH[a.emote] ?? '·', { height });
    if (a.offline) drawOffline(ctx, pos, { height });
  }

  if (debug) updateHud();
  requestAnimationFrame(render);
}

function updateHud() {
  metaEl.textContent = `場上 ${latest.length} 人　同步 ${syncHz} Hz`;
  listEl.replaceChildren();
  for (const a of latest) {
    const tr = document.createElement('tr');

    // 顯示名稱來自使用者輸入，一律以 textContent 寫入
    const nameCell = document.createElement('td');
    nameCell.className = 'n';
    nameCell.textContent = roster.get(a.id)?.name ?? a.id;

    const barCell = document.createElement('td');
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(a.alpha * 100)}%`;
    bar.append(fill);
    barCell.append(bar);

    const modeCell = document.createElement('td');
    modeCell.className = `m ${a.mode}`;
    modeCell.textContent = a.mode + (a.offline ? ' · 離線' : '');

    tr.append(nameCell, barCell, modeCell);
    listEl.append(tr);
  }
}

requestAnimationFrame(render);

// ─────────────────────────────────────────────────────────────
// 即時問答與排行榜
// ─────────────────────────────────────────────────────────────
const quizEl = document.getElementById('quiz');

/** @type {object|null} 目前題目 */
let quiz = null;
let quizDeadline = 0;
let quizRaf = null;

/** 題目與任務橫幅都在畫面上緣，同時出現會疊在一起 */
function syncBanners() {
  document.getElementById('mission').hidden = quiz !== null || missionShown === null;
}

let missionShown = null;

function renderQuizOptions(revealed = null, counts = null) {
  const wrap = document.getElementById('q-opts');
  wrap.replaceChildren();

  quiz.options.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'q-opt';
    row.style.background = QUIZ_CHOICES[i].color;
    if (revealed !== null) row.classList.add(i === revealed ? 'right' : 'dim');

    const g = document.createElement('span');
    g.className = 'g';
    g.textContent = QUIZ_CHOICES[i].glyph;

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = text;   // 題目由主辦者輸入，一律以 textContent 寫入

    row.append(g, t);

    if (counts) {
      const c = document.createElement('span');
      c.className = 'c';
      c.textContent = `${counts[i]} 人`;
      row.append(c);
    }
    wrap.append(row);
  });
}

/** 倒數條用動畫影格更新，與角色渲染同一個時鐘，不另外開計時器 */
function animateTimebar() {
  cancelAnimationFrame(quizRaf);
  const bar = document.getElementById('q-timebar');
  const fill = document.getElementById('q-timefill');

  const step = () => {
    if (!quiz) return;
    const left = Math.max(0, quizDeadline - Date.now());
    const ratio = quiz.durationMs > 0 ? left / quiz.durationMs : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.classList.toggle('urgent', left < 5000);
    if (left > 0) quizRaf = requestAnimationFrame(step);
  };
  step();
}

function showQuestion(q) {
  quiz = q;
  quizDeadline = Date.now() + (q.remainingMs ?? 0);
  document.getElementById('q-no').textContent = `第 ${q.index} 題`;
  document.getElementById('q-state').textContent = '作答中';
  document.getElementById('q-title').textContent = q.question;
  document.getElementById('q-answered').textContent = q.answered ?? 0;
  document.getElementById('q-foot').hidden = false;
  renderQuizOptions();
  quizEl.hidden = false;
  syncBanners();
  animateTimebar();
}

function showReveal(msg) {
  if (!quiz) return;
  cancelAnimationFrame(quizRaf);
  document.getElementById('q-state').textContent = '正解';
  document.getElementById('q-timefill').style.width = '0%';
  renderQuizOptions(msg.correctIndex, msg.counts);

  const right = msg.correctIds?.length ?? 0;
  document.getElementById('q-foot').replaceChildren(
    document.createTextNode('答對 '),
    Object.assign(document.createElement('b'), { textContent: String(right) }),
    document.createTextNode(` 人　·　作答 ${msg.totalAnswers} 人`),
  );

  // 答對的角色在場上擴散光環：把手機上的答對，變成大螢幕上看得見的事
  for (const id of msg.correctIds ?? []) pulse.set(id, performance.now());
}

function hideQuiz() {
  quiz = null;
  cancelAnimationFrame(quizRaf);
  quizEl.hidden = true;
  syncBanners();
}

function renderRanks(rows) {
  const box = document.getElementById('ranks');
  const ol = document.getElementById('ranks-list');
  box.hidden = rows.length === 0;
  ol.replaceChildren();

  for (const r of rows) {
    const li = document.createElement('li');
    if (r.rank <= 3) li.className = 'top';

    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = r.rank;

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.name || r.id;   // 顯示名稱來自使用者輸入

    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = r.score;

    li.append(no, who, pts);
    ol.append(li);
  }
}
