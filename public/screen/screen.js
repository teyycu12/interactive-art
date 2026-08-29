/**
 * 模組 M3 — 大螢幕公共畫布
 *
 * 渲染分兩層：
 *   靜態場景　由 scene.js 離屏渲染一次，每幀貼圖（見該檔的說明）
 *   角色　　　由 shared/character.js 逐幀以變換矩陣算出步態（手機端 POV 共用同一份）
 *
 * 除錯視圖（按 D）保留自 M2 開發期，用於檢查 α 權重、避障半徑與速度向量。
 */

import { EV, STAGE, MAX_SPEED, QUIZ_CHOICES, EMOTE_GLYPH, TEAMS } from '/shared/protocol.js';
import { avatarImage as buildAvatarImage } from '/shared/avatarSprite.js';
import { OBSTACLES, PROPS } from '/shared/scene.js';
import { TREASURE_RADIUS } from '/shared/heat.js';
import { RoomScene, populateProps } from './3d/RoomScene.js';
import { drawCharacter, drawNameplate, drawEmote, drawOffline } from '/shared/character.js';

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
  if (e.key === '1') roomScene?.applyLight('day');
  if (e.key === '2') roomScene?.applyLight('evening');
  if (e.key === '3') roomScene?.applyLight('night');
  if (e.key === 'r' || e.key === 'R') roomScene?.resetCamera();
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

/**
 * 剛進場的角色 → 標記時間。用於在頭頂畫一段時間的指示箭頭。
 *
 * 存在的理由：參與者在手機上完成捏臉／生成後會抬頭找自己，
 * 而十個角色散在 1920×1080 上並不好認。沒有指示的話，
 * 「這是我」這個連結就建立不起來 —— 而那正是整件作品的前提。
 */
const arrivals = new Map();
const ARRIVAL_MS = 6000;
let rosterSeenOnce = false;
/**
 * 社交圖譜的邊。
 *
 * 這是整件作品真正在累積的東西 —— 每一條線都對應現場實際發生過的一次
 * 交談（配對必須雙方確認）。角色會走動、會加分，但「誰跟誰認識」若不畫
 * 出來，那張集體共創的關係圖就只存在於伺服器的記憶體裡。
 */
let links = [];
/**
 * 尋寶本輪狀態（含座標）。
 *
 * 大螢幕拿得到座標而手機拿不到 —— 大螢幕是公開畫面，寶箱畫上去
 * 所有人都看得到大概方位，但「還差多遠」仍只有先知知道。
 */
let treasureRound = null;
let treasureHeat = null;

/** 剛完成配對的連線特效，播完即丟 */
const sparks = [];
const SPARK_MS = 1400;
const PULSE_MS = 2600;

let latest = [];
let syncCount = 0;
let lastSyncAt = 0;
let syncHz = 0;

/**
 * 大螢幕的角色圖像。組裝邏輯共用 shared/avatarSprite.js，
 * enhance 打開對比補償 —— 投影機的實際亮度遠低於製作時的螢幕。
 */
const avatarImage = (avatar) => buildAvatarImage(avatar, { enhance: true });

let screenReconnectDelay = 1000;

const offlineEl = document.getElementById('offline');
const offlineTextEl = document.getElementById('offline-text');
/** 重連倒數的計時器，重連成功或下一次斷線時都必須清掉 */
let offlineTimer = null;

/**
 * 顯示／隱藏斷線提示。
 *
 * 這個提示不是可有可無的裝飾：IDLE_MOTION 預設為靜止待機，因此伺服器掛掉時
 * 畫面與「健康但沒人操控」完全相同 —— 角色都停在原地，也沒有任何錯誤訊息。
 * 現場操作者需要一個能一眼分辨兩者的訊號。
 */
