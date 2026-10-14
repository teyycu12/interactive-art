/**
 * 顯示名稱不雅字詞過濾（server/nameFilter.js）
 *
 * 兩個方向都要釘住：擋得下常見的繞法，也不能誤殺正常名字 ——
 * 誤殺一個就是一位參與者進不了場。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isBlockedName } from '../server/nameFilter.js';

describe('顯示名稱過濾', () => {
  test('擋下中英文髒話', () => {
    for (const name of ['幹你娘', '靠北喔', '你是智障', 'fuck', 'Shit', 'BITCH', '王八蛋123']) {
      assert.equal(isBlockedName(name), true, name);
    }
  });

  test('擋下加空白、符號、全形、數字代換的寫法', () => {
    for (const name of ['f u c k', '幹 你 娘', '幹_你.娘', 'ｆｕｃｋ', 'sh1t', 'b!tch', 'f*u*c*k', 'd i c k', '@ss']) {
      assert.equal(isBlockedName(name), true, name);
    }
  });

  test('短英文字只擋整個字', () => {
    assert.equal(isBlockedName('my ass'), true);
    assert.equal(isBlockedName('Dick'), true);
    for (const name of ['Cassie', 'Dickson', 'Essex', 'Peacock', 'Grape', 'Cumin', 'Assistant']) {
      assert.equal(isBlockedName(name), false, name);
    }
  });

  test('不誤殺拼音與日文名字（英文髒字不做子字串比對）', () => {
    for (const name of [
      'Chen Shi Ting', 'Lin Shi Tao', 'Shi Tao', 'Shiting', 'Fu Kai', 'Fukuda', 'Yoshitaka',
      'Cun Ting', 'Scunthorpe', 'Hsu Shih-Ting', 'Shitake', 'Pussycat', 'Sussex', 'Cockburn',
    ]) {
      assert.equal(isBlockedName(name), false, name);
    }
  });

  test('擋下黏在別的字前面的明顯髒話與常見變形', () => {
    for (const name of ['fuckyou', 'FuckingCool', 'bitchass', 'motherfucker', 'shitty', 'bull shit', 'a55']) {
      assert.equal(isBlockedName(name), true, name);
    }
  });

  test('不誤殺含「幹」「屌」「靠」的正常用語與一般名字', () => {
    for (const name of ['幹部小王', '能幹的人', '屌打全場', '靠譜', '阿賓', '小明', 'Amy520', '王小明', '🐱貓貓']) {
      assert.equal(isBlockedName(name), false, name);
    }
  });

  test('非字串一律不擋（交給 sanitizeName 判空）', () => {
    assert.equal(isBlockedName(undefined), false);
    assert.equal(isBlockedName(42), false);
  });
});
