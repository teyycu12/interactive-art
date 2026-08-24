/**
 * themes/lego.js 的算繪契約測試。
 *
 * 這支檔案原本是 lego_grid.test.js，測的是格柵處理管線的記憶化。合併
 * pivot-full-character 之後，該管線（_clusterGrid / _enhanceGrid /
 * _makeSymmetric / _filterHairCells / _filterShirtFromLower）連同繪製它的
 * _drawClothGrid 一併移除 —— 此主題只畫 AI 生成的完整角色 sprite，格柵
 * 已無消費者，記憶化自然也無從談起。
 *
 * 保留下來的是那條決定本身：本檔把「full_character 走 sprite、不再跑格柵
 * 管線」釘住，讓日後若有人把格柵接回來時看得見這段歷史。
 * 投影牆的格柵是 projection.html 內另一套 PIXI 實作，不受此處影響。
 *
 * 執行：node --test frontend/tests/
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createSandbox, load, run } = require("./harness.js");

const LEGO_SRC = path.join(__dirname, "..", "themes", "lego.js");

function makePerson(overrides = {}) {
  return Object.assign({
    hairColor: { r: 60, g: 40, b: 20 },
    innerColor: { r: 200, g: 50, b: 50 },
    lowerColor: { r: 50, g: 70, b: 150 },
    skinColor: { r: 255, g: 219, b: 0 },
    eyeColor: { r: 0, g: 0, b: 0 }, lipColor: { r: 200, g: 80, b: 80 },
    accessories: [], renderMode: "full_character", vel: { x: 0, y: 0 },
    x: 0, y: 0, hairStyle: "short_straight", lowerType: "shorts",
    swarmState: "ROAMING", smileScore: 0.5,
  }, overrides);
}

test("格柵管線已從此主題移除，沒有殘留的呼叫點", () => {
  // 逐行剔除註解後再比對，避免把說明文字本身誤判成呼叫點。
  const code = fs.readFileSync(LEGO_SRC, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("|");
  const gone = ["_clusterGrid", "_enhanceGrid", "_makeSymmetric",
                "_filterHairCells", "_filterShirtFromLower", "_drawClothGrid"];
  for (const name of gone) {
    assert.ok(!code.includes(name),
      name + " 又出現在 lego.js —— 若這是有意的，請一併恢復 _drawClothGrid 與本測試");
  }
});

test("full_character 角色以單張 sprite 繪製", () => {
  const drawn = [];
  const s = createSandbox({ image: (...a) => drawn.push(a) });
  load(s, "themes/lego.js");
  const person = makePerson({ bodySprite: { width: 512, height: 768 } });
  run(s, "drawLegoCharacter")(person);
  assert.strictEqual(drawn.length, 1, "應該只畫一張整體 sprite");
});

test("沒有 sprite 的角色不會拋錯（退回程式繪製的部件）", () => {
  const s = load(createSandbox(), "themes/lego.js");
  const draw = run(s, "drawLegoCharacter");
  assert.doesNotThrow(() => draw(makePerson({ bodySprite: null })));
});

test("身高 profile 只在程式繪製模式下改變比例", () => {
  const s = load(createSandbox(), "themes/lego.js");
  const draw = run(s, "drawLegoCharacter");
  const profile = { torso_scale_y: 1.4, leg_scale_y: 0.8 };
  assert.doesNotThrow(() => draw(makePerson({
    renderMode: "body_sprite", bodySprite: null, heightProfile: profile,
  })));
  assert.doesNotThrow(() => draw(makePerson({
    renderMode: "full_character", bodySprite: null, heightProfile: profile,
  })));
});
