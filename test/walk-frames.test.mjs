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

  test('給了手臂範圍就照給的擺（斜背包、寬袖擋住縫時從圖上找不到手）', () => {
    const img = canvas();
    head(img);
    fill(img, 16, 33, 44, 58, SHIRT);    // 手與身體之間沒有縫
    fill(img, 16, 52, 19, 56, SKIN);
    fill(img, 41, 52, 44, 56, SKIN);
    fill(img, 24, 59, 29, 85, PANTS);
    fill(img, 31, 59, 36, 85, PANTS);
    fill(img, 23, 86, 29, 89, SHOE);
    fill(img, 31, 86, 37, 89, SHOE);
    // 座標是格子的：從人的外框左緣（第 16 欄）算起
    const rows = (c0, c1) => Array.from({ length: 24 }, (_, i) => [33 + i, c0 - 16, c1 - 16]);
    const rig = buildWalkRig(img, 'front', { arms: [{ name: 'armL', cells: rows(16, 19) }, { name: 'armR', cells: rows(41, 44) }] });
    for (const name of ['armL', 'armR']) {
      const arm = rig.regions.find((r) => r.name === name);
      assert.ok(arm, names(rig).join());
      assert.deepEqual([arm.pivot, arm.bottom], [33, 56], `${name} 沒照給的範圍`);
    }
    assert.equal(rig.handRow, 56, '手掌高度照給的範圍算（側面要用）');
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

  for (const [name, rgb] of [['白色', WHITE], ['粉紅', PINK]]) {
    test(`臉的取樣範圍裡${name}比膚色多，膚色仍是膚色（實測量成${name}，裙子被當成手）`, () => {
      const img = frontFigure();
      // 臉的下半大半被蓋住（白衣領、粉紅的長髮或口罩），只剩上面幾列是膚色
      fill(img, 20, 22, 40, 29, rgb);
      const rig = buildWalkRig(img, 'front');
      assert.ok(rig.skin, '應該找得到膚色');
      rig.skin.forEach((v, i) => assert.ok(Math.abs(v - SKIN[i]) < 8, `量成 ${rig.skin.map(Math.round)}`));
    });
  }
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

  test('長袖只露出手掌、袖子又沒有描邊：套姿勢參考圖的手臂模板，只小幅擺（每個角色都要會擺手）', () => {
    const rig = buildWalkRig(shortsFigure({ bareArm: false }), 'side', { skin });
    const arm = rig.regions.find((r) => r.name === 'arm');
    assert.ok(arm, names(rig).join());
    assert.ok(arm.swing <= 2, `擺 ${arm.swing} 格：手臂底下的身體不存在，只能小幅擺`);
    assert.ok(names(rig).includes('legFront'));
  });

  test('給了手臂範圍（換裝角色的 arms.json）就照給的擺，不從圖上找', () => {
    const img = sideFigure();
    // 座標是格子的：從人的外框左緣（第 22 欄）算起
    const cells = [];
    for (let r = 36; r <= 56; r++) cells.push([r, 27 - 22, 31 - 22]);
    const rig = buildWalkRig(img, 'side', { skin: SKIN, arms: [{ name: 'arm', cells, small: true }] });
    const arm = rig.regions.find((r) => r.name === 'arm');
    assert.ok(arm, names(rig).join());
    assert.equal(arm.pivot, 36);
    assert.equal(arm.bottom, 56);
    assert.ok(arm.swing <= 2, '整條袖子只小幅擺');
    // 給的範圍裡沒有這一面的手：就是不擺，不退回去猜
    const none = buildWalkRig(img, 'side', { skin: SKIN, arms: [] });
    assert.ok(!names(none).includes('arm'), names(none).join());
  });

  test('長袖有描邊時沿著描邊找出整條袖子，從肩膀小幅擺（每個角色都要會擺手）', () => {
    const TEE = [200, 204, 210];
    const LINE = [90, 92, 98];
    const img = canvas();
    fill(img, 22, 0, 38, 29, SKIN);
    fill(img, 22, 0, 30, 29, HAIR);
    fill(img, 27, 30, 32, 32, SKIN);
    fill(img, 23, 33, 37, 58, TEE);
    fill(img, 24, 59, 35, 85, PANTS);
    fill(img, 24, 86, 38, 89, SHOE);
    fill(img, 27, 36, 27, 55, LINE);    // 袖子兩側的描邊
    fill(img, 32, 36, 32, 55, LINE);
    fill(img, 28, 56, 31, 59, SKIN);    // 只露出手掌
    const rig = buildWalkRig(img, 'side', { skin: SKIN });
    const arm = rig.regions.find((r) => r.name === 'arm');
    assert.ok(arm, names(rig).join());
    assert.ok(arm.pivot <= 40, `袖子從第 ${arm.pivot} 列才開始，沒有接到肩膀`);
    assert.ok(arm.swing <= 2, `長袖擺 ${arm.swing} 格，原地補色會太大塊`);
    const fr = walkFrame(img, rig, 1);
    // 手掌往後移開（原本最前緣那一格不再是膚色）；袖子靠前的描邊也跟著走，不留在原地
    const at = (y, x, rgb) => rgb.every((v, k) => fr.data[(y * img.width + x) * 4 + k] === v);
    assert.ok(!at(58 * CELL, 31 * CELL, SKIN), '手掌沒動');
    assert.ok(!at(54 * CELL, 32 * CELL, LINE), '袖子的描邊留在原地');
    assert.ok(at(54 * CELL, 30 * CELL, LINE), '袖子的描邊沒有跟著手走');
  });

  test('窄裙：裙子只比腿寬一點，腿仍從裙襬底下擺（實測整件裙子被當成腿剪開）', () => {
    const img = canvas();
    fill(img, 22, 0, 38, 29, SKIN);
    fill(img, 22, 0, 30, 29, HAIR);
    fill(img, 27, 30, 32, 32, SKIN);
    fill(img, 23, 33, 37, 55, SHIRT);
    fill(img, 25, 56, 34, 70, PINK);    // 窄裙：10 格寬，腿 8 格 —— 寬度分不出來
    fill(img, 26, 71, 33, 85, SKIN);
    fill(img, 26, 86, 37, 89, SHOE);
    const rig = buildWalkRig(img, 'side', { skin });
    const leg = rig.regions.find((r) => r.name === 'legFront');
    assert.ok(leg, names(rig).join());
    assert.ok(leg.pivot >= 71, `腿從第 ${leg.pivot} 列起，包進了裙子`);
    const fr = walkFrame(img, rig, 1);
    for (let y = 56 * CELL; y < 71 * CELL; y++) {
      for (let x = 25 * CELL; x < 35 * CELL; x++) {
        const i = (y * img.width + x) * 4;
        assert.deepEqual([...fr.data.slice(i, i + 4)], [...img.data.slice(i, i + 4)], `裙子 (${x}, ${y}) 動了`);
      }
    }
  });

  test('長褲：垂在骨盆旁的手掌跟著手臂擺，擺開後原地補上褲子的顏色', () => {
    const img = canvas();
    fill(img, 22, 0, 38, 29, SKIN);
    fill(img, 22, 0, 30, 29, HAIR);
    fill(img, 27, 30, 32, 32, SKIN);
    fill(img, 23, 33, 37, 58, SHIRT);
    fill(img, 24, 59, 35, 85, PANTS);   // 寬褲：與小腿同色，腿的上緣一路到腰
    fill(img, 24, 86, 38, 89, SHOE);
    fill(img, 28, 40, 31, 63, SKIN);    // 短袖：手臂到手掌，手掌落在褲子上
    const rig = buildWalkRig(img, 'side', { skin });
    const arm = rig.regions.find((r) => r.name === 'arm');
    assert.ok(arm, names(rig).join());
    assert.ok(arm.bottom >= 63, `手只到第 ${arm.bottom} 列，手掌被切掉`);
    const fr = walkFrame(img, rig, 1);
    for (let y = 59 * CELL; y < 64 * CELL; y++) {
      for (let x = 24 * CELL; x < 36 * CELL; x++) {
        assert.ok(alphaAt(fr, x, y) > 0, `褲子上 (${x}, ${y}) 破了一個洞`);
      }
    }
    // 手掌兩側的深色是褲子不是描邊，不跟著手走：褲子的輪廓外不該出現褲子的顏色
    for (let y = 59 * CELL; y < 64 * CELL; y++) {
      for (let x = 0; x < 24 * CELL; x++) {
        const i = (y * img.width + x) * 4;
        const isPants = fr.data[i + 3] && fr.data[i] === PANTS[0] && fr.data[i + 2] === PANTS[2];
        assert.ok(!isPants, `褲子被手帶到 (${x}, ${y})`);
      }
    }
  });

  test('手臂背光的陰影與後緣描邊跟著手走；短袖的袖口不被撕開（2026-10-20 回報「手臂一部分黏在軀幹上」）', () => {
    const OUTLINE = [110, 60, 45];
    const SHADE = SKIN.map((v) => Math.round(v * 0.75));   // 同一種膚色、暗一階
    const HEM = [40, 60, 110];
    const TEE = [200, 204, 210];   // 淺色 T 恤（回報的是灰 T）：深色衣服本來就不收描邊，見上一個測試
    const img = canvas();
    fill(img, 22, 0, 38, 29, SKIN);
    fill(img, 22, 0, 30, 29, HAIR);
    fill(img, 27, 30, 32, 32, SKIN);
    fill(img, 23, 33, 37, 58, TEE);
    fill(img, 24, 59, 35, 85, PANTS);
    fill(img, 24, 86, 38, 89, SHOE);
    fill(img, 25, 42, 33, 42, HEM);       // 袖口：比手臂寬
    fill(img, 26, 43, 26, 60, OUTLINE);   // 手臂後緣的描邊
    fill(img, 27, 43, 28, 60, SHADE);     // 背光的陰影，兩格
    fill(img, 29, 43, 31, 60, SKIN);
    fill(img, 32, 43, 32, 60, OUTLINE);
    const rig = buildWalkRig(img, 'side', { skin: SKIN });
    const arm = rig.regions.find((r) => r.name === 'arm');
    assert.ok(arm, names(rig).join());
    const same = (fr, x, y, rgb) => {
      const i = (y * img.width + x) * 4;
      return fr.data[i + 3] && rgb.every((v, k) => Math.abs(fr.data[i + k] - v) <= 2);
    };
    for (const s of [1, -1]) {
      const fr = walkFrame(img, rig, s);
      // 手擺最開、還在上衣前面的那幾列：原本陰影與描邊的位置不該還是陰影、描邊
      // （59 列起手掌在深色褲子前面，深色照規則不收，見「長褲」那個測試）
      for (let y = 55 * CELL; y < 59 * CELL; y++) {
        for (let x = 26 * CELL; x < 29 * CELL; x++) {
          assert.ok(!same(fr, x, y, SHADE) && !same(fr, x, y, OUTLINE), `s=${s}：(${x}, ${y}) 還黏著手臂的陰影或描邊`);
        }
      }
      // 袖口那一列整條不動
      for (let x = 25 * CELL; x < 34 * CELL; x++) {
        assert.ok(same(fr, x, 42 * CELL + 1, HEM), `s=${s}：袖口 (${x}) 被撕開`);
      }
    }
  });

  test('大頭（約 2.2 頭身）：腿從比較低的髖部擺，垂得比較低的手掌也算在手上', () => {
    // 2026-10-15 參考圖集換成約 2.2 頭身。比例寫死成 3 頭身時，腿從腰上面擺、
    // 手掌（垂到 78%）被切在 74% 之外，原地留下一團殘影
    const img = canvas();
    fill(img, 21, 0, 39, 40, SKIN);       // 頭到 45%
    fill(img, 21, 0, 39, 12, HAIR);
    fill(img, 27, 41, 32, 43, SKIN);      // 脖子
    fill(img, 23, 44, 37, 55, SHIRT);
    fill(img, 24, 56, 35, 85, PANTS);     // 褲頭在 62%，髖部約 70%
    fill(img, 24, 86, 38, 89, SHOE);
    fill(img, 28, 46, 31, 70, SKIN);      // 手臂到手掌，手掌垂到 78%
    const rig = buildWalkRig(img, 'side', { skin, body: { handRow: 69 } });
    const arm = rig.regions.find((r) => r.name === 'arm');
    const leg = rig.regions.find((r) => r.name === 'legFront');
    assert.ok(arm && leg, names(rig).join());
    assert.ok(arm.bottom >= 70, `手只到第 ${arm.bottom} 列，手掌被切掉`);
    assert.ok(leg.pivot >= 62, `腿從第 ${leg.pivot} 列擺，髖部還在腰上面`);
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
