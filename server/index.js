/**
 * 通訊與狀態調度層 (Gateway & State Manager)
 *
 * 技術文件架構第 2 層。負責：
 *   1. 靜態資源服務（手機控制器 / 大螢幕）
 *   2. WebSocket 連線生命週期管理
 *   3. 入站訊息驗證
 *   4. 30 Hz 模擬 tick，驅動 M2 並廣播 STAGE_SYNC
 *
 * HTTP 與 WebSocket 共用同一個 port，現場只需開放一個連接埠，
 * 手機掃碼後也能直接由 location.host 推導出 WebSocket 位址，免設定。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';

import {
  EV, ACTIONS, PAIR_MISSION_IDS, STAGE, SYNC_FPS, PAIR_ERRORS, MISSION_TYPES,
  CLIENT_SYNC_MS, CLIENT_SYNC_RADIUS,
  SCORE_SOURCES, EVENT_INFO, GREET_OUTCOME,
} from '../shared/protocol.js';
import { validateAvatarConfig } from '../shared/avatars.js';
import { avatarMatchesFamily, COLOR_FAMILIES } from '../shared/colorFamily.js';
import { DEFAULT_THEME, isSelectableTheme, THEME_MAP } from '../shared/themes.js';
import {
  TICK_MS, MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, RATE_LIMIT, HOST_KEY_LENGTH, SCORING,
  PERSISTENCE, VISION_HOST, VISION_PORT, GREET, EVENTS,
  CLIENT_SYNC_MAX_BUFFERED, STAGE_SYNC_MAX_BUFFERED,
} from './config.js';
import { Stage, tokensMatch } from './state.js';
import { RateLimiter } from './ratelimit.js';
import { certificateReport } from './certcheck.js';
import { photoUrlBase, savePhoto, requestOrigin, rankLanAddresses } from './photos.js';
import { Attendance } from './attendance.js';
import { startTicker } from './scheduler.js';
import { MissionBoard } from './missions.js';
import { SocialGraph } from './socialgraph.js';
import { Encounters } from './encounters.js';
import { VIA } from '../shared/encounters.js';
import { PairingSession } from './pairing.js';
import { Greetings } from './greetings.js';
import { BingoRound, BINGO_ERRORS, STRANGER } from './bingo.js';
import { TopicTables } from './topics.js';
import { TOPIC_QUESTIONS, TOPIC_TABLES } from '../shared/topics.js';
import { PROPS, OBSTACLES, obstacleDistance } from '../shared/scene.js';
import { QuizSession } from './quiz.js';
import { TraitStore } from './traits.js';
import { WordCloudSession } from './wordcloud.js';
import { MessageRelay } from './messages.js';
import { normalizeScoring, editableScoring } from '../shared/scoring.js';
import {
  DEFAULT_PERSONA_QUIZ, PERSONA_TRAIT_KEY, PERSONA_RESULTS, validatePersonaQuiz, scorePersona, personaQuizVersion,
} from '../shared/persona.js';
import { ScoreBoard } from './scores.js';
import { SnapshotStore, Directory } from './persistence.js';
import { createHttpLayer } from './httplayer.js';
import { buildReport } from './report.js';
import { affinityFrom, arrangeCrowdByAffinity, guestSpots } from './photoLayout.js';
import { isBlockedName } from './nameFilter.js';
import {
  defaultBingoFacts, validateBingoFacts, BINGO_FACTS_ASK,
} from '../shared/bingoFacts.js';
import { EventLog, sessionName, sessionKind, generationIdOf } from './eventlog.js';
import { pairRule, traitCatalog, buildRule, feasibility, GatherTracker } from './missionRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const stage = new Stage();
const missions = new MissionBoard();
const bingo = new BingoRound();
const topics = new TopicTables({ questions: TOPIC_QUESTIONS, ...TOPIC_TABLES });
const graph = new SocialGraph();
const pairing = new PairingSession(graph);
/** 今天遇見的人（手機名單與紀念卡）。比圖譜寬：揮手、乾杯、同桌也算，見 encounters.js */
const encounters = new Encounters();
// 今天來過、有參與的人：大合照連不在場的也要放進去（server/attendance.js）
const attendance = new Attendance({ ttlMs: PERSISTENCE.directoryTtlMs });
// 揮手要尊重私訊的封鎖：封鎖了卻還能讓對方手機一直跳出「某某在跟你揮手」，封鎖就沒有意義
const greetings = new Greetings({ ...GREET, isBlocked: (by, target) => messages.isBlocked(by, target) });
const quiz = new QuizSession();
/** 參與者身上的標籤（進場人格問卷的類型；人物賓果的條件也讀它） */
const traits = new TraitStore();
/** 文字雲：主持人提問，參與者用手機輸入，大螢幕即時呈現 */
const wordcloud = new WordCloudSession();
const scores = new ScoreBoard();
/** 私訊：點手機畫面上的角色傳文字。只在記憶體，不寫快照（見 messages.js） */
const messages = new MessageRelay();

// ─────────────────────────────────────────────────────────────
// 狀態還原
//
// 場上角色的座標與速度不存也不還原 —— 它們每秒變動 30 次，
// 而且伺服器重開後角色本來就該重新入場。還原的是重來一次會心痛的東西：
// 積分、社交圖譜、任務與問答紀錄，以及讓參與者認領回自己角色的身分目錄。
// ─────────────────────────────────────────────────────────────
// 啟動當下的 commit。scripts/doctor.py 拿它和硬碟上的比：對不上就是 git pull 後沒重開
const BUILD_COMMIT = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); }
  catch { return 'unknown'; }
})();

// 大合照存在這裡，Gateway 以 /photos/<id>.png 送給掃 QR 的手機（server/photos.js）
const PHOTOS_DIR = path.join(ROOT, 'data', 'photos');

const store = new SnapshotStore(
  path.isAbsolute(PERSISTENCE.file) ? PERSISTENCE.file : path.join(ROOT, PERSISTENCE.file),
  { enabled: PERSISTENCE.enabled },
);
const directory = new Directory({
  limit: PERSISTENCE.directoryLimit,
  ttlMs: PERSISTENCE.directoryTtlMs,
});

const snapshot = store.load();
if (snapshot) {
  scores.hydrate(snapshot.scores);
  graph.hydrate(snapshot.graph);
  if (Array.isArray(snapshot.encounters)) encounters.hydrate(snapshot.encounters);
  else encounters.seedFromGraph(snapshot.graph);
  missions.hydrate(snapshot.missions);
  quiz.hydrate(snapshot.quiz);
  // 標籤原本存在轉場問卷的快照裡（snapshot.survey.traits），舊存檔照樣讀得回來
  traits.hydrate(snapshot.traits ?? snapshot.survey?.traits);
  wordcloud.hydrate(snapshot.wordcloud);
  directory.hydrate(snapshot.directory);
  attendance.hydrate(snapshot.attendance);
}

/**
 * 配分。預設值在 config.js；主持人在主辦端「節目單」頁改過的話落地進快照。
 * 直接改 SCORING 物件本身：計分的地方（這個檔案、quiz.js）都讀同一個物件，改一處就全部生效。
 */
const SCORING_DEFAULTS = Object.freeze(editableScoring(SCORING));
/**
 * 2026-10-19 以前的預設。那時快照不分有沒有改過，一律把整份配分存進去 ——
 * 存檔裡剛好等於舊預設，代表主持人從沒動過，這次改了預設就該跟著用新的，
 * 不能把舊預設當成「主持人自訂」沿用下去。
 */
const LEGACY_SCORING_DEFAULTS = {
  quizCorrect: 100, quizSpeedBonus: 100, pairCompletion: 20, missionFinish: 50, bingoCell: 5, bingoLine: 20, bingoFull: 40,
};
const isLegacyDefault = (s) => Object.keys(LEGACY_SCORING_DEFAULTS).every((k) => s?.[k] === LEGACY_SCORING_DEFAULTS[k])
  && Object.keys(s).every((k) => k in LEGACY_SCORING_DEFAULTS);
{
  const raw = snapshot?.scoring;
  const saved = raw && !isLegacyDefault(raw) ? normalizeScoring(raw, SCORING_DEFAULTS) : null;
  if (saved?.ok) Object.assign(SCORING, saved.value);
}
const scoringView = () => {
  const scoring = editableScoring(SCORING);
  return { scoring, isDefault: Object.keys(scoring).every((k) => scoring[k] === SCORING_DEFAULTS[k]) };
};

/**
 * 大螢幕目前的場景主題。落地進快照：伺服器在活動中途重開時，
 * 投影畫面不能自己跳回預設主題，主辦端也不會記得要再選一次。
 */
// 快照裡若是已停用的場景（例如 3D 客廳），重開後退回預設，不再沿用
let stageTheme = isSelectableTheme(snapshot?.theme) ? snapshot.theme : DEFAULT_THEME;

/**
 * 活動名稱，取代大螢幕左上角的場景名。null 代表還沒設定 ——
 * 主辦端此時只看得到「活動設定」那一頁，要先選場景、命名才進得了活動編排。
 * 落地進快照：活動中途重開伺服器時，不能把主辦端趕回設定頁、大螢幕也不能跳回場景名。
 */
let eventInfo = parseEventInfo(snapshot?.event);

/**
 * 大螢幕的持續性設定。原本投影畫面右上角的按鈕已收進主辦端 ——
 * 投影畫面上的按鈕現場沒人點得到，而且會被投出去。
 * 光線與重置視角已拿掉（光線現場用不到；重置視角只對已停用的 3D 客廳有意義），
 * 剩下的除錯視圖不落地：那是臨時檢查用的，重開後不該還開著。
 * 「清除效果」也拿掉了（2026-10-17）：大螢幕上的物件不再能點，走近時的小動畫幾秒後自己消失。
 * ranks：右下角的積分排行要不要顯示（主持人不想讓全場比分數時可以關）。
 */
const screenSettings = { debug: false, sound: true, ranks: true };

/**
 * 進場人格問卷的題目。主持人可在主辦端修改，落地進快照 ——
 * 活動中途重開伺服器，不能悄悄換回預設題目（已經答過的人與之後答的人會是兩套標準）。
 * 快照裡的題目一樣要驗：檔案可能被手動改過。
 */
let personaQuiz = (snapshot?.personaQuiz && validatePersonaQuiz(snapshot.personaQuiz).ok)
  ? validatePersonaQuiz(snapshot.personaQuiz).value
  : DEFAULT_PERSONA_QUIZ;
/**
 * 賓果的自我介紹題。null 代表用目前場景的預設題（換場景會跟著換）。
 * 落地進快照，理由同進場問卷：活動中途重開，主持人改過的題目不能悄悄變回預設。
 */
let bingoFactsCustom = (() => {
  const v = snapshot?.bingoFacts;
  if (!Array.isArray(v)) return null;
  const r = validateBingoFacts(v, isBlockedName);
  return r.ok ? r.value : null;
})();
const bingoFactsView = () => ({
  facts: bingoFactsCustom ?? defaultBingoFacts(stageTheme),
  isDefault: bingoFactsCustom === null,
});

const personaView = () => ({
  quiz: personaQuiz,
  version: personaQuizVersion(personaQuiz),
  isDefault: personaQuiz === DEFAULT_PERSONA_QUIZ,
});

// 逐筆事件紀錄（見 eventlog.js）。session_start 寫在 listen 成功之後，
// 綁不上 port 的那次啟動不該在紀錄裡多出一個空場次。
const SESSION = sessionName(EVENTS.session);
const events = new EventLog({
  dir: path.isAbsolute(EVENTS.dir) ? EVENTS.dir : path.join(ROOT, EVENTS.dir),
  session: SESSION,
  enabled: EVENTS.enabled,
});
/** agentId → 上次記下的仲裁模式。只在模式改變時記一筆，不是每幀 */
const loggedMode = new Map();

/** 手機自報的入場路徑白名單。CV 角色一律是 photo，不採信手機 */
const ENTRY_ROUTES = new Set(['builder', 'scan_fallback']);

/** 快照內容。集中在一處，新增要落地的東西時只改這裡與還原段。 */
const snapshotData = () => ({
  version: 1,
  savedAt: Date.now(),
  hostKey: HOST_KEY,
  scores: scores.export(),
  graph: graph.export(),
  encounters: encounters.export(),
  missions: missions.export(),
  quiz: quiz.export(),
  traits: traits.export(),
  wordcloud: wordcloud.export(),
  directory: directory.export(),
  attendance: attendance.export(),
  theme: stageTheme,
  event: eventInfo,
  // 預設題目不存：之後改版預設題目時，沒改過的活動才會跟著用新版
  personaQuiz: personaQuiz === DEFAULT_PERSONA_QUIZ ? null : personaQuiz,
  bingoFacts: bingoFactsCustom,
  // 只存主持人改過的配分：沒改過就存 null，之後調整預設值時，沒改過的活動才會跟著用新的
  scoring: scoringView().isDefault ? null : editableScoring(SCORING),
});

/** 狀態有變動，等下一次自動存檔 */
const markDirty = () => store.touch();

/**
 * 主辦端通行密鑰。
 *
 * 控制台不能只靠「網址沒人知道」來保護：現場所有人連在同一個區網，
 * 路徑可被掃出，而控制台握有踢人與結算全場的能力。
 * 避開易混淆字元（0/O、1/I），因為主辦者要從終端機讀出來手動輸入。
 *
 * 取用順序：環境變數 → 快照裡的舊密鑰 → 重新產生。
 * 中間那一步是關鍵：伺服器重開後密鑰若跟著換，主辦端就得在活動進行中
 * 重新讀一組新號碼再登入一次，而那通常正好是最忙亂的時刻。
 */
function resolveHostKey() {
  const fromEnv = process.env.PIXELAIR_HOST_KEY?.trim().toUpperCase();
  if (fromEnv) {
    if (fromEnv.length === HOST_KEY_LENGTH) return fromEnv;
    console.warn(`[host] 環境變數指定的密鑰長度不是 ${HOST_KEY_LENGTH} 碼，已忽略`);
  }
  const fromSnapshot = snapshot?.hostKey;
  if (typeof fromSnapshot === 'string' && fromSnapshot.length === HOST_KEY_LENGTH) {
    return fromSnapshot;
  }
  return Array.from(randomBytes(HOST_KEY_LENGTH))
    .map((b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31])
    .join('');
}

const HOST_KEY = resolveHostKey();
const HOST_KEY_SOURCE = process.env.PIXELAIR_HOST_KEY ? '環境變數'
  : (snapshot?.hostKey === HOST_KEY ? '沿用上次啟動' : '本次啟動產生');

