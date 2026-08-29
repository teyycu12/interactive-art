/**
 * 尋寶（先知模式）測試
 *
 * 執行：node --test
 *
 * 這個玩法的價值完全建立在「資訊不對稱」上：先知看得到冷熱但不能得分，
 * 其他人看不到但能得分。任何一邊破功，它就退化成一個沒有人需要
 * 開口講話的普通尋寶 —— 而讓現場開口正是做它的唯一理由。
 * 因此下面每一條測的都是那個不對稱本身。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TreasureHunt, heatOf } from '../server/treasure.js';
import { HEAT_LEVELS, HEAT_MAP, TREASURE_RADIUS } from '../shared/heat.js';
import { TREASURE } from '../server/config.js';
import { OBSTACLES } from '../shared/scene.js';
import { STAGE } from '../shared/protocol.js';

/** 造一個假的 agents Map */
function agentsOf(entries) {
  return new Map(entries.map(([id, x, y]) => [id, { id, x, y }]));
}

describe('冷熱換算', () => {
  test('距離越近越熱，且每一級都取得到', () => {
    assert.equal(heatOf(0), 'BURNING');
    assert.equal(heatOf(150), 'HOT');
    assert.equal(heatOf(350), 'WARM');
    assert.equal(heatOf(700), 'COLD');
    assert.equal(heatOf(2000), 'FREEZING');
  });

  test('每個等級都有對應的顯示資料', () => {
    // 伺服器送出的 id 若在 HEAT_MAP 裡查不到，手機端會顯示空白，
    // 而先知的畫面上冷熱是唯一的資訊。
    for (const d of [0, 150, 350, 700, 2000]) {
      assert.ok(HEAT_MAP[heatOf(d)], `${d} 判出的等級查不到顯示資料`);
    }
    assert.equal(HEAT_LEVELS.length, 5);
  });

  test('門檻與等級數一致', () => {
    // 門檻少一個就會有等級永遠取不到
    assert.equal(TREASURE.heatThresholds.length, HEAT_LEVELS.length - 1);
  });
});

describe('開局', () => {
  test('少於兩人無法開始', () => {
    // 只有先知的話沒人能得分，只有找的人的話沒有提示來源
    const t = new TreasureHunt();
    assert.equal(t.start([]).ok, false);
    assert.equal(t.start(['a']).ok, false);
    assert.equal(t.isActive, false);
  });

  test('兩人以上可開始，先知取自參與者', () => {
    const t = new TreasureHunt();
    const r = t.start(['a', 'b']);
    assert.ok(r.ok);
    assert.ok(['a', 'b'].includes(r.round.prophetId));
  });

  test('可指定先知；指定了不在場的人則改為隨機', () => {
    const t1 = new TreasureHunt();
    assert.equal(t1.start(['a', 'b'], { prophetId: 'b' }).round.prophetId, 'b');

    const t2 = new TreasureHunt();
    const r = t2.start(['a', 'b'], { prophetId: 'ghost' });
    assert.ok(['a', 'b'].includes(r.round.prophetId), '不在場的先知應退回隨機');
  });

  test('不會重複開局', () => {
    const t = new TreasureHunt();
    t.start(['a', 'b']);
    assert.equal(t.start(['a', 'b']).ok, false);
  });

  test('隨機藏寶點不會落在道具裡或貼著邊', () => {
    // 藏在道具裡的話沒有人走得到，那一輪永遠結束不了
    for (let i = 0; i < 200; i++) {
      const t = new TreasureHunt();
      const { x, y } = t.start(['a', 'b']).round;
      for (const o of OBSTACLES) {
        assert.ok(Math.hypot(x - o.x, y - o.y) >= o.r + TREASURE_RADIUS,
          `第 ${i} 次藏在道具 (${o.x},${o.y}) 裡`);
      }
      assert.ok(x >= TREASURE.edgeMargin && x <= STAGE.width - TREASURE.edgeMargin);
      assert.ok(y >= TREASURE.edgeMargin && y <= STAGE.height - TREASURE.edgeMargin);
    }
  });
});

