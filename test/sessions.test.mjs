import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventCatalog, isEventId, sessionsDirFor } from '../server/sessions.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pixelair-sessions-'));

describe('活動目錄（server/sessions.js）', () => {
  test('舊的單一快照第一次啟動時轉成第一場活動，原檔保留', () => {
    const dir = tmp();
    const legacy = path.join(dir, 'state.json');
    fs.writeFileSync(legacy, JSON.stringify({ savedAt: 1792000000000, event: { name: '迎新' }, theme: 'office', directory: [{ id: 'u1' }] }));
    const c = new EventCatalog({ dir: sessionsDirFor(legacy), legacyFile: legacy });
    const id = c.init();
    assert.ok(isEventId(id));
    assert.equal(c.load(id).event.name, '迎新');
    assert.ok(fs.existsSync(legacy), '原檔不刪');
    const [row] = c.list();
    assert.deepEqual([row.id, row.name, row.theme, row.people], [id, '迎新', 'office', 1]);
    // 第二次啟動：照 active.json 接回同一場，不會再轉一次
    const again = new EventCatalog({ dir: sessionsDirFor(legacy), legacyFile: legacy });
    assert.equal(again.init(), id);
    assert.equal(again.list().length, 1);
  });

  test('什麼都沒有時建一場未命名的活動（主辦端照舊先進活動設定）', () => {
    const dir = tmp();
    const c = new EventCatalog({ dir: path.join(dir, 'sessions'), legacyFile: path.join(dir, 'state.json') });
    const id = c.init();
    assert.equal(c.load(id).event, null);
    assert.equal(c.list().length, 1);
  });

  test('建立、存檔、切換目前的活動、刪除；開啟中的那場不能刪', () => {
    const dir = tmp();
    const c = new EventCatalog({ dir: path.join(dir, 'sessions') });
    const a = c.init();
    const b = c.create({ event: { name: '第二場' }, theme: 'kitchen' });
    assert.notEqual(a, b);
    assert.equal(c.list().length, 2);
    c.save(a, { ...c.load(a), savedAt: Date.now() + 1000, scores: { totals: {} } });
    assert.equal(c.list()[0].id, a, '最近存過的在前');
    c.setActive(b);
    assert.equal(new EventCatalog({ dir: path.join(dir, 'sessions') }).init(), b, '重開後接回最後開啟的那場');
    assert.equal(c.remove(b), false, '開啟中的不能刪');
    c.setActive(a);
    assert.equal(c.remove(b), true);
    assert.deepEqual(c.list().map((e) => e.id), [a]);
  });

  test('不合法的 id 不碰檔案系統（不能讓主辦端送來的字串決定讀寫哪個檔）', () => {
    const c = new EventCatalog({ dir: path.join(tmp(), 'sessions') });
    c.init();
    for (const bad of ['../state', 'evt-..-..', '', null, 'evt-20261029-1200-zzzz', 'active']) {
      assert.equal(isEventId(bad), false, String(bad));
      assert.equal(c.load(bad), null);
      assert.equal(c.has(bad), false);
      assert.equal(c.remove(bad), false);
    }
    assert.throws(() => c.fileOf('../x'));
  });

  test('關閉存檔時（測試用）一樣能建立與切換，快照放在記憶體', () => {
    const dir = tmp();
    const c = new EventCatalog({ dir: path.join(dir, 'sessions'), enabled: false });
    const a = c.init();
    const b = c.create({ event: { name: 'B' }, theme: 'gym' });
    c.save(a, { event: { name: 'A' }, savedAt: 1 });
    assert.equal(c.load(b).event.name, 'B');
    assert.deepEqual(c.list().map((e) => e.name).sort(), ['A', 'B']);
    assert.equal(fs.existsSync(path.join(dir, 'sessions')), false, '不寫硬碟');
  });

  test('活動資料夾放在快照檔旁邊', () => {
    assert.equal(sessionsDirFor(path.join('d', 'state.json')), path.join('d', 'sessions'));
    assert.equal(sessionsDirFor(path.join('t', 'e2e.json')), path.join('t', 'e2e.sessions'));
  });
});
