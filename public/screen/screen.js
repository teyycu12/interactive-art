/**
 * 模組 M3 — 大螢幕公共畫布
 *
 * 渲染分兩層：
 *   靜態場景　由 scene.js 離屏渲染一次，每幀貼圖（見該檔的說明）
 *   角色　　　由 shared/character.js 逐幀以變換矩陣算出步態（手機端 POV 共用同一份）
 *
 * 除錯視圖（按 D）保留自 M2 開發期，用於檢查 α 權重、避障半徑與速度向量。
 */

import { EV, STAGE, MAX_SPEED, QUIZ_CHOICES, EMOTE_GLYPH } from '/shared/protocol.js';
import { avatarImage as buildAvatarImage } from '/shared/avatarSprite.js';
import { OBSTACLES, PROPS } from '/shared/scene.js';
import { TREASURE_RADIUS } from '/shared/heat.js';
import { SURVEY } from '/shared/surveys.js';
import { createScene, pinnedSceneId } from './scenes/registry.js';
import { DEFAULT_THEME, isThemeId } from '/shared/themes.js';
import { drawCharacter, drawNameplate, drawEmote, drawOffline } from '/shared/character.js';
import { stageViewport, setStageTopInset, onStageViewportChange } from './stageViewport.js';

let activeScene = null;

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
  if (e.key === '1') activeScene?.applyLight('day');
  if (e.key === '2') activeScene?.applyLight('evening');
  if (e.key === '3') activeScene?.applyLight('night');
  if (e.key === 'r' || e.key === 'R') activeScene?.resetCamera();
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

  // 畫布鋪滿視窗，但角色只落在可用區裡 —— 與場景背景用同一份 stageViewport()。
  // 兩邊各自算的話，題目出現時角色會浮在房間外面，而畫面上只是「位置怪怪的」。
  const vp = stageViewport();
  scale = Math.min(vp.width / STAGE.width, vp.height / STAGE.height);
  offsetX = vp.x + (vp.width - STAGE.width * scale) / 2;
  offsetY = vp.y + (vp.height - STAGE.height * scale) / 2;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';
}
addEventListener('resize', resize);
onStageViewportChange(resize);
resize();

// ─────────────────────────────────────────────────────────────
// 場景主題
// ─────────────────────────────────────────────────────────────
// 主題由主辦端選擇、伺服器以 STAGE_THEME 廣播；網址帶 ?scene= 時釘住不跟隨（開發預覽用）。
// 開機先用上次的主題，避免投影機重開時先閃一下預設場景、等伺服器回覆才換掉。
// 角色管線不等待場景載入：activeScene 為 null 期間 toScreen 退回 2D 等比縮放。
const sceneHost = document.getElementById('bg3d');
const THEME_KEY = 'pf.screen.theme';
let sceneId = null;
let sceneToken = 0;

async function switchScene(id) {
  if (!isThemeId(id) || id === sceneId) return;
  sceneId = id;
  const token = ++sceneToken;
  const prev = activeScene;
  activeScene = null;
  if (prev?.dispose) prev.dispose(); else if (prev) sceneHost.replaceChildren();
  const next = await createScene(sceneHost, PROPS, id);
  // 載入期間又切了一次：丟掉這個過期的場景，不然兩張畫布會疊在一起
  if (token !== sceneToken) { next.dispose?.(); return; }
  activeScene = next;
}

function followTheme(id) {
  if (pinnedSceneId() || !isThemeId(id)) return;
  try { localStorage.setItem(THEME_KEY, id); } catch { /* 無痕模式等情況，不影響切換 */ }
  switchScene(id);
}

let savedTheme = null;
try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* 略 */ }
switchScene(pinnedSceneId() ?? (isThemeId(savedTheme) ? savedTheme : DEFAULT_THEME));

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
      case EV.STAGE_THEME:
        followTheme(msg.theme);
        break;

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

      case EV.SURVEY_QUESTION:
        showSurvey({ ...msg.survey, counts: new Array(msg.survey.options.length).fill(0), totalAnswers: msg.survey.answered ?? 0 },
          { durationMs: msg.survey.durationMs });
        break;

      case EV.SURVEY_STATE:
        if (msg.state) showSurvey(msg.state);
        break;

      case EV.SURVEY_CLOSED:
        showSurvey(msg.result, { closed: true });
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
  return activeScene ? activeScene.projectToScreen(v.x, v.y)
    : { x: offsetX + v.x * scale, y: offsetY + v.y * scale };
};