function keyMatches(input) {
  if (typeof input !== 'string') return false;
  const a = Buffer.from(input.toUpperCase(), 'utf8');
  const b = Buffer.from(HOST_KEY, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────
// TLS
//
// 手機瀏覽器的 getUserMedia 要求安全情境（HTTPS 或 localhost）。
// 場館用 http://192.168.x.x 時相機會被瀏覽器直接拒絕，掃描進場等於不存在
// —— 這是瀏覽器的硬規則，不是可以繞過的設定。
//
// 提供 TLS_CERT / TLS_KEY 就以 HTTPS 啟動，未提供則維持 HTTP（本機開發用）。
// 憑證產生見 scripts/make-cert.sh。
// ─────────────────────────────────────────────────────────────
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

function readTLSOptions() {
  if (!TLS_CERT || !TLS_KEY) return null;
  try {
    return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
  } catch (err) {
    // 現場最怕的是「以為開了 HTTPS，其實悄悄退回 HTTP」——
    // 那會等到有人要拍照才發現。這裡直接讓啟動失敗。
    console.error(`\n  ✗ 讀不到 TLS 憑證：${err.message}`);
    console.error('    請確認 TLS_CERT 與 TLS_KEY 指向正確的檔案，或不要設定這兩個變數以 HTTP 啟動。\n');
    process.exit(1);
  }
}

const tlsOptions = readTLSOptions();
const SCHEME = tlsOptions ? 'https' : 'http';

/**
 * 憑證健檢：SAN 是否涵蓋當下的 LAN IP，以及是否過期。
 *
 * 為什麼需要：憑證是按「產生當下的 IP」簽發的，而區網 IP 多半由 DHCP 配發，
 * 筆電重連 Wi-Fi 或隔天再來就可能換號。憑證一旦與實際位址不符，
 * 手機上會多跳一個「網域不符」的錯誤 —— 而現場只會看到「掃不進來」，
 * 完全看不出跟 IP 有關。這種故障必須在啟動時就講清楚，不能等到現場。
 *
 * 只警告、不阻擋啟動：憑證不符仍然可以用（使用者點過警告即可），
 * 而展演進行到一半時，「能跑但有警告」永遠優於「直接不給啟動」。
 *
 * @returns {{expired: boolean, daysLeft: number, missing: string[]}|null}
 */
function inspectCertificate(addrs) {
  if (!tlsOptions) return null;
  try {
    const cert = new X509Certificate(tlsOptions.cert);
    return certificateReport(cert.subjectAltName, cert.validTo, addrs);
  } catch {
    // 憑證讀得到但解析不了：不是啟動的阻礙，交由 TLS 層自己去報錯
    return null;
  }
}


// 大螢幕交回的截圖暫存區：requestId → { resolve, timer }
// 只在一次合照流程中短暫存在，用完即刪。
// 定義在這裡而不是跟 requestScreenCapture 放一起，是因為下面的 createHttpLayer
// 在模組載入當下就要拿到 resolveScreenCapture —— const 沒有提升，
// 放到檔案後段會在啟動時就 ReferenceError。
const pendingCaptures = new Map();

/**
 * 收下大螢幕 POST 回來的合照底圖。
 * @returns {boolean} requestId 是否認得（認不得代表這不是我們要的那張）
 */
function resolveScreenCapture(requestId, image) {
  const pending = pendingCaptures.get(requestId);
  if (!pending) return false;
  pendingCaptures.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(image);
  return true;
}

const { handleRequest } = createHttpLayer({
  root: ROOT,
  publicDir: PUBLIC_DIR,
  keyMatches,
  onScreenCapture: resolveScreenCapture,
  getPersonaQuiz: () => personaView(),
  photosDir: PHOTOS_DIR,
  buildCommit: BUILD_COMMIT,
});

const server = tlsOptions
  ? https.createServer(tlsOptions, handleRequest)
  : http.createServer(handleRequest);

// ─────────────────────────────────────────────────────────────
// WebSocket 連線與訊息處理
// ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

/** @type {Set<import('ws').WebSocket>} 已註冊的大螢幕連線 */
const screens = new Set();
/** 能拿來截圖的大螢幕：連線中、且不是主控台的預覽小窗（見 SCREEN_HELLO） */
const isCaptureScreen = (ws) => ws.readyState === ws.OPEN && !ws.preview;
/** @type {Set<import('ws').WebSocket>} 已通過認證的主辦端連線 */
const hosts = new Set();
/** @type {Map<string, import('ws').WebSocket>} agentId → 該參與者的連線，用於定向推送 */
const controllers = new Map();
/**
 * 候補名單：人滿時進場的連線，依先後排隊（ws.role === 'audience'，ws.pendingJoin 是原本的 CLIENT_JOIN）。
 *
 * 原本人滿就回「現場人數已滿，請稍候再試」—— 被擋的人只能自己猜什麼時候再試，
 * 而離場的人還會佔名額 45 秒（AGENT_TTL）。最容易直接走掉的就是這些人。
 * 現在排進名單，主迴圈一看到空位就替排第一的人完成進場，手機不必再操作。
 * @type {import('ws').WebSocket[]}
 */
const audienceQueue = [];

const send = (ws, type, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
};

/** 對指定參與者推送（如配對碼、確認請求） */
function sendToAgent(agentId, type, payload) {
  const ws = controllers.get(agentId);
  if (ws) send(ws, type, payload);
}

/** 對一組連線廣播同一份已序列化的訊息 */
/**
 * 送出手機端名冊給單一連線。
 *
 * 進場與重連都必須送 —— 主迴圈那份是「內容變了才廣播」，
 * 而新連上的手機碰到的常常正是「名冊沒變」的情況（例如重整分頁、
 * 或斷線後在 AGENT_TTL 內接回原角色）。少了這裡，那支手機的
 * renderer.names 會一直是空的，鄰居全部沒有名字直到有人進出為止。
 */
function sendClientRoster(ws) {
  send(ws, EV.CLIENT_ROSTER, { agents: stage.nameRoster() });
  // 場景主題與名冊同一時機補送：進場與重連都走這裡，
  // 手機的個人視角才知道要畫廚房還是辦公室
  send(ws, EV.STAGE_THEME, { theme: stageTheme });
}

function blast(targets, type, payload) {
  const raw = JSON.stringify({ type, ...payload });
  for (const ws of targets) if (ws.readyState === ws.OPEN) ws.send(raw);
}

/** 推送給所有人：參與者、大螢幕、主辦端 */
function blastAll(type, payload) {
  blast(controllers.values(), type, payload);
  blast(screens, type, payload);
  blast(hosts, type, payload);
}

/** 角色是否仍在場。排行榜據此排除已離場者（分數仍留在帳本裡供匯出） */
const isPresent = (id) => stage.agents.has(id);
const nameOf = (id) => stage.get(id)?.name ?? '';

/** 主辦端的現況面板資料 */
/**
 * 大合照的下載 QR（照片上不放，改在大螢幕右下角）。拍完自動顯示，之後由主持人
 * 在主控端切換顯示／隱藏（2026-10-19）。宣告在 hostState 之前：它會被讀到。
 * @type {{id: string, qr: string, url: string, visible: boolean}|null}
 */
let photoQr = null;
const photoQrPayload = () => (photoQr ? { qr: photoQr.qr, url: photoQr.url, visible: photoQr.visible } : null);

/**
 * 文字雲收題後，結果還留在大螢幕上嗎。主持人可以按「收起」；沒按的話一陣子後自動收起，
 * 開始問答、賓果時也會先收起（滿版的結果不能蓋住下一個活動）。
 */
let wordcloudResultShown = false;
let wordcloudResultTimer = null;
const WORDCLOUD_RESULT_MS = 60_000;

function hostState() {
  return {
    agents: [...stage.agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      // 主辦端要能認出「這一列是誰」—— 名字是自填的，現場常常重複或看不懂，
      // 頭像才是參與者在大螢幕上實際的樣子。CV 角色只帶 URL，捏臉只帶 token，
      // 兩者都很小，不會讓這份狀態訊息膨脹。
      avatar: a.avatar,
      offline: a.offline,
      progress: missions.progressMap(a.id),
      connections: graph.degree(a.id),
      activeMs: Math.round(a.activeMs),
      score: scores.totalOf(a.id),
      // 標籤（進場人格問卷的類型）：主辦端名冊與分組都看它
      traits: traits.traitsOf(a.id),
    })),
    missions: missions.states(stage.agents.size),
    graphEdges: graph.size,
    audience: audienceQueue.length,
    topics: topics.enabled,
    quiz: quiz.publicView(),
    wordcloud: wordcloud.publicView(),
    quizReveal: quiz.revealView(),
    leaderboard: scores.leaderboard(SCORING.leaderboardSize, nameOf, isPresent),
    personaSpread: personaSpread(),
    // 主控端重新整理後也要能切換：帶 QR 圖
    photoQr: photoQr ? { visible: photoQr.visible, qr: photoQr.qr } : null,
    wordcloudResultShown,
  };
}

/** 在場者的人格類型分佈（含還沒答的人數），依 PERSONA_RESULTS 的順序 */
function personaSpread() {
  const counts = traits.spread(PERSONA_TRAIT_KEY, isPresent);
  const answered = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    counts: PERSONA_RESULTS.map((t) => ({ id: t.id, count: counts.get(t.id) ?? 0 })),
    unanswered: Math.max(0, stage.agents.size - answered),
  };
}

/**
 * 依進場時帶來的作答，記下這個人的類型。
 * 作答必須是針對「現在這份題目」—— 主持人在他答題期間改了題目的話，
 * 舊答案對應不到新題目，與其判錯不如不判（主辦端會看到「未作答」）。
 */
function applyPersona(agentId, raw) {
  if (!raw || raw.version !== personaQuizVersion(personaQuiz)) return;
  const result = scorePersona(personaQuiz, raw.answers);
  if (!result) return;
  traits.setTrait(agentId, PERSONA_TRAIT_KEY, { value: result.id, label: `${result.emoji} ${result.name}`, at: Date.now() });
  events.log('persona', { agent: agentId, type: result.id });
  markDirty();
}

const pushHostState = () => blast(hosts, EV.HOST_STATE, hostState());

/**
 * 結算某個任務。主辦端按「結算」與限時到點走同一條路，
 * 三端收到的 MISSION_CLOSED 才會一模一樣。
 * @param {'host'|'time'} by 誰收掉的；時間到時主辦端要在動態裡看得出來
 * @param {string} id 要結算的任務（可以同時有好幾個）
 */
function closeMission(by, id) {
  const closed = missions.close(id);
  if (!closed) return;
  events.log('mission_close', {
    mission: closed.id, by, completions: closed.events.length, present: stage.agents.size,
  });
  console.log(`[mission] 結算「${closed.title}」${by === 'time' ? '（時間到）' : ''}`);
  markDirty();
  blastAll(EV.MISSION_CLOSED, {
    id: closed.id,
    title: closed.title,
    totalCompletions: closed.events.length,
    graphEdges: graph.size,
    by,
  });
  pushHostState();
}

/**
 * 積分帳本的單一寫入點。
 *
 * 所有得分來源（配對、任務達標、問答）都走這裡，好處有兩個：
 * 個人端的 SCORE_SELF 不會漏送，而排行榜的重算與廣播只需標記一次髒旗標。
 */
let scoresDirty = false;

function award(agentId, points, meta) {
  if (points <= 0) return null;
  const { total, delta } = scores.award(agentId, points, meta);
  scoresDirty = true;
  markDirty();
  sendToAgent(agentId, EV.SCORE_SELF, {
    score: total,
    delta,
    source: meta.source,
    rank: scores.rankOf(agentId, isPresent),
  });
  return total;
}

/** 排行榜有變動時才重算並廣播，節流由主迴圈負責（scoresDirty 為髒旗標） */
function broadcastScoreBoard() {
  blast([...screens, ...hosts], EV.SCORE_BOARD, {
    leaderboard: scores.leaderboard(SCORING.leaderboardSize, nameOf, isPresent),
    players: stage.agents.size,
  });
}

/** 任務進度變動時，同步通知全場 */
function broadcastMissionState() {
  for (const state of missions.states(stage.agents.size)) blastAll(EV.MISSION_STATE, { mission: state });
  pushHostState();
}

/**
 * 問答、文字雲、人物賓果一次只能開一個（2026-10-17）：三個都要大家看大螢幕或手機作答，
 * 疊在一起時參與者不知道該答哪一個。任務不在此限，可以跟它們同時進行、也可以同時開好幾個。
 * @param {'quiz'|'wordcloud'|'bingo'} starting 要開始的那一個（同一種的上一輪由各自的流程處理）
 * @returns {string|null} 擋下時給主辦端看的原因
 */
function busyActivity(starting) {
  const running = [
    ['quiz', '即時問答', quiz.isActive],
    ['wordcloud', '文字雲', wordcloud.isActive],
    ['bingo', '人物賓果', bingo.isActive],
  ].find(([kind, , on]) => on && kind !== starting);
  return running ? `「${running[1]}」還在進行中，一次只能進行一個活動（任務除外），請先結束它` : null;
}

/** 剝除控制字元並去頭尾空白。名稱會上大螢幕，控制字元會破壞排版 */
function stripControl(raw) {
  if (typeof raw !== 'string') return '';
  // 逐字元過濾，避免在原始碼中嵌入字面控制字元
  return [...raw]
    .filter((ch) => { const c = ch.codePointAt(0); return c > 0x1f && c !== 0x7f; })
    .join('')
    .trim();
}

// 名稱會投影在大螢幕上。不說是哪個字被擋 —— 說了等於教人怎麼繞過去
const NAME_BLOCKED_REASON = '這個名稱不能使用，請換一個';

/** 顯示名稱驗證：長度限制並剝除控制字元，避免大螢幕排版被破壞 */
function sanitizeName(raw) {
  const name = stripControl(raw);
  if (name.length === 0) return null;
  return name.slice(0, MAX_NAME_LENGTH);
}

/**
 * 活動名稱驗證。超長一律拒絕而不是截斷 —— 主辦端 UI 已經設了 maxlength，
 * 會送來超長的只有繞過 UI 的客戶端；默默截掉會讓大螢幕出現半個字的標題。
 * @returns {{name: string, subtitle: string}|null}
 */
function parseEventInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = stripControl(raw.name);
  const subtitle = stripControl(raw.subtitle ?? '');
  if (!name || [...name].length > EVENT_INFO.maxNameLength) return null;
  if ([...subtitle].length > EVENT_INFO.maxSubtitleLength) return null;
  return { name, subtitle };
}

/** 取有限數值，非數值一律歸零，防止 NaN 汙染整個物理模擬 */
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * 補送進行中的尋寶給單一連線（中途進場與斷線重連都要）。
 *
 * ⚠ 送的是 publicView（不含座標）—— 補送給手機的東西一樣不能夾帶答案。
 */
/**
 * 補送進行中的文字雲給單一連線（手機）。
 *
 * 中途進場與斷線重連走的是不同分支（重連那段會提前 return），兩邊都要呼叫 ——
 * 少了任一邊，那支手機在整題結束前都不會知道現在有一題可以答。
 * 已經送過答案的人要看到自己送過什麼，而不是一個可以重送的空白題。
 */
function sendWordCloudCatchUp(ws, agentId) {
  if (!wordcloud.isActive) return;
  send(ws, EV.WORDCLOUD_QUESTION, { cloud: wordcloud.publicView() });
  const mine = wordcloud.mineOf(agentId);
  if (mine.length) send(ws, EV.WORDCLOUD_ACK, { ok: true, mine });
}

// ─────────────────────────────────────────────────────────────
// 人物賓果（server/bingo.js）
// ─────────────────────────────────────────────────────────────
/**
 * 候選條件：全部取自系統本來就有的資料。id 帶前綴，判定時據此分流。
 * 場上沒有任何人符合的條件由 BingoRound 自己濾掉。
 */
function bingoPool() {
  const pool = COLOR_FAMILIES.map((f) => ({ id: `color:${f.id}`, label: `衣服有${f.label}的人` }));
  for (const t of PERSONA_RESULTS) {
    pool.push({ id: `persona:${t.id}`, label: `進場問卷是${t.emoji}${t.name}的人` });
  }
  // 轉場問卷已移除，標籤條件只剩進場人格問卷的類型
  return pool;
}

/** 某人是否符合某條件。from 是填卡的人（「還不認識的人」要看兩人之間有沒有連線） */
function bingoTest(who, condId, from) {
  if (condId === STRANGER) return who !== from && !graph.connected(from, who);
  const agent = stage.get(who);
  if (!agent) return false;
  const [kind, a] = condId.split(':');
  if (kind === 'color') return avatarMatchesFamily(agent.avatar, a);
  if (kind === 'persona') return traits.traitOf(who, PERSONA_TRAIT_KEY)?.value === a;
  if (kind === 'fact') return bingo.hasFact(who, a);
  return false;
}

/** 手機看到的卡：填了的格子顯示那個人的名字（不給 id —— 手機不需要） */
/** 某人開局勾的自我介紹題（題目文字）。沒答過回 null，勾了零題回 [] */
function bingoFactsOf(agentId) {
  const r = bingo.round;
  if (!r?.facts.length || !bingo.hasAnswered(agentId)) return null;
  return r.facts.filter((f) => bingo.hasFact(agentId, f.id)).map((f) => f.text);
}

function sendBingoCard(agentId) {
  const card = bingo.cardOf(agentId);
  if (!card) return;
  const r = bingo.round;
  sendToAgent(agentId, EV.BINGO_CARD, {
    card: {
      cells: card.cells.map((c) => ({ label: c.cond.label, filled: !!c.by, name: c.by ? nameOf(c.by) : null })),
      lines: card.lines,
    },
    // 自己開局勾了什麼（2026-10-17 試玩回饋）：別人是照這個來找你的，勾完就忘的話會被問倒
    myFacts: bingoFactsOf(agentId),
    remainingMs: r.endsAt ? Math.max(0, r.endsAt - Date.now()) : null,
  });
}

/** 大螢幕與主辦端：進度前幾名。不送卡片內容 —— 卡是私人的 */
function bingoPublicView() {
  const r = bingo.round;
  if (!r) return null;
  const asking = r.phase === 'ask';
  // ask 階段：還在勾自我介紹題，主辦端與大螢幕顯示「x / y 人答完」。
  // y 只算連著線的人 —— 伺服器也只等他們（bingoAskers），斷線還留在場上的人算進去會一直湊不滿
  const askers = asking ? bingoAskers() : [];
  return {
    phase: r.phase,
    answered: asking ? askers.filter((id) => bingo.hasAnswered(id)).length : null,
    askRemainingMs: asking && r.askEndsAt !== null ? Math.max(0, r.askEndsAt - Date.now()) : null,
    remainingMs: r.endsAt ? Math.max(0, r.endsAt - Date.now()) : null,
    players: asking ? askers.length : r.cards.size,
    top: bingo.standings().slice(0, 5).map((s) => ({ name: nameOf(s.id), lines: s.lines, filled: s.filled })),
  };
}

/**
 * 主辦端多看一份：每個人勾了哪幾題自我介紹。大螢幕不送 —— 那是全場看得到的畫面。
 * 主持人要能在有人說「我不記得我勾了什麼」「他說他是、可是填不進去」時當場查。
 */
