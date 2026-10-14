/**
 * 2D 走路格（shared/walkFrames.js）：從每一面分析手腳，以變形做出步伐。
 *
 * 用方塊拼出來的人形測：一格 = 4px，90 格高。守住的是幾個「不這樣做會出事、
 * 但不會報錯」的地方：
 *   - 兩腳併攏那一格要與原圖逐像素相同（否則站著不動也在抖）
 *   - 手與身體之間的白縫、往外斜的手，都要分得出手（實測兩手都不動過）
 *   - 長裙只有腳動，裙子不動（裙襬跟著晃，現場回報「很破碎」）
 *   - 側面兩腿疊在一起時複製一隻當遠側的腳，不從中間撕開
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildWalkRig, walkFrame, frameS, WALK_FRAMES } from '../shared/walkFrames.js';
import { walkFrameIndex } from '../shared/spriteCache.js';

const CELL = 4;
const COLS = 60;
const ROWS = 90;

const SKIN = [236, 190, 160];
const HAIR = [80, 50, 30];
const SHIRT = [70, 110, 190];
const PANTS = [60, 60, 70];
const SHOE = [40, 30, 25];
const WHITE = [255, 255, 255];
const PINK = [235, 160, 175];

function canvas() {
  return { width: COLS * CELL, height: ROWS * CELL, data: new Uint8ClampedArray(COLS * CELL * ROWS * CELL * 4) };
}

/** 以格為單位塗一塊（含兩端） */
function fill(img, c0, r0, c1, r1, rgb) {
  for (let y = r0 * CELL; y < (r1 + 1) * CELL; y++) {
    for (let x = c0 * CELL; x < (c1 + 1) * CELL; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
  }
}

function head(img, c0 = 20, c1 = 40) {
  fill(img, c0, 0, c1, 29, SKIN);
  fill(img, c0, 0, c1, 8, HAIR);
  fill(img, 27, 30, 33, 32, SKIN);   // 脖子：最窄的那幾列
}

/** 正面：手與身體之間有縫，兩腿分開 */
function frontFigure({ whiteGaps = false, slantedArms = false } = {}) {
  const img = canvas();
  head(img);
  fill(img, 22, 33, 38, 58, SHIRT);
  for (let r = 34; r <= 56; r++) {
    // 往外斜的手：越往下離身體越遠
    const out = slantedArms ? Math.floor((r - 34) / 6) : 0;
    const color = r >= 52 ? SKIN : SHIRT;
    fill(img, 16 - out, r, 19 - out, r, color);
    fill(img, 41 + out, r, 44 + out, r, color);
    if (whiteGaps && r >= 36) {
      // 模型常在手與衣服之間畫一兩格白，去背時被圍住而保留成不透明。
      // 一路到手掌：不然手掌那幾列本來就有縫，測不到白縫的處理
      fill(img, 20 - out, r, 21 - out, r, WHITE);
      fill(img, 39 + out, r, 40 + out, r, WHITE);
    }
  }
  if (whiteGaps) {
    // 縫的上下被手與衣服接住，白縫是圍起來的
    fill(img, 20, 34, 21, 35, SHIRT);
    fill(img, 39, 34, 40, 35, SHIRT);
    fill(img, 16, 57, 21, 57, SKIN);
    fill(img, 39, 57, 44, 57, SKIN);
  }
  fill(img, 23, 59, 28, 84, PANTS);
  fill(img, 32, 59, 37, 84, PANTS);
  fill(img, 23, 85, 28, 89, SHOE);
  fill(img, 32, 85, 37, 89, SHOE);
  return img;
}

/** 正面長洋裝：裙子蓋到小腿，只露出一截腳 */
function dressFigure() {
  const img = canvas();
  head(img);
  fill(img, 22, 33, 38, 58, PINK);
  fill(img, 18, 59, 42, 80, PINK);
  for (let r = 34; r <= 56; r++) {
    fill(img, 16, r, 19, r, r >= 52 ? SKIN : PINK);
    fill(img, 41, r, 44, r, r >= 52 ? SKIN : PINK);
  }
  fill(img, 24, 81, 28, 86, SKIN);
  fill(img, 32, 81, 36, 86, SKIN);
  fill(img, 23, 87, 28, 89, SHOE);
  fill(img, 32, 87, 37, 89, SHOE);
  return img;
}

/** 側面（朝右）：手貼在身體前面（膚色），兩腿疊成一條 */
function sideFigure({ skirt = false } = {}) {
  const img = canvas();
  fill(img, 22, 0, 38, 29, SKIN);
  fill(img, 22, 0, 30, 29, HAIR);
  fill(img, 27, 30, 32, 32, SKIN);
  fill(img, 24, 33, 36, 58, SHIRT);
  if (skirt) fill(img, 20, 54, 40, 74, PINK);
  fill(img, 27, 36, 31, 56, SKIN);          // 手臂（無袖）貼在身體前面
  fill(img, 26, skirt ? 75 : 59, 33, 85, SKIN);
  fill(img, 26, 86, 37, 89, SHOE);          // 腳尖朝右
  return img;
}

const names = (rig) => rig.regions.map((r) => r.name);

function opaqueXRange(img, y) {
  let lo = -1, hi = -1;
  for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3]) { if (lo < 0) lo = x; hi = x; }
  }
  return [lo, hi];
}

