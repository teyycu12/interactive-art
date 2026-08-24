/**
 * 場景預覽產生器
 *
 * 執行：npm run preview:scene
 * 產出：docs/scene-preview.svg
 *
 * 用途：調整 shared/scene.js 的佈局時，不必啟動伺服器與瀏覽器就能看到結果。
 * rough.js 的 generator API 是純運算、不依賴 DOM，因此可以在 Node 端跑完，
 * 只需把它產生的 ops 轉成 SVG path。
 *
 * ⚠ 這是離線預覽，不是實際渲染路徑。實際大螢幕由 public/screen/scene.js
 *   以 Canvas2D 繪製；兩邊的圖形參數必須保持一致，改動請同步。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZONES, PROPS } from '../shared/scene.js';
import { STAGE } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// roughjs 的 package.json 沒有 "type": "module"，Node 會把 rough.esm.js 當成
// CommonJS 而在 export 語句上報錯。改以 data: URL 動態匯入，繞過副檔名判定。
// （瀏覽器不受影響 —— 它依 import 語句決定模組性，不看副檔名。）
const roughSrc = fs.readFileSync(
  path.join(ROOT, 'node_modules', 'roughjs', 'bundled', 'rough.esm.js'), 'utf8',
);
const rough = (await import(
  `data:text/javascript;base64,${Buffer.from(roughSrc).toString('base64')}`
)).default;

const gen = rough.generator();
const out = [];
const INK = '#2F2A26';

/** rough.js 的 ops 結構轉成 SVG path 的 d 屬性 */
function opsToPath(ops) {
  let d = '';
  for (const op of ops) {
    const p = op.data;
    if (op.op === 'move') d += `M${p[0]} ${p[1]} `;
    else if (op.op === 'lineTo') d += `L${p[0]} ${p[1]} `;
    else if (op.op === 'bcurveTo') d += `C${p[0]} ${p[1]}, ${p[2]} ${p[3]}, ${p[4]} ${p[5]} `;
  }
  return d.trim();
}

