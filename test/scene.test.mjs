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
import { BOIDS } from '../server/config.js';

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
  test('角色會被推離道具，不會停在道具內部', () => {
    const stage = new Stage();
    const obstacle = OBSTACLES[0];
    // 直接放在道具正中央
    const agent = makeAgent(stage, { x: obstacle.x, y: obstacle.y });

    run([agent], { steps: 200 });

    const dist = Math.hypot(agent.x - obstacle.x, agent.y - obstacle.y);
    assert.ok(dist > obstacle.r,
      `角色應被推出碰撞半徑（${obstacle.r}），實際距離 ${dist.toFixed(1)}`);
  });

  test('漫遊中的角色長時間不會卡在任何道具裡', () => {
    const stage = new Stage();
    const agents = [];
    for (let i = 0; i < 12; i++) {
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
  test('角色會漂向曾經配對過的那一群人', () => {
    // 偏置的作用不是「讓熟人貼得更近」—— 分離力構成 95 單位的地板，
    // 凝聚力再強也擠不進去。它真正的作用是「決定你往哪一群漂」，
    // 因此以兩個相隔的群體來測，而非單一擁擠的小圈子。
    function trial(withAffinity) {
      const stage = new Stage();
      const graph = new SocialGraph();
      const at = (x, y) => makeAgent(stage, { x, y, wanderAngle: 0 });

      const groupX = [at(700, 480), at(700, 600), at(640, 540)];
      const groupY = [at(1220, 480), at(1220, 600), at(1280, 540)];
      const me = at(960, 540); // 正中間，與兩群等距

      if (withAffinity) for (const y of groupY) graph.connect(me.id, y.id);

      // 關掉漫遊擾動，讓結果只反映凝聚力的差異
      const saved = BOIDS.wanderWeight;
      BOIDS.wanderWeight = 0;
      try {
        run([...groupX, ...groupY, me], {
          steps: 200,
          graph: withAffinity ? graph : null,
        });
      } finally {
        BOIDS.wanderWeight = saved;
      }

      const centroid = (g) => ({
        x: g.reduce((s, a) => s + a.x, 0) / g.length,
        y: g.reduce((s, a) => s + a.y, 0) / g.length,
      });
      const cx = centroid(groupX);
      const cy = centroid(groupY);
      return {
        toX: Math.hypot(me.x - cx.x, me.y - cx.y),
        toY: Math.hypot(me.x - cy.x, me.y - cy.y),
      };
    }

    const biased = trial(true);
    assert.ok(biased.toY < biased.toX * 0.7,
      `應明顯靠向熟人那群：距熟人 ${biased.toY.toFixed(0)}，距陌生人 ${biased.toX.toFixed(0)}`);

    const neutral = trial(false);
    const gap = Math.abs(neutral.toX - neutral.toY);
    assert.ok(gap < Math.min(neutral.toX, neutral.toY) * 0.5,
      `無社交連結時應維持大致等距，實得 ${neutral.toX.toFixed(0)} / ${neutral.toY.toFixed(0)}`);
  });

  test('親和力不影響分離力，熟人仍保有個人空間', () => {
    const stage = new Stage();
    const graph = new SocialGraph();
    const a = makeAgent(stage, { x: 900, y: 540 });
    const b = makeAgent(stage, { x: 920, y: 540 });
    graph.connect(a.id, b.id);

    run([a, b], { steps: 300, graph });

    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(dist > 30,
      `即使已配對，分離力仍應維持個人空間，實際距離 ${dist.toFixed(1)}`);
  });

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
