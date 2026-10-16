/**
 * 活動配方範本（shared/recipes.js）
 *
 * 範本是寫死的資料，壞掉時不會報錯 —— 主辦端按「下一項」才被伺服器拒絕，
 * 而那時主持人已經對著全場說「接下來……」。這裡在出貨前把每一步驗一遍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECIPES, recipesForTheme } from '../shared/recipes.js';
import { EV, MISSION_TYPES, MISSION_DURATIONS } from '../shared/protocol.js';
import { WORDCLOUD } from '../shared/wordcloud.js';
import { SELECTABLE_THEMES, THEME_MAP } from '../shared/themes.js';

const KINDS = new Set(['mission', 'wordcloud', 'bingo', 'photo']);

test('每個可選的場景都至少有一套範本', () => {
  for (const t of SELECTABLE_THEMES) assert.ok(recipesForTheme(t.id).length > 0, t.id);
});

test('範本只綁在真的存在的場景上', () => {
  for (const r of RECIPES) if (r.theme !== null) assert.ok(THEME_MAP[r.theme], r.id);
});

test('每一步的訊息型別都存在、種類認得', () => {
  const types = new Set(Object.values(EV));
  for (const r of RECIPES) {
    for (const step of r.steps) {
      assert.ok(KINDS.has(step.kind), `${r.id}: ${step.kind}`);
      assert.ok(types.has(step.msg.type), `${r.id}: ${step.msg.type}`);
      assert.ok(step.label && !step.label.includes('undefined'), `${r.id}: ${step.label}`);
    }
  }
});

test('文字雲題目非空、在長度上限內（伺服器會照同一個上限拒絕）', () => {
  for (const r of RECIPES) {
    for (const step of r.steps.filter((s) => s.kind === 'wordcloud')) {
      const q = step.msg.question;
      assert.ok(typeof q === 'string' && q.trim().length > 0, r.id);
      assert.ok([...q].length <= WORDCLOUD.maxQuestionLength, `${r.id}: ${q}`);
    }
  }
});

test('任務型別、次數、時長都在主辦端表單選得到的範圍內', () => {
  for (const r of RECIPES) {
    for (const step of r.steps.filter((s) => s.kind === 'mission')) {
      const t = MISSION_TYPES[step.msg.missionType];
      assert.ok(t, step.msg.missionType);
      assert.ok(step.msg.target >= 1 && step.msg.target <= t.maxTarget);
      assert.ok(MISSION_DURATIONS.includes(step.msg.durationMs), `${r.id}: ${step.msg.durationMs}`);
    }
  }
});

test('範本不含大合照：時機由主持人看現場決定，用側欄的按鈕拍', () => {
  for (const r of RECIPES) assert.ok(!r.steps.some((s) => s.kind === 'photo'), r.id);
});
