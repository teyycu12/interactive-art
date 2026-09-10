/**
 * 虛擬參與者注入器（整合版）
 *
 * 用途：一個人也能把場域填滿，實際玩一輪尋寶或顏色任務。
 *
 * 為什麼需要：尋寶至少要 2 人、顏色任務要場上有各種顏色的人，
 * 而「冷熱門檻的節奏對不對」「寶箱在 3D 房間裡看不看得見」這類問題
 * 測試完全測不出來 —— 只能真的玩一輪。找 10 個真人來試調參數不現實，
 * 因此讓機器人湊人數，真人只出一個（當先知或當找的人）。
 *
 * ⚠ 這是開發／調校工具，不是展場的一部分。現場請勿使用 ——
 *   機器人會佔用 MAX_AGENTS 的名額，把真的想進場的人擋在外面。
 *
 * 用法：
 *   node scripts/bots.mjs                 # 預設 5 隻，連 localhost:3000
 *   node scripts/bots.mjs --count 9       # 湊滿 10 人（自己佔 1 個）
 *   node scripts/bots.mjs --url ws://192.168.1.5:3000
 *   node scripts/bots.mjs --colors        # 每種色族各保證一隻（測顏色任務）
 *   node scripts/bots.mjs --still         # 進場後不動，只當背景
 *
 * Ctrl-C 會讓機器人主動離場，不留幽靈角色。
 */

import { WebSocket } from 'ws';
import { EV, STAGE, ACTIONS } from '../shared/protocol.js';
import {
  HEADS, FACES, BODIES, SKIN_TONES, ACCENT_COLORS, randomAvatarConfig,
} from '../shared/avatars.js';
import { COLOR_FAMILIES, familyOf } from '../shared/colorFamily.js';
import { OBSTACLES } from '../shared/scene.js';

// ── 參數 ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const COUNT = Math.max(1, Number(flag('count', 5)));
const URL = flag('url', `ws://localhost:${process.env.PORT || 3000}`);
const STILL = has('still');
const BY_COLOR = has('colors');

const NAMES = [
  '小安', '阿哲', '婷婷', '大雄', '小美', '阿賓', '子瑜', '阿凱',
  '欣妤', '志明', '春嬌', '小胖', '阿良', '佩佩', '大寶',
];

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 產生外觀。--colors 模式下輪流指定色族，確保場上每種顏色都有人 ——
 * 否則隨機挑色很容易整場沒有半個紫色的人，顏色任務就無解了。
 */
function avatarFor(index) {
  if (!BY_COLOR) return randomAvatarConfig();
  const want = COLOR_FAMILIES[index % COLOR_FAMILIES.length].id;
  // 從調色盤裡挑一個真的屬於該色族的顏色。挑不到就退回隨機 ——
  // 調色盤未必涵蓋每一族（例如紫色目前就沒有對應的 accent）。
  const match = ACCENT_COLORS.filter((c) => familyOf(c) === want);
  return {
    head: rand(HEADS).id,
    face: rand(FACES).id,
    body: rand(BODIES).id,
    accentColor: match.length ? rand(match) : rand(ACCENT_COLORS),
    skinTone: rand(SKIN_TONES),
  };
}

/** 隨機挑一個不在道具裡的目標點，讓機器人有地方可走 */
function wanderTarget() {
  for (let i = 0; i < 30; i++) {
    const x = 150 + Math.random() * (STAGE.width - 300);
    const y = 150 + Math.random() * (STAGE.height - 300);
    if (!OBSTACLES.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + 80)) return { x, y };
  }
  return { x: STAGE.width / 2, y: STAGE.height / 2 };
}

// ── 單隻機器人 ────────────────────────────────────────────
class Bot {
  constructor(index) {
    this.index = index;
    this.name = NAMES[index % NAMES.length] + (index >= NAMES.length ? index : '');
    this.avatar = avatarFor(index);
    this.family = familyOf(this.avatar.accentColor);
    this.id = null;
    this.pos = null;
    this.target = wanderTarget();
    this.ws = null;
    this.alive = true;
  }