function bingoHostView() {
  const view = bingoPublicView();
  if (!view) return null;
  const r = bingo.round;
  const ids = r.phase === 'ask' ? bingoAskers() : [...r.cards.keys()];
  return {
    ...view,
    picks: r.facts.length
      ? ids.filter((id) => stage.get(id)).map((id) => ({ name: nameOf(id), facts: bingoFactsOf(id) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      : null,
  };
}

const pushBingoState = () => {
  blast(screens, EV.BINGO_STATE, { round: bingoPublicView() });
  blast(hosts, EV.BINGO_STATE, { round: bingoHostView() });
};

function startBingo(ws, msg) {
  const busy = busyActivity('bingo');
  if (busy) { send(ws, EV.HOST_REJECT, { reason: busy }); return; }
  dismissWordCloudResult();
  const ids = bingoPresent();
  const durationMs = Number(msg.durationMs) > 0 ? Math.min(Number(msg.durationMs), 30 * 60 * 1000) : null;
  const bank = bingoFactsView().facts;
  const facts = [...bank].sort(() => Math.random() - 0.5).slice(0, BINGO_FACTS_ASK);
  // 自我介紹不限時（2026-10-19）：在線的人都答完才發卡，有人一直不答就由主持人按「直接發卡」
  const result = bingo.start(ids, bingoPool(), bingoTest, { durationMs, facts, askMs: null, present: bingoPresent });
  if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
  if (bingo.phase === 'ask') {
    for (const id of ids) sendToAgent(id, EV.BINGO_ASK, bingoAsk());
  } else {
    for (const id of ids) sendBingoCard(id);
  }
  events.log('bingo_start', { players: ids.length, durationMs: durationMs ?? undefined });
  pushBingoState();
  console.log(`[bingo] 開始　${ids.length} 人${durationMs ? `　限時 ${durationMs / 60000} 分鐘` : ''}`);
}

function endBingo(by = 'host') {
  if (!bingo.isActive) return;
  const top = bingo.standings();
  bingo.end();
  // 公布：連最多線的人（同分並列）。沒人連成線就公布填最多格的；
  // 一格都沒人填就沒有贏家 —— 否則全場 0 格同分，每個人都會被唸成贏家
  const best = top[0];
  const winners = !best || (best.lines === 0 && best.filled === 0) ? [] : top
    .filter((s) => s.lines === best.lines && (best.lines > 0 || s.filled === best.filled))
    .map((s) => nameOf(s.id)).filter(Boolean);
  blastAll(EV.BINGO_ENDED, { winners, by });
  events.log('bingo_end', {
    by, winners: winners.length,
    lines: top.map((t) => t.lines), filled: top.map((t) => t.filled),
  });
  pushBingoState();
  console.log(`[bingo] 結束${by === 'time' ? '（時間到）' : ''}　${winners.join('、') || '無人得分'}`);
}

function handleBingoClaim(ws, msg) {
  const from = ws.agentId;
  const reply = (payload) => send(ws, EV.BINGO_RESULT, payload);
  if (!bingo.isActive) { reply({ ok: false, reason: BINGO_ERRORS.NO_ROUND }); return; }
  // 防枚舉：每一次嘗試都記配對的冷卻，不論成功失敗。
  // 否則 MISMATCH ↔ NOT_FOUND 的差異可以拿來窮舉出場上每個人的碼
  // （見 INTERACTION-DESIGN「顏色預檢不可成為枚舉管道」）
  const now = Date.now();
  if (pairing.inCooldown(from, now)) { reply({ ok: false, reason: BINGO_ERRORS.COOLDOWN }); return; }
  pairing.noteClaim(from, now);
  const target = pairing.peekTarget(msg.code, now);
  if (!target) {
    events.log('bingo_claim', { agent: from, ok: false, reason: BINGO_ERRORS.NOT_FOUND });
    reply({ ok: false, reason: BINGO_ERRORS.NOT_FOUND });
    return;
  }

  const r = bingo.claim(from, msg.cell, target);
  events.log('bingo_claim', {
    agent: from, peer: target, cell: msg.cell, ok: r.ok,
    reason: r.ok ? undefined : r.reason,
    newLines: r.ok ? r.newLines : undefined, full: r.ok ? r.full : undefined,
  });
  if (!r.ok) { reply({ ok: false, reason: r.reason }); return; }
  bingoFilled(from, target, r, reply);
  // 被填進去的人也要知道：「剛剛那個人原來是在玩賓果」—— 這通常就是下一段對話的開頭。
  // 剛來找他的人若也符合他卡上空著的一格，順便問他要不要填（不必再輸碼：才剛當面拿過）
  const cell = bingo.cardOf(from).cells[r.cell];
  const offer = bingo.offerFor(target, from);
  sendToAgent(target, EV.BINGO_TAGGED, {
    byName: nameOf(from), label: cell.cond.label, offer: offer ? { label: offer.label } : null,
  });
}

/** 收下「順便填」的邀請 */
function handleBingoAccept(ws) {
  const me = ws.agentId;
  const reply = (payload) => send(ws, EV.BINGO_RESULT, payload);
  if (!bingo.isActive) { reply({ ok: false, reason: BINGO_ERRORS.NO_ROUND }); return; }
  const r = bingo.acceptOffer(me);
  if (!r.ok) { reply({ ok: false, reason: r.reason }); return; }
  bingoFilled(me, r.from, r, reply);
  // 只通知、不再反過來邀請：對方剛剛才填過我，再邀一次就是無止境的來回
  const cell = bingo.cardOf(me).cells[r.cell];
  sendToAgent(r.from, EV.BINGO_TAGGED, { byName: nameOf(me), label: cell.cond.label, offer: null });
}

/** 填格成功：計分、回覆、更新卡片與排行、記進「今天遇見的人」 */
function bingoFilled(from, target, r, reply) {
  const points = SCORING.bingoCell + r.newLines * SCORING.bingoLine + (r.full ? SCORING.bingoFull : 0);
  award(from, points, { source: SCORE_SOURCES.BINGO });
  reply({ ok: true, name: nameOf(target), newLines: r.newLines, full: r.full });
  sendBingoCard(from);
  // 只記在填格的這一方（理由見 encounters.js）。對方收下「順便填」時，他那邊也會記一筆
  if (encounters.noteOneWay(from, target, VIA.BINGO)) sendSocialSelf(from);
  pushBingoState();
  markDirty();
}

/** 勾選自我介紹題 */
function handleBingoFacts(ws, msg) {
  const me = ws.agentId;
  if (!bingo.isActive || !bingo.answerFacts(me, msg.yes)) return;
  if (bingo.phase === 'play') {
    // 發卡之後才答（例如重連）：照常補一張卡
    sendBingoCatchUp(me);
  } else {
    pushBingoState();
    if (bingo.readyToPlay(bingoAskers())) startBingoPlay();
  }
}

/** ask 階段要等誰：連著線的人。斷線但還留在場上的人等不到，不等他（重連時再補卡） */
const bingoAskers = () => [...controllers.keys()].filter((id) => stage.agents.has(id));

/** 自我介紹收齊（或時間到）：發卡、開始計時 */
/**
 * 賓果算「在場」的人：連著線的角色。斷線、轉入漫遊的角色還留在場上，但人不在現場 ——
 * 拿他們來判斷「場上有人符合」，就會出現怎麼找都找不到人的格子（2026-10-19 試玩）。
 * 他們重連時照樣補一張卡（sendBingoCatchUp）。
 */
const bingoPresent = () => [...stage.agents.values()].filter((a) => !a.offline).map((a) => a.id);

function startBingoPlay() {
  bingo.beginPlay(bingoPresent());
  for (const id of bingo.round.cards.keys()) sendBingoCard(id);
  pushBingoState();
  console.log(`[bingo] 發卡　${bingo.round.cards.size} 人`);
}

/** 這一輪要問的題目：從題庫隨機挑幾題，所有人問同一組，才找得到彼此 */
function bingoAsk() {
  const r = bingo.round;
  return { facts: r.facts, remainingMs: r.askEndsAt === null ? null : Math.max(0, r.askEndsAt - Date.now()) };
}

/**
 * 中途進場、重連：
 * - 還在問自我介紹：沒答過的人補問
 * - 已經發卡：補一張卡（已經有就重送）。發卡後才進場的人不再問，直接拿卡
 */
function sendBingoCatchUp(agentId) {
  if (!bingo.isActive || !agentId) return;
  if (bingo.phase === 'ask') {
    if (!bingo.hasAnswered(agentId)) sendToAgent(agentId, EV.BINGO_ASK, bingoAsk());
    return;
  }
  bingo.dealCard(agentId, bingoPresent());
  sendBingoCard(agentId);
}

// ─────────────────────────────────────────────────────────────
// 話題桌（server/topics.js）
// ─────────────────────────────────────────────────────────────
/** 目前主題的號碼牌桌（shared/themes.js 的 spots）。換主題時桌子跟著換 */
function topicSpots() {
  const spots = THEME_MAP[stageTheme]?.spots ?? {};
  return PROPS.filter((p) => spots[p.id]).map((p) => ({ id: p.id, x: p.x, y: p.y, r: p.r, label: spots[p.id] }));
}

/**
 * 主辦端在帶活動時，桌邊不該突然跳出聊天題搶注意力 —— 問答、文字雲進行中一律暫停。
 * 任務（配對）與賓果不暫停：坐下來聊正是它們要的。
 */
function topicsPaused() {
  return quiz.isActive || wordcloud.isActive;
}

let lastTopicCheck = 0;
function stepTopics(now) {
  if (now - lastTopicCheck < 500) return;   // 半秒看一次就夠：停留門檻是 2 秒
  lastTopicCheck = now;
  if (topicsPaused()) return;
  // 只有標了 topicTables 的場景有話題桌（shared/themes.js）
  if (!THEME_MAP[stageTheme]?.topicTables) return;
  for (const deal of topics.update(topicSpots(), stage.agents.values(), now)) {
    for (const id of deal.ids) {
      sendToAgent(id, EV.TOPIC_CARD, {
        question: deal.question,
        spot: deal.label,
        withNames: deal.ids.filter((x) => x !== id).map(nameOf).filter(Boolean),
      });
    }
    blast(screens, EV.STAGE_TOPIC, { spotId: deal.spotId, question: deal.question });
    events.log('topic_card', { spot: deal.spotId, agents: deal.ids, question: deal.question });
    console.log(`[topic] ${deal.label}　${deal.ids.map(nameOf).join('、')}　「${deal.question}」`);
  }
  for (const [a, b] of topics.seatedPairs(now)) meetUp(a, b, VIA.TOPIC);
}

function handleJoin(ws, msg) {
  // 一條連線只能綁定一個角色。
  // 初版未設此限，重複送出 CLIENT_JOIN 會不斷新建角色並覆寫 ws.agentId，
  // 舊角色因為沒有任何連線指向它，disconnectedAt 永遠是 null，
  // AGENT_TTL 也就永遠不會回收 —— 單一連線即可製造無限個永久幽靈。
  if (ws.agentId) {
    const existing = stage.get(ws.agentId);
    if (existing) {
      // 允許在同一連線內更新暱稱與造型，但不另建角色
      const rename = sanitizeName(msg.name);
      if (rename && isBlockedName(rename)) {
        send(ws, EV.CLIENT_REJECT, { reason: NAME_BLOCKED_REASON });
        return;
      }
      const restyle = validateAvatarConfig(msg.avatar ?? msg.avatarConfig);
      if (rename) existing.name = rename;
      if (restyle.ok) existing.avatar = restyle.value;
      stage.rosterDirty = true;
      send(ws, EV.CLIENT_WELCOME, {
        userId: existing.id,
        rejoinToken: existing.rejoinToken,
        name: existing.name,
        stage: STAGE,
      });
      // 重連的人可能已經累積了社交連結（邊是既成事實，不隨斷線消失）
      sendSocialSelf(existing.id);
      sendClientRoster(ws);
      // 文字雲進行中就補送。這個分支會 return，走不到下面正常入場的補送
      sendWordCloudCatchUp(ws, existing.id);
      // 封鎖名單只在伺服器：手機重整後要靠這則才知道點到的人是不是被自己封鎖了
      send(ws, EV.MSG_BLOCKS, { userIds: messages.blockedBy(existing.id) });
      sendBingoCatchUp(existing.id);
      return;
    }
    ws.agentId = null; // 角色已被回收，往下走正常入場流程
  }

  const name = sanitizeName(msg.name);
  if (!name) {
    send(ws, EV.CLIENT_REJECT, { reason: '顯示名稱不可為空' });
    return;
  }
  if (isBlockedName(name)) {
    send(ws, EV.CLIENT_REJECT, { reason: NAME_BLOCKED_REASON });
    return;
  }
  const avatar = validateAvatarConfig(msg.avatar ?? msg.avatarConfig);
  if (!avatar.ok) {
    send(ws, EV.CLIENT_REJECT, { reason: avatar.reason });
    return;
  }

  // 優先嘗試斷線重連。憑證不符或角色不存在都會回傳 null，兩者不可區分，
  // 因此無法用來探測某個 userId 是否存在於場上。
  let agent = typeof msg.userId === 'string'
    ? stage.reattach(msg.userId, msg.rejoinToken)
    : null;
  /** 這次入場是怎麼接上的：new 全新角色、reattach 斷線重連、claim 重開後認領 */
  let rejoin = agent ? 'reattach' : 'new';

  // 伺服器重開後場上是空的，reattach 一定失敗。此時改用身分目錄認領：
  // 憑證相符就以原本的 id 重建角色，積分與社交圖譜自動接回（見 state.claimAgent）。
  if (!agent && typeof msg.userId === 'string') {
    agent = stage.claimAgent(directory.get(msg.userId), msg.rejoinToken);
    if (agent) {
      rejoin = 'claim';
      agent.name = name;
      agent.avatar = avatar.value;
      console.log(`[claim] ${agent.name} (${agent.id}) 於重開後認領回原角色　${scores.totalOf(agent.id)} 分`);
    }
  }

  if (agent) {
    agent.name = name;
    agent.avatar = avatar.value;
  } else {
    // 已經有人在排隊時，新來的人也排到後面 —— 不能趁著某人離場的那一瞬間插隊
    const mustQueue = audienceQueue.length > 0 && !ws.promoting;
    agent = mustQueue ? null : stage.addAgent({ name, avatar: avatar.value });
    if (!agent) {
      enqueueAudience(ws, msg);
      return;
    }
  }

  ws.role = 'controller';
  ws.agentId = agent.id;
  controllers.set(agent.id, ws);
  // 記進身分目錄，讓這個人在伺服器重開後還認得回自己的角色與分數
  directory.remember(agent);
  attendance.note(agent);
  applyPersona(agent.id, msg.persona);
  markDirty();

  // rejoinToken 只在此處單獨回傳給角色本人，不會出現在任何廣播訊息中
  send(ws, EV.CLIENT_WELCOME, {
    userId: agent.id,
    rejoinToken: agent.rejoinToken,
    name: agent.name,
    stage: STAGE,
  });

  sendClientRoster(ws);

  // 補送目前的任務狀態與配對碼，讓中途進場的人立刻能參與
  send(ws, EV.PAIR_CODE, { code: pairing.register(agent.id), nextInMs: pairing.msUntilRotate() });
  for (const m of missions.actives) send(ws, EV.MISSION_ANNOUNCE, missionAnnounceFor(agent.id, m));
  // 問答進行中就補送題目。剩餘時間由伺服器算，所以晚到的人拿到的是
  // 真正剩下的秒數，而不是從頭開始的完整倒數。
  if (quiz.isActive) sendQuestion(ws);
  // 文字雲同理：中途進場的人要能馬上作答
  sendWordCloudCatchUp(ws, agent.id);
  send(ws, EV.MSG_BLOCKS, { userIds: messages.blockedBy(agent.id) });
  sendBingoCatchUp(agent.id);
  send(ws, EV.SCORE_SELF, {
    score: scores.totalOf(agent.id),
    delta: 0,
    source: null,
    rank: scores.rankOf(agent.id, isPresent),
  });
  pushHostState();
  const isCV = agent.avatar?.source === 'CV';
  events.log('join', {
    agent: agent.id,
    name: agent.name,
    // 換裝的角色也是貼圖（isCV），但要分得出來：實測要知道 API 掛掉時有多少人走這條
    entry: isCV ? (msg.entry === 'dressup' ? 'dressup' : 'photo') : (ENTRY_ROUTES.has(msg.entry) ? msg.entry : 'builder'),
    genReq: isCV ? generationIdOf(agent.avatar) : undefined,
    rejoin,
    fromWaitlist: ws.fromWaitlist || undefined,
    present: stage.agents.size,
  });
  loggedMode.set(agent.id, agent.mode);
  console.log(`[join] ${agent.name} (${agent.id})　場上人數 ${stage.agents.size}`);
}

/**
 * 候補名單上限。伺服器沒有限制單一來源的連線數，沒有上限的話開一堆連線就能把名單
 * 灌到無限長 —— 而名單每動一次，排隊的每個人都要收一則位置更新（O(n²)）。
 * 60 遠超過一場活動實際會同時等的人數。
 */
const AUDIENCE_MAX = 60;

/** 排進候補名單。同一條連線重送 CLIENT_JOIN 只更新資料，不重排 */
function enqueueAudience(ws, msg) {
  if (!audienceQueue.includes(ws) && audienceQueue.length >= AUDIENCE_MAX) {
    send(ws, EV.CLIENT_REJECT, { reason: '現場人數已滿，候補名單也滿了，請稍候再試' });
    return;
  }
  ws.role = 'audience';
  ws.pendingJoin = msg;
  if (!audienceQueue.includes(ws)) {
    audienceQueue.push(ws);
    console.log(`[audience] 人滿，排入候補　候補 ${audienceQueue.length} 人`);
    // 候補的人還沒有 agentId，用暱稱與排位記；進場後的 join 會帶 fromWaitlist
    events.log('waitlist_join', { name: sanitizeName(msg.name) ?? undefined, position: audienceQueue.length });
  }
  pushAudiencePositions();
  pushHostState();
}

function dropAudience(ws) {
  const i = audienceQueue.indexOf(ws);
  if (i === -1) return;
  audienceQueue.splice(i, 1);
  pushAudiencePositions();
  pushHostState();
}

/** 每個人前面還有幾位 */
function pushAudiencePositions() {
  audienceQueue.forEach((w, i) => send(w, EV.AUDIENCE_WAIT, { ahead: i }));
}

/**
 * 有空位就讓排第一的人進場。由主迴圈每個 tick 呼叫 —— 空位的來源很多
 * （主動離場、被請出場、斷線逾時），掛在每一條路徑上遲早會漏一條。
 */
function promoteAudience() {
  let moved = false;
  while (audienceQueue.length && !stage.isFull()) {
    const w = audienceQueue.shift();
    moved = true;
    if (w.readyState !== w.OPEN || w.role !== 'audience') continue;
    w.role = null;
    w.promoting = true;
    w.fromWaitlist = true;
    try {
      handleJoin(w, w.pendingJoin);
    } finally {
      w.promoting = false;
    }
    // 沒進成（例如名字在這段期間變得不合格）就不再排：handleJoin 已經回了 CLIENT_REJECT
    if (w.agentId) console.log(`[audience] 候補進場　剩 ${audienceQueue.length} 人`);
  }
  if (moved) {
    pushAudiencePositions();
    pushHostState();
  }
}

/**
 * 參與者離開場域時的共用清理。
 *
 * forget 用於「明確的離場」（主動退出、被主辦端移除）：
 * 連身分目錄裡的憑證一併撤銷，這個 userId 就再也認領不回來。
 * 沒有這一步，主動離場的人只要重送舊憑證就能接回原角色與積分，
 * 而「離場後重新進場是全新角色」是既有的設計承諾；
 * 被踢的人也會因此能自己走回來。
 *
 * 單純的斷線不走這裡（見 ws.on('close')）—— 那是網路瞬斷，
 * 憑證必須留著，否則就沒有重連可言。
 */
function detachAgent(agentId, { forget = false } = {}) {
  controllers.delete(agentId);
  pairing.release(agentId);
  greetings.drop(agentId);
  if (forget) {
    directory.forget(agentId);
    // 標籤是「這個人是誰」，主動離場或被請出場時要一起忘掉；
    // 單純斷線則保留 —— 那個人多半還會用原憑證接回同一個角色。
    traits.forget(agentId);
    bingo.forget(agentId);
    messages.forget(agentId);
    encounters.forget(agentId);
    markDirty();
  }
}

// ─────────────────────────────────────────────────────────────
// 揮手（要對方回揮才算數，見 server/greetings.js；乾杯已移除）
// ─────────────────────────────────────────────────────────────
function handleWave(agentId, targetId) {
  const r = greetings.wave(agentId, stage.agents, Date.now(), targetId);
  if (r.kind === 'nobody') {
    sendToAgent(agentId, EV.GREET_RESULT, { kind: 'WAVE', outcome: GREET_OUTCOME.NOBODY });
  } else if (r.kind === 'invite') {
    if (!r.silent) sendToAgent(r.to, EV.GREET_INVITE, { fromId: r.from, fromName: nameOf(r.from) });
    events.log('greet_invite', { agent: r.from, peer: r.to, silent: r.silent || undefined });
    sendToAgent(r.from, EV.GREET_RESULT, {
      kind: 'WAVE', outcome: GREET_OUTCOME.SENT, otherName: nameOf(r.to),
    });
  } else {
    greetDone('WAVE', GREET_OUTCOME.MUTUAL, r.a, r.b);
  }
}

/** 兩人成功：雙方手機各收一則，大螢幕在兩人之間畫一道連線 */
function greetDone(kind, outcome, a, b) {
  sendToAgent(a, EV.GREET_RESULT, { kind, outcome, otherName: nameOf(b) });
  sendToAgent(b, EV.GREET_RESULT, { kind, outcome, otherName: nameOf(a) });
  blast(screens, EV.STAGE_GREET, { kind, a, b });
  // 「要對方回應才算數」的那一刻：社交圖譜之外，第二種「兩人有互動」的證據
  events.log('greet', { kind, agent: a, peer: b });
  // 回揮的那一方此時頭上已經有揮手圖示；先揮的那一方可能已經消失了，補上
  stage.applyAction(a, kind, { force: true });
  meetUp(a, b, VIA.WAVE);
  console.log(`[greet] ${nameOf(a)} × ${nameOf(b)}　互相揮手`);
}

// ─────────────────────────────────────────────────────────────
// 配對任務處理
// ─────────────────────────────────────────────────────────────
/** 走配對流程的任務型別。COLOR_HUNT 只是多一道顏色條件，驗證模型與 PAIRING 相同 */
const PAIR_MISSION_TYPES = new Set(PAIR_MISSION_IDS);

/** 任務條件判定要用的場上資料（missionRules.js 的 RuleCtx） */
const ruleCtx = {
  avatarOf: (id) => stage.get(id)?.avatar ?? null,
  traitOf: (id, key) => traits.traitOf(id, key),
};

/** 標籤鍵的人話名稱。目前只有進場人格會寫標籤（轉場問卷已移除） */
function traitTitle(key) {
  return key === PERSONA_TRAIT_KEY ? '進場人格類型' : key;
}

/** 主辦端發布任務時可選的條件：場上真的有的標籤、目前場景的集合點 */
function missionOptions() {
  return {
    catalog: traitCatalog([...stage.agents.keys()], (id) => traits.traitsOf(id), traitTitle),
    spots: topicSpots().map(({ id, label }) => ({ id, label })),
  };
}

/**
 * 整理任務條件並檢查做不做得完。發布與發布前的檢查走同一條路，
 * 主辦端看到的警告才會跟按下發布時伺服器的判斷一致。
 */
function checkMission(msg) {
  const spec = MISSION_TYPES[msg.missionType];
  if (!spec) return { ok: false, reason: `未知的任務型別：${msg.missionType}` };
  const built = buildRule(spec.id, msg, missionOptions());
  if (!built.ok) return built;
  const target = spec.verify === 'gather' ? 1 : Number(msg.target);
  const check = feasibility(built.rule, {
    target,
    agents: [...stage.agents.keys()],
    ctx: ruleCtx,
    connected: (a, b) => graph.neighbors(a).has(b),
  });
  return { ok: true, rule: built.rule, target, check };
}

/** DIFF／SAME 任務：這個人自己在那一題的答案（手機上要寫「你是 🐯 老虎」） */
function myTraitLabel(agentId, m) {
  const key = m?.rule?.traitKey;
  return key ? (traits.traitOf(agentId, key)?.label ?? null) : null;
}

/** 單一參與者收到的某個任務的公告。條件裡有「你自己是哪一類」，所以每個人一份 */
function missionAnnounceFor(agentId, m) {
  return {
    mission: missions.announcement(m.id),
    progress: missions.progressOf(m.id, agentId),
    mine: myTraitLabel(agentId, m),
    gather: gatherView(m),
  };
}

// ── GATHER：湊滿人數到集合點 ─────────────────────────────────
/**
 * 每個進行中的 GATHER 任務一個集合判定（可以同時開兩個不同集合點）。
 * 任務結算或伺服器重開後，於主迴圈依進行中的任務重建。
 * @type {Map<string, GatherTracker>}
 */
const gatherTrackers = new Map();

function gatherView(m) {
  if (m?.type !== 'GATHER') return null;
  const inside = gatherTrackers.get(m.id)?.lastInside ?? 0;
  return { id: m.id, spot: m.rule.spot, label: m.rule.label, need: m.rule.teamSize, inside: Math.max(0, inside) };
}

function stepGather(now) {
  const gathers = missions.actives.filter((m) => m.type === 'GATHER');
  for (const id of gatherTrackers.keys()) {
    if (!gathers.some((m) => m.id === id)) gatherTrackers.delete(id);
  }
  for (const m of gathers) {
    let tracker = gatherTrackers.get(m.id);
    if (!tracker) {
      const prop = PROPS.find((p) => p.id === m.rule.spot);
      if (!prop) continue;
      tracker = new GatherTracker({ spot: prop, teamSize: m.rule.teamSize, holdMs: MISSION_TYPES.GATHER.holdMs });
      gatherTrackers.set(m.id, tracker);
    }
    // 斷線中的角色還留在場上（AGENT_TTL），但那個人不在現場，不能幫別人湊數
    const out = (id) => missions.progressOf(m.id, id) >= m.target || !!stage.get(id)?.offline;
    const r = tracker.step(stage.agents.values(), out, now);
    if (r.completed.length) completeGather(m, r.completed);
    if (r.changed || r.completed.length) {
      blastAll(EV.MISSION_GATHER, { id: m.id, inside: r.inside, need: m.rule.teamSize, done: r.completed });
    }
  }
}

function completeGather(m, ids) {
  for (const id of ids) {
    const credit = missions.credit(m.id, id, { with: ids.filter((x) => x !== id) });
    if (!credit) continue;
    // 集合本身不給分，做到任務目標才給（2026-10-19）
    if (credit.count === m.target) award(id, SCORING.missionFinish, { source: SCORE_SOURCES.MISSION_DONE, ref: m.id });
    events.log('mission_progress', { mission: m.id, agent: id, count: credit.count, target: m.target, team: ids });
    if (credit.count === m.target) events.log('mission_complete', { mission: m.id, agent: id });
  }
  console.log(`[mission] ${ids.map(nameOf).join('、')} 在「${m.rule.label}」集合完成`);
  markDirty();
  broadcastMissionState();
}

function handlePairClaim(ws, msg) {
  // 可以同時有好幾個任務：這次配對算得進哪幾個，在提交碼的當下就決定
  const pairMissions = missions.actives.filter((m) => PAIR_MISSION_TYPES.has(m.type));
  if (!pairMissions.length) {
    // 進行中的只有集合任務：那要走過去，不是輸入配對碼
    send(ws, EV.PAIR_RESULT, {
      ok: false, reason: missions.isActive ? PAIR_ERRORS.NOT_PAIR_MISSION : PAIR_ERRORS.NO_MISSION,
    });
    return;
  }
  // 任務條件（顏色、類型、同類／不同類）在「提交碼」這一步就判定，而不是等對方確認 ——
  // 讓 A 白等 30 秒才被告知「他不是紅色的」是很差的體驗，而且會佔用雙方的 pending 名額。
  // 判定本身在 missionRules.pairRule()。這次配對只算進條件成立的那幾個任務；
  // 有一般配對任務（沒有條件）時它永遠成立，所以不會擋人。
  //
  // ⚠ 這條路徑必須自己處理冷卻（peekTarget 不含冷卻，見該方法的說明）：
  //   直接 return 而不記冷卻的話，攻擊者可從「條件不符」↔ NOT_FOUND
  //   的差異無限次試碼，把 claim() 的防枚舉冷卻整套繞過去。
  const allConditional = pairMissions.every((m) => m.rule && m.rule.type !== 'PAIRING');
  const targetAgent = stage.get(pairing.peekTarget(msg.code));
  const self = targetAgent?.id === ws.agentId;
  const verdicts = pairMissions.map((m) => ({
    m, why: targetAgent && !self ? pairRule(m.rule, ws.agentId, targetAgent.id, ruleCtx) : null,
  }));
  const matched = verdicts.filter((v) => !v.why).map((v) => v.m);
  if (allConditional) {
    if (pairing.inCooldown(ws.agentId)) {
      send(ws, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.COOLDOWN });
      return;
    }
    if (targetAgent && !self && !matched.length) {
      // 條件不符是正當使用者會遇到的情況（走向了不對的人），
      // 因此刻意不記冷卻 —— 讓他能馬上改找正確的人。
      const colored = pairMissions.filter((m) => m.colorFamily);
      const traitKey = pairMissions.find((m) => m.rule?.traitKey)?.rule.traitKey;
      send(ws, EV.PAIR_RESULT, {
        ok: false,
        reason: verdicts[0].why,
        colorFamily: colored[0]?.colorFamily ?? undefined,
        colorFamilies: colored.length ? colored.map((m) => m.colorFamily) : undefined,
        // DIFF／SAME：對方是哪一類要說出來 —— 「他也是老虎」比「不符合」好懂，
        // 而這個資訊對方本來就會當面講（條件本來就是靠問的）
        peerLabel: traitKey ? (traits.traitOf(targetAgent.id, traitKey)?.label ?? undefined) : undefined,
      });
      events.log('pair_claim', {
        agent: ws.agentId, peer: targetAgent.id, ok: false,
        reason: verdicts[0].why, missions: pairMissions.map((m) => m.id),
      });
      return;
    }
    // 沒有命中「條件不符」的情況（查無此碼、或對方符合條件）一律記冷卻，
    // 使這條預檢路徑的成本與正常的 claim() 相同
    if (!targetAgent) pairing.noteClaim(ws.agentId);
  }
  const result = pairing.claim(ws.agentId, msg.code, Date.now(),
    matched.map((m) => m.id));
  events.log('pair_claim', {
    agent: ws.agentId, peer: result.target, ok: result.ok,
    reason: result.ok ? undefined : result.reason, missions: matched.map((m) => m.id),
  });
  if (!result.ok) {
    send(ws, EV.PAIR_RESULT, { ok: false, reason: result.reason });
    return;
  }
  const me = stage.get(ws.agentId);
  // 推送確認請求給被指定的一方，附上發起人的外觀讓他能對照眼前的人
  sendToAgent(result.target, EV.PAIR_CONFIRM_REQ, {
    from: ws.agentId,
    name: me?.name ?? '',
    avatar: me?.avatar ?? null,
    expiresInMs: 30000,
  });
  send(ws, EV.PAIR_RESULT, { ok: true, pending: true, waitingFor: result.target });
}

function handlePairConfirm(ws, msg) {
  const result = pairing.confirm(ws.agentId, msg.accept === true);
  // agent 是發起方、peer 是確認方，與 pair_claim 同一個方向，兩筆才對得起來
  events.log('pair_confirm', {
    agent: result.from, peer: ws.agentId, ok: result.ok,
    reason: result.ok ? undefined : result.reason, missions: result.missionIds ?? undefined,
  });
  if (!result.ok) {
    send(ws, EV.PAIR_RESULT, { ok: false, reason: result.reason });
    if (result.from) {
      sendToAgent(result.from, EV.PAIR_RESULT, { ok: false, reason: result.reason });
    }
    return;
  }

  const a = stage.get(result.from);
  const b = stage.get(result.to);
  // 邀請發出後、確認送達前，主辦端可能已經結算舊任務並發布新的。
  // 只記發出邀請當下算得進去、而且現在還開著的任務；新發布的任務不算。
  const still = result.missionIds.filter((mid) => missions.get(mid));

  for (const [id, partnerId, partner] of [
    [result.from, result.to, b],
    [result.to, result.from, a],
  ]) {
    // 配對本身不給分（2026-10-19 起任務只看達標）。達標獎勵每個任務各一次，
    // 只在「剛好踏到目標次數」的那一次發：用 count === target 而不是 done ——
    // done 在超過目標後每次都為真，拿它當條件會讓達標的人每多配對一次就再領一次獎勵。
    let total = scores.totalOf(id);
    let earned = 0;
    const detail = { with: partner?.id ?? null };
    const progress = [];
    for (const mid of still) {
      const credit = missions.credit(mid, id, { with: partnerId });
      const m = missions.get(mid);
      progress.push({ id: mid, title: m.title, target: m.target, progress: credit.count, done: credit.done });
      events.log('mission_progress', { mission: mid, agent: id, peer: partnerId, count: credit.count, target: m.target });
      if (credit.count === m.target) {
        events.log('mission_complete', { mission: mid, agent: id });
        earned += SCORING.missionFinish;
        total = award(id, SCORING.missionFinish, { source: SCORE_SOURCES.MISSION_DONE, ref: mid, detail });
      }
    }

    sendToAgent(id, EV.PAIR_RESULT, {
      ok: true,
      partnerName: partner?.name ?? '',
      // 每個算進去的任務各自的進度；progress/done 是第一個任務的（舊版手機只讀這兩欄）
      missions: progress,
      progress: progress[0]?.progress ?? 0,
      done: progress[0]?.done ?? false,
      points: earned,
      score: total,
    });
  }

  // 第 05 步「回饋」不可省略：完成必須在共享畫布上被看見，
  // 否則任務退化成手機小遊戲，與打破個人螢幕封閉性的核心命題相悖
  blastAll(EV.MISSION_COMPLETE, {
    a: { id: result.from, name: a?.name ?? '' },
    b: { id: result.to, name: b?.name ?? '' },
    edgeCount: graph.size,
  });
  // 大螢幕的連線圖要重畫
  linksDirty = true;
  // 雙方各自看到「我認識了誰」—— 手機端在進場後除了搖桿與分數之外
  // 看不到任何社交狀態，但那正是這場活動真正在累積的東西。
  encounters.meet(result.from, result.to, VIA.PAIR);
  sendSocialSelf(result.from);
  sendSocialSelf(result.to);
  markDirty();
  broadcastMissionState();
  console.log(`[pair] ${a?.name} × ${b?.name}　社交圖譜 ${graph.size} 條連結`);
}

// ─────────────────────────────────────────────────────────────
// 即時問答
// ─────────────────────────────────────────────────────────────

/** 送出題目。remainingMs 於送出當下計算，中途進場的人也能接上正確的倒數。 */
function sendQuestion(target) {
  const view = quiz.publicView();
  if (!view) return;
  if (target) send(target, EV.QUIZ_QUESTION, { quiz: view });
  else blastAll(EV.QUIZ_QUESTION, { quiz: view });
}

/**
 * 公布正解、算分、推播結果。
 *
 * 分數要在「全部記完」之後才推個人結果 —— 名次是相對的，
 * 邊記邊推會讓先被處理到的人看到還沒算完的名次。
 */
function revealQuiz(now = Date.now()) {
  const result = quiz.reveal(now);
  if (!result) return;

  for (const a of result.awards) {
    if (a.points > 0) {
      award(a.agentId, a.points, {
        source: SCORE_SOURCES.QUIZ,
        ref: result.id,
        detail: { choice: a.choice, correct: a.correct, elapsedMs: a.elapsedMs },
      });
    }
  }

  events.log('quiz_reveal', {
    quiz: result.id,
    correctIndex: result.correctIndex,
    answers: result.totalAnswers,
    correct: result.awards.filter((a) => a.correct).length,
  });
  const answered = new Set(result.awards.map((a) => a.agentId));
  for (const a of result.awards) {
    sendToAgent(a.agentId, EV.QUIZ_RESULT, {
      answered: true,
      correct: a.correct,
      correctIndex: result.correctIndex,
      choice: a.choice,
      points: a.points,
      score: scores.totalOf(a.agentId),
      rank: scores.rankOf(a.agentId, isPresent),
    });
  }
  // 沒作答的人也必須收到結果，否則手機會一直停在「等待公布」
  for (const id of controllers.keys()) {
    if (answered.has(id)) continue;
    sendToAgent(id, EV.QUIZ_RESULT, {
      answered: false,
      correct: false,
      correctIndex: result.correctIndex,
      choice: null,
      points: 0,
      score: scores.totalOf(id),
      rank: scores.rankOf(id, isPresent),
    });
  }

  blastAll(EV.QUIZ_REVEAL, {
    id: result.id,
    correctIndex: result.correctIndex,
    counts: result.counts,
    totalAnswers: result.totalAnswers,
    // 大螢幕據此讓答對者的角色擴散光環 —— 問答的結果必須回到共享畫布上，
    // 否則它就只是三十個人各自低頭玩手機（規格 v3.0 §3.1 第 05 步）
    correctIds: result.awards.filter((a) => a.correct).map((a) => a.agentId),
  });
  scoresDirty = true;
  markDirty();
  pushHostState();
  console.log(`[quiz] 公布正解　作答 ${result.totalAnswers} 人　答對 ${result.awards.filter((a) => a.correct).length} 人`);
}

/** 收題。未揭曉就收掉等同作廢，不計分。 */
function endQuiz() {
  const closed = quiz.end();
  if (!closed) return;
  events.log('quiz_end', { quiz: closed.id });
  blastAll(EV.QUIZ_ENDED, { id: closed.id });
  markDirty();
  pushHostState();
}

/** 作答人數變動後才廣播，節流由主迴圈負責 */
let quizTallyDirty = false;
/** 文字雲的詞變動後才廣播，同上 */
let wordcloudDirty = false;

/** 收掉文字雲。大螢幕停在最終的雲上，手機收起作答面板 */
function closeWordCloud(now = Date.now()) {
  const result = wordcloud.close(now);
  if (!result) return;
  events.log('wordcloud_close', {
    round: result.id, participants: result.participants,
    words: result.words.slice(0, 20).map((w) => w.text),
  });
  blastAll(EV.WORDCLOUD_CLOSED, { result });
  // 結果留在大螢幕上，等主持人收起（或時間到）
  wordcloudResultShown = true;
  clearTimeout(wordcloudResultTimer);
  wordcloudResultTimer = setTimeout(() => dismissWordCloudResult(), WORDCLOUD_RESULT_MS);
  markDirty();
  pushHostState();
  console.log(`[wordcloud] 收題「${result.question}」　${result.participants} 人作答、${result.words.length} 個詞`);
}

/** 收起大螢幕上的文字雲結果（主持人按、時間到、或要開始下一個滿版活動） */
function dismissWordCloudResult() {
  clearTimeout(wordcloudResultTimer);
  if (!wordcloudResultShown) return;
  wordcloudResultShown = false;
  blast(screens, EV.WORDCLOUD_DISMISS, {});
  pushHostState();
}

function handleWordCloudAnswer(ws, msg) {
  const r = wordcloud.answer(ws.agentId, msg.text);
  // mine 一律帶回：手機的「你送過的」清單以伺服器為準（重連、被拒時都對得上）
  send(ws, EV.WORDCLOUD_ACK, r.ok ? { ok: true, mine: r.mine } : { ok: false, reason: r.reason, mine: r.mine ?? [] });
  if (r.ok) {
    wordcloudDirty = true;
    // 每送出一個答案給一次分（2026-10-19）。被擋下的（重複、不雅字、超過 3 個）不給
    award(ws.agentId, SCORING.wordcloudAnswer, { source: SCORE_SOURCES.WORDCLOUD, ref: wordcloud.publicView()?.id ?? null });
    // 只記誰送了幾個詞，不記內容：個別答案對應得到人，雲上只看得到彙整後的詞
    events.log('wordcloud_answer', { round: wordcloud.publicView()?.id, agent: ws.agentId, count: r.mine.length });
  }
}

function handleQuizAnswer(ws, msg) {
  const result = quiz.answer(ws.agentId, msg.choice);
  if (!result.ok) {
    send(ws, EV.QUIZ_ACK, { ok: false, reason: result.reason });
    return;
  }
  // 對錯不在這裡記：正解要到揭曉才算數，分析時以 quiz_start 的 correctIndex 對照
  events.log('quiz_answer', {
    quiz: quiz.current.id, agent: ws.agentId, choice: result.choice, elapsedMs: result.elapsedMs,
  });
  // 只回「已鎖定」，不回對錯 —— 倒數期間任何一位參與者都不該提前知道答案
  send(ws, EV.QUIZ_ACK, { ok: true, choice: result.choice });
  quizTallyDirty = true;
}

// ─────────────────────────────────────────────────────────────
// 私訊
// ─────────────────────────────────────────────────────────────
/** 收件人在不在場、手機有沒有連著。私訊只送給連線中的手機，不替離線的人存信 */
const messagePresence = {
  exists: (id) => stage.agents.has(id),
  online: (id) => {
    const sock = controllers.get(id);
    return !!sock && sock.readyState === sock.OPEN;
  },
};

function handleDirectMessage(ws, msg) {
  const from = ws.agentId;
  // 手機帶來的請求編號，原樣帶回：手機上「點角色寫的」與「收件畫面的回應」可能
  // 同時在等結果，靠先後順序對不準（連線層限流丟掉的訊息不會有回覆）
  const ref = typeof msg.ref === 'string' && msg.ref.length <= 16 ? msg.ref : undefined;
  const result = messages.send(from, msg.to, msg.text, messagePresence);
  if (!result.ok) {
    send(ws, EV.MSG_RESULT, { ok: false, to: msg.to ?? null, reason: result.reason, ref });
    return;
  }
  // 被封鎖時一樣回報成功（理由見 messages.js 開頭），只是不轉送
  send(ws, EV.MSG_RESULT, { ok: true, to: msg.to, ref });
  // 只記誰寫給誰，**不記內容** —— 私訊只屬於兩個當事人（同上方不給主辦端的理由）
  events.log('message', { agent: from, peer: msg.to, delivered: result.delivered });
  if (!result.delivered) return;
  const { message } = result;
  // 對方回過才算兩人聊過；單方面傳不算
  if (encounters.wrote(message.from, message.to)) {
    sendSocialSelf(message.from);
    sendSocialSelf(message.to);
    markDirty();
  }
  // 只送給收件人。不廣播、不進大螢幕、不給主辦端 —— 一般私訊只有兩個當事人看得到
  sendToAgent(message.to, EV.MSG_RECEIVE, {
    message: { id: message.id, from: message.from, fromName: nameOf(message.from), text: message.text, at: message.at },
  });
}

function handleMessageReport(ws, msg) {
  const entry = messages.report(ws.agentId, msg.messageId);
  if (!entry) return;
  // 名字在檢舉當下記下來：寄件人之後若被移除，主辦端仍要知道是誰
  entry.fromName = nameOf(entry.from);
  entry.toName = nameOf(entry.to);
  events.log('message_report', { agent: entry.to, peer: entry.from });
  console.log(`[report] ${entry.toName} 檢舉了 ${entry.fromName} 的私訊`);
  pushMessageReports();
}

const pushMessageReports = () => blast(hosts, EV.HOST_MSG_REPORTS, { reports: messageReports() });

/** 主辦端的檢舉清單。帶上寄件人是否仍在場，主辦端才知道「移除」按了有沒有意義 */
function messageReports() {
  return messages.reports.map((r) => ({ ...r, fromPresent: isPresent(r.from) }));
}

/** 切換場景主題。HOST_SET_THEME 與活動設定共用 */
function setStageTheme(theme) {
  if (theme === stageTheme) return;
  stageTheme = theme;
  console.log(`[theme] 切換為「${THEME_MAP[stageTheme].label}」`);
  events.log('theme_change', { theme: stageTheme });
  markDirty();
  // 手機也要：個人視角畫的是同一個場景的局部，主題不同步就會一邊廚房一邊辦公室
  blast([...screens, ...hosts, ...controllers.values()], EV.STAGE_THEME, { theme: stageTheme });
  // 預設的自我介紹題跟著場景走
  if (bingoFactsCustom === null) blast(hosts, EV.HOST_BINGO_FACTS, bingoFactsView());
}

/**
 * 大螢幕操作（原本是投影畫面上的按鈕與鍵盤快捷鍵）。
 *
 * 除錯視圖是「狀態」，由伺服器保存並廣播 SCREEN_SETTINGS ——
 * 投影機中途重開、或同時接了兩台螢幕，畫面才會一致，主辦端的按鈕也才知道目前是開是關。
 * 清除效果是一次性動作，只轉發給大螢幕。
 */
function handleScreenCommand(ws, msg) {
  switch (msg.cmd) {
    case 'debug':
      screenSettings.debug = msg.value === true;
      blast([...screens, ...hosts], EV.SCREEN_SETTINGS, { settings: screenSettings });
      break;
    case 'sound':
      // 音效開關。展場若有講者在台上說話，主辦方要能一鍵關掉
      screenSettings.sound = msg.value === true;
      blast([...screens, ...hosts], EV.SCREEN_SETTINGS, { settings: screenSettings });
      break;
    case 'ranks':
      screenSettings.ranks = msg.value === true;
      blast([...screens, ...hosts], EV.SCREEN_SETTINGS, { settings: screenSettings });
      break;
    case 'capture':
      captureForHost(ws);
      break;
    default:
  }
}

/**
 * 「儲存畫面」：截圖由大螢幕產生（3D 場景只存在於它的 WebGL 畫布上），
 * 走合照同一條 /api/screen-capture 管線，再把圖交給按下按鈕的那台主辦端下載。
 * 原本是在投影電腦上直接下載，檔案落在投影機那台電腦裡，主辦者拿不到。
 * 刻意不 await，理由同 HOST_TAKE_PHOTO。
 */
async function captureForHost(ws) {
  if (![...screens].some(isCaptureScreen)) {
    send(ws, EV.HOST_SCREEN_SHOT, { error: '大螢幕沒有連線' });
    return;
  }
  const image = await requestScreenCapture();
  send(ws, EV.HOST_SCREEN_SHOT, image ? { image } : { error: '大螢幕沒有回應，請再試一次' });
}

// ─────────────────────────────────────────────────────────────
// 主辦端處理
// ─────────────────────────────────────────────────────────────
function handleHostMessage(ws, msg) {
  switch (msg.type) {
    case EV.HOST_CHECK_MISSION: {
      // 主辦端每改一次表單就問一次。沒帶型別時只回可選的條件（標籤、集合點）
      const checked = msg.missionType ? checkMission(msg) : null;
      send(ws, EV.HOST_MISSION_CHECK, {
        seq: msg.seq ?? null,
        options: missionOptions(),
        check: checked?.ok ? checked.check : null,
        error: checked && !checked.ok ? checked.reason : null,
      });
      break;
    }

    case EV.HOST_PUBLISH_MISSION: {
      const checked = checkMission(msg);
      if (!checked.ok) { send(ws, EV.HOST_REJECT, { reason: checked.reason }); return; }
      // 沒有任何一組人做得完的任務，預設不發：發下去只會讓全場找半天找不到。
      // 主辦端確認過（force）才放行 —— 例如人還沒到齊就想先把任務掛上去。
      if (checked.check.level === 'block' && msg.force !== true) {
        send(ws, EV.HOST_REJECT, { reason: `現在沒有人做得完：${checked.check.summary}`, check: checked.check });
        return;
      }
      const result = missions.publish({
        type: msg.missionType,
        target: checked.target,
        colorFamily: checked.rule.colorFamily ?? null,
        rule: checked.rule,
        durationMs: msg.durationMs ?? 0,
      });
      if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
      console.log(`[mission] 發布「${result.mission.title}」目標 ${result.mission.target} 次`
        + `（進行中 ${missions.actives.length} 個）`);
      events.log('mission_publish', {
        mission: result.mission.id, type: result.mission.type, title: result.mission.title,
        target: result.mission.target, colorFamily: result.mission.colorFamily ?? undefined,
        rule: result.mission.rule, feasible: checked.check.canFinish,
        durationMs: result.mission.durationMs || undefined, present: stage.agents.size,
        concurrent: missions.actives.length,
      });
      markDirty();
      // 公告同時推送至手機與大螢幕。只送新的這一個：其他進行中的任務各端本來就有。
      // 手機每人一份：同類／不同類要寫出「你是哪一類」
      for (const [id, sock] of controllers) send(sock, EV.MISSION_ANNOUNCE, missionAnnounceFor(id, result.mission));
      blast(screens, EV.MISSION_ANNOUNCE, {
        mission: missions.announcement(result.mission.id), gather: gatherView(result.mission),
      });
      broadcastMissionState();
      break;
    }

    case EV.HOST_START_BINGO:
      startBingo(ws, msg);
      break;

    case EV.HOST_SET_TOPICS:
      topics.setEnabled(msg.enabled === true);
      console.log(`[topic] 話題桌${topics.enabled ? '開啟' : '關閉'}`);
      pushHostState();
      break;

    case EV.HOST_END_BINGO:
      endBingo('host');
      break;

    // 自我介紹不限時，有人一直沒答時由主持人決定不等了
    case EV.HOST_BINGO_DEAL:
      if (bingo.phase === 'ask') {
        console.log('[bingo] 主持人直接發卡');
        startBingoPlay();
      }
      break;

    case EV.HOST_START_WORDCLOUD: {
      const busy = busyActivity('wordcloud');
      if (busy) { send(ws, EV.HOST_REJECT, { reason: busy }); return; }
      // 上一題還開著就先收掉：節目單按「下一項」接著出下一題時，
      // 不該卡在「上一題還沒收」—— 那時主持人正對著全場說話。題目不合格時保留上一題。
      if (wordcloud.isActive && msg.question && String(msg.question).trim()) closeWordCloud();
      const result = wordcloud.start({ question: msg.question });
      if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
      // 新題目會直接換掉大螢幕上的舊結果；舊結果的「時間到自動收起」不能收到新題目
      clearTimeout(wordcloudResultTimer);
      wordcloudResultShown = false;
      console.log(`[wordcloud] 出題「${result.round.question}」`);
      events.log('wordcloud_start', {
        round: result.round.id, question: result.round.question, present: stage.agents.size,
      });
      markDirty();
      // 手機要作答、大螢幕與主辦端要顯示題目，三端都送題目；雲本身只給大螢幕與主辦端
      blastAll(EV.WORDCLOUD_QUESTION, { cloud: result.round });
      blast([...screens, ...hosts], EV.WORDCLOUD_STATE, { cloud: wordcloud.cloud() });
      pushHostState();
      break;
    }

    case EV.HOST_HIDE_WORD:
      if (wordcloud.hide(msg.word)) {
        console.log(`[wordcloud] 主持人隱藏了一個詞`);
        // 隱藏要立刻生效，不等節流：那個詞可能正投在全場面前
        blast([...screens, ...hosts], EV.WORDCLOUD_STATE, { cloud: wordcloud.cloud() });
      }
      break;

    case EV.HOST_CLOSE_WORDCLOUD:
      closeWordCloud();
      break;

    case EV.HOST_DISMISS_WORDCLOUD:
      dismissWordCloudResult();
      break;

    // 大螢幕右下角的合照下載 QR：主持人切換顯示／隱藏
    case EV.HOST_PHOTO_QR:
      if (!photoQr) return;
      photoQr.visible = msg.visible === true;
      blast(screens, EV.SCREEN_PHOTO_QR, photoQrPayload());
      pushHostState();
      break;

    case EV.HOST_SET_THEME: {
      if (!isSelectableTheme(msg.theme)) { send(ws, EV.HOST_REJECT, { reason: '沒有這個場景主題' }); return; }
      setStageTheme(msg.theme);
      break;
    }

    case EV.HOST_SETUP_EVENT: {
      // 場景與名稱一起驗證、一起生效：只套用一半的話，大螢幕會出現
      // 「新名稱配舊場景」，而主辦端以為設定失敗、其實場景已經換了
      if (!isSelectableTheme(msg.theme)) { send(ws, EV.HOST_REJECT, { reason: '請先選擇一個場景' }); return; }
      const info = parseEventInfo(msg);
      if (!info) {
        send(ws, EV.HOST_REJECT, {
          reason: `請填寫活動名稱（${EVENT_INFO.maxNameLength} 字內，副標 ${EVENT_INFO.maxSubtitleLength} 字內）`,
        });
        return;
      }
      eventInfo = info;
      console.log(`[event] 活動「${info.name}」　場景「${THEME_MAP[msg.theme].label}」`);
      markDirty();
      setStageTheme(msg.theme);
      blast([...screens, ...hosts], EV.STAGE_EVENT, { event: eventInfo });
      break;
    }

    case EV.HOST_SCREEN_CMD:
      handleScreenCommand(ws, msg);
      break;

    case EV.HOST_SET_PERSONA_QUIZ: {
      if (msg.quiz === null) {
        personaQuiz = DEFAULT_PERSONA_QUIZ;
      } else {
        const r = validatePersonaQuiz(msg.quiz);
        if (!r.ok) { send(ws, EV.HOST_REJECT, { reason: r.reason }); return; }
        personaQuiz = r.value;
      }
      console.log(`[persona] 進場問卷${personaQuiz === DEFAULT_PERSONA_QUIZ ? '恢復預設' : '已修改'}　${personaQuiz.questions.length} 題`);
      markDirty();
      blast(hosts, EV.HOST_PERSONA_QUIZ, personaView());
      break;
    }

    case EV.HOST_SET_BINGO_FACTS: {
      if (msg.facts === null) {
        bingoFactsCustom = null;
      } else {
        const r = validateBingoFacts(msg.facts, isBlockedName);
        if (!r.ok) { send(ws, EV.HOST_REJECT, { reason: r.reason }); return; }
        bingoFactsCustom = r.value;
      }
      console.log(`[bingo] 自我介紹題${bingoFactsCustom ? `已修改　${bingoFactsCustom.length} 題` : '恢復預設'}`);
      markDirty();
      blast(hosts, EV.HOST_BINGO_FACTS, bingoFactsView());
      break;
    }

    case EV.HOST_SET_SCORING: {
      const r = msg.scoring === null
        ? { ok: true, value: SCORING_DEFAULTS }
        : normalizeScoring(msg.scoring, editableScoring(SCORING));
      if (!r.ok) { send(ws, EV.HOST_REJECT, { reason: r.reason }); return; }
      Object.assign(SCORING, r.value);
      console.log(`[scoring] 配分${msg.scoring === null ? '恢復預設' : '已修改'}　${JSON.stringify(r.value)}`);
      markDirty();
      // 已經得到的分數不重算：改的是之後的規則
      blast(hosts, EV.HOST_SCORING, scoringView());
      break;
    }

    case EV.HOST_DISMISS_REPORT:
      if (messages.dismissReport(msg.messageId)) pushMessageReports();
      break;

    case EV.HOST_CLOSE_MISSION:
      // 指定 missionId 只結算那一個；沒帶（舊版主辦端）就全部結算
      if (typeof msg.missionId === 'string') closeMission('host', msg.missionId);
      else for (const m of [...missions.actives]) closeMission('host', m.id);
      break;

    case EV.HOST_REQUEST_REPORT:
      // format 原樣帶回：主辦端據此決定要下載哪一張表
      send(ws, EV.HOST_REPORT, {
        format: msg.format === 'activities' ? 'activities' : 'people',
        report: buildReport({
          missions: missions.export(),
          quiz: quiz.export(),
          traits: traits.export(),
          wordcloud: wordcloud.export(),
          scores: scores.export(),
          graph: graph.export(),
          // 已經離場的人從 directory 找名字；被移除的人兩邊都查不到，留空
          nameOf: (id) => nameOf(id) || directory.get(id)?.name || '',
          isPresent,
        }),
      });
      break;

    case EV.HOST_START_QUIZ: {
      const busy = busyActivity('quiz');
      if (busy) { send(ws, EV.HOST_REJECT, { reason: busy }); return; }
      dismissWordCloudResult();
      const result = quiz.start({
        question: msg.question,
        options: msg.options,
        correctIndex: msg.correctIndex,
        durationMs: msg.durationMs,
        talkMs: msg.talkMs,
      });
      if (!result.ok) { send(ws, EV.HOST_REJECT, { reason: result.reason }); return; }
      markDirty();
      console.log(`[quiz] 第 ${result.quiz.index} 題「${result.quiz.question}」`
        + `${result.quiz.talkMs ? `討論 ${result.quiz.talkMs / 1000} 秒＋` : ''}${result.quiz.durationMs / 1000} 秒`);
      events.log('quiz_start', {
        quiz: result.quiz.id, index: result.quiz.index, question: result.quiz.question,
        options: result.quiz.options, correctIndex: result.quiz.correctIndex,
        talkMs: result.quiz.talkMs || undefined,
        durationMs: result.quiz.durationMs, present: stage.agents.size,
      });
      sendQuestion();
      pushHostState();
      break;
    }

    case EV.HOST_TAKE_PHOTO:
      // 刻意不 await：合照要等角色就定位，await 會讓這條 WebSocket 的
      // 訊息處理停擺數秒，期間主辦端的其他操作全部沒有回應。
      takeGroupPhoto(ws, { arrange: msg.arrange });
      break;

    case EV.HOST_REVEAL_QUIZ:
      revealQuiz();
      break;

    case EV.HOST_END_QUIZ:
      endQuiz();
      break;

    case EV.HOST_KICK: {
      const target = stage.get(msg.agentId);
      if (!target) return;
      console.log(`[kick] 主辦端移除 ${target.name} (${target.id})`);
      events.log('leave', { agent: target.id, reason: 'kick' });
      loggedMode.delete(target.id);
      const sock = controllers.get(target.id);
      detachAgent(target.id, { forget: true });
      attendance.forget(target.id);
      stage.removeAgent(target.id);
      if (sock) {
        send(sock, EV.CLIENT_REJECT, { reason: '你已被主辦方請出現場' });
        sock.agentId = null;
        sock.role = null;
      }
      pushHostState();
      if (messages.reports.some((r) => r.from === target.id)) pushMessageReports();
      break;
    }
  }
}

wss.on('connection', (ws, req) => {
  ws.role = null;
  // 這條連線是從哪個網址連進來的（例如 ngrok 網域）。主辦端拍合照時，QR 就指向同一個網址
  ws.origin = requestOrigin(req, SCHEME);
  ws.agentId = null;
  ws.isAlive = true;
  ws.closing = false;
  ws.limiter = new RateLimiter(RATE_LIMIT, performance.now());
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // close() 只是開始關閉交握，已在緩衝區中的訊息仍會繼續觸發本事件。
    // 沒有這道防護，一次洪水攻擊會重複記錄數千筆 abuse 日誌。
    if (ws.closing) return;

    // 速率限制先於解析：JSON.parse 本身就是攻擊者可放大的成本
    const verdict = ws.limiter.check(performance.now());
    if (verdict === 'abuse') {
      ws.closing = true;
      console.warn(`[abuse] ${ws.agentId ?? '未登入連線'} 持續超出速率上限，已中斷`);
      ws.close(1008, 'rate limit exceeded');
      return;
    }
    if (verdict === 'drop') return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 格式錯誤直接忽略，不回應也不斷線
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case EV.CLIENT_JOIN:
        // SCREEN_HELLO / HOST_AUTH 的鏡像情況：大螢幕或主辦端連線若送出
        // CLIENT_JOIN，ws.role 會被改成 'controller'，關閉時
        // screens/hosts 的清理就不會執行，死掉的 socket 永遠留在集合裡。
        if (screens.has(ws) || hosts.has(ws)) break;
        handleJoin(ws, msg);
        break;

      case EV.SCREEN_HELLO:
        // 已綁定角色的連線不可改註冊為大螢幕。
        // 允許的話 ws.role 會變成 'screen'，但 controllers 映射沒清、
        // agent 也沒標記斷線；此連線關閉時只會走 screen 的清理分支，
        // 角色就永久留在場上。反覆操作即可耗盡 120 人上限，
        // 讓真正的參與者再也進不來。
        if (ws.agentId) break;
        ws.role = 'screen';
        // 主控台裡的預覽小窗也是一台大螢幕（收同樣的廣播），但不能被挑去截圖：
        // 它比投影機先連上時，合照底圖就會變成主持人電腦上那張縮小的預覽
        ws.preview = msg.preview === true;
        screens.add(ws);
        send(ws, EV.STAGE_META, { stage: STAGE, fps: SYNC_FPS });
        // 投影機中途重開或新接一台螢幕，都要知道現在該顯示哪個主題
        send(ws, EV.STAGE_THEME, { theme: stageTheme });
        send(ws, EV.STAGE_EVENT, { event: eventInfo });
        send(ws, EV.SCREEN_SETTINGS, { settings: screenSettings });
        send(ws, EV.STAGE_ROSTER, { agents: stage.roster() });
        // 進行中的文字雲：投影機中途重開時要接回目前的題目與雲
        if (wordcloud.isActive) {
          send(ws, EV.WORDCLOUD_QUESTION, { cloud: wordcloud.publicView() });
          send(ws, EV.WORDCLOUD_STATE, { cloud: wordcloud.cloud() });
        }
        if (bingo.isActive) send(ws, EV.BINGO_STATE, { round: bingoPublicView() });
        // 進行中的任務（可以好幾個）：投影機中途重開時，上緣的「進行中：」一列要接回來
        // 集合任務還要接回地上那一圈與目前人數
        for (const m of missions.actives) {
          send(ws, EV.MISSION_ANNOUNCE, { mission: missions.announcement(m.id), gather: gatherView(m) });
          send(ws, EV.MISSION_STATE, { mission: missions.state(m.id, stage.agents.size) });
        }
        for (const st of missions.states(stage.agents.size)) send(ws, EV.MISSION_STATE, { mission: st });
        // 連線圖是累積了整場的資料，投影機中途重開必須補送，
        // 否則大螢幕會停在「一條線都沒有」的狀態直到下一次配對
        send(ws, EV.STAGE_LINKS, { edges: graphEdges() });
        if (photoQr?.visible) send(ws, EV.SCREEN_PHOTO_QR, photoQrPayload());
        // 投影機在活動中途被重開是常態，補送當下的問答與排行榜，
        // 大螢幕才不會停在空白畫面等下一題
        if (quiz.isActive) {
          sendQuestion(ws);
          const revealed = quiz.revealView();
          if (revealed) send(ws, EV.QUIZ_REVEAL, { ...revealed, correctIds: [] });
        }
        send(ws, EV.SCORE_BOARD, {
          leaderboard: scores.leaderboard(SCORING.leaderboardSize, nameOf, isPresent),
          players: stage.agents.size,
        });
        console.log(ws.preview ? '[screen] 主控台預覽已連線' : `[screen] 大螢幕已連線　共 ${[...screens].filter((s) => !s.preview).length} 台`);
        break;

      // 大螢幕上下載 QR 的 ×：跟主控端按「隱藏」同一件事，改的是伺服器的狀態，
      // 所以每台大螢幕一起收起、主控端的按鈕也跟著變回「顯示」。
      // 只能收、不能開：大螢幕這端沒有認證，開的權限留在主控端
      case EV.SCREEN_PHOTO_QR_HIDE:
        if (ws.role !== 'screen' || !photoQr?.visible) return;
        photoQr.visible = false;
        blast(screens, EV.SCREEN_PHOTO_QR, photoQrPayload());
        pushHostState();
        break;

      case EV.INPUT_MOVE: {
        if (ws.role !== 'controller') return;
        // 相容技術文件的兩種 payload 形狀：{vector,intensity} 與 {vx,vy}
        const vec = msg.vector ?? { x: msg.vx, y: msg.vy };
        const x = finite(vec.x);
        const y = finite(vec.y);
        // 未給 intensity 時，由向量長度推得（§3 協定表的 vx/vy 形式）
        const intensity = msg.intensity === undefined
          ? clamp01(Math.hypot(x, y))
          : clamp01(finite(msg.intensity));
        stage.applyMove(ws.agentId, { x, y, intensity });
        // 超過死區才算真的操控過（lastInputAt 由 applyMove 依死區判斷）
        if (stage.get(ws.agentId)?.lastInputAt) attendance.markMoved(ws.agentId);
        break;
      }

      case EV.INPUT_ACTION: {
        if (ws.role !== 'controller') return;
        if (!ACTIONS.includes(msg.action)) return; // 白名單外的動作直接丟棄
        // 冷卻中不往下判定：否則連按揮手可以繞過冷卻狂發邀請
        if (!stage.applyAction(ws.agentId, msg.action)) return;
        if (msg.action === 'WAVE') {
          handleWave(ws.agentId, typeof msg.target === 'string' ? msg.target : undefined);
        }
        break;
      }

      case EV.CLIENT_RETIRE: {
        // 只接受還沒進場的連線：這是「換一個新角色」在進場前送出的，
        // 已綁定角色的連線要離場請走 CLIENT_LEAVE。
        if (ws.role || ws.agentId) return;
        const id = typeof msg.userId === 'string' ? msg.userId : null;
        if (!id) return;
        const removed = stage.retire(id, msg.rejoinToken);
        // 還在場上卻沒移除 = 憑證不符，或另一條連線正在用：都不能動
        if (!removed && stage.get(id)) return;
        // 已被回收的角色仍留在身分目錄裡，伺服器重開後會被認領回來，一併忘掉
        const entry = directory.get(id);
        if (!removed && !(entry && tokensMatch(entry.rejoinToken, msg.rejoinToken))) return;
        console.log(`[retire] ${id} 換新角色，舊角色離場`);
        detachAgent(id, { forget: true });
        attendance.forget(id);   // 同一個人換了角色，合照名單只留新的那一個
        pushHostState();
        break;
      }

      case EV.CLIENT_LEAVE: {
        if (ws.role !== 'controller' || !ws.agentId) return;
        // 主動退出與被動斷線不同：使用者已明確表達離開意圖，
        // 因此立即移除角色，而非讓它轉入 Boids 漫遊等待重連。
        console.log(`[leave] ${ws.agentId} 主動離場`);
        events.log('leave', { agent: ws.agentId, reason: 'self' });
        loggedMode.delete(ws.agentId);
        detachAgent(ws.agentId, { forget: true });
        stage.removeAgent(ws.agentId);
        ws.agentId = null;
        ws.role = null;
        pushHostState();
        break;
      }

      case EV.PAIR_CLAIM:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handlePairClaim(ws, msg);
        break;

      case EV.PAIR_CONFIRM:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handlePairConfirm(ws, msg);
        break;

      case EV.QUIZ_ANSWER:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleQuizAnswer(ws, msg);
        break;

      case EV.WORDCLOUD_ANSWER:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleWordCloudAnswer(ws, msg);
        break;

      case EV.MSG_SEND:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleDirectMessage(ws, msg);
        break;

      case EV.MSG_BLOCK:
        if (ws.role !== 'controller' || !ws.agentId) return;
        if (messages.block(ws.agentId, msg.userId, messagePresence)) {
          console.log(`[block] ${nameOf(ws.agentId)} 封鎖了 ${nameOf(msg.userId) || msg.userId}`);
          // 封鎖是雙向從名單上拿掉的：兩邊都要重送
          sendSocialSelf(ws.agentId);
          sendSocialSelf(msg.userId);
        }
        send(ws, EV.MSG_BLOCKS, { userIds: messages.blockedBy(ws.agentId) });
        break;

      case EV.MSG_UNBLOCK:
        if (ws.role !== 'controller' || !ws.agentId) return;
        if (messages.unblock(ws.agentId, msg.userId)) {
          console.log(`[block] ${nameOf(ws.agentId)} 解除封鎖 ${nameOf(msg.userId) || msg.userId}`);
          sendSocialSelf(ws.agentId);
          sendSocialSelf(msg.userId);
        }
        send(ws, EV.MSG_BLOCKS, { userIds: messages.blockedBy(ws.agentId) });
        break;

      case EV.MSG_REPORT:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleMessageReport(ws, msg);
        break;

      case EV.BINGO_CLAIM:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleBingoClaim(ws, msg);
        break;

      case EV.BINGO_FACTS:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleBingoFacts(ws, msg);
        break;

      case EV.BINGO_ACCEPT:
        if (ws.role !== 'controller' || !ws.agentId) return;
        handleBingoAccept(ws);
        break;

      case EV.HOST_AUTH: {
        // 與 SCREEN_HELLO 同一個理由：已綁定角色的連線改註冊為主辦端後，
        // 關閉時只會走 hosts 的清理分支，agent 的 disconnectedAt 永遠是 null，
        // AGENT_TTL 不會回收它，人數上限就被永久佔用。
        if (ws.agentId) {
          send(ws, EV.HOST_REJECT, { reason: '已入場的裝置不能改登入主辦端' });
          return;
        }
        if (!keyMatches(msg.key)) {
          console.warn('[host] 通行密鑰錯誤，拒絕連線');
          send(ws, EV.HOST_REJECT, { reason: '通行密鑰錯誤' });
          return;
        }
        ws.role = 'host';
        hosts.add(ws);
        // 一併帶上計分規則：主辦端要能在畫面上說明「答對幾分、配對幾分」，
        // 而這些值只存在於伺服器的調校檔，不在共用的協定層
        send(ws, EV.HOST_WELCOME, {
          missionTypes: Object.values(MISSION_TYPES),
          scoring: SCORING,
        });
        send(ws, EV.HOST_STATE, hostState());
        send(ws, EV.HOST_SCORING, scoringView());
        // 主題選單只由 STAGE_THEME 驅動，重整後的主辦端要靠這則才知道目前選的是哪個
        send(ws, EV.STAGE_THEME, { theme: stageTheme });
        send(ws, EV.SCREEN_SETTINGS, { settings: screenSettings });
        // 主辦端據此決定先進「活動設定」還是直接進控制台，所以排在主題之後
        //（設定頁要用目前的主題預選場景卡）
        send(ws, EV.STAGE_EVENT, { event: eventInfo });
        // 檢舉清單只由 HOST_MSG_REPORTS 驅動，重整後的主辦端要靠這則才看得到
        send(ws, EV.HOST_MSG_REPORTS, { reports: messageReports() });
        send(ws, EV.HOST_PERSONA_QUIZ, personaView());
        send(ws, EV.HOST_BINGO_FACTS, bingoFactsView());
        // 文字雲面板的詞只由 WORDCLOUD_STATE 驅動，HOST_STATE 只帶題目 ——
        // 少了這裡，重整後的主辦端看得到題目，卻看不到詞、也按不到「隱藏」。
        if (wordcloud.isActive) {
          send(ws, EV.WORDCLOUD_QUESTION, { cloud: wordcloud.publicView() });
          send(ws, EV.WORDCLOUD_STATE, { cloud: wordcloud.cloud() });
        }
        if (bingo.isActive) send(ws, EV.BINGO_STATE, { round: bingoHostView() });
        console.log(`[host] 主辦端已連線　共 ${hosts.size} 台`);
        break;
      }

      case EV.HOST_PUBLISH_MISSION:
      case EV.HOST_CLOSE_MISSION:
      case EV.HOST_CHECK_MISSION:
      case EV.HOST_START_BINGO:
      case EV.HOST_END_BINGO:
      case EV.HOST_BINGO_DEAL:
      case EV.HOST_SET_TOPICS:
      case EV.HOST_START_QUIZ:
      case EV.HOST_REVEAL_QUIZ:
      case EV.HOST_END_QUIZ:
      case EV.HOST_KICK:
      case EV.HOST_TAKE_PHOTO:
      case EV.HOST_SET_THEME:
      case EV.HOST_SETUP_EVENT:
      case EV.HOST_SCREEN_CMD:
      case EV.HOST_DISMISS_REPORT:
      case EV.HOST_SET_PERSONA_QUIZ:
      case EV.HOST_START_WORDCLOUD:
      case EV.HOST_CLOSE_WORDCLOUD:
      case EV.HOST_DISMISS_WORDCLOUD:
      case EV.HOST_PHOTO_QR:
      case EV.HOST_HIDE_WORD:
      case EV.HOST_SET_BINGO_FACTS:
      case EV.HOST_SET_SCORING:
      case EV.HOST_REQUEST_REPORT:
        // 未通過認證的連線一律忽略，不回應也不透露任何狀態
        if (ws.role !== 'host') return;
        handleHostMessage(ws, msg);
        break;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'audience') {
      dropAudience(ws);
    } else if (ws.role === 'screen') {
      screens.delete(ws);
    } else if (ws.role === 'host') {
      hosts.delete(ws);
    } else if (ws.agentId) {
      // 不立即移除角色：讓它先無縫轉入 Boids 漫遊（§6 風險 1）。
      // 但要解除定向推送對映，否則會對著已關閉的 socket 送配對碼。
      controllers.delete(ws.agentId);
      stage.markDisconnected(ws.agentId);
      console.log(`[leave] ${ws.agentId} 斷線，轉入漫遊態`);
      events.log('disconnect', { agent: ws.agentId });
      pushHostState();
    }
  });
});

