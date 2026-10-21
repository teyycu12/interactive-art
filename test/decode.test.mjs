import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecodeRound, ROLE } from '../server/decode.js';
import { DECODE, DEFAULT_DECODE_SYMBOLS, decodeSymbolsFor } from '../shared/decode.js';
import { THEMES } from '../shared/themes.js';
import { MISSION_TYPES } from '../shared/protocol.js';
import { buildRule, feasibility } from '../server/missionRules.js';
import { MissionBoard } from '../server/missions.js';

const people = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const round = (opts = {}) => new DecodeRound({ codeLength: 4, symbols: DEFAULT_DECODE_SYMBOLS, ...opts });

/** 從兩支手機各自看到的那一半拼出答案 —— 也就是現場兩個人講話在做的事 */
function solveFromViews(r, ids) {
  const views = ids.map((id) => r.viewFor(id));
  const symbols = views.find((v) => v.role === ROLE.SYMBOLS).symbols;
  const book = views.filter((v) => v.role === ROLE.BOOK).flatMap((v) => v.book);
  return symbols.map((s) => book.find((b) => b.glyph === s.glyph).digit).join('');
}

test('偶數人兩兩分組，每組一人拿符號、其他人拿密碼本', () => {
  const r = round();
  r.sync(people(4), 0);
  assert.equal(r.groups.size, 2);
  for (const g of r.groups.values()) {
    assert.equal(g.members.length, 2);
    const roles = g.members.map((id) => r.viewFor(id).role).sort();
    assert.deepEqual(roles, [ROLE.BOOK, ROLE.SYMBOLS]);
  }
});

test('奇數人有一組三人，密碼本拆兩半、題目兩半都用到', () => {
  for (let k = 0; k < 30; k++) {
    const r = round();
    r.sync(people(5), 0);
    const trio = [...r.groups.values()].find((g) => g.members.length === 3);
    assert.ok(trio, '要有一組三人');
    const books = trio.members.map((id) => r.viewFor(id)).filter((v) => v.role === ROLE.BOOK);
    assert.equal(books.length, 2);
    assert.equal(books[0].book.length + books[1].book.length, DECODE.bookSize);
    const glyphs = r.viewFor(trio.holder).symbols.map((s) => s.glyph);
    for (const b of books) assert.ok(glyphs.some((gl) => b.book.some((x) => x.glyph === gl)), '每一半都要用得到');
  }
});

test('手機看到的只有自己那一半，任何人都拿不到答案', () => {
  const r = round();
  r.sync(people(2), 0);
  const g = [...r.groups.values()][0];
  for (const id of g.members) {
    const v = r.viewFor(id);
    const raw = JSON.stringify(v);
    assert.ok(!('code' in v));
    // 拿符號的沒有密碼本，拿密碼本的沒有題目
    if (v.role === ROLE.SYMBOLS) assert.ok(!v.book);
    else assert.ok(!v.symbols);
    assert.ok(!raw.includes(`"${g.code}"`));
  }
  assert.ok(!JSON.stringify(r.publicView()).includes(g.code));
  assert.ok(!JSON.stringify(r.publicView()).includes('glyph'));
});

test('密碼本的數字不重複，符號比密碼用到的多', () => {
  const r = round();
  r.sync(people(2), 0);
  const g = [...r.groups.values()][0];
  const book = r.viewFor(g.members.find((id) => id !== g.holder)).book;
  assert.equal(book.length, DECODE.bookSize);
  assert.equal(new Set(book.map((b) => b.digit)).size, book.length);
  assert.ok(new Set(r.viewFor(g.holder).symbols.map((s) => s.glyph)).size <= 4);
});

test('兩半拼起來就解得開；解開後換搭檔、交換角色', () => {
  const r = round();
  r.sync(people(4), 0);
  const [g1] = r.groups.values();
  const before = g1.holder;
  const res = r.guess(g1.members[0], solveFromViews(r, g1.members), 1000);
  assert.ok(res.ok && res.solved);
  assert.equal(r.solved, 1);
  // 另一組還沒解開，剛解開的兩人不會馬上被湊回一起
  r.sync(people(4), 1100);
  assert.equal(r.viewFor(g1.members[0]).state, 'waiting');
  // 另一組也解開：四個人交叉重配，沒有人跟原搭檔同組
  const [g2] = r.groups.values();
  r.guess(g2.members[0], solveFromViews(r, g2.members), 1200);
  r.sync(people(4), 1300);
  for (const g of r.groups.values()) {
    const key = [...g.members].sort().join();
    assert.notEqual(key, [...g1.members].sort().join());
    assert.notEqual(key, [...g2.members].sort().join());
  }
  // 上一輪拿符號的人，這一輪拿密碼本
  assert.equal(r.viewFor(before).role, ROLE.BOOK);
});

