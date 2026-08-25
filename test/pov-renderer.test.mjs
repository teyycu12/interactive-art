/**
 * 手機端個人視角畫布（POV Canvas）測試
 *
 * 重點在腳步震動的觸地偵測 —— 這是最容易默默壞掉的部分：
 * 震動對不上腳步不會拋任何錯誤，只會讓手感變差，而且在桌機上完全測不出來。
 *
 * 兩個曾經真的寫錯的地方，各留一條回歸測試：
 *   1. |sin| 的觸底是**雙向**過零，只抓單向會漏掉一半的腳步
 *   2. 速度門檻若低於低通濾波的殘餘量，角色站著不動也會持續震動
 *
 * 執行：node --test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

/** 最小 canvas 替身：只記錄呼叫，不做任何實際繪製 */
function makeCanvasStub() {
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return { width: 0, height: 0 };
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; },
  });
  return { clientWidth: 390, clientHeight: 700, width: 0, height: 0, getContext: () => ctx };
}

let AvatarRenderer;
let rafCb = null;

before(async () => {
  const canvas = makeCanvasStub();
  // avatarRenderer.js 是瀏覽器模組，載入時就會碰這些全域
  globalThis.document = { createElement: () => canvas };
  globalThis.devicePixelRatio = 3;
  globalThis.Image = class { addEventListener() {} set src(_v) {} };
  globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.innerWidth = 390;
  globalThis.innerHeight = 700;

  ({ AvatarRenderer } = await import('../public/controller/avatarRenderer.js'));
});

const AVATAR = {
  source: 'CV',
  textures: { head: '/a/head.webp', torso: '/a/torso.webp', legs: '/a/legs.webp' },
  fallbackColors: { skin: '#F4C08A', hair: '#4A2C1A', torso: '#8FA05E', legs: '#B7A98A' },
};

/** 跑 n 幀 @60fps，回傳期間的觸地次數 */
function run(r, clock, frames) {
  let steps = 0;
  r.onFootstep(() => steps++);
  for (let i = 0; i < frames; i++) {
    clock.t += 1000 / 60;
    rafCb(clock.t);
  }
  return steps;
}

function makeRenderer() {
  const clock = { t: 0 };
  globalThis.performance = { now: () => clock.t };
  const r = new AvatarRenderer(makeCanvasStub(), AVATAR);
  r.start();
  return { r, clock };
}

describe('POV 畫布：觸地偵測', () => {
  test('推滿搖桿時的步頻與 character.js 的 |sin| 彈跳一致', () => {
    const { r, clock } = makeRenderer();
    r.setInput({ x: 1, y: 0 }, 1);
    const steps = run(r, clock, 180);   // 3 秒

    // cadence = 0.55 + 0.45·1 = 1.0，ω = 12 rad/s
    // 一個 sin 週期兩步 → 3s · 12/(2π) · 2 ≈ 11.5 步
    // 這裡刻意用範圍而非精確值：起步的第一幀不計為觸地。
    assert.ok(steps >= 10 && steps <= 12,
      `3 秒全速應約 11 步（雙向過零），實得 ${steps}。` +
      '若只有一半，表示過零偵測退回單向。');
    r.stop();
  });

  test('角色完全靜止後不再震動（低通濾波的殘餘速度不得觸發）', () => {
    const { r, clock } = makeRenderer();
    r.setInput({ x: 1, y: 0 }, 1);
    run(r, clock, 120);

    // 放手，先跑掉減速期
    r.setInput({ x: 0, y: 0 }, 0);
    run(r, clock, 120);

    // 此後角色在畫面上已完全停住，這段必須一次都不震
    const idle = run(r, clock, 300);   // 5 秒
    assert.equal(idle, 0,
      `靜止 5 秒仍震動 ${idle} 次 —— 速度門檻低於濾波殘量。`);
    r.stop();
  });

  test('放手後的腳步在 WALK 動畫結束前就停止', () => {
    const { r, clock } = makeRenderer();
    r.setInput({ x: 1, y: 0 }, 1);
    run(r, clock, 120);

    const releaseAt = clock.t;
    let lastStepAt = releaseAt;
    r.onFootstep(() => { lastStepAt = clock.t; });
    r.setInput({ x: 0, y: 0 }, 0);
    for (let i = 0; i < 180; i++) { clock.t += 1000 / 60; rafCb(clock.t); }

    // character.js 在速度降到 WALK 門檻以下才切回 IDLE（約 +0.37s）。
    // 腳步若晚於此，使用者會看到角色站定了卻還在震。
    const after = (lastStepAt - releaseAt) / 1000;
    assert.ok(after < 0.37,
      `最後一次腳步在放手後 ${after.toFixed(3)}s，已超過 WALK 動畫結束時間。`);
    r.stop();
  });
});

