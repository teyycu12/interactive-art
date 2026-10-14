/**
 * 體素骨架測試（shared/voxelRig.js）
 *
 * 用一個合成的 90 格高小人：頭、脖子、軀幹、兩隻與身體分開的手臂、
 * 兩條腿。驗的是「拆得對」與「有厚度」—— 拆錯時渲染端不會報錯，只會出現
 * 一條腿分到全部體素、另一條只剩幾顆，走起路來單腳跳。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRig, sampleGrid, segment, GRID_ROWS, PARTS } from '../shared/voxelRig.js';

const SKIN = [240, 190, 150];
const HAIR = [90, 50, 20];
const SHIRT = [60, 110, 200];
const PANTS = [70, 70, 80];

/**
 * 一格像素對一格網格（高剛好 GRID_ROWS），省掉降採樣的誤差。
 * 欄位：頭 14~26、脖子 18~22、軀幹 10~30、手臂 4~8 與 32~36、腿 12~19 與 21~28。
 */
function makeFigure({ arms = true, handInward = false } = {}) {
  const W = 41;
  const H = GRID_ROWS;
  const data = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
    }
  };
  fill(14, 0, 27, 8, HAIR);
  fill(14, 8, 27, 24, SKIN);
  fill(18, 24, 23, 28, SKIN);        // 脖子
  fill(10, 28, 31, 56, SHIRT);       // 軀幹
  if (arms) {
    fill(6, 28, 10, 30, SHIRT);      // 肩膀接到手臂
    fill(31, 28, 35, 30, SHIRT);
    fill(4, 30, 8, 58, SHIRT);       // 手臂（與軀幹之間隔兩格）
    fill(33, 30, 37, 58, SHIRT);
    fill(4, 58, 8, 62, SKIN);        // 手
    fill(33, 58, 37, 62, SKIN);
    // 手掌往內伸，比手臂與身體的分界更靠中線 —— 實測讓胯下誤判的情境
    if (handInward) { fill(8, 58, 11, 62, SKIN); fill(30, 58, 33, 62, SKIN); }
  }
  fill(12, 56, 20, 90, PANTS);       // 左腿
  fill(21, 56, 29, 90, PANTS);       // 右腿
  return { width: W, height: H, data };
}

const count = (rig, name) => rig.parts[name].voxels.length / 6;

describe('體素骨架：拆部位', () => {
  test('脖子、胯下、兩隻手臂都找得到', () => {
    const g = sampleGrid(makeFigure());
    const seg = segment(g);
    assert.ok(seg.neck >= 22 && seg.neck <= 28, `脖子應在 22~28 列，實得 ${seg.neck}`);
    assert.ok(seg.crotch >= 55 && seg.crotch <= 58, `胯下應在 56 列附近，實得 ${seg.crotch}`);
    assert.notEqual(seg.armL, null);
    assert.notEqual(seg.armR, null);
  });

  test('兩條腿分到的體素差不多', () => {
    const rig = buildRig(makeFigure());
    const l = count(rig, 'legL');
    const r = count(rig, 'legR');
    assert.ok(l > 0 && r > 0);
    assert.ok(Math.min(l, r) / Math.max(l, r) > 0.8, `左右腿應接近，實得 ${l} / ${r}`);
  });

  test('手掌往內伸時，胯下不會被判到腰上', () => {
    const g = sampleGrid(makeFigure({ handInward: true }));
    const seg = segment(g);
    assert.ok(seg.crotch >= 55, `胯下應在 56 列附近，實得 ${seg.crotch}`);
    const rig = buildRig(makeFigure({ handInward: true }));
    const l = count(rig, 'legL');
    const r = count(rig, 'legR');
    assert.ok(Math.min(l, r) / Math.max(l, r) > 0.8, `左右腿應接近，實得 ${l} / ${r}`);
  });

  test('手臂貼著身體拆不開時，併在軀幹上而不是消失', () => {
    const rig = buildRig(makeFigure({ arms: false }));
    assert.equal(count(rig, 'armL'), 0);
    assert.equal(count(rig, 'armR'), 0);
    assert.ok(count(rig, 'torso') > 0);
  });

  test('六個部位都有關節', () => {
    const rig = buildRig(makeFigure());
    for (const name of PARTS) {
      assert.equal(rig.parts[name].pivot.length, 3, name);
      assert.ok(rig.parts[name].pivot.every(Number.isFinite), name);
    }
  });
});

describe('體素骨架：厚度與顏色', () => {
  /** 某部位在 z 方向的厚度（最大 z − 最小 z + 1） */
  const depth = (rig, name) => {
    const v = rig.parts[name].voxels;
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < v.length; i += 6) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    return hi - lo + 1;
  };

  test('有厚度：頭最厚、軀幹比寬度薄、腿是圓柱', () => {
    const rig = buildRig(makeFigure());
    const head = depth(rig, 'head');
    const torso = depth(rig, 'torso');
    const leg = depth(rig, 'legL');
    assert.ok(head >= 8, `頭應有厚度，實得 ${head}`);
    assert.ok(torso >= 8 && torso < 21, `軀幹應比寬度（21）薄，實得 ${torso}`);
    assert.ok(leg >= 4 && leg <= 9, `腿約與腿寬（8）相當，實得 ${leg}`);
  });

  test('腳底在 y = 0，頭頂在 y = rows − 1', () => {
    const rig = buildRig(makeFigure());
    let lo = Infinity, hi = -Infinity;
    for (const name of PARTS) {
      const v = rig.parts[name].voxels;
      for (let i = 1; i < v.length; i += 6) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    }
    assert.equal(lo, 0);
    assert.equal(hi, rig.rows - 1);
  });

  test('體素座標全是整數（渲染端以整數打包當鍵查鄰格）', () => {
    const rig = buildRig(makeFigure());
    for (const name of PARTS) {
      const v = rig.parts[name].voxels;
      for (let i = 0; i < v.length; i += 6) {
        assert.ok(Number.isInteger(v[i]) && Number.isInteger(v[i + 1]) && Number.isInteger(v[i + 2]));
      }
    }
  });

  test('臉朝前（+z）是膚色，後腦勺（−z）不是', () => {
    const rig = buildRig(makeFigure());
    const v = rig.parts.head.voxels;
    let front = null, back = null, maxZ = -Infinity, minZ = Infinity;
    // 取臉中央那一欄（x = 0 附近、y 在臉的高度）最前與最後的體素
    for (let i = 0; i < v.length; i += 6) {
      if (v[i] !== 0 || v[i + 1] !== GRID_ROWS - 1 - 16) continue;
      if (v[i + 2] > maxZ) { maxZ = v[i + 2]; front = v.slice(i + 3, i + 6); }
      if (v[i + 2] < minZ) { minZ = v[i + 2]; back = v.slice(i + 3, i + 6); }
    }
    assert.deepEqual(front, SKIN);
    assert.notDeepEqual(back, SKIN);
  });

  test('全透明的圖回傳 null', () => {
    const empty = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
    assert.equal(buildRig(empty), null);
  });
});
