/**
 * 模組 M3 — 大螢幕公共畫布
 *
 * 渲染分兩層：
 *   靜態場景　由 scene.js 離屏渲染一次，每幀貼圖（見該檔的說明）
 *   角色　　　由 shared/character.js 逐幀以變換矩陣算出步態（手機端 POV 共用同一份）
 *
 * 除錯視圖保留自 M2 開發期，用於檢查 α 權重、避障半徑與速度向量。
 * 它與排行榜、音效、儲存畫面一樣由主辦端操作（SCREEN_SETTINGS；除錯視圖在「系統」分頁），
 * 投影畫面上不留任何按鈕或快捷鍵。
 */

import { EV, STAGE, MAX_SPEED, QUIZ_CHOICES, QUIZ_PHASE, EMOTE_GLYPH, MISSION_TYPES } from '/shared/protocol.js';
import { avatarImage as buildAvatarImage } from '/shared/avatarSprite.js';
import { OBSTACLES, PROPS } from '/shared/scene.js';
import { WORDCLOUD } from '/shared/wordcloud.js';
import { createScene, pinnedSceneId } from './scenes/registry.js';
import { DEFAULT_THEME, isThemeId, THEME_MAP } from '/shared/themes.js';
import {
  drawCharacter, drawNameplate, drawEmote, drawOffline, emoteIsPosed,
  measureNameplate, NAMEPLATE_DROP,
} from '/shared/character.js';
import { layoutNameplates } from '/shared/nameplateLayout.js';
import { stageViewport, onStageViewportChange } from './stageViewport.js';
import { Sfx } from './sfx.js';
import { renderGroupPhoto } from './photoRender.js';

let activeScene = null;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const metaEl = document.getElementById('meta');
const listEl = document.getElementById('list');

const COLOR_ACTIVE = '#E76F51';
const COLOR_SWARM = '#457B9D';
const CHARACTER_HEIGHT = 150;   // 邏輯座標下的角色高度

let debug = false;
/**
 * 目前的賓果進度（BINGO_STATE），null 代表沒有進行中的一輪。
 * 放在檔頭：syncBanners 會讀它，宣告若排在後面，載入途中一被呼叫就是 TDZ 錯誤、整個大螢幕白掉。
 */
let bingoShown = null;
let bingoDeadline = null;

/** 短音效（public/screen/sfx.js）。開關由主辦端控制，預設開 */
const sfx = new Sfx();

/**
 * ?preview=1：嵌在主控台裡的預覽小窗。畫面與真的大螢幕完全一樣，但
 * 不出聲（主持人的電腦跟著投影機一起響只會干擾），也不提供截圖（見伺服器的 SCREEN_HELLO）。
 */
const PREVIEW = new URLSearchParams(location.search).get('preview') === '1';
if (PREVIEW) { document.documentElement.classList.add('is-preview'); sfx.setEnabled(false); }

/** 右下角積分排行：主辦端可以關掉（不想讓全場比分數時），有人得分才出現 */
let ranksOn = true;
let ranksCount = 0;
const syncRanks = () => { document.getElementById('ranks').hidden = !ranksOn || ranksCount === 0; };

function applySettings(settings) {
  if (!settings) return;
  debug = settings.debug === true;
  document.getElementById('hud').hidden = !debug;
  sfx.setEnabled(!PREVIEW && settings.sound !== false);
  ranksOn = settings.ranks !== false;
  syncRanks();
}

// ─────────────────────────────────────────────────────────────
// 左上角標題卡：活動名稱
// ─────────────────────────────────────────────────────────────
// 主辦端設定活動名稱後，標題卡顯示活動主題而非場景名；尚未設定時退回場景名。
// 畫在頁面層而非場景裡，3D 客廳與像素場景才會長得一樣。
const eventCard = document.getElementById('event-card');
let eventInfo = null;

