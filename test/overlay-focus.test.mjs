/**
 * 覆蓋層的鍵盤行為測試（配對面板／配對確認／退出確認／問答）
 *
 * 這四層在視覺上都是 position:fixed + 遮罩，看起來蓋住了整個畫面，
 * 但**擋不住鍵盤** —— 這是本檔要守住的東西。曾經的實際行為是：
 * 面板開著時 Tab 會穿過遮罩走到底下的搖桿與表情鍵，焦點框落在
 * 一塊看不見的區域裡，使用者不知道選到什麼，按下去卻真的會送出動作。
 *
 * 三條回歸重點：
 *   1. 開啟時底下的 #app 要 inert，關閉後要還原
 *   2. 疊層（問答蓋在配對面板上）時只有最上層可聚焦，且要按順序還原
 *   3. 關閉後焦點回到觸發的那顆按鈕，不是掉回 <body>
 *
 * app.js 直接綁 document，無法在 node 環境載入，因此這裡重建同一套
 * 堆疊邏輯來測。**改 app.js 的 pushOverlay／popOverlay 時要同步改這裡** ——
 * 兩邊漂移了測試會繼續綠燈，那正是這類 bug 最初溜進去的方式。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/** 最小 DOM 替身：只保留 inert、focus 與連線狀態 */
function el(name) {
  return {
    name,
    inert: false,
    isConnected: true,
    offsetParent: {},        // 非 null 代表可見
    focused: false,
    focus() { this.focused = true; },
  };
}

/** app.js 中 pushOverlay／popOverlay 的等價實作 */
function makeOverlayManager(appRoot) {
  const stack = [];
  return {
    stack,
    push(target, { restoreTo } = {}) {
      if (stack.some((o) => o.el === target)) return;
      stack.push({ el: target, restoreTo });
      appRoot.inert = true;
      for (const o of stack) if (o.el !== target) o.el.inert = true;
      target.inert = false;
    },
    pop(target) {
      const i = stack.findIndex((o) => o.el === target);
      if (i === -1) return;
      const [gone] = stack.splice(i, 1);
      target.inert = false;
      const top = stack[stack.length - 1];
      if (top) top.el.inert = false;
      else appRoot.inert = false;
      const back = gone.restoreTo;
      if (back && back.isConnected && back.offsetParent !== null) back.focus();
    },
  };
}

describe('覆蓋層開啟時底下不可被 Tab 走到', () => {
  test('開啟時 #app 變 inert，關閉後還原', () => {
    const app = el('app');
    const sheet = el('sheet');
    const m = makeOverlayManager(app);

    assert.equal(app.inert, false);
    m.push(sheet);
    assert.equal(app.inert, true, '面板開著時底下的搖桿仍可 Tab 走到');
    assert.equal(sheet.inert, false, '面板自己不該被 inert 擋掉');

    m.pop(sheet);
    assert.equal(app.inert, false, '關閉後底下應該重新可操作');
  });

  test('關閉後焦點回到觸發的按鈕', () => {
    const app = el('app');
    const banner = el('mission-banner');
    const sheet = el('sheet');
    const m = makeOverlayManager(app);

    m.push(sheet, { restoreTo: banner });
    m.pop(sheet);
    assert.equal(banner.focused, true, '焦點掉回 <body>，下次 Tab 得從頭走一遍');
  });

  test('觸發者已隱藏時不硬搶焦點', () => {
    const app = el('app');
    const trigger = el('btn-exit');
    const box = el('confirm-exit');
    const m = makeOverlayManager(app);

    m.push(box, { restoreTo: trigger });
    // 離開現場後整個 controller section 收起來，觸發者不再可見
    trigger.offsetParent = null;
    m.pop(box);
    assert.equal(trigger.focused, false, '對已隱藏的元素呼叫 focus() 沒有意義');
  });
});

describe('疊層', () => {
  test('問答蓋在配對面板上時，只有問答可聚焦', () => {
    const app = el('app');
    const sheet = el('sheet');
    const quiz = el('quiz');
    const m = makeOverlayManager(app);

    m.push(sheet);
    m.push(quiz);

    assert.equal(quiz.inert, false, '最上層應可聚焦');
    assert.equal(sheet.inert, true, 'Tab 會走到被蓋住的那一層');
    assert.equal(app.inert, true);
  });

  test('上層關閉後，焦點交還給下層而非整個頁面', () => {
    const app = el('app');
    const sheet = el('sheet');
    const quiz = el('quiz');
    const m = makeOverlayManager(app);

    m.push(sheet);
    m.push(quiz);
    m.pop(quiz);

    assert.equal(sheet.inert, false, '下層應該重新可聚焦');
    assert.equal(app.inert, true, '還有一層開著，底下不該解除 inert');

    m.pop(sheet);
    assert.equal(app.inert, false, '全部關閉後才解除');
  });

  test('重複開啟同一層不會在堆疊裡疊兩份', () => {
    const app = el('app');
    const sheet = el('sheet');
    const m = makeOverlayManager(app);

    m.push(sheet);
    m.push(sheet);
    assert.equal(m.stack.length, 1);

    // 疊了兩份的話，這一次 pop 之後 app 會卡在 inert 永遠解不開
    m.pop(sheet);
    assert.equal(app.inert, false, 'inert 沒解開，整個控制器會變成不能操作');
  });

  test('關閉不在堆疊裡的層不影響其他層', () => {
    const app = el('app');
    const sheet = el('sheet');
    const never = el('never-opened');
    const m = makeOverlayManager(app);

    m.push(sheet);
    m.pop(never);          // 退出流程會對已隱藏的覆蓋層呼叫 close
    assert.equal(app.inert, true, '不該被無關的 pop 解除');
    assert.equal(m.stack.length, 1);
  });
});