const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

describe('正面', () => {
  test('分得出兩腳兩手', () => {
    const rig = buildWalkRig(frontFigure(), 'front');
    assert.deepEqual(names(rig).sort(), ['armL', 'armR', 'legL', 'legR']);
  });

  test('兩腳併攏那一格與原圖逐像素相同', () => {
    const img = frontFigure();
    const rig = buildWalkRig(img, 'front');
    assert.deepEqual(walkFrame(img, rig, 0).data, img.data);
  });

  test('s = 1：左腳抬起（腳底那幾列空出來），右腳踩在地上', () => {
    const img = frontFigure();
    const fr = walkFrame(img, buildWalkRig(img, 'front'), 1);
    const y = ROWS * CELL - 1;
    assert.equal(alphaAt(fr, 25 * CELL, y), 0, '左腳底應該離地');
    assert.equal(alphaAt(fr, 34 * CELL, y), 255, '右腳踩著');
  });

  test('s = 1：右手往上縮、往內收，左手不動', () => {
    const img = frontFigure();
    const fr = walkFrame(img, buildWalkRig(img, 'front'), 1);
    const handBottom = 57 * CELL - 1;
    assert.equal(alphaAt(fr, 44 * CELL + 2, handBottom), 0, '右手的最下緣空出來');
    assert.equal(alphaAt(fr, 16 * CELL + 2, handBottom), 255, '左手還在原地');
  });

  test('手與衣服之間不透明的白縫，仍然分得出手', () => {
    const rig = buildWalkRig(frontFigure({ whiteGaps: true }), 'front');
    assert.ok(names(rig).includes('armL') && names(rig).includes('armR'), names(rig).join());
  });

  test('往外斜的手也分得出來（不假設手與身體的分界是一條直線）', () => {
    const img = frontFigure({ slantedArms: true });
    const rig = buildWalkRig(img, 'front');
    assert.ok(names(rig).includes('armL') && names(rig).includes('armR'), names(rig).join());
    // 手掌整個算在手上（斜出去最遠的那一截也是）：右手抬起時最下緣空出來
    const fr = walkFrame(img, rig, 1);
    const out = Math.floor((56 - 34) / 6);
    assert.equal(alphaAt(fr, (44 + out) * CELL + 2, 57 * CELL - 1), 0);
  });

  test('膚色從臉上取得（給側面找手用）', () => {
    const rig = buildWalkRig(frontFigure(), 'front');
    assert.ok(rig.skin, '應該找得到膚色');
    rig.skin.forEach((v, i) => assert.ok(Math.abs(v - SKIN[i]) < 8));
  });
});

describe('長裙', () => {
  test('只有裙襬下露出的腳會動，裙子不動', () => {
    const img = dressFigure();
    const rig = buildWalkRig(img, 'front');
    assert.ok(names(rig).includes('feetL') && names(rig).includes('feetR'), names(rig).join());
    const fr = walkFrame(img, rig, 1);
    // 裙子（第 60–80 格列）逐像素不變
    const from = (60 * CELL * img.width) * 4;
    const to = (81 * CELL * img.width) * 4;
    const skirtArea = (d) => d.slice(from, to).filter((_, i) => {
      const x = (i / 4 | 0) % img.width;
      return x >= 21 * CELL && x < 40 * CELL;   // 只看裙子中段，不看兩側的手
    });
    assert.deepEqual(skirtArea(fr.data), skirtArea(img.data));
  });
});

