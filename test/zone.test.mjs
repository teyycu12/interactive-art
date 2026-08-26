/**
 * 分區感知測試
 *
 * 執行：node --test
 *
 * 分區原本只是地板上的色塊 —— 伺服器完全不知道它們存在。
 * 這組測試守的是「判定本身」與「只在換區時回報」這兩件事：
 * 後者若壞掉，30Hz × 10 人會變成每秒 300 則重複訊息，
 * 而現場的症狀只是「網路很慢」，完全看不出跟分區有關。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { zoneAt, ZONES, ZONE_MAP, OBSTACLES } from '../shared/scene.js';
import { Stage } from '../server/state.js';
import { STAGE } from '../shared/protocol.js';
import { MAX_AGENTS } from '../server/config.js';

const AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

describe('分區判定', () => {
  test('每個分區的中心都判得回自己', () => {
    for (const z of ZONES) {
      const cx = z.x + z.w / 2;
      const cy = z.y + z.h / 2;
      assert.equal(zoneAt(cx, cy), z.id, `${z.id} 的中心判定錯誤`);
    }
  });

  test('分區外回傳 null', () => {
    // 場地中央刻意留空（三個分區都不在那裡）
    assert.equal(zoneAt(960, 600), null);
  });

  test('邊界採左閉右開，相鄰分區不會同時命中', () => {
    const z = ZONES[0];
    assert.equal(zoneAt(z.x, z.y), z.id, '左上角應屬於該區');
    assert.equal(zoneAt(z.x + z.w, z.y), null, '右邊界外不應屬於該區');
    assert.equal(zoneAt(z.x - 1, z.y), null);
  });

  test('非法座標不拋例外', () => {
    for (const [x, y] of [[NaN, 0], [0, NaN], [Infinity, 0], [undefined, undefined]]) {
      assert.equal(zoneAt(x, y), null);
    }
  });

  test('ZONE_MAP 涵蓋每一個分區', () => {
    // 三端靠它顯示名稱與顏色，少一個就會顯示 undefined
    for (const z of ZONES) {
      assert.equal(ZONE_MAP[z.id]?.label, z.label);
    }
  });

  test('每個分區都有可站立的空間（不被道具塞滿）', () => {
    // 分區的意義在於引導人群聚集，站不進去就沒有意義
    for (const z of ZONES) {
      let free = 0;
      for (let x = z.x + 20; x < z.x + z.w; x += 40) {
        for (let y = z.y + 20; y < z.y + z.h; y += 40) {
          if (!OBSTACLES.some((o) => Math.hypot(x - o.x, y - o.y) < o.r)) free++;
        }
      }
      assert.ok(free > 10, `${z.id} 幾乎被道具塞滿，只剩 ${free} 個落點`);
    }
  });
});

describe('分區進出只在換區時回報', () => {
  const spawnAt = (stage, x, y) => {
    const a = stage.addAgent({ name: 'T', avatar: AVATAR });
    a.x = x; a.y = y;
    a.boidsVx = 0; a.boidsVy = 0;
    return a;
  };

  test('停在同一區內不會重複回報', () => {
    // 每幀回報的話 30Hz × 10 人是每秒 300 則重複訊息
    const stage = new Stage();
    const z = ZONES[0];
    const a = spawnAt(stage, z.x + z.w / 2, z.y + z.h / 2);

    const first = stage.tick(1 / 30);
    assert.equal(first.length, 1, '首次進入應回報一次');
    assert.equal(first[0].to, z.id);
    assert.equal(first[0].from, null);
    assert.equal(a.zone, z.id);

    // 原地不動再跑十幀，不該再有任何回報
    let more = 0;
    for (let i = 0; i < 10; i++) more += stage.tick(1 / 30).length;
    assert.equal(more, 0, `停在原地卻回報了 ${more} 次`);
  });

  test('換區時帶著來源與目的地', () => {
    const stage = new Stage();
    const from = ZONES[0];
    const to = ZONES[1];
    const a = spawnAt(stage, from.x + from.w / 2, from.y + from.h / 2);
    stage.tick(1 / 30);

    a.x = to.x + to.w / 2;
    a.y = to.y + to.h / 2;
    const moves = stage.tick(1 / 30);
    assert.equal(moves.length, 1);
    assert.deepEqual(
      { from: moves[0].from, to: moves[0].to },
      { from: from.id, to: to.id },
    );
  });

  test('走出分區回報 to: null', () => {
    const stage = new Stage();
    const z = ZONES[0];
    const a = spawnAt(stage, z.x + z.w / 2, z.y + z.h / 2);
    stage.tick(1 / 30);

    a.x = 960; a.y = 600;   // 中央空地
    const moves = stage.tick(1 / 30);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].to, null);
    assert.equal(moves[0].from, z.id);
  });

  test('沒有人在分區內時不產生任何回報', () => {
    const stage = new Stage();
    spawnAt(stage, 960, 600);
    // 首幀的 zone 由 null → null，不算換區
    assert.equal(stage.tick(1 / 30).length, 0);
  });
});

describe('分區人數統計', () => {
  test('回報每一區有誰，分區外的人不計入', () => {
    const stage = new Stage();
    const z = ZONES[0];
    // 用 MAX_AGENTS 當上界，不寫死人數（見 CLAUDE.md 的人數上限一節）
    const inZone = Math.min(3, MAX_AGENTS - 1);
    for (let i = 0; i < inZone; i++) {
      const a = stage.addAgent({ name: `Z${i}`, avatar: AVATAR });
      a.x = z.x + 30 + i * 10;
      a.y = z.y + 30;
    }
    const outsider = stage.addAgent({ name: '外', avatar: AVATAR });
    outsider.x = 960; outsider.y = 600;

    stage.tick(1 / 30);
    const occ = stage.zoneOccupancy();
    assert.equal(occ[z.id]?.length, inZone);
    assert.ok(!Object.values(occ).flat().includes(outsider.id), '分區外的人不該被計入');
  });

  test('沒有人在任何分區時回傳空物件', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: '孤', avatar: AVATAR });
    a.x = 960; a.y = 600;
    stage.tick(1 / 30);
    assert.deepEqual(stage.zoneOccupancy(), {});
  });
});

describe('個人視角帶著分區', () => {
  test('CLIENT_SYNC 的 self 含 zone，重連的人才拿得到狀態', () => {
    // ZONE_SELF 是事件，重連的人已經錯過了；只有狀態拿得到
    const stage = new Stage();
    const z = ZONES[0];
    const a = stage.addAgent({ name: 'T', avatar: AVATAR });
    a.x = z.x + z.w / 2;
    a.y = z.y + z.h / 2;
    stage.tick(1 / 30);

    const view = stage.personalSnapshot(a.id, 320);
    assert.equal(view.self.zone, z.id);
  });
});