// 角色在 3D 世界裡的身高（房間牆高 9，成人約佔五分之一多一點）
const CHARACTER_WORLD_HEIGHT = 2.1;

/**
 * 角色在該座標處應有的螢幕高度。
 *
 * 走 3D 投影而非固定值：同一個人走到房間深處就該變小，走近就該變大。
 * activeScene 還沒建好時退回原本的等比縮放，畫面不會空掉。
 */
function characterHeightAt(v) {
  if (!activeScene || !v) return CHARACTER_HEIGHT * scale;
  const px = activeScene.scaleAt(v.x, v.y, CHARACTER_WORLD_HEIGHT);
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
  if (activeScene) activeScene.render();

  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d');

  // 3D 房間在底層。WebGL 畫布的像素尺寸與 2D 畫布未必相同
  // （setPixelRatio 上限 1.5，2D 用完整 dpr），因此明確拉伸到同一尺寸。
  const gl = activeScene?.canvas ?? activeScene?.renderer?.domElement;
  if (gl) octx.drawImage(gl, 0, 0, out.width, out.height);
  // 角色與名牌在上層
  octx.drawImage(canvas, 0, 0);

  return out.toDataURL('image/png');
}

// Local export uses the exact same scene + character compositor as SCREEN_CAPTURE_REQ.
addEventListener('scene-capture', () => {
  const link = document.createElement('a');
  link.download = 'personaflow-scene.png';
  link.href = captureStageFrame();
  link.click();
});

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
  const r = activeScene
    ? (activeScene.scaleAt(treasureRound.x, treasureRound.y, TREASURE_WORLD_HEIGHT) || TREASURE_RADIUS * scale)
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

  // 場景與透明角色圖層在同一個動畫影格內繪製
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  activeScene?.updateAgents?.(latest);
  if (activeScene) activeScene.render(now);

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
  drawSurveyZones();

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
    drawNameplate(ctx, pos, entry?.name ?? a.id, { fontSize: Math.max(10, height * 0.12) });
    drawPendingMark(a, pos, height);
    if (a.emote) drawEmote(ctx, pos, EMOTE_GLYPH[a.emote] ?? '·', { height });
    if (a.offline) drawOffline(ctx, pos, { height });
  }

  drawSurveySpots(now);

  if (debug) updateHud();
  requestAnimationFrame(render);
}

/**
 * 把問卷選項畫在場景裡它對應的家具旁。
 *
 * 畫在角色之後：這是要看的資訊，被站在桌邊的人蓋住就失去意義。
 * 位置抬到頭頂之上，盡量不壓到人臉。
 */
/**
 * 要到場才算的題目：把每個答案的集合範圍畫在地板上。
 *
 * 畫在角色**之前**，因為它是地面標記 —— 蓋在人身上的話，站滿人的圈圈
 * 就只剩一片色塊，看不出裡面有誰。看不到範圍時現場只能用猜的，
 * 站在邊緣的人會以為系統判錯而不是自己差一步。
 *
 * 半徑由投影過的兩個點量出來，不是縮放乘上去的：3D 地板有透視壓縮，
 * 直接乘會畫出一個與伺服器判定不一致的圈 —— 而那正是最難查的一種不一致。
 */
/**
 * 答了但還沒走到的人，在頭上標一個自己答案顏色的箭頭。
 *
 * 「還差一個」只說得出數字，說不出是誰。標出來之後旁邊的人會開口提醒他 ——
 * 而「通關路徑上要有一步必須跟另一個人講話」正是本專案對新玩法的判準
 * （見 INTERACTION-DESIGN）。
 */
