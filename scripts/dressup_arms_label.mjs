// scripts/dressup_arms.py 用：對每一面跑大螢幕的走路分析（shared/walkFrames.js），
// 輸出手臂佔了哪些格，以及格子在圖上的位置。
//   node scripts/dressup_arms_label.mjs <資料夾>
// 資料夾裡要有 meta.json（[{id, front: [w, h], side, back}]）與 <id>_<面>.bin（RGBA 原始位元組）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWalkRig } from '../shared/walkFrames.js';

const dir = process.argv[2];
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const load = (id, v, [w, h]) => ({ width: w, height: h, data: new Uint8ClampedArray(readFileSync(join(dir, `${id}_${v}.bin`))) });
const out = {};
for (const m of meta) {
  // 側面與背面找手要用正面量到的膚色與手掌高度（與大螢幕 spriteCache 同一個順序）
  const front = buildWalkRig(load(m.id, 'front', m.front), 'front', { skin: null });
  out[m.id] = {};
  for (const v of ['front', 'side', 'back']) {
    const rig = v === 'front' ? front
      : buildWalkRig(load(m.id, v, m[v]), v, { skin: front.skin, body: { handRow: front.handRow ?? null } });
    const arms = [];
    rig.regions.forEach((R, i) => {
      if (!/^arm/.test(R.name)) return;
      const cells = [];
      for (let r = 0; r < rig.g.height; r++) {
        for (let c = 0; c < rig.g.width; c++) if (rig.label[r * rig.g.width + c] === i) cells.push([r, c]);
      }
      arms.push({ name: R.name, cells });
    });
    out[m.id][v] = { x0: rig.g.x0, y0: rig.g.y0, cell: rig.g.cell, arms };
  }
}
writeFileSync(join(dir, 'labels.json'), JSON.stringify(out));
