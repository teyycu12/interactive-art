/**
 * 大合照的下載網址與存檔
 *
 * QR Code 原本指向 http://127.0.0.1:5055/photos/... —— 手機上的 127.0.0.1 是手機
 * 自己，生成服務也沒有那條路由，掃得到、打不開（2026-10-17 現場回報）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { photoUrlBase, savePhoto, photoPath } from '../server/photos.js';
import { createHttpLayer } from '../server/httplayer.js';

const ID = 'photo_1792169613_3p_18f34d68';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

describe('合照網址', () => {
  test('指向手機連得到的區網位址，不是 127.0.0.1', () => {
    const base = photoUrlBase({ scheme: 'https', port: 3000, lanAddrs: ['172.30.90.223'] });
    assert.equal(base, 'https://172.30.90.223:3000/photos');
  });

  test('PUBLIC_HOST 優先（好幾張網卡時指定場館 Wi-Fi 那張）', () => {
    const base = photoUrlBase({ scheme: 'https', port: 3000, lanAddrs: ['172.28.96.1'], publicHost: '192.168.1.5' });
    assert.equal(base, 'https://192.168.1.5:3000/photos');
  });

  test('沒有區網位址時退回 localhost', () => {
    assert.equal(photoUrlBase({ scheme: 'http', port: 3000, lanAddrs: [] }), 'http://localhost:3000/photos');
  });
});

describe('合照存檔與下載', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-photos-'));

  test('存成 <id>.png', () => {
    const file = savePhoto(dir, ID, DATA_URL);
    assert.ok(file);
    assert.deepEqual(fs.readFileSync(file), PNG);
  });

  test('id 不是合照的形狀就不存（擋路徑穿越）', () => {
    assert.equal(savePhoto(dir, '../state', DATA_URL), null);
    assert.equal(savePhoto(dir, ID, null), null);
  });

  test('只有合照檔名對應得到檔案', () => {
    assert.equal(photoPath(dir, `/photos/${ID}.png`), path.join(dir, `${ID}.png`));
    assert.equal(photoPath(dir, '/photos/../state.json'), null);
    assert.equal(photoPath(dir, '/photos/state.json'), null);
  });

  test('Gateway 送得出合照，送不出 data/ 底下的其他檔案', async () => {
    savePhoto(dir, ID, DATA_URL);
    fs.writeFileSync(path.join(dir, 'state.json'), '{"hostKey":"SECRET"}');
    const { handleRequest } = createHttpLayer({
      root: process.cwd(), publicDir: path.join(process.cwd(), 'public'),
      keyMatches: () => false, onScreenCapture: () => false, photosDir: dir,
    });
    const server = http.createServer(handleRequest);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = (p) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      });
    });
    try {
      const ok = await get(`/photos/${ID}.png`);
      assert.equal(ok.status, 200);
      assert.equal(ok.type, 'image/png');
      assert.deepEqual(ok.body, PNG);
      assert.equal((await get('/photos/state.json')).status, 404);
      assert.equal((await get('/photos/..%2fstate.json')).status, 404);
      assert.equal((await get('/photos/photo_1_1p_00.png')).status, 404, '沒有這張');
    } finally {
      server.close();
    }
  });
});

describe('/api/version', () => {
  test('回報啟動時的 commit（scripts/doctor.py 比對「pull 了沒重開」）', async () => {
    const { handleRequest } = createHttpLayer({
      root: process.cwd(), publicDir: path.join(process.cwd(), 'public'),
      keyMatches: () => false, onScreenCapture: () => false, buildCommit: 'abc1234',
    });
    const server = http.createServer(handleRequest);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const body = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/version' }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve(JSON.parse(text)));
        });
      });
      assert.deepEqual(body, { ok: true, commit: 'abc1234' });
    } finally {
      server.close();
    }
  });
});