function emit(drawable) {
  const o = drawable.options;
  for (const set of drawable.sets) {
    const d = opsToPath(set.ops);
    if (!d) continue;
    if (set.type === 'path') {
      out.push(`<path d="${d}" fill="none" stroke="${o.stroke}" stroke-width="${o.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else if (set.type === 'fillPath') {
      out.push(`<path d="${d}" fill="${o.fill}" stroke="none" fill-rule="evenodd"/>`);
    } else if (set.type === 'fillSketch') {
      out.push(`<path d="${d}" fill="none" stroke="${o.fill}" stroke-width="${o.fillWeight ?? 1}" stroke-linecap="round"/>`);
    }
  }
}

// 以下參數必須與 public/screen/props.js、scene.js 保持一致
const stroke = (seed, extra = {}) => ({
  seed, stroke: INK, strokeWidth: 2.4, roughness: 1.5, bowing: 1.4, ...extra,
});
const filled = (seed, fill, extra = {}) => stroke(seed, {
  fill, fillStyle: 'hachure', fillWeight: 1.6, hachureGap: 6, ...extra,
});
const seedOf = (id) => {
  let s = 0;
  for (const ch of id) s = (s * 31 + ch.charCodeAt(0)) % 100000;
  return s + 1;
};

// ── 底色與網格微點 ──
out.push(`<rect width="${STAGE.width}" height="${STAGE.height}" fill="#FAF8F5"/>`);
for (let y = 32; y < STAGE.height; y += 32) {
  for (let x = 32; x < STAGE.width; x += 32) {
    out.push(`<circle cx="${x}" cy="${y}" r="1.6" fill="#E2DACE"/>`);
  }
}

// ── 功能分區 ──
const labels = [];
for (const z of ZONES) {
  emit(gen.rectangle(z.x, z.y, z.w, z.h, {
    seed: seedOf(z.id), stroke: INK, strokeWidth: 3, roughness: 1.8, bowing: 2,
    fill: z.fill, fillStyle: 'hachure', fillWeight: 2, hachureGap: 14, hachureAngle: -41,
  }));
  labels.push(`<text x="${z.x + 18}" y="${z.y + 40}" font-size="26" font-weight="700" fill="${INK}" opacity="0.72">${z.label}</text>`);
}

// ── 道具 ──
const RENDER = {
  plant(x, y, s) {
    emit(gen.polygon([[x - 22, y + 6], [x + 22, y + 6], [x + 16, y + 40], [x - 16, y + 40]], filled(s, '#C68642')));
    emit(gen.ellipse(x - 16, y - 16, 34, 46, filled(s + 1, '#84A98C')));
    emit(gen.ellipse(x + 16, y - 12, 32, 42, filled(s + 2, '#84A98C')));
    emit(gen.ellipse(x, y - 34, 30, 44, filled(s + 3, '#6E9075')));
    emit(gen.line(x, y + 6, x, y - 24, stroke(s + 4, { strokeWidth: 2 })));
  },
  table(x, y, s) {
    emit(gen.line(x, y - 10, x, y + 34, stroke(s, { strokeWidth: 4 })));
    emit(gen.ellipse(x, y + 38, 44, 14, filled(s + 1, '#D8D0C6')));
    emit(gen.ellipse(x, y - 14, 92, 34, filled(s + 2, '#E9C46A')));
  },
  lowtable(x, y, s) {
    emit(gen.ellipse(x, y, 104, 44, filled(s, '#C68642')));
    emit(gen.line(x - 34, y + 12, x - 34, y + 32, stroke(s + 1, { strokeWidth: 3 })));
    emit(gen.line(x + 34, y + 12, x + 34, y + 32, stroke(s + 2, { strokeWidth: 3 })));
  },
  sofa(x, y, s) {
    emit(gen.rectangle(x - 76, y - 42, 152, 44, filled(s, '#B56576')));
    emit(gen.rectangle(x - 76, y - 6, 152, 38, filled(s + 1, '#C97F8E')));
    emit(gen.rectangle(x - 88, y - 14, 20, 46, filled(s + 2, '#B56576')));
    emit(gen.rectangle(x + 68, y - 14, 20, 46, filled(s + 3, '#B56576')));
    emit(gen.line(x, y - 4, x, y + 30, stroke(s + 4, { strokeWidth: 1.8 })));
  },
  speaker(x, y, s) {
    emit(gen.rectangle(x - 30, y - 62, 60, 104, filled(s, '#6D6875')));
    emit(gen.circle(x, y - 32, 34, stroke(s + 1, { strokeWidth: 2 })));
    emit(gen.circle(x, y + 14, 22, stroke(s + 2, { strokeWidth: 2 })));
  },
};

for (const p of PROPS) RENDER[p.type]?.(p.x, p.y, seedOf(p.id));

// ── 外框 ──
emit(gen.rectangle(6, 6, STAGE.width - 12, STAGE.height - 12, {
  seed: 7, stroke: '#D8D0C6', strokeWidth: 3, roughness: 2.2, bowing: 1.2,
}));

// ── 避障半徑（僅預覽用，實際畫面看不到）──
const rings = PROPS.map((p) =>
  `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="none" stroke="#E9C46A" stroke-width="2" stroke-dasharray="7 7" opacity="0.55"/>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STAGE.width}" height="${STAGE.height}"
  viewBox="0 0 ${STAGE.width} ${STAGE.height}" font-family="system-ui, sans-serif">
${out.join('\n')}
${labels.join('\n')}
<g id="collision-radii">
${rings.join('\n')}
</g>
</svg>`;

const outDir = path.join(ROOT, 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'scene-preview.svg');
fs.writeFileSync(outPath, svg);

console.log(`已產生　${path.relative(ROOT, outPath)}`);
console.log(`　　　　${out.length} 個圖形元素、${ZONES.length} 個分區、${PROPS.length} 件道具`);
console.log('　　　　黃色虛線圈為 Boids 的剛體避障半徑（僅預覽顯示）');