function drawPendingMark(a, pos, height) {
  const choice = pendingChoice.get(a.id);
  if (choice === undefined) return;
  const color = QUIZ_CHOICES[choice]?.color ?? '#E76F51';
  // 尺寸抓角色高度的 0.17：再小就與名牌上的字混在一起，
  // 投影到場地另一端時看不出那是一個記號還是一個像素雜點
  const r = Math.max(8, height * 0.17);
  const y = pos.y - height * 1.5;
  // 浮動幅度很小，但它仍然是裝飾性動態 —— 使用者要求減少動態時就不要動
  const bob = reducedMotion.matches ? 0 : Math.sin(performance.now() / 420 + pos.x) * r * 0.18;

  ctx.save();
  ctx.translate(0, bob);   // 緩慢上下浮動：靜止的畫面上，會動的東西才抓得到餘光
  // 朝下的三角指著這個人，與他要去的那個圈同色 —— 顏色就是「你要去哪一圈」
  ctx.beginPath();
  ctx.moveTo(pos.x - r, y - r * 1.15);
  ctx.lineTo(pos.x + r, y - r * 1.15);
  ctx.lineTo(pos.x, y + r * 0.75);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(1.6, r * 0.28);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** agentId → 選項索引。只放「答了但還沒走到」的人。 */
const pendingChoice = new Map();

function syncPendingChoice() {
  pendingChoice.clear();
  if (!surveyState?.requireArrival) return;
  for (const p of surveyState.pending ?? []) pendingChoice.set(p.id, p.choice);
}

function drawSurveyZones() {
  if (!surveyState?.requireArrival || !optionsAreOnStage(surveyState.options)) return;

  surveyState.options.forEach((opt, i) => {
    const prop = PROPS.find((p) => p.id === opt.spot);
    if (!prop) return;
    const pos = toScreen(prop);
    const reach = (prop.r ?? 0) + SURVEY.arriveRadius;
    const rx = Math.abs(toScreen({ x: prop.x + reach, y: prop.y }).x - pos.x);
    const ry = Math.abs(toScreen({ x: prop.x, y: prop.y + reach }).y - pos.y) || rx * 0.6;
    if (!(rx > 0)) return;

    // 湊齊了就換成實線 —— 虛線代表「還缺人」，實線代表「這一組到齊了」。
    // 數字要看清楚得盯著螢幕，而一圈線的虛實在場地另一端也分得出來。
    const chosen = surveyState.counts?.[i] ?? 0;
    const here = surveyState.arrived?.[i] ?? 0;
    const done = chosen > 0 && here >= chosen;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = `${QUIZ_CHOICES[i].color}${done ? '4D' : '33'}`;
    ctx.fill();
    ctx.lineWidth = Math.max(3, rx * (done ? 0.07 : 0.055));
    ctx.strokeStyle = QUIZ_CHOICES[i].color;
    if (!done) ctx.setLineDash([rx * 0.13, rx * 0.085]);
    ctx.stroke();

    // 內側再描一圈白：投影到深色地板與淺色地毯上時，單一顏色的線
    // 在其中一種底色上一定會糊掉，而場景裡兩種底色都有
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, rx * 0.955, ry * 0.955, 0, 0, Math.PI * 2);
    ctx.setLineDash([]);
    ctx.lineWidth = Math.max(1.5, rx * 0.02);
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.stroke();
    ctx.restore();
  });
}

