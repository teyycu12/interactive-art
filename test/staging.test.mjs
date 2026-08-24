/**
 * 定位鎖定與朝向測試
 *
 * 這兩項是為了讓合照（M4）與 3D 渲染能在不修改 M2 的前提下接手。
 * 測試的重點在「交接處的契約」—— 到位判定、平滑接管、朝向一致性 ——
 * 而不只是功能有沒有動。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stepAgent } from '../server/arbiter.js';
import { Stage } from '../server/state.js';
import { OBSTACLES } from '../shared/scene.js';
import { STAGE, AGENT_MODE } from '../shared/protocol.js';
import { ARRIVE, MAX_SPEED } from '../server/config.js';

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

/** 推進場域一段時間 */
function run(stage, steps, dt = 0.033) {
  for (let i = 0; i < steps; i++) stage.tick(dt);
}

describe('出生點', () => {
  test('不會落在道具內部', () => {
    const stage = new Stage();
    for (let i = 0; i < 500; i++) {
      const a = stage.addAgent({ name: 'T', avatar: AVATAR });
      for (const o of OBSTACLES) {
        assert.ok(Math.hypot(a.x - o.x, a.y - o.y) >= o.r,
          `出生點落在 ${o.x},${o.y} 的道具內`);
      }
      stage.removeAgent(a.id);
    }
  });

  test('出生點仍在場域範圍內', () => {
    const stage = new Stage();
    for (let i = 0; i < 200; i++) {
      const a = stage.addAgent({ name: 'T', avatar: AVATAR });
      assert.ok(a.x >= 0 && a.x <= STAGE.width);
      assert.ok(a.y >= 0 && a.y <= STAGE.height);
      stage.removeAgent(a.id);
    }
  });
});

describe('定位鎖定', () => {
  test('角色會移動到指定位置並回報到位', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 300, y: 300 });

    stage.lockStage(new Map([[a.id, { x: 1400, y: 800 }]]));
    assert.equal(stage.locked, true);

    run(stage, 400);

    assert.ok(Math.hypot(a.x - 1400, a.y - 800) <= ARRIVE.epsilon,
      `應停在目標位置，實際 (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`);
    assert.equal(a.arrived, true);
    assert.equal(stage.allArrived(), true);
  });

  test('接管是漸進的，不會瞬間變向', () => {
    const stage = new Stage();
    // 先讓角色以固定速度往右移動
    const a = makeAgent(stage, { x: 960, y: 540, boidsVx: MAX_SPEED, boidsVy: 0 });
    run(stage, 30);
    const before = { vx: a.vx, vy: a.vy };

    // 指派一個反方向的目標
    stage.lockStage(new Map([[a.id, { x: 200, y: 540 }]]));

    // 接管後的第一個 tick，速度不應立刻翻轉
    stage.tick(0.033);
    const delta = Math.hypot(a.vx - before.vx, a.vy - before.vy);
    assert.ok(delta < MAX_SPEED * 0.5,
      `單一 tick 的速度變化過大（${delta.toFixed(1)}），接管不夠平滑`);
    assert.ok(a.lockAlpha > 0 && a.lockAlpha < 1, '接管權重應在過渡中');
  });

  test('鎖定期間使用者操控不生效', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 960, y: 540 });
    stage.lockStage(new Map([[a.id, { x: 960, y: 900 }]]));

    // 持續往反方向推桿
    for (let i = 0; i < 300; i++) {
      stage.applyMove(a.id, { x: 0, y: -1, intensity: 1 });
      stage.tick(0.033);
    }

    assert.ok(a.arrived, '仍應抵達指定位置');
    assert.ok(Math.abs(a.y - 900) <= ARRIVE.epsilon,
      `操控不應把角色拉離定位，實際 y=${a.y.toFixed(1)}`);
    assert.equal(a.mode, AGENT_MODE.STAGED);
  });

  test('接近目標時會減速，不會衝過頭再折返', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 300, y: 540 });
    stage.lockStage(new Map([[a.id, { x: 1200, y: 540 }]]));

    let maxOvershoot = 0;
    for (let i = 0; i < 400; i++) {
      stage.tick(0.033);
      if (a.x > 1200) maxOvershoot = Math.max(maxOvershoot, a.x - 1200);
    }
    assert.ok(maxOvershoot <= ARRIVE.epsilon,
      `不應衝過目標，最大超調 ${maxOvershoot.toFixed(1)}`);
  });

  test('可指定到位後的朝向，供合照面向鏡頭', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 900, y: 540 });
    const facing = -Math.PI / 2; // 面向畫面上方

    stage.lockStage(new Map([[a.id, { x: 960, y: 540, heading: facing }]]));
    run(stage, 400);

    assert.equal(a.arrived, true);
    assert.ok(Math.abs(a.heading - facing) < 0.05,
      `到位後應轉向指定方向，實際 ${a.heading.toFixed(3)} 期望 ${facing.toFixed(3)}`);
  });

  test('allArrived 在還有人未到位時為 false', () => {
    const stage = new Stage();
    const near = makeAgent(stage, { x: 950, y: 540 });
    const far = makeAgent(stage, { x: 100, y: 100 });

    stage.lockStage(new Map([
      [near.id, { x: 960, y: 540 }],
      [far.id, { x: 1800, y: 1000 }],
    ]));

    run(stage, 40);
    assert.equal(stage.allArrived(), false, '尚有角色在移動中');

    run(stage, 600);
    assert.equal(stage.allArrived(), true);
  });

  test('未指派目標的角色不影響 allArrived 判定', () => {
    const stage = new Stage();
    const staged = makeAgent(stage, { x: 950, y: 540 });
    makeAgent(stage, { x: 400, y: 400 }); // 自由活動，未被指派

    stage.lockStage(new Map([[staged.id, { x: 960, y: 540 }]]));
    run(stage, 300);
    assert.equal(stage.allArrived(), true);
  });

  test('無人被指派時 allArrived 為 false，避免空場誤判為已就緒', () => {
    const stage = new Stage();
    makeAgent(stage);
    assert.equal(stage.allArrived(), false);
  });

  test('解除鎖定後角色恢復自由活動', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 300, y: 300 });
    stage.lockStage(new Map([[a.id, { x: 960, y: 540 }]]));
    run(stage, 400);
    assert.equal(a.arrived, true);

    stage.unlockStage();
    assert.equal(stage.locked, false);
    assert.equal(a.targetX, null);

    run(stage, 200);
    assert.notEqual(a.mode, AGENT_MODE.STAGED, '應已離開定位模式');
    assert.ok(Math.hypot(a.x - 960, a.y - 540) > ARRIVE.epsilon, '應重新開始漫遊');
  });

  test('鎖定不存在的角色不會出錯', () => {
    const stage = new Stage();
    const n = stage.lockStage(new Map([['usr_nobody', { x: 100, y: 100 }]]));
    assert.equal(n, 0);
    assert.equal(stage.locked, false);
  });
});