  connect() {
    this.ws = new WebSocket(URL);
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        type: EV.CLIENT_JOIN, name: this.name, avatar: this.avatar,
      }));
    });
    this.ws.on('message', (raw) => this.#onMessage(raw));
    this.ws.on('error', (e) => {
      console.error(`  ✗ ${this.name} 連線失敗：${e.message}`);
      this.alive = false;
    });
    this.ws.on('close', () => { this.alive = false; });
  }

  #onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === EV.CLIENT_WELCOME) {
      this.id = m.userId;
      const fam = COLOR_FAMILIES.find((f) => f.id === this.family);
      console.log(`  ✓ ${this.name.padEnd(6)} 進場　${fam ? fam.glyph + fam.label : this.family}`);
      return;
    }
    if (m.type === EV.CLIENT_REJECT) {
      console.error(`  ✗ ${this.name} 被拒絕：${m.reason}`);
      this.alive = false;
      return;
    }
    // 自己的座標。機器人不自行模擬位置，一律以伺服器為準
    // （與手機端同一個理由，見 CLAUDE.md）
    if (m.type === EV.CLIENT_SYNC && m.self) {
      this.pos = { x: m.self.x, y: m.self.y };
    }
    // 尋寶開始時報一下，方便對照大螢幕
    if (m.type === EV.TREASURE_START && m.round?.prophetId === this.id) {
      console.log(`  🔮 ${this.name} 被選為先知（機器人不會喊話，建議指定真人）`);
    }
  }

  /** 走向目標點，到了就換一個。這是最省事又看得出「有人在動」的行為 */
  step() {
    if (!this.alive || STILL || !this.pos || this.ws.readyState !== this.ws.OPEN) return;
    const dx = this.target.x - this.pos.x;
    const dy = this.target.y - this.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 60) { this.target = wanderTarget(); return; }
    this.ws.send(JSON.stringify({
      type: EV.INPUT_MOVE,
      // ⚠ 形狀必須是 {vector:{x,y}}：伺服器讀 msg.vector ?? {x:msg.vx,y:msg.vy}，
      //   寫成裸的 {x,y} 會兩邊都是 undefined，角色完全不動
      vector: { x: dx / d, y: dy / d },
      intensity: 0.75,   // 略慢於真人，讓真人追得上也看得出差別
    }));
  }

  /** 偶爾比個手勢，讓畫面不會只有走動 */
  emote() {
    if (!this.alive || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ type: EV.INPUT_ACTION, action: rand(ACTIONS) }));
  }

  leave() {
    if (this.ws?.readyState === this.ws?.OPEN) {
      // 主動離場，角色立即移除 —— 否則要等 AGENT_TTL（45 秒）才回收，
      // 期間場上都是不動的幽靈，佔著人數上限
      this.ws.send(JSON.stringify({ type: EV.CLIENT_LEAVE }));
    }
    this.ws?.close();
  }
}

// ── 主流程 ────────────────────────────────────────────────
console.log(`\n  注入 ${COUNT} 隻虛擬參與者 → ${URL}`);
if (BY_COLOR) console.log('  （--colors：每種色族輪流指定，確保顏色任務有解）');
if (STILL) console.log('  （--still：進場後不移動）');
console.log();

const bots = Array.from({ length: COUNT }, (_, i) => new Bot(i));
// 逐隻間隔進場：一次全開會讓大螢幕的 arrivals 箭頭擠成一團，
// 也比較像真實的到場節奏
for (const bot of bots) {
  bot.connect();
  await sleep(250);
}

await sleep(800);
const joined = bots.filter((b) => b.id).length;
console.log(`\n  ${joined}/${COUNT} 隻已進場`);
if (joined < COUNT) {
  console.log('  ⚠ 有機器人沒進場，多半是達到 MAX_AGENTS 上限（預設 10）');
}
console.log('\n  Ctrl-C 結束並讓它們離場\n');

// 移動迴圈。20Hz 與手機端的節流頻率一致
const walker = setInterval(() => { for (const b of bots) b.step(); }, 50);
// 每隔幾秒隨機一隻比手勢
const emoter = setInterval(() => { rand(bots).emote(); }, 4000);

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(walker);
  clearInterval(emoter);
  console.log('\n  讓機器人離場…');
  for (const b of bots) b.leave();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
