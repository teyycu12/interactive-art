/**
 * 手機端個人視角畫布（POV Canvas）
 *
 * 角色固定在畫面中央，世界（網格與鄰居）相對移動。
 *
 * ── 座標的真實來源是伺服器 ──
 * CLIENT_SYNC（10Hz）送來自己的絕對座標與鄰居的相對位移。
 * 手機端**不自己模擬位置** —— 這是與 issue #8（投影牆跑自己的 Boids）
 * 刻意相反的選擇：本地模擬會讓使用者低頭看到自己穿牆、
 * 抬頭卻看見大螢幕上的角色卡在牆邊。
 *
 * 本地預測只用於兩件事，都不會與伺服器產生位置分歧：
 *   1. 步態相位（走路動畫與腳步震動）—— 純視覺，不影響座標
 *   2. 兩次 CLIENT_SYNC 之間的網格視差內插 —— 收到新封包即校正
 *
 * 伺服器沉默時（尚未連上、或 α 仲裁把控制權收回）畫面會停在最後
 * 已知狀態，而不是繼續往前推 —— 寧可靜止，不要走出一個假的位置。
 *
 * 步態一律 import shared/character.js，不另抄常數。
 */

import {
  drawCharacter, drawNameplate, drawEmote, stepIndex, emoteIsPosed, gaitPhase,
  measureNameplate, NAMEPLATE_DROP,
} from '/shared/character.js';
import { layoutNameplates } from '/shared/nameplateLayout.js';
import { avatarImage } from '/shared/avatarSprite.js';
import {
  sceneBackdrop, scenePainter, ORIGIN_X, ORIGIN_Y, ROOM_W, ROOM_H, BODY_UNITS, OUTSIDE,
} from './sceneBackdrop.js';
import {
  MAX_SPEED, CLIENT_SYNC_MS, CLIENT_SYNC_RADIUS, EMOTE_GLYPH, WALK_THRESHOLD,
} from '/shared/protocol.js';

const GRID_SIZE = 72;          // 背景網格間距（CSS px）
const GRID_PARALLAX = 0.45;    // 網格相對角色速度的位移比例，低於 1 才有景深感
const CHARACTER_HEIGHT = 190;  // 手機上的角色高度
const HORIZON_RATIO = 0.52;    // 地平線位置，角色腳底站在其下方
// 觸地判定的速度下限。必須明顯高於低通濾波的殘餘速度，
// 否則角色停下後濾波尾巴會繼續觸發震動。
const FOOTSTEP_MIN_SPEED = 0.12;

/** 場域單位 → 畫面像素。鄰居的相對位移用它換算成畫布距離。 */
const WORLD_TO_PX = 0.42;
/** 鄰居身高相對主角的比例，製造前後景深 */
const NEIGHBOR_SCALE = 0.72;

/**
 * 伺服器狀態的過期時限。
 *
 * 超過這個時間沒收到 CLIENT_SYNC 就停止外推 —— 網路斷掉時
 * 角色應該停在原地，而不是以最後的速度一路飄出場外。
 * 取兩個同步週期，容得下一次封包遺失。
 */
const SYNC_STALE_MS = CLIENT_SYNC_MS * 2;


