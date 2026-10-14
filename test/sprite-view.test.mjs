/**
 * 換面時用哪一張圖（shared/spriteCache.js 的 spriteView）。
 *
 * 側面與背面來自三視圖生成；沒有、或還沒載入完時一律退回正面 ——
 * 少一面只是轉身時不換圖，不能讓角色消失或出現程式推導的怪圖。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { spriteView } from '../shared/spriteCache.js';

const loaded = (name) => ({ name, complete: true, naturalWidth: 788 });

describe('spriteView', () => {
  test('正面就是 sprite 本身', () => {
    const sprite = { ...loaded('front'), views: { side: loaded('side') } };
    assert.equal(spriteView(sprite, 'front'), sprite);
    assert.equal(spriteView(sprite, undefined), sprite);
  });

  test('有生成的側面、背面就用它', () => {
    const sprite = { ...loaded('front'), views: { side: loaded('side'), back: loaded('back') } };
    assert.equal(spriteView(sprite, 'side').name, 'side');
    assert.equal(spriteView(sprite, 'back').name, 'back');
  });

  test('沒有該面（舊角色、其他風格）退回正面', () => {
    const sprite = { ...loaded('front'), views: {} };
    assert.equal(spriteView(sprite, 'back'), sprite);
    const noViews = loaded('front');
    assert.equal(spriteView(noViews, 'side'), noViews);
  });

  test('還沒載入完退回正面', () => {
    const sprite = { ...loaded('front'), views: { side: { complete: false, naturalWidth: 0 } } };
    assert.equal(spriteView(sprite, 'side'), sprite);
  });

  test('sprite 是 null 時不丟例外', () => {
    assert.equal(spriteView(null, 'side'), null);
  });
});
