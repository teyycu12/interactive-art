/**
 * 角色之間不能互相穿越（server/boids.js 的 resolveAgentOverlap）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentOverlap } from '../server/boids.js';
import { AGENT_BODY_DISTANCE } from '../server/config.js';
import { Stage } from '../server/state.js';

const body = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy, boidsVx: 0, boidsVy: 0, targetX: null });
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const AVATAR = { head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01', accentColor: '#E76F51', skinTone: '#F4A261' };

test('重疊的兩人被推開到剛好一個身體距離', () => {
  const a = body(900, 600);
  const b = body(910, 600);
  resolveAgentOverlap([a, b]);
  assert.ok(Math.abs(gap(a, b) - AGENT_BODY_DISTANCE) < 1e-6, `gap=${gap(a, b)}`);
});

test('走過去的人被擋下，站著的人不被推著走；朝對方的速度被消去', () => {
  const walker = body(900, 600, 120, 0);
  const stander = body(940, 600);
  resolveAgentOverlap([walker, stander]);
  assert.equal(stander.x, 940, '站著的人原地不動');
  assert.ok(Math.abs(gap(walker, stander) - AGENT_BODY_DISTANCE) < 1e-6);
  assert.equal(walker.vx, 0, '正面撞上：前進的速度被消掉');
});

test('疊在同一點也分得開，合照定位中的角色不參與', () => {
  const a = body(900, 600);
  const b = body(900, 600);
  resolveAgentOverlap([a, b]);
  assert.ok(gap(a, b) >= AGENT_BODY_DISTANCE - 1e-6);
  const s1 = { ...body(900, 600), targetX: 900 };
  const s2 = { ...body(905, 600), targetX: 905 };
  resolveAgentOverlap([s1, s2]);
  assert.equal(gap(s1, s2), 5, '排隊形時本來就要站很近');
});

test('實際推著搖桿走向別人：被擋住後沿著對方身邊繞過去，整段路都不重疊', () => {
  const stage = new Stage();
  const me = stage.addAgent({ name: '我', avatar: AVATAR });
  const other = stage.addAgent({ name: '他', avatar: AVATAR });
  me.x = 700; me.y = 640;
  other.x = 900; other.y = 640;
  let closest = Infinity;
  for (let i = 0; i < 90; i++) {   // 三秒，全速朝右
    stage.applyMove(me.id, { x: 1, y: 0, intensity: 1 });
    stage.tick(1 / 30);
    closest = Math.min(closest, gap(me, other));
  }
  assert.ok(closest >= AGENT_BODY_DISTANCE - 0.5, `最近距離 ${closest.toFixed(1)}`);
  assert.ok(Math.abs(me.y - other.y) >= AGENT_BODY_DISTANCE - 0.5, '是從旁邊繞過去，不是從中間穿過去');
  assert.equal(other.x, 900, '站著的人沒被推走');
});
