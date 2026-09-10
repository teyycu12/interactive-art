/**
 * 站位引導文案測試。
 *
 * 這些文字是參與者唯一會看到的東西 —— 判定再準，話說錯了現場一樣站不對。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  allCaptureIndicatorsPassed, captureGuidanceText, captureIndicators, heightStationPassed,
} from '../shared/capture-guidance.js';

const READY = {
  capture_ready: true, capture_ready_raw: true,
  height_measurement_ready: true, height_station_valid: true,
  stability_count: 3, stability_required: 3,
  capture_quality: { capture_checks: { pose: true, feet: true, framing: true } },
};

describe('引導文案', () => {
  const cases = [
    ['move_closer', {}, '人物佔畫面太小，請向前一步'],
    ['show_feet', { missing_foot_sides: ['left'] }, '左腳尚未辨識，請露出完整左腳'],
    ['show_feet', { missing_foot_sides: ['right'] }, '右腳尚未辨識，請露出完整右腳'],
    ['show_feet', { missing_foot_sides: [] }, '左右腳尚未完整辨識，請露出雙腳'],
    ['body_clipped', { clipped_edges: ['bottom'] }, '腳太靠近畫面底部，請稍微後退'],
    ['body_clipped', { clipped_edges: ['top'] }, '頭頂被裁切，請稍微後退'],
    ['align_with_guide', { alignment_issues: ['face_camera'] }, '請面向鏡頭並自然站直'],
    ['move_inside_guide', {}, '請將身體移到人形中央'],
    ['show_full_body', {}, '請保持全身與雙腳入鏡'],
  ];
  for (const [reason, quality, expected] of cases) {
    test(`${reason} → ${expected}`, () => {
      assert.equal(captureGuidanceText({ guidance_reason: reason, capture_quality: quality }), expected);
    });
  }

  test('未偵測到人時有預設文案', () => {
    assert.equal(captureGuidanceText({}), '尚未偵測到人物');
  });

  test('hold_still 顯示穩定度進度', () => {
    assert.equal(
      captureGuidanceText({ guidance_reason: 'hold_still', stability_count: 2, stability_required: 3 }),
      '全身已入鏡，請保持不動 (2/3)',
    );
  });

  test('站位已對但身高還在量時，改說身高進度', () => {
    // 兩件事都在「保持不動」階段，但參與者需要知道系統在等哪一個
    const text = captureGuidanceText({
      guidance_reason: 'hold_still', height_station_valid: true,
      height_measurement_ready: false, height_sample_count: 1, height_samples_required: 3,
    });
    assert.equal(text, '腳底位置正確，正在確認身高 (1/3)');
  });

  test('就緒文案由呼叫端決定（鍵盤與觸控的操作不同）', () => {
    assert.equal(captureGuidanceText({ guidance_reason: 'ready' }, '準備拍攝'), '準備拍攝');
  });
});

describe('指示燈', () => {
  test('全部就緒時六盞全亮', () => {
    assert.ok(captureIndicators(READY).every((i) => i.ok));
    assert.equal(allCaptureIndicatorsPassed(READY), true);
  });

  test('少一項就不得開始倒數', () => {
    for (const patch of [
      { capture_ready: false },
      { height_measurement_ready: false },
      { stability_count: 2 },
      { height_station_valid: false, capture_quality: { capture_checks: { pose: true, feet: true, framing: true } } },
      { capture_quality: { capture_checks: { pose: false, feet: true, framing: true } } },
    ]) {
      assert.equal(allCaptureIndicatorsPassed({ ...READY, ...patch }), false,
        `${JSON.stringify(patch)} 的情況下不該判定為就緒`);
    }
  });

  test('腳底基準線：容差內即算通過', () => {
    assert.equal(heightStationPassed({ foot_baseline_offset: 0.05, height_station_tolerance: 0.10 }), true);
    assert.equal(heightStationPassed({ foot_baseline_offset: 0.20, height_station_tolerance: 0.10 }), false);
  });
});
