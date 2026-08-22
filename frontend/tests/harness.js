/**
 * 在 Node 中載入前端腳本的最小工具。
 *
 * 前端程式依賴大量 p5.js 全域函式。此處用 Proxy 讓任何未定義的識別字都解析為
 * 無害的樁函式，如此就能在沒有瀏覽器與 p5 的情況下測試純邏輯（格柵處理、
 * 記憶化、資料轉換），不必逐一列舉上百個 p5 API。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRONTEND = path.join(__dirname, "..");

function createSandbox(extra = {}) {
  const stub = () => ({});
  const target = Object.assign(Object.create(null), {
    console, Math, Array, Object, JSON, Number, String, Boolean, Date,
    Uint8Array, Int32Array, Float32Array, Map, Set, Error,
    PI: Math.PI, TWO_PI: Math.PI * 2, HALF_PI: Math.PI / 2,
    ROUND: "round", CLOSE: "close", CENTER: "center", CORNER: "corner",
    radians: (d) => (d * Math.PI) / 180,
    degrees: (r) => (r * 180) / Math.PI,
    hexToRgb: () => ({ r: 0, g: 0, b: 0 }),
    drawingContext: {
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      closePath() {}, clip() {}, fillRect() {}, fillStyle: "",
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => Date.now() },
  }, extra);
  target.window = target;
  target.document = { getElementById: () => null, createElement: () => ({ style: {} }) };

  const sandbox = new Proxy(target, {
    has: () => true,                          // 讓所有識別字看起來都存在
    get: (t, k) => (k in t ? t[k] : stub),    // 未定義者回無害函式
  });
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, ...relPaths) {
  for (const rel of relPaths) {
    const file = path.join(FRONTEND, rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: rel });
  }
  return sandbox;
}

const run = (sandbox, code) => vm.runInContext(code, sandbox);

module.exports = { createSandbox, load, run };
