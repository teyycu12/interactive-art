import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, THEME_MAP, DEFAULT_THEME, isThemeId } from '../shared/themes.js';
import { PROPS } from '../shared/scene.js';
import { SCENES } from '../public/screen/scenes/registry.js';
import { KitchenScene } from '../public/screen/scenes/KitchenScene.js';
import { OfficeScene } from '../public/screen/scenes/OfficeScene.js';

// 主辦端選單、伺服器驗證、大螢幕載入三端共用 THEMES。對不上的症狀是
// 「主辦端選了、大螢幕沒反應」或「退回預設場景」，而兩邊都不報錯。
test('every theme in the host menu has a scene, and every scene is selectable', () => {
  assert.deepEqual(THEMES.map((t) => t.id).sort(), Object.keys(SCENES).sort());
  assert.ok(isThemeId(DEFAULT_THEME));
});

test('theme ids are validated strictly', () => {
  for (const bad of [undefined, null, '', 'OFFICE', '__proto__', 'constructor', '../../etc/passwd', 42]) {
    assert.equal(isThemeId(bad), false, String(bad));
  }
});

// 之後的集合任務（「穿白色的人到 1號桌」）會用 spots 取道具座標，
// 指到不存在的道具就等於叫大家去一張不存在的桌子。
test('numbered spots point at real props and never repeat a name within a theme', () => {
  const ids = new Set(PROPS.map((p) => p.id));
  for (const t of THEMES) {
    for (const propId of Object.keys(t.spots)) assert.ok(ids.has(propId), `${t.id}: ${propId}`);
    const names = Object.values(t.spots);
    assert.equal(new Set(names).size, names.length, `${t.id} has duplicate spot names`);
  }
});

test('each pixel scene is wired to its own theme entry', () => {
  for (const Scene of [KitchenScene, OfficeScene]) {
    assert.ok(THEME_MAP[Scene.THEME_ID], Scene.name);
    assert.equal(typeof Scene.paintRoom, 'function');
    assert.equal(typeof Scene.paintProp, 'function');
  }
});

// 新增道具時若只在廚房補了外觀，辦公室會悄悄把它畫成盆栽。
// 盆栽（plt_*）刻意走 FALLBACK，其餘道具都要有明確外觀。
test('every non-plant prop has an explicit appearance in each pixel theme', () => {
  for (const Scene of [KitchenScene, OfficeScene]) {
    const scene = Object.create(Scene.prototype);
    for (const p of PROPS) {
      const item = scene.item(p);
      assert.equal(item.length, 3, `${Scene.name} ${p.id}`);
      if (!p.id.startsWith('plt_')) assert.ok(Scene.ITEMS[p.id], `${Scene.name} is missing ${p.id}`);
    }
    assert.equal(scene.item({ id: 'future', type: 'unknown' }), Scene.FALLBACK);
  }
});

// 問卷選項可以綁道具，而大螢幕與主辦端都以道具名稱顯示集合地點。
// 兩個道具同名時，「到工作桌集合」會指向兩張不同的桌子，而畫面上看不出差別。
test('每個主題裡的道具名稱互不重複', () => {
  for (const Scene of [KitchenScene, OfficeScene]) {
    const labels = Object.values(Scene.ITEMS).map(([, label]) => label);
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    assert.deepEqual([...new Set(dupes)], [], `${Scene.name} 有同名道具`);
  }
});