function drawSurveySpots(now) {
  if (!surveyState || !optionsAreOnStage(surveyState.options)) return;
  const counts = surveyState.counts ?? [];

  const needArrival = !!surveyState.requireArrival;
  const arrived = surveyState.arrived ?? [];

  surveyState.options.forEach((opt, i) => {
    const prop = PROPS.find((p) => p.id === opt.spot);
    if (!prop) return;
    const pos = toScreen(prop);


    // 尺寸比照站在同一個位置的人，遠近才一致 —— 固定尺寸的標籤在房間深處
    // 會大得像貼紙浮在畫面上（與角色高度同一個理由）
    const h = characterHeightAt(prop);
    const pad = h * 0.16;
    const font = Math.max(11, h * 0.26);
    const countFont = Math.max(12, h * 0.3);

    const label = opt.label;
    // 要到場才算時，到位數才是成績；選了幾個人只是過程，所以排在後面且較小。
    const chosen = counts[i] ?? 0;
    const here = arrived[i] ?? 0;
    const count = needArrival
      ? `${here}/${chosen}${chosen > 0 && here >= chosen ? ' ✓' : ''}`
      : `${chosen} 人`;
    ctx.save();
    ctx.font = `700 ${font}px system-ui, "Noto Sans TC", sans-serif`;
    const labelW = ctx.measureText(label).width;
    ctx.font = `900 ${countFont}px system-ui, "Noto Sans TC", sans-serif`;
    const countW = ctx.measureText(count).width;
    const gap = pad * 0.9;
    const w = pad * 2 + font * 1.1 + gap + labelW + gap + countW;
    const boxH = Math.max(font, countFont) + pad * 1.6;
    const x = pos.x - w / 2;
    const y = pos.y - h * 1.15 - boxH;

    ctx.fillStyle = QUIZ_CHOICES[i].color;
    ctx.strokeStyle = 'rgba(47,42,38,.85)';
    ctx.lineWidth = Math.max(1.5, h * 0.025);
    roundRect(ctx, x, y, w, boxH, boxH / 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const midY = y + boxH / 2;
    let cursor = x + pad;
    ctx.font = `900 ${font * 1.1}px system-ui, sans-serif`;
    ctx.fillText(QUIZ_CHOICES[i].glyph, cursor, midY);
    cursor += font * 1.1 + gap;
    ctx.font = `700 ${font}px system-ui, "Noto Sans TC", sans-serif`;
    ctx.fillText(label, cursor, midY);
    cursor += labelW + gap;
    ctx.font = `900 ${countFont}px system-ui, "Noto Sans TC", sans-serif`;
    ctx.fillText(count, cursor, midY);

    // 指向家具的小尖角，免得標籤看起來飄在半空中
    ctx.beginPath();
    ctx.moveTo(pos.x - boxH * 0.22, y + boxH);
    ctx.lineTo(pos.x + boxH * 0.22, y + boxH);
    ctx.lineTo(pos.x, y + boxH + boxH * 0.42);
    ctx.closePath();
    ctx.fillStyle = QUIZ_CHOICES[i].color;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
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

/**
 * 題目、問卷與任務橫幅都固定在畫面上緣，同時出現會疊在一起。
 * 優先序：問答 > 問卷 > 任務 —— 問答有倒數與計分，最不能被蓋住。
 */
function syncBanners() {
  const surveyEl = document.getElementById('survey');
  surveyEl.hidden = surveyState === null || quiz !== null;
  document.getElementById('mission').hidden =
    quiz !== null || surveyState !== null || missionShown === null;
  measureBannerInset();
}

/**
 * 把目前可見的橫幅高度讓給它，場景縮到剩下的空間。
 *
 * 量實際高度而不是寫死：題目長度、選項字數、是否顯示集合地點都會改變高度，
 * 寫死的值在最長的那一題上就會重新蓋到角色 —— 而那一題正是最需要看清楚的。
 */
const BANNER_IDS = ['quiz', 'survey', 'mission'];
const BANNER_GAP = 14;   // 橫幅與房間上緣之間留一點縫，免得看起來黏在一起

function measureBannerInset() {
  let bottom = 0;
  for (const id of BANNER_IDS) {
    const el = document.getElementById(id);
    if (!el || el.hidden) continue;
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
  }
  setStageTopInset(bottom === 0 ? 0 : bottom + BANNER_GAP);
}

// 橫幅內容會在顯示之後才填（選項、倒數條、分佈長條），高度因此是變動的。
// 只在 syncBanners 量一次會量到還沒填完的高度，少掉的那一截正好蓋住角色。
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(() => measureBannerInset());
  for (const id of BANNER_IDS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }
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

// ── 轉場問卷 ────────────────────────────────────────────────
/** @type {object|null} 目前的問卷分佈（題目 + 即時票數） */
let surveyState = null;
let surveyDeadline = 0;
let surveyRaf = null;
let surveyHideTimer = null;

/** 選項綁定的道具名稱。取自目前場景的道具清單，換主題時名稱會跟著換。 */
function spotLabel(propId) {
  if (!propId) return null;
  const prop = PROPS.find((p) => p.id === propId);
  const items = activeScene?.constructor?.ITEMS;
  return items?.[propId]?.[1] ?? (prop ? propId : null);
}

/**
 * 選項是否每一個都綁了場景裡的地點。
 *
 * 全綁了就不在橫幅上列選項 —— 它們改畫在場景裡各自的家具旁（drawSurveySpots）。
 * 這同時省掉橫幅四分之三的高度，並把「我選這個要走去哪」直接答在畫面上，
 * 而那正是這類題目的重點：答案不是按鈕，是走過去。
 */
function optionsAreOnStage(options) {
  return Array.isArray(options) && options.length > 0
    && options.every((o) => o?.spot && PROPS.some((p) => p.id === o.spot));
}

function renderSurveyOptions(state) {
  const wrap = document.getElementById('sv-opts');
  wrap.replaceChildren();
  if (optionsAreOnStage(state.options)) return;
  const total = Math.max(1, state.totalAnswers);

  state.options.forEach((opt, i) => {
    const row = document.createElement('div');
    row.className = 'q-opt';
    row.style.background = QUIZ_CHOICES[i].color;

    const fill = document.createElement('i');
    fill.className = 'fill';
    fill.style.width = `${Math.round((state.counts[i] / total) * 100)}%`;

    const g = document.createElement('span');
    g.className = 'g';
    g.textContent = QUIZ_CHOICES[i].glyph;

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = opt.label;   // 題目與選項可能由主辦者輸入，一律 textContent

    row.append(fill, g, t);

    // 綁了道具的選項標出地點：之後的集合任務就是走這個道具，
    // 先讓全場在答題時就看見「答這個會被叫去哪裡」
    const where = spotLabel(opt.spot);
    if (where) {
      const s = document.createElement('span');
      s.className = 'spot';
      s.textContent = where;
      row.append(s);
    }

    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = `${state.counts[i]} 人`;
    row.append(c);

    wrap.append(row);
  });
}

function animateSurveyBar() {
  cancelAnimationFrame(surveyRaf);
  const bar = document.getElementById('sv-timebar');
  const fill = document.getElementById('sv-timefill');
  const step = () => {
    if (!surveyState) return;
    const left = Math.max(0, surveyDeadline - Date.now());
    const ratio = surveyState.durationMs > 0 ? left / surveyState.durationMs : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.classList.toggle('urgent', left < 5000);
    if (left > 0) surveyRaf = requestAnimationFrame(step);
  };
  step();
}

function showSurvey(state, { closed = false, durationMs = null } = {}) {
  clearTimeout(surveyHideTimer);
  surveyState = { ...state, durationMs: durationMs ?? surveyState?.durationMs ?? state.durationMs ?? 0 };
  syncPendingChoice();
  if (!closed) {
    surveyDeadline = Date.now() + (state.remainingMs ?? 0);
    animateSurveyBar();
  }
  document.getElementById('sv-no').textContent = `問卷 ${state.index ?? ''}`.trim();
  document.getElementById('sv-state').textContent = closed ? '結果' : '作答中';
  document.getElementById('sv-title').textContent = state.question;
  // 要到場才算的題目，橫幅上報的是到位人數 —— 那才是這一題的進度，
  // 「按了幾個」在這種題目裡只是中途狀態
  const answered = state.totalAnswers ?? state.answered ?? 0;
  const foot = document.getElementById('sv-foot');
  if (state.requireArrival) {
    foot.replaceChildren(
      document.createTextNode('已到位 '),
      Object.assign(document.createElement('b'), { textContent: String(state.totalArrived ?? 0) }),
      document.createTextNode(` / ${answered} 人`),
    );
  } else {
    foot.replaceChildren(
      document.createTextNode('已作答 '),
      Object.assign(document.createElement('b'), { textContent: String(answered) }),
      document.createTextNode(' 人'),
    );
  }
  renderSurveyOptions({
    options: state.options,
    counts: state.counts ?? new Array(state.options.length).fill(0),
    totalAnswers: state.totalAnswers ?? 0,
  });
  syncBanners();
  if (closed) {
    cancelAnimationFrame(surveyRaf);
    document.getElementById('sv-timefill').style.width = '0%';
    // 收題後把分佈留在畫面上一段時間再收起 —— 那張長條圖就是這一題的成果，
    // 立刻消失的話現場只會看到題目閃了一下
    surveyHideTimer = setTimeout(hideSurvey, 15000);
  }
}

function hideSurvey() {
  clearTimeout(surveyHideTimer);
  cancelAnimationFrame(surveyRaf);
  surveyState = null;
  syncPendingChoice();
  syncBanners();
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
