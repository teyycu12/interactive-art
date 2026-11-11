/**
 * NPC：人少時讓場面不要太乾（第一階段：只走動、揮手，不加分）。
 *
 * ── 跟真人的關係 ──
 * NPC 放在 stage.npcs，不在 stage.agents（理由見 state.js 的 npcs 欄位）。
 * 移動完全沿用真人那一套（arbiter.js 的 stepAgent）：這裡每幀替每個 NPC 推一支
 * 虛擬搖桿 —— 設定 inputX/inputY/inputIntensity，並把 lastInputAt 刷成現在，
 * α 因此一直是 1，不受全場 IDLE_MOTION 影響（'wander' 時也不會被 Boids 帶著漂）。
 * 轉向、翻面、正背側面、碰撞、繞物件都不用另寫。
 *
 * ── 走法：走走停停 ──
 * 挑目的地（道具旁一圈、或分區裡）→ 走過去 → 停 5–20 秒 → 再挑。純 Boids 會像魚群，
 * 見 config.js 的 NPC 說明。要去室外（或從室外回來）先經過牆上的門，直線走會撞牆。
 *
 * ── 數量 ──
 * 固定 N 個，或「場上至少 N 人」（N − 真人數，真人越多 NPC 越少）。一次只進退一個；
 * 退場的 NPC 走回正門口的地墊（shared/scene.js 的 ENTRANCE）才消失，不憑空不見；進場也從那裡走進來。
 *
 * ⚠ 這個模組只讀 stage.agents（看真人在哪），從不寫它。
 */

import { STAGE } from '../shared/protocol.js';
import { PROPS, ZONES, DOORWAYS, OBSTACLES, ENTRANCE, obstacleDistance, nearestOnObstacle } from '../shared/scene.js';
import { THEME_MAP } from '../shared/themes.js';
import { MAX_SPEED, MAX_AGENTS, NPC } from './config.js';
import { obstacleAvoidance } from './boids.js';

/** NPC 的名字（名牌是「身分・名字」）。換裝紀錄沒有存當初的名字，所以另備一份 */
export const NPC_NICKS = ['小麥', '阿哲', '小葵', '阿凱', '小柚', '阿豪', '小蘋', '阿德', '小茉', '阿光', '小晴', '阿樂'];

export const NPC_MODES = ['fixed', 'atLeast'];

/** count 的上限：「場上至少 N 人」的 N 不會比滿場還多 */
const MAX_COUNT = MAX_AGENTS + NPC.maxCount;

/** 離牆、離場邊至少這麼遠才挑得當目的地 */
const EDGE = 80;
/** 穿門時，門的兩側各取一個點（離牆中心線這麼遠） */
const DOOR_SIDE = 70;

const DOORS = DOORWAYS.map((d) => {
  const cx = d.x + d.w / 2;
  // 西邊的門通往 x 更小的室外，東邊的通往 x 更大的
  return { x: cx, y: d.y + d.h / 2, out: cx < STAGE.width / 2 ? -1 : 1, side: cx < STAGE.width / 2 ? 'w' : 'e' };
});

/** 在室內、西側室外、還是東側室外 */
export function regionOf(x) {
  for (const d of DOORS) if ((x - d.x) * d.out > 0) return d.side;
  return 'in';
}

/**
 * 從 from 走到 to 要經過的點（最後一個就是 to）。不同區之間一定要經過門：
 * 先從所在的室外走回室內，再走進目的地那一側的室外。
 */
export function route(from, to) {
  const path = [];
  const a = regionOf(from.x), b = regionOf(to.x);
  if (a !== b) {
    const exit = DOORS.find((d) => d.side === a);
    if (exit) path.push({ x: exit.x + exit.out * DOOR_SIDE, y: exit.y }, { x: exit.x - exit.out * DOOR_SIDE, y: exit.y });
    const enter = DOORS.find((d) => d.side === b);
    if (enter) path.push({ x: enter.x - enter.out * DOOR_SIDE, y: enter.y }, { x: enter.x + enter.out * DOOR_SIDE, y: enter.y });
  }
  path.push({ x: to.x, y: to.y });
  return path;
}