// 心跳偵測：手機息屏或離開 Wi-Fi 範圍時 TCP 常不會正常關閉，
// 沒有心跳就會留下永遠「在線」卻毫無輸入的殭屍連線。
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

// ─────────────────────────────────────────────────────────────
// 模擬主迴圈
// ─────────────────────────────────────────────────────────────
// 排程器對齊絕對截止時間，消除 setInterval 在 Windows 上的累積漂移
// （實測有效頻率由 27.3 Hz 修正為 30.0 Hz，詳見 scheduler.js）
let lastTallyAt = 0;
let lastWordCloudAt = 0;
let lastScoreAt = 0;
/** CLIENT_SYNC 的節流基準。主迴圈是 30Hz，個人視角只需 15Hz。 */
let lastClientSyncAt = 0;
/** 手機名冊待重送。與 stage.rosterDirty 分開，理由見主迴圈內的說明。 */
let clientRosterDirty = false;
/** 上次送給手機的名冊內容指紋，用來判斷是否真的變了 */
let lastClientRosterSig = '';

const loop = startTicker({
  intervalMs: TICK_MS,
  onTick(dt) {
    // 傳入社交圖譜：配對過的角色之間凝聚力較強，關係會表現為畫面上的群聚
    const zoneMoves = stage.tick(dt, graph);
    if (audienceQueue.length) promoteAudience();
    greetings.prune(Date.now());

    // 分區進出。只在換區時送，不是每幀 ——
    // 每幀回報所在分區的話，30Hz × 10 人是每秒 300 則重複訊息。
    //
    // ⚠ 與 CLIENT_SYNC 同樣放在 `screens.size === 0` 早退之前，
    //   否則投影機還沒接上時手機完全收不到分區提示。
    if (zoneMoves.length) {
      for (const mv of zoneMoves) {
        sendToAgent(mv.id, EV.ZONE_SELF, { from: mv.from, to: mv.to });
      }
      // 大螢幕與主辦端要的是「哪一區現在有幾人」，不是逐筆進出
      blast([...screens, ...hosts], EV.ZONE_STATE, {
        zones: stage.zoneOccupancy(),
      });
    }

    // 配對碼輪換。舊碼在寬限期內仍有效，因此輪換不會打斷正在進行的交換。
    if (pairing.rotate()) {
      for (const [id, sock] of controllers) {
        send(sock, EV.PAIR_CODE, { code: pairing.codeOf(id), nextInMs: pairing.msUntilRotate() });
      }
    }

    // 逾時未回應的配對請求：兩邊都要收到結果，否則發起方會一直空等
    for (const p of pairing.sweep()) {
      events.log('pair_confirm', {
        agent: p.from, peer: p.to, ok: false, reason: PAIR_ERRORS.EXPIRED,
        mission: p.missionId ?? undefined,
      });
      sendToAgent(p.from, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.EXPIRED });
      sendToAgent(p.to, EV.PAIR_RESULT, { ok: false, reason: PAIR_ERRORS.EXPIRED });
    }

    // 角色被 TTL 回收時一併釋放其配對碼，避免碼池累積失效項目
    if (stage.rosterDirty) {
      for (const id of [...pairing.codes.keys()]) {
        if (!stage.agents.has(id)) pairing.release(id);
      }
      // 主動離場與被踢都已在當下記過並刪掉；還留在這裡的就是斷線逾時被回收的
      for (const id of [...loggedMode.keys()]) {
        if (stage.agents.has(id)) continue;
        loggedMode.delete(id);
        events.log('leave', { agent: id, reason: 'timeout' });
      }
    }

    // 仲裁模式（漫遊／操控／合照定位）只在改變時記一筆。
    // 操控時間比例、放手後多久回來操控，都由這串事件算得出來。
    for (const a of stage.agents.values()) {
      const prev = loggedMode.get(a.id);
      if (prev === a.mode) continue;
      loggedMode.set(a.id, a.mode);
      if (prev !== undefined) events.log('mode_change', { agent: a.id, from: prev, to: a.mode });
    }

    // 問答的時間推進由主迴圈負責，不用 setTimeout ——
    // 定時器在事件迴圈被拖慢時會延後觸發，而這裡的時間到必須與
    // 大螢幕上的倒數一致；主迴圈本來就對齊絕對截止時間（scheduler.js）。
    const now = Date.now();
    // 討論時間到：重送一次題目（phase 變成 ASKING、remainingMs 換成作答時間），
    // 手機據此解鎖選項、大螢幕換成作答倒數
    if (quiz.shouldBeginAnswering(now) && quiz.beginAnswering()) {
      sendQuestion();
      pushHostState();
    }
    if (bingo.phase === 'ask' && bingo.readyToPlay(bingoAskers(), now)) startBingoPlay();
    if (bingo.shouldAutoEnd(now)) endBingo('time');
    stepTopics(now);
    if (quiz.shouldAutoReveal(now)) revealQuiz(now);
    else if (quiz.shouldAutoEnd(now)) endQuiz();

    // 限時任務到點結算，與問答同樣由主迴圈推進：setTimeout 在事件迴圈
    // 被拖慢時會延後觸發，而這裡的時間到必須與大螢幕上的倒數一致。
    for (const id of missions.expired(now)) closeMission('time', id);
    stepGather(now);

    // 文字雲：有新答案時才廣播，最快每 300ms 一次。三十個人同時送出時
    // 逐則廣播等於每秒上百份整片雲，而大螢幕的動畫本來就跟不上那麼快。
    if (wordcloud.isActive && wordcloudDirty && now - lastWordCloudAt >= 300) {
      lastWordCloudAt = now;
      wordcloudDirty = false;
      blast([...screens, ...hosts], EV.WORDCLOUD_STATE, { cloud: wordcloud.cloud() });
    }

    // 作答人數：只送給大螢幕與主辦端。參與者不需要知道，
    // 而倒數期間送給所有人等於每次有人按就廣播三十份。
    if (quizTallyDirty && now - lastTallyAt >= 250) {
      lastTallyAt = now;
      quizTallyDirty = false;
      blast([...screens, ...hosts], EV.QUIZ_TALLY, quiz.tally());
    }

    if (scoresDirty && now - lastScoreAt >= SCORING.broadcastMs) {
      lastScoreAt = now;
      scoresDirty = false;
      broadcastScoreBoard();
    }

    // 手機端的名冊（id → 名字）。與 CLIENT_SYNC 分開送：
    // 名字是靜態資料，隨 15Hz 的座標重送等於每秒多耗十幾 KB 的重複字串。
    //
    // 觸發沿用 stage.rosterDirty（state.js 的五個變動點已統一維護它，
    // 另設一份鏡射旗標只要漏掉一處，手機名冊就會默默過期）。
    //
    // 但**不能**只寫 `if (stage.rosterDirty) clientRosterDirty = true`：
    // stage.rosterDirty 要等下面大螢幕那段才清除，而那段在
    // `screens.size === 0` 早退之後 —— 沒有大螢幕連線時它會一直是 true，
    // 於是每一幀都重新舉旗，名冊變成 30Hz 廣播（實測 2 秒送了 60 次）。
    // 因此改為比對「上次送出的名冊內容」，與大螢幕的清除時機完全脫鉤。
    const rosterSig = stage.clientRosterSignature();
    if (rosterSig !== lastClientRosterSig) clientRosterDirty = true;
    if (controllers.size && clientRosterDirty) {
      clientRosterDirty = false;
      lastClientRosterSig = rosterSig;
      const payload = JSON.stringify({
        type: EV.CLIENT_ROSTER, agents: stage.nameRoster(),
      });
      for (const sock of controllers.values()) {
        if (sock.readyState === sock.OPEN) sock.send(payload);
      }
    }

    // 手機端個人視角（15Hz）。
    //
    // 必須放在下面那道 `screens.size === 0` 早退之前 ——
    // 放在後面的話，大螢幕沒連上時所有手機的畫面會整個凍結，
    // 而這正是佈場與除錯時最常見的狀態（先開手機、投影機還沒接）。
    // 半個 tick 的容差：主迴圈是 30Hz（33.3ms），若頻率不整除 tick，
    // 嚴格比較會讓某些格子差零點幾毫秒被擋下，實際頻率掉一整格
    // （10Hz 曾因此實測只有 7.5Hz）。15Hz 整除 30，這裡是雙重保險。
    if (controllers.size && now - lastClientSyncAt >= CLIENT_SYNC_MS - TICK_MS / 2) {
      lastClientSyncAt = now;
      for (const [id, sock] of controllers) {
        if (sock.readyState !== sock.OPEN) continue;
        // 收不完就跳過這一格。座標只有最新的一則有用，Wi-Fi 訊號差的手機若照樣每格塞，
        // 舊座標會在 socket 緩衝裡排隊，手機上看到的永遠是好幾秒前的場面（2026-10 實測「很卡」）
        if (sock.bufferedAmount > CLIENT_SYNC_MAX_BUFFERED) continue;
        const view = stage.personalSnapshot(id, CLIENT_SYNC_RADIUS);
        // 角色可能已被 TTL 回收，但連線還在（下一次 CLIENT_JOIN 會重建）
        if (view) send(sock, EV.CLIENT_SYNC, view);
      }
    }

    if (screens.size === 0) return;
    // 沒有大螢幕連線時不廣播，rosterDirty 保持為 true，待螢幕接上後補送

    if (stage.rosterDirty) {
      const roster = JSON.stringify({ type: EV.STAGE_ROSTER, agents: stage.roster() });
      for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(roster);
      stage.rosterDirty = false;
    }
    // 社交圖譜與名冊一樣走「變動才送」，不塞進 30Hz 的 sync ——
    // 邊只在有人配對成功時增加，每幀重送整張圖是純粹的浪費。
    if (linksDirty) {
      const links = JSON.stringify({ type: EV.STAGE_LINKS, edges: graphEdges() });
      for (const ws of screens) if (ws.readyState === ws.OPEN) ws.send(links);
      linksDirty = false;
    }
    const sync = JSON.stringify({
      type: EV.STAGE_SYNC, agents: stage.snapshot(), t: Date.now(),
    });
    // 大螢幕同理：主控台預覽小窗所在的筆電忙不過來時，不讓座標排隊
    for (const ws of screens) {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount <= STAGE_SYNC_MAX_BUFFERED) ws.send(sync);
    }
  },
});

