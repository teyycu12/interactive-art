/**
 * 今天遇見的人（server/encounters.js）
 *
 * 手機名單與紀念卡讀這本帳。它和社交圖譜分開，是為了讓圖譜維持
 * 「經雙方確認」的嚴格定義 —— 這裡驗的是寬的那一本該有的規則。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Encounters } from '../server/encounters.js';
import { VIA, encounterLabel } from '../shared/encounters.js';
import { SocialGraph } from '../server/socialgraph.js';

const ids = (list) => list.map((p) => p.id);

describe('記帳', () => {
  test('雙方互動兩邊都記', () => {
    const e = new Encounters();
    assert.equal(e.meet('a', 'b', VIA.WAVE, 1), true);
    assert.deepEqual(ids(e.peersOf('a')), ['b']);
    assert.deepEqual(ids(e.peersOf('b')), ['a']);
  });

  test('同一種互動重複發生不算變動，不同種類會累加', () => {
    const e = new Encounters();
    e.meet('a', 'b', VIA.WAVE, 1);
    assert.equal(e.meet('b', 'a', VIA.WAVE, 2), false, '不需要再推送');
    assert.equal(e.meet('a', 'b', VIA.CHEERS, 3), true);
    assert.deepEqual(e.peersOf('a')[0].via, [VIA.CHEERS, VIA.WAVE]);
    assert.equal(e.peersOf('a')[0].at, 1, '第一次遇見的時間不被覆寫');
  });

  test('自己、空 id、不認得的種類都不記', () => {
    const e = new Encounters();
    assert.equal(e.meet('a', 'a', VIA.WAVE), false);
    assert.equal(e.meet('a', '', VIA.WAVE), false);
    assert.equal(e.meet('a', 'b', 'hug'), false);
    assert.deepEqual(e.peersOf('a'), []);
  });

  test('賓果只記在輸碼的那一方', () => {
    const e = new Encounters();
    assert.equal(e.noteOneWay('a', 'b', VIA.BINGO), true);
    assert.deepEqual(ids(e.peersOf('a')), ['b']);
    assert.deepEqual(e.peersOf('b'), [], '被輸碼的人不該多一個陌生名字');
  });

  test('私訊要對方回過才算', () => {
    const e = new Encounters();
    assert.equal(e.wrote('a', 'b', 1), false);
    assert.equal(e.wrote('a', 'b', 2), false, '同一方連傳幾則也不算');
    assert.deepEqual(e.peersOf('a'), []);
    assert.equal(e.wrote('b', 'a', 3), true);
    assert.deepEqual(e.peersOf('a')[0].via, [VIA.MESSAGE]);
    assert.deepEqual(e.peersOf('b')[0].via, [VIA.MESSAGE]);
  });
});

describe('排序', () => {
  test('配對過的 → 雙方動作種類多的 → 只有單方面的；同層先遇到的在前', () => {
    const e = new Encounters();
    e.noteOneWay('me', 'bingo', VIA.BINGO, 1);
    e.meet('me', 'wave1', VIA.WAVE, 2);
    e.meet('me', 'wave2', VIA.WAVE, 3);
    e.meet('me', 'both', VIA.WAVE, 4);
    e.meet('me', 'both', VIA.TOPIC, 5);
    e.meet('me', 'pair', VIA.PAIR, 9);
    assert.deepEqual(ids(e.peersOf('me')), ['pair', 'both', 'wave1', 'wave2', 'bingo']);
  });

  test('賓果找到的人後來又揮了手，就升到雙方那一層', () => {
    const e = new Encounters();
    e.meet('me', 'x', VIA.WAVE, 1);
    e.noteOneWay('me', 'y', VIA.BINGO, 0);
    e.meet('me', 'y', VIA.CHEERS, 2);
    assert.deepEqual(ids(e.peersOf('me')), ['y', 'x'], 'y 有兩種互動，排在 x 前面');
  });
});

describe('隱藏與離場', () => {
  test('hidden 濾掉的人不出現（例如封鎖），帳本身不動', () => {
    const e = new Encounters();
    e.meet('a', 'b', VIA.PAIR);
    e.meet('a', 'c', VIA.WAVE);
    assert.deepEqual(ids(e.peersOf('a', { hidden: (id) => id === 'b' })), ['c']);
    assert.deepEqual(ids(e.peersOf('a')), ['b', 'c'], '解除封鎖後會自己回來');
  });

  test('離場丟掉自己的名單與未回的私訊，別人名單上的他保留', () => {
    const e = new Encounters();
    e.meet('a', 'b', VIA.WAVE);
    e.wrote('a', 'c');
    e.forget('a');
    assert.deepEqual(e.peersOf('a'), []);
    assert.deepEqual(ids(e.peersOf('b')), ['a'], '先走的人仍是今天遇見過的人');
    assert.equal(e.wrote('c', 'a'), false, 'a 的未回私訊已清掉');
  });
});

describe('快照', () => {
  test('匯出再還原，名單與順序不變', () => {
    const e = new Encounters();
    e.meet('a', 'b', VIA.PAIR, 1);
    e.meet('a', 'c', VIA.WAVE, 2);
    e.noteOneWay('a', 'd', VIA.BINGO, 3);
    const back = new Encounters().hydrate(JSON.parse(JSON.stringify(e.export())));
    assert.deepEqual(back.peersOf('a'), e.peersOf('a'));
    assert.deepEqual(back.peersOf('d'), []);
  });

  test('還原時略過壞掉的資料', () => {
    const e = new Encounters().hydrate([null, { id: 'a' }, { id: 'a', peers: [{ id: 'b', via: ['hug', VIA.WAVE] }, 'x'] }]);
    assert.deepEqual(e.peersOf('a').map((p) => p.via), [[VIA.WAVE]]);
  });

  test('舊快照沒有這本帳時，從社交圖譜補回配對過的人', () => {
    const g = new SocialGraph();
    g.connect('a', 'b');
    const e = new Encounters().seedFromGraph(g.export());
    assert.deepEqual(e.peersOf('a').map((p) => p.via), [[VIA.PAIR]]);
    assert.deepEqual(ids(e.peersOf('b')), ['a']);
  });
});

test('顯示文字：照固定順序串起來，不認得的種類略過', () => {
  assert.equal(encounterLabel([VIA.PAIR, VIA.CHEERS]), '配對認識・一起乾杯');
  assert.equal(encounterLabel(['hug', VIA.WAVE]), '互相揮手');
  assert.equal(encounterLabel(undefined), '');
});
