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

import { drawCharacter } from '/shared/character.js';
import { avatarImage } from '/shared/avatarSprite.js';
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
    this.sprite = avatar ? avatarImage(avatar) : null;

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

    this.running = false;
    this.lastAt = 0;
    this.time = 0;
    this._frame = null;
    this._onFootstep = null;

    // 觸地偵測：步態相位過零時觸發。詳見 _detectFootstep。
    this._prevPhaseSin = 0;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    this._resize();
  }

  /** 更換角色外觀（例如掃描生成完成後） */
  setAvatar(avatar) {
    this.sprite = avatar ? avatarImage(avatar) : null;
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
      if (prev) {
        prev.fromDx = prev.dx; prev.fromDy = prev.dy;
        prev.dx = n.dx; prev.dy = n.dy;
        prev.facing = n.facing; prev.state = n.state; prev.emote = n.emote;
        prev.t = 0;
      } else {
        // 新出現的鄰居直接就位，不從畫面中心滑進來
        this.neighbors.set(n.id, {
          ...n, fromDx: n.dx, fromDy: n.dy, t: 1,
        });
      }
    }
    for (const id of this.neighbors.keys()) {
      if (!seen.has(id)) this.neighbors.delete(id);
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

    // 鄰居內插：把上一次的相對座標推進到最新值
    for (const n of this.neighbors.values()) {
      if (n.t < 1) n.t = Math.min(1, n.t + dt / (CLIENT_SYNC_MS / 1000));
    }

    this._detectFootstep(speed);
  }

  /**
   * 觸地偵測。
   *
   * shared/character.js 的彈跳是 |sin(phase)|，因此腳落地對應 |sin| 觸底，
   * 也就是 sin **每一次**過零 —— 上行與下行都算，一個 sin 週期有兩步
   * （左腳、右腳）。只抓單向變號會漏掉一半的腳步，震動聽起來像在跳而不是走。
   *
   * 這份相位計算與 character.js 的 cadence() 綁在一起：那邊改了步頻公式，
   * 這裡的震動就會對不上腳步。兩者的耦合刻意留在註解裡。
   */
  _detectFootstep(speed) {
    // 門檻要高於 _update 低通濾波的殘量。濾波是指數收斂，速度會長時間
    // 停在 0 附近的極小值 —— 門檻壓太低會讓角色明明站著不動卻持續震動。
    if (speed < FOOTSTEP_MIN_SPEED) { this._prevPhaseSin = 0; return; }

    const cadence = 0.55 + 0.45 * Math.min(1, speed);
    const phase = this.time * (0.2 * 60) * cadence;
    const s = Math.sin(phase);
    // 過零偵測（雙向）。_prevPhaseSin 為 0 代表剛從靜止起步，不算一次觸地。
    if (this._prevPhaseSin !== 0 && Math.sign(s) !== Math.sign(this._prevPhaseSin)) {
      this._onFootstep?.();
    }
    this._prevPhaseSin = s;
  }

  _draw() {
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
    };

    drawCharacter(ctx, agent, { x: w / 2, y: footY }, this.sprite, {
      time: this.time,
      maxSpeed: MAX_SPEED,
      height: CHARACTER_HEIGHT,
    });
  }

  /**
   * 鄰居。以相對座標畫在主角周圍，越遠越小越淡。
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
        { state: n.state, vx: 0, vy: 0, facing: n.facing ?? 1 },
        { x, y },
        null,   // 鄰居不載入貼圖：10 個人 × 3 張圖的流量不值得這點細節
        { time: this.time, maxSpeed: MAX_SPEED,
          height: CHARACTER_HEIGHT * NEIGHBOR_SCALE * (0.8 + fade * 0.2) });
      ctx.restore();

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
        ctx.fillStyle = '#FAF8F5';
        ctx.beginPath();
        ctx.roundRect(x - w / 2, ny, w, fs + 6, 5);
        ctx.fill();
        ctx.globalAlpha = 0.35 + fade * 0.65;
        ctx.fillStyle = '#2F2A26';
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
    g.addColorStop(0, '#FAF8F5');
    g.addColorStop(1, '#EFEAE3');
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
    g.addColorStop(0, '#EFEAE3');
    g.addColorStop(1, '#E3DCD2');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizon, w, h - horizon);
    ctx.clip();

    ctx.strokeStyle = 'rgba(47, 42, 38, 0.13)';
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