describe('POV 畫布：伺服器同步', () => {
  const sync = (over = {}, neighbors = []) => ({
    self: {
      x: 960, y: 540, vx: 0, vy: 0, heading: 0,
      state: 'IDLE', mode: 'SWARM', alpha: 0, facing: 1, ...over,
    },
    neighbors,
  });

  test('速度以伺服器為準，不採用搖桿的本地推測', () => {
    const { r, clock } = makeRenderer();
    // 搖桿往右推，但伺服器說角色正在往左走（例如被 α 仲裁接管、或撞上障礙物）
    r.setInput({ x: 1, y: 0 }, 1);
    r.applySync(sync({ vx: -150, vy: 0, state: 'WALK', facing: -1 }));
    run(r, clock, 30);

    assert.ok(r.vx < 0, `速度應跟隨伺服器（負值），實得 ${r.vx}`);
    r.stop();
  });

  test('朝向直接取伺服器的 facing，不由本地速度反推', () => {
    const { r, clock } = makeRenderer();
    // 關鍵情境：角色幾乎靜止（本地速度落在 facing 死區內），
    // 但伺服器明確說它面向左邊 —— 例如剛停下來、或正在打招呼。
    // 若朝向是由本地速度反推，死區會讓它卡在預設的 +1。
    r.applySync(sync({ vx: 0, vy: 0, state: 'IDLE', facing: -1 }));
    run(r, clock, 30);

    assert.equal(r.facing, -1,
      '朝向由本地速度反推 —— 靜止時會落在死區內，與大螢幕的朝向不一致');
    r.stop();
  });

  test('伺服器狀態過期時停止外推，收斂到靜止', () => {
    const { r, clock } = makeRenderer();
    r.applySync(sync({ vx: 190, vy: 0, state: 'WALK' }));
    run(r, clock, 6);          // 約 100ms，狀態仍新鮮
    assert.ok(Math.abs(r.vx) > 0.3, '新鮮狀態下應跟隨伺服器速度');

    // 之後不再送同步（模擬掉線），角色必須停下而不是一路飄走
    run(r, clock, 120);        // 2 秒無同步
    assert.ok(Math.abs(r.vx) < 0.02,
      `斷線後仍以 ${r.vx} 前進 —— 會飄出場外，與大螢幕徹底脫節`);
    r.stop();
  });

  test('鄰居就地更新，不在每次同步時重建（避免瞬移）', () => {
    const { r, clock } = makeRenderer();
    r.applySync(sync({}, [{ id: 'usr_a', dx: 100, dy: 0, facing: 1, state: 'WALK' }]));
    run(r, clock, 6);
    const first = r.neighbors.get('usr_a');

    r.applySync(sync({}, [{ id: 'usr_a', dx: 140, dy: 0, facing: 1, state: 'WALK' }]));
    const second = r.neighbors.get('usr_a');

    assert.equal(first, second, '鄰居條目被整個換掉，內插會從頭開始造成瞬移');
    assert.equal(second.fromDx, 100, '內插起點應是上一次的位置');
    assert.equal(second.dx, 140);
    r.stop();
  });

  test('離開可見半徑的鄰居會被移除', () => {
    const { r, clock } = makeRenderer();
    r.applySync(sync({}, [
      { id: 'usr_a', dx: 100, dy: 0, facing: 1, state: 'WALK' },
      { id: 'usr_b', dx: -80, dy: 20, facing: -1, state: 'IDLE' },
    ]));
    assert.equal(r.neighbors.size, 2);

    // 伺服器下一則只回報 a —— b 已走出半徑
    r.applySync(sync({}, [{ id: 'usr_a', dx: 110, dy: 0, facing: 1, state: 'WALK' }]));
    assert.equal(r.neighbors.size, 1);
    assert.ok(!r.neighbors.has('usr_b'), '走出半徑的鄰居沒被清掉，會永遠留在畫面上');
    r.stop();
  });

  test('空的或格式不符的同步不會讓畫面崩掉', () => {
    const { r, clock } = makeRenderer();
    r.applySync(undefined);
    r.applySync({});
    r.applySync({ self: null });
    r.applySync(sync({}, undefined));   // neighbors 缺欄位
    run(r, clock, 10);
    assert.equal(r.neighbors.size, 0);
    r.stop();
  });
});

describe('POV 畫布：渲染設定', () => {
  test('devicePixelRatio 上限壓在 2（低階手機的填色成本）', () => {
    const canvas = makeCanvasStub();
    globalThis.performance = { now: () => 0 };
    globalThis.devicePixelRatio = 3;
    // eslint-disable-next-line no-new
    new AvatarRenderer(canvas, AVATAR);
    assert.equal(canvas.width, 390 * 2,
      'dpr 未被夾在 2，全螢幕畫布在 dpr=3 的裝置上填色成本會多出一倍以上');
  });

  test('推桿方向決定朝向，接近垂直時不左右亂翻', () => {
    const { r, clock } = makeRenderer();
    r.setInput({ x: 1, y: 0 }, 1);
    run(r, clock, 60);
    assert.equal(r.facing, 1);

    r.setInput({ x: -1, y: 0 }, 1);
    run(r, clock, 60);
    assert.equal(r.facing, -1);

    // 幾乎垂直的推桿落在死區內，朝向應維持不變
    r.setInput({ x: 0.02, y: 1 }, 1);
    run(r, clock, 60);
    assert.equal(r.facing, -1, '死區失效：接近垂直推桿時角色會左右抖動');
    r.stop();
  });
});