describe('朝向', () => {
  test('移動時朝向行進方向', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 960, y: 540, heading: 0 });
    // 往下移動（+y），期望朝向 π/2
    stage.lockStage(new Map([[a.id, { x: 960, y: 900 }]]));
    run(stage, 60);
    assert.ok(Math.abs(a.heading - Math.PI / 2) < 0.2,
      `應朝向 +y，實際 ${a.heading.toFixed(3)}`);
  });

  test('靜止時保持朝向，不會原地亂轉', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 960, y: 540 });
    stage.lockStage(new Map([[a.id, { x: 960, y: 540 }]])); // 目標即原地
    run(stage, 120);

    const h1 = a.heading;
    run(stage, 120);
    assert.equal(a.heading, h1, '靜止時朝向不應變動');
  });

  test('轉向有速率上限，不會瞬間翻面', () => {
    const stage = new Stage();
    const a = makeAgent(stage, { x: 960, y: 540, heading: 0 });
    stage.lockStage(new Map([[a.id, { x: 500, y: 540 }]])); // 需轉向 π

    const before = a.heading;
    stage.tick(0.033);
    let diff = Math.abs(a.heading - before);
    while (diff > Math.PI) diff -= Math.PI * 2;
    assert.ok(Math.abs(diff) < 0.5, `單一 tick 轉幅過大：${diff.toFixed(3)} 弧度`);
  });

  test('走最短路徑轉向，不會繞遠路', () => {
    const stage = new Stage();
    // 朝向接近 +π，目標方向為 -π+0.1，最短路徑應跨過 ±π 邊界
    const a = makeAgent(stage, { x: 960, y: 540, heading: Math.PI - 0.05 });
    stage.lockStage(new Map([[a.id, { x: 500, y: 545 }]]));

    let maxStep = 0;
    let prev = a.heading;
    for (let i = 0; i < 60; i++) {
      stage.tick(0.033);
      let d = Math.abs(a.heading - prev);
      if (d > Math.PI) d = Math.PI * 2 - d; // 跨邊界的視覺轉幅
      maxStep = Math.max(maxStep, d);
      prev = a.heading;
    }
    assert.ok(maxStep < 0.5, `不應出現繞遠路的大跳轉，最大單步 ${maxStep.toFixed(3)}`);
  });

  test('snapshot 帶出 heading 與 arrived，供 3D 與合照使用', () => {
    const stage = new Stage();
    const a = makeAgent(stage);
    stage.lockStage(new Map([[a.id, { x: 960, y: 540 }]]));
    run(stage, 400);

    const snap = stage.snapshot()[0];
    assert.equal(typeof snap.heading, 'number');
    assert.ok(Number.isFinite(snap.heading));
    assert.equal(snap.arrived, true);
  });

  test('未定位時不送 arrived，節省廣播頻寬', () => {
    const stage = new Stage();
    makeAgent(stage);
    run(stage, 10);
    assert.equal('arrived' in stage.snapshot()[0], false);
  });
});

