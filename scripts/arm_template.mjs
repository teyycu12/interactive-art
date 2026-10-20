// scripts/arm_template.py 用：在素體的每一面量出對齊用的基準（bodyAnchors），
// 連同手臂範圍寫成 shared/armTemplate.js。
//   node scripts/arm_template.mjs <資料夾> <輸出檔>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWalkRig, bodyAnchors } from '../shared/walkFrames.js';

const [dir, outFile] = process.argv.slice(2);
const { size, arms } = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const template = {};
for (const view of ['front', 'side', 'back']) {
  const [w, h] = size[view];
  const img = { width: w, height: h, data: new Uint8ClampedArray(readFileSync(join(dir, `${view}.bin`))) };
  const rig = buildWalkRig(img, view, { arms: arms[view] ?? [] });
  template[view] = { ...bodyAnchors(rig.g, view), arms: arms[view] ?? [] };
}
writeFileSync(outFile, `// 由 scripts/arm_template.py 產生，不要手改。
// 生成角色從圖上找不到手時的手臂模板：男生素體（姿勢參考圖）穿長袖外套的手臂範圍，
// 格子座標（每一面的不透明範圍切 90 列），連同對齊用的基準（walkFrames.bodyAnchors）。
export const ARM_TEMPLATE = ${JSON.stringify(template)};
`);
