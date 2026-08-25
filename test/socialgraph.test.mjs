/**
 * 社交圖譜與其廣播契約
 *
 * 圖譜本身是這件作品最有價值的產物（每條邊都代表現場實際發生過的一次
 * 交談），但它長期只存在於伺服器記憶體裡 —— 大螢幕一條線都沒畫。
 * 這裡驗的是「送到前端的那份資料」的形狀，因為兩端對不上時
 * 畫面只會少幾條線，不會有任何錯誤訊息。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SocialGraph } from '../server/socialgraph.js';

/** server/index.js 的 graphEdges()，抽出來驗證形狀 */
const graphEdges = (graph) =>
  graph.export().edges.map((e) => ({ a: e.a, b: e.b, at: e.at }));

describe('社交圖譜：邊的建立', () => {
  test('配對成功建立一條邊', () => {
    const g = new SocialGraph();
    assert.equal(g.connect('usr_a', 'usr_b'), true);
    assert.equal(g.size, 1);
  });

  test('同一組人再配對不會重複計數', () => {
    const g = new SocialGraph();
    g.connect('usr_a', 'usr_b');
    assert.equal(g.connect('usr_a', 'usr_b'), false, '重複配對應回傳 false');
    assert.equal(g.connect('usr_b', 'usr_a'), false, '方向相反仍是同一條邊');
    assert.equal(g.size, 1);
  });

  test('不能跟自己配對', () => {
    const g = new SocialGraph();
    assert.equal(g.connect('usr_a', 'usr_a'), false);
    assert.equal(g.size, 0);
  });
});

describe('社交圖譜：廣播給大螢幕的資料', () => {
  test('只帶 id 與時間，不夾帶姓名', () => {
    const g = new SocialGraph();
    g.connect('usr_a', 'usr_b');
    const [edge] = graphEdges(g);
    assert.deepEqual(Object.keys(edge).sort(), ['a', 'at', 'b']);
    assert.equal(typeof edge.at, 'number', '前端要靠 at 判斷邊有多新');
  });

  test('多條邊都會送出', () => {
    const g = new SocialGraph();
    g.connect('usr_a', 'usr_b');
    g.connect('usr_b', 'usr_c');
    g.connect('usr_a', 'usr_c');
    assert.equal(graphEdges(g).length, 3);
  });

  test('空圖送出空陣列而不是 undefined', () => {
    assert.deepEqual(graphEdges(new SocialGraph()), []);
  });
});

describe('社交圖譜：個人的鄰居', () => {
  test('雙方都記得對方', () => {
    const g = new SocialGraph();
    g.connect('usr_a', 'usr_b');
    assert.deepEqual([...g.neighbors('usr_a')], ['usr_b']);
    assert.deepEqual([...g.neighbors('usr_b')], ['usr_a']);
  });

  test('degree 反映認識的人數', () => {
    const g = new SocialGraph();
    g.connect('usr_a', 'usr_b');
    g.connect('usr_a', 'usr_c');
    assert.equal(g.degree('usr_a'), 2);
    assert.equal(g.degree('usr_b'), 1);
  });

  test('沒有連結的人回傳空集合而非 undefined', () => {
    const g = new SocialGraph();
    assert.equal(g.degree('usr_nobody'), 0);
    assert.deepEqual([...g.neighbors('usr_nobody')], []);
  });
});

describe('社交圖譜：重開機後的還原', () => {
  test('邊是既成事實，重開不該讓兩個認識的人變回陌生人', () => {
    const a = new SocialGraph();
    a.connect('usr_a', 'usr_b');
    const restored = new SocialGraph().hydrate(a.export());
    assert.equal(restored.size, 1);
    assert.equal(restored.connected('usr_a', 'usr_b'), true);
    assert.equal(restored.degree('usr_a'), 1, '鄰接表也要一起還原');
  });

  test('還原後仍能正確送給大螢幕', () => {
    const a = new SocialGraph();
    a.connect('usr_a', 'usr_b');
    const edges = graphEdges(new SocialGraph().hydrate(a.export()));
    assert.equal(edges.length, 1);
    assert.equal(typeof edges[0].at, 'number');
  });

  test('壞掉的快照不會讓還原崩潰', () => {
    const g = new SocialGraph().hydrate({
      edges: [null, { a: 'x' }, { a: 'x', b: 'x' }, { a: 1, b: 2 }],
    });
    assert.equal(g.size, 0, '不合法的邊應全部略過');
  });
});
