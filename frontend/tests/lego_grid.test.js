/**
 * themes/lego.js 的格柵處理與記憶化測試。
 *
 * 這條路徑在 draw() 迴圈裡、每角色每幀都會經過，是前端唯一的效能熱點：
 * 實測單次 pipeline 約 2.2ms，若不做記憶化，30 個角色的每幀成本會達 65ms
 * （上限約 15fps），遠低於 60fps 目標。因此「快取有沒有真的命中」是需要
 * 長期守住的性質，不是一次性的優化。
 *
 * 執行：node --test frontend/tests/
 */
const test = require("node:test");
const assert = require("node:assert");
const { createSandbox, load, run } = require("./harness.js");

const COLS = 32, ROWS = 40;   // 與 cv_module 實際輸出的尺寸一致

function makeGrid(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cells = [];
  for (let i = 0; i < COLS * ROWS; i++) {
    cells.push({ r: 120, g: 80, b: 60, active: rnd() > 0.2 });
  }
  return { cols: COLS, rows: ROWS, cells };
}

function makePerson(overrides = {}) {
  return Object.assign({
    clothGrid: makeGrid(1), lowerGrid: null,
    hairColor: { r: 60, g: 40, b: 20 },
    innerColor: { r: 200, g: 50, b: 50 },
    lowerColor: { r: 50, g: 70, b: 150 },
    skinColor: { r: 255, g: 219, b: 0 },
    eyeColor: { r: 0, g: 0, b: 0 }, lipColor: { r: 200, g: 80, b: 80 },
    accessories: [], renderMode: "programmatic", vel: { x: 0, y: 0 },
    x: 0, y: 0, hairStyle: "short_straight", lowerType: "shorts",
    swarmState: "ROAMING", smileScore: 0.5,
  }, overrides);
}

/** 載入 lego.js 並攔截 _clusterGrid 以計算實際重算次數。 */
function newScene() {
  const s = load(createSandbox(), "themes/lego.js");
  run(s, `var __n = 0; var __orig = _clusterGrid;
          _clusterGrid = function () { __n++; return __orig.apply(null, arguments); };`);
  return {
    draw: run(s, "drawLegoCharacter"),
    computes: () => run(s, "__n"),
    reset: () => run(s, "__n = 0"),
    sandbox: s,
  };
}

test("同一份 grid 連續 60 幀只重算一次", () => {
  const sc = newScene();
  const p = makePerson();
  for (let i = 0; i < 60; i++) sc.draw(p);
  assert.strictEqual(sc.computes(), 1,
    "快取未命中 —— 每幀重算會讓 30 個角色掉到約 15fps");
});

test("無變更時後續幀完全不重算", () => {
  const sc = newScene();
  const p = makePerson();
  for (let i = 0; i < 30; i++) sc.draw(p);
  sc.reset();
  for (let i = 0; i < 60; i++) sc.draw(p);
  assert.strictEqual(sc.computes(), 0);
});

test("換成新的 grid 物件會重算一次", () => {
  const sc = newScene();
  const p = makePerson();
  sc.draw(p);
  sc.reset();
  p.clothGrid = makeGrid(2);
  for (let i = 0; i < 60; i++) sc.draw(p);
  assert.strictEqual(sc.computes(), 1, "換新 grid 後必須重算，否則牆上會是舊顏色");
});

test("髮色變更會使快取失效", () => {
  const sc = newScene();
  const p = makePerson();
  sc.draw(p);
  sc.reset();
  p.hairColor = { r: 10, g: 10, b: 10 };
  for (let i = 0; i < 60; i++) sc.draw(p);
  assert.strictEqual(sc.computes(), 1);
});

test("內搭色變更會使快取失效", () => {
  const sc = newScene();
  const p = makePerson();
  sc.draw(p);
  sc.reset();
  p.innerColor = { r: 1, g: 2, b: 3 };
  for (let i = 0; i < 60; i++) sc.draw(p);
  assert.strictEqual(sc.computes(), 1);
});

test("已知限制：就地修改 grid 內容不會使快取失效", () => {
  // 快取以「物件參照」判斷，而非內容雜湊。
  // 目前安全，因為 update_positions 每次都從 socket payload 指派全新陣列
  // （見 sketch.js 的 update_positions handler）。
  // 但若日後有人改成就地修改 cells，牆上會顯示舊顏色且毫無徵兆 ——
  // 此測試把這個限制固定下來，讓改動的人看得見。
  const sc = newScene();
  const p = makePerson();
  sc.draw(p);
  sc.reset();
  p.clothGrid.cells[0].r = 255;      // 就地修改，不換參照
  for (let i = 0; i < 10; i++) sc.draw(p);
  assert.strictEqual(sc.computes(), 0,
    "行為若改變（變成會重算），請一併更新此測試與 lego.js 的註解");
});

test("每個角色各自擁有快取，不會互相干擾", () => {
  const sc = newScene();
  const a = makePerson({ clothGrid: makeGrid(10) });
  const b = makePerson({ clothGrid: makeGrid(20) });
  sc.draw(a); sc.draw(b);
  sc.reset();
  for (let i = 0; i < 30; i++) { sc.draw(a); sc.draw(b); }
  assert.strictEqual(sc.computes(), 0, "兩個角色交替繪製不該互相清掉對方的快取");
});

test("沒有 clothGrid 的角色也能正常繪製", () => {
  const sc = newScene();
  assert.doesNotThrow(() => sc.draw(makePerson({ clothGrid: null })));
});
