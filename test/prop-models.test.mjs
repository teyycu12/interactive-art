/**
 * 3D 家具模型的相依防線（見 docs/notes/SERVER-AND-TESTS.md
 * 「前端相依一律由 node_modules 直出，不走 CDN」）
 *
 * 這支測試擋的是兩個「不會報錯但現場會出事」的回歸：
 *
 *   1. PROP_URLS 改回 CDN —— 展場斷網時六個模型全部走程序化後備，
 *      畫面不會空、只會變成另一個樣子，本機永遠測不出來。
 *   2. PROP_URLS 的鍵與 shared/scene.js 的 PROPS.type 對不上 ——
 *      populateProps() 會靜默 fallback 成盆栽模型再拉成該家具的高度。
 *      曾經發生過：鍵寫 couch、場景用 sofa，兩張沙發一直載盆栽。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM_SCENE = path.join(ROOT, 'public', 'screen', '3d', 'RoomScene.js');

/**
 * RoomScene.js 只在瀏覽器跑（import 了 three 與一堆 addons），Node 直接
 * import 會炸。這裡改用原始碼解析取出 PROP_URLS —— 也因此順帶擋住
 * 「把 URL 藏進變數或樣板字串」這種繞過寫法。
 */
function readPropUrls() {
  const src = readFileSync(ROOM_SCENE, 'utf8');
  const block = src.match(/const PROP_URLS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'RoomScene.js 找不到 PROP_URLS 定義');

  const urls = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(\w+)\s*:\s*'([^']*)'\s*,?\s*$/);
    if (m) urls[m[1]] = m[2];
  }
  return urls;
}

describe('3D 家具模型相依', () => {
  test('模型一律走本機路徑，不得指向 CDN', () => {
    const urls = readPropUrls();
    assert.ok(Object.keys(urls).length > 0, 'PROP_URLS 解析結果是空的');

    for (const [key, url] of Object.entries(urls)) {
      assert.ok(
        !/^https?:\/\//i.test(url),
        `${key} 指向外部網址（${url}）。展場斷網時會靜默降級成程序化後備，` +
          '本機測不出來 —— 請把模型下載到 public/assets/models/。'
      );
      assert.ok(
        url.startsWith('/assets/models/'),
        `${key} 的路徑（${url}）不在 /assets/models/ 底下`
      );
    }
  });

  test('每個模型檔都真的存在於版本庫中', () => {
    for (const [key, url] of Object.entries(readPropUrls())) {
      const file = path.join(ROOT, 'public', url.replace(/^\//, ''));
      assert.ok(existsSync(file), `${key} 對應的 ${url} 不存在`);

      // glTF 二進位的 magic 是 ASCII "glTF"。擋掉「curl 抓到錯誤頁面
      // 卻存成 .glb」這種情況 —— 那會等到現場才在 console 爆載入失敗。
      const magic = readFileSync(file).subarray(0, 4).toString('ascii');
      assert.equal(magic, 'glTF', `${url} 不是有效的 glTF 二進位檔`);
    }
  });

  test('PROP_URLS 的鍵涵蓋 scene.js 用到的每一種家具', async () => {
    const { PROPS } = await import('../shared/scene.js');
    const urls = readPropUrls();

    for (const type of new Set(PROPS.map((p) => p.type))) {
      assert.ok(
        Object.hasOwn(urls, type),
        `PROPS 用到 type='${type}'，但 PROP_URLS 沒有這個鍵。` +
          'populateProps() 會靜默 fallback 成盆栽模型，不會報錯。'
      );
    }
  });
});