export class AvatarRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} avatar  捏臉或掃描生成的外觀設定
   */
  constructor(canvas, avatar) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    /** 名牌目前的位移，逐幀朝避讓結果內插（同大螢幕的 drawPlate） */
    this.plateOffset = new Map();
    this.sprite = avatar ? avatarImage(avatar) : null;
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? { matches: false };

    // 背景網格的累積位移。角色不動，世界動。
    this.scrollX = 0;
    this.scrollY = 0;

    // 目前用於繪製的速度（場域單位／秒的正規化值，0..1）。
    // 有伺服器狀態時由 CLIENT_SYNC 決定，否則維持 0。
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;

    /** 伺服器送來的最新自身狀態；null 代表尚未收到任何 CLIENT_SYNC */
    this.serverSelf = null;
    /** 鄰居（相對座標）。內插用，鍵為角色 id。 */
    this.neighbors = new Map();
    /** 最後一次收到 CLIENT_SYNC 的時間，用於判斷狀態是否過期 */
    this.lastSyncAt = 0;
    /** id → 名字（CLIENT_ROSTER）。名字是靜態資料，不隨座標重送。 */
    this.names = new Map();
    /** id → 鄰居的像素角色（由 CLIENT_ROSTER 的 look 產生），以及產生它的 look 指紋 */
    this.looks = new Map();

    // ── 場景視角 ──
    // 有像素底圖時，畫面是大螢幕同一張場景的局部，鏡頭跟著自己。
    // 沒有（3D 主題、或還不知道主題）時退回原本的地面網格。
    this.backdrop = null;
    /** 自己在場域上的顯示位置（平滑過的伺服器座標），鏡頭中心 */
    this.selfPos = null;
    /** 這一幀鄰居的點擊框（見 pickAt） */
    this.hitboxes = [];
    /** 累計走過的距離（身高數）。步伐換腳與腳步震動都以它為準。 */
    this.travel = 0;
    this._lastStep = null;
    /** 角色要站在哪個元素的範圍內（搖桿區）。由 app.js 指定，見 setAnchorElement。 */
    this.anchorEl = null;
    this.anchorBox = null;

    this.running = false;
    this.lastAt = 0;
    this.time = 0;
    this._frame = null;
    this._onFootstep = null;

    // 觸地偵測：步態相位過零時觸發。詳見 _detectFootstep。
    this._contactHalf = null;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    this._resize();
  }

  /** 更換角色外觀（例如掃描生成完成後） */
  setAvatar(avatar) {
    this.sprite = avatar ? avatarImage(avatar) : null;
  }

  /**
   * 切換場景主題（EV.STAGE_THEME）。像素主題會畫出與大螢幕相同的底圖，
   * 3D 主題沒有像素底圖，回到地面網格。
   */
  setTheme(themeId) {
    this.backdrop = sceneBackdrop(themeId);
    this.props = scenePainter(themeId);
  }

  /**
   * 角色站在這個元素的範圍中央（元素本身是透明的搖桿區）。
   * 用實際版面決定而非寫死比例：直式與橫式的搖桿區位置完全不同，
   * 任務橫幅出現時也會把它往下推。
   */
  setAnchorElement(el) {
    this.anchorEl = el;
    this._measureAnchor();
    if (typeof ResizeObserver !== 'undefined' && el) {
      this._anchorObserver?.disconnect();
      this._anchorObserver = new ResizeObserver(() => this._measureAnchor());
      this._anchorObserver.observe(el);
    }
  }

  _measureAnchor() {
    const el = this.anchorEl;
    if (!el?.getBoundingClientRect || !this.canvas.getBoundingClientRect) { this.anchorBox = null; return; }
    const z = el.getBoundingClientRect();
    const c = this.canvas.getBoundingClientRect();
    this.anchorBox = { x: z.left - c.left, y: z.top - c.top, w: z.width, h: z.height };
  }

  /** 註冊觸地回呼，供 app.js 接上震動 */
  onFootstep(fn) {
    this._onFootstep = fn;
  }

  /**
   * 餵入搖桿輸入。座標系與 INPUT_MOVE 一致（y 向下為正）。
   *
   * 注意這**不會**移動角色 —— 位置一律由 CLIENT_SYNC 決定。
   * 這裡只在尚未收到任何伺服器狀態時（剛進場、連線中）提供即時的
   * 步態回饋，讓搖桿不會有一段完全沒反應的空窗期。
   *
   * @param {{x:number,y:number}} vector 單位向量
   * @param {number} intensity 0..1
   */
  setInput(vector, intensity) {
    this.inputVx = (vector?.x ?? 0) * intensity;
    this.inputVy = (vector?.y ?? 0) * intensity;
  }

  /**
   * 套用手機端名冊（EV.CLIENT_ROSTER）。
   * @param {{id:string,name:string}[]} agents
   */
  setNames(agents) {
    this.names = new Map(agents.map((a) => [a.id, a.name]));
    // 鄰居外觀：只在 look 真的變了才重畫 12 格，名冊重送時其他人不必重建
    const next = new Map();
    for (const a of agents) {
      if (!a.look) continue;
      const key = JSON.stringify(a.look);
      const prev = this.looks.get(a.id);
      next.set(a.id, prev?.key === key ? prev : { key, sprite: avatarImage(a.look) });
    }
    this.looks = next;
  }

  /**
   * 套用伺服器送來的個人視角狀態（EV.CLIENT_SYNC）。
   * @param {{self: object, neighbors: object[]}} view
   */
  applySync(view) {
    if (!view?.self) return;
    this.serverSelf = view.self;
    this.lastSyncAt = performance.now();

    // 鄰居：就地更新既有條目，讓內插能從上一個位置接續。
    // 整個 Map 重建會讓每個鄰居在每次同步時瞬移。
    const seen = new Set();
    for (const n of view.neighbors ?? []) {
      seen.add(n.id);
      const prev = this.neighbors.get(n.id);
      // 絕對座標：相對位移是以「伺服器上的自己」為準，換回場域座標後
      // 才能與平滑過的鏡頭分開內插，否則自己一動，所有鄰居都跟著抖
      const ax = view.self.x + n.dx;
      const ay = view.self.y + n.dy;
      if (prev) {
        prev.fromDx = prev.dx; prev.fromDy = prev.dy;
        prev.dx = n.dx; prev.dy = n.dy;
        prev.fromAx = prev.x ?? ax; prev.fromAy = prev.y ?? ay;
        prev.ax = ax; prev.ay = ay;
        prev.facing = n.facing; prev.heading = n.heading; prev.view = n.view; prev.state = n.state; prev.emote = n.emote;
        prev.t = 0;
      } else {
        // 新出現的鄰居直接就位，不從畫面中心滑進來
        this.neighbors.set(n.id, {
          ...n, fromDx: n.dx, fromDy: n.dy, ax, ay, fromAx: ax, fromAy: ay,
          x: ax, y: ay, vx: 0, vy: 0, travel: 0, t: 1,
        });
      }
    }
    for (const id of this.neighbors.keys()) {
      if (!seen.has(id)) { this.neighbors.delete(id); this.plateOffset.delete(id); }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastAt = performance.now();
    addEventListener('resize', this._resize);
    this._frame = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    removeEventListener('resize', this._resize);
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  _resize() {
    this._measureAnchor?.();
    // 低階手機上 devicePixelRatio 可能是 3，全螢幕畫布的填色成本會跟著平方成長。
    // 上限壓在 2：視覺差異在這個尺寸下幾乎看不出來，幀率差異則很明顯。
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.canvas.width = Math.ceil(w * dpr);
    this.canvas.height = Math.ceil(h * dpr);
    this.w = w;
    this.h = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _tick(now) {
    if (!this.running) return;
    // 分頁切回來時 dt 可能是好幾秒，夾住上限避免網格瞬間飛走
    const dt = Math.min((now - this.lastAt) / 1000, 0.05);
    this.lastAt = now;
    this.time += dt;

    this._update(dt, now);
    this._draw();

    this._frame = requestAnimationFrame(this._tick);
  }

  _update(dt, now) {
    const fresh = this.serverSelf && (now - this.lastSyncAt) < SYNC_STALE_MS;

    if (fresh) {
      // ── 伺服器是唯一的位置來源 ──
      // 速度正規化回 0..1，讓步態的 cadence 與大螢幕落在同一個尺度。
      const target = {
        x: this.serverSelf.vx / MAX_SPEED,
        y: this.serverSelf.vy / MAX_SPEED,
      };
      // 仍做一次平滑：10Hz 的速度變化直接套用會讓步頻一格一格跳。
      // 這只影響動畫，不影響位置，因此不會與伺服器分歧。
      const k = 1 - Math.exp(-dt / 0.08);
      this.vx += (target.x - this.vx) * k;
      this.vy += (target.y - this.vy) * k;
      this.facing = this.serverSelf.facing;
      this.view = this.serverSelf.view;
    } else if (this.serverSelf) {
      // 狀態過期（掉封包或斷線）：收斂到靜止，不外推位置。
      // 繼續以最後速度前進會讓角色一路飄出場外，與大螢幕徹底脫節。
      const k = 1 - Math.exp(-dt / 0.25);
      this.vx += (0 - this.vx) * k;
      this.vy += (0 - this.vy) * k;
    } else {
      // 尚未收到任何 CLIENT_SYNC（剛進場）：暫時用搖桿輸入驅動步態，
      // 讓使用者推桿時立刻有回饋。第一則同步到達後這條分支就不再走。
      const k = 1 - Math.exp(-dt / 0.12);
      this.vx += ((this.inputVx ?? 0) - this.vx) * k;
      this.vy += ((this.inputVy ?? 0) - this.vy) * k;
      if (Math.abs(this.vx) > 0.08) this.facing = this.vx > 0 ? 1 : -1;
    }

    const speed = Math.hypot(this.vx, this.vy);

    // 世界往角色前進的反方向捲動。用速度而非座標差分積分，
    // 是為了讓 10Hz 的同步之間仍有連續的視差，不會每 100ms 頓一下。
    this.scrollX -= this.vx * MAX_SPEED * GRID_PARALLAX * dt;
    this.scrollY -= this.vy * MAX_SPEED * GRID_PARALLAX * dt;

    // 自己的顯示位置：以最後一次同步為起點、依速度外推到現在，再平滑逼近。
    // 鏡頭中心就是它 —— 世界在腳下移動的距離與換腳的距離因此是同一個數。
    if (this.serverSelf) {
      const age = fresh ? Math.min(now - this.lastSyncAt, SYNC_STALE_MS) / 1000 : 0;
      const tx = this.serverSelf.x + (fresh ? this.serverSelf.vx * age : 0);
      const ty = this.serverSelf.y + (fresh ? this.serverSelf.vy * age : 0);
      if (!this.selfPos) {
        this.selfPos = { x: tx, y: ty };
      } else {
        const k = 1 - Math.exp(-dt / 0.06);
        const nx = this.selfPos.x + (tx - this.selfPos.x) * k;
        const ny = this.selfPos.y + (ty - this.selfPos.y) * k;
        const moved = Math.hypot(nx - this.selfPos.x, ny - this.selfPos.y);
        if (moved < BODY_UNITS) this.travel += moved / BODY_UNITS;
        this.selfPos = { x: nx, y: ny };
      }
    } else {
      // 還沒有伺服器座標：用搖桿輸入推算，讓剛推桿時腳就會動
      this.travel += (speed * MAX_SPEED * dt) / BODY_UNITS;
    }

    // 鄰居內插：把上一次的座標推進到最新值
    for (const n of this.neighbors.values()) {
      if (n.t < 1) n.t = Math.min(1, n.t + dt / (CLIENT_SYNC_MS / 1000));
      const x = n.fromAx + (n.ax - n.fromAx) * n.t;
      const y = n.fromAy + (n.ay - n.fromAy) * n.t;
      const moved = Math.hypot(x - n.x, y - n.y);
      if (moved < BODY_UNITS) n.travel += moved / BODY_UNITS;
      if (dt > 0) { n.vx = (x - n.x) / dt; n.vy = (y - n.y) / dt; }
      n.x = x; n.y = y;
    }

    this._detectFootstep(speed);
  }

  /**
   * 觸地偵測：震動與畫面上的腳步同一把尺。
   *
   * 捏臉的像素角色依走過的距離換腳（stepIndex）；拍照角色依 drawCharacter
   * 累加的步伐相位（gaitPhase），一個循環左右腳各著地一次。兩條都直接讀畫面
   * 用的那個數，不另算一份 —— 另算的話步頻公式一改，震動就與腳步錯開。
   */
  _detectFootstep(speed) {
    // 像素角色的換腳由走過的距離決定（shared/character.js 的 STEP_BODIES），
    // 震動要跟著同一把尺，否則腳踏下去的那一格與震動會錯開。
    if (this.sprite?.pixelFrames) {
      const step = stepIndex(this.travel);
      if (speed >= FOOTSTEP_MIN_SPEED && this._lastStep !== null && step !== this._lastStep) {
        this._onFootstep?.();
      }
      this._lastStep = step;
      return;
    }

    // 門檻要高於 _update 低通濾波的殘量。濾波是指數收斂，速度會長時間
    // 停在 0 附近的極小值 —— 門檻壓太低會讓角色明明站著不動卻持續震動。
    if (speed < FOOTSTEP_MIN_SPEED) { this._contactHalf = null; return; }

    // 拍照角色：直接讀畫面上的步伐相位（shared/character.js 的 gaitPhase），
    // 起伏最低點（相位 π/2、3π/2，兩腳張到最開、走路格的第 2、6 格）是腳著地。
    // 不在這裡另算一份相位：步頻公式一改，震動就與畫面上的腳步錯開。
    // _contactHalf 為 null 代表剛從靜止起步，不算一次觸地。
    const phase = gaitPhase('self');
    if (phase === null) return;
    const TAU = Math.PI * 2;
    const half = Math.floor((((phase - Math.PI / 2) % TAU) + TAU) % TAU / Math.PI);
    if (this._contactHalf != null && half !== this._contactHalf) this._onFootstep?.();
    this._contactHalf = half;
  }

  /**
   * 點擊判定：手機畫面上的某一點落在哪個鄰居身上（私訊用）。
   *
   * 框在每一幀畫的時候記下來（_hit），與畫面上的位置完全一致，不另外重算一套投影。
   * 由後往前找：後畫的人站得比較前面、蓋在上面，手指點到的應該是他。
   * @returns {string|null} 鄰居的 id；沒點到人（或點到自己）回 null
   */
  pickAt(clientX, clientY) {
    return this.pickAllAt(clientX, clientY)[0] ?? null;
  }

  /**
   * 這一點落在哪些鄰居身上，站得越前面（蓋在上面）的排越前。
   *
   * 幾個人擠在一起時點擊框會重疊（遠處的人框被撐到 44px，比本人寬），
   * 只回最上面那個的話，常常點到旁邊的人（2026-10-17 試玩回饋）。
   * 呼叫端拿到兩個以上時讓使用者自己選。
   * @returns {string[]}
   */
  pickAllAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const out = [];
    for (let i = this.hitboxes.length - 1; i >= 0; i--) {
      const b = this.hitboxes[i];
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && !out.includes(b.id)) out.push(b.id);
    }
    return out;
  }

  /**
   * 記下一個鄰居的點擊框（腳底在 pos、身高 height 的角色）。
   * 小於 44px 的一律撐到 44px —— 遠處的人在手機上只有二十幾 px 高，照實際大小根本點不到。
   */
  _hit(id, pos, height) {
    const w = Math.max(44, height * 0.64);
    const h = Math.max(44, height + 10);
    this.hitboxes.push({ id, x0: pos.x - w / 2, x1: pos.x + w / 2, y0: pos.y + 10 - h, y1: pos.y + 10 });
  }

  _draw() {
    this.hitboxes = [];
    if (this.backdrop) { this._drawScene(); return; }
    const { ctx, w, h } = this;
    const horizon = h * HORIZON_RATIO;

    ctx.clearRect(0, 0, w, h);
    this._drawSky(horizon);
    this._drawGround(horizon);

    // 角色永遠站在畫面中央偏下的固定點
    const footY = horizon + (h - horizon) * 0.46;
    const speed = Math.hypot(this.vx, this.vy);

    // 鄰居先畫，主角後畫 —— 主角永遠在最上層，不會被別人擋住
    this._drawNeighbors(footY, horizon);

    // drawCharacter 需要一份 agent 形狀的狀態。速度換算回場域單位，
    // 讓 cadence() 的內插與大螢幕落在同一個尺度上。
    // 門檻用場域單位比較（this.vx 是正規化速度，×MAX_SPEED 才是場域單位），
    // 與伺服器的 WALK_THRESHOLD 同一把尺 —— 否則手機會說 WALK、
    // 大螢幕說 IDLE，同一個角色在兩個畫面上狀態不一致。
    const agent = {
      state: speed * MAX_SPEED > WALK_THRESHOLD ? 'WALK' : 'IDLE',
      vx: this.vx * MAX_SPEED,
      vy: this.vy * MAX_SPEED,
      facing: this.facing,
      // 像素角色依 heading 選方向。用伺服器的值，手機與大螢幕才會面向同一邊；
      // 還沒收到同步時是 undefined，drawCharacter 會改用速度推算。
      heading: this.serverSelf?.heading,
      // 拍照生成的角色依伺服器的 view 換面（正面／背面／側面）
      view: this.view,
    };

    drawCharacter(ctx, agent, { x: w / 2, y: footY }, this.sprite, {
      time: this.time,
      maxSpeed: MAX_SPEED,
      height: CHARACTER_HEIGHT,
      // 步伐相位以鍵區分（shared/character.js 的 stepPhase）；自己沒有 id
      gaitKey: "self",
    });
  }

  /** 角色腳底要落在畫面上的哪一點（CSS px），與這個縮放下的角色身高 */
  _layout() {
    const box = this.anchorBox ?? { x: 0, y: 0, w: this.w, h: this.h };
    // 身高約佔搖桿區高度的 18%：看得清自己，也看得到周圍的道具與人。
    // 下限 0.6 是手機橫放時的保底（區域只剩兩百多 px 高，再小就看不出表情）。
    const zoom = Math.max(0.6, Math.min(1.2, (box.h * 0.18) / BODY_UNITS));
    return {
      ax: box.x + box.w / 2,
      // 腳底略低於中線，讓整個角色落在區域正中
      ay: box.y + box.h * 0.6,
      zoom,
    };
  }

  /**
   * 場景視角：大螢幕同一張底圖的局部，鏡頭跟著自己。
   * 角色、名牌、表情都用大螢幕的同一組繪圖函式，兩邊長得一樣。
   */
  _drawScene() {
    const { ctx, w, h } = this;
    const { ax, ay, zoom } = this._layout();
    const dpr = this.canvas.width / (w || 1);
    const snap = (v) => Math.round(v * dpr) / dpr;

    // 還沒收到座標前，先看場景正中央
    const cam = this.selfPos ?? { x: ROOM_W / 2 - ORIGIN_X, y: ROOM_H / 2 - ORIGIN_Y };
    const ox = snap(ax - (ORIGIN_X + cam.x) * zoom);
    const oy = snap(ay - (ORIGIN_Y + cam.y) * zoom);

    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, w, h);

    // 只取畫面看得到的那一塊底圖，不把整張 2596×1460 丟給 drawImage
    const sx0 = Math.max(0, -ox / zoom);
    const sy0 = Math.max(0, -oy / zoom);
    const sx1 = Math.min(ROOM_W, (w - ox) / zoom);
    const sy1 = Math.min(ROOM_H, (h - oy) / zoom);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.backdrop, sx0, sy0, sx1 - sx0, sy1 - sy0,
        ox + sx0 * zoom, oy + sy0 * zoom, (sx1 - sx0) * zoom, (sy1 - sy0) * zoom);
      ctx.restore();
    }

    // 道具逐幀畫：自己或鄰居走近時會動（植物晃、書櫃冒光），與大螢幕同一套繪圖與觸發距離
    if (this.props) {
      const now = performance.now();
      const walkers = [...this.neighbors.values()];
      if (this.selfPos && this.serverSelf?.mode !== 'STAGED') walkers.push({ id: 'self', x: cam.x, y: cam.y });
      this.props.update(walkers, now);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(zoom, zoom);
      ctx.imageSmoothingEnabled = false;
      this.props.draw(ctx, { x0: -ox / zoom, y0: -oy / zoom, x1: (w - ox) / zoom, y1: (h - oy) / zoom },
        now, this.reducedMotion.matches);
      ctx.restore();
    }

    const height = BODY_UNITS * zoom;
    const toScreen = (x, y) => ({ x: ox + (ORIGIN_X + x) * zoom, y: oy + (ORIGIN_Y + y) * zoom });
    const speed = Math.hypot(this.vx, this.vy);

    // 自己與鄰居一起依 y 排序，前面的人蓋住後面的人（與大螢幕相同）
    const people = [...this.neighbors.values()].map((n) => ({ n, y: n.y }));
    people.push({ self: true, y: cam.y });
    people.sort((a, b) => a.y - b.y);

    // 名牌先排版（避讓要看到所有名牌），畫的時候跟著各自的角色一起畫：前面的人經過時，
    // 後面那人的名字會被擋住，跟角色本身一樣（同大螢幕 screen.js 的 drawPlate）
    const plates = [];
    for (const p of people) {
      if (p.self) continue;
      const n = p.n;
      p.pos = toScreen(n.x, n.y);
      p.visible = !(p.pos.x < -height || p.pos.x > w + height || p.pos.y < -40 || p.pos.y > h + height);
      // 名字：配對任務要「走向另一位參與者」，看不出誰是誰就無從找起
      const name = this.names.get(n.id);
      if (!p.visible || !name) continue;
      p.name = name;
      p.fontSize = Math.max(11, Math.round(height * 0.12));
      const { w: pw, h: ph } = measureNameplate(ctx, name, { fontSize: p.fontSize });
      plates.push({ id: n.id, x: p.pos.x, y: p.pos.y + NAMEPLATE_DROP, w: pw, h: ph });
    }
    const target = layoutNameplates(plates, { bottom: h });

    for (const p of people) {
      if (p.self) {
        drawCharacter(ctx, {
          state: speed * MAX_SPEED > WALK_THRESHOLD ? 'WALK' : 'IDLE',
          vx: this.vx * MAX_SPEED,
          vy: this.vy * MAX_SPEED,
          facing: this.facing,
          heading: this.serverSelf?.heading,
          // 拍照生成的角色依伺服器的 view 換面
          view: this.view,
          // 自己按下揮手／乾杯時，手機上的自己也要跟著做
          emote: this.serverSelf?.emote,
        }, { x: ax, y: ay }, this.sprite, {
          time: this.time, maxSpeed: MAX_SPEED, height, travel: this.travel,
          // 步伐相位以鍵區分（shared/character.js 的 stepPhase）；自己沒有 id
          gaitKey: 'self',
        });
        // 拍照生成的角色沒有舉手的動作畫格，動作只能靠頭上的圖示：原本只替別人畫，
        // 按了揮手的人在自己手機上什麼都看不到（同下面鄰居的 drawEmote）
        const myEmote = this.serverSelf?.emote;
        if (myEmote && !emoteIsPosed(this.sprite, myEmote)) {
          drawEmote(ctx, { x: ax, y: ay }, EMOTE_GLYPH[myEmote] ?? '·', { height });
        }
        continue;
      }
      const n = p.n;
      const pos = p.pos;
      if (!p.visible) continue;
      drawCharacter(ctx,
        { id: n.id, state: n.state, vx: n.vx, vy: n.vy, facing: n.facing ?? 1, heading: n.heading, view: n.view, emote: n.emote },
        pos, this.looks.get(n.id)?.sprite ?? null,
        { time: this.time, maxSpeed: MAX_SPEED, height, travel: n.travel });
      this._hit(n.id, pos, height);
      if (p.name) {
        const t = target.get(n.id);
        let cur = this.plateOffset.get(n.id);
        if (!cur) { cur = { dx: t.dx, dy: t.dy }; this.plateOffset.set(n.id, cur); }
        cur.dx += (t.dx - cur.dx) * 0.2;
        cur.dy += (t.dy - cur.dy) * 0.2;
        drawNameplate(ctx, pos, p.name, { fontSize: p.fontSize, offset: cur });
      }
      if (n.emote && !emoteIsPosed(this.looks.get(n.id)?.sprite, n.emote)) {
        drawEmote(ctx, pos, EMOTE_GLYPH[n.emote] ?? '·', { height });
      }
    }
  }

  /**
   * 鄰居（地面網格模式）。以相對座標畫在主角周圍，越遠越小越淡。
   *
   * 這裡只用 dy 決定深度而不做真透視：手機畫面小，鄰居本來就只有
   * 幾十像素高，完整的透視矩陣在這個尺寸下看不出差別，卻要多算一輪。
   */
  _drawNeighbors(footY, horizon) {
    const { ctx, w, h } = this;
    if (!this.neighbors.size) return;

    // 由遠到近排序，近的蓋住遠的
    const sorted = [...this.neighbors.values()].sort((a, b) => {
      const ay = a.fromDy + (a.dy - a.fromDy) * a.t;
      const by = b.fromDy + (b.dy - b.fromDy) * b.t;
      return ay - by;
    });

    for (const n of sorted) {
      const dx = n.fromDx + (n.dx - n.fromDx) * n.t;
      const dy = n.fromDy + (n.dy - n.fromDy) * n.t;

      const x = w / 2 + dx * WORLD_TO_PX;
      const y = footY + dy * WORLD_TO_PX * 0.5;   // y 壓扁，模擬俯視角
      // 畫面外就不必畫了
      if (x < -80 || x > w + 80 || y < horizon - 40 || y > h + 80) continue;

      // 距離越遠越淡，與半徑邊界對齊，讓鄰居是淡出而不是突然消失
      const dist = Math.hypot(dx, dy);
      const fade = Math.max(0, Math.min(1, 1 - dist / CLIENT_SYNC_RADIUS));

      ctx.save();
      ctx.globalAlpha = 0.25 + fade * 0.55;
      drawCharacter(ctx,
        { id: n.id, state: n.state, vx: 0, vy: 0, facing: n.facing ?? 1 },
        { x, y },
        null,   // 鄰居不載入貼圖：10 個人 × 3 張圖的流量不值得這點細節
        { time: this.time, maxSpeed: MAX_SPEED,
          height: CHARACTER_HEIGHT * NEIGHBOR_SCALE * (0.8 + fade * 0.2) });
      ctx.restore();
      this._hit(n.id, { x, y }, CHARACTER_HEIGHT * NEIGHBOR_SCALE * (0.8 + fade * 0.2));

      // 名字：配對任務要「走向另一位參與者」，看不出誰是誰就無從找起。
      // 太遠的不畫 —— 小字疊在一起反而比沒有更難讀。
      const name = this.names.get(n.id);
      if (name && fade > 0.35) {
        const h = CHARACTER_HEIGHT * NEIGHBOR_SCALE * (0.8 + fade * 0.2);
        const fs = Math.max(10, Math.round(h * 0.13));
        ctx.save();
        ctx.font = `700 ${fs}px "Noto Sans TC", "PingFang TC", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const ny = y + 4;
        // 米白底襯：名字會落在網格線上，純色文字讀不清
        const w = ctx.measureText(name).width + 10;
        ctx.globalAlpha = (0.25 + fade * 0.55) * 0.9;
        ctx.fillStyle = '#F7F1E3';
        ctx.beginPath();
        ctx.roundRect(x - w / 2, ny, w, fs + 6, 5);
        ctx.fill();
        ctx.globalAlpha = 0.35 + fade * 0.65;
        ctx.fillStyle = '#3A2E27';
        ctx.fillText(name, x, ny + 3);
        ctx.restore();
      }

      if (n.emote) {
        ctx.save();
        ctx.globalAlpha = 0.6 + fade * 0.4;
        ctx.font = `${Math.round(CHARACTER_HEIGHT * 0.2)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(EMOTE_GLYPH[n.emote] ?? '·', x,
          y - CHARACTER_HEIGHT * NEIGHBOR_SCALE - 6);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawSky(horizon) {
    const { ctx, w } = this;
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    // 與大螢幕廚房的流理台背牆同色系；上方文字列壓在這裡，所以維持淺色
    g.addColorStop(0, '#F7F1E3');
    g.addColorStop(1, '#EDE3CE');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizon);
  }

  /**
   * 地面透視網格。
   *
   * 橫線依距離指數收斂到地平線，直線則從中心放射 —— 這是最省的
   * 假透視：不需要矩陣運算，但推動搖桿時的位移感與真投影幾乎一致。
   */
  _drawGround(horizon) {
    const { ctx, w, h } = this;

    const g = ctx.createLinearGradient(0, horizon, 0, h);
    // 淺木地板（大螢幕廚房地板的淡化版）。刻意比場景淺：
    // 搖桿提示與角色都疊在上面，太深會吃掉對比。
    g.addColorStop(0, '#EADBC1');
    g.addColorStop(1, '#DCC4A1');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizon, w, h - horizon);
    ctx.clip();

    ctx.strokeStyle = 'rgba(122, 76, 49, 0.2)';
    ctx.lineWidth = 1;

    // ── 橫線：往地平線靠攏時間距收縮 ──
    const depth = h - horizon;
    const offset = ((this.scrollY % GRID_SIZE) + GRID_SIZE) % GRID_SIZE;
    for (let i = 0; i < 14; i++) {
      // t 越接近 1 越靠近地平線
      const t = (i * GRID_SIZE + offset) / (14 * GRID_SIZE);
      const y = h - depth * (1 - Math.pow(1 - t, 2.2));
      if (y <= horizon + 0.5) continue;
      ctx.globalAlpha = Math.min(1, (y - horizon) / (depth * 0.35));
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // ── 直線：自地平線的消失點放射 ──
    ctx.globalAlpha = 0.55;
    const vanishX = w / 2;
    const spacing = GRID_SIZE * 1.6;
    const shift = ((this.scrollX % spacing) + spacing) % spacing;
    for (let i = -9; i <= 9; i++) {
      const baseX = vanishX + i * spacing + shift;
      ctx.beginPath();
      ctx.moveTo(vanishX + (baseX - vanishX) * 0.06, horizon);
      ctx.lineTo(vanishX + (baseX - vanishX) * 2.4, h);
      ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