/** 點 p 到線段 a–b 的距離 */
function segmentDistance(p, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0;
  return Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t));
}

function free(x, y) {
  if (x < EDGE || x > STAGE.width - EDGE || y < EDGE || y > STAGE.height - EDGE) return false;
  return !OBSTACLES.some((o) => obstacleDistance(o, x, y) < o.r + 30);
}

const range = (rng, [lo, hi]) => lo + rng() * (hi - lo);

export class NpcDirector {
  /**
   * @param {import('./state.js').Stage} stage
   * @param {{rng?: () => number, theme?: () => string}} [opts]
   */
  constructor(stage, { rng = Math.random, theme = () => 'kitchen' } = {}) {
    this.stage = stage;
    this.rng = rng;
    this.theme = theme;
    this.settings = { enabled: false, mode: 'fixed', count: 4, max: NPC.maxCount };
    /** @type {{assetId: string, avatar: object}[]} 可以用的外型（換裝角色） */
    this.library = [];
    this.lastChangeAt = -Infinity;
    /** 進場順序，用來輪流分配身分 */
    this.serial = 0;
  }

  /** 主辦端改設定。不合法的欄位忽略，數字夾在範圍內 */
  configure(patch = {}) {
    const s = this.settings;
    if (typeof patch.enabled === 'boolean') s.enabled = patch.enabled;
    if (NPC_MODES.includes(patch.mode)) s.mode = patch.mode;
    if (Number.isFinite(patch.max)) s.max = Math.max(0, Math.min(NPC.maxCount, Math.round(patch.max)));
    // 「場上至少 N 人」的 N 可以比 NPC 上限大（例如至少 12 人、NPC 最多 8 個）
    if (Number.isFinite(patch.count)) s.count = Math.max(0, Math.min(MAX_COUNT, Math.round(patch.count)));
    return { ...s };
  }

  /** 換外型庫。被拿掉的外型，場上用著它的 NPC 會退場 */
  setLibrary(entries) {
    this.library = entries.filter((e) => e && typeof e.assetId === 'string' && e.avatar);
  }

  /** 現在應該有幾個 NPC */
  target(humans = this.stage.agents.size) {
    const s = this.settings;
    if (!s.enabled || !this.library.length) return 0;
    const want = s.mode === 'atLeast' ? s.count - humans : s.count;
    return Math.max(0, Math.min(s.max, want));
  }

  /** 還沒在退場的 NPC */
  staying() {
    return [...this.stage.npcs.values()].filter((n) => n.npc.state !== 'leave');
  }

  /**
   * 每幀呼叫，要在 stage.tick 之前（這裡設定虛擬搖桿，tick 照著走）。
   * @param {number} now ms
   * @param {{frozen?: boolean}} [opts] frozen：問答進行中，NPC 停在原地
   */
  tick(now, { frozen = false } = {}) {
    this.reconcile(now);
    for (const npc of [...this.stage.npcs.values()]) this.drive(npc, now, frozen);
  }

  reconcile(now) {
    if (now - this.lastChangeAt < NPC.spawnGapMs) return;
    const ids = new Set(this.library.map((e) => e.assetId));
    const staying = this.staying();
    // 外型被移出庫的先走
    const orphan = staying.find((n) => !ids.has(n.npc.assetId));
    if (orphan) { this.leave(orphan, now); return; }
    const want = this.target();
    if (staying.length > want) {
      // 最晚進場的先走：剛進場的人比較不會注意到它不見
      this.leave(staying.reduce((a, b) => (a.npc.since > b.npc.since ? a : b)), now);
    } else if (staying.length < want) {
      this.spawn(now);
    }
  }

