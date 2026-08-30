/**
 * 拍攝站位引導：把 CV 的判定結果翻成一句給參與者看的話。
 *
 * 這些是純函式，輸入是 backend 的 features（Socket.io 的 clothing_features 或
 * HTTP 的 /api/preview，兩者同形狀），輸出是文字與布林。
 *
 * 為什麼放在 shared/：2D 備援版（frontend/sketch.js）與整合版控制器
 * （public/controller/app.js）走不同的傳輸方式，但引導的判準必須一致 ——
 * 兩份各自演化的話，同一個站姿在兩個入口會得到不同的指示，而且不會有任何
 * 錯誤訊息。
 *
 * ⚠ frontend/sketch.js 目前仍是自己那份副本：那個目錄是 CommonJS 全域腳本
 *   （見 frontend/package.json），沒辦法直接 import 這裡的 ESM。
 *   test/capture-guidance.test.mjs 有一條測試逐項比對兩邊的文案，
 *   任一邊改了而另一邊沒跟上就會失敗。
 */

/**
 * 腳底是否站在基準線上。
 *
 * 四個來源任一成立即可：後端可能在不同欄位回報同一件事，取聯集才不會因為
 * 某個版本少填一個欄位就讓指示燈永遠不亮。
 */
export function heightStationPassed(features) {
  const checks = features?.capture_quality?.capture_checks || {};
  const stationOffset = Number(features?.foot_baseline_offset);
  const stationTolerance = Number(features?.height_station_tolerance ?? 0.10);
  return !!(
    features?.height_station_valid
    || checks.height_station
    || checks.height
    || (Number.isFinite(stationOffset) && stationOffset <= stationTolerance)
  );
}

/** 六項指示燈是否全亮 —— 全亮才可以開始倒數 */
export function allCaptureIndicatorsPassed(features) {
  const checks = features?.capture_quality?.capture_checks || {};
  const rawReady = !!features?.capture_ready_raw;
  const poseOk = checks.pose ?? rawReady;
  const feetOk = checks.feet ?? rawReady;
  const framingOk = checks.framing ?? rawReady;
  const stationOk = heightStationPassed(features);
  const heightOk = !!features?.height_measurement_ready;
  const stableOk = (features?.stability_count || 0) >= (features?.stability_required || 3);
  return !!features?.capture_ready && poseOk && feetOk && framingOk && stationOk && heightOk && stableOk;
}

/** 逐項指示燈的狀態，供 UI 畫成一排燈號 */
export function captureIndicators(features) {
  const checks = features?.capture_quality?.capture_checks || {};
  const rawReady = !!features?.capture_ready_raw;
  return [
    { key: 'pose', label: '姿勢', ok: checks.pose ?? rawReady },
    { key: 'feet', label: '雙腳', ok: checks.feet ?? rawReady },
    { key: 'framing', label: '構圖', ok: checks.framing ?? rawReady },
    { key: 'clarity', label: '清晰', ok: features?.capture_quality?.sharpness_ok ?? true },
    { key: 'station', label: '站位', ok: heightStationPassed(features) },
    { key: 'height', label: '身高', ok: !!features?.height_measurement_ready },
    {
      key: 'stable',
      label: '穩定',
      ok: (features?.stability_count || 0) >= (features?.stability_required || 3),
    },
  ];
}

/**
 * 引導文案。
 *
 * @param {object} features
 * @param {string} readyText 全部就緒時要顯示的話 —— 兩個入口的操作方式不同
 *   （鍵盤 Enter vs 觸控自動倒數），只有這一句需要各自決定。
 */
export function captureGuidanceText(features, readyText = '✓ 全身已入鏡') {
  const reason = features?.guidance_reason || 'person_not_detected';
  const quality = features?.capture_quality || {};

  if (reason === 'ready') return readyText;
  if (reason === 'hold_still') {
    if (heightStationPassed(features) && !features?.height_measurement_ready) {
      return `腳底位置正確，正在確認身高 (${features?.height_sample_count || 0}/${features?.height_samples_required || 3})`;
    }
    return `全身已入鏡，請保持不動 (${features?.stability_count || 0}/${features?.stability_required || 3})`;
  }
  if (reason === 'move_closer') return '人物佔畫面太小，請向前一步';
  // 站位都對了、只是手震或失焦。講「請站穩」而不是「照片模糊」——
  // 前者說得出下一步該做什麼，後者只是把結果重述一次。
  if (reason === 'too_blurry') return '畫面有點晃，請站穩不動再拍一次';
  if (reason === 'align_height_baseline') {
    const offset = Number(features?.foot_baseline_offset ?? quality?.foot_baseline_offset);
    const detail = Number.isFinite(offset) ? `（目前相差 ${(offset * 100).toFixed(1)}%）` : '';
    return `請站在地面腳印，讓雙腳貼近畫面底部基準線${detail}`;
  }
  if (reason === 'show_feet') {
    const sides = quality.missing_foot_sides || [];
    if (sides.length === 1) return sides[0] === 'left' ? '左腳尚未辨識，請露出完整左腳' : '右腳尚未辨識，請露出完整右腳';
    return '左右腳尚未完整辨識，請露出雙腳';
  }
  if (reason === 'body_clipped') {
    const edges = quality.clipped_edges || [];
    if (edges.includes('bottom')) return '腳太靠近畫面底部，請稍微後退';
    if (edges.includes('top')) return '頭頂被裁切，請稍微後退';
    if (edges.includes('left')) return '身體碰到畫面右側，請往左移';
    if (edges.includes('right')) return '身體碰到畫面左側，請往右移';
    return '身體碰到畫面邊緣，請稍微後退';
  }
  if (reason === 'align_with_guide') {
    const issues = quality.alignment_issues || [];
    if (issues.includes('move_screen_left')) return '身體偏右，請往畫面左側移動';
    if (issues.includes('move_screen_right')) return '身體偏左，請往畫面右側移動';
    if (issues.includes('feet_too_high')) return '雙腳位置太高，請向前一步對齊人形腳部';
    if (issues.includes('feet_too_low')) return '雙腳太靠近底部，請稍微後退';
    if (issues.includes('shoulders_too_high')) return '肩膀位置太高，請稍微後退';
    if (issues.includes('shoulders_too_low')) return '請讓肩膀對齊人形肩線';
    if (issues.includes('face_camera')) return '請面向鏡頭並自然站直';
    return '請讓肩膀、髖部與雙腳對齊人形';
  }
  if (reason === 'pose_incomplete') {
    const labels = {
      left_shoulder: '左肩', right_shoulder: '右肩',
      left_hip: '左髖', right_hip: '右髖',
      left_knee: '左膝', right_knee: '右膝',
    };
    const joints = (quality.low_visibility_joints || []).map((item) => labels[item] || item);
    return joints.length ? `${joints.join('、')}辨識不穩，請面向鏡頭` : '肢體偵測不完整，請面向鏡頭';
  }
  if (reason === 'move_inside_guide') return '請將身體移到人形中央';
  if (reason === 'show_full_body') return '請保持全身與雙腳入鏡';
  return '尚未偵測到人物';
}
