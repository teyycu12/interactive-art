/**
 * 斷線的手機用號碼牌領回生成結果（server/generateResults.js、/api/generate/result）
 *
 * 40 人排隊時最後幾位要等好幾分鐘，期間切去別的 App、螢幕鎖定，iOS 都會把
 * 生成請求的連線砍掉 —— 而那張圖照樣生完、照樣收費。這裡守住：結果留得住、
 * 只能領一次、會過期；排隊中斷線但還在輪詢的人不會被讓位。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { GenerateResults } from '../server/generateResults.js';

const T = (n) => n.toString(16).padStart(32, '0');

describe('結果暫存', () => {
  test('領一次就沒了', () => {
    const r = new GenerateResults();
    r.put(T(1), 200, Buffer.from('{"ok":true}'));
    assert.equal(r.has(T(1)), true);
    assert.equal(r.take(T(1)).body.toString(), '{"ok":true}');
    assert.equal(r.take(T(1)), null);
    assert.equal(r.has(T(1)), false);
  });

  test('過期就丟', () => {
    let now = 0;
    const r = new GenerateResults({ ttlMs: 1000, now: () => now });
    r.put(T(1), 200, Buffer.from('a'));
    now = 999;
    assert.equal(r.has(T(1)), true);
    now = 1001;
    assert.equal(r.has(T(1)), false);
  });

  test('超過筆數上限丟最舊的，記憶體不會一路長', () => {
    const r = new GenerateResults({ maxEntries: 2 });
    for (let i = 1; i <= 3; i++) r.put(T(i), 200, Buffer.from(String(i)));
    assert.equal(r.has(T(1)), false);
    assert.equal(r.has(T(2)), true);
    assert.equal(r.has(T(3)), true);
  });
});

describe('經由 HTTP 層', () => {
  /** 假的生成服務：每次收到請求都記下來，等 release() 才回 */
  let vision;
  let calls = 0;
  const pending = [];
  let server;
  let base;

  before(async () => {
    vision = http.createServer((req, res) => {
      calls += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => pending.push(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, n: calls }));
      }));
    });
    await new Promise((r) => vision.listen(0, '127.0.0.1', r));
    process.env.VISION_PORT = String(vision.address().port);
    process.env.GEN_MAX_CONCURRENT = '1';
    // config.js 在載入當下讀 VISION_PORT，所以要等環境變數設好才 import
    const { createHttpLayer } = await import('../server/httplayer.js');
    const layer = createHttpLayer({
      root: process.cwd(), publicDir: process.cwd(),
      keyMatches: () => false, onScreenCapture: () => false,
    });
    server = http.createServer(layer.handleRequest);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.closeAllConnections();
    vision.closeAllConnections();
    server.close();
    vision.close();
  });

  const getJSON = async (path) => (await fetch(base + path)).json();
  const waitFor = async (cond) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(cond(), 'waitFor 逾時');
  };
  /** 送出生成請求後立刻把連線砍掉，模擬 iOS 把頁面暫停 */
  const postAndDrop = (ticket) => new Promise((resolve) => {
    const req = http.request(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gen-Ticket': ticket },
    });
    req.on('error', () => {});
    req.end('{}', () => setTimeout(() => { req.destroy(); resolve(); }, 50));
  });

  test('生成中斷線：結果照樣留著，用號碼牌領得回來，只能領一次', async () => {
    const ticket = T(0xa1);
    await postAndDrop(ticket);
    await waitFor(() => pending.length === 1);
    assert.equal((await getJSON(`/api/generate/status?ticket=${ticket}`)).state, 'active');

    pending.shift()();
    let s;
    for (let i = 0; i < 50; i++) {
      s = await getJSON(`/api/generate/status?ticket=${ticket}`);
      if (s.state === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(s.state, 'done');

    const got = await getJSON(`/api/generate/result?ticket=${ticket}`);
    assert.equal(got.ok, true);
    assert.equal((await getJSON(`/api/generate/result?ticket=${ticket}`)).error, 'result_not_found');
  });

  test('排隊中斷線但還在輪詢：輪到時照樣生成，不會被讓位', async () => {
    const first = T(0xb1);
    const second = T(0xb2);
    const before = calls;
    await postAndDrop(first);
    await waitFor(() => pending.length === 1);
    await postAndDrop(second);
    const q = await getJSON(`/api/generate/status?ticket=${second}`);
    assert.equal(q.state, 'queued', '並發上限 1：第二個人在排隊');

    pending.shift()();
    await waitFor(() => pending.length === 1);
    assert.equal(calls, before + 2, '連線已斷、但剛輪詢過的人照樣送去生成');
    pending.shift()();
  });

  test('不認得的號碼牌領不到東西', async () => {
    assert.equal((await getJSON(`/api/generate/result?ticket=${T(0xc1)}`)).error, 'result_not_found');
    assert.equal((await getJSON(`/api/generate/result?ticket=bad`)).error, 'result_not_found');
  });
});
