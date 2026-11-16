/**
 * 預設角色（server/starters.js，REVIEW E3）：生成服務掛了時手機讓人選一個先進場。
 * 這些角色要真的進得了場：過進場同一道驗證、貼圖檔真的在、複製到 gen/ 之後網址才對得上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadStarters } from '../server/starters.js';
import { validateAvatarConfig } from '../shared/avatars.js';

const REAL_STARTERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'starters');

/** 拷一份到暫存的 public/：不能在測試裡寫進專案真正的 assets/gen/ */
function tempPublic() {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelair-starters-'));
  fs.cpSync(REAL_STARTERS, path.join(pub, 'assets', 'starters'), { recursive: true });
  return pub;
}

test('版控裡的 6 個預設角色都合法、貼圖齊全，開機時複製到 gen/', () => {
  const pub = tempPublic();
  const list = loadStarters(pub);
  assert.equal(list.length, 6);
  assert.deepEqual(list.map((s) => s.label), ['女生 A', '女生 B', '女生 C', '女生 D', '男生 A', '男生 B']);
  for (const s of list) {
    assert.ok(validateAvatarConfig(s.avatar).ok, `${s.label} 過不了進場驗證`);
    for (const part of ['head', 'torso', 'legs', 'full', 'side', 'back']) {
      assert.ok(fs.existsSync(path.join(pub, s.avatar.textures[part])), `${s.label} 缺 ${part}`);
    }
    // 大螢幕從側面貼圖的網址推得到手臂資料
    assert.ok(fs.existsSync(path.join(pub, 'assets', 'gen', s.id, 'arms.json')), `${s.label} 缺 arms.json`);
  }
  fs.rmSync(pub, { recursive: true, force: true });
});

test('六個是不同的角色（不是同一組貼圖）', () => {
  const pub = tempPublic();
  const list = loadStarters(pub);
  assert.equal(new Set(list.map((s) => s.id)).size, 6);
  const heads = new Set(list.map((s) => fs.readFileSync(path.join(pub, s.avatar.textures.head)).toString('base64')));
  assert.equal(heads.size, 6);
  fs.rmSync(pub, { recursive: true, force: true });
});

test('manifest 被改壞時只略過壞的那個，不影響其他', () => {
  const pub = tempPublic();
  const file = path.join(pub, 'assets', 'starters', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.starters[0].id = '../../etc';                 // 路徑穿越
  m.starters[1].fallbackColors = { skin: 'red' }; // 顏色格式不對
  fs.writeFileSync(file, JSON.stringify(m));
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(loadStarters(pub).length, 4); } finally { console.warn = warn; }
  fs.rmSync(pub, { recursive: true, force: true });
});

test('沒有 starters 資料夾或 manifest 壞掉：回空陣列、不丟例外', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelair-starters-'));
  assert.deepEqual(loadStarters(pub), []);
  fs.mkdirSync(path.join(pub, 'assets', 'starters'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'assets', 'starters', 'manifest.json'), '{壞掉');
  assert.deepEqual(loadStarters(pub), []);
  fs.rmSync(pub, { recursive: true, force: true });
});
