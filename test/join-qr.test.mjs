/**
 * 大螢幕的進場 QR（server/joinQr.js，REVIEW E1）
 *
 * 網址選法跟合照 QR 共用（photos.js 的 publicOrigin）：兩個 QR 指向同一台電腦，
 * 一個掃得開、另一個掃不開的話，現場只會覺得「QR 時好時壞」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qrSvgDataUrl, joinUrlOf } from '../server/joinQr.js';
import { publicOrigin, photoUrlBase } from '../server/photos.js';

const base = { scheme: 'https', port: 3000, lanAddrs: ['192.168.1.105'] };

test('進場網址指向手機頁面', () => {
  assert.equal(joinUrlOf('https://192.168.1.105:3000'), 'https://192.168.1.105:3000/controller/');
  assert.equal(joinUrlOf('https://abc.ngrok-free.app/'), 'https://abc.ngrok-free.app/controller/');
});

test('QR 是可以直接放進 <img> 的 SVG，不靠任何外部服務', () => {
  const url = qrSvgDataUrl('https://192.168.1.105:3000/controller/');
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg.replace(/xmlns="[^"]+"/g, '')), 'SVG 裡不能引用外部資源');
});

test('進場 QR 與合照 QR 用同一套網址選法', () => {
  for (const opts of [
    base,
    { ...base, viewerOrigin: 'https://abc.ngrok-free.app' },
    { ...base, viewerOrigin: 'https://localhost:3000' },
    { ...base, publicHost: 'https://abc.ngrok-free.app/' },
    { ...base, publicHost: '10.0.0.8' },
  ]) {
    assert.equal(photoUrlBase(opts), `${publicOrigin(opts)}/photos`);
  }
  // 主辦端開在本機時不能給 localhost —— 手機上的 localhost 是手機自己
  assert.equal(publicOrigin({ ...base, viewerOrigin: 'https://localhost:3000' }), 'https://192.168.1.105:3000');
  assert.equal(publicOrigin({ ...base, viewerOrigin: 'https://abc.ngrok-free.app' }), 'https://abc.ngrok-free.app');
});
