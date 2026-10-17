import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeStorage(init) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    dump: () => Object.fromEntries(m),
  };
}

test('改名前存的 personaflow.* 搬到 pixelair.*，新鍵已存在時不覆蓋', async () => {
  globalThis.localStorage = fakeStorage({
    'personaflow.userId': 'u1', 'personaflow.quizBank': '[1]', 'pixelair.feed': 'new',
    'personaflow.feed': 'old', 'pf.chats.u1': 'keep',
  });
  globalThis.sessionStorage = fakeStorage({ 'personaflow.hostKey': 'ABC123' });
  await import('../shared/legacyStorage.js');
  assert.deepEqual(localStorage.dump(), {
    'pixelair.feed': 'new', 'pf.chats.u1': 'keep', 'pixelair.userId': 'u1', 'pixelair.quizBank': '[1]',
  });
  assert.deepEqual(sessionStorage.dump(), { 'pixelair.hostKey': 'ABC123' });
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});
