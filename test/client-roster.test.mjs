/**
 * 手機端名冊（CLIENT_ROSTER）的重送節流
 *
 * 驗的是一個只在「沒有大螢幕連線」時才出現的故障：
 * 名冊若沿用 stage.rosterDirty 當觸發條件，而該旗標要等主迴圈的
 * 大螢幕區段才清除 —— 那段在 `screens.size === 0` 早退之後 ——
 * 旗標就會一直是 true，名冊變成 30Hz 廣播（實測 2 秒送出 60 次）。
 *
 * 這個情境端對端測試抓不到（scripts/e2e.mjs 全程接著大螢幕），
 * 而「先開手機、投影機還沒接」正是佈場時最常見的狀態。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Stage } from '../server/state.js';

/** 對應 server/index.js 主迴圈裡的名冊指紋計算 */
function rosterSignature(stage) {
  return stage.agents.size
    ? `${stage.agents.size}:${[...stage.agents.values()].map((a) => `${a.id}~${a.name}`).join('|')}`
    : '';
}

/** 重現主迴圈：跑 n 個 tick，回傳實際送出的次數 */
function runTicks(stage, ticks, { hasScreen }) {
  let sig = '';
  let dirty = false;
  let sent = 0;
  for (let i = 0; i < ticks; i++) {
    const now = rosterSignature(stage);
    if (now !== sig) dirty = true;
    if (dirty) { dirty = false; sig = now; sent++; }
    // 大螢幕區段：沒有大螢幕時整段被早退跳過，rosterDirty 因此不會被清
    if (hasScreen) stage.rosterDirty = false;
  }
  return sent;
}

const AVATAR = {
  head: 'head_curly_02', face: 'face_smile_01', body: 'body_shirt_02',
  skinTone: '#F4C08A', accentColor: '#E76F51',
};

describe('CLIENT_ROSTER 重送節流', () => {
  test('成員不變時只送一次 —— 沒有大螢幕連線也一樣', () => {
    const stage = new Stage();
    stage.addAgent({ name: '阿明', avatar: AVATAR });
    // hasScreen: false 正是會踩到 stage.rosterDirty 永遠為 true 的情境
    const sent = runTicks(stage, 90, { hasScreen: false });
    assert.equal(sent, 1,
      `90 個 tick 送了 ${sent} 次 —— 節流依賴了大螢幕才會清除的旗標`);
  });

  test('有大螢幕連線時行為一致', () => {
    const stage = new Stage();
    stage.addAgent({ name: '阿明', avatar: AVATAR });
    assert.equal(runTicks(stage, 90, { hasScreen: true }), 1);
  });

  test('有人加入才會再送一次', () => {
    const stage = new Stage();
    stage.addAgent({ name: '阿明', avatar: AVATAR });
    let sig = rosterSignature(stage);
    stage.addAgent({ name: '小華', avatar: AVATAR });
    assert.notEqual(rosterSignature(stage), sig, '加入新成員後指紋沒變');
  });

  test('有人離場也要重送', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: '阿明', avatar: AVATAR });
    stage.addAgent({ name: '小華', avatar: AVATAR });
    const sig = rosterSignature(stage);
    stage.removeAgent(a.id);
    assert.notEqual(rosterSignature(stage), sig, '離場後指紋沒變，名冊會殘留已走的人');
  });

  test('改名也要重送 —— 指紋要涵蓋名字而不只是人數', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: '阿明', avatar: AVATAR });
    const sig = rosterSignature(stage);
    a.name = '阿明二號';
    assert.notEqual(rosterSignature(stage), sig,
      '指紋只看人數的話，改名不會觸發重送，鄰居標籤會一直是舊名字');
  });

  test('新連線必須另外補送 —— 主迴圈的廣播不涵蓋它', () => {
    // 重連或重整分頁時，場上成員多半沒有變動，指紋因此相同，
    // 主迴圈不會廣播。少了進場當下那一次，該手機的 renderer.names
    // 會一直是空的，鄰居全部沒有名字直到有人進出為止。
    const stage = new Stage();
    stage.addAgent({ name: '阿明', avatar: AVATAR });
    stage.addAgent({ name: '小華', avatar: AVATAR });

    const sig = rosterSignature(stage);
    // 模擬「一支手機重連，但成員組成完全沒變」
    const sigAfterRejoin = rosterSignature(stage);
    assert.equal(sigAfterRejoin, sig,
      '前提：重連不改變名冊內容，因此主迴圈不會廣播');

    // 結論：server/index.js 的 CLIENT_JOIN 兩條路徑都必須呼叫
    // sendClientRoster()，否則這支手機拿不到名冊。
    assert.equal(stage.nameRoster().length, 2,
      'nameRoster 應能隨時取得完整名冊供補送');
  });

  test('nameRoster 只帶 id 與名字，不含捏臉外觀', () => {
    const stage = new Stage();
    stage.addAgent({ name: '阿明', avatar: AVATAR });
    const r = stage.nameRoster();
    assert.deepEqual(Object.keys(r[0]).sort(), ['id', 'name']);
  });
});