function renderEventCard() {
  const scene = activeScene?.constructor;
  const title = eventInfo?.name || scene?.TITLE || THEME_MAP[sceneId]?.label || '';
  const subtitle = eventInfo ? eventInfo.subtitle : (scene?.SUBTITLE ?? '');
  eventCard.querySelector('h1').textContent = title;
  const sub = eventCard.querySelector('p');
  sub.textContent = subtitle;
  sub.hidden = !subtitle;
  eventCard.hidden = !title;
  document.title = eventInfo?.name ? `${eventInfo.name}｜PixelAir 大螢幕` : 'PixelAir 大螢幕';
}

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
  renderEventCard();
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
/** 名牌目前畫在哪（相對原位的位移）。逐幀朝避讓結果內插，人走動時名牌滑過去而不是跳過去 */
const plateOffset = new Map();
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
/** 剛完成配對的連線特效，播完即丟 */
const sparks = [];
/** 揮手、碰杯的光束色（陶土橘）。與配對的青綠分開：一眼分得出「認識了」與「打了招呼」 */
const GREET_SPARK_RGB = '217, 116, 74';
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
/** 目前這條連線。大螢幕平常只收不送；送的只有下載 QR 的 ×（見 showPhotoQr 上方） */
let screenWs = null;

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
  screenWs = ws;

  ws.addEventListener('open', () => {
    screenReconnectDelay = 1000;
    setOffline(false);
    ws.send(JSON.stringify({ type: EV.SCREEN_HELLO, preview: PREVIEW }));
    helloAt = Date.now();
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case EV.STAGE_THEME:
        followTheme(msg.theme);
        break;

      case EV.STAGE_EVENT:
        eventInfo = msg.event ?? null;
        renderEventCard();
        break;

      case EV.SCREEN_SETTINGS:
        applySettings(msg.settings);
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
          plateOffset.delete(id);
          voxels?.dispose(id);
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

      case EV.STAGE_TOPIC:
        if (typeof msg.spotId === 'string' && typeof msg.question === 'string') {
          topicBubbles.set(msg.spotId, { question: msg.question, at: performance.now() });
        }
        break;

      case EV.STAGE_GREET:
        // 互相揮手／碰杯：同一道光束，暖色，不留常駐連線（那是配對的事，見 greetings.js）
        if (typeof msg.a === 'string' && typeof msg.b === 'string') {
          sparks.push({ a: msg.a, b: msg.b, at: performance.now(), rgb: GREET_SPARK_RGB });
          sfx.play('greet');
        }
        break;

      case EV.MISSION_ANNOUNCE:
        if (msg.gather && msg.mission?.id) gatherStates.set(msg.mission.id, msg.gather);
        showMission(msg.mission);
        headline('新任務', msg.mission?.title, msg.mission?.brief);
        break;

      case EV.MISSION_GATHER: {
        const g = gatherStates.get(msg.id);
        if (!g) break;
        g.inside = msg.inside;
        if (msg.done?.length) {
          toast(`${msg.done.length} 人在「${g.label}」集合完成！`);
          sfx.play('pair');
          const t = performance.now();
          for (const id of msg.done) pulse.set(id, t);
        }
        break;
      }

      case EV.MISSION_STATE:
        showMissionProgress(msg.mission);
        break;

      case EV.MISSION_COMPLETE:
        // 規格 v3.0 §3.1 第 05 步：每一次完成都必須在共享畫布上被看見，
        // 否則任務會退化成手機小遊戲
        toast(`${msg.a.name} 和 ${msg.b.name} 認識了！`);
        sfx.play('pair');
        pulse.set(msg.a.id, performance.now());
        pulse.set(msg.b.id, performance.now());
        // 兩個各自擴散的環看不出「是這兩人連上了」——
        // 補一道從 A 射向 B 的光束，把關係本身畫出來
        sparks.push({ a: msg.a.id, b: msg.b.id, at: performance.now() });
        break;

      case EV.MISSION_CLOSED:
        if (msg.id) gatherStates.delete(msg.id); else gatherStates.clear();
        closeMissionShown(msg.id);
        toast(`任務結束　共 ${msg.totalCompletions} 次配對`);
        break;

      case EV.QUIZ_QUESTION:
        // 同一題送第二次是「討論結束、開始作答」；新題目才是出題音
        sfx.play(quiz?.id === msg.quiz?.id ? 'go' : 'quiz');
        showQuestion(msg.quiz);
        break;

      case EV.WORDCLOUD_QUESTION:
        sfx.play('quiz');
        showWordCloud({ question: msg.cloud.question, words: [], participants: 0 });
        break;

      case EV.WORDCLOUD_STATE:
        if (msg.cloud) updateWordCloud(msg.cloud);
        break;

      case EV.WORDCLOUD_CLOSED:
        closeWordCloud(msg.result);
        break;

      // 主持人收起結果（或伺服器時間到）。只收「已收題」的那一面，正在作答的題目不受影響
      case EV.WORDCLOUD_DISMISS:
        if (wcEl.classList.contains('closed')) { clearTimeout(wcHideTimer); wcEl.hidden = true; }
        break;

      case EV.BINGO_STATE: {
        if (msg.round && !bingoShown) headline('新活動', '人物賓果開始了', '打開手機，找符合格子條件的人，問他的配對碼');
        // 有人新連成一線：響一聲（BINGO_STATE 每填一格都會來，只有線數變多才響）
        const prevTop = bingoShown?.top?.[0]?.lines ?? 0;
        showBingo(msg.round);
        if ((msg.round?.top?.[0]?.lines ?? 0) > prevTop) sfx.play('pair');
        break;
      }

      case EV.BINGO_COUNTDOWN:
        countdown321(msg.kind === 'end' ? '人物賓果　即將結束' : '人物賓果　準備開始',
          msg.kind === 'end' ? '時間到！' : '開始！', msg.ms);
        break;

      case EV.BINGO_ENDED:
        showBingo(null);
        toast(msg.winners?.length ? `人物賓果結束！最多連線：${msg.winners.join('、')}` : '人物賓果結束！');
        sfx.play('fanfare');
        break;

      case EV.QUIZ_TALLY: {
        // 揭曉後這格已換成「答對 N 人」，遲到的計數直接略過
        const el = document.getElementById('q-answered');
        if (el) el.textContent = msg.answered;
        break;
      }

      case EV.QUIZ_REVEAL:
        showReveal(msg);
        sfx.play('reveal');
        break;

      case EV.QUIZ_ENDED:
        hideQuiz();
        break;

      case EV.SCORE_BOARD:
        renderRanks(msg.leaderboard ?? []);
        break;

      case EV.SCREEN_PHOTO_QR:
        showPhotoQr(msg);
        break;

      case EV.SCREEN_CAPTURE_REQ: {
        // 兩種用途共用這條管線：
        //   帶 people → 大合照。在看不見的畫布上另外合成一張全員到齊的房間（photoRender.js），
        //               大螢幕畫面完全不變、場上的人照常走動。
        //   不帶      → 主辦端「儲存畫面」，截大螢幕當下的樣子。
        // 走 HTTP 而非這條 WebSocket：截圖遠大於單則訊息上限（4KB），
        // 那個上限是擋惡意客戶端用的，不該為了合照對所有連線放寬。
        const post = (image) => fetch('/api/screen-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: msg.requestId, image }),
        }).catch(() => { /* 失敗就讓伺服器那邊逾時，退回無底圖版本 */ });
        if (Array.isArray(msg.people)) {
          renderGroupPhoto(activeScene, msg.people, { heightScale: CHARACTER_SCALE, worldHeight: CHARACTER_WORLD_HEIGHT })
            .catch((err) => { console.warn('[photo] 合成失敗', err); return null; })
            .then(post);   // null（3D 主題、合成失敗）→ 伺服器退回 Python 自畫的舞台
        } else {
          post(captureStageFrame());
        }
        break;
      }
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
/**
 * 進行中的任務：id → {title, finished, total}。可以同時好幾個（2026-10-17），
 * 上緣「進行中：」一列一個任務一格。
 * @type {Map<string, {title: string, finished: number|null, total: number|null}>}
 */
const missionsShown = new Map();

function showMission(m) {
  if (!m?.id) return;
  missionsShown.set(m.id, { title: m.title, finished: null, total: null });
  renderMissionsBar();
}

function showMissionProgress(m) {
  if (!m?.id) return;
  const entry = missionsShown.get(m.id) ?? { title: m.title };
  missionsShown.set(m.id, { ...entry, title: m.title ?? entry.title, finished: m.finished, total: m.totalAgents });
  renderMissionsBar();
}

function closeMissionShown(id) {
  if (id) missionsShown.delete(id); else missionsShown.clear();
  renderMissionsBar();
}

function renderMissionsBar() {
  document.getElementById('nb-missions').replaceChildren(...[...missionsShown.values()].map((m) => {
    const item = Object.assign(document.createElement('span'), { className: 'nb-item' });
    item.append(
      Object.assign(document.createElement('b'), { className: 'nb-kind nb-mission', textContent: '任務' }),
      Object.assign(document.createElement('span'), { className: 'nb-text', textContent: m.title }),
    );
    if (m.finished != null) {
      const meta = Object.assign(document.createElement('span'), { className: 'nb-meta' });
      meta.append(Object.assign(document.createElement('b'), { textContent: `${m.finished} / ${m.total}` }), document.createTextNode(' 人完成'));
      item.append(meta);
    }
    return item;
  }));
  syncBanners();
}

/** 賓果開始／結束前的 3、2、1。大螢幕跟手機各自數，起點都是收到 BINGO_COUNTDOWN 的那一刻 */
let c3Timer = null;
function countdown321(label, finalText, ms = 3000) {
  const el = document.getElementById('countdown-321');
  const num = document.getElementById('c3-num');
  document.getElementById('c3-label').textContent = label;
  clearInterval(c3Timer);
  const endAt = Date.now() + ms;
  const tick = () => {
    const left = endAt - Date.now();
    if (left <= 0) {
      num.textContent = finalText;
      num.classList.add('final');
      clearInterval(c3Timer);
      sfx.play('fanfare');
      setTimeout(() => { el.hidden = true; num.classList.remove('final'); }, 1100);
      return;
    }
    const n = String(Math.ceil(left / 1000));
    if (num.textContent !== n) {
      num.textContent = n;
      num.classList.remove('final');
      num.style.animation = 'none';
      void num.offsetWidth;
      num.style.animation = '';
      sfx.play('go');   // 每個數字一聲短嗶
    }
  };
  num.textContent = '';
  el.hidden = false;
  tick();
  c3Timer = setInterval(tick, 100);
}

/** 連上（或重連）的時刻。之後一小段時間收到的公告是伺服器補送的進行中活動，不是剛開始的 */
let helloAt = 0;
let headlineTimer = null;

/** 新活動開始：中央大字標題幾秒。重連補送的不跳 —— 那不是「剛開始」，而且一次會來好幾個 */
function headline(kind, title, sub) {
  if (!title || Date.now() - helloAt < 2000) return;
  document.getElementById('hl-kind').textContent = kind;
  document.getElementById('hl-title').textContent = title;   // 主持人輸入的文字，一律 textContent
  document.getElementById('hl-sub').textContent = sub ?? '';
  const el = document.getElementById('headline');
  el.hidden = false;
  clearTimeout(headlineTimer);
  headlineTimer = setTimeout(() => { el.hidden = true; }, 4500);
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
 * 角色整體放大倍率，所有場景一起套用。
 *
 * 2026-10-08 現場看過：比起周圍的家具，角色小了一截（要大 10~15%）。
 * 放在這裡而不是改 CHARACTER_WORLD_HEIGHT：像素場景的 scaleAt 不吃世界
 * 高度的實際意義（height × 57 × zoom），改那個數字兩種場景放大的比例不同。
 * 名牌、箭頭、表情都以角色高度為準，會跟著一起放大。
 */
const CHARACTER_SCALE = 1.12;

/**
 * 角色在該座標處應有的螢幕高度。
 *
 * 走 3D 投影而非固定值：同一個人走到房間深處就該變小，走近就該變大。
 * activeScene 還沒建好時退回原本的等比縮放，畫面不會空掉。
 */
function characterHeightAt(v) {
  if (!activeScene || !v) return CHARACTER_HEIGHT * scale * CHARACTER_SCALE;
  const px = activeScene.scaleAt(v.x, v.y, CHARACTER_WORLD_HEIGHT);
  return (px > 1 ? px : CHARACTER_HEIGHT * scale) * CHARACTER_SCALE;
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
    ctx.strokeStyle = `rgba(${sp.rgb ?? '42, 140, 128'}, ${0.9 * fade})`;
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
// ── 大合照下載 QR ─────────────────────────────────────────
// 拍完自動顯示，之後由主持人在主控端切換顯示／隱藏（SCREEN_PHOTO_QR 的 visible）。
// 右上角的 × 在大螢幕這台直接收起：先在本機藏起來（不等來回），再告訴伺服器，
// 其他大螢幕與主控端的按鈕才會一致（server 的 SCREEN_PHOTO_QR_HIDE）
document.getElementById('photo-qr-close').addEventListener('click', () => {
  document.getElementById('photo-qr').hidden = true;
  if (screenWs?.readyState === WebSocket.OPEN) screenWs.send(JSON.stringify({ type: EV.SCREEN_PHOTO_QR_HIDE }));
});

function showPhotoQr({ qr, visible } = {}) {
  const box = document.getElementById('photo-qr');
  if (!visible || typeof qr !== 'string' || !qr.startsWith('data:image/')) { box.hidden = true; return; }
  document.getElementById('photo-qr-img').src = qr;
  box.hidden = false;
}

function captureStageFrame() {
  // 整幀重畫（場景＋角色），不只重畫場景：大螢幕分頁在背景或縮小時瀏覽器會暫停
  // 動畫，角色那層停在很久以前的樣子 —— 合照只有房間沒有人（2026-10-17 實測：
  // 另開了一個沒在看的大螢幕分頁，伺服器挑到它）。角色先貼到最新位置：
  // 內插是給連續動畫用的，暫停過的分頁會差一大截
  for (const a of latest) view.set(a.id, { x: a.x, y: a.y });
  drawFrame(performance.now());

  // 只截房間那一塊（像素場景剛好 16:9）。原本截整個視窗：大螢幕視窗不是 16:9 時
  // （瀏覽器還有工具列、或投影機解析度不同）兩側多了深色邊，Python 再硬拉成
  // 1920×1080，整個房間被壓扁或拉長（2026-10-19「合照長寬比跑掉了」）。
  // 3D 主題沒有房間框，照舊截整個視窗，Python 那邊會等比縮放、不再硬拉。
  const r = activeScene?.roomRect?.() ?? { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const k = canvas.width / innerWidth;   // 2D 畫布每 CSS px 幾個像素
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w * k));
  out.height = Math.max(1, Math.round(r.h * k));
  const octx = out.getContext('2d');
  // 各畫布的像素密度未必相同（WebGL 的 setPixelRatio 上限 1.5，2D 用完整 dpr），
  // 每一張都依自己的密度換算要截的那一塊
  const blit = (src) => {
    const s = src.width / innerWidth;
    octx.drawImage(src, r.x * s, r.y * s, r.w * s, r.h * s, 0, 0, out.width, out.height);
  };

  // 場景在底層，角色與名牌在上層
  const gl = activeScene?.canvas ?? activeScene?.renderer?.domElement;
  if (gl) blit(gl);
  blit(canvas);

  return out.toDataURL('image/png');
}


// 體素 3D 角色：預設關閉。場景是 2D 的，角色維持平面紙娃娃（shared/character.js）；
// ?voxel=1 才開，留作比較與實驗。WebGL 不能用時 ok 為 false，照舊畫 2D。
//
// 動態載入：voxelCharacters.js 會 import 整包 three.js（約 1 MB）。靜態 import 的話，
// 預設不開體素的每一次開機都要下載、解析它；而且 /vendor/three.module.js 一旦
// 載不到，整個 screen.js 模組載入失敗，連 2D 舞台都是空白 —— 展場網路不穩時
// 這是投影直接黑掉。載入失敗就維持 null，照舊畫 2D（「失敗一律降級」）。
let voxels = null;
if (new URLSearchParams(location.search).get('voxel') === '1') {
  import('./voxelCharacters.js')
    .then(({ VoxelCharacters }) => { voxels = new VoxelCharacters(); })
    .catch((err) => console.warn('[voxel] 載入失敗，照舊畫 2D', err));
}
let lastFrameAt = 0;

/** 每一幀：畫完再排下一幀。截圖要的是「畫一幀」，不能多排一條動畫迴圈（見 captureStageFrame） */
function render(now) {
  drawFrame(now);
  requestAnimationFrame(render);
}

function drawFrame(now) {
  const time = now / 1000;
  // 上限 0.1 秒：分頁切回來時的第一幀不要讓角色一口氣轉好幾圈
  const dt = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 0;
  lastFrameAt = now;

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

  drawGatherZones();

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

  // 名牌先排版（避讓要看到全場的名牌才排得出來），畫的時候再跟著各自的角色一起畫：
  // 名牌跟角色在同一個前後順序裡 —— 有人從前面經過時，後面那人的名字會被他擋住。
  const frames = new Map();
  const plates = [];
  for (const a of sorted) {
    const v = view.get(a.id);
    const pos = toScreen(v);
    // 角色高度隨深度變化。房間最深處到最近處的相機距離差 2.45 倍，
    // 固定高度會讓所有人畫得一樣大 —— 那是「貼紙浮在畫面上」的主因。
    const height = characterHeightAt(v);
    const entry = roster.get(a.id);
    // 名牌字級跟著角色一起遠小近大，否則遠處的人會頂著一塊過大的名牌
    const name = entry?.name ?? a.id;
    const fontSize = Math.max(10, height * 0.12);
    const { w, h } = measureNameplate(ctx, name, { fontSize });
    frames.set(a.id, { pos, height, entry, name, fontSize });
    plates.push({ id: a.id, x: pos.x, y: pos.y + NAMEPLATE_DROP, w, h });
  }
  const plateTarget = layoutNameplates(plates, { bottom: innerHeight });

  // 體素角色先全部畫進圖集，下面的迴圈再一個個貼回來 ——
  // 這樣名牌、箭頭與前後遮擋的順序與 2D 時完全相同
  if (voxels?.ok) {
    const list = [];
    for (const a of sorted) {
      if (voxels.ensure(a.id, roster.get(a.id)?.img)) list.push({ id: a.id, agent: a });
    }
    voxels.render(list, { time, maxSpeed: MAX_SPEED, dt });
  }

  for (const a of sorted) {
    const { pos, height, entry, name, fontSize } = frames.get(a.id);

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

    drawCharacter(ctx, a, pos, entry?.img,
      { time, maxSpeed: MAX_SPEED, height, voxel: voxels?.tile(a.id) });
    drawPlate(a.id, pos, name, fontSize, plateTarget.get(a.id));
    if (a.emote && !emoteIsPosed(entry?.img, a.emote)) drawEmote(ctx, pos, EMOTE_GLYPH[a.emote], { height });
    if (a.offline) drawOffline(ctx, pos, { height });
  }

  drawGatherLabels();
  drawTopicBubbles(now);

  if (debug) updateHud();
}

/**
 * 畫一個名牌：位置是避讓排版的結果（shared/nameplateLayout.js），平滑地滑到位。
 *
 * 跟著自己的角色畫，不是全部角色畫完才統一畫在最上層（2026-10-17 改）：名牌是角色的一部分，
 * 有人從前面經過時，後面那人的名字被擋住才自然。代價是人擠成一團時，站在後排的
 * 名字可能暫時被前排的人蓋住；避讓排版仍會把名牌往下、往旁邊錯開，盡量露出來。
 */
function drawPlate(id, pos, name, fontSize, target) {
  let cur = plateOffset.get(id);
  if (!cur) {
    // 第一次出現直接放到位，不要從原位滑過去
    cur = { dx: target.dx, dy: target.dy };
    plateOffset.set(id, cur);
  }
  cur.dx += (target.dx - cur.dx) * 0.2;
  cur.dy += (target.dy - cur.dy) * 0.2;
  drawNameplate(ctx, pos, name, { fontSize, offset: cur });
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
 * 話題桌的題目泡泡（STAGE_TOPIC）。題目公開在大螢幕上是刻意的：旁邊的人看到
 * 「1號桌在聊最想學的技能」，可能就走過去加入 —— 新的人坐下，那桌會換一題。
 * @type {Map<string, {question: string, at: number}>}
 */
const topicBubbles = new Map();
const TOPIC_SHOW_MS = 20_000;

function drawTopicBubbles(now) {
  for (const [spotId, b] of topicBubbles) {
    const age = now - b.at;
    if (age > TOPIC_SHOW_MS) { topicBubbles.delete(spotId); continue; }
    const prop = PROPS.find((p) => p.id === spotId);
    if (!prop) continue;
    const pos = toScreen(prop);
    const h = characterHeightAt(prop);
    const font = Math.max(12, h * 0.24);
    const pad = font * 0.7;
    const lines = wrapText(`💬 ${b.question}`, 13).slice(0, 3);

    ctx.save();
    // 最後兩秒淡出
    ctx.globalAlpha = Math.min(1, (TOPIC_SHOW_MS - age) / 2000);
    ctx.font = `800 ${font}px system-ui, "Noto Sans TC", sans-serif`;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const boxH = lines.length * font * 1.3 + pad * 1.4;
    const x = pos.x - w / 2;
    const y = pos.y - h * 1.2 - boxH;
    ctx.fillStyle = '#FFFCF5';
    ctx.strokeStyle = '#3D6158';
    ctx.lineWidth = Math.max(2, h * 0.03);
    roundRect(ctx, x, y, w, boxH, font * 0.6);
    ctx.fill();
    ctx.stroke();
    // 指向桌子的尖角
    ctx.beginPath();
    ctx.moveTo(pos.x - font * 0.4, y + boxH);
    ctx.lineTo(pos.x + font * 0.4, y + boxH);
    ctx.lineTo(pos.x, y + boxH + font * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#3A2E27';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, pos.x, y + pad * 0.7 + i * font * 1.3));
    ctx.restore();
  }
}

/** 中文沒有空格可斷，依字數硬斷；超過的部分由呼叫端截掉 */
function wrapText(text, perLine) {
  const chars = [...text];
  const out = [];
  for (let i = 0; i < chars.length; i += perLine) out.push(chars.slice(i, i + perLine).join(''));
  return out;
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
 * 上緣的「進行中：」一列（任務、賓果）。直接疊在場景上、房間不縮小（2026-10-17 主持人決定）：
 * 場景大小固定比較重要，被這一列蓋住上緣一小塊可以接受。
 * 問答、文字雲是滿版面板，開著時會蓋在這一列上面。
 */
function syncBanners() {
  document.getElementById('nb-bingo').hidden = bingoShown === null;
  document.getElementById('now-bar').hidden = missionsShown.size === 0 && bingoShown === null;
}

function showBingo(round) {
  bingoShown = round;
  // ask 階段倒數的是勾題目的時間，play 階段才是本輪限時
  const left = round?.phase === 'ask' ? round.askRemainingMs : round?.remainingMs;
  bingoDeadline = left == null ? null : Date.now() + left;
  if (round?.phase === 'ask') {
    document.getElementById('bingo-lead').textContent = '先在手機上勾自我介紹';
  } else if (round) {
    const lead = round.top.filter((t) => t.lines > 0 && t.lines === round.top[0].lines);
    document.getElementById('bingo-lead').textContent = lead.length
      ? `最多連線：${lead.map((t) => t.name).join('、')}（${lead[0].lines} 線）`
      : '找符合條件的人，問他的配對碼';
  }
  renderBingoMeta();
  syncBanners();
}

function renderBingoMeta() {
  if (!bingoShown) return;
  const parts = [bingoShown.phase === 'ask'
    ? `${bingoShown.answered ?? 0} / ${bingoShown.players} 人答完`
    : `${bingoShown.players} 人參加`];
  if (bingoDeadline) {
    const left = Math.max(0, bingoDeadline - Date.now());
    parts.push(`剩 ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`);
  }
  document.getElementById('bingo-meta').textContent = parts.join('　·　');
}
setInterval(renderBingoMeta, 1000);


function renderQuizOptions(revealed = null, counts = null) {
  const wrap = document.getElementById('q-opts');
  wrap.replaceChildren();

  quiz.options.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'q-opt';
    row.style.background = QUIZ_CHOICES[i].color;
    row.style.color = QUIZ_CHOICES[i].ink;
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

// ── GATHER 任務的集合點 ─────────────────────────────────────
/**
 * 進行中的集合任務：任務 id → 集合點與人數。可以同時開兩個不同集合點。
 * @type {Map<string, {spot: string, label: string, need: number, inside: number}>}
 */
const gatherStates = new Map();
const GATHER_COLOR = '#457B9D';

/**
 * 集合點地上那一圈。範圍與伺服器判定相同（道具半徑 + MISSION_TYPES.GATHER.reachRadius），
 * 站進圈裡才算 —— 兩邊各算各的話，會出現「畫面上明明在圈裡卻不算」。
 */
function drawGatherZones() {
  for (const g of gatherStates.values()) drawGatherZone(g);
}

function drawGatherZone(gatherState) {
  const prop = PROPS.find((p) => p.id === gatherState.spot);
  if (!prop) return;
  const pos = toScreen(prop);
  const reach = (prop.r ?? 0) + MISSION_TYPES.GATHER.reachRadius;
  const rx = Math.abs(toScreen({ x: prop.x + reach, y: prop.y }).x - pos.x);
  const ry = Math.abs(toScreen({ x: prop.x, y: prop.y + reach }).y - pos.y) || rx * 0.6;
  if (!(rx > 0)) return;
  const full = gatherState.inside >= gatherState.need;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(pos.x, pos.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = `${GATHER_COLOR}${full ? '4D' : '26'}`;
  ctx.fill();
  ctx.lineWidth = Math.max(3, rx * (full ? 0.07 : 0.055));
  ctx.strokeStyle = GATHER_COLOR;
  // 湊齊了換實線（同問卷集合點）：線的虛實在場地另一端也分得出來
  if (!full) ctx.setLineDash([rx * 0.13, rx * 0.085]);
  ctx.stroke();
  ctx.restore();
}

/** 集合點上方的牌子：「1號桌　2 / 3 人」 */
function drawGatherLabels() {
  for (const g of gatherStates.values()) drawGatherLabel(g);
}

function drawGatherLabel(gatherState) {
  const prop = PROPS.find((p) => p.id === gatherState.spot);
  if (!prop) return;
  const pos = toScreen(prop);
  const h = characterHeightAt(prop);
  const font = Math.max(12, h * 0.28);
  const text = `${gatherState.label}　${gatherState.inside} / ${gatherState.need} 人`;
  ctx.save();
  ctx.font = `800 ${font}px system-ui, "Noto Sans TC", sans-serif`;
  const pad = font * 0.6;
  const w = ctx.measureText(text).width + pad * 2;
  const boxH = font + pad * 1.2;
  const x = pos.x - w / 2;
  const y = pos.y - h * 1.15 - boxH;
  ctx.fillStyle = GATHER_COLOR;
  ctx.strokeStyle = 'rgba(47,42,38,.85)';
  ctx.lineWidth = Math.max(1.5, h * 0.025);
  roundRect(ctx, x, y, w, boxH, boxH / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';   // 白字壓 #457B9D 是 4.59:1
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, pos.x, y + boxH / 2);
  ctx.restore();
}


/** 倒數條用動畫影格更新，與角色渲染同一個時鐘，不另外開計時器 */
function animateTimebar() {
  cancelAnimationFrame(quizRaf);
  const bar = document.getElementById('q-timebar');
  const fill = document.getElementById('q-timefill');

  const step = () => {
    if (!quiz) return;
    const left = Math.max(0, quizDeadline - Date.now());
    // 討論中倒數的是討論時間，倒數條的滿格也要用它算
    const talking = quiz.phase === QUIZ_PHASE.DISCUSS;
    const total = talking ? quiz.talkMs : quiz.durationMs;
    const ratio = total > 0 ? left / total : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.classList.toggle('urgent', !talking && left < 5000);
    if (left > 0) quizRaf = requestAnimationFrame(step);
  };
  step();
}

function showQuestion(q) {
  quiz = q;
  quizDeadline = Date.now() + (q.remainingMs ?? 0);
  document.getElementById('q-no').textContent = `第 ${q.index} 題`;
  // 討論時間：題目先亮給全場看，但還不能作答 —— 這是要大家轉頭商量的時間
  document.getElementById('q-state').textContent = q.phase === QUIZ_PHASE.DISCUSS
    ? '討論時間　跟旁邊的人商量一下，等一下才能作答'
    : '拿起手機，按下你的答案！';
  quizEl.classList.remove('revealed');
  document.getElementById('q-title').textContent = q.question;
  // 重建而不是只改數字：上一題揭曉時 showReveal 把整格換成「答對 N 人」，
  // #q-answered 已經不在了 —— 連續出題時下一題就會在這裡丟錯、選項停在上一題
  const foot = document.getElementById('q-foot');
  foot.replaceChildren(
    document.createTextNode('已作答 '),
    Object.assign(document.createElement('b'), { id: 'q-answered', textContent: String(q.answered ?? 0) }),
    document.createTextNode(' 人'),
  );
  foot.hidden = false;
  renderQuizOptions();
  quizEl.hidden = false;
  syncBanners();
  animateTimebar();
}

function showReveal(msg) {
  if (!quiz) return;
  cancelAnimationFrame(quizRaf);
  document.getElementById('q-state').textContent = '正解揭曉';
  quizEl.classList.add('revealed');
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
  const ol = document.getElementById('ranks-list');
  ranksCount = rows.length;
  syncRanks();
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

// ─────────────────────────────────────────────────────────────
// 文字雲（主持人提問，參與者用手機輸入）
// ─────────────────────────────────────────────────────────────
// 版面：詞依票數由大到小，從中心沿阿基米德螺旋找第一個不重疊的位置。
// 每次更新整片重排，但同一個詞沿用同一個 DOM 元素，位置與字級的變化交給
// CSS transition —— 票數變多時字慢慢放大、旁邊的詞讓開，看起來是「長出來」的。
// 新詞以 wc-pop 動畫彈出。伺服器已節流（約 300ms 一次），這裡不再節流。

const wcEl = document.getElementById('wordcloud');
const wcArea = document.getElementById('wc-area');
/** text → 元素 */
const wcNodes = new Map();
let wcWords = [];
let wcHideTimer = null;
const wcMeasure = document.createElement('canvas').getContext('2d');
// 與 UI 同一組暖色系；顏色依詞決定（同一個詞每次同色），不依名次 —— 名次一變就換色會很花
const WC_COLORS = ['#C4462A', '#1F7268', '#3A2E27', '#B07A12', '#3A6A88', '#8E4A6E', '#4F7A3A'];
const wcColor = (text) => {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) | 0;
  return WC_COLORS[Math.abs(h) % WC_COLORS.length];
};

function showWordCloud(state) {
  clearTimeout(wcHideTimer);
  wcEl.classList.remove('closed');
  for (const n of wcNodes.values()) n.remove();
  wcNodes.clear();
  wcWords = [];
  document.getElementById('wc-title').textContent = state.question;   // 主持人輸入的題目
  document.getElementById('wc-hint').textContent = '拿起手機，輸入你的答案！';
  wcEl.hidden = false;
  updateWordCloud(state);
}

function updateWordCloud(cloud) {
  if (wcEl.hidden) return;
  document.getElementById('wc-meta').textContent = `${cloud.participants ?? 0} 人作答`;
  wcWords = cloud.words ?? [];
  layoutWordCloud();
}

/** 收題：留著最終的雲 30 秒，讓主持人挑幾個詞問「誰寫了這個？」，再收起 */
function closeWordCloud(result) {
  if (wcEl.hidden) return;
  if (result?.words) wcWords = result.words.slice(0, WORDCLOUD.maxShown);
  wcEl.classList.add('closed');
  document.getElementById('wc-meta').textContent = `${result?.participants ?? 0} 人作答・已收題`;
  document.getElementById('wc-hint').textContent = result?.words?.length ? '誰寫了這個？' : '這題沒有人作答';
  layoutWordCloud();
  // 什麼時候收起由伺服器決定（主持人按「收起」或時間到，WORDCLOUD_DISMISS）。
  // 這裡只留一個很長的保險：伺服器斷線收不到通知時，結果也不會永遠蓋著房間
  clearTimeout(wcHideTimer);
  wcHideTimer = setTimeout(() => { wcEl.hidden = true; }, 5 * 60_000);
}

function layoutWordCloud() {
  const W = wcArea.clientWidth;
  const H = wcArea.clientHeight;
  if (!W || !H) return;
  const words = wcWords;
  const max = Math.max(1, ...words.map((w) => w.count));
  const min = Math.min(max, ...words.map((w) => w.count));
  // 字級：最大詞約佔區域高度的 1/4，最小 22px。以平方根壓縮差距 ——
  // 線性的話一個 10 票的詞會把其他詞擠成看不見的小字
  const top = Math.min(H * 0.24, W * 0.12, 150);
  const base = Math.max(22, Math.min(40, top * 0.32));
  const sizeOf = (count) => (max === min ? Math.min(top, base * 1.6) : base + (top - base) * Math.sqrt((count - min) / (max - min)));

  let placed = null;
  // 排不下時整體縮小再排，最多五次：寧可小一點，也不要有詞消失
  for (let shrink = 1, tries = 0; tries < 5 && !placed; tries++, shrink *= 0.84) {
    placed = placeWords(words, (c) => sizeOf(c) * shrink, W, H);
  }
  placed = placed ?? placeWords(words, (c) => sizeOf(c) * 0.4, W, H, { allowSkip: true });

  const seen = new Set();
  for (const p of placed) {
    seen.add(p.text);
    let el = wcNodes.get(p.text);
    if (!el) {
      el = document.createElement('span');
      el.className = 'wc-word';
      el.textContent = p.text;   // 參與者輸入的文字，一律 textContent
      el.style.color = wcColor(p.text);
      wcArea.append(el);
      wcNodes.set(p.text, el);
    }
    el.style.fontSize = `${p.size}px`;
    el.style.setProperty('--x', `${Math.round(p.x)}px`);
    el.style.setProperty('--y', `${Math.round(p.y)}px`);
  }
  // 被主持人隱藏或掉出前 N 名的詞：淡出後移除
  for (const [text, el] of wcNodes) {
    if (seen.has(text)) continue;
    wcNodes.delete(text);
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }
}

/**
 * 螺旋排版。回傳每個詞的左上角座標與字級；有詞排不下時回 null（呼叫端縮小重排）。
 * 詞框用 canvas measureText 量，與畫面上同一種字型。
 */
function placeWords(words, sizeFor, W, H, { allowSkip = false } = {}) {
  const font = getComputedStyle(wcArea).fontFamily || 'sans-serif';
  const boxes = [];
  const out = [];
  const pad = 6;
  for (const w of words) {
    const size = Math.round(sizeFor(w.count));
    wcMeasure.font = `800 ${size}px ${font}`;
    const bw = wcMeasure.measureText(w.text).width + pad * 2;
    const bh = size * 1.18 + pad;
    let spot = null;
    // 阿基米德螺旋：r = a·θ。橫向拉寬（ratio）讓雲是橫的橢圓，配合投影畫面的比例
    const ratio = W / H;
    for (let t = 0; t < 1200; t++) {
      const theta = t * 0.18;
      const r = 3.2 * theta;
      const cx = W / 2 + r * Math.cos(theta) * Math.max(1, ratio * 0.75);
      const cy = H / 2 + r * Math.sin(theta);
      const x = cx - bw / 2;
      const y = cy - bh / 2;
      if (x < 0 || y < 0 || x + bw > W || y + bh > H) {
        if (r > Math.max(W, H)) break;
        continue;
      }
      if (boxes.some((b) => x < b.x + b.w && x + bw > b.x && y < b.y + b.h && y + bh > b.y)) continue;
      spot = { x, y };
      break;
    }
    if (!spot) {
      if (allowSkip) continue;
      return null;
    }
    boxes.push({ x: spot.x, y: spot.y, w: bw, h: bh });
    out.push({ text: w.text, size, x: spot.x + pad, y: spot.y + pad / 2 });
  }
  return out;
}

addEventListener('resize', () => { if (!wcEl.hidden) layoutWordCloud(); });
