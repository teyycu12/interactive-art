/**
 * CV 角色貼圖合成測試
 *
 * 驗的是「替身矩形何時該畫」這一件事。貼圖是去背過的透明圖，而替身是
 * 不透明的實心色塊 —— 無條件先畫替身再疊貼圖，色塊會從角色輪廓外的
 * 透明處透出來，在大螢幕上看起來就像根本沒去背（實際上去背是好的）。
 *
 * 這裡以最小的 canvas / Image stub 取代瀏覽器 DOM：要驗的是繪製順序與
 * 條件，不是 Canvas2D 本身的行為。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const CV_AVATAR = {
  source: 'CV',
  textures: {
    head: '/assets/gen/' + 'a'.repeat(32) + '/head.webp',
    torso: '/assets/gen/' + 'a'.repeat(32) + '/torso.webp',
    legs: '/assets/gen/' + 'a'.repeat(32) + '/legs.webp',
  },
  fallbackColors: {
    hair: '#4A2C1A', skin: '#F4C08A', torso: '#8FA05E', legs: '#B7A98A',
  },
};

/** 記錄每次繪製呼叫，供斷言檢查順序與內容 */
let ops;
let images;

function installDom() {
  ops = [];
  images = [];
  const ctx = {
    fillStyle: '', filter: 'none',
    fillRect: (...a) => ops.push({ op: 'fillRect', args: a }),
    clearRect: (...a) => ops.push({ op: 'clearRect', args: a }),
    drawImage: (img, ...a) => ops.push({ op: 'drawImage', src: img.src, args: a }),
  };
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
  globalThis.Image = class {
    constructor() { this.listeners = {}; images.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    fire(name) { this.listeners[name]?.(); }
  };
}

const fillRects = () => ops.filter((o) => o.op === 'fillRect');
const drawImages = () => ops.filter((o) => o.op === 'drawImage');

describe('CV 貼圖合成：替身矩形', () => {
  let cvAvatarImage;

  beforeEach(async () => {
    installDom();
    // 每個測試重新載入，避免模組層級狀態互相影響
    ({ cvAvatarImage } = await import(
      '../shared/avatarSprite.js?t=' + Math.random()));
  });

  test('三張貼圖都載入成功時，不留任何替身色塊', () => {
    cvAvatarImage(CV_AVATAR);
    const before = fillRects().length;
    assert.ok(before > 0, '載入前應先畫替身，避免角色是空白的');

    ops.length = 0;
    for (const img of images) img.fire('load');

    assert.equal(fillRects().length, 0,
      '貼圖到齊後不可再畫替身 —— 不透明色塊會從去背的透明處透出來');
    assert.equal(drawImages().length, 3, '三張貼圖都要疊上去');
  });

  test('有貼圖載入失敗時，仍畫替身補洞', () => {
    cvAvatarImage(CV_AVATAR);
    ops.length = 0;
    images[0].fire('load');
    images[1].fire('load');
    images[2].fire('error');   // 一張失敗

    assert.ok(fillRects().length > 0,
      '缺一張時要保留替身，否則角色在大螢幕上會缺一塊');
    assert.equal(drawImages().length, 2);
  });

  test('三張全部失敗時保留初始替身，不清空成空白', () => {
    cvAvatarImage(CV_AVATAR);
    const initial = fillRects().length;
    ops.length = 0;
    for (const img of images) img.fire('error');

    assert.equal(ops.length, 0, '全部失敗應直接返回，不動畫布');
    assert.ok(initial > 0);
  });

  test('合成前會先清空畫布', () => {
    cvAvatarImage(CV_AVATAR);
    ops.length = 0;
    for (const img of images) img.fire('load');
    assert.equal(ops[0].op, 'clearRect', '沒有先清空，替身會殘留在底層');
  });
});
