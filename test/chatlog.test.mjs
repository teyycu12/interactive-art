import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatLog, CHATLOG_LIMITS } from '../public/controller/chatlog.js';

/** 最小的 localStorage 替身 */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    keys: () => [...m.keys()],
  };
}

test('收到與送出的訊息依序記下，重新整理（新的 ChatLog）後還在', () => {
  const s = fakeStorage();
  const log = new ChatLog(s);
  log.setOwner('me');
  log.add('amy', { mine: false, text: '你在哪？', at: 1, id: 'm1', name: '小美' });
  log.add('amy', { mine: true, text: '籃球架旁邊', at: 2 });
  const again = new ChatLog(s);
  again.setOwner('me');
  assert.deepEqual(again.thread('amy').map((m) => [m.mine, m.text]), [[false, '你在哪？'], [true, '籃球架旁邊']]);
  assert.equal(again.nameOf('amy'), '小美');
});

test('聊過的人以最近一次對話排序；同一則訊息只記一次', () => {
  const log = new ChatLog(fakeStorage());
  log.setOwner('me');
  log.add('amy', { mine: false, text: 'a', id: 'x', name: '小美' });
  log.add('ben', { mine: true, text: 'b' });
  log.add('amy', { mine: false, text: 'a', id: 'x' });
  assert.deepEqual(log.peers().map((p) => p.id), ['ben', 'amy'], '重複的那則不算新對話');
  log.add('amy', { mine: true, text: 'c' });
  assert.deepEqual(log.peers().map((p) => p.id), ['amy', 'ben']);
  assert.equal(log.peers()[0].last.text, 'c');
});

test('每個人、總人數都有上限，超過時丟最舊的', () => {
  const log = new ChatLog(fakeStorage());
  log.setOwner('me');
  for (let i = 0; i < CHATLOG_LIMITS.perPeer + 5; i++) log.add('amy', { mine: true, text: `#${i}` });
  assert.equal(log.thread('amy').length, CHATLOG_LIMITS.perPeer);
  assert.equal(log.thread('amy')[0].text, '#5');
  for (let i = 0; i < CHATLOG_LIMITS.peers + 1; i++) log.add(`p${i}`, { mine: true, text: 'hi' });
  assert.equal(log.peers().length, CHATLOG_LIMITS.peers);
  assert.equal(log.thread('amy').length, 0, '最久沒聊的人被擠掉');
});

test('一個角色一份：換角色看不到舊對話，dropOthers 把舊的從手機上清掉', () => {
  const s = fakeStorage();
  const log = new ChatLog(s);
  log.setOwner('old');
  log.add('amy', { mine: true, text: '舊角色的對話' });
  log.setOwner('new');
  assert.equal(log.peers().length, 0);
  log.add('ben', { mine: true, text: 'hi' });
  log.dropOthers();
  assert.deepEqual(s.keys(), ['pf.chats.new']);
});

test('沒有 storage 或存檔壞掉時當成沒有紀錄，不丟錯', () => {
  const log = new ChatLog(null);
  log.setOwner('me');
  log.add('amy', { mine: true, text: 'hi' });
  assert.equal(log.thread('amy').length, 1, '這一場仍記得，只是存不下來');
  const s = fakeStorage();
  s.setItem('pf.chats.me', '{壞掉');
  const broken = new ChatLog(s);
  broken.setOwner('me');
  assert.deepEqual(broken.peers(), []);
});

test('未讀：收到才算、正開著對話時不算、打開或自己回話就歸零，重新整理後還在', () => {
  const s = fakeStorage();
  const log = new ChatLog(s);
  log.setOwner('me');
  log.add('amy', { mine: false, text: '1', id: 'a' });
  log.add('amy', { mine: false, text: '2', id: 'b' });
  log.add('ben', { mine: false, text: '3', id: 'c', read: true });
  assert.equal(log.unreadTotal(), 2);
  assert.equal(log.peers().find((p) => p.id === 'amy').unread, 2);
  const again = new ChatLog(s);
  again.setOwner('me');
  assert.equal(again.unreadTotal(), 2, '重新整理後未讀數還在');
  again.markRead('amy');
  assert.equal(again.unreadTotal(), 0);
  again.add('ben', { mine: false, text: '4', id: 'd' });
  again.add('ben', { mine: true, text: '好' });
  assert.equal(again.unreadTotal(), 0, '自己回話代表看過了');
});
