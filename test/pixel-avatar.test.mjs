/**
 * 像素角色（shared/pixelAvatar.js）
 *
 * 畫錯不會拋任何錯誤 —— 缺一格、方向判反、斜走時逐幀跳方向，
 * 都只會在大螢幕上默默看起來不對。這裡把它們釘成數字。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADS, FACES, BODIES, SKIN_TONES, ACCENT_COLORS, avatarGrid, renderAvatarSVG,
} from '../shared/avatars.js';
import {
  PIXEL_W, PIXEL_H, PIXEL_DIRS, PIXEL_FRAMES, OUTLINE, dirFromHeading,
} from '../shared/pixelAvatar.js';

const cfg = (over = {}) => ({
  head: HEADS[0].id, face: FACES[0].id, body: BODIES[0].id,
  accentColor: ACCENT_COLORS[0], skinTone: SKIN_TONES[0], ...over,
});
const filled = (g) => g.flat().filter(Boolean).length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

describe('像素格子', () => {
  test('每種模組 × 每個方向 × 每格步態都畫得出來，尺寸固定', () => {
    for (const h of HEADS) for (const f of FACES) for (const b of BODIES) {
      for (const d of PIXEL_DIRS) for (let fr = 0; fr < PIXEL_FRAMES; fr++) {
        const g = avatarGrid(cfg({ head: h.id, face: f.id, body: b.id }), d, fr);
        assert.equal(g.length, PIXEL_H);
        for (const row of g) assert.equal(row.length, PIXEL_W);
        assert.ok(filled(g) > 150, `${h.id}/${f.id}/${b.id} ${d}#${fr} 幾乎是空的`);
        for (const c of g.flat()) if (c) assert.match(c, /^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  test('right 是 left 的水平鏡像', () => {
    for (let fr = 0; fr < PIXEL_FRAMES; fr++) {
      const l = avatarGrid(cfg(), 'left', fr);
      const r = avatarGrid(cfg(), 'right', fr);
      assert.ok(same(r, l.map((row) => row.slice().reverse())));
    }
  });

  test('四個方向彼此不同（背面看不到臉、側面不是正面）', () => {
    const g = Object.fromEntries(PIXEL_DIRS.map((d) => [d, avatarGrid(cfg(), d, 0)]));
    for (const a of PIXEL_DIRS) for (const b of PIXEL_DIRS) {
      if (a !== b) assert.ok(!same(g[a], g[b]), `${a} 與 ${b} 畫得一樣`);
    }
  });

  test('走路的兩格跨步與站立不同', () => {
    for (const d of PIXEL_DIRS) {
      const [s, a, b] = [0, 1, 2].map((fr) => avatarGrid(cfg(), d, fr));
      assert.ok(!same(s, a) && !same(s, b) && !same(a, b), `${d} 的步態格有重複`);
    }
  });

  test('最上一列與最左右兩欄留白，外框不會被畫布切掉', () => {
    for (const h of HEADS) for (const d of PIXEL_DIRS) {
      const g = avatarGrid(cfg({ head: h.id, body: 'body_dress_03' }), d, 0);
      assert.ok(g[0].every((c) => !c || c === OUTLINE), `${h.id} ${d} 頂端被切到`);
      for (const row of g) {
        assert.ok(!row[0] || row[0] === OUTLINE);
        assert.ok(!row[PIXEL_W - 1] || row[PIXEL_W - 1] === OUTLINE);
      }
    }
  });
});

describe('dirFromHeading（heading = atan2(vy, vx)，y 向下）', () => {
  test('四個主方向', () => {
    assert.equal(dirFromHeading(0), 'right');
    assert.equal(dirFromHeading(Math.PI / 2), 'down');
    assert.equal(dirFromHeading(Math.PI), 'left');
    assert.equal(dirFromHeading(-Math.PI / 2), 'up');
  });

  test('沒有朝向時維持前一個方向，第一次預設面向觀眾', () => {
    assert.equal(dirFromHeading(undefined), 'down');
    assert.equal(dirFromHeading(NaN, 'left'), 'left');
  });

  test('斜走在 45° 附近不會來回跳（遲滯）', () => {
    const deg = (d) => (d * Math.PI) / 180;
    // 從右轉到略過 45°：仍維持 right
    assert.equal(dirFromHeading(deg(50), 'right'), 'right');
    // 同一個角度，若原本就是 down 也維持 down
    assert.equal(dirFromHeading(deg(50), 'down'), 'down');
    // 明顯越過遲滯區才換
    assert.equal(dirFromHeading(deg(60), 'right'), 'down');
  });

  test('跨越 ±π 的邊界也正確', () => {
    assert.equal(dirFromHeading(-Math.PI + 0.01), 'left');
    assert.equal(dirFromHeading(Math.PI - 0.01, 'left'), 'left');
  });
});

test('renderAvatarSVG 輸出像素 SVG，套用白名單顏色', () => {
  const svg = renderAvatarSVG(cfg({ skinTone: '#F4A261', accentColor: '#2A9D8F' }));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('#F4A261'));
  assert.ok(svg.includes('#2A9D8F'));
  assert.ok(!svg.includes('undefined'));
});
