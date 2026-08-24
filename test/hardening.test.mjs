/**
 * 連線防護與時脈測試
 *
 * 這些測試對應 1.0 版實測發現的四個問題，用來防止日後回歸：
 *   1. reattach 可冒用他人身分
 *   2. 入站訊息無速率限制
 *   3. 重複 CLIENT_JOIN 造成永久幽靈角色洩漏
 *   4. setInterval 使有效時脈只有 27.3 Hz
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Stage } from '../server/state.js';
import { RateLimiter } from '../server/ratelimit.js';
import { startTicker } from '../server/scheduler.js';
import { MAX_AGENTS, RATE_LIMIT } from '../server/config.js';

const AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};
const add = (stage, name = 'U') => stage.addAgent({ name, avatar: AVATAR });

describe('重連憑證', () => {
  test('憑證正確時可接回原角色', () => {
    const stage = new Stage();
    const agent = add(stage, '本人');
    stage.markDisconnected(agent.id);
    const back = stage.reattach(agent.id, agent.rejoinToken);
    assert.equal(back?.id, agent.id);
    assert.equal(back.disconnectedAt, null);
    assert.equal(back.offline, false);
  });

  test('憑證錯誤時拒絕接回（阻擋身分冒用）', () => {
    const stage = new Stage();
    const victim = add(stage, '受害者');
    stage.markDisconnected(victim.id);

    assert.equal(stage.reattach(victim.id, 'f'.repeat(32)), null, '偽造憑證不應通過');
    assert.equal(stage.reattach(victim.id, undefined), null, '缺少憑證不應通過');
    assert.equal(stage.reattach(victim.id, ''), null, '空字串不應通過');
    assert.equal(stage.get(victim.id).name, '受害者', '角色不應被改名');
    assert.equal(stage.get(victim.id).disconnectedAt !== null, true, '角色應仍處於斷線狀態');
  });

  test('不存在的角色與憑證錯誤回傳相同結果，無法用於探測 userId', () => {
    const stage = new Stage();
    const agent = add(stage);
    stage.markDisconnected(agent.id);
    assert.equal(stage.reattach('usr_deadbeef', 'x'.repeat(32)), null);
    assert.equal(stage.reattach(agent.id, 'x'.repeat(32)), null);
  });

  test('每個角色的憑證互不相同且長度足夠', () => {
    const stage = new Stage();
    const tokens = new Set();
    for (let i = 0; i < 50; i++) tokens.add(add(stage).rejoinToken);
    assert.equal(tokens.size, 50, '憑證不應重複');
    for (const t of tokens) assert.equal(t.length, 32, '應為 16 bytes 的 hex');
  });

  test('憑證不會外洩到任何廣播訊息', () => {
    const stage = new Stage();
    const agent = add(stage);
    const rosterJson = JSON.stringify(stage.roster());
    const syncJson = JSON.stringify(stage.snapshot());
    assert.ok(!rosterJson.includes(agent.rejoinToken), 'STAGE_ROSTER 洩漏了重連憑證');
    assert.ok(!syncJson.includes(agent.rejoinToken), 'STAGE_SYNC 洩漏了重連憑證');
    assert.ok(!rosterJson.includes('rejoinToken'));
    assert.ok(!syncJson.includes('rejoinToken'));
  });
});

describe('場域人數上限', () => {
  test('達到上限後拒絕建立新角色', () => {
    const stage = new Stage();
    for (let i = 0; i < MAX_AGENTS; i++) assert.ok(add(stage) !== null);
    assert.equal(stage.isFull(), true);
    assert.equal(add(stage), null, '超出上限應回傳 null 而非繼續建立');
    assert.equal(stage.agents.size, MAX_AGENTS);
  });

  test('移除角色後可再次加入', () => {
    const stage = new Stage();
    const first = add(stage);
    for (let i = 1; i < MAX_AGENTS; i++) add(stage);
    assert.equal(add(stage), null);
    stage.removeAgent(first.id);
    assert.ok(add(stage) !== null, '釋出名額後應可再加入');
  });
});

describe('入站速率限制', () => {
  const T0 = 1_000_000; // 合成時鐘起點，須與建構時的基準一致

  test('協定規格內的流量完全不受影響', () => {
    const limiter = new RateLimiter(RATE_LIMIT, T0);
    let now = T0;
    // 以 20 Hz 持續送 30 秒
    for (let i = 0; i < 600; i++) {
      now += 50;
      assert.equal(limiter.check(now), 'ok', `第 ${i} 則在規格內卻被擋下`);
    }
  });

  test('允許手機自背景喚醒時的突發', () => {
    const limiter = new RateLimiter(RATE_LIMIT, T0);
    // 靜默 3 秒後一次湧入整桶容量
    const now = T0 + 3000;
    for (let i = 0; i < RATE_LIMIT.capacity; i++) {
      assert.equal(limiter.check(now), 'ok', `突發第 ${i} 則不應被擋`);
    }
  });

  test('持續洪水攻擊會被判定為濫用', () => {
    const limiter = new RateLimiter(RATE_LIMIT, T0);
    let verdict = 'ok';
    let i = 0;
    // 同一毫秒內連續灌入，模擬實測到的每秒約 28,600 則
    for (; i < 5000; i++) {
      verdict = limiter.check(T0);
      if (verdict === 'abuse') break;
    }
    assert.equal(verdict, 'abuse', '持續洪水應被判定為濫用');
    assert.ok(i < 1000, `應在 1000 則內判定，實際 ${i} 則`);
  });

  test('偶發突發不會在稍後才誤判為濫用', () => {
    const limiter = new RateLimiter(RATE_LIMIT, T0);
    let now = T0;
    // 一次短暫超量
    for (let i = 0; i < 200; i++) limiter.check(now);
    assert.ok(limiter.violations > 0);
    // 之後恢復正常速率
    for (let i = 0; i < 100; i++) {
      now += 50;
      assert.notEqual(limiter.check(now), 'abuse', '恢復正常後不應被斷線');
    }
    assert.equal(limiter.violations, 0, '違規計數應隨時間衰減歸零');
  });

  test('時鐘倒退不會使水桶永久停擺', () => {
    const limiter = new RateLimiter(RATE_LIMIT, T0);
    // 先耗盡水桶
    for (let i = 0; i < RATE_LIMIT.capacity; i++) limiter.check(T0);
    assert.equal(limiter.check(T0), 'drop');
    // 時間倒退（模擬時鐘域錯置或系統校時）
    assert.equal(limiter.check(T0 - 5000), 'drop');
    // 恢復正常推進後，水桶必須能重新補水
    assert.equal(limiter.check(T0 - 5000 + 1000), 'ok', '時間倒退後水桶應能回補');
  });
});

describe('模擬時脈', () => {
  test('實際頻率達到 30 Hz（±1 Hz）', async () => {
    let ticks = 0;
    const t0 = Date.now();
    const ticker = startTicker({ intervalMs: 1000 / 30, onTick: () => { ticks++; } });
    await new Promise((r) => setTimeout(r, 3000));
    ticker.stop();

    const hz = ticks / ((Date.now() - t0) / 1000);
    assert.ok(hz > 29 && hz < 31,
      `目標 30 Hz，實際 ${hz.toFixed(1)} Hz（setInterval 實作約為 27.3 Hz）`);
  });

  test('dt 有上限，行程停頓後不會造成瞬移', async () => {
    const dts = [];
    const ticker = startTicker({
      intervalMs: 1000 / 30,
      maxDt: 0.1,
      onTick: (dt) => { dts.push(dt); },
    });
    // 同步阻塞事件迴圈 400ms，模擬行程被搶占
    const until = Date.now() + 400;
    while (Date.now() < until) { /* 蓄意阻塞 */ }
    await new Promise((r) => setTimeout(r, 300));
    ticker.stop();

    assert.ok(dts.length > 0);
    assert.ok(Math.max(...dts) <= 0.1 + 1e-9,
      `dt 應被夾限在 0.1 秒內，實際最大 ${Math.max(...dts)}`);
  });

  test('stop() 之後不再觸發', async () => {
    let ticks = 0;
    const ticker = startTicker({ intervalMs: 1000 / 30, onTick: () => { ticks++; } });
    await new Promise((r) => setTimeout(r, 200));
    ticker.stop();
    const frozen = ticks;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ticks, frozen, 'stop() 後仍有 tick 觸發');
  });
});