  spawn(now) {
    const used = new Map();
    for (const n of this.stage.npcs.values()) used.set(n.npc.assetId, (used.get(n.npc.assetId) ?? 0) + 1);
    // 場上用得最少的外型，同樣少的隨機挑：避免兩個長得一樣的 NPC 同時在場
    const fewest = Math.min(...this.library.map((e) => used.get(e.assetId) ?? 0));
    const pool = this.library.filter((e) => (used.get(e.assetId) ?? 0) === fewest);
    const look = pool[Math.floor(this.rng() * pool.length)];
    const nicks = new Set([...this.stage.npcs.values()].map((n) => n.npc.nick));
    const nick = NPC_NICKS.find((n) => !nicks.has(n)) ?? NPC_NICKS[this.serial % NPC_NICKS.length];
    const role = this.serial++;
    // 從正門口的地墊走進來（2026-11-11 前是隨機一扇側門，看起來像從牆裡冒出來）
    const x = ENTRANCE.x + (this.rng() - 0.5) * ENTRANCE.w * 0.6;
    const meta = {
      assetId: look.assetId, nick, role, since: now,
      state: 'dwell', until: now, path: [], progressAt: now, progressDist: Infinity, greetAt: -Infinity, near: new Set(),
    };
    this.stage.addNpc({ name: this.nameOf(meta), avatar: look.avatar, x, y: ENTRANCE.y, npc: meta });
    this.lastChangeAt = now;
  }

  leave(npc, now) {
    const m = npc.npc;
    m.state = 'leave';
    m.leaveBy = now + NPC.leaveTimeoutMs;
    // 走回正門口的地墊才消失；在室外的先穿過側門回到室內（route 會加上門口的點）
    m.path = route(npc, { x: ENTRANCE.x + (this.rng() - 0.5) * ENTRANCE.w * 0.6, y: ENTRANCE.y });
    m.progressAt = now;
    m.progressDist = Infinity;
    this.lastChangeAt = now;
  }

  /** 「身分・名字」。身分跟著目前的場景（shared/themes.js 的 npcRoles） */
  nameOf(meta) {
    const roles = THEME_MAP[this.theme()]?.npcRoles ?? ['店員'];
    return `${roles[meta.role % roles.length]}・${meta.nick}`;
  }

  /** 換場景之後改名牌上的身分 */
  retitle() {
    for (const npc of this.stage.npcs.values()) npc.name = this.nameOf(npc.npc);
    this.stage.rosterDirty = true;
  }

  /** 全部立刻清掉（主辦端「全部退場」以外的情況：例如伺服器要關） */
  clear() {
    for (const id of [...this.stage.npcs.keys()]) this.stage.removeNpc(id);
  }

  /** 每幀替一個 NPC 決定虛擬搖桿 */
  drive(npc, now, frozen) {
    const m = npc.npc;
    npc.lastInputAt = now;
    // 合照定位接手中（lockStage 設了 targetX）：讓 arbiter 帶它走，這裡不推
    if (npc.targetX !== null || frozen) { this.stop(npc); return; }

    if (m.state === 'dwell') {
      this.stop(npc);
      this.greet(npc, now);
      if (now >= m.until) this.pickNext(npc, now);
      return;
    }
    if (m.state === 'escape') {
      if (now >= m.until) { this.pickNext(npc, now, m.away); return; }
      npc.inputX = m.away.x; npc.inputY = m.away.y; npc.inputIntensity = NPC.speed;
      return;
    }

    const goal = m.path[0];
    if (!goal) { this.arrive(npc, now); return; }
    const dist = Math.hypot(goal.x - npc.x, goal.y - npc.y);
    const last = m.path.length === 1;
    if (dist <= (last ? NPC.arriveEpsilon : 30)) {
      m.path.shift();
      m.progressDist = Infinity;
      m.progressAt = now;
      if (!m.path.length) this.arrive(npc, now);
      return;
    }
    // 卡住了（被站著的人夾住、門口擠）：先退開一下再換目的地；退場的直接消失。
    // 不退開的話，夾住它的那幾個人通常也擋著下一個目的地的方向，會原地一直換
    if (dist < m.progressDist - 12) { m.progressDist = dist; m.progressAt = now; }
    else if (now - m.progressAt > NPC.stuckMs) {
      if (m.state === 'leave') { this.stage.removeNpc(npc.id); return; }
      this.escape(npc, now);
      return;
    }
    if (m.state === 'leave' && now > m.leaveBy) { this.stage.removeNpc(npc.id); return; }

    const [vx, vy] = this.steer(npc, goal, dist, last);
    const speed = Math.hypot(vx, vy);
    npc.inputX = speed ? vx / speed : 0;
    npc.inputY = speed ? vy / speed : 0;
    npc.inputIntensity = speed / MAX_SPEED;
  }

