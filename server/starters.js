/**
 * 預設角色（備援，REVIEW-2026-11-15 E3）。
 *
 * 手機端的「自己換裝」要靠 Python 生成服務組角色，它一掛，新來的人全部卡在門口。
 * scripts/make_starters.py 預先用換裝管線組好 6 個角色放進 public/assets/starters/（進版控；
 * 不是照任何人的臉畫的），生成服務沒回應時手機改成「從這幾個裡選一個先進場」。
 *
 * 貼圖網址只認 /assets/gen/<id>/（shared/avatars.js 的 TEXTURE_URL_RE），所以開機時
 * 把它們複製過去 —— 跟固定 NPC 同一套做法。
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateAvatarConfig } from '../shared/avatars.js';

const ASSET_ID = /^[0-9a-f]{32}$/;

/**
 * 把 starters/ 複製到 gen/（缺的才複製）。讀不到、複製失敗都不是錯：沒有預設角色而已
 * @returns {{id: string, label: string, base: string, avatar: object}[]} 驗證過、可以直接進場的角色
 */
export function loadStarters(publicDir) {
  const dir = path.join(publicDir, 'assets', 'starters');
  const gen = path.join(publicDir, 'assets', 'gen');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return []; }
  const out = [];
  for (const s of Array.isArray(manifest?.starters) ? manifest.starters : []) {
    if (typeof s?.id !== 'string' || !ASSET_ID.test(s.id)) continue;
    const dest = path.join(gen, s.id);
    if (!fs.existsSync(path.join(dest, 'full.webp'))) {
      try { fs.cpSync(path.join(dir, s.id), dest, { recursive: true }); } catch (err) {
        console.warn(`[starters] ${s.id} 複製失敗：${err.message}`);
        continue;
      }
    }
    const textures = Object.fromEntries(
      ['head', 'torso', 'legs', 'full', 'side', 'back'].map((p) => [p, `/assets/gen/${s.id}/${p}.webp`]),
    );
    // 一律過進場同一道驗證：manifest 被手動改壞的話，那一個就不列，不會等到有人選了才進場失敗
    const v = validateAvatarConfig({
      source: 'CV', textures, fallbackColors: s.fallbackColors,
      ...(Array.isArray(s.outfitColors) && { outfitColors: s.outfitColors }),
    });
    if (!v.ok) { console.warn(`[starters] ${s.id} 不合法，略過：${v.reason}`); continue; }
    out.push({ id: s.id, label: String(s.label ?? ''), base: String(s.base ?? ''), avatar: v.value });
  }
  return out;
}