// 自動存檔。刻意不放進 30Hz 主迴圈：磁碟寫入是同步呼叫，
// 放在模擬迴圈裡會讓每次落地都推遲當幀的 STAGE_SYNC 廣播。
// 只有標記過髒旗標時才真的寫，閒置的場域不會空轉磨損磁碟。
const autosave = setInterval(() => {
  store.save(snapshotData());
}, PERSISTENCE.autosaveMs);

// 每分鐘回報實際模擬頻率，讓現場能即時發現時脈掉速
const monitor = setInterval(() => {
  const s = loop.stats();
  if (s.hz < 29 || s.resyncs > 0) {
    console.warn(`[tick] 實際 ${s.hz.toFixed(1)} Hz（目標 30）　重新對齊 ${s.resyncs} 次`);
  }
}, 60000);

// ─────────────────────────────────────────────────────────────
// 啟動
// ─────────────────────────────────────────────────────────────
/** 區網位址，手機最可能連得到的排前面（虛擬網卡排最後，見 photos.js 的 rankLanAddresses） */
function lanAddresses() {
  return rankLanAddresses(os.networkInterfaces());
}

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n  PixelAir Gateway 已啟動\n');
  console.log(`  大螢幕　  ${SCHEME}://localhost:${PORT}/screen/`);
  console.log(`  手機控制  ${SCHEME}://localhost:${PORT}/controller/`);
  console.log(`  主辦端　  ${SCHEME}://localhost:${PORT}/host/`);
  console.log(`\n  主辦端通行密鑰　${HOST_KEY}　（${HOST_KEY_SOURCE}）`);
  if (!PERSISTENCE.enabled) {
    console.log('  ⚠ 已關閉狀態存檔（PIXELAIR_PERSIST=0），重開後資料不保留');
  } else if (snapshot) {
    console.log(`  已接續上次的活動資料　${scores.standings().length} 人有積分`
      + `　社交連結 ${graph.size} 條　問答 ${quiz.asked} 題`);
  }
  // 啟動當下就先落地一次。自動存檔只在狀態有變動時才寫，
  // 但通行密鑰是「還沒有人做任何事」就已經需要保住的東西 ——
  // 沒有這一次寫入，開機後尚無人進場就當機的話，重開會換一組新密鑰，
  // 而主辦者手上那張寫著號碼的紙就作廢了。
  store.save(snapshotData(), { force: true });

  events.log('session_start', {
    kind: sessionKind(SESSION), theme: stageTheme, pid: process.pid, resumed: !!snapshot,
  });
  if (events.enabled) {
    console.log(`  事件紀錄　${events.file}（場次 ${SESSION}，${sessionKind(SESSION) === 'live' ? '正式' : '測試'}）`);
  }

  if (addrs.length) {
    console.log('\n  同一區網的手機請改用下列位址（現場請用這個做 QR Code）：');
    for (const a of addrs) console.log(`            ${SCHEME}://${a}:${PORT}/controller/`);
    console.log('\n  手機必須與這台電腦連在同一個 Wi-Fi —— 上面是私有位址，'
      + '手機用行動網路或別的網路都連不到。');
  }
  if (!tlsOptions) {
    console.log('\n  ⚠ 目前是 HTTP：手機在區網位址上無法使用相機，掃描進場會自動退回捏臉。');
    console.log('    要啟用掃描請先產生憑證：bash scripts/make-cert.sh');
  } else {
    const cert = inspectCertificate(addrs);
    if (cert?.expired) {
      // daysLeft 可能是 NaN（到期時間解析不出來），此時不報天數
      console.log(Number.isFinite(cert.daysLeft)
        ? `\n  ⚠ 憑證已於 ${-cert.daysLeft} 天前過期，手機會擋下連線。`
        : '\n  ⚠ 讀不出憑證的到期時間，無法確認是否仍然有效。');
      console.log('    請重新產生：bash scripts/make-cert.sh');
    } else if (cert && cert.daysLeft <= 14) {
      console.log(`\n  ⚠ 憑證再 ${cert.daysLeft} 天到期，建議在展演前重新產生。`);
    }
    if (cert?.missing.length) {
      // 這是最容易在現場才爆炸的一種：位址看起來正常、服務也活著，
      // 只有手機端會說憑證有問題，而錯誤訊息完全不提 IP。
      console.log(`\n  ⚠ 憑證不涵蓋目前的區網位址：${cert.missing.join('、')}`);
      console.log('    IP 多半是 DHCP 配發的，換過網路或重開機就會變。');
      console.log('    手機會多跳一個「網域不符」錯誤，請重新產生：bash scripts/make-cert.sh');
    }
  }
  console.log('');
});

