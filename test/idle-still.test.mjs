/**
 * 靜止待機（IDLE_MOTION === 'still'，預設值）測試
 *
 * 對照組是 wander-mode.test.mjs：同一批力學在另一個參數下的行為。
 * 這裡驗的是「沒有人操控時角色完全不動」，以及那個「不動」不能是
 * 硬拔電源 —— 放開搖桿要平滑煞停，經過道具仍要能繞過去。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stepAgent } from '../server/arbiter.js';
import { Stage } from '../server/state.js';
import {
  MAX_SPEED, IDLE_MOTION, ALPHA_DECAY_MS, MAX_AGENTS, FACING_DWELL_MS,
} from '../server/config.js';
import { OBSTACLES } from '../shared/scene.js';
import { AGENT_STATE } from '../shared/protocol.js';

const AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

function makeAgent(stage, overrides = {}) {
  const a = stage.addAgent({ name: 'T', avatar: AVATAR });
  a.boidsVx = 0;
  a.boidsVy = 0;
  a.lastInputAt = 0;
  Object.assign(a, overrides);
  return a;
}

describe("靜止待機（IDLE_MOTION='still'）", { skip: IDLE_MOTION !== 'still' && '需預設的 still 模式' }, () => {
  test('從未操控過的角色完全不會位移', () => {
    const stage = new Stage();
    const agents = [];
    // 用 MAX_AGENTS 而非寫死數量（見 CLAUDE.md 的人數上限說明）
    for (let i = 0; i < MAX_AGENTS; i++) {
      agents.push(makeAgent(stage, { x: 700 + i * 110, y: 750 }));
    }

    // 先跑一步讓剛體修正把（若有的話）與道具重疊的角色推到表面上，
    // 再取基準點。否則量到的是「出生點被修正」而非「閒置時的漂移」。
    let now = 1_000_000;
    now += 33;
    for (const a of agents) stepAgent(a, agents, 0.033, now);
    const start = agents.map((a) => ({ x: a.x, y: a.y }));

    for (let i = 0; i < 900; i++) { // 30 秒
      now += 33;
      for (const a of agents) stepAgent(a, agents, 0.033, now);
    }

    for (const [i, a] of agents.entries()) {
      const moved = Math.hypot(a.x - start[i].x, a.y - start[i].y);
      // 用容差而非嚴格等於：座標是浮點數，速度乘 0 再累加仍可能留下 1e-15 的殘值
      assert.ok(moved < 1e-6, `角色 ${i} 不應位移，實得 ${moved}`);
      assert.equal(a.state, AGENT_STATE.IDLE, '應回報 IDLE 待機');
    }
  });

  test('推搖桿時仍能正常移動', () => {
    const stage = new Stage();
    const agent = makeAgent(stage, {
      x: 300, y: 540, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    const startX = agent.x;
    for (let i = 0; i < 30; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
    }

    assert.ok(agent.x - startX > MAX_SPEED * 0.5,
      `推桿 1 秒應明顯前進，實得 ${(agent.x - startX).toFixed(1)}`);
    assert.equal(agent.state, AGENT_STATE.WALK);
  });

  test('放開搖桿是平滑煞停，不是瞬間歸零', () => {
    // 這一則是防退化的重點。α 要閒置滿門檻才開始衰減，而 inputIntensity
    // 在放手當下就歸零 —— 兩者相乘會讓速度從全速直接掉到 0。
    // 'wander' 模式下那個缺口由 Boids 影子速度補上，看不出來；
    // 靜止模式沒有東西補，缺口會直接變成畫面上的急煞。
    const stage = new Stage();
    // 刻意選一段沒有道具的空地並朝場地中央走：撞上道具時位置修正會消去
    // 朝內的速度分量（那是碰撞處理，不是煞停），會把這一則要量的曲線蓋掉。
    const agent = makeAgent(stage, {
      x: 700, y: 750, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
    }

    // 放開搖桿
    agent.inputX = 0; agent.inputY = 0; agent.inputIntensity = 0;

    let prev = Math.hypot(agent.vx, agent.vy);
    let maxJump = 0;
    const steps = Math.ceil((ALPHA_DECAY_MS / 1000) / 0.033) + 30;
    for (let i = 0; i < steps; i++) {
      now += 33;
      stepAgent(agent, [agent], 0.033, now);
      const speed = Math.hypot(agent.vx, agent.vy);
      maxJump = Math.max(maxJump, Math.abs(speed - prev));
      prev = speed;
    }

    assert.ok(maxJump < MAX_SPEED * 0.2,
      `煞停應平滑，單步最大速度變化 ${maxJump.toFixed(1)} 不應接近 MAX_SPEED`);
    assert.ok(prev < 1, `煞停結束後應完全靜止，實得 ${prev.toFixed(3)}`);
  });

  test('煞停期間仍會繼續前進一小段，而非原地定住', () => {
    const stage = new Stage();
    const agent = makeAgent(stage, {
      x: 700, y: 750, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
    }

    const releaseX = agent.x;
    agent.inputX = 0; agent.inputY = 0; agent.inputIntensity = 0;
    for (let i = 0; i < 60; i++) { now += 33; stepAgent(agent, [agent], 0.033, now); }

    const glide = agent.x - releaseX;
    assert.ok(glide > 10, `放手後應有滑行距離，實得 ${glide.toFixed(1)}`);
  });

  test('操控中撞向道具仍會沿邊緣繞過，不會卡住', () => {
    // 靜止模式關掉的是自主意圖，不是碰撞處理。若把整個自主項乘 0，
    // 道具斥力的側向分量會一併消失，角色會正面卡在道具前推不過去。
    const stage = new Stage();
    const o = OBSTACLES[0];
    const agent = makeAgent(stage, {
      x: o.x - 260, y: o.y, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    let minDist = Infinity;
    let maxSpeed = 0;
    for (let i = 0; i < 200; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
      minDist = Math.min(minDist, Math.hypot(agent.x - o.x, agent.y - o.y));
      maxSpeed = Math.max(maxSpeed, Math.hypot(agent.vx, agent.vy));
    }

    assert.ok(minDist >= o.r - 0.01, `不應進入道具內部，最近 ${minDist.toFixed(1)}`);
    assert.ok(agent.x > o.x, '應能繞過道具繼續前進，而不是卡在正前方');
    // 繞行是改變方向，不該變成加速
    assert.ok(maxSpeed <= MAX_SPEED + 1e-6, `繞行時不應超速，實得 ${maxSpeed.toFixed(1)}`);
  });

  test('把搖桿拖回原點時角色不會反覆左右翻面', () => {
    // 翻面是整個角色的水平鏡像，是畫面上最醒目的變化。使用者鬆手回中時
    // 手指不可能走直線，向量會在零附近反覆換邊 —— 只用正負號判斷會讓
    // 角色瘋狂左右擺動（實測 12 次翻面）。
    const stage = new Stage();
    const agent = makeAgent(stage, {
      x: 900, y: 750, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
    }

    // 拖回中心：強度遞減，方向因手指微抖反覆換邊
    let flips = 0;
    let prev = agent.facing;
    for (let i = 0; i < 40; i++) {
      agent.inputX = Math.sin(i * 1.1) > 0 ? 1 : -1;
      agent.inputY = 0;
      agent.inputIntensity = Math.max(0, 0.35 * (1 - i / 40));
      agent.lastInputAt = now;
      now += 33;
      stepAgent(agent, [agent], 0.033, now);
      if (agent.facing !== prev) { flips++; prev = agent.facing; }
    }

    assert.equal(flips, 0, `回中期間不應翻面，實得 ${flips} 次`);
  });

  test('回中途中速度不會反覆反向（手指抖動不該變成全速倒車）', () => {
    // 這是「放開搖桿時角色瘋狂左右擺動」的根因回歸測試。
    //
    // INPUT_MOVE 的方向是**單位向量**：靠近搖桿中心時，手指的一點偏移
    // 就是一個滿長度的方向，只有 intensity 在縮放。沒有平滑的話，回中
    // 途中 vx 會是 -95 → 87 → 79 → -71 …（實測 6 次高速反向），
    // 畫面上就是角色以全速步態左右亂晃。
    const stage = new Stage();
    const agent = makeAgent(stage, {
      x: 900, y: 750, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
    }

    let reversals = 0;
    let prev = Math.sign(agent.vx);
    for (let i = 0; i < 12; i++) {
      agent.inputX = Math.sin(i * 1.3) > 0 ? 1 : -1;
      agent.inputY = 0;
      agent.inputIntensity = Math.max(0, 0.5 * (1 - i / 12));
      agent.lastInputAt = now;
      now += 33;
      stepAgent(agent, [agent], 0.033, now);
      const sign = Math.sign(agent.vx);
      if (sign !== 0 && sign !== prev) { reversals++; prev = sign; }
    }

    assert.equal(reversals, 0, `回中途中不應反向，實得 ${reversals} 次`);
  });

  test('真正的轉身仍會改變朝向，且延遲在可接受範圍', () => {
    // 防抖不能矯枉過正：持續往反方向推時必須確實轉身。
    const stage = new Stage();
    const agent = makeAgent(stage, {
      x: 900, y: 750, inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      now += 33;
      agent.lastInputAt = now;
      stepAgent(agent, [agent], 0.033, now);
    }
    assert.equal(agent.facing, 1, '先向右走');

    agent.inputX = -1;
    agent.inputIntensity = 1;
    let turnedAtMs = null;
    for (let i = 0; i < 30; i++) {
      agent.lastInputAt = now;
      now += 33;
      stepAgent(agent, [agent], 0.033, now);
      if (agent.facing === -1 && turnedAtMs === null) turnedAtMs = (i + 1) * 33;
    }

    assert.equal(agent.facing, -1, '持續往左推應該要轉身');
    assert.ok(turnedAtMs <= FACING_DWELL_MS * 2,
      `轉身延遲應接近 FACING_DWELL_MS，實得 ${turnedAtMs}ms`);
  });

  test('合照定位仍可把靜止的角色帶到指定位置', () => {
    // 定位鎖定是第三個速度來源，不能被靜止模式擋掉，
    // 否則 M6 大合照會叫不動任何人。
    const stage = new Stage();
    const agent = makeAgent(stage, { x: 300, y: 300 });
    agent.targetX = 1200;
    agent.targetY = 800;

    let now = 1_000_000;
    for (let i = 0; i < 600; i++) { now += 33; stepAgent(agent, [agent], 0.033, now); }

    const dist = Math.hypot(agent.x - 1200, agent.y - 800);
    assert.ok(dist < 20, `應抵達定位，距離 ${dist.toFixed(1)}`);
  });
});
