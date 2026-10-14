/**
 * 色塊上的文字讀不讀得出來
 *
 * 問答選項是「文字壓在彩色底上」，而且是現場沒有第二來源的資訊。
 * 原本一律白字：問答 C 的黃底只有 1.67:1。
 * 對比問題不會報錯、本機室內看也還好，只有在場地強光下才會咬人
 * （見 docs/notes/UI-STYLING.md），所以用測試釘住。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { QUIZ_CHOICES } from '../shared/protocol.js';

const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const INK = '#2F2A26';
const WHITE = '#FFFFFF';
// 這些字都是 16px 粗體以上（手機問答 16px、大螢幕 25px），屬於 WCAG 的大字：3:1
const LARGE_TEXT = 3;

for (const [name, list] of [['問答選項', QUIZ_CHOICES]]) {
  describe(name, () => {
    for (const item of list) {
      const id = item.label ?? item.id;
      test(`${id}（${item.color}）的字色讀得出來`, () => {
        assert.ok(item.ink, '每一格都要指定字色，不能靠 CSS 預設的白字');
        const r = ratio(item.ink, item.color);
        assert.ok(r >= LARGE_TEXT, `${item.ink} 壓在 ${item.color} 上只有 ${r.toFixed(2)}:1`);
      });

      test(`${id}（${item.color}）選的是深字與白字中較清楚的那個`, () => {
        const best = ratio(INK, item.color) >= ratio(WHITE, item.color) ? INK : WHITE;
        assert.equal(item.ink.toUpperCase(), best);
      });
    }
  });
}