  /** 往遠離附近的人與物件的方向走一小段（NPC.escapeMs） */
  escape(npc, now) {
    const m = npc.npc;
    let x = 0, y = 0;
    for (const o of this.stage.everyone()) {
      if (o === npc) continue;
      const d = Math.hypot(o.x - npc.x, o.y - npc.y);
      if (d > 0 && d < NPC.personalSpace * 1.5) { x += (npc.x - o.x) / d; y += (npc.y - o.y) / d; }
    }
    for (const o of OBSTACLES) {
      const [ox, oy] = nearestOnObstacle(o, npc.x, npc.y);
      const d = Math.hypot(npc.x - ox, npc.y - oy);
      if (d > 0 && d < o.r + 60) { x += (npc.x - ox) / d; y += (npc.y - oy) / d; }
    }
    const a = this.rng() * Math.PI * 2;
    x += Math.cos(a) * 0.5; y += Math.sin(a) * 0.5;
    const k = Math.hypot(x, y) || 1;
    m.state = 'escape';
    m.away = { x: x / k, y: y / k };
    m.until = now + NPC.escapeMs;
    // 記住卡住的地方：一陣子內新的路線不能經過這裡（例如沙發跟站著的人之間那條過不去的縫，
    // 沙發旁又是熱門的目的地，不記的話會一直被帶回來卡）
    m.blocked = { x: npc.x, y: npc.y, until: now + NPC.blockedMs };
  }

  stop(npc) {
    npc.inputX = 0; npc.inputY = 0; npc.inputIntensity = 0;
  }

  arrive(npc, now) {
    const m = npc.npc;
    if (m.state === 'leave') { this.stage.removeNpc(npc.id); return; }
    m.state = 'dwell';
    m.until = now + range(this.rng, NPC.dwellMs);
    this.stop(npc);
  }

  /** @param {{x: number, y: number}} [toward] 剛退開的方向：下一個目的地要在這一側，不然又走回卡住的地方 */
  pickNext(npc, now, toward = null) {
    const m = npc.npc;
    this.clock = now;
    const dest = this.pickDestination(npc, toward) ?? (toward && this.pickDestination(npc));
    if (!dest) { m.state = 'dwell'; m.until = now + NPC.dwellMs[0]; return; }
    m.state = 'walk';
    m.dest = dest;
    m.path = route(npc, dest);
    m.progressAt = now;
    m.progressDist = Infinity;
  }

