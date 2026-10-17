/**
 * 逐筆事件紀錄的測試
 *
 * 真的伺服器寫出了哪些事件由 e2e 驗（scripts/e2e.mjs「事件紀錄」那段）；
 * 這裡只驗紀錄器本身：格式、分檔、關機不掉資料、寫不進去也不拋錯。
 *
 * 執行：node --test
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventLog, sessionName, sessionKind, generationIdOf } from '../server/eventlog.js';

const TMP = path.join(os.tmpdir(), `pixelair-eventlog-${process.pid}`);
const read = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('事件紀錄', () => {
  test('入場、配對、離場三筆依序寫入，欄位正確', async () => {
    let t = 1000;
    const log = new EventLog({ dir: TMP, session: 'live-1019', now: () => t++ });
    log.log('join', { agent: 'usr_a', name: '小美', entry: 'photo', genReq: 'abc123' });
    log.log('pair_confirm', { agent: 'usr_a', peer: 'usr_b', ok: true });
    log.log('leave', { agent: 'usr_a', reason: 'self' });
    await log.close();

    const rows = read(path.join(TMP, 'live-1019.jsonl'));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      t: 1000, session: 'live-1019', ev: 'join',
      agent: 'usr_a', name: '小美', entry: 'photo', genReq: 'abc123',
    });
    assert.deepEqual(rows.map((r) => r.ev), ['join', 'pair_confirm', 'leave']);
    assert.deepEqual(rows.map((r) => r.t), [1000, 1001, 1002]);
    assert.equal(rows[1].peer, 'usr_b');
    assert.equal(rows[2].reason, 'self');
  });

  test('undefined 欄位不出現在紀錄裡', async () => {
    const log = new EventLog({ dir: TMP, session: 'dev' });
    log.log('join', { agent: 'usr_a', genReq: undefined });
    await log.close();
    const [row] = read(path.join(TMP, 'dev.jsonl'));
    assert.equal('genReq' in row, false);
  });

  test('不同場次分在不同檔案 —— 這就是測試與正式資料分開的方式', async () => {
    const dev = new EventLog({ dir: TMP, session: 'dev' });
    const live = new EventLog({ dir: TMP, session: 'live-1019' });
    dev.log('join', { agent: 'usr_test' });
    live.log('join', { agent: 'usr_real' });
    await Promise.all([dev.close(), live.close()]);
    assert.equal(read(path.join(TMP, 'dev.jsonl'))[0].agent, 'usr_test');
    assert.equal(read(path.join(TMP, 'live-1019.jsonl'))[0].agent, 'usr_real');
  });

  test('同一場次重開是接著寫，不覆蓋前半場', async () => {
    const first = new EventLog({ dir: TMP, session: 'live-1019' });
    first.log('session_start');
    await first.close();
    const second = new EventLog({ dir: TMP, session: 'live-1019' });
    second.log('session_start');
    await second.close();
    assert.equal(read(path.join(TMP, 'live-1019.jsonl')).length, 2);
  });

  test('關閉後再記不會拋錯，也不會寫入', async () => {
    const log = new EventLog({ dir: TMP, session: 'dev' });
    log.log('a');
    await log.close();
    assert.doesNotThrow(() => log.log('b'));
    assert.equal(read(path.join(TMP, 'dev.jsonl')).length, 1);
  });

  test('停用時不建立任何檔案', async () => {
    const log = new EventLog({ dir: TMP, session: 'dev', enabled: false });
    log.log('join', { agent: 'usr_a' });
    log.logSync('session_end');
    await log.close();
    assert.equal(fs.existsSync(TMP), false);
  });

  test('寫不進去時只停用、不拋錯（紀錄不能讓現場的伺服器當掉）', async () => {
    // 目錄位置被一個檔案佔住，mkdir 一定失敗
    fs.mkdirSync(path.dirname(TMP), { recursive: true });
    fs.writeFileSync(TMP, 'not a directory');
    const warn = console.warn;
    console.warn = () => {};
    try {
      const log = new EventLog({ dir: TMP, session: 'dev' });
      assert.doesNotThrow(() => log.log('join'));
      assert.equal(log.failed, true);
      await log.close();
    } finally {
      console.warn = warn;
      fs.rmSync(TMP, { force: true });
    }
  });

  test('logSync 給崩潰路徑用：不等事件迴圈也已經落地', async () => {
    const log = new EventLog({ dir: TMP, session: 'dev' });
    log.logSync('session_end', { reason: 'crash' });
    const rows = read(path.join(TMP, 'dev.jsonl'));
    assert.equal(rows.at(-1).reason, 'crash');
    await log.close();
  });
});

describe('場次名稱', () => {
  test('沒設定就是 dev', () => {
    assert.equal(sessionName(undefined), 'dev');
    assert.equal(sessionName('   '), 'dev');
  });

  test('只留檔名安全的字元，擋掉路徑穿越', () => {
    assert.equal(sessionName('live-1019'), 'live-1019');
    assert.equal(sessionName('../../etc/passwd'), 'etcpasswd');
    assert.equal(sessionName('彩排 1'), '1');
  });

  test('live 開頭的才算正式場次', () => {
    assert.equal(sessionKind('live-1019'), 'live');
    assert.equal(sessionKind('dev'), 'test');
    assert.equal(sessionKind('rehearsal-1017'), 'test');
  });
});

describe('生成紀錄的對照', () => {
  test('從 CV 貼圖路徑取出生成服務的 requestId', () => {
    const avatar = {
      source: 'CV',
      textures: {
        head: '/assets/gen/9c1e0f2a/head.webp',
        torso: '/assets/gen/9c1e0f2a/torso.webp',
      },
    };
    assert.equal(generationIdOf(avatar), '9c1e0f2a');
  });

  test('捏臉角色沒有生成 id', () => {
    assert.equal(generationIdOf({ head: 'head_curly_02' }), undefined);
    assert.equal(generationIdOf(null), undefined);
  });
});