// ── 大合照（M6）─────────────────────────────────────────────
//
// 流程：決定每個人在合照裡站哪 → 大螢幕在看不見的畫布上合成全員到齊的房間
// （public/screen/photoRender.js）→ 生成服務加上標題與 QR。
//
// 合照是另一條合成管線，不影響大螢幕的畫面（2026-10-19 主持人決定）：原本是把
// 場上的人定住、轉向鏡頭（依互動排位時還要走到隊形裡）再截大螢幕，拍照那十幾秒
// 全場動不了，而且只拍得到還在場的人。現在場上照常走動，合照裡另外放進
// 「有參與但不在場」的人（server/attendance.js）。
//
// 預設採角色的實際座標而非重排隊形：這件作品要記錄的是集體共創的
// 當下樣貌，誰跟誰聚在一起正是重點，排整齊會把那個訊息抹掉。
// 不在場的人補進人群旁邊的空位（photoLayout.js 的 guestSpots）。
//
// 主辦端可以改選「依互動排位」（arrange: 'affinity'，server/photoLayout.js）：
// 排成一個面向鏡頭的隊形，今天互動越多的人站得越近；不在場的人一起排進去。
const PHOTO_TIMEOUT_MS = 60000;   // 合成含外部圖床上傳，比生成寬鬆
let photoInFlight = false;