  /**
   * 下一個目的地：六成是道具旁一圈（站在桌邊、植物旁，像在做事），兩成是分區裡，兩成是場上任何空位。
   * 不挑太近的（看起來像原地踱步）、不挑別的 NPC 附近（擠成一團）、不挑真人身上。
   */
  pickDestination(npc, toward = null) {
    const rng = this.rng;
    // 其他 NPC 現在的位置與要去的地方
    const taken = [];
    for (const n of this.stage.npcs.values()) {
      if (n === npc) continue;
      taken.push(n);
      if (n.npc.dest) taken.push(n.npc.dest);
    }
    for (let i = 0; i < 40; i++) {
      let x, y;
      const pick = rng();
      if (pick < 0.6) {
        const p = PROPS[Math.floor(rng() * PROPS.length)];
        const a = rng() * Math.PI * 2;
        const d = p.r + 45 + rng() * 40;
        x = p.x + Math.cos(a) * d;
        y = p.y + Math.sin(a) * d;
      } else if (pick < 0.8) {
        const z = ZONES[Math.floor(rng() * ZONES.length)];
        x = z.x + 40 + rng() * (z.w - 80);
        y = z.y + 40 + rng() * (z.h - 80);
      } else {
        // 場上任何一個空位：東側室外沒有道具也沒有分區，不靠這個永遠沒人去
        x = rng() * STAGE.width;
        y = rng() * STAGE.height;
      }
      if (!free(x, y)) continue;
      if (Math.hypot(x - npc.x, y - npc.y) < NPC.minHop) continue;
      if (toward && (x - npc.x) * toward.x + (y - npc.y) * toward.y <= 0) continue;
      const b = npc.npc.blocked;
      if (b && this.clock < b.until && segmentDistance(b, npc, { x, y }) < NPC.personalSpace) continue;
      if (taken.some((o) => Math.hypot(o.x - x, o.y - y) < NPC.spreadRadius)) continue;
      if ([...this.stage.agents.values()].some((h) => Math.hypot(h.x - x, h.y - y) < NPC.personalSpace)) continue;
      return { x, y };
    }
    return null;
  }

  /**
   * 朝 goal 走的速度。前方有人就從旁邊繞（personalSpace），物件沿用 boids.js 的切向繞行；
   * 兩者都只改方向不改速率（同 arbiter.js 的理由：疊加會讓角色經過時莫名加速）。
   */
  steer(npc, goal, dist, last) {
    const speed = NPC.speed * MAX_SPEED * (last ? Math.min(1, Math.max(0.35, dist / NPC.slowRadius)) : 1);
    const dx = (goal.x - npc.x) / dist, dy = (goal.y - npc.y) / dist;
    let tx = 0, ty = 0;
    for (const o of this.stage.everyone()) {
      if (o === npc) continue;
      const ox = o.x - npc.x, oy = o.y - npc.y;
      const d = Math.hypot(ox, oy);
      if (d === 0 || d > NPC.personalSpace || d > dist) continue;
      const ahead = (ox * dx + oy * dy) / d;
      if (ahead <= 0) continue;
      // 往行進方向的垂直方向閃，取背對那個人的那一側
      let px = -dy, py = dx;
      if (px * ox + py * oy > 0) { px = -px; py = -py; }
      const w = ahead * (1 - d / NPC.personalSpace);
      tx += px * w;
      ty += py * w;
    }
    let vx = (dx + tx * 1.5) * speed, vy = (dy + ty * 1.5) * speed;
    const [ax, ay] = obstacleAvoidance(npc, vx, vy);
    vx += ax; vy += ay;
    const mag = Math.hypot(vx, vy) || 1;
    return [(vx / mag) * speed, (vy / mag) * speed];
  }

  /** 停著的時候，有真人剛走進 greetRadius 就揮手（有冷卻，不會一直揮） */
  greet(npc, now) {
    const m = npc.npc;
    const near = new Set();
    let newcomer = null;
    for (const h of this.stage.agents.values()) {
      if (h.offline || Math.hypot(h.x - npc.x, h.y - npc.y) > NPC.greetRadius) continue;
      near.add(h.id);
      if (!m.near.has(h.id)) newcomer = h;
    }
    m.near = near;
    if (!newcomer || now - m.greetAt < NPC.greetCooldownMs) return;
    m.greetAt = now;
    npc.facing = newcomer.x >= npc.x ? 1 : -1;
    this.stage.npcEmote(npc.id, 'wave');
  }
}
