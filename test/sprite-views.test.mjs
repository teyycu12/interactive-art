/**
 * 正面／背面／側面測試
 *
 * 兩半：
 *   1. 伺服器的 updateView —— 往哪走該是哪一面、防抖、停下後轉回正面
 *   2. shared/spriteViews.js 的像素推導 —— 用一張合成的小角色圖驗
 *      「背面看不到臉」「側面變窄」「找得到脖子」
 *
 * 推導是純函式（輸入輸出都是 {width, height, data}），不需要 DOM。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stepAgent } from '../server/arbiter.js';
import { Stage } from '../server/state.js';
import { FACING_DWELL_MS, VIEW_RETURN_FRONT_MS } from '../server/config.js';
import { AGENT_VIEW } from '../shared/protocol.js';
import {
  analyze, deriveBack, deriveSide, findNeckRow, opaqueBounds,
} from '../shared/spriteViews.js';

// ─────────────────────────────────────────────────────────────
// 1. 伺服器：updateView
// ─────────────────────────────────────────────────────────────

const AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

function makeAgent(stage, overrides = {}) {
  const a = stage.addAgent({ name: 'T', avatar: AVATAR });
  a.boidsVx = 0;
  a.boidsVy = 0;
  a.lastInputAt = 0;
  Object.assign(a, { x: 1200, y: 600 }, overrides);
  return a;
}

/** 以固定輸入推 n 幀，回傳最後的時間 */
function push(agent, x, y, frames, now) {
  agent.inputX = x;
  agent.inputY = y;
  agent.inputIntensity = x || y ? 1 : 0;
  for (let i = 0; i < frames; i++) {
    now += 33;
    if (x || y) agent.lastInputAt = now;
    stepAgent(agent, [agent], 0.033, now);
  }
  return now;
}

describe('伺服器：正面／背面／側面', () => {
  test('新角色是正面', () => {
    const agent = makeAgent(new Stage());
    assert.equal(agent.view, AGENT_VIEW.FRONT);
  });

  test('往上（遠離鏡頭）走是背面，往下是正面，橫走是側面', () => {
    const agent = makeAgent(new Stage());
    let now = 1_000_000;
    now = push(agent, 0, -1, 30, now);
    assert.equal(agent.view, AGENT_VIEW.BACK);
    now = push(agent, 1, 0, 30, now);
    assert.equal(agent.view, AGENT_VIEW.SIDE);
    now = push(agent, 0, 1, 30, now);
    assert.equal(agent.view, AGENT_VIEW.FRONT);
  });

  test('斜走時不在側面與背面之間來回跳', () => {
    // 剛好 45° 往左上：|vx| ≈ |vy|，正落在判定邊界上。
    // 沒有遲滯的話速度的微小起伏就會讓圖一直換。
    const agent = makeAgent(new Stage());
    let now = push(agent, 0, -1, 30, 1_000_000);
    assert.equal(agent.view, AGENT_VIEW.BACK);

    let changes = 0;
    let prev = agent.view;
    for (let i = 0; i < 60; i++) {
      const wobble = Math.sin(i * 1.3) * 0.12;
      now = push(agent, -Math.SQRT1_2 + wobble, -Math.SQRT1_2 - wobble, 1, now);
      if (agent.view !== prev) { changes++; prev = agent.view; }
    }
    assert.equal(changes, 0, `斜走期間不應換面，實得 ${changes} 次`);
  });

  test('換面要站得住腳：短暫的反向不換', () => {
    const agent = makeAgent(new Stage());
    let now = push(agent, 0, -1, 30, 1_000_000);
    assert.equal(agent.view, AGENT_VIEW.BACK);
    // 比 FACING_DWELL_MS 短的往下推
    const frames = Math.floor(FACING_DWELL_MS / 33) - 1;
    now = push(agent, 0, 1, frames, now);
    now = push(agent, 0, -1, 10, now);
    assert.equal(agent.view, AGENT_VIEW.BACK);
  });

  test('停下滿 VIEW_RETURN_FRONT_MS 才轉回正面，不是一停就轉', () => {
    const agent = makeAgent(new Stage());
    let now = push(agent, 0, -1, 30, 1_000_000);
    assert.equal(agent.view, AGENT_VIEW.BACK);

    // 放開搖桿後一小段時間仍是背面（走走停停時不閃）
    now = push(agent, 0, 0, 12, now);
    assert.equal(agent.view, AGENT_VIEW.BACK, '剛放開時應維持背面');

    // 煞停約 1.2 秒，再加上 VIEW_RETURN_FRONT_MS
    now = push(agent, 0, 0, Math.ceil((1500 + VIEW_RETURN_FRONT_MS) / 33), now);
    assert.equal(agent.view, AGENT_VIEW.FRONT, '停下夠久要轉回正面讓人認得出來');
  });

  test('STAGE_SYNC 只在不是正面時帶 view', () => {
    const stage = new Stage();
    const agent = makeAgent(stage);
    let snap = stage.snapshot().find((a) => a.id === agent.id);
    assert.equal(snap.view, undefined);

    push(agent, 0, -1, 30, 1_000_000);
    snap = stage.snapshot().find((a) => a.id === agent.id);
    assert.equal(snap.view, AGENT_VIEW.BACK);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. 推導：合成角色圖
// ─────────────────────────────────────────────────────────────

const W = 60;
const H = 100;
const HAIR = [90, 50, 20];
const SKIN = [240, 190, 150];
const EYE = [20, 120, 60];      // 綠眼睛：亮度高於輪廓門檻，不會被當成輪廓
const SHIRT = [60, 110, 200];
const LOGO = [250, 230, 40];
const PANTS = [70, 70, 80];
const INK = [48, 42, 45];

/**
 * 一個 3 頭身的小人：頭 24 寬（含髮）、脖子 8 寬、身體 36 寬、兩條腿。
 * 每個區塊外圍一圈 1px 墨線。
 */
function makeFigure() {
  const data = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
    }
  };
  const box = (x0, y0, x1, y1, c) => { fill(x0, y0, x1, y1, INK); fill(x0 + 1, y0 + 1, x1 - 1, y1 - 1, c); };

  box(18, 2, 42, 32, SKIN);       // 頭
  fill(19, 3, 41, 12, HAIR);      // 頭頂的頭髮
  fill(23, 18, 26, 21, EYE);      // 左眼
  fill(34, 18, 37, 21, EYE);      // 右眼
  box(26, 32, 34, 37, SKIN);      // 脖子
  box(12, 37, 48, 64, SHIRT);     // 上衣
  fill(26, 44, 34, 52, LOGO);     // 胸前圖案
  box(16, 64, 29, 98, PANTS);     // 左腿
  box(31, 64, 44, 98, PANTS);     // 右腿
  return { width: W, height: H, data };
}

const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const near = (a, b, tol = 40) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

/** 一塊區域裡有沒有某個顏色 */
function hasColor(img, color, y0 = 0, y1 = img.height, tol = 12) {
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = px(img, x, y);
      if (p[3] > 40 && near(p, color, tol)) return true;
    }
  }
  return false;
}