describe('側面', () => {
  const skin = buildWalkRig(frontFigure(), 'front').skin;

  test('兩腿疊在一起：複製一隻當遠側的腳，不從中間切開', () => {
    const rig = buildWalkRig(sideFigure(), 'side', { skin });
    const far = rig.regions.find((r) => r.name === 'legFar');
    assert.ok(far, names(rig).join());
    assert.equal(rig.regions[far.alias].name, 'legFront');
    assert.ok(far.shade < 1, '遠側的腳壓暗');
  });

  test('用膚色找到貼在身體前面的手', () => {
    const rig = buildWalkRig(sideFigure(), 'side', { skin });
    assert.ok(names(rig).includes('arm'), names(rig).join());
  });

  test('兩腳併攏那一格與原圖逐像素相同', () => {
    const img = sideFigure();
    assert.deepEqual(walkFrame(img, buildWalkRig(img, 'side', { skin }), 0).data, img.data);
  });

  test('s = 1：前腳往前、遠側的腳往後，腳底的寬度變大', () => {
    const img = sideFigure();
    const fr = walkFrame(img, buildWalkRig(img, 'side', { skin }), 1);
    const y = ROWS * CELL - 2;
    const [a0, a1] = opaqueXRange(img, y);
    const [b0, b1] = opaqueXRange(fr, y);
    assert.ok(b1 > a1, '前腳的腳尖往前');
    assert.ok(b0 < a0, '遠側的腳往後');
  });

  test('有裙子時裙子不動，腿從裙襬底下擺', () => {
    const img = sideFigure({ skirt: true });
    const rig = buildWalkRig(img, 'side', { skin });
    assert.ok(!names(rig).includes('skirt'));
    const fr = walkFrame(img, rig, 1);
    // 腿露出來的第一列不動：我們的格子與模型的格子對不準，裙襬最底下幾排
    // 像素常落在這一列，跟著腿走會把裙襬撕下一條
    for (let y = 75 * CELL; y < 76 * CELL; y++) {
      for (let x = 0; x < img.width; x++) {
        assert.equal(fr.data[(y * img.width + x) * 4 + 3], img.data[(y * img.width + x) * 4 + 3], `(${x}, ${y})`);
      }
    }
    for (let y = 60 * CELL; y < 75 * CELL; y++) {
      for (let x = 20 * CELL; x < 26 * CELL; x++) {
        // 裙子的後半（手臂不會擺到的地方）逐像素不變
        assert.equal(fr.data[(y * img.width + x) * 4 + 3], img.data[(y * img.width + x) * 4 + 3]);
      }
    }
  });

  /** 側面短褲：大腿露出來（膚色），上衣的袖子長或短 */
  function shortsFigure({ bareArm, cropTop = false }) {
    const img = canvas();
    // 短版上衣：大腿落在找手的高度裡，而且比手大 —— 不限制在腿的上方找，
    // 大腿就被當成手
    const hemRow = cropTop ? 50 : 60;
    fill(img, 22, 0, 38, 29, SKIN);
    fill(img, 22, 0, 30, 29, HAIR);
    fill(img, 27, 30, 32, 32, SKIN);
    fill(img, 23, 33, 37, hemRow, SHIRT);
    fill(img, 25, hemRow + 1, 34, hemRow + 4, PINK);   // 短褲：只比腿寬一點
    fill(img, 26, hemRow + 5, 33, 85, SKIN);           // 大腿到小腿，全是膚色
    fill(img, 26, 86, 37, 89, SHOE);
    if (bareArm) fill(img, 28, 36, 31, hemRow + 2, SKIN);   // 無袖：整隻手臂是膚色
    else fill(img, 28, hemRow - 3, 31, hemRow - 1, SKIN);   // 長袖：只露出手掌
    return img;
  }

  test('露出的大腿不會被當成手（實測大腿被拉走、原地補成衣服色）', () => {
    const rig = buildWalkRig(shortsFigure({ bareArm: true, cropTop: true }), 'side', { skin });
    const arm = rig.regions.find((r) => r.name === 'arm');
    const leg = rig.regions.find((r) => r.name === 'legFront');
    assert.ok(arm && leg, names(rig).join());
    assert.ok(arm.bottom < leg.pivot, `手 ${arm.pivot}-${arm.bottom} 跑到腿（${leg.pivot} 起）裡了`);
    assert.ok(arm.pivot < 45, `手從第 ${arm.pivot} 列起，找到的不是手臂`);
  });

  test('腿從短褲、上衣的下襬底下擺，不包進上衣', () => {
    const rig = buildWalkRig(shortsFigure({ bareArm: true }), 'side', { skin });
    const leg = rig.regions.find((r) => r.name === 'legFront');
    assert.ok(leg.pivot >= 60, `腿從第 ${leg.pivot} 列起，包進了上衣`);
  });

  test('長袖只露出手掌時手不擺（手臂的範圍猜不準，一擺就撕破袖子）', () => {
    const rig = buildWalkRig(shortsFigure({ bareArm: false }), 'side', { skin });
    assert.ok(!names(rig).includes('arm'), names(rig).join());
    assert.ok(names(rig).includes('legFront'));
  });

  test('沒有膚色（正面分析不出來）時手不動，腳照樣動', () => {
    const rig = buildWalkRig(sideFigure(), 'side', { skin: null });
    assert.ok(!names(rig).includes('arm'));
    assert.ok(names(rig).includes('legFront'));
  });
});

describe('相位', () => {
  test('一個循環 8 格，第 0 格是兩腳併攏', () => {
    assert.equal(WALK_FRAMES, 8);
    assert.equal(frameS(0), 0);
    assert.ok(Math.abs(frameS(4)) < 1e-9);
  });

  test('步伐相位對到格：併攏的兩格回傳 0（畫原圖）', () => {
    assert.equal(walkFrameIndex(0), 0);
    assert.equal(walkFrameIndex(Math.PI), 0);
    assert.equal(walkFrameIndex(Math.PI / 2), 2);
    assert.equal(walkFrameIndex(Math.PI * 1.5), 6);
    assert.equal(walkFrameIndex(Math.PI * 2 - 0.01), 0);
  });

  test('空白的圖回傳 null', () => {
    assert.equal(buildWalkRig(canvas(), 'front'), null);
  });
});
