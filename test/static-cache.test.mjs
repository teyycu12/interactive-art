/**
 * 靜態檔的壓縮與重新驗證（2026-10 實測：手機頁面每次載入約 700 KB 全部重下）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

import { createHttpLayer } from '../server/httplayer.js';

async function withServer(fn) {
  const { handleRequest } = createHttpLayer({
    root: process.cwd(), publicDir: path.join(process.cwd(), 'public'),
    keyMatches: () => false, onScreenCapture: () => false,
  });
  const server = http.createServer(handleRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (p, headers = {}) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
  });
  try { await fn(get); } finally { server.close(); }
}

describe('靜態檔：gzip 與 ETag', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), 'public/controller/app.js'));

  test('手機說收得下 gzip 就壓縮，解開跟原檔一模一樣', () => withServer(async (get) => {
    const r = await get('/controller/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers.vary, 'Accept-Encoding');
    assert.ok(r.body.length < raw.length / 2, `壓縮後 ${r.body.length} bytes`);
    assert.deepEqual(zlib.gunzipSync(r.body), raw);
  }));

  test('沒說收得下 gzip 就送原檔', () => withServer(async (get) => {
    const r = await get('/controller/app.js');
    assert.equal(r.headers['content-encoding'], undefined);
    assert.deepEqual(r.body, raw);
  }));

  test('檔案沒變就回 304，不重送內容；仍要求每次重新驗證', () => withServer(async (get) => {
    const first = await get('/controller/app.js');
    assert.ok(first.headers.etag);
    assert.equal(first.headers['cache-control'], 'no-cache');
    const again = await get('/controller/app.js', { 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
  }));

  test('圖片不再壓一次', () => withServer(async (get) => {
    const r = await get('/controller/icon-192.png', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
  }));

  test('目錄少了尾斜線仍轉址，不存在的檔案仍是 404', () => withServer(async (get) => {
    assert.equal((await get('/controller')).status, 302);
    assert.equal((await get('/controller/nope.js')).status, 404);
  }));
});
