/**
 * 湧現漫遊態（IDLE_MOTION === 'wander'）的群體動力學測試
 *
 * ⚠ 本檔必須在 PERSONAFLOW_IDLE_MOTION=wander 之下執行，見 package.json 的
 *   test:wander。IDLE_MOTION 於模組載入時讀取，同一個行程內無法中途切換，
 *   因此這些測試不能與預設（'still'）的測試混在同一次 node --test 執行。
 *
 * 這裡驗的全都是「沒有人操控時角色自己會做什麼」—— 分離、凝聚、漫遊、
 * 道具排開。預設模式刻意讓角色靜止，這些行為在那之下全部不成立，
 * 但參數改回 'wander' 時它們仍必須正確，所以測試保留而非刪除。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stepAgent } from '../server/arbiter.js';
import { Stage } from '../server/state.js';
import { SocialGraph } from '../server/socialgraph.js';
import { OBSTACLES } from '../shared/scene.js';
import { BOIDS, IDLE_MOTION } from '../server/config.js';

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

/** 推進一段時間 */
function run(agents, { steps, dt = 0.033, graph = null }) {
  let now = 1_000_000;
  for (let i = 0; i < steps; i++) {
    now += dt * 1000;
    for (const a of agents) {
      stepAgent(a, agents, dt, now, graph ? graph.neighbors(a.id) : null);
    }
  }
}

// IDLE_MOTION 於模組載入時定案，同一行程無法中途切換，因此預設（'still'）
// 那一輪跑到本檔時整組跳過，改由 npm run test:wander 以正確的環境變數再跑一次。
// 用 skip 而非讓它失敗，npm test 才能一次跑完兩種模式。
describe("湧現漫遊態（IDLE_MOTION='wander'）", { skip: IDLE_MOTION !== 'wander' && '需 PERSONAFLOW_IDLE_MOTION=wander（見 npm run test:wander）' }, () => {

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

  test('分離力會把重疊的角色推開', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    // 兩個角色相距僅 20（遠小於分離半徑 95），且均無手動輸入
    const a = makeAgent(stage, { x: 900, y: 540, lastInputAt: 0 });
    const b = makeAgent(stage, { x: 920, y: 540, lastInputAt: 0 });
    const agents = [a, b];

    let now = t0;
    for (let i = 0; i < 200; i++) {
      now += 33;
      for (const ag of agents) stepAgent(ag, agents, 0.033, now);
    }

    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(dist > 20, `分離力應把角色推開，起始 20，最終 ${dist.toFixed(1)}`);
  });

  test('無鄰居的孤立角色仍會漫遊，不會靜止', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { x: 960, y: 540, lastInputAt: 0 });
    const start = { x: agent.x, y: agent.y };

    let now = t0;
    for (let i = 0; i < 150; i++) { now += 33; stepAgent(agent, [agent], 0.033, now); }

    const moved = Math.hypot(agent.x - start.x, agent.y - start.y);
    assert.ok(moved > 50, `孤立角色應持續漫遊，實際位移僅 ${moved.toFixed(1)}`);
  });

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
});
