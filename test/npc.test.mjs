/**
 * NPC（server/npc.js）。
 *
 * 兩件最容易默默壞掉的事：
 *   1. NPC 跑進既有玩法 —— 配對、賓果、報表、人數上限都走 stage.agents，
 *      NPC 一旦混進去，「跟 NPC 配對完成任務」不會報任何錯。
 *   2. 走法卡死 —— 卡在門邊、陷進物件、一直站著不動或一直走不停，畫面上只是「怪怪的」。
 * 走法用模擬時間跑幾分鐘來驗。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '../server/state.js';
import { NpcDirector, regionOf, route, NPC_NICKS } from '../server/npc.js';
import { NPC, MAX_AGENTS, MAX_SPEED, IDLE_MOTION } from '../server/config.js';
import { OBSTACLES, obstacleDistance } from '../shared/scene.js';
import { THEME_MAP } from '../shared/themes.js';

const TICK = 1 / 30;
const LOOK = (n) => ({ assetId: `a${n}`.padEnd(32, '0'), avatar: { source: 'CV', textures: {}, fallbackColors: {} } });

/** stage.tick 讀 Date.now()，NPC 用傳進去的時間：兩邊要是同一個時鐘 */
let clock;
const realNow = Date.now;
beforeEach(() => { clock = 1_000_000; Date.now = () => clock; });
afterEach(() => { Date.now = realNow; });

/** 用固定的亂數，每次跑出一樣的結果 */
function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

function setup({ count = 4, mode = 'fixed', looks = 3, theme = 'kitchen' } = {}) {
  const stage = new Stage();
  const npcs = new NpcDirector(stage, { rng: seeded(), theme: () => theme });
  npcs.setLibrary(Array.from({ length: looks }, (_, i) => LOOK(i)));
  npcs.configure({ enabled: true, mode, count });
  return { stage, npcs };
}

/** 跑 seconds 秒，每幀呼叫 onFrame */
function run(stage, npcs, seconds, onFrame = () => {}, opts = {}) {
  for (let i = 0; i < seconds * 30; i++) {
    clock += 1000 / 30;
    npcs.tick(clock, opts);
    stage.tick(TICK);
    onFrame();
  }
}

describe('NPC 不混進真人', () => {
  test('不在 agents 裡、不佔人數上限，stage.get 也找不到', () => {
    const { stage, npcs } = setup({ count: 3 });
    run(stage, npcs, 10);
    assert.equal(stage.npcs.size, 3);
    assert.equal(stage.agents.size, 0);
    for (let i = 0; i < MAX_AGENTS; i++) stage.addAgent({ name: `p${i}`, avatar: {} });
    assert.ok(stage.isFull(), 'NPC 不該佔掉真人的名額');
    assert.equal(stage.agents.size, MAX_AGENTS);
    for (const id of stage.npcs.keys()) assert.equal(stage.get(id), undefined);
  });

  test('畫面同步帶得到 NPC，並標成 npc', () => {
    const { stage, npcs } = setup({ count: 2 });
    const me = stage.addAgent({ name: '我', avatar: {} });
    run(stage, npcs, 5);
    const [id] = stage.npcs.keys();
    assert.equal(stage.snapshot().find((a) => a.id === id)?.npc, true);
    assert.equal(stage.roster().find((a) => a.id === id)?.npc, true);
    assert.equal(stage.nameRoster().find((a) => a.id === id)?.npc, true);
    assert.equal(stage.snapshot().find((a) => a.id === me.id)?.npc, undefined);
    // 個人視角：把 NPC 拉到自己旁邊
    const n = stage.npcs.get(id);
    n.x = me.x + 50; n.y = me.y;
    assert.equal(stage.personalSnapshot(me.id, 320).neighbors.find((a) => a.id === id)?.npc, true);
  });

  test('分區人數與分區進出只算真人', () => {
    const { stage, npcs } = setup({ count: 4 });
    let moves = 0;
    for (let i = 0; i < 30 * 60; i++) {
      clock += 1000 / 30;
      npcs.tick(clock);
      moves += stage.tick(TICK).length;
    }
    assert.equal(moves, 0);
    assert.deepEqual(stage.zoneOccupancy(), {});
  });
});

