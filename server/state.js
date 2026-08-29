/**
 * 空間狀態矩陣 (Spatial State Matrix)
 *
 * 目前以行程內記憶體保存。技術文件第 2 層規劃 Redis，但單一投影場域的
 * 狀態量（約 30 個角色 × 每 tick 更新）不需要跨行程共享，過早引入 Redis
 * 只會增加部署複雜度與一次網路往返。待需要多場域或伺服器水平擴展時，
 * 本類別的介面即為抽換點。
 */

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { STAGE, AGENT_STATE, AGENT_MODE, TEAM_IDS } from '../shared/protocol.js';
import { OBSTACLES, zoneAt } from '../shared/scene.js';
import {
  EMOTE_DURATION_MS, EMOTE_COOLDOWN_MS, AGENT_TTL_MS, INPUT_DEADZONE,
  MAX_AGENTS,
} from './config.js';
import { stepAgent } from './arbiter.js';

/**
 * 挑一個不落在道具內的出生點。
 * 實測直接隨機有約 1.5% 的機率生在沙發或盆栽裡，
 * 雖然剛體修正會在第一個 tick 把角色彈出來，但觀眾看得到那一下。
 */
function spawnPoint() {
  for (let i = 0; i < 30; i++) {
    const x = STAGE.width * (0.3 + Math.random() * 0.4);
    const y = STAGE.height * (0.3 + Math.random() * 0.4);
    // 多留一點餘裕，避免出生就緊貼道具邊緣
    if (!OBSTACLES.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + 30)) return { x, y };
  }
  return { x: STAGE.width / 2, y: STAGE.height / 2 };
}

/**
 * 隊伍分派的不變式：場上不存在沒有隊伍的角色。
 *
 * 「不要無隊伍」是刻意的需求 —— 沒有它，每個下游（計分聚合、跨隊配對
 * 判定、大螢幕色標）都要各自判空，而漏判的症狀是角色沒有顏色、
 * 或跨隊任務把他算成兩邊都不是。集中在這裡保證之後，下游可以直接信任
 * agent.team 一定有效。
 *
 * 缺答案時**補位而非拒絕**：伺服器不能假設前端一定帶 team
 * （舊版前端、手動送 WebSocket 都可能沒有），但拒絕入場會違反
 * 「掃描失敗一律降級，不擋人進場」那條鐵律。補位順便平衡人數 ——
 * 往人少的隊丟，兩隊人數差因此不會超過 1。
 *
 * @param {Map<string, object>} agents 目前場上的角色
 * @param {*} requested 客戶端聲稱的隊伍，未驗證
 * @returns {string} 必定是 TEAM_IDS 裡的其中一個
 */
