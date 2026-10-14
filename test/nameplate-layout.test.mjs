/**
 * 名牌避讓測試。
 *
 * 30 人在場時名牌疊成一團是實測發現的（scripts/bots.mjs 放滿 30 人，牆邊的
 * 「阿良20」「阿良」疊得只剩半個字）。畫面上的問題測試看不到，所以這裡量的是
 * 名牌矩形本身有沒有重疊。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { layoutNameplates } from '../shared/nameplateLayout.js';

const plate = (id, x, y, w = 80, h = 24) => ({ id, x, y, w, h });

function rects(plates, offsets) {
  return plates.map((p) => ({
    left: p.x + offsets.get(p.id).dx - p.w / 2, right: p.x + offsets.get(p.id).dx + p.w / 2,
    top: p.y + offsets.get(p.id).dy, bottom: p.y + offsets.get(p.id).dy + p.h,
  }));
}

function overlappingPairs(rs) {
  let n = 0;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (Math.min(a.right, b.right) > Math.max(a.left, b.left)
          && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) n++;
    }
  }
  return n;
}

describe('名牌避讓', () => {
  test('沒有重疊時全部留在原位', () => {
    const plates = [plate('a', 100, 100), plate('b', 400, 100), plate('c', 100, 400)];
    const out = layoutNameplates(plates);
    for (const p of plates) assert.deepEqual(out.get(p.id), { dx: 0, dy: 0 });
  });

  test('兩人站在一起（配對）時名牌錯開，不再重疊', () => {
    const plates = [plate('a', 200, 300), plate('b', 230, 305)];
    const out = layoutNameplates(plates);
    assert.equal(overlappingPairs(rects(plates, out)), 0);
    // 只有一個人讓位
    assert.equal([...out.values()].filter((o) => o.dx !== 0 || o.dy !== 0).length, 1);
    // 兩個人時優先往下錯開，名牌仍在自己角色的正下方
    assert.equal(out.get('b').dx, 0);
  });

  test('誰讓位由 id 決定，與位置前後無關（否則並肩走時名牌會上下跳）', () => {
    const before = layoutNameplates([plate('a', 200, 300), plate('b', 230, 305)]);
    // b 走到 a 的上方一點點：Y 順序交換，但讓位的人不能換
    const after = layoutNameplates([plate('a', 200, 300), plate('b', 230, 295)]);
    assert.deepEqual(before.get('a'), { dx: 0, dy: 0 });
    assert.deepEqual(after.get('a'), { dx: 0, dy: 0 });
    assert.ok(before.get('b').dy > 0 && after.get('b').dy > 0);
  });

  test('輸入順序不影響結果', () => {
    const plates = [plate('c', 200, 300), plate('a', 210, 300), plate('b', 220, 300)];
    const x = layoutNameplates(plates);
    const y = layoutNameplates([...plates].reverse());
    for (const p of plates) assert.deepEqual(x.get(p.id), y.get(p.id));
  });

  test('不會錯開到畫面下緣之外', () => {
    const plates = [plate('a', 200, 1040), plate('b', 210, 1040)];
    const out = layoutNameplates(plates, { bottom: 1080 });
    for (const p of plates) assert.ok(p.y + out.get(p.id).dy + p.h <= 1080);
  });

  test('錯開格數有上限：再擠也不會把名牌推到離角色很遠的地方', () => {
    const plates = Array.from({ length: 12 }, (_, i) => plate(`p${String(i).padStart(2, '0')}`, 300, 300));
    const out = layoutNameplates(plates, { maxSteps: 4, gap: 2 });
    for (const { dy } of out.values()) assert.ok(dy <= 4 * (24 + 2));
  });

  // 重現實測：30 人分成兩群，各自擠在左右牆邊，Y 隨機散開
  function crowd(seed, spread) {
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: 30 }, (_, i) => plate(
      `u${String(i).padStart(2, '0')}`,
      (i < 15 ? 260 : 1660) + rand() * spread,
      220 + rand() * 700,
      60 + rand() * 40,
    ));
  }
  const zeroOffsets = (plates) => new Map(plates.map((p) => [p.id, { dx: 0, dy: 0 }]));

  test('30 人一般擁擠（各群散在 200px 寬）：名牌不再重疊', () => {
    let before = 0;
    let after = 0;
    for (let s = 1; s <= 20; s++) {
      const plates = crowd(s * 7919, 200);
      before += overlappingPairs(rects(plates, zeroOffsets(plates)));
      after += overlappingPairs(rects(plates, layoutNameplates(plates, { bottom: 1080 })));
    }
    assert.ok(before >= 100, `前提：未避讓時應有明顯重疊（20 場共 ${before} 組）`);
    assert.ok(after <= 1, `避讓後 20 場仍有 ${after} 組重疊`);
  });

  test('30 人極端擁擠（15 人貼著同一面牆）：重疊至少少掉八成', () => {
    let before = 0;
    let after = 0;
    for (let s = 1; s <= 20; s++) {
      const plates = crowd(s * 7919, 40);
      before += overlappingPairs(rects(plates, zeroOffsets(plates)));
      after += overlappingPairs(rects(plates, layoutNameplates(plates, { bottom: 1080 })));
    }
    assert.ok(after <= before * 0.2, `避讓前 ${before} 組，避讓後 ${after} 組`);
  });
});
