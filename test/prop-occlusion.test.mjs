/**
 * 角色被物件擋住（2026-10-29）。
 *
 * 場景是平面的：房間與物件畫在角色底下，角色一律疊在上面 —— 走到桌子後面的人
 * 看起來就是踩在桌上。前後看腳底：物件的 y（碰撞圓心）比腳底更前面才擋得到。
 *   - 大螢幕：PixelScene.occludersOf 挑出擋得到的物件，cutOut 把它們從角色層挖掉
 *   - 手機：ScenePainter 把物件跟角色依前後穿插著畫
 * 兩邊規則不同步的話，同一個人在大螢幕上被桌子擋住、在手機上卻踩在桌上，而且都不會報錯。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KitchenScene } from '../public/screen/scenes/KitchenScene.js';
import { ScenePainter } from '../public/controller/sceneBackdrop.js';
import { PROPS } from '../shared/scene.js';

const TABLE = PROPS.find((p) => p.id === 'tbl_1');

function scene() {
  const s = Object.create(KitchenScene.prototype);
  Object.assign(s, { props: PROPS, effects: new Map(), zoom: 0.5, ox: 30, oy: 20, dpr: 2, reduced: { matches: false } });
  return s;
}

/** 角色在畫面上的範圍，與 screen.js 的 drawBehindProps 同一個算法 */
function boxAt(s, x, y) {
  const pos = s.projectToScreen(x, y);
  const h = s.scaleAt(x, y, 2.1);
  return { x0: pos.x - h * 0.6, x1: pos.x + h * 0.6, y0: pos.y - h * 1.2, y1: pos.y + h * 0.15 };
}

test('大螢幕：站在桌子後面的人被桌子擋住，站在前面的不會', () => {
  const s = scene();
  const behind = TABLE.y - TABLE.r - 5;
  assert.ok(s.occludersOf(behind, boxAt(s, TABLE.x, behind)).includes(TABLE));
  const front = TABLE.y + TABLE.r + 5;
  assert.ok(!s.occludersOf(front, boxAt(s, TABLE.x, front)).includes(TABLE));
});

test('大螢幕：離得遠的物件不算，免得每個角色都繞一趟暫存畫布', () => {
  const s = scene();
  const y = TABLE.y - TABLE.r - 5, x = TABLE.x + 400;
  assert.ok(!s.occludersOf(y, boxAt(s, x, y)).includes(TABLE));
  // 遠遠在桌子後面（畫面上方），整個人都在桌子上緣之外
  const far = TABLE.y - 400;
  assert.ok(!s.occludersOf(far, boxAt(s, TABLE.x, far)).includes(TABLE));
});

test('大螢幕：挖的時候用場景的變換與 destination-out，畫的是同一支 paintProp', () => {
  const s = scene();
  const calls = [];
  const c = {
    save() {}, restore() {}, translate() {}, scale() {},
    setTransform: (...m) => calls.push(['setTransform', ...m]),
    set globalCompositeOperation(v) { calls.push(['op', v]); },
    set imageSmoothingEnabled(_v) {},
  };
  const painted = [];
  const Scene = class extends KitchenScene {};
  Scene.paintProp = (_c, p) => painted.push(p.id);
  Object.setPrototypeOf(s, Scene.prototype);
  s.cutOut(c, [TABLE], 0);
  assert.deepEqual(calls[0], ['setTransform', 2, 0, 0, 2, 0, 0], '密度要跟場景畫布一樣，挖的邊緣才對得齊');
  assert.deepEqual(calls[1], ['op', 'destination-out']);
  assert.deepEqual(painted, [TABLE.id]);
});

function painter() {
  const p = new ScenePainter('kitchen');
  const drawn = [];
  p.Scene = { paintProp: (_c, prop) => drawn.push(prop.id), ITEMS: {}, FALLBACK: ['table'] };
  p.spots = {};
  p.begin({ x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 }, 0, false);
  return { p, drawn };
}

test('手機：物件跟角色依前後穿插著畫，每個物件只畫一次', () => {
  const { p, drawn } = painter();
  p.drawUntil({}, TABLE.y - 1);
  assert.ok(!drawn.includes(TABLE.id), '桌子後面的人畫之前，桌子還不能畫');
  p.drawUntil({}, TABLE.y + 1);
  assert.ok(drawn.includes(TABLE.id));
  p.drawUntil({}, Infinity);
  assert.equal(drawn.length, PROPS.length);
  assert.equal(new Set(drawn).size, drawn.length);
  const ys = drawn.map((id) => PROPS.find((q) => q.id === id).y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
});

test('手機：會被擋住的人才延後畫名牌（站在冰箱後面的人，名字還是要看得到）', () => {
  const { p } = painter();
  const behind = TABLE.y - TABLE.r - 5;
  p.drawUntil({}, behind);
  assert.ok(p.covers(TABLE.x, behind), '桌子還沒畫，桌子後面的人名牌要延後');
  // 東側室外的空地：附近沒有任何物件
  assert.ok(!p.covers(2500, 900));
  p.drawUntil({}, Infinity);
  assert.ok(!p.covers(TABLE.x, behind), '物件都畫完了就不用再等');
});
