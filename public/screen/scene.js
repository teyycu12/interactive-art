/**
 * 模組 M3 — 手繪風格場景（技術文件 §手繪風格場景管線）
 *
 * ⚠ 效能與觀感的關鍵決定：靜態場景只渲染一次到離屏 canvas，之後每幀貼圖。
 *
 *   rough.js 每次呼叫都會重新產生隨機化的路徑資料。若逐幀重繪整個場景，
 *   除了 CPU 成本高，畫面還會「沸騰」—— 手繪抖動每一幀都不一樣，
 *   觀感會變成雜訊而非手繪。場景是靜態的，本來就沒有理由重畫。
 *
 *   角色是唯一需要逐幀重繪的東西，見 character.js。
 *
 * 技術選型說明：技術文件寫的是 p5.js + rough.js，此處使用原生 Canvas2D
 * + rough.js。rough.js 本來就直接操作 Canvas2D context、不需要 p5；
 * 而渲染管線（座標映射、內插、Y 軸排序）已為本專案量身寫好，
 * 改用 p5 需要重寫且多引入約 1MB，對現場筆電並不划算。
 */

import rough from '/vendor/rough.esm.js';
import { STAGE } from '/shared/protocol.js';
import { ZONES, PROPS } from '/shared/scene.js';
import { drawProp } from './props.js';

const PAPER = '#FAF8F5';
const INK = '#2F2A26';
const DOT = '#E2DACE';

/**
 * 建立場景圖層。
 * @param {number} scale 邏輯座標到 CSS 像素的縮放
 * @param {number} dpr   裝置像素比
 * @returns {HTMLCanvasElement} 已完成繪製的離屏 canvas
 */
export function buildScene(scale, dpr) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(STAGE.width * scale * dpr);
  canvas.height = Math.ceil(STAGE.height * scale * dpr);

  const ctx = canvas.getContext('2d');
  // 先設好變換，後續一律以邏輯座標作畫；rough.js 取用同一個 context，
  // 因此它畫出來的線條也會一併縮放
  ctx.scale(scale * dpr, scale * dpr);

  const rc = rough.canvas(canvas);

  drawBackground(ctx);
  for (const zone of ZONES) drawZone(rc, ctx, zone);
  for (const prop of PROPS) drawProp(rc, prop);
  drawBorder(rc);

  return canvas;
}

/** 米白底色 + 網格微點 */
function drawBackground(ctx) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, STAGE.width, STAGE.height);

  ctx.fillStyle = DOT;
  const gap = 32;
  for (let y = gap; y < STAGE.height; y += gap) {
    for (let x = gap; x < STAGE.width; x += gap) {
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * 功能分區：帶手繪顫線的幾何色塊。
 * seed 由分區 id 推導，確保每次重建場景（例如視窗縮放）的抖動完全一致，
 * 否則調整視窗大小時場景會突然「換一種手感」。
 */
function drawZone(rc, ctx, zone) {
  let seed = 0;
  for (const ch of zone.id) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;

  rc.rectangle(zone.x, zone.y, zone.w, zone.h, {
    seed: seed + 1,
    stroke: INK,
    strokeWidth: 3,
    roughness: 1.8,
    bowing: 2,
    fill: zone.fill,
    fillStyle: 'hachure',
    fillWeight: 2,
    hachureGap: 14,
    hachureAngle: -41,
  });

  // 分區標籤置於左上角，留在色塊內側
  ctx.save();
  ctx.font = '700 26px "Noto Sans TC", "PingFang TC", system-ui, sans-serif';
  ctx.fillStyle = INK;
  ctx.textBaseline = 'top';
  ctx.globalAlpha = 0.72;
  ctx.fillText(zone.label, zone.x + 18, zone.y + 14);
  ctx.restore();
}

/** 場域外框，讓投影邊界在畫面上是明確的 */
function drawBorder(rc) {
  rc.rectangle(6, 6, STAGE.width - 12, STAGE.height - 12, {
    seed: 7,
    stroke: '#D8D0C6',
    strokeWidth: 3,
    roughness: 2.2,
    bowing: 1.2,
  });
}
