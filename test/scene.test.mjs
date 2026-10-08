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
import { DOORWAYS, OBSTACLES, PROPS, WALLS, ZONES, obstacleDistance } from '../shared/scene.js';
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
    // 只算道具，不算牆：牆不是散在地板中間的障礙，而是房間的邊，
    // 把它算進「佔掉的地板」會讓這個比例失去意義。
    const occupied = PROPS.reduce((s, o) => s + Math.PI * o.r ** 2, 0);
    const ratio = occupied / (STAGE.width * STAGE.height);
    assert.ok(ratio < 0.1, `道具佔 ${(ratio * 100).toFixed(1)}%，過於擁擠`);
  });

  test('牆真的擋得住，門以外的地方穿不過去', () => {
    // 牆是裝飾變成物理的那一刻才有意義。只要有人把牆段的座標改錯，
    // 畫面上仍然是一道牆，但角色會直接穿牆走進菜園 —— 沒有任何錯誤訊息。
    for (const w of WALLS) {
      for (let y = w.y + 1; y < w.y2; y += 10) {
        assert.ok(OBSTACLES.some((o) => obstacleDistance(o, w.x, y) < o.r),
          `牆 ${w.id} 在 y=${y} 沒有擋住`);
      }
    }
  });

  test('室外的兩塊地走得到：牆上必須真的留了門', () => {
    // 這一則守的是「牆改了但忘記留門」。症狀是現場有一塊地永遠沒有人進得去，
    // 而那正是把舞台擴張到整張圖想解決的問題本身。
    const STEP = 10;
    const free = (x, y) => x >= 0 && y >= 0 && x <= STAGE.width && y <= STAGE.height
      && OBSTACLES.every((o) => obstacleDistance(o, x, y) >= o.r);

    const key = (ix, iy) => `${ix},${iy}`;
    const seen = new Set();
    const start = [Math.round(1300 / STEP), Math.round(540 / STEP)];   // 室內正中央
    assert.ok(free(start[0] * STEP, start[1] * STEP), '起點本身要是空地');
    const queue = [start];
    seen.add(key(...start));
    while (queue.length) {
      const [ix, iy] = queue.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = ix + dx, ny = iy + dy;
        if (seen.has(key(nx, ny)) || !free(nx * STEP, ny * STEP)) continue;
        seen.add(key(nx, ny));
        queue.push([nx, ny]);
      }
    }
    const reached = (x, y) => seen.has(key(Math.round(x / STEP), Math.round(y / STEP)));
    // 取菜畦南邊那一點：它只能經由靠牆的那條走道走到，等於順便驗了
    // 「道具沒有把室外區封死」
    assert.ok(reached(250, 950), '西側的室外區（菜園／大廳）從室內走不到');
    assert.ok(reached(2450, 600), '東側的室外區（露台／遊戲間）從室內走不到');
  });

  test('室外的道具要留得下一條走道', () => {
    // 西側可站的只有 0 到牆面那一段。道具再往右擺一點，靠牆那條走道就會窄到
    // 角色擠不過去 —— 而症狀不是「卡住」，是整塊室外區沒有人進得去，
    // 跟當初沒有門是同一個結果。
    const wall = WALLS.find((w) => w.id.startsWith('wall_w'));
    const face = wall.x - wall.r;
    const west = PROPS.filter((prop) => prop.x < face);
    assert.ok(west.length >= 3, '西側室外區應該要有道具可以當集合點');
    for (const prop of west) {
      const lane = face - (prop.x + prop.r);
      assert.ok(lane >= 60, `${prop.id} 與牆之間只剩 ${lane}，走不過去`);
      assert.ok(prop.x - prop.r >= 0, `${prop.id} 凸出場域左緣`);
    }
  });

  test('門的淨寬容得下一個人走過去', () => {
    // 門高扣掉牆兩端的碰撞半徑才是真正過得去的寬度。留得太窄的話，
    // 兩側牆段的斥力會在門口正中央對消，角色卡在門前原地抖動。
    for (const d of DOORWAYS) {
      const x = d.x + d.w / 2;
      let open = 0;
      for (let y = d.y; y <= d.y + d.h; y += 2) {
        if (OBSTACLES.every((o) => obstacleDistance(o, x, y) >= o.r)) open += 2;
      }
      assert.ok(open >= 120, `${d.id} 的淨寬只有 ${open}`);
    }
  });

  test('避障清單＝道具在前、牆在後', () => {
    // 順序有意義：好幾組測試以 OBSTACLES[n] 取「某個道具」，
    // 牆插到前面會讓它們改成測到一道牆，而且還是會通過。
    assert.equal(OBSTACLES.length, PROPS.length + WALLS.length);
    assert.deepEqual(OBSTACLES.slice(0, PROPS.length).map((o) => o.r), PROPS.map((p) => p.r));
    assert.ok(OBSTACLES.slice(PROPS.length).every((o) => o.x2 !== undefined));
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
          if (obstacleDistance(o, a.x, a.y) < o.r - 0.01) violations++;
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