describe('社交動作進度', () => {
  test('emoteT 隨時間由 0 遞增至 1', async () => {
    const stage = new Stage();
    const a = makeAgent(stage);
    stage.applyAction(a.id, 'CHEERS');

    const first = stage.snapshot()[0];
    assert.equal(first.emote, 'CHEERS');
    assert.ok(first.emoteT < 0.1, `剛觸發時應接近 0，實得 ${first.emoteT}`);

    await new Promise((r) => setTimeout(r, 300));
    const later = stage.snapshot()[0];
    assert.ok(later.emoteT > first.emoteT, '進度應隨時間遞增');
    assert.ok(later.emoteT <= 1);
  });

  test('沒有動作時不送 emoteT，節省廣播頻寬', () => {
    const stage = new Stage();
    makeAgent(stage);
    const snap = stage.snapshot()[0];
    assert.equal(snap.emote, null);
    assert.equal('emoteT' in snap, false, '無動作時不應出現此欄位');
  });
});

describe('避障交接', () => {
  /** 速度朝道具中心的分量，正值代表朝道具內部 */
  function inwardComponent(agent, o, vx, vy) {
    const dx = o.x - agent.x;
    const dy = o.y - agent.y;
    const len = Math.hypot(dx, dy) || 1;
    return (vx * dx + vy * dy) / len;
  }

  test('剛體修正會一併消去影子速度朝道具內的分量', () => {
    const stage = new Stage();
    const o = OBSTACLES[5];
    // 陷在道具裡，且影子速度直接朝道具中心
    const a = makeAgent(stage, {
      x: o.x + o.r - 4, y: o.y,
      boidsVx: -MAX_SPEED, boidsVy: 0,
    });
    assert.ok(inwardComponent(a, o, a.boidsVx, a.boidsVy) > 100, '前提：初始朝道具內');

    stage.tick(0.033);

    const into = inwardComponent(a, o, a.boidsVx, a.boidsVy);
    assert.ok(into < 1,
      `修正後影子速度不應仍朝道具內部（分量 ${into.toFixed(1)}）`);
  });

  test('放開搖桿的瞬間，貼牆角色不會朝道具衝進去', () => {
    // 這是原始 bug 的實際症狀：只修正 vx/vy 而不修正影子速度時，
    // α 交還給 Boids 的瞬間，角色會朝道具內部加速。
    const stage = new Stage();
    const o = OBSTACLES[5];
    const a = makeAgent(stage, { x: o.x + o.r + 40, y: o.y });

    // 持續往道具方向推桿，把角色壓在道具邊緣
    let now = Date.now();
    for (let i = 0; i < 90; i++) {
      stage.applyMove(a.id, { x: -1, y: 0, intensity: 1 });
      stage.tick(0.033);
      now += 33;
    }
    assert.ok(a.alpha > 0.9, '前提：應處於主動控制態');

    // 放開搖桿後觀察，角色不該侵入道具
    let deepest = Infinity;
    for (let i = 0; i < 200; i++) {
      stage.tick(0.033);
      deepest = Math.min(deepest, Math.hypot(a.x - o.x, a.y - o.y));
    }
    assert.ok(deepest >= o.r - 0.01,
      `放手後不應侵入道具（半徑 ${o.r}），最近距離 ${deepest.toFixed(1)}`);
  });
});