const CAPTURE_TIMEOUT_MS = 8000;

/**
 * 向大螢幕要一張當下畫面。
 *
 * 為什麼是「跟大螢幕要」而不是伺服器自己畫：3D 房間跑在瀏覽器的 WebGL 上，
 * 伺服器端沒有等價的渲染路徑。要在 Node 端重畫一次，等於把 RoomScene、
 * 光照、GLTF 載入與角色貼圖疊合全部再實作一遍 —— 而且兩份必然會漂移，
 * 合照裡的場景會跟觀眾前一秒看到的不一樣（arbiter.js 的註解警告過同一件事）。
 *
 * 沒有大螢幕連線時回 null，呼叫端會退回 Python 端的舞台底圖。
 */
const requestScreenCapture = (people = null) => new Promise((resolve) => {
  const screen = [...screens].find(isCaptureScreen);
  if (!screen) { resolve(null); return; }

  const requestId = randomBytes(8).toString('hex');
  const timer = setTimeout(() => {
    pendingCaptures.delete(requestId);
    resolve(null);          // 逾時就用沒有底圖的版本，不要卡住現場
  }, CAPTURE_TIMEOUT_MS);

  pendingCaptures.set(requestId, { resolve, timer });
  // 帶 people 時大螢幕另外合成合照、不截當下畫面（public/screen/photoRender.js）
  send(screen, EV.SCREEN_CAPTURE_REQ, people ? { requestId, people } : { requestId });
});

