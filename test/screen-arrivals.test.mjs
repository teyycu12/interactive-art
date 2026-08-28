/**
 * 大螢幕的「剛進場」標記
 *
 * 驗的是標記何時該建立、何時不該 —— 這段邏輯錯了不會拋任何錯誤，
 * 只會讓箭頭指錯人或整片亂閃，而那在單元測試以外很難察覺。
 *
 * screen.js 是瀏覽器模組（碰 document / WebSocket），無法直接載入，
 * 因此這裡重現它的名冊比對規則。規則本身很短，重點在於把
 * 「首次名冊不算新加入」這條決策釘住。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/** 對應 screen.js 的 STAGE_ROSTER 處理 */
function makeTracker() {
  const roster = new Map();
  const arrivals = new Map();
  let rosterSeenOnce = false;

  return {
    roster,
    arrivals,
    apply(agents, at = 1000) {
      const seen = new Set();
      const firstRoster = !rosterSeenOnce;
      for (const a of agents) {
        seen.add(a.id);
        const prev = roster.get(a.id);
        if (!prev) roster.set(a.id, { ...a });
        if (!prev && !firstRoster) arrivals.set(a.id, at);
      }
      rosterSeenOnce = true;
      for (const id of [...roster.keys()]) {
        if (!seen.has(id)) { roster.delete(id); arrivals.delete(id); }
      }
    },
  };
}

const A = { id: 'usr_a', name: 'A' };
const B = { id: 'usr_b', name: 'B' };
const C = { id: 'usr_c', name: 'C' };

describe('剛進場標記', () => {
  test('首次收到名冊不算新加入', () => {
    const t = makeTracker();
    // 大螢幕中途重開時，場上可能已有十個人 —— 全部一起閃會變成一片光暈
    t.apply([A, B, C]);
    assert.equal(t.arrivals.size, 0,
      '首次名冊就標記了 —— 大螢幕重開時全場角色會同時閃');
    assert.equal(t.roster.size, 3);
  });

  test('之後真的新加入的人才會被標記', () => {
    const t = makeTracker();
    t.apply([A, B]);
    t.apply([A, B, C], 2000);
    assert.deepEqual([...t.arrivals.keys()], ['usr_c']);
    assert.equal(t.arrivals.get('usr_c'), 2000);
  });

  test('既有成員重複出現在名冊裡不會重複標記', () => {
    const t = makeTracker();
    t.apply([A]);
    t.apply([A, B], 2000);
    t.apply([A, B], 3000);   // 名冊因為別的原因重送
    assert.equal(t.arrivals.get('usr_b'), 2000, '標記時間被後來的名冊覆蓋了');
    assert.equal(t.arrivals.size, 1);
  });

  test('離場者的標記要一併清掉', () => {
    const t = makeTracker();
    t.apply([A]);
    t.apply([A, B], 2000);
    assert.equal(t.arrivals.size, 1);
    t.apply([A], 3000);      // B 離場
    assert.equal(t.arrivals.size, 0, '離場者的標記沒清掉，會殘留在 Map 裡');
    assert.ok(!t.roster.has('usr_b'));
  });

  test('離場後再進場會重新標記', () => {
    const t = makeTracker();
    t.apply([A, B]);
    t.apply([A], 2000);            // B 離場
    t.apply([A, B], 3000);         // B 又回來
    assert.equal(t.arrivals.get('usr_b'), 3000);
  });

  test('空名冊之後的第一個人仍算新加入', () => {
    const t = makeTracker();
    t.apply([]);                   // 開場時還沒有人
    t.apply([A], 2000);
    assert.equal(t.arrivals.get('usr_a'), 2000,
      '開場第一位進場者沒被標記 —— 那正是最需要指示的時刻');
  });
});
