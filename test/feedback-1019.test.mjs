/**
 * 2026-10-19 試玩回饋的修正：表情與動作、換裝快速套組、操控卡住
 *
 * 執行：node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ACTIONS, EMOJI_EMOTES, MOTION_EMOTES, EMOTE_GLYPH, MOTION_IDS } from '../shared/protocol.js';
import { INPUT_STALE_MS } from '../server/config.js';
import { INPUT_THROTTLE_MS } from '../shared/protocol.js';

test('表情與動作都在伺服器的白名單裡；揮手保留', () => {
  for (const e of [...EMOJI_EMOTES, ...MOTION_EMOTES]) assert.ok(ACTIONS.includes(e.id), e.id);
  assert.ok(ACTIONS.includes('WAVE'));
  assert.equal(new Set(ACTIONS).size, ACTIONS.length, '不能有重複的 id');
});

test('表情有頭上的圖示；角色動作沒有（是角色本身在動）', () => {
  for (const e of EMOJI_EMOTES) assert.equal(EMOTE_GLYPH[e.id], e.glyph);
  for (const m of MOTION_EMOTES) {
    assert.equal(EMOTE_GLYPH[m.id], undefined, `${m.id} 不該畫圖示`);
    assert.ok(MOTION_IDS.has(m.id));
  }
});

test('推桿封包的逾時遠大於手機的發送間隔：正常推桿不會被當成放手', () => {
  assert.ok(INPUT_STALE_MS >= INPUT_THROTTLE_MS * 5, `${INPUT_STALE_MS} vs ${INPUT_THROTTLE_MS}`);
  assert.ok(INPUT_STALE_MS <= 1000, '太長的話，掉了放手封包時角色會自己走很久');
});

test('換裝快速套組用到的部件都在換裝選單裡（manifest 改過時這裡會先發現）', () => {
  const manifest = JSON.parse(readFileSync(new URL('../docs/style_reference/2026q3_pixel_curated/dressup/manifest.json', import.meta.url)));
  const parts = new Map(manifest.parts.map((p) => [p.id, p.category]));
  const app = readFileSync(new URL('../public/controller/app.js', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('const DU_PRESETS'), app.indexOf('function applyDuPreset'));
  const pairs = [...block.matchAll(/(\w+): '(\w+_\w+(?:_\w+)?)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 10, '應該讀得到套組內容');
  for (const [cat, id] of pairs) {
    assert.equal(parts.get(id), cat, `${id} 不在「${cat}」分類裡`);
  }
});
