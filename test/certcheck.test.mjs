/**
 * TLS 憑證健檢
 *
 * 驗的是「現場掃不進來」這個故障能不能在啟動時就被指出來。
 * 憑證與 IP 不符時，服務照常啟動、位址看起來正常，
 * 只有手機端會報錯 —— 而那個訊息完全不提 IP。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { certificateReport } from '../server/certcheck.js';

const SAN = 'DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.104';
const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 25);

describe('憑證涵蓋範圍', () => {
  test('IP 相符時不回報缺漏', () => {
    const r = certificateReport(SAN, new Date(NOW + 90 * DAY), ['192.168.1.104'], NOW);
    assert.deepEqual(r.missing, []);
  });

  test('DHCP 換號後指出不符的位址', () => {
    // 這正是實際發生過的情境：憑證簽的是 .104，重連 Wi-Fi 後變成 .111
    const r = certificateReport(SAN, new Date(NOW + 90 * DAY), ['192.168.1.111'], NOW);
    assert.deepEqual(r.missing, ['192.168.1.111'],
      '沒抓到 IP 不符 —— 這個故障只會在現場以「手機掃不進來」的形式出現');
  });

  test('多張網卡時只回報沒被涵蓋的那些', () => {
    const r = certificateReport(SAN, new Date(NOW + 90 * DAY),
      ['192.168.1.104', '10.0.0.5'], NOW);
    assert.deepEqual(r.missing, ['10.0.0.5']);
  });

  test('只比對 IP，不把 DNS 名稱誤算成位址', () => {
    // "DNS:localhost" 不該讓 IP 檢查放行任何東西
    const r = certificateReport('DNS:localhost', new Date(NOW + 90 * DAY),
      ['192.168.1.104'], NOW);
    assert.deepEqual(r.missing, ['192.168.1.104']);
  });

  test('SAN 缺漏或格式異常時視為完全沒涵蓋，而不是拋錯', () => {
    for (const san of [undefined, null, '', 'garbage']) {
      const r = certificateReport(san, new Date(NOW + 90 * DAY), ['192.168.1.104'], NOW);
      assert.deepEqual(r.missing, ['192.168.1.104']);
    }
  });
});

describe('憑證到期', () => {
  test('未到期時 expired 為 false', () => {
    const r = certificateReport(SAN, new Date(NOW + 30 * DAY), [], NOW);
    assert.equal(r.expired, false);
    assert.equal(r.daysLeft, 30);
  });

  test('已過期時 expired 為 true 且天數為負', () => {
    const r = certificateReport(SAN, new Date(NOW - 3 * DAY), [], NOW);
    assert.equal(r.expired, true);
    assert.equal(r.daysLeft, -3);
  });

  test('到期時間解析不出來時視為過期，不是靜默放行', () => {
    // NaN 會讓 expired（NaN < 0）與近期到期（NaN <= 14）兩個分支同時失效，
    // 壞掉的憑證會在啟動訊息上看起來完全健康 —— 正是本模組要防的靜默失敗
    for (const bad of ['not a date', '', undefined, null]) {
      const r = certificateReport(SAN, bad, [], NOW);
      assert.equal(r.expired, true,
        `validTo=${JSON.stringify(bad)} 被當成有效憑證 —— 壞憑證會靜默通過`);
    }
  });

  test('不足一天以無條件捨去計算', () => {
    // 剩 12 小時要顯示成 0 天，不能四捨五入成 1 ——
    // 「還有 1 天」會讓人以為明天再處理就好
    const r = certificateReport(SAN, new Date(NOW + DAY / 2), [], NOW);
    assert.equal(r.daysLeft, 0);
    assert.equal(r.expired, false);
  });
});
