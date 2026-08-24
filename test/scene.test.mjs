/**
 * 場景避障與社交親和力偏置測試（技術文件 M3、規格 v3.0 §4.2）
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stepAgent } from '../server/arbiter.js';
import { Stage } from '../server/state.js';
import { SocialGraph } from '../server/socialgraph.js';
import { OBSTACLES, PROPS, ZONES } from '../shared/scene.js';
import { STAGE } from '../shared/protocol.js';
import { BOIDS, MAX_AGENTS } from '../server/config.js';

const AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

function makeAgent(stage, overrides = {}) {
  const a = stage.addAgent({ name: 'T', avatar: AVATAR });
  a.boidsVx = 0;
  a.boidsVy = 0;
  a.lastInputAt = 0; // 一出生即為漫遊態
  Object.assign(a, overrides);
  return a;
}

/** 推進一段時間，回傳最終狀態 */
function run(agents, { steps, dt = 0.033, graph = null }) {
  let now = 1_000_000;
  for (let i = 0; i < steps; i++) {
    now += dt * 1000;
    for (const a of agents) {
      stepAgent(a, agents, dt, now, graph ? graph.neighbors(a.id) : null);
    }
  }
}

describe('場域佈局', () => {
  test('所有道具都在場域範圍內', () => {
    for (const p of PROPS) {
      assert.ok(p.x >= 0 && p.x <= STAGE.width, `${p.id} 的 x 超出場域：${p.x}`);
      assert.ok(p.y >= 0 && p.y <= STAGE.height, `${p.id} 的 y 超出場域：${p.y}`);
    }
  });

  test('所有分區都在場域範圍內', () => {
    for (const z of ZONES) {
      assert.ok(z.x >= 0 && z.x + z.w <= STAGE.width, `${z.id} 水平超出場域`);
      assert.ok(z.y >= 0 && z.y + z.h <= STAGE.height, `${z.id} 垂直超出場域`);
    }
  });

  test('道具彼此不重疊，避免視覺穿插', () => {
    for (let i = 0; i < PROPS.length; i++) {
      for (let j = i + 1; j < PROPS.length; j++) {
        const a = PROPS[i];
        const b = PROPS[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(dist >= a.r + b.r,
          `${a.id} 與 ${b.id} 的碰撞半徑重疊（距離 ${dist.toFixed(0)}，需 ${a.r + b.r}）`);
      }
    }
  });

  test('道具佔用的面積遠小於場域，仍有充足漫遊空間', () => {
    const occupied = OBSTACLES.reduce((s, o) => s + Math.PI * o.r ** 2, 0);
    const ratio = occupied / (STAGE.width * STAGE.height);
    assert.ok(ratio < 0.1, `道具佔 ${(ratio * 100).toFixed(1)}%，過於擁擠`);
  });

  test('避障清單與道具清單一致', () => {
    assert.equal(OBSTACLES.length, PROPS.length);
  });
});

describe('剛體避障', () => {

  test('漫遊中的角色長時間不會卡在任何道具裡', () => {
    const stage = new Stage();
    const agents = [];
    // 綁在 MAX_AGENTS 上而非寫死：這裡驗的是「角色不會卡進道具」，
    // 具體幾個不重要，但超過場域上限時 addAgent 會回 null。
    for (let i = 0; i < MAX_AGENTS; i++) {
      agents.push(makeAgent(stage, {
        x: 200 + (i % 4) * 450,
        y: 200 + Math.floor(i / 4) * 320,
      }));
    }

    let violations = 0;
    let now = 1_000_000;
    for (let i = 0; i < 900; i++) {
      now += 33;
      for (const a of agents) {
        stepAgent(a, agents, 0.033, now);
        for (const o of OBSTACLES) {
          // 位置修正是硬保證，任何一幀結束時都不該有角色位於道具內部
          if (Math.hypot(a.x - o.x, a.y - o.y) < o.r - 0.01) violations++;
        }
      }
    }
    assert.equal(violations, 0, `出現 ${violations} 次陷入道具的情形`);
  });

  test('手動操控的角色也不會穿過道具，而是沿邊緣滑過', () => {
    // α = 1 時 Boids 的柔性閃避力完全不生效（使用者的操控不該被系統接管），
    // 因此穿透只能靠位置修正擋下。這一則就是在驗證那道硬保證。
    const stage = new Stage();
    const o = OBSTACLES[0];
    const agent = makeAgent(stage, {
      x: o.x - 260, y: o.y,
      inputX: 1, inputY: 0, inputIntensity: 1,
    });

    let now = 1_000_000;
    let minDist = Infinity;
    for (let i = 0; i < 200; i++) {
      now += 33;
      agent.lastInputAt = now; // 維持在主動控制態
      stepAgent(agent, [agent], 0.033, now);
      minDist = Math.min(minDist, Math.hypot(agent.x - o.x, agent.y - o.y));
    }

    assert.equal(agent.alpha, 1, '持續操控時 α 應為 1');
    assert.ok(minDist >= o.r - 0.01,
      `角色不應進入道具內部（半徑 ${o.r}），最近距離 ${minDist.toFixed(1)}`);
    assert.ok(agent.x > o.x, '應能繞過道具繼續前進，而不是被卡住');
  });
});

describe('社交親和力偏置', () => {

  test('未傳入圖譜時行為不變，偏置為選用功能', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 900, y: 540 });
    const b = makeAgent(stage, { x: 1000, y: 540 });
    assert.doesNotThrow(() => run([a, b], { steps: 60, graph: null }));
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
  });

  test('Stage.tick 可接受圖譜並正常推進', () => {
    const stage = new Stage();
    const graph = new SocialGraph();
    const a = makeAgent(stage);
    const b = makeAgent(stage);
    graph.connect(a.id, b.id);
    assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) stage.tick(0.033, graph); });
    for (const ag of stage.agents.values()) {
      assert.ok(Number.isFinite(ag.x) && Number.isFinite(ag.y), '座標不應變成 NaN');
    }
  });
});
