/**
 * 採水果（籃子接力）測試
 *
 * 執行：node --test
 *
 * 這個玩法只有一條規則 ——「一個人一輪只能採一畦」—— 但整個設計都掛在它上面：
 * 少了它，一個人可以自己把三畦採完送回去，現場就是十個人看著一個人玩。
 * 因此下面大半的測試守的都是那一條，以及它必然帶來的兩個後果：
 * 交接距離、以及人不夠時會卡死。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HarvestRelay } from '../server/harvest.js';
import { HARVEST, HARVEST_PLAN } from '../shared/harvest.js';
import { PROPS } from '../shared/scene.js';
import { BOIDS } from '../server/config.js';

const PROP = new Map(PROPS.map((p) => [p.id, p]));
const BEDS = HARVEST_PLAN.beds;

/** 一個以 Map 當場上座標的假舞台 */
function stage(entries = {}) {
  const pos = new Map(Object.entries(entries));
  return {
    pos,
    at: (id) => pos.get(id) ?? null,
    ids: () => pos.keys(),
    /** 把某個人直接放到某個道具旁（剛好在判定圈內） */
    moveTo(id, propId) {
      const p = PROP.get(propId);
      pos.set(id, { x: p.x + p.r + HARVEST.reachRadius - 1, y: p.y });
    },
    moveXY(id, x, y) { pos.set(id, { x, y }); },
  };
}

function started(people = ['a', 'b', 'c']) {
  const h = new HarvestRelay();
  const st = stage(Object.fromEntries(people.map((id) => [id, { x: 1300, y: 540 }])));
  const res = h.start(people, HARVEST_PLAN);
  assert.equal(res.ok, true, res.reason);
  return { h, st };
}

/** 把某個人帶到籃子旁並接過來 */
function handTo(h, st, id) {
  const b = h.basketAt();
  st.moveXY(id, b.x, b.y);
  const r = h.take(id, st.at);
  assert.equal(r.ok, true, r.reason);
  h.tick(st.at, st.ids());
}

describe('採水果：設定', () => {
  test('題庫指到的道具都真的存在', () => {
    // 打錯一個 id 的症狀是「那一處永遠採不到」，而畫面上不會有任何異常
    for (const id of [...BEDS, HARVEST_PLAN.home]) {
      assert.ok(PROP.has(id), `${id} 不在 PROPS 裡`);
    }
  });

  test('交接距離必須大於角色之間的分離半徑', () => {
    // 分離力讓兩個自主漫遊的角色擠不進 BOIDS.separationRadius 以內。
    // 交接距離若小於它，「接過籃子」在沒有人操控的那一側永遠按不下去，
    // 而現場看到的是兩個人明明站在一起卻交不了東西。
    assert.ok(HARVEST.handRadius > BOIDS.separationRadius,
      `交接距離 ${HARVEST.handRadius} 不大於分離半徑 ${BOIDS.separationRadius}`);
  });

  test('兩處採收點的判定圈不可以重疊', () => {
    // 重疊的話，拿著籃子走過中間會莫名其妙採到隔壁那一處
    for (let i = 0; i < BEDS.length; i++) {
      for (let j = i + 1; j < BEDS.length; j++) {
        const a = PROP.get(BEDS[i]), b = PROP.get(BEDS[j]);
        const gap = Math.hypot(a.x - b.x, a.y - b.y)
          - (a.r + HARVEST.reachRadius) - (b.r + HARVEST.reachRadius);
        assert.ok(gap > 0, `${a.id} 與 ${b.id} 的判定圈重疊了 ${(-gap).toFixed(0)}`);
      }
    }
  });
});

