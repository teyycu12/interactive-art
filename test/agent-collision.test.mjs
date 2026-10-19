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

test('走過去撞上站著的人：站著的人往側邊讓（不是被往前推著走），走的人放慢但沒被擋死', () => {
  // 借過（2026-10-19）：原本是走的人整個被擋下、前進速度歸零，
  // 一群人聚在一起時就怎麼推都過不去
  const walker = body(900, 600, 120, 0);
  const stander = body(940, 600);
  resolveAgentOverlap([walker, stander]);
  assert.equal(stander.x, 940, '站著的人沒有被往前推');
  assert.notEqual(stander.y, 600, '站著的人往側邊讓了一點');
  assert.ok(walker.vx > 0 && walker.vx < 120, `走的人放慢但還在前進：vx=${walker.vx}`);
});

test('一小群人聚在一起時，推著搖桿也擠得過去，而且不會深深疊進別人身體裡', () => {
  const stage = new Stage();
  const me = stage.addAgent({ name: '我', avatar: AVATAR });
  me.x = 700; me.y = 640;
  const pts = [[900, 600], [900, 660], [960, 630], [960, 570], [960, 690], [1020, 630]];
  const crowd = pts.map(([x, y]) => Object.assign(stage.addAgent({ name: '人', avatar: AVATAR }), { x, y }));
  let closest = Infinity;
  for (let i = 0; i < 120; i++) {   // 四秒，全速朝右
    stage.applyMove(me.id, { x: 1, y: 0, intensity: 1 });
    stage.tick(1 / 30);
    for (const o of crowd) closest = Math.min(closest, gap(me, o));
  }
  assert.ok(me.x > 1080, `被人群擋住了：x=${me.x.toFixed(0)}`);
  assert.ok(closest > AGENT_BODY_DISTANCE - 10, `擠的時候疊得太深：${closest.toFixed(1)}`);
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
  // 借過時站著的人一幀只讓一部分，會比身體距離近幾個單位（畫面上看不出來）；要擋的是穿過去
  assert.ok(closest >= AGENT_BODY_DISTANCE - 10, `最近距離 ${closest.toFixed(1)}`);
  assert.ok(Math.abs(me.y - other.y) >= AGENT_BODY_DISTANCE - 0.5, '是從旁邊繞過去，不是從中間穿過去');
  assert.equal(other.x, 900, '站著的人沒被推走');
});