describe('資訊不對稱（本玩法的核心）', () => {
  test('公開狀態絕不含座標', () => {
    // 手機端只要收到座標，打開開發者工具就能直接看到答案，
    // 而現場一定有人會這麼做。
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 800, y: 600 } });
    const view = t.publicView();
    assert.equal(view.x, undefined);
    assert.equal(view.y, undefined);

    // 逐值比對而非在整串 JSON 裡找子字串。
    //
    // 原本寫的是 JSON.stringify(view).includes('800')，用意是好的
    // （座標從任何欄位漏出去都要抓到），但 startedAt 是毫秒時間戳，
    // 裡面遲早會出現 '800' 這三個連續數字 —— 實測 1788006490658 就是。
    // 那會讓這個測試在某些時刻無故變紅，而訊息完全看不出跟時間有關。
    //
    // 改成檢查「有沒有任何欄位的值等於座標」：一樣涵蓋所有欄位，
    // 但不會把時間戳裡碰巧相連的數字當成洩漏。
    for (const [key, value] of Object.entries(view)) {
      assert.notEqual(value, 800, `publicView 的 ${key} 洩漏了 x 座標`);
      assert.notEqual(value, 600, `publicView 的 ${key} 洩漏了 y 座標`);
    }

    // 但大螢幕與主辦端拿得到
    assert.deepEqual(t.spot(), { x: 800, y: 600 });
  });

  test('先知踩上去不算找到', () => {
    // 先知看得到冷熱，讓他自己去踩等於整個機制失效
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
    assert.equal(t.check(agentsOf([['a', 500, 500]])), null, '先知不該能撿');
    assert.ok(t.isActive, '先知踩到後本輪仍應繼續');
  });

  test('非先知踩上去才算找到', () => {
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
    const found = t.check(agentsOf([['a', 500, 500], ['b', 500, 500]]));
    assert.deepEqual(found, { id: 'b' });
    assert.equal(t.round.foundBy, 'b');
  });

  test('先知得 0 分', () => {
    // 先知一旦能得分就有動機自己走過去而不是喊出來
    assert.equal(TREASURE.prophetPoints, 0);
    assert.ok(TREASURE.points > 0);
  });

  test('冷熱回報的是別人的距離，不是先知自己的', () => {
    // 若回報先知自己的距離，他會本能地往寶藏走，而那對隊伍毫無幫助
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
    // 先知就站在寶藏上，隊友在很遠處 → 應回報「冷」而不是「燙」
    const heat = t.heatFor(agentsOf([['a', 500, 500], ['b', 1800, 1000]]));
    assert.equal(heat.heat, 'FREEZING');
  });

  test('只有一個人（先知本人）在場時不回報冷熱', () => {
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
    assert.equal(t.heatFor(agentsOf([['a', 500, 500]])), null);
  });
});

describe('判定半徑', () => {
  test('剛好在半徑內算踩到，外面不算', () => {
    const mk = () => {
      const t = new TreasureHunt();
      t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
      return t;
    };
    assert.ok(mk().check(agentsOf([['b', 500 + TREASURE_RADIUS - 1, 500]])));
    assert.equal(mk().check(agentsOf([['b', 500 + TREASURE_RADIUS + 1, 500]])), null);
  });

  test('伺服器與大螢幕共用同一個半徑', () => {
    // 兩邊各存一份會出現「畫面上明明踩進圈裡卻沒有反應」
    assert.equal(TREASURE.claimRadius, TREASURE_RADIUS);
  });
});

describe('冷熱只在等級變動時推送', () => {
  test('連續同一等級只有第一次 changed 為真', () => {
    // 每幀重送同一個字只是白白佔用現場頻寬（30Hz）
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
    const far = agentsOf([['b', 1800, 1000]]);
    assert.equal(t.heatFor(far).changed, true);
    assert.equal(t.heatFor(far).changed, false);
    assert.equal(t.heatFor(far).changed, false);
    // 靠近後應再次觸發
    assert.equal(t.heatFor(agentsOf([['b', 520, 500]])).changed, true);
  });

  test('已經找到之後不再回報冷熱', () => {
    const t = new TreasureHunt();
    t.start(['a', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'a' });
    t.check(agentsOf([['b', 500, 500]]));
    assert.equal(t.heatFor(agentsOf([['b', 1800, 1000]])), null);
  });
});

describe('現場會發生的中斷情況', () => {
  const mk = () => {
    const t = new TreasureHunt();
    t.start(['p', 'b'], { spot: { x: 500, y: 500 }, prophetId: 'p' });
    return t;
  };

  test('先知離場時本輪判定為不成立', () => {
    // 冷熱照算但沒有人收得到，其他人完全沒有提示，這一輪永遠不會結束。
    // 賓客關掉分頁角色仍留在場上 45 秒才回收，一場活動必然發生好幾次。
    const t = mk();
    const v = t.viability(agentsOf([['b', 100, 100]]));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'PROPHET_LEFT');
  });

  test('只剩先知時本輪判定為不成立', () => {
    // 先知不能撿，因此沒有人結束得了
    const t = mk();
    const v = t.viability(agentsOf([['p', 100, 100]]));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'NO_SEEKERS');
  });

  test('先知與至少一位其他人都在時仍然成立', () => {
    assert.equal(mk().viability(agentsOf([['p', 0, 0], ['b', 900, 900]])).ok, true);
  });

  test('沒有進行中的尋寶時 viability 不報錯', () => {
    assert.equal(new TreasureHunt().viability(new Map()).ok, true);
  });

  test('resendHeat 讓下一次無條件重送', () => {
    // 先知瞬斷重連後畫面是空的。若不重置，要等到冷熱「等級變動」
    // 才會再收到 —— 隊伍停在原地時可以是好幾十秒。
    const t = mk();
    const far = agentsOf([['b', 1800, 1000]]);
    assert.equal(t.heatFor(far).changed, true);
    assert.equal(t.heatFor(far).changed, false);
    t.resendHeat();
    assert.equal(t.heatFor(far).changed, true, '重連後應強制重送');
  });

  test('resendHeat 在沒有進行中的尋寶時不報錯', () => {
    const t = new TreasureHunt();
    t.resendHeat();
    assert.equal(t.isActive, false);
  });
});