describe('採水果：規則', () => {
  test('人數少於採收點時開不起來，而不是開了才卡住', () => {
    const h = new HarvestRelay();
    const res = h.start(['a', 'b'], HARVEST_PLAN);
    assert.equal(res.ok, false);
    assert.match(res.reason, /至少需要/);
  });

  test('籃子一開始放在送回去的地方', () => {
    const { h } = started();
    const home = PROP.get(HARVEST_PLAN.home);
    assert.deepEqual(h.basketAt(), { x: home.x, y: home.y });
  });

  test('人要走到籃子旁邊才接得到', () => {
    const { h, st } = started();
    st.moveXY('a', 50, 50);
    assert.deepEqual(h.take('a', st.at), { ok: false, reason: 'TOO_FAR' });
    handTo(h, st, 'a');
    assert.equal(h.publicView().holder, 'a');
  });

  test('拿著籃子走到採收點就採到了，不必再按一次', () => {
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveTo('a', BEDS[0]);
    const r = h.tick(st.at, st.ids());
    assert.deepEqual(r.picked.map((b) => b.propId), [BEDS[0]]);
    assert.equal(h.remaining().length, BEDS.length - 1);
  });

  test('一個人只能採一處 —— 採過的人站到下一處也不會採', () => {
    // 這是整個玩法唯一的規則。壞掉的話一個人就能把全部採完送回去，
    // 現場會變成十個人看著一個人玩。
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveTo('a', BEDS[0]);
    h.tick(st.at, st.ids());
    st.moveTo('a', BEDS[1]);
    const r = h.tick(st.at, st.ids());
    assert.deepEqual(r.picked, []);
    assert.equal(h.remaining().length, BEDS.length - 1);
  });

  test('交給還沒採過的人之後，換他採得到', () => {
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveTo('a', BEDS[0]);
    h.tick(st.at, st.ids());
    handTo(h, st, 'b');          // b 走到 a 旁邊接過來
    st.moveTo('b', BEDS[1]);
    const r = h.tick(st.at, st.ids());
    assert.deepEqual(r.picked.map((x) => x.propId), [BEDS[1]]);
  });

  test('還沒採完就送回去不算完成', () => {
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveTo('a', BEDS[0]);
    h.tick(st.at, st.ids());
    st.moveTo('a', HARVEST_PLAN.home);
    assert.equal(h.tick(st.at, st.ids()).delivered, false);
  });

  test('全部採完再送回去才算完成，而且是接力完成的', () => {
    const { h, st } = started();
    const people = ['a', 'b', 'c'];
    people.forEach((id, i) => {
      handTo(h, st, id);
      st.moveTo(id, BEDS[i]);
      h.tick(st.at, st.ids());
    });
    assert.equal(h.remaining().length, 0);
    st.moveTo('c', HARVEST_PLAN.home);
    assert.equal(h.tick(st.at, st.ids()).delivered, true);
    assert.deepEqual(h.publicView().picked.sort(), people);
  });
});

describe('採水果：不會卡死', () => {
  test('拿著籃子的人離場時，籃子留在他最後站的地方', () => {
    // 籃子跟著人一起消失的話，這一輪永遠結束不了，而畫面上看不出原因
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveXY('a', 700, 400);
    h.tick(st.at, st.ids());
    st.pos.delete('a');
    const r = h.tick(st.at, st.ids());
    assert.equal(r.dropped, true);
    assert.equal(h.publicView().holder, null);
    assert.deepEqual(h.basketAt(), { x: 700, y: 400 });
    // 別人可以走過去撿起來
    handTo(h, st, 'b');
    assert.equal(h.publicView().holder, 'b');
  });

  test('還沒採過的人不夠時自動中止，不留一個解不開的局', () => {
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveTo('a', BEDS[0]);
    h.tick(st.at, st.ids());
    assert.deepEqual(h.viability(st.ids()), { ok: true });
    st.pos.delete('b');   // 剩下 a（採過）與 c，但還有兩處沒採
    assert.deepEqual(h.viability(st.ids()), { ok: false, reason: 'NO_FRESH_HANDS' });
  });

  test('全部採完之後人再少也不中止 —— 只剩送回去', () => {
    const { h, st } = started();
    ['a', 'b', 'c'].forEach((id, i) => {
      handTo(h, st, id);
      st.moveTo(id, BEDS[i]);
      h.tick(st.at, st.ids());
    });
    st.pos.delete('a'); st.pos.delete('b');
    assert.deepEqual(h.viability(st.ids()), { ok: true });
  });

  test('場上沒有人時中止', () => {
    const { h, st } = started();
    for (const id of [...st.pos.keys()]) st.pos.delete(id);
    assert.deepEqual(h.viability(st.ids()), { ok: false, reason: 'NO_PLAYERS' });
  });
});

describe('採水果：推播節流', () => {
  test('「接得到籃子」只在狀態真的變了的時候回報', () => {
    // 每拍廣播是每秒三百則重複訊息，而現場的症狀只會是「網路很慢」
    const { h, st } = started();
    handTo(h, st, 'a');
    st.moveXY('b', h.basketAt().x, h.basketAt().y);
    assert.deepEqual(h.tick(st.at, st.ids()).reachChanged, ['b']);
    assert.equal(h.canTake('b'), true);
    assert.deepEqual(h.tick(st.at, st.ids()).reachChanged, []);
    st.moveXY('b', 50, 50);
    assert.deepEqual(h.tick(st.at, st.ids()).reachChanged, ['b']);
    assert.equal(h.canTake('b'), false);
  });

  test('拿著籃子的人自己不算在「接得到」裡面', () => {
    const { h, st } = started();
    handTo(h, st, 'a');
    h.tick(st.at, st.ids());
    assert.equal(h.canTake('a'), false);
  });
});