/**
 * 社交圖譜的邊，供大螢幕繪製連線。
 *
 * 只帶 id：姓名已經在名冊裡，重複送會讓訊息無謂變大；
 * `at` 讓前端能把剛建立的邊畫得亮一些，隨時間淡成常駐細線。
 */
const graphEdges = () => graph.export().edges.map((e) => ({ a: e.a, b: e.b, at: e.at }));

/** 圖譜有變動、待廣播。與 stage.rosterDirty 同樣的節流策略 */
let linksDirty = true;

/**
 * 推送「今天遇見的人」給單一參與者。帶對方姓名，手機端才顯示得出來。
 *
 * 讀 encounters 不讀圖譜（理由見 encounters.js）。順序由伺服器排好，手機照順序畫。
 * 封鎖雙向濾掉：紀念卡會被分享出去，不能讓封鎖對象的名字和肖像出現在上面。
 */
function sendSocialSelf(agentId) {
  const hidden = (id) => messages.isBlocked(agentId, id) || messages.isBlocked(id, agentId);
  const list = encounters.peersOf(agentId, { hidden });
  sendToAgent(agentId, EV.SOCIAL_SELF, {
    count: list.length,
    peers: list.map(({ id, via }) => {
      // 已經斷線被回收的人不在 stage 上，但身分目錄還記得 —— 原本這裡只查 stage，
      // 「今天認識的人」裡先走的那幾位會變成沒有名字的空格
      const peer = stage.agents.get(id) ?? directory.get(id);
      return { id, name: peer?.name ?? '', avatar: peer?.avatar ?? null, via };
    }),
  });
}

/** 兩人有了雙方都參與的互動：記帳，名單有變動才推送 */
function meetUp(a, b, via) {
  if (!encounters.meet(a, b, via)) return;
  sendSocialSelf(a);
  sendSocialSelf(b);
  markDirty();
}

/** 合照名冊裡的一個人：名字與畫得出來的外觀（在場的人另外帶座標） */
const photoEntry = (id, name, avatarIn, extra = {}) => {
  const avatar = avatarIn || {};
  const out = { id, name: name || '', ...extra };
  // CV 角色：直接取未切片的全身圖。
  // 這裡原本是從 head 的路徑字串推導出 full 的路徑 —— 因為當時 full 不在
  // shared/avatars.js 的驗證白名單裡，取不到也不敢直接信。現在 full 與其他
  // 三張走同一條路徑驗證（含「必須同屬一個資產目錄」），可以直接用，
  // 不必再靠字串替換，也不會因為副檔名改動而悄悄失效。
  const full = avatar.textures?.full;
  if (typeof full === 'string') out.fullPng = full;
  // 捏臉角色沒有生成圖，交給 photo_composer 程式化繪製樂高人偶
  if (avatar.fallbackColors) {
    out.outfit = {
      inner_color: avatar.fallbackColors.torso,
      lower_color: avatar.fallbackColors.legs,
    };
    out.face = {
      skin_tone: avatar.fallbackColors.skin,
      hair_color: avatar.fallbackColors.hair,
    };
  }
  return out;
};

/**
 * 合照裡的每個人與站位：在場的人（原地或依互動排位）＋有參與但不在場的人。
 * 只決定座標，不動場上的任何人 —— 合照是另外合成的（見上方大合照段落）。
 * @returns {{people: {id: string, name: string, avatar: object|null, x: number, y: number}[], present: number, absent: number}}
 */
const photoPeople = (arrange) => {
  const meta = new Map(stage.roster().map((a) => [a.id, a]));
  const present = stage.snapshot().map((s) => ({
    id: s.id, name: meta.get(s.id)?.name ?? '', avatar: meta.get(s.id)?.avatar ?? null, x: s.x, y: s.y,
  }));
  const absent = photoAbsent(new Set(present.map((p) => p.id)));
  let spots;
  if (arrange === 'affinity') {
    spots = affinitySpots([...present, ...absent]);
  } else {
    const field = { stage: STAGE, obstacles: OBSTACLES, obstacleDistance };
    const extra = guestSpots(absent.length, present, field);
    spots = new Map([
      ...present.map((p) => [p.id, { x: p.x, y: p.y }]),
      ...absent.slice(0, extra.length).map((p, i) => [p.id, extra[i]]),
    ]);
  }
  // 場地塞滿、排不進去的不在場者就不放（不能疊在別人身上或塞進沙發）
  const people = [...present, ...absent]
    .filter((p) => spots.has(p.id))
    .map((p) => ({ ...p, ...spots.get(p.id) }));
  return { people, present: present.length, absent: people.length - present.length };
};

/** 有沒有社交連結：配對過，或出現在任何人的相遇名單上（揮手、私訊、賓果……） */
const hasSocial = (id) => graph.degree(id) > 0
  || encounters.peersOf(id).length > 0
  || [...encounters.byId.values()].some((peers) => peers.has(id));

/**
 * 有參與、但按快門時不在場上的人（先走的、斷線的）。合照下方的名單用。
 * 門檻見 server/attendance.js：操控過移動，或有社交連結。
 */
const photoAbsent = (presentIds) => attendance.participants(hasSocial)
  .filter((e) => !presentIds.has(e.id))
  // 外觀以身分目錄為準（重連時更新過），已離場、目錄忘掉的人才用進場時記下的那份
  .map((e) => ({ id: e.id, name: e.name, avatar: directory.get(e.id)?.avatar ?? e.avatar ?? null }));

/** 合照在這台電腦上的網址前綴（QR 指向這裡，除非上傳到雲端圖床） */
const localPhotoBase = (viewerOrigin = null) => photoUrlBase({
  scheme: SCHEME, port: PORT, lanAddrs: lanAddresses(), publicHost: process.env.PUBLIC_HOST, viewerOrigin,
});

const requestCompose = (characters, backdrop, { photoBase = localPhotoBase() } = {}) => new Promise((resolve) => {
  const body = Buffer.from(JSON.stringify({
    characters,
    backdrop,
    // 場地尺寸：沒有大螢幕底圖、改由 Python 自己畫時，座標要照這個換算。
    // 原本 Python 寫死 1920×1080，場地加寬到 2596 之後人整體往右偏、間距也被壓窄
    field: { width: STAGE.width, height: STAGE.height },
    // 手機連得到的位址：沒設雲端圖床時 QR 就指向這裡（見 server/photos.js）
    photoUrlBase: photoBase,
  }), 'utf8');
  const up = http.request({
    host: VISION_HOST, port: VISION_PORT, path: '/compose', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    timeout: PHOTO_TIMEOUT_MS,
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({ ok: false, error: 'bad_response' }); }
    });
  });
  up.on('timeout', () => { up.destroy(); resolve({ ok: false, error: 'compose_timeout' }); });
  up.on('error', () => resolve({ ok: false, error: 'vision_service_unavailable' }));
  up.end(body);
});

/** 合照的站位方式。不認得的值一律當原地拍：預設行為不該因為一個打錯的參數而改變 */
const PHOTO_ARRANGE = new Set(['stay', 'affinity']);

/**
 * 依互動排位：錯落人群，中間是互動最多的人，熟的人圍在旁邊往外排（photoLayout.js 的
 * arrangeCrowdByAffinity）。場地塞不下時排不進去的人不出現
 */
function affinitySpots(people) {
  // 封鎖雙向濾掉（同紀念卡）：封鎖過的兩人不能因為之前互動過就被排在隔壁
  const hidden = (a) => (b) => messages.isBlocked(a, b) || messages.isBlocked(b, a);
  const strength = affinityFrom((id) => encounters.peersOf(id, { hidden: hidden(id) }));
  return arrangeCrowdByAffinity(people, strength, { stage: STAGE, obstacles: OBSTACLES, obstacleDistance });
}

const takeGroupPhoto = async (ws, { arrange = 'stay' } = {}) => {
  if (!PHOTO_ARRANGE.has(arrange)) arrange = 'stay';
  if (photoInFlight) {
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'ERROR', error: '合照進行中' });
    return;
  }
  const { people, present, absent } = photoPeople(arrange);
  if (people.length === 0) {
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'ERROR', error: '場上沒有角色' });
    return;
  }
  photoInFlight = true;
  try {
    events.log('photo_start', { count: people.length, present, absent, arrange });
    send(ws, EV.HOST_PHOTO_STATE, { phase: 'COMPOSING', count: people.length, arrange });
    console.log(`[photo] 合成 ${people.length} 人（在場 ${present}、不在場 ${absent}）${arrange === 'affinity' ? '　依互動排位' : ''}`);

    // 大螢幕在看不見的畫布上合成（畫面不變）；拿不到（沒有大螢幕、3D 主題、逾時）
    // 就傳 null，Python 端退回自己畫的舞台，角色照座標畫上去
    const backdrop = await requestScreenCapture(people);
    // QR 指向主持人開主辦端用的那個網址（經 ngrok 就是 ngrok 網域），見 photos.js
    const photoBase = localPhotoBase(ws.origin);
    const roster = people.map((p) => photoEntry(p.id, p.name, p.avatar, { x: p.x, y: p.y }));
    const res = await requestCompose(roster, backdrop, { photoBase });
    if (res && res.ok) {
      // 有雲端圖床時 QR 指向雲端，本機這份只是備份；沒有時 QR 指向的就是這份
      if (!savePhoto(PHOTOS_DIR, res.photo_id, res.photo_b64)) {
        console.warn(`[photo] 存檔失敗：${res.photo_id}，QR Code 會打不開`);
      }
      console.log(`[photo] 完成　${res.character_count} 人　${res.photo_id}　${res.photo_url}`);
      events.log('photo', {
        ok: true, photoId: res.photo_id, count: res.character_count, absent,
        backdrop: backdrop !== null,
        uploaded: typeof res.photo_url === 'string' && !res.photo_url.startsWith(photoBase),
      });
      // 下載 QR 交給大螢幕右下角顯示（照片上不放）
      if (typeof res.qr_b64 === 'string') {
        photoQr = { id: res.photo_id, qr: res.qr_b64, url: res.photo_url, visible: true };
        blast(screens, EV.SCREEN_PHOTO_QR, photoQrPayload());
        pushHostState();
      }
      send(ws, EV.HOST_PHOTO_STATE, {
        phase: 'DONE',
        photoId: res.photo_id,
        photoUrl: res.photo_url,
        photoB64: res.photo_b64,
        qrB64: res.qr_b64,
        count: res.character_count,
        // 沒拿到大螢幕畫面、用的是自己畫的備用舞台：主辦端要知道，否則會以為合照就長這樣
        fallback: backdrop === null,
      });
    } else {
      const error = res?.error || 'compose_failed';
      console.warn(`[photo] 失敗：${error}`);
      events.log('photo', { ok: false, error });
      send(ws, EV.HOST_PHOTO_STATE, { phase: 'ERROR', error });
    }
  } finally {
    photoInFlight = false;
  }
};

const shutdown = () => {
  loop.stop();
  clearInterval(heartbeat);
  clearInterval(monitor);
  clearInterval(autosave);
  // 強制寫入最後一份快照。Ctrl+C 與活動結束的正常關閉都會走到這裡，
  // 因此正常收工不會掉最後幾秒的資料；只有整台機器斷電會退回上一次自動存檔。
  if (store.save(snapshotData(), { force: true })) {
    console.log(`\n  狀態已存檔　${store.file}`);
  }
  // 必須逐一 terminate：wss.close() 只停止接受新連線，不會結束既有連線，
  // 而 server.close() 會等所有連線結束才回呼 —— 大螢幕連著時，
  // 現場按 Ctrl+C 會像沒反應一樣一直卡住。
  // session_end 要在 terminate 之前寫：之後的 close 事件會再記一串 disconnect，
  // 那是關機造成的，不是參與者斷線，分析時以 session_end 為界就能排除。
  events.log('session_end', { reason: 'shutdown', present: stage.agents.size });
  for (const client of wss.clients) client.terminate();
  wss.close();
  // 等事件紀錄的緩衝寫完再結束，否則最後幾筆（包括 session_end）會掉
  Promise.all([events.close(), new Promise((r) => server.close(r))])
    .then(() => process.exit(0));
  // 最後的保險：仍有殘留 handle 時不要讓收工的人卡在終端機前面。
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const handleCrash = (type, err) => {
  console.error(`\n[fatal] 未處理的例外 (${type})：`, err);
  try {
    store.save(snapshotData(), { force: true });
    console.error(`  崩潰前已緊急保存狀態快照　${store.file}`);
    events.logSync('session_end', { reason: 'crash', error: String(err?.message ?? err) });
  } catch (saveErr) {
    console.error('  快照緊急存檔失敗：', saveErr);
  }
  process.exit(1);
};
process.on('uncaughtException', (err) => handleCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleCrash('unhandledRejection', reason));
