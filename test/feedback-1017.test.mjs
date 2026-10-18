/**
 * 2026-10-17 試玩回饋的修正：話題桌只在辦公室、配對碼的寬限
 *
 * 執行：node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THEMES } from '../shared/themes.js';
import { PAIRING } from '../server/config.js';
import { PairingSession } from '../server/pairing.js';
import { SocialGraph } from '../server/socialgraph.js';

test('話題桌只在辦公室開：其他場景的號碼牌是集合點與器材站', () => {
  const on = THEMES.filter((t) => t.topicTables).map((t) => t.id);
  assert.deepEqual(on, ['office']);
  // 號碼牌照樣留著給集合任務用
  assert.ok(Object.keys(THEMES.find((t) => t.id === 'kitchen').spots).length > 0);
});

test('配對碼輪換後，舊碼整整一分鐘內都還能用', () => {
  assert.ok(PAIRING.graceMs >= 60_000, '先記下碼、走去找下一個人再輸入，常常超過 15 秒');
  assert.ok(PAIRING.graceMs <= PAIRING.rotateMs, '只存一代舊碼：寬限不能比輪換間隔長');
  const p = new PairingSession(new SocialGraph());
  p.register('A');
  p.register('B');
  const t = 1_000_000;
  p.rotate(t);
  const old = p.codeOf('B');
  p.rotate(t + PAIRING.rotateMs);
  const r = p.claim('A', old, t + PAIRING.rotateMs + 50_000);
  assert.equal(r.ok, true, '輪換後 50 秒，舊碼仍找得到人');
  assert.equal(r.target, 'B');
});

test('新碼不會跟仍在寬限內的舊碼撞號（寬限拉長後更要緊）', () => {
  const p = new PairingSession(new SocialGraph());
  for (let i = 0; i < 300; i++) p.register(`u${i}`);
  const t = 1_000_000;
  p.rotate(t);
  const olds = new Map([...Array(300).keys()].map((i) => [`u${i}`, p.codeOf(`u${i}`)]));
  p.rotate(t + PAIRING.rotateMs);
  const fresh = new Set([...Array(300).keys()].map((i) => p.codeOf(`u${i}`)));
  for (const [, code] of olds) assert.ok(!fresh.has(code), `新碼 ${code} 跟某人的舊碼一樣`);
});

test('配對碼輪換改成 100 秒，手機拿得到「還剩幾秒換新碼」（2026-10-19）', () => {
  assert.equal(PAIRING.rotateMs, 100_000);
  const p = new PairingSession(new SocialGraph());
  const t = 1_000_000;
  p.rotate(t);
  assert.equal(p.msUntilRotate(t), 100_000);
  assert.equal(p.msUntilRotate(t + 30_000), 70_000);
  assert.equal(p.msUntilRotate(t + 200_000), 0, '不會是負的');
});
