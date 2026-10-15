import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quizBankToText, parseQuizText, sameQuiz } from '../shared/quizText.js';

const BANK = [
  // 編輯區存進來的形狀：四格選項、留白的格子、正解指在第三格
  { question: '台灣最高的山是？', options: ['雪山', '', '玉山', '合歡山'], correctIndex: 2, durationMs: 20000, talkMs: 10000 },
  { question: 'Boids 不包含哪一條？', options: ['分離', '對齊', '加速', '聚合'], correctIndex: 2, durationMs: 30000, talkMs: 0 },
];

test('匯出再匯入一字不差：留白的選項拿掉、正解跟著對到同一個選項', () => {
  const { items, errors } = parseQuizText(quizBankToText(BANK));
  assert.deepEqual(errors, []);
  assert.deepEqual(items[0], { question: '台灣最高的山是？', options: ['雪山', '玉山', '合歡山'], correctIndex: 1, durationMs: 20000, talkMs: 10000 });
  assert.equal(items[1].options[items[1].correctIndex], '加速');
  assert.equal(items[1].talkMs, 0, '「不討論」也要保留，不能變成沿用表單設定');
  assert.ok(sameQuiz(items[0], BANK[0]));
});

test('手寫的檔案：BOM、Windows 換行、多餘空行、註解、全形冒號與「秒」都吃得下', () => {
  const text = '﻿# 我的題目\r\n\r\n\r\n誰最高？\r\n*小明\r\n小華\r\n時間：15秒\r\n\r\n\r\n第二題\r\n甲\r\n* 乙\r\n';
  const { items, errors } = parseQuizText(text);
  assert.deepEqual(errors, []);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { question: '誰最高？', options: ['小明', '小華'], correctIndex: 0, durationMs: 15000 });
  assert.equal(items[1].correctIndex, 1, '星號後面多一個空白也算');
  assert.equal(items[1].durationMs, undefined, '沒寫時間就不帶，出題時沿用預設');
});

test('壞掉的題目只壞那一題，並說出第幾題、哪裡錯', () => {
  const text = [
    '好題目', '*對', '錯', '',
    '沒標答案', '甲', '乙', '',
    '只有一個選項', '*甲', '',
    '兩個答案', '*甲', '*乙', '',
    '太多選項', '*1', '2', '3', '4', '5', '',
    '時間太長', '*甲', '乙', '時間 999',
  ].join('\n');
  const { items, errors } = parseQuizText(text);
  assert.deepEqual(items.map((q) => q.question), ['好題目']);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /^第 2 題（沒標答案）：沒有標正確答案/);
  assert.match(errors[1], /至少要有 2 個選項/);
  assert.match(errors[2], /不只一個正確答案/);
  assert.match(errors[3], /最多 4 個選項/);
  assert.match(errors[4], /作答時間/);
});

test('選項本身以 * 開頭或長得像設定行時，匯出會跳脫，匯回來不走樣', () => {
  const tricky = [{ question: '#1 哪個是乘號？', options: ['*', '時間 20', '×'], correctIndex: 2 }];
  const { items, errors } = parseQuizText(quizBankToText(tricky));
  assert.deepEqual(errors, []);
  assert.deepEqual(items[0], { question: '#1 哪個是乘號？', options: ['*', '時間 20', '×'], correctIndex: 2 });
});

test('空檔案或只有說明：沒有題目也沒有錯誤', () => {
  assert.deepEqual(parseQuizText(''), { items: [], errors: [] });
  assert.deepEqual(parseQuizText(quizBankToText([])), { items: [], errors: [] });
});