function setOffline(on, secondsLeft = 0) {
  if (offlineTimer) { clearInterval(offlineTimer); offlineTimer = null; }
  if (!offlineEl) return;
  offlineEl.hidden = !on;
  if (!on) return;

  let left = secondsLeft;
  const paint = () => {
    offlineTextEl.textContent = left > 0
      ? `與伺服器斷線，${left} 秒後重新連線…`
      : '與伺服器斷線，正在重新連線…';
    left -= 1;
    if (left < 0 && offlineTimer) { clearInterval(offlineTimer); offlineTimer = null; }
  };
  paint();
  offlineTimer = setInterval(paint, 1000);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);

  ws.addEventListener('open', () => {
    screenReconnectDelay = 1000;
    setOffline(false);
    ws.send(JSON.stringify({ type: EV.SCREEN_HELLO }));
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case EV.STAGE_ROSTER: {
        const seen = new Set();
        // 首次收到名冊時不算「新加入」—— 大螢幕中途重開時場上可能已有十個人，
        // 全部一起閃會變成一片光暈，反而看不出誰是誰。
        const firstRoster = !rosterSeenOnce;
        for (const a of msg.agents) {
          seen.add(a.id);
          const prev = roster.get(a.id);
          // 只在捏臉設定確實改變時才重建圖像，避免每次名冊廣播都重新解碼 SVG
          if (!prev || JSON.stringify(prev.avatar) !== JSON.stringify(a.avatar)) {
            roster.set(a.id, { ...a, img: avatarImage(a.avatar) });
          } else {
            prev.name = a.name;
            // 隊伍也要跟著更新 —— 這條分支（外觀沒變）會在整場活動裡
            // 走無數次，只更新名字的話色標會永遠停在第一次收到的值。
            prev.team = a.team;
          }
          // 新加入者標記為「剛進場」：參與者剛抬頭看大螢幕時，
          // 十個角色裡找自己並不容易，給一段時間的指示才接得上。
          if (!prev && !firstRoster) arrivals.set(a.id, performance.now());
        }
        rosterSeenOnce = true;
        for (const id of [...roster.keys()]) {
          if (seen.has(id)) continue;
          // 離場要有交代。默默消失會讓畫面出現無法解釋的變化 ——
          // 觀眾會以為是系統出錯，而不是有人離開了。
          // 首次名冊同樣不報（那只是本機還沒有名冊，不是有人離場）。
          if (!firstRoster) toast(`${roster.get(id).name} 離開了`);
          roster.delete(id); view.delete(id); pulse.delete(id); arrivals.delete(id);
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

      case EV.STAGE_LINKS:
        links = Array.isArray(msg.edges) ? msg.edges : [];
        break;

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
        // 兩個各自擴散的環看不出「是這兩人連上了」——
        // 補一道從 A 射向 B 的光束，把關係本身畫出來
        sparks.push({ a: msg.a.id, b: msg.b.id, at: performance.now() });
        break;

      case EV.TREASURE_START:
        // 大螢幕看得到座標而手機看不到，是刻意的：
        // 大螢幕是「公開的畫面」，寶箱畫在上面所有人都看得到大概方位，
        // 但仍然需要先知喊出冷熱才知道差多遠 —— 這正是設計要的張力。
        treasureRound = { ...msg.round, ...(msg.spot ?? {}) };
        toast(`尋寶開始！先知　${roster.get(msg.round.prophetId)?.name ?? ''}`);
        break;

      case EV.TREASURE_HEAT:
        treasureHeat = msg.heat;
        break;

      case EV.TREASURE_FOUND:
        toast(`${msg.byName} 找到寶藏了！`);
        if (msg.by) pulse.set(msg.by, performance.now());
        treasureRound = null;
        treasureHeat = null;
        break;

      case EV.TREASURE_ENDED:
        treasureRound = null;
        treasureHeat = null;
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
        renderVersus(msg.teams ?? []);
        break;

      case EV.SCREEN_CAPTURE_REQ:
        // 大合照的底圖只能由大螢幕自己提供 —— 3D 場景在 WebGL 畫布上，
        // 伺服器端沒有等價的渲染路徑（見 server/index.js 的 takeGroupPhoto）。
        //
        // 走 HTTP 而非這條 WebSocket：截圖遠大於單則訊息上限（4KB），
        // 那個上限是擋惡意客戶端用的，不該為了合照對所有連線放寬。
        fetch('/api/screen-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: msg.requestId, image: captureStageFrame() }),
        }).catch(() => { /* 失敗就讓伺服器那邊逾時，退回無底圖版本 */ });
        break;
    }
  });

  ws.addEventListener('close', () => {
    const delay = screenReconnectDelay + Math.floor(Math.random() * 500);
    // #meta 在除錯面板裡（預設 hidden），所以另外顯示常駐的斷線提示
    metaEl.textContent = `與伺服器斷線，${(delay / 1000).toFixed(1)} 秒後重連…`;
    setOffline(true, Math.round(delay / 1000));
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

/** 邏輯座標 → 螢幕座標 (3D 空間投影) */
const toScreen = (v) => {
  return roomScene ? roomScene.projectToScreen(v.x, v.y) : { x: 0, y: 0 };
};

// 角色在 3D 世界裡的身高（房間牆高 9，成人約佔五分之一多一點）
const CHARACTER_WORLD_HEIGHT = 2.1;

/**
 * 角色在該座標處應有的螢幕高度。
 *
 * 走 3D 投影而非固定值：同一個人走到房間深處就該變小，走近就該變大。
 * roomScene 還沒建好時退回原本的等比縮放，畫面不會空掉。
 */
function characterHeightAt(v) {
  if (!roomScene || !v) return CHARACTER_HEIGHT * scale;
  const px = roomScene.scaleAt(v.x, v.y, CHARACTER_WORLD_HEIGHT);
  return px > 1 ? px : CHARACTER_HEIGHT * scale;
}

/** 新建立的邊會亮著這麼久，之後淡成常駐細線 */
const LINK_FRESH_MS = 6000;

/**
 * 畫出社交圖譜。
 *
 * 剛建立的邊亮而粗，隨時間淡成細線 —— 這讓「剛剛有兩個人認識了」在滿場
 * 連線中仍然看得出來，同時整場累積的關係網也一直留在畫面上。
 *
 * 只畫兩端都在場的邊：邊本身是既成事實（人離場也不刪），但畫一條連到
 * 空無一人處的線只會讓畫面變髒。
 */
function drawLinks(now) {
  if (links.length === 0) return;
  const wallNow = Date.now();

  ctx.save();
  ctx.lineCap = 'round';
  for (const e of links) {
    const va = view.get(e.a);
    const vb = view.get(e.b);
    if (!va || !vb) continue;

    const pa = toScreen(va);
    const pb = toScreen(vb);
    if (!Number.isFinite(pa.x) || !Number.isFinite(pb.x)) continue;

    // 0 = 剛建立，1 = 已成為背景的一部分
    const age = Math.min(1, Math.max(0, (wallNow - (e.at ?? 0)) / LINK_FRESH_MS));
    const fresh = 1 - age;
    // 剛連上時脈動一下，讓現場注意到
    const pulseAmt = fresh > 0 ? (0.5 + 0.5 * Math.sin(now / 140)) * fresh : 0;

    ctx.strokeStyle = `rgba(42, 140, 128, ${0.16 + fresh * 0.5 + pulseAmt * 0.2})`;
    ctx.lineWidth = (1.2 + fresh * 2.4 + pulseAmt * 1.2) * scale;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 配對瞬間的連線特效：一道沿著兩人之間快速掃過的亮線。
 *
 * 與常駐連線分開處理 —— 那條線負責「他們認識」，這道光束負責
 * 「他們剛剛認識」。全場需要在那一兩秒內知道有事發生。
 */
function drawSparks(now) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i];
    const t = (now - sp.at) / SPARK_MS;
    if (t >= 1) { sparks.splice(i, 1); continue; }

    const va = view.get(sp.a);
    const vb = view.get(sp.b);
    if (!va || !vb) continue;
    const pa = toScreen(va);
    const pb = toScreen(vb);
    if (!Number.isFinite(pa.x) || !Number.isFinite(pb.x)) continue;

    // 前 45% 是光束射出，其餘時間整條線發亮後淡出
    const head = Math.min(1, t / 0.45);
    const ease = 1 - Math.pow(1 - head, 3);
    const hx = pa.x + (pb.x - pa.x) * ease;
    const hy = pa.y + (pb.y - pa.y) * ease;
    const fade = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(42, 140, 128, ${0.9 * fade})`;
    ctx.lineWidth = 5 * scale;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    // 光點在前端
    ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * fade})`;
    ctx.beginPath();
    ctx.arc(hx, hy, 5 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

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

/**
 * 把當下的大螢幕畫面截成一張 PNG（大合照的底圖）。
 *
 * 畫面實際上是兩張獨立的畫布疊出來的：3D 房間在 WebGL 畫布、角色在 2D
 * 畫布，CSS 用 z-index 把它們疊在一起。截圖必須依同樣順序合成 ——
 * 只截其中一張會得到「有房間沒有人」或「有人沒有房間」。
 *
 * 先強制 render 一次再讀：WebGL 的緩衝內容只在該幀有效，
 * 不重畫就可能讀到上一幀甚至空白（配合 preserveDrawingBuffer）。
 */
function captureStageFrame() {
  if (roomScene) roomScene.render();

  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d');

  // 3D 房間在底層。WebGL 畫布的像素尺寸與 2D 畫布未必相同
  // （setPixelRatio 上限 1.5，2D 用完整 dpr），因此明確拉伸到同一尺寸。
  const gl = roomScene?.renderer?.domElement;
  if (gl) octx.drawImage(gl, 0, 0, out.width, out.height);
  // 角色與名牌在上層
  octx.drawImage(canvas, 0, 0);

  return out.toDataURL('image/png');
}

/**
 * 寶箱。畫在角色下方（先繪製），避免蓋住站上去的人。
 *
 * 刻意畫得明顯：這是全場要一起找的目標，看不清楚就失去意義。
 * 但只畫「在哪」，不畫「離最近的人多遠」—— 後者是先知的獨佔資訊。
 */
/** 寶箱在 3D 世界裡的高度（角色為 2.1，寶箱約及膝） */
const TREASURE_WORLD_HEIGHT = 0.8;

function drawTreasure(now) {
  if (!treasureRound || !Number.isFinite(treasureRound.x)) return;
  const p = toScreen(treasureRound);
  // 半徑必須跟著透視縮放，與角色走同一條路徑（characterHeightAt）——
  // 直接用 2D 的 scale 會讓寶箱在房間深處畫得跟最前方一樣大，
  // 那就是「貼紙浮在畫面上」而不是放在地板上。
  const r = roomScene
    ? (roomScene.scaleAt(treasureRound.x, treasureRound.y, TREASURE_WORLD_HEIGHT) || TREASURE_RADIUS * scale)
    : TREASURE_RADIUS * scale;
  // 呼吸脈動：靜止的圖示在滿是走動角色的畫面上會被忽略
  const beat = 1 + Math.sin(now / 380) * 0.08;

  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.beginPath();
  ctx.arc(0, 0, r * beat, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(233,196,106,.18)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(233,196,106,.85)';
  ctx.stroke();

  ctx.font = `${Math.round(r * 1.1)}px system-ui, "Apple Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💎', 0, 0);
  ctx.restore();
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

  drawTreasure(now);

  // 位置內插
  for (const a of latest) {
    let v = view.get(a.id);
    if (!v) { v = { x: a.x, y: a.y }; view.set(a.id, v); }
    v.x += (a.x - v.x) * 0.35;
    v.y += (a.y - v.y) * 0.35;
  }

  // 連線畫在角色底下：關係是背景脈絡，不該蓋住人臉
  drawLinks(now);
  drawSparks(now);

  // 依 Y 軸排序，讓視覺上較近（偏下）的角色蓋住較遠的（§6 風險 2）
  const sorted = [...latest].sort((p, q) => p.y - q.y);

  for (const a of sorted) {
    const v = view.get(a.id);
    const pos = toScreen(v);
    // 角色高度隨深度變化。房間最深處到最近處的相機距離差 2.45 倍，
    // 固定高度會讓所有人畫得一樣大 —— 那是「貼紙浮在畫面上」的主因。
    const height = characterHeightAt(v);
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

    // 剛進場：頭頂的下指箭頭，幫參與者在十個角色裡認出自己。
    // 畫在 drawCharacter 之前，讓角色本體蓋在箭頭之上而非被箭頭壓住。
    const arrivedAt = arrivals.get(a.id);
    if (arrivedAt !== undefined) {
      const t = (now - arrivedAt) / ARRIVAL_MS;
      if (t >= 1) {
        arrivals.delete(a.id);
      } else {
        // 尾段淡出，不要在時間到的瞬間硬切
        const alpha = t > 0.75 ? (1 - t) / 0.25 : 1;
        // 上下浮動，靜止的箭頭在滿是走動角色的畫面裡不夠顯眼
        const float = Math.sin(now / 220) * height * 0.045;
        const tipY = pos.y - height * 1.16 + float;
        const w = height * 0.11;
        const h = height * 0.13;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(pos.x, tipY + h);          // 箭尖朝下，指著角色
        ctx.lineTo(pos.x - w, tipY);
        ctx.lineTo(pos.x + w, tipY);
        ctx.closePath();
        ctx.fillStyle = COLOR_ACTIVE;
        ctx.fill();
        // 米白描邊：深色分區底下純色箭頭會糊掉
        ctx.strokeStyle = 'rgba(250, 248, 245, .9)';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.restore();
      }
    }

    if (debug) drawDebugOverlay(a, pos);

    drawCharacter(ctx, a, pos, entry?.img, { time, maxSpeed: MAX_SPEED, height });
    // 名牌字級跟著角色一起遠小近大，否則遠處的人會頂著一塊過大的名牌
    drawNameplate(ctx, pos, entry?.name ?? a.id, {
      fontSize: Math.max(10, height * 0.12),
      teamColor: entry?.team ? (TEAMS[entry.team]?.color ?? null) : null,
    });
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

/**
 * 兩隊對抗條。
 *
 * 兩隊都是 0 分時各佔一半（而非 0 寬度）—— 活動剛開始時一條空白的
 * 長條看起來像壞掉，對半分才看得出「還沒開始拉開差距」。
 */
function renderVersus(teams) {
  const box = document.getElementById('versus');
  if (!box) return;
  if (teams.length < 2) { box.hidden = true; return; }

  const [a, b] = teams;
  const total = a.score + b.score;
  const aPct = total === 0 ? 50 : (a.score / total) * 100;

  const barA = document.getElementById('versus-a');
  const barB = document.getElementById('versus-b');
  barA.style.width = `${aPct}%`;
  barA.style.background = a.color;
  barB.style.background = b.color;

  const la = document.getElementById('versus-a-label');
  const lb = document.getElementById('versus-b-label');
  la.textContent = `${a.label} ${a.score}`;
  lb.textContent = `${b.score} ${b.label}`;
  // 文字用 ink 而非色塊色：色塊色當文字在紙底上只有 3.7:1
  la.style.color = a.ink;
  lb.style.color = b.ink;
  box.hidden = false;
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
