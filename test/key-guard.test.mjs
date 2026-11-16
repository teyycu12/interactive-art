/**
 * 主辦端密鑰的失敗次數限制（server/keyGuard.js，REVIEW B1）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { KeyGuard } from '../server/keyGuard.js';
import { createHttpLayer } from '../server/httplayer.js';

const match = (k) => k === 'RIGHT1';

describe('KeyGuard', () => {
  test('錯太多次就鎖住，連正確的密鑰也不收；鎖過期後恢復', () => {
    const g = new KeyGuard({ maxFails: 3, windowMs: 60_000, lockMs: 30_000 });
    let t = 1000;
    assert.equal(g.check('a', 'x', match, t), 'bad');
    assert.equal(g.check('a', 'x', match, t += 10), 'bad');
    assert.equal(g.check('a', 'x', match, t += 10), 'bad');          // 第 3 次錯 → 鎖
    assert.equal(g.check('a', 'RIGHT1', match, t += 10), 'locked', '鎖住期間正確的也不收');
    assert.ok(g.retryAfterMs('a', t) > 0);
    assert.equal(g.check('a', 'RIGHT1', match, t + 30_001), 'ok');
  });

  test('不同來源各算各的', () => {
    const g = new KeyGuard({ maxFails: 2 });
    g.check('a', 'x', match, 0); g.check('a', 'x', match, 1);
    assert.equal(g.check('a', 'RIGHT1', match, 2), 'locked');
    assert.equal(g.check('b', 'RIGHT1', match, 2), 'ok');
  });

  test('打錯幾次之後輸入正確，失敗紀錄清掉', () => {
    const g = new KeyGuard({ maxFails: 3 });
    g.check('a', 'x', match, 0); g.check('a', 'x', match, 1);
    assert.equal(g.check('a', 'RIGHT1', match, 2), 'ok');
    g.check('a', 'x', match, 3); g.check('a', 'x', match, 4);
    assert.equal(g.check('a', 'RIGHT1', match, 5), 'ok', '清掉之後重新計，兩次錯不會鎖');
  });

  test('超過視窗的失敗不累計', () => {
    const g = new KeyGuard({ maxFails: 3, windowMs: 1000 });
    g.check('a', 'x', match, 0); g.check('a', 'x', match, 100);
    assert.equal(g.check('a', 'x', match, 5000), 'bad');
    assert.equal(g.locked('a', 5001), false);
  });
});

describe('HTTP 主辦端路徑', () => {
  test('錯太多次回 429，正確密鑰在鎖住期間也一樣；其他來源不受影響', async () => {
    const guard = new KeyGuard({ maxFails: 3, lockMs: 60_000 });
    const { handleRequest } = createHttpLayer({
      root: process.cwd(), publicDir: path.join(process.cwd(), 'public'),
      keyMatches: match, onScreenCapture: () => false,
      // 測試用：來源位址取自 X-Test-Ip（真正的伺服器用 clientIp）
      checkHostKey: (req, key) => guard.check(req.headers['x-test-ip'], key, match),
    });
    const server = http.createServer(handleRequest);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const status = (key, ip) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: `/api/host/avatars?key=${key}`, headers: { 'x-test-ip': ip } },
        (res) => { res.resume(); resolve(res.statusCode); });
    });
    try {
      assert.equal(await status('BAD', 'a'), 403);
      assert.equal(await status('BAD', 'a'), 403);
      assert.equal(await status('BAD', 'a'), 403);
      assert.equal(await status('RIGHT1', 'a'), 429);
      assert.equal(await status('RIGHT1', 'b'), 200);
    } finally { server.close(); }
  });
});