describe('NPC 數量', () => {
  test('固定 N 個：一次只進一個', () => {
    const { stage, npcs } = setup({ count: 4 });
    run(stage, npcs, NPC.spawnGapMs / 1000 * 1.5);
    assert.ok(stage.npcs.size >= 1 && stage.npcs.size <= 2, `一次只進一個（實際 ${stage.npcs.size}）`);
    run(stage, npcs, 10);
    assert.equal(stage.npcs.size, 4);
  });

  test('場上至少 N 人：真人越多 NPC 越少，不超過上限', () => {
    const { stage, npcs } = setup({ count: 6, mode: 'atLeast' });
    assert.equal(npcs.target(0), 6);
    assert.equal(npcs.target(4), 2);
    assert.equal(npcs.target(10), 0);
    npcs.configure({ count: 30 });
    assert.equal(npcs.target(0), NPC.maxCount);
    for (let i = 0; i < 5; i++) stage.addAgent({ name: `p${i}`, avatar: {} });
    npcs.configure({ count: 6 });
    run(stage, npcs, 15);
    assert.equal(npcs.staying().length, 1);
  });

  test('外型庫是空的、或關掉時，一個都不進', () => {
    const { stage, npcs } = setup({ count: 4 });
    npcs.setLibrary([]);
    run(stage, npcs, 10);
    assert.equal(stage.npcs.size, 0);
    npcs.setLibrary([LOOK(0)]);
    npcs.configure({ enabled: false });
    run(stage, npcs, 10);
    assert.equal(stage.npcs.size, 0);
  });

  test('關掉之後走到門口消失，不憑空不見', () => {
    const { stage, npcs } = setup({ count: 4 });
    run(stage, npcs, 60);
    npcs.configure({ enabled: false });
    clock += 1000 / 30;
    npcs.tick(clock);
    assert.equal(stage.npcs.size, 4, '先開始走，不是立刻刪掉');
    run(stage, npcs, (NPC.spawnGapMs / 1000) * 4 + NPC.leaveTimeoutMs / 1000 + 2);
    assert.equal(stage.npcs.size, 0);
  });

  test('外型被移出庫：用著它的 NPC 退場，換別的外型補上', () => {
    const { stage, npcs } = setup({ count: 2, looks: 2 });
    run(stage, npcs, 20);
    const gone = LOOK(0).assetId;
    npcs.setLibrary([LOOK(1), LOOK(2)]);
    run(stage, npcs, 40);
    assert.ok([...stage.npcs.values()].every((n) => n.npc.assetId !== gone));
    assert.equal(stage.npcs.size, 2);
  });

  test('外型盡量不重複，名字同時在場不重複', () => {
    const { stage, npcs } = setup({ count: 3, looks: 3 });
    run(stage, npcs, 15);
    const looks = [...stage.npcs.values()].map((n) => n.npc.assetId);
    assert.equal(new Set(looks).size, 3);
    const nicks = [...stage.npcs.values()].map((n) => n.npc.nick);
    assert.equal(new Set(nicks).size, 3);
    assert.ok(nicks.every((n) => NPC_NICKS.includes(n)));
  });
});

describe('NPC 名牌', () => {
  test('身分・名字，身分跟著場景換', () => {
    let theme = 'kitchen';
    const stage = new Stage();
    const npcs = new NpcDirector(stage, { rng: seeded(), theme: () => theme });
    npcs.setLibrary([LOOK(0)]);
    npcs.configure({ enabled: true, count: 1 });
    run(stage, npcs, 3);
    const n = [...stage.npcs.values()][0];
    const [role] = n.name.split('・');
    assert.ok(THEME_MAP.kitchen.npcRoles.includes(role), n.name);
    assert.equal(n.name.split('・')[1], n.npc.nick);
    theme = 'gym';
    npcs.retitle();
    assert.ok(THEME_MAP.gym.npcRoles.includes(n.name.split('・')[0]), n.name);
  });
});

