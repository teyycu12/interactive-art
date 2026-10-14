import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageRelay, cleanText } from '../server/messages.js';
import { MSG_ERRORS, DIRECT_MESSAGE } from '../shared/protocol.js';

const everyone = { exists: () => true, online: () => true };
const T0 = 1_000_000;

test('正常送出：回傳訊息內容與 id', () => {
  const r = new MessageRelay();
  const res = r.send('a', 'b', '  我在籃球架旁邊  ', everyone, T0);
  assert.equal(res.ok, true);
  assert.equal(res.delivered, true);
  assert.equal(res.message.text, '我在籃球架旁邊');
  assert.match(res.message.id, /^[0-9a-f]{16}$/);
});

test('控制字元、換行與零寬字元被剝除（訊息會畫進對方手機）', () => {
  assert.equal(cleanText('嗨\n\r\t你好​ '), '嗨你好');
  assert.equal(cleanText(42), '');
});

test('空白、超長、傳給自己都被拒絕', () => {
  const r = new MessageRelay();
  assert.equal(r.send('a', 'b', '   ', everyone, T0).reason, MSG_ERRORS.EMPTY);
  assert.equal(r.send('a', 'b', '字'.repeat(DIRECT_MESSAGE.maxLength + 1), everyone, T0).reason, MSG_ERRORS.TOO_LONG);
  assert.equal(r.send('a', 'a', '嗨', everyone, T0).reason, MSG_ERRORS.SELF);
});

test('字數以字元計：emoji 與中文都算一個字', () => {
  const r = new MessageRelay();
  assert.equal(r.send('a', 'b', '😀'.repeat(DIRECT_MESSAGE.maxLength), everyone, T0).ok, true);
});

test('對方不在場或手機沒連線時告知寄件人', () => {
  const r = new MessageRelay();
  assert.equal(r.send('a', 'ghost', '嗨', { exists: () => false, online: () => false }, T0).reason, MSG_ERRORS.NOT_FOUND);
  assert.equal(r.send('a', 'b', '嗨', { exists: () => true, online: () => false }, T0).reason, MSG_ERRORS.OFFLINE);
  assert.equal(r.send('a', 'b', { evil: true }, everyone, T0).reason, MSG_ERRORS.EMPTY);
});

test('頻率限制：兩則間隔太短、或一分鐘超過上限都被擋', () => {
  const r = new MessageRelay({ minIntervalMs: 2000, perMinute: 3 });
  assert.equal(r.send('a', 'b', '1', everyone, T0).ok, true);
  assert.equal(r.send('a', 'b', '2', everyone, T0 + 500).reason, MSG_ERRORS.RATE_LIMITED);
  assert.equal(r.send('a', 'b', '2', everyone, T0 + 2000).ok, true);
  assert.equal(r.send('a', 'c', '3', everyone, T0 + 4000).ok, true);
  assert.equal(r.send('a', 'c', '4', everyone, T0 + 6000).reason, MSG_ERRORS.RATE_LIMITED);
  assert.equal(r.send('a', 'c', '4', everyone, T0 + 61000).ok, true, '一分鐘後額度恢復');
});

test('被拒的訊息不吃頻率額度（打錯字不該被懲罰）', () => {
  const r = new MessageRelay({ minIntervalMs: 2000, perMinute: 10 });
  r.send('a', 'b', '', everyone, T0);
  assert.equal(r.send('a', 'b', '嗨', everyone, T0 + 10).ok, true);
});

test('封鎖：之後的訊息靜默丟棄，寄件人看到的仍是送出成功', () => {
  const r = new MessageRelay({ minIntervalMs: 0 });
  assert.equal(r.block('b', 'a'), true);
  assert.equal(r.block('b', 'a'), false, '重複封鎖不算新增');
  assert.equal(r.block('b', 'b'), false, '不能封鎖自己');
  const res = r.send('a', 'b', '還在嗎', everyone, T0);
  assert.deepEqual([res.ok, res.delivered, res.message], [true, false, undefined]);
  assert.equal(r.send('c', 'b', '嗨', everyone, T0).delivered, true, '只擋被封鎖的那個人');
});

test('封鎖的人自己也不能傳給對方，要先解除封鎖', () => {
  const r = new MessageRelay({ minIntervalMs: 0 });
  r.block('b', 'a');
  assert.equal(r.send('b', 'a', '嗨', everyone, T0).reason, MSG_ERRORS.BLOCKED);
  assert.deepEqual(r.blockedBy('b'), ['a']);
  assert.equal(r.unblock('b', 'a'), true);
  assert.equal(r.unblock('b', 'a'), false, '重複解除不算');
  assert.deepEqual(r.blockedBy('b'), []);
  assert.equal(r.send('b', 'a', '嗨', everyone, T0).delivered, true, '解除後可以傳');
  assert.equal(r.send('a', 'b', '在嗎', everyone, T0).delivered, true, '解除後也重新收得到對方的訊息');
});

test('被拒的 BLOCKED 不吃頻率額度', () => {
  const r = new MessageRelay({ minIntervalMs: 2000 });
  r.block('b', 'a');
  r.send('b', 'a', '嗨', everyone, T0);
  r.unblock('b', 'a');
  assert.equal(r.send('b', 'a', '嗨', everyone, T0 + 10).ok, true);
});

test('檢舉：只有收件人能檢舉，主辦端拿到原文，重複檢舉不重複列', () => {
  const r = new MessageRelay();
  const { message } = r.send('a', 'b', '不禮貌的話', everyone, T0);
  assert.equal(r.report('c', message.id, T0), null, '旁人不能拿 id 翻別人的私訊');
  assert.equal(r.report('a', message.id, T0), null, '寄件人不能檢舉自己的訊息');
  const entry = r.report('b', message.id, T0 + 5);
  assert.deepEqual(entry, { messageId: message.id, from: 'a', to: 'b', text: '不禮貌的話', at: T0, reportedAt: T0 + 5 });
  assert.equal(r.report('b', message.id, T0 + 6), null);
  assert.equal(r.reports.length, 1);
  assert.equal(r.report('b', 'not-an-id'), null);
  assert.equal(r.dismissReport(message.id), true);
  assert.equal(r.reports.length, 0);
});

test('舊訊息過期後不能再檢舉，保留則數有上限', () => {
  const r = new MessageRelay({ minIntervalMs: 0, perMinute: 1000, keepForReportMs: 1000, keepMax: 3 });
  const first = r.send('a', 'b', '1', everyone, T0).message;
  r.send('a', 'b', '2', everyone, T0 + 2000);
  assert.equal(r.report('b', first.id), null, '過期');
  for (let i = 0; i < 5; i++) r.send('a', 'b', String(i), everyone, T0 + 2000 + i);
  assert.ok(r.recent.size <= 3);
});