test('只剩剛合作過的兩人時，等一下才讓他們再一組', () => {
  const r = round();
  r.sync(people(2), 0);
  const [g] = r.groups.values();
  r.guess(g.members[0], solveFromViews(r, g.members), 100);
  r.sync(people(2), 200);
  assert.equal(r.groups.size, 0);
  r.sync(people(2), 100 + DECODE.repeatAfterMs);
  assert.equal(r.groups.size, 1);
});

test('輸入錯誤只講對了幾碼；連錯三次要冷卻', () => {
  const r = round();
  r.sync(people(2), 0);
  const [g] = r.groups.values();
  const wrong = g.code.split('').map((d, i) => (i === 0 ? String((Number(d) + 1) % 10) : d)).join('');
  const a = g.members[0];
  const r1 = r.guess(a, wrong, 10);
  assert.equal(r1.solved, false);
  assert.equal(r1.hits, 3);
  r.guess(a, wrong, 20);
  const r3 = r.guess(a, wrong, 30);
  assert.equal(r3.cooldownMs, DECODE.cooldownMs);
  // 冷卻中連正確答案也不收
  assert.equal(r.guess(a, g.code, 40).reason, 'COOLDOWN');
  assert.ok(r.guess(a, g.code, 30 + DECODE.cooldownMs).solved);
});

test('格式不對的輸入不算錯一次', () => {
  const r = round();
  r.sync(people(2), 0);
  const [g] = r.groups.values();
  assert.equal(r.guess(g.members[0], '12', 0).reason, 'BAD_CODE');
  assert.equal(r.guess(g.members[0], 'abcd', 0).reason, 'BAD_CODE');
  assert.equal(g.wrong, 0);
  assert.equal(r.guess('nobody', '1234', 0).reason, 'NO_GROUP');
});

test('搭檔離場：那一組拆掉，留下的人回等待區，有人就重配', () => {
  const r = round();
  r.sync(people(4), 0);
  const [g1] = r.groups.values();
  const leaver = g1.members[0];
  const stayer = g1.members[1];
  r.sync(people(4).filter((p) => p.id !== leaver), 100);
  assert.equal(r.viewFor(stayer).state, 'waiting');
  // 新的人進場就跟他湊一組
  r.sync([...people(4).filter((p) => p.id !== leaver), { id: 'new' }], 200);
  assert.equal(r.viewFor(stayer).state, 'playing');
  assert.deepEqual(r.viewFor(stayer).partners, ['new']);
});

test('斷線不馬上拆組，超過 dropOfflineMs 才拆', () => {
  const r = round();
  r.sync(people(2), 0);
  const off = [{ id: 'p0', offline: true }, { id: 'p1' }];
  r.sync(off, 1000);
  assert.equal(r.groups.size, 1);
  r.sync(off, 1000 + DECODE.dropOfflineMs);
  assert.equal(r.groups.size, 0);
  assert.equal(r.viewFor('p1').state, 'waiting');
});

test('分組優先排今天還不認識的人', () => {
  const met = (a, b) => [a, b].sort().join() === 'p0,p1';
  for (let k = 0; k < 20; k++) {
    const r = round({ met });
    r.sync(people(4), 0);
    for (const g of r.groups.values()) assert.notEqual([...g.members].sort().join(), 'p0,p1');
  }
});

test('每個場景的符號都夠一本密碼本，名字不重複', () => {
  for (const t of THEMES) {
    const list = decodeSymbolsFor(t.id);
    assert.ok(list.length >= DECODE.bookSize, t.id);
    assert.equal(new Set(list.map((s) => s.glyph)).size, list.length, t.id);
    assert.equal(new Set(list.map((s) => s.name)).size, list.length, t.id);
  }
  assert.equal(decodeSymbolsFor('nope'), DEFAULT_DECODE_SYMBOLS);
});

test('主辦端：碼長驗證、可行性、同時只能開一個解碼', () => {
  const opts = { catalog: [], spots: [] };
  assert.equal(buildRule('DECODE', { codeLength: 2 }, opts).ok, false);
  assert.equal(buildRule('DECODE', { codeLength: 7 }, opts).ok, false);
  const ok = buildRule('DECODE', { codeLength: 4 }, opts);
  assert.deepEqual(ok.rule, { type: 'DECODE', codeLength: 4 });
  assert.equal(buildRule('DECODE', {}, opts).rule.codeLength, MISSION_TYPES.DECODE.codeLength.default);

  const f = (n) => feasibility(ok.rule, { target: 2, agents: people(n).map((p) => p.id), ctx: {}, connected: () => false });
  assert.equal(f(1).level, 'block');
  assert.equal(f(4).level, 'ok');
  assert.ok(f(5).notes.some((x) => x.includes('三人')));

  const board = new MissionBoard();
  assert.ok(board.publish({ type: 'DECODE', target: 2, rule: ok.rule }).ok);
  const again = board.publish({ type: 'DECODE', target: 2, rule: buildRule('DECODE', { codeLength: 5 }, opts).rule });
  assert.equal(again.ok, false);
});