describe('NPC 走法', () => {
  test('走走停停：幾分鐘內換過好幾個地方，有走也有停，不陷進物件', () => {
    const { stage, npcs } = setup({ count: 4 });
    const hops = new Map();
    let moving = 0, standing = 0, inside = 0;
    run(stage, npcs, 240, () => {
      for (const n of stage.npcs.values()) {
        if (n.npc.state === 'walk' && n.npc.dest !== hops.get(n.id)?.last) {
          hops.set(n.id, { last: n.npc.dest, count: (hops.get(n.id)?.count ?? 0) + 1 });
        }
        if (Math.hypot(n.vx, n.vy) > 5) moving++; else standing++;
        if (OBSTACLES.some((o) => obstacleDistance(o, n.x, n.y) < o.r - 2)) inside++;
      }
    });
    assert.equal(inside, 0, '陷進物件或牆裡');
    for (const [id, h] of hops) assert.ok(h.count >= 4, `${id} 4 分鐘只換了 ${h.count} 個地方`);
    const share = moving / (moving + standing);
    assert.ok(share > 0.15 && share < 0.85, `走路時間佔 ${(share * 100).toFixed(0)}%，應該有走有停`);
  });

  test('走得比真人推滿慢', () => {
    const { stage, npcs } = setup({ count: 3 });
    let top = 0;
    run(stage, npcs, 60, () => {
      for (const n of stage.npcs.values()) top = Math.max(top, Math.hypot(n.vx, n.vy));
    });
    assert.ok(top <= NPC.speed * MAX_SPEED * 1.05, `最快 ${top.toFixed(1)}`);
    assert.ok(top > 0);
  });

  test('室內外之間一定經過門', () => {
    assert.equal(regionOf(100), 'w');
    assert.equal(regionOf(1300), 'in');
    assert.equal(regionOf(2500), 'e');
    const path = route({ x: 150, y: 700 }, { x: 2450, y: 900 });
    assert.equal(path.length, 5, '西側室外 → 室內 → 東側室外，各穿一次門');
    assert.deepEqual(path.at(-1), { x: 2450, y: 900 });
    assert.equal(route({ x: 800, y: 500 }, { x: 1500, y: 600 }).length, 1, '同一區直接走');
  });

  test('走得到室外再走回來，不卡在牆上', () => {
    const { stage, npcs } = setup({ count: 1 });
    run(stage, npcs, 3);
    const n = [...stage.npcs.values()][0];
    const m = n.npc;
    // 直接指定一個西側室外的目的地
    n.x = 1200; n.y = 600;
    m.state = 'walk'; m.dest = { x: 160, y: 560 }; m.path = route(n, m.dest);
    m.progressAt = clock; m.progressDist = Infinity;
    let reached = false;
    run(stage, npcs, 60, () => { if (m.state === 'dwell' && regionOf(n.x) === 'w') reached = true; });
    assert.ok(reached, `沒走到室外（停在 ${n.x.toFixed(0)}, ${n.y.toFixed(0)}）`);
  });

  test('問答進行中停在原地', () => {
    const { stage, npcs } = setup({ count: 3 });
    run(stage, npcs, 30);
    run(stage, npcs, 3, () => {}, { frozen: true });
    const before = [...stage.npcs.values()].map((n) => [n.x, n.y]);
    run(stage, npcs, 5, () => {}, { frozen: true });
    const after = [...stage.npcs.values()].map((n) => [n.x, n.y]);
    before.forEach(([x, y], i) => assert.ok(Math.hypot(after[i][0] - x, after[i][1] - y) < 1));
  });

  test('真人走近，停著的 NPC 揮手；一直站在旁邊不會一直揮', () => {
    const { stage, npcs } = setup({ count: 1 });
    run(stage, npcs, 3);
    const n = [...stage.npcs.values()][0];
    n.npc.state = 'dwell'; n.npc.until = clock + 60_000;
    const h = stage.addAgent({ name: '路人', avatar: {} });
    h.x = n.x + 100; h.y = n.y;
    const waves = new Set();
    run(stage, npcs, 30, () => { if (n.emote?.action === 'wave') waves.add(n.emote); });
    assert.equal(waves.size, 1);
  });

  // wander 模式下真人自己會走動，量不出「被推走」
  test('不會把站著的真人推走', { skip: IDLE_MOTION !== 'still' }, () => {
    const { stage, npcs } = setup({ count: 4 });
    const people = [];
    for (let i = 0; i < 8; i++) {
      const h = stage.addAgent({ name: `p${i}`, avatar: {} });
      people.push([h, h.x, h.y]);
    }
    run(stage, npcs, 120);
    for (const [h, x, y] of people) {
      assert.ok(Math.hypot(h.x - x, h.y - y) < 40, `${h.name} 被推走 ${Math.hypot(h.x - x, h.y - y).toFixed(0)}`);
    }
  });
});

