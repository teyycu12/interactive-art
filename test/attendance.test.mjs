import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Attendance } from '../server/attendance.js';

const agent = (id, name = id) => ({ id, name, avatar: { textures: { full: `/assets/gen/${id}/full.webp` } } });

describe('今天來過的人（大合照名單）', () => {
  test('操控過移動或有社交連結才算參與；只進場不動的不算', () => {
    const a = new Attendance();
    a.note(agent('mover'), 1);
    a.note(agent('social'), 2);
    a.note(agent('idle'), 3);
    a.markMoved('mover');
    const ids = a.participants((id) => id === 'social').map((e) => e.id);
    assert.deepEqual(ids, ['mover', 'social']);
  });

  test('依第一次進場的先後；重連不改順序、不丟掉「動過」', () => {
    const a = new Attendance();
    a.note(agent('b'), 10);
    a.note(agent('a'), 20);
    a.markMoved('a'); a.markMoved('b');
    a.note(agent('b', '改名'), 30);
    const list = a.participants();
    assert.deepEqual(list.map((e) => e.id), ['b', 'a']);
    assert.equal(list[0].name, '改名');
    assert.equal(list[0].moved, true);
  });

  test('被請出場或換角色就從名單拿掉', () => {
    const a = new Attendance();
    a.note(agent('x')); a.markMoved('x');
    a.forget('x');
    assert.equal(a.participants().length, 0);
  });

  test('存檔還原後名單還在（伺服器重開不能讓先走的人從合照消失）', () => {
    const a = new Attendance();
    a.note(agent('x'), Date.now()); a.markMoved('x');
    const b = new Attendance().hydrate(JSON.parse(JSON.stringify(a.export())));
    assert.deepEqual(b.participants().map((e) => [e.id, e.moved, e.avatar.textures.full]),
      [['x', true, '/assets/gen/x/full.webp']]);
  });

  test('超過保留時間（預設 12 小時）的人不再出現', () => {
    const a = new Attendance({ ttlMs: 1000 });
    a.note(agent('old'), Date.now() - 5000); a.markMoved('old');
    a.note(agent('new'));
    assert.deepEqual(a.export().map((e) => e.id), ['new']);
  });
});