describe('推導：從正面得到背面與側面', () => {
  test('找得到脖子（頭部下緣最窄的那一列）', () => {
    const img = makeFigure();
    const neck = findNeckRow(img);
    assert.ok(neck >= 32 && neck < 37, `脖子應在 32~36 列，實得 ${neck}`);
  });

  test('髮色取自頭頂', () => {
    const a = analyze(makeFigure());
    assert.ok(near(a.hair, HAIR, 16), `髮色應接近 ${HAIR}，實得 ${a.hair}`);
  });

  test('背面看不到眼睛，頭部內部是髮色系', () => {
    const back = deriveBack(makeFigure());
    assert.equal(hasColor(back, EYE, 0, 37), false, '背面不該有眼睛');
    // 鏡像後頭的中央仍在畫面中央
    assert.ok(near(px(back, 30, 20), HAIR, 50), `後腦勺應是髮色，實得 ${px(back, 30, 20)}`);
  });

  test('背面保留輪廓線', () => {
    const back = deriveBack(makeFigure());
    // 頭部左緣那一圈墨線（鏡像後在 x = 59 - 18 = 41）
    assert.ok(near(px(back, 41, 20), INK, 4));
  });

  test('背面抹掉胸前圖案，但不動腿', () => {
    const back = deriveBack(makeFigure());
    assert.equal(hasColor(back, LOGO, 37, 64), false, '背面不該有胸前圖案');
    assert.ok(hasColor(back, PANTS, 64, 98), '褲子要在');
  });

  test('側面比正面窄，頭留一隻眼睛', () => {
    const img = makeFigure();
    const side = deriveSide(img);
    const fb = opaqueBounds(img);
    const sb = opaqueBounds(side);
    assert.ok(sb.x1 - sb.x0 < (fb.x1 - fb.x0) * 0.8, '側面要明顯變窄');
    // 腳底與頭頂不動：drawCharacter 以腳底對齊，高度變了角色會浮起來
    assert.equal(sb.y0, fb.y0);
    assert.equal(sb.y1, fb.y1);

    // 朝右：後半個頭（左側）是頭髮，前面（右側）還看得到眼睛
    let leftEye = false, rightEye = false;
    for (let y = 18; y < 21; y++) {
      for (let x = 0; x < W; x++) {
        if (!near(px(side, x, y), EYE, 12)) continue;
        if (x < 30) leftEye = true; else rightEye = true;
      }
    }
    assert.equal(leftEye, false, '後半個頭不該有眼睛');
    assert.equal(rightEye, true, '朝前的那隻眼睛要在');
  });

  test('推導不改動輸入', () => {
    const img = makeFigure();
    const before = new Uint8ClampedArray(img.data);
    deriveBack(img);
    deriveSide(img);
    assert.deepEqual(img.data, before);
  });

  test('全透明的圖原樣回傳，不丟例外', () => {
    const empty = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
    assert.equal(analyze(empty), null);
    assert.deepEqual(deriveBack(empty).data, empty.data);
    assert.deepEqual(deriveSide(empty).data, empty.data);
  });
});
