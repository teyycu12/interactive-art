/**
 * 生成排隊（server/generateQueue.js）
 *
 * 原本超過並發上限就立刻回 too_busy，30 人同時按拍照時 26 個人要靠狂按重拍
 * 去搶位子。這裡守住排隊的幾個關鍵性質：先來先到、名額只還一次、
 * 排隊中斷線要讓位、run 出錯不能卡住後面的人。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { GenerateQueue, isValidTicket } from '../server/generateQueue.js';

const T = (n) => n.toString(16).padStart(16, '0');

/** 回傳一個 run，並把它的 done 收進 dones，讓測試決定何時結束 */
function recorder() {
  const started = [];
  const dones = new Map();
  const run = (ticket) => (done) => { started.push(ticket); dones.set(ticket, done); };
  return { started, dones, run };
}

describe('排隊', () => {
  test('有空位就立刻開始，滿了就排隊，前面做完依先後放行', () => {
    const q = new GenerateQueue({ maxActive: 2, maxQueued: 10 });
    const r = recorder();
    for (let i = 1; i <= 5; i++) q.enqueue(T(i), r.run(T(i)));

    assert.deepEqual(r.started, [T(1), T(2)]);
    assert.deepEqual(q.size, { active: 2, waiting: 3 });

    r.dones.get(T(2))();
    assert.deepEqual(r.started, [T(1), T(2), T(3)], '先來先到：放行的是第 3 個，不是隨機一個');
    r.dones.get(T(1))();
    assert.deepEqual(r.started, [T(1), T(2), T(3), T(4)]);
  });

  test('隊伍滿了才回 full', () => {
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 2 });
    const r = recorder();
    assert.equal(q.enqueue(T(1), r.run(T(1))), 'started');
    assert.equal(q.enqueue(T(2), r.run(T(2))), 'queued');
    assert.equal(q.enqueue(T(3), r.run(T(3))), 'queued');
    assert.equal(q.enqueue(T(4), r.run(T(4))), 'full');
  });

  test('同一張號碼牌不能排兩次', () => {
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 5 });
    const r = recorder();
    q.enqueue(T(1), r.run(T(1)));
    q.enqueue(T(2), r.run(T(2)));
    assert.equal(q.enqueue(T(1), r.run(T(1))), 'duplicate');
    assert.equal(q.enqueue(T(2), r.run(T(2))), 'duplicate');
  });

  test('done 重複呼叫只還一次名額', () => {
    // 成功、逾時、連線錯誤可能先後各觸發一次。多還的話實際並發會超過上限，
    // 多出來的在 Python 的信號量上隱形排隊。
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 5 });
    const r = recorder();
    for (let i = 1; i <= 3; i++) q.enqueue(T(i), r.run(T(i)));
    const done = r.dones.get(T(1));
    done();
    done();
    assert.deepEqual(r.started, [T(1), T(2)], '只能放行一個人');
    assert.equal(q.size.active, 1);
  });

  test('排隊中取消會讓位，後面的人往前', () => {
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 5 });
    const r = recorder();
    for (let i = 1; i <= 3; i++) q.enqueue(T(i), r.run(T(i)));

    assert.equal(q.cancel(T(2)), true);
    assert.equal(q.status(T(3)).ahead, 0);
    r.dones.get(T(1))();
    assert.deepEqual(r.started, [T(1), T(3)], '取消的人不能被放行（那會白花一次生圖錢）');
  });

  test('取消正在生成的人不影響名額（錢已經付了，讓它做完）', () => {
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 5 });
    const r = recorder();
    q.enqueue(T(1), r.run(T(1)));
    q.enqueue(T(2), r.run(T(2)));
    assert.equal(q.cancel(T(1)), false);
    assert.deepEqual(r.started, [T(1)]);
  });

  test('run 拋例外時還回名額，後面的人照常放行', () => {
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 5 });
    const r = recorder();
    const origError = console.error;
    console.error = () => {};
    try {
      q.enqueue(T(1), r.run(T(1)));
      q.enqueue(T(2), () => { throw new Error('boom'); });
      q.enqueue(T(3), r.run(T(3)));
      r.dones.get(T(1))();
    } finally {
      console.error = origError;
    }
    assert.deepEqual(r.started, [T(1), T(3)]);
  });
});

describe('狀態查詢', () => {
  test('回報排第幾與預估等待', () => {
    const q = new GenerateQueue({ maxActive: 2, maxQueued: 10, typicalMs: 30_000 });
    const r = recorder();
    for (let i = 1; i <= 6; i++) q.enqueue(T(i), r.run(T(i)));

    assert.deepEqual(q.status(T(1)), { state: 'active' });
    assert.equal(q.status(T(3)).ahead, 0);
    assert.equal(q.status(T(6)).ahead, 3);
    // 每輪放行 2 人；正在跑的那一輪只算半輪
    assert.equal(q.status(T(3)).etaMs, 15_000);
    assert.equal(q.status(T(5)).etaMs, 45_000);
  });

  test('做完或沒見過的號碼牌回 null', () => {
    const q = new GenerateQueue({ maxActive: 1, maxQueued: 5 });
    const r = recorder();
    q.enqueue(T(1), r.run(T(1)));
    r.dones.get(T(1))();
    assert.equal(q.status(T(1)), null);
    assert.equal(q.status(T(99)), null);
  });
});

describe('號碼牌格式', () => {
  test('只收 16–64 位小寫十六進位', () => {
    assert.equal(isValidTicket('0123456789abcdef'), true);
    assert.equal(isValidTicket('a'.repeat(64)), true);
    assert.equal(isValidTicket('a'.repeat(15)), false);
    assert.equal(isValidTicket('a'.repeat(65)), false);
    assert.equal(isValidTicket('0123456789ABCDEF'), false);
    assert.equal(isValidTicket(undefined), false);
    assert.equal(isValidTicket(['0123456789abcdef']), false, '重複的標頭在 Node 會變成陣列');
  });
});

describe('限流用的來源位址', async () => {
  const { clientIp } = await import('../server/clientIp.js');
  const req = (remoteAddress, xff) => ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });

  test('經本機代理（ngrok）時採用轉發標頭，否則全場共用一個限流額度', () => {
    assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
    assert.equal(clientIp(req('::1', '203.0.113.7, 10.0.0.1')), '203.0.113.7');
    assert.equal(clientIp(req('::ffff:127.0.0.1', '203.0.113.8')), '203.0.113.8');
  });

  test('區網直連時不採信標頭，否則手機自己塞一個就能繞過限流', () => {
    assert.equal(clientIp(req('192.168.1.23', '203.0.113.7')), '192.168.1.23');
  });

  test('本機但沒有標頭時退回連線位址', () => {
    assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
    assert.equal(clientIp(req('127.0.0.1', '')), '127.0.0.1');
  });
});