function assignTeam(agents, requested) {
  if (TEAM_IDS.includes(requested)) return requested;

  const counts = Object.fromEntries(TEAM_IDS.map((t) => [t, 0]));
  for (const a of agents.values()) {
    if (counts[a.team] !== undefined) counts[a.team]++;
  }
  const fewest = Math.min(...TEAM_IDS.map((t) => counts[t]));
  const candidates = TEAM_IDS.filter((t) => counts[t] === fewest);
  // 同數時隨機，避免每次重開伺服器前幾個人都固定進同一隊
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** 定時安全比較，避免以回應時間差逐字元試出 token */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class Stage {
  constructor() {
    /** @type {Map<string, object>} */
    this.agents = new Map();
    this.rosterDirty = true; // 名冊是否需要重新廣播
    this.locked = false;     // 場域是否處於定位鎖定狀態（合照等流程）
  }

  /** 場域是否已達人數上限 */
  isFull() {
    return this.agents.size >= MAX_AGENTS;
  }

  /**
   * 建立新角色。出生點散佈在場域中央區域，避免全部疊在同一點。
   *
   * identity 用於伺服器重開後的認領（見 restoreAgent）：帶著原本的 id 與憑證
   * 重建角色，積分與社交圖譜自然接得回去 —— 它們都是掛在 id 上的。
   *
   * @returns {object|null} 達人數上限、或該 id 已在場上時回傳 null
   */
  addAgent({ name, avatar, id: keepId = null, rejoinToken: keepToken = null, team = null }) {
    if (this.isFull()) return null;
    if (keepId && this.agents.has(keepId)) return null;
    const id = keepId ?? `usr_${randomUUID().slice(0, 8)}`;
    const agent = {
      id,
      name,
      avatar,
      // 破冰分組。這是所有角色建立路徑的單一咽喉點（claimAgent 也走這裡），
      // 因此「場上不存在沒有隊伍的角色」這條不變式只需要在 assignTeam 保證一次。
      team: assignTeam(this.agents, team),
      // 重連憑證：僅存於伺服器，絕不出現在 STAGE_ROSTER / STAGE_SYNC 等任何廣播中。
      // 只在 CLIENT_WELCOME 中單獨回傳給該角色本人的連線。
      rejoinToken: keepToken ?? randomBytes(16).toString('hex'),
      // 位置與實際速度
      ...spawnPoint(),
      vx: 0,
      vy: 0,
      heading: Math.random() * Math.PI * 2, // 3D 用的完整朝向角（弧度）
      // Boids 影子速度（見 boids.js 的關鍵設計說明）
      boidsVx: (Math.random() - 0.5) * 60,
      boidsVy: (Math.random() - 0.5) * 60,
      wanderAngle: Math.random() * Math.PI * 2,
      // M2 仲裁狀態
      alpha: 0,
      decayStartAt: null,
      decayFrom: 0,
      // 靜止模式的煞停狀態（IDLE_MOTION === 'still'，見 arbiter.js）。
      // null 代表沒有正在進行的煞停。
      brakeFrom: null,
      brakeStartAt: 0,
      // 定位鎖定。targetX 為 null 代表角色自由活動；
      // 合照等情境由 lockStage() 指派目標，見該方法的說明。
      targetX: null,
      targetY: null,
      targetHeading: null,
      lockAlpha: 0,
      arrived: false,
      inputX: 0,
      inputY: 0,
      inputIntensity: 0,
      // 平滑後的手動速度（見 arbiter.js）。原始輸入是單位向量，
      // 直接使用會讓回中時的手指抖動變成全速的方向反轉。
      manualVx: 0,
      manualVy: 0,
      lastInputAt: 0, // 0 代表從未輸入過 → 一出生即為漫遊態
      // 連線狀態
      disconnectedAt: null,
      offline: false,
      // 渲染提示
      state: AGENT_STATE.IDLE,
      // 目前所在分區（shared/scene.js 的 ZONES）。null 代表在分區外。
      zone: null,
      mode: AGENT_MODE.SWARM,
      facing: 1,
      // 翻面防抖：累積中的反向與其持續時間（見 arbiter.js 的 updateFacing）
      facingPendingDir: null,
      facingPendingMs: 0,
      emote: null,
      lastEmoteAt: 0,
      // 行為 Log（WP-C 數據收集 / M4 活躍度加權的原始資料）
      joinedAt: Date.now(),
      activeMs: 0,
      emoteCount: 0,
    };
    this.agents.set(id, agent);
    this.rosterDirty = true;
    return agent;
  }

  get(id) {
    return this.agents.get(id);
  }

  /**
   * 套用搖桿輸入。
   * 技術文件在 M1 規格與 §3 協定表使用了兩種略有出入的 payload 形狀
   * （vector+intensity 與 vx/vy），此處統一在入口正規化，兩種都接受。
   */
  applyMove(id, { x, y, intensity }) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const mag = Math.hypot(x, y);
    if (mag > 0) {
      agent.inputX = x / mag;
      agent.inputY = y / mag;
    } else {
      agent.inputX = 0;
      agent.inputY = 0;
    }
    // 僅在推桿強度超過死區時才算主動操控並重置閒置計時器；
    // 手指微顫或搖桿歸位殘值不應把角色留在 Active 態
    if (intensity > INPUT_DEADZONE) {
      agent.inputIntensity = intensity;
      agent.lastInputAt = Date.now();
    } else {
      agent.inputIntensity = 0;
    }
  }

  /** 觸發社交動作，回傳是否成功（false 代表仍在冷卻中） */
  applyAction(id, action) {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const now = Date.now();
    if (now - agent.lastEmoteAt < EMOTE_COOLDOWN_MS) return false;
    agent.lastEmoteAt = now;
    agent.emote = { action, until: now + EMOTE_DURATION_MS };
    agent.emoteCount++;
    return true;
  }

  /** 標記斷線。角色不立即移除，讓大螢幕能無縫轉入 Boids 而非憑空消失 */
  markDisconnected(id) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.disconnectedAt = Date.now();
    agent.inputIntensity = 0;
    this.rosterDirty = true;
  }

  /**
   * 斷線重連：手機在 AGENT_TTL_MS 內帶著原 userId 與憑證回來時接回同一角色。
   * 現場無線網路瞬斷是常態，若每次重連都新建角色，場上會迅速堆滿幽靈。
   *
   * 必須驗證 rejoinToken：初版只憑客戶端自稱的 userId 就交出角色，
   * 任何人都能在他人瞬斷的空檔冒名接管其角色並改掉顯示名稱。
   *
   * @returns {object|null} 成功接回的角色；憑證不符或角色不存在皆回傳 null
   *   （兩種失敗回傳相同結果，不讓呼叫端據以判斷該 userId 是否存在）
   */
  reattach(id, rejoinToken) {
    const agent = this.agents.get(id);
    if (!agent || agent.disconnectedAt === null) return null;
    if (!tokensMatch(agent.rejoinToken, rejoinToken)) return null;
    agent.disconnectedAt = null;
    agent.offline = false;
    this.rosterDirty = true;
    return agent;
  }

  removeAgent(id) {
    if (this.agents.delete(id)) this.rosterDirty = true;
  }

  /**
   * 伺服器重開後的認領。
   *
   * reattach() 只在角色還活在記憶體裡時有用；伺服器重開後整個 Map 是空的，
   * 那時要靠身分目錄（persistence.js）裡的憑證重建同一個 id 的角色。
   * 角色是全新出生的（座標、速度都重來），但身分不變，
   * 因此積分、社交圖譜、任務進度全部自動接回。
   *
   * @param {{id: string, name: string, avatar: object, team?: string, rejoinToken: string}} entry 目錄項目
   * @param {string} rejoinToken 客戶端出示的憑證
   * @returns {object|null} 憑證不符、id 已在場上、或人數已滿時皆回傳 null
   */
  claimAgent(entry, rejoinToken) {
    if (!entry || !tokensMatch(entry.rejoinToken, rejoinToken)) return null;
    if (this.agents.has(entry.id)) return null;
    return this.addAgent({
      name: entry.name,
      avatar: entry.avatar,
      id: entry.id,
      rejoinToken: entry.rejoinToken,
      // 隊伍必須跟著身分回來。少了這一行，重連的人會被 assignTeam
      // 重新隨機分派，而他先前的分數仍記在原隊帳上 ——
      // 現場的症狀是「我怎麼變成敵隊了」。
      team: entry.team ?? null,
    });
  }

  // ───────────────────────────────────────────────────────────
  // 定位鎖定
  //
  // 提供給合照（M4）等需要把角色帶到指定位置的流程。
  // 本類別只負責「機制」—— 把角色平滑帶到指定座標並回報是否到位；
  // 「隊形」（誰站哪、怎麼排）屬於呼叫端的決策，不寫在這裡。
  // 這條界線讓 M4 可以任意更換排版演算法而完全不必動 M2。
  // ───────────────────────────────────────────────────────────

  /**
   * 鎖定場域並指派定位。鎖定期間使用者操控與群體動力都不生效，
   * 角色會以 ARRIVE.takeoverMs 平滑接管後移向目標。
   *
   * @param {Map<string, {x:number, y:number, heading?:number}>} assignments
   *   agentId → 目標位置。heading 為到位後的朝向（弧度），
   *   合照時通常全部設成面向鏡頭。未指定則保持行進方向。
   * @returns {number} 實際被指派的角色數
   */
  lockStage(assignments) {
    let n = 0;
    for (const [id, spot] of assignments) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      agent.targetX = spot.x;
      agent.targetY = spot.y;
      agent.targetHeading = typeof spot.heading === 'number' ? spot.heading : null;
      agent.arrived = false;
      n++;
    }
    this.locked = n > 0;
    return n;
  }

  /** 解除鎖定，角色平滑地重新加入人群 */
  unlockStage() {
    for (const agent of this.agents.values()) {
      agent.targetX = null;
      agent.targetY = null;
      agent.targetHeading = null;
      agent.arrived = false;
    }
    this.locked = false;
  }

  /**
   * 是否所有被指派的角色都已就定位。
   * 合照流程應輪詢此值，等到位後再拍 —— 而不是用固定秒數等待，
   * 因為移動時間取決於角色原本散得多開。
   */
  allArrived() {
    let assigned = 0;
    for (const agent of this.agents.values()) {
      if (agent.targetX === null) continue;
      assigned++;
      if (!agent.arrived) return false;
    }
    return assigned > 0;
  }

  /**
   * 推進整個場域一個時間步。
   * @param {number} dt 時間步長（秒）
   * @param {{neighbors: (id: string) => Set<string>}|null} graph
   *   社交圖譜。傳入時，配對過的角色之間會有較強的凝聚力（規格 v3.0 §4.2）。
   */
  tick(dt, graph = null) {
    const now = Date.now();
    const agents = [...this.agents.values()];
    /** @type {{id: string, from: string|null, to: string|null}[]} 本幀的分區進出 */
    const transitions = [];

    for (const agent of agents) {
      stepAgent(agent, agents, dt, now, graph ? graph.neighbors(agent.id) : null);

      // 累計主動操控時長，作為 WP-C 行為 Log 與 M4 構圖加權的依據
      if (agent.alpha > 0.5) agent.activeMs += dt * 1000;

      // 分區進出。只在「換區」時記一筆，呼叫端據此推播 ——
      // 每幀回報所在分區的話，30Hz × 10 人就是每秒 300 則重複訊息。
      const zone = zoneAt(agent.x, agent.y);
      if (zone !== agent.zone) {
        transitions.push({ id: agent.id, from: agent.zone, to: zone });
        agent.zone = zone;
      }

      if (agent.emote && now > agent.emote.until) agent.emote = null;

      // 長時間斷線才真正移除，期間若使用者重新連線可沿用同一角色
      if (agent.disconnectedAt !== null && now - agent.disconnectedAt > AGENT_TTL_MS) {
        this.removeAgent(agent.id);
      }
    }

    return transitions;
  }

  /** 目前各分區裡有誰。供大螢幕高亮與「合力開門」這類需要人數的玩法 */
  zoneOccupancy() {
    const out = {};
    for (const a of this.agents.values()) {
      if (!a.zone) continue;
      (out[a.zone] ??= []).push(a.id);
    }
    return out;
  }

  /**
   * 產生 STAGE_SYNC 的精簡快照。
   * 刻意不含捏臉外觀 —— 那是靜態資料，由 STAGE_ROSTER 另行傳送，
   * 否則 30 FPS × 30 人的重複外觀資料會佔滿現場無線頻寬。
   */
  snapshot() {
    const round = (n) => Math.round(n * 10) / 10;
    const round3 = (n) => Math.round(n * 1000) / 1000;
    const now = Date.now();
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      x: round(a.x),
      y: round(a.y),
      vx: round(a.vx),
      vy: round(a.vy),
      // 完整朝向角（弧度）。3D 角色需要它；2D 備援版本用 facing。
      heading: round3(a.heading),
      state: a.state,
      mode: a.mode,
      alpha: Math.round(a.alpha * 100) / 100,
      facing: a.facing,
      offline: a.offline,
      emote: a.emote ? a.emote.action : null,
      // 以下兩欄只在有意義時才送。它們絕大多數時間都是預設值，
      // 而這是每秒 30 次 × 30 人的廣播 —— 與捏臉外觀不放進 STAGE_SYNC
      // 是同一個理由。渲染端讀到 undefined 與讀到預設值等價。
      ...(a.emote && {
        // 社交動作進度 0~1，供渲染端對齊動畫相位；
        // 中途連上的大螢幕才不會把已播一半的動作從頭再播一次
        emoteT: round3(Math.max(0, Math.min(1,
          1 - (a.emote.until - now) / EMOTE_DURATION_MS))),
      }),
      // 定位鎖定時才有意義，供合照流程判斷是否可以拍
      ...(a.arrived && { arrived: true }),
    }));
  }

  /**
   * 個人視角快照：某個角色自己 + 半徑內的鄰居。
   *
   * 與 snapshot() 的差別不只是過濾 —— 回傳的鄰居座標是**相對於自己**的。
   * 手機端把自己畫在畫面中央，需要的本來就是相對位移；
   * 在伺服器換算可以少送一組絕對座標，也讓手機端不必知道場域原點。
   *
   * 鄰居欄位刻意比 snapshot() 更精簡：手機上的鄰居只有幾十像素高，
   * alpha / mode / emoteT 之類的欄位在那個尺寸下完全看不出來。
   *
   * @param {string} id 觀察者的角色 id
   * @param {number} radius 可見半徑（邏輯單位）
   * @returns {{self: object, neighbors: object[]}|null} 角色不存在時回傳 null
   */
  personalSnapshot(id, radius) {
    const me = this.agents.get(id);
    if (!me) return null;

    const round = (n) => Math.round(n * 10) / 10;
    const round3 = (n) => Math.round(n * 1000) / 1000;
    const r2 = radius * radius;

    const neighbors = [];
    for (const a of this.agents.values()) {
      if (a.id === id) continue;
      const dx = a.x - me.x;
      const dy = a.y - me.y;
      if (dx * dx + dy * dy > r2) continue;
      neighbors.push({
        id: a.id,
        dx: round(dx),
        dy: round(dy),
        facing: a.facing,
        state: a.state,
        // 有社交動作時才帶，與 snapshot() 同一個省頻寬的理由
        ...(a.emote && { emote: a.emote.action }),
      });
    }

    return {
      self: {
        x: round(me.x),
        y: round(me.y),
        vx: round(me.vx),
        vy: round(me.vy),
        heading: round3(me.heading),
        state: me.state,
        mode: me.mode,
        // α 是手機端唯一需要的仲裁資訊：它決定「你正在操控」的提示
        alpha: Math.round(me.alpha * 100) / 100,
        facing: me.facing,
        // 所在分區。手機端據此顯示「你在暢飲區」，與 ZONE_SELF 的
        // 進出事件互補：這個是狀態，那個是事件（重連時只有狀態拿得到）
        zone: me.zone,
      },
      neighbors,
    };
  }

  /**
   * 手機端用的精簡名冊：只有 id 與名字。
   *
   * 與 roster() 分開是因為手機不需要捏臉外觀 —— POV 畫布上的鄰居
   * 只有幾十像素高，不載入貼圖（見 avatarRenderer 的 _drawNeighbors）。
   * 名字放這裡而非塞進 CLIENT_SYNC 的每個鄰居：名字是靜態資料，
   * 隨 15Hz 的座標重送等於每秒多送十幾 KB 的重複字串。
   */
  nameRoster() {
    return [...this.agents.values()].map((a) => ({ id: a.id, name: a.name }));
  }

  /** 參與者名冊：id、顯示名稱、捏臉設定與隊伍，僅在成員變動時廣播 */
  roster() {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      // 大螢幕據此畫隊伍色標。這裡是逐欄白名單而非整個 agent 序列化，
      // rejoinToken 因此不會混進廣播 —— 新增欄位時務必維持這個形狀。
      team: a.team,
    }));
  }
}
