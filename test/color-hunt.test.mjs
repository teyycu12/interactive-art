/**
 * COLOR_HUNT 任務測試
 *
 * 執行：node --test
 *
 * 這個任務的核心是「顏色判定」，而判定錯誤在現場的表現是
 * 「系統說他不是紅色的，但大家都看得到他穿紅衣服」——
 * 參與者無法理解，主辦端也無從解釋。因此判定規則需要回歸防護。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_FAMILIES, COLOR_FAMILY_MAP, familyOf, familiesOfAvatar, avatarMatchesFamily,
} from '../shared/colorFamily.js';
import { MissionBoard } from '../server/missions.js';
import { SocialGraph } from '../server/socialgraph.js';
import { PairingSession } from '../server/pairing.js';
import { ACCENT_COLORS } from '../shared/avatars.js';

describe('色族判定', () => {
  test('每個色族的代表色都會判回自己', () => {
    // 主辦端選單上顯示的色塊，必須與該選項實際會匹配到的顏色一致。
    // 不一致的話主辦端會選到一個「看起來是紫色、實際判定成紅色」的選項。
    for (const f of COLOR_FAMILIES) {
      assert.equal(familyOf(f.swatch), f.id, `${f.id} 的代表色 ${f.swatch} 判定錯誤`);
    }
  });

  test('調色盤的每個顏色都判得出色族，且不會全擠在同一族', () => {
    const got = ACCENT_COLORS.map(familyOf);
    for (const [i, f] of got.entries()) {
      assert.ok(f, `${ACCENT_COLORS[i]} 判不出色族`);
      assert.ok(COLOR_FAMILY_MAP[f], `${ACCENT_COLORS[i]} 判出未知色族 ${f}`);
    }
    // 若全部落在同一族，任務就永遠只有一個顏色可選
    assert.ok(new Set(got).size >= 3, `調色盤只涵蓋 ${new Set(got).size} 個色族`);
  });

  test('低飽和但看得出顏色的衣服不可被判成黑白灰', () => {
    // #84A98C 是調色盤裡的鼠尾草綠，飽和度僅 0.18。
    // 門檻設太高會讓它被判成無彩色 —— 而它在大螢幕上明顯是綠的。
    assert.equal(familyOf('#84A98C'), 'GREEN');
  });

  test('真正的無彩色才歸黑白灰', () => {
    for (const hex of ['#FFFFFF', '#000000', '#6D6875', '#808080']) {
      assert.equal(familyOf(hex), 'MONO', `${hex} 應為 MONO`);
    }
  });

  test('非法輸入回傳 null 而非誤判成某個顏色', () => {
    for (const bad of ['', 'red', '#GGG', null, undefined, '#12345']) {
      assert.equal(familyOf(bad), null);
    }
  });
});

describe('角色顏色比對', () => {
  const knob = (accentColor) => ({ head: 'h', face: 'f', body: 'b', accentColor });
  const cv = (torso, legs) => ({
    source: 'CV',
    textures: {},
    fallbackColors: { skin: '#F4A261', hair: '#2F2A26', torso, legs },
  });

  test('捏臉角色以 accentColor 判定', () => {
    assert.ok(avatarMatchesFamily(knob('#E76F51'), 'RED'));
    assert.ok(!avatarMatchesFamily(knob('#E76F51'), 'BLUE'));
  });

  test('CV 角色同時看上衣與褲子', () => {
    // 任務說的是「身上帶這個顏色」。只看上衣會讓穿紅褲子的人
    // 明明符合卻被判不符，而他本人看得到自己的角色有紅色。
    const a = cv('#457B9D', '#E63946');
    assert.ok(avatarMatchesFamily(a, 'BLUE'), '上衣藍色應符合');
    assert.ok(avatarMatchesFamily(a, 'RED'), '褲子紅色也應符合');
    assert.deepEqual(familiesOfAvatar(a).sort(), ['BLUE', 'RED']);
  });

  test('未知色族一律不符，不會意外放行', () => {
    assert.ok(!avatarMatchesFamily(knob('#E76F51'), 'PINK'));
    assert.ok(!avatarMatchesFamily(knob('#E76F51'), null));
  });

  test('壞掉的角色資料不會拋例外', () => {
    for (const bad of [null, undefined, 42, {}, { source: 'CV' }]) {
      assert.deepEqual(familiesOfAvatar(bad), []);
      assert.equal(avatarMatchesFamily(bad, 'RED'), false);
    }
  });
});

describe('COLOR_HUNT 任務發布', () => {
  test('缺少顏色參數時拒絕發布', () => {
    const b = new MissionBoard();
    assert.equal(b.publish({ type: 'COLOR_HUNT', target: 2 }).ok, false);
    assert.equal(b.isActive, false);
  });

  test('顏色不在白名單時拒絕發布', () => {
    const b = new MissionBoard();
    assert.equal(b.publish({ type: 'COLOR_HUNT', target: 2, colorFamily: 'PINK' }).ok, false);
  });

  test('合法發布後顏色會出現在公告中', () => {
    // 手機端靠公告裡的 colorFamily 顯示「要找什麼顏色」，
    // 漏掉這個欄位參與者就不知道任務目標。
    const b = new MissionBoard();
    const r = b.publish({ type: 'COLOR_HUNT', target: 2, colorFamily: 'RED' });
    assert.ok(r.ok);
    assert.equal(b.announcement().colorFamily, 'RED');
    assert.equal(b.export().active.colorFamily, 'RED');
  });

  test('PAIRING 不受影響，且不會被塞進顏色', () => {
    const b = new MissionBoard();
    const r = b.publish({ type: 'PAIRING', target: 2 });
    assert.ok(r.ok);
    assert.equal(b.announcement().colorFamily, null);
  });
});

describe('peekTarget 不產生副作用', () => {
  test('查詢不會吃掉 claim 冷卻', () => {
    // 顏色不符的路徑會先 peek 再拒絕。若 peek 動到冷卻計時，
    // 使用者馬上改找正確的人時會被冷卻擋下，看起來像系統壞掉。
    const graph = new SocialGraph();
    const p = new PairingSession(graph);
    const codeA = p.register('a');
    p.register('b');

    assert.equal(p.peekTarget(codeA), 'a');
    assert.equal(p.peekTarget(codeA), 'a');
    // 連續 peek 之後，b 仍然可以正常提交
    assert.equal(p.claim('b', codeA).ok, true);
  });

  test('非法碼回傳 null 而不拋例外', () => {
    const p = new PairingSession(new SocialGraph());
    for (const bad of ['', 'abcd', null, '123456789']) {
      assert.equal(p.peekTarget(bad), null);
    }
  });
});

describe('顏色預檢不可成為枚舉管道', () => {
  test('查無此碼會記冷卻，無法無限次試', () => {
    // peekTarget 本身沒有冷卻。若「顏色不符」那條路徑直接 return
    // 而不記冷卻，攻擊者就能從 COLOR_MISMATCH ↔ NOT_FOUND 的差異
    // 無限次試碼，把 claim() 的防枚舉保護整套繞過去
    // （4 位碼只有 10000 組，實測 15ms 可試完）。
    const p = new PairingSession(new SocialGraph());
    p.register('victim');
    assert.equal(p.inCooldown('attacker'), false);
    p.noteClaim('attacker');
    assert.equal(p.inCooldown('attacker'), true);
  });

  test('顏色不符不記冷卻，正當使用者可馬上改找別人', () => {
    // 走向了不對的人是正當使用者天天會遇到的事，不該罰他
    const p = new PairingSession(new SocialGraph());
    const code = p.register('someone');
    assert.equal(p.inCooldown('me'), false);
    // 顏色不符的分支不呼叫 noteClaim
    assert.equal(p.peekTarget(code), 'someone');
    assert.equal(p.inCooldown('me'), false);
  });
});
