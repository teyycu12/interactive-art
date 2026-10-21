import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HoopCourt, HOOP_ERRORS } from '../server/hoops.js';
import { HOOPS, hoopsFor, idealPower, shotChance, inRect } from '../shared/hoops.js';
import { THEMES } from '../shared/themes.js';
import { propsForTheme } from '../shared/scene.js';

const cfg = hoopsFor('gym');
const atCart = { x: cfg.cart.x, y: cfg.cart.y + cfg.cart.r + 10 };
const inZone = { x: cfg.hoop.x, y: cfg.hoop.y + cfg.hoop.r + 40 };
const far = { x: 2000, y: 800 };
/** 這個位置投得進的完美手勢 */
const perfect = (pos) => ({ angle: 0, power: idealPower(Math.hypot(pos.x - cfg.hoop.x, pos.y - cfg.hoop.y)) });
const court = (rng = () => 0) => new HoopCourt(cfg, rng);

test('只有體育館開投籃，球車、籃框、可投範圍都在場上', () => {
  assert.ok(cfg);
  for (const t of THEMES) if (t.id !== 'gym') assert.equal(hoopsFor(t.id), null, t.id);
  assert.ok(inRect(cfg.zone, inZone.x, inZone.y), '籃框前面要在可投的範圍裡');
});

test('體育館拿掉盆栽：不畫也不擋人；其他場景照舊', () => {
  assert.ok(!propsForTheme('gym').some((p) => p.type === 'plant'));
  assert.ok(propsForTheme('kitchen').some((p) => p.type === 'plant'));
});

test('走到球車自動拿球；要離開再回來才拿得到下一顆', () => {
  const c = court();
  assert.ok(c.step([{ id: 'a', ...atCart }]).changed.has('a'));
  assert.equal(c.viewFor('a').hasBall, true);
  c.shoot('a', inZone, perfect(inZone), 0);
  // 投完還站在球車旁：不會馬上又有球
  c.step([{ id: 'a', ...atCart }]);
  assert.equal(c.viewFor('a').hasBall, false);
  c.step([{ id: 'a', ...far }]);
  c.step([{ id: 'a', ...atCart }]);
  assert.equal(c.viewFor('a').hasBall, true);
});

test('傳球：要有球、對方沒球、距離夠近', () => {
  const c = court();
  c.step([{ id: 'a', ...atCart }]);
  const pos = { a: atCart, b: { x: atCart.x + 200, y: atCart.y }, z: far, c: atCart };
  const posOf = (id) => pos[id] ?? null;
  assert.equal(c.pass('b', 'a', posOf).reason, HOOP_ERRORS.NO_BALL);
  assert.equal(c.pass('a', 'a', posOf).reason, HOOP_ERRORS.SELF);
  assert.equal(c.pass('a', 'z', posOf).reason, HOOP_ERRORS.TOO_FAR);
  assert.equal(c.pass('a', 'nobody', posOf).reason, HOOP_ERRORS.NOT_FOUND);
  assert.ok(c.pass('a', 'b', posOf, 1000).ok);
  assert.equal(c.viewFor('a').hasBall, false);
  const vb = c.viewFor('b', 1000);
  assert.equal(vb.hasBall, true);
  assert.equal(vb.from, 'a');
  assert.equal(vb.assistMs, HOOPS.assistMs);
});

test('接到傳球後時限內投進算助攻，兩人都得分；單人進球分數較少', () => {
  const c = court();
  c.step([{ id: 'a', ...atCart }]);
  c.pass('a', 'b', () => inZone, 1000);
  const r = c.shoot('b', inZone, perfect(inZone), 2000);
  assert.ok(r.ok && r.made);
  assert.equal(r.assist, 'a');
  assert.equal(c.viewFor('b').points, HOOPS.points.assisted);
  assert.equal(c.viewFor('a').points, HOOPS.points.assist);
  assert.equal(c.viewFor('a').assists, 1);

  const solo = court();
  solo.step([{ id: 's', ...atCart }]);
  const rs = solo.shoot('s', inZone, perfect(inZone), 0);
  assert.equal(rs.assist, null);
  assert.equal(solo.viewFor('s').points, HOOPS.points.solo);
  assert.ok(HOOPS.points.assisted > HOOPS.points.solo);
});

test('拖太久才投不算助攻', () => {
  const c = court();
  c.step([{ id: 'a', ...atCart }]);
  c.pass('a', 'b', () => inZone, 0);
  const r = c.shoot('b', inZone, perfect(inZone), HOOPS.assistMs + 1);
  assert.ok(r.made);
  assert.equal(r.assist, null);
});

test('投籃：要拿著球、要在籃框區、手勢要合理；投完球就沒了', () => {
  const c = court();
  assert.equal(c.shoot('a', inZone, perfect(inZone)).reason, HOOP_ERRORS.NO_BALL);
  c.step([{ id: 'a', ...atCart }]);
  assert.equal(c.shoot('a', far, perfect(far)).reason, HOOP_ERRORS.OUT_OF_ZONE);
  assert.equal(c.shoot('a', inZone, { angle: 0, power: 5 }).reason, HOOP_ERRORS.BAD_SHOT);
  assert.equal(c.shoot('a', inZone, { angle: 'x', power: 0.5 }).reason, HOOP_ERRORS.BAD_SHOT);
  assert.equal(c.viewFor('a').hasBall, true, '手勢不合理不算投過');
  assert.ok(c.shoot('a', inZone, perfect(inZone)).ok);
  assert.equal(c.viewFor('a').hasBall, false);
});

test('進球機率：準就高、差一點有機會、偏太多不會進；愈遠要愈大力', () => {
  assert.equal(shotChance(100, 0, idealPower(100)), HOOPS.cleanChance);
  assert.equal(shotChance(100, HOOPS.angleTol * 1.5, idealPower(100)), HOOPS.roughChance);
  assert.equal(shotChance(100, 40, idealPower(100)), 0);
  assert.equal(shotChance(100, 0, idealPower(100) + 0.5), 0);
  assert.ok(idealPower(400) > idealPower(50));
  // 伺服器判定進不進，不是手機說了算：準度相同時，亂數決定
  const c = court(() => 0.99);
  c.step([{ id: 'a', ...atCart }]);
  assert.equal(c.shoot('a', inZone, perfect(inZone)).made, false);
});

test('離場的人手上的球收回；大螢幕排行依分數', () => {
  const c = court();
  c.step([{ id: 'a', ...atCart }, { id: 'b', ...far }]);
  assert.deepEqual(c.publicView().holders, ['a']);
  c.step([{ id: 'b', ...far }]);
  assert.deepEqual(c.publicView().holders, []);

  const d = court();
  d.step([{ id: 'x', ...atCart }]);
  d.pass('x', 'y', () => inZone, 0);
  d.shoot('y', inZone, perfect(inZone), 10);
  const top = d.publicView().top;
  assert.equal(top.length, 2);
  assert.equal(d.publicView().totals.assists, 1);
});
