/**
 * 大合照名冊組裝測試
 *
 * 合照流程橫跨兩個語言：Node 決定「誰在場、站在哪」，Python 負責繪製。
 * 交接處是那份名冊 —— 這裡驗的是它的形狀，因為兩邊對不上時
 * 兩端都不會報錯，只會畫出一張少了人或位置錯亂的合照。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Stage } from '../server/state.js';
import { STAGE } from '../shared/protocol.js';

const BUILDER_AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

const CV_AVATAR = {
  source: 'CV',
  textures: {
    head: '/assets/gen/aid1/head.png',
    torso: '/assets/gen/aid1/torso.png',
    legs: '/assets/gen/aid1/legs.png',
  },
  fallbackColors: {
    hair: '#4A2C1A', skin: '#F4C08A', torso: '#8FA05E', legs: '#B7A98A',
  },
};

/** server/index.js 的 photoRoster() 邏輯，抽出來供測試驗證形狀 */
function photoRoster(stage) {
  const byId = new Map(stage.roster().map((a) => [a.id, a]));
  return stage.snapshot().map((s) => {
    const meta = byId.get(s.id) || {};
    const avatar = meta.avatar || {};
    const out = { id: s.id, name: meta.name || '', x: s.x, y: s.y };
    const head = avatar.textures?.head;
    if (typeof head === 'string') out.fullPng = head.replace(/\/head\.png$/, '/full.png');
    if (avatar.fallbackColors) {
      out.outfit = {
        inner_color: avatar.fallbackColors.torso,
        lower_color: avatar.fallbackColors.legs,
      };
      out.face = {
        skin_tone: avatar.fallbackColors.skin,
        hair_color: avatar.fallbackColors.hair,
      };
    }
    return out;
  });
}

describe('大合照名冊', () => {
  test('CV 角色帶出同目錄的未切片全身圖', () => {
    const stage = new Stage();
    stage.addAgent({ name: '掃描客', avatar: CV_AVATAR });
    const [row] = photoRoster(stage);
    assert.equal(row.fullPng, '/assets/gen/aid1/full.png');
  });

  test('只替換結尾的 head.png，不動路徑中的其他片段', () => {
    const stage = new Stage();
    stage.addAgent({
      name: 'x',
      avatar: { ...CV_AVATAR, textures: { ...CV_AVATAR.textures, head: '/assets/gen/head/head.png' } },
    });
    const [row] = photoRoster(stage);
    assert.equal(row.fullPng, '/assets/gen/head/full.png', '目錄名叫 head 時不可被誤改');
  });

  test('捏臉角色沒有生成圖，但帶著色碼供程式化繪製', () => {
    const stage = new Stage();
    stage.addAgent({ name: '捏臉客', avatar: BUILDER_AVATAR });
    const [row] = photoRoster(stage);
    assert.equal(row.fullPng, undefined, '捏臉角色不該有 fullPng');
  });

  test('CV 角色同時帶色碼，貼圖讀不到時仍畫得出來', () => {
    const stage = new Stage();
    stage.addAgent({ name: 'x', avatar: CV_AVATAR });
    const [row] = photoRoster(stage);
    assert.equal(row.face.skin_tone, '#F4C08A');
    assert.equal(row.outfit.inner_color, '#8FA05E');
  });

  test('兩種來源的賓客同框，人數不因來源而少', () => {
    const stage = new Stage();
    stage.addAgent({ name: 'a', avatar: CV_AVATAR });
    stage.addAgent({ name: 'b', avatar: BUILDER_AVATAR });
    assert.equal(photoRoster(stage).length, 2);
  });

  test('每一列都帶著場上座標', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: 'a', avatar: BUILDER_AVATAR });
    a.x = 640; a.y = 320;
    const [row] = photoRoster(stage);
    assert.equal(typeof row.x, 'number');
    assert.equal(typeof row.y, 'number');
    assert.ok(row.x >= 0 && row.x <= STAGE.width);
  });

  test('空場回傳空陣列而不是拋錯', () => {
    assert.deepEqual(photoRoster(new Stage()), []);
  });
});

describe('合照定位', () => {
  test('原地定住：目標座標等於當下座標，不重排隊形', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: 'a', avatar: BUILDER_AVATAR });
    a.x = 300; a.y = 700;
    const snap = stage.snapshot();
    stage.lockStage(new Map(snap.map((s) => [s.id, { x: s.x, y: s.y, heading: Math.PI / 2 }])));
    assert.equal(a.targetX, 300);
    assert.equal(a.targetY, 700);
  });

  test('全部轉向鏡頭', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: 'a', avatar: BUILDER_AVATAR });
    stage.lockStage(new Map([[a.id, { x: a.x, y: a.y, heading: Math.PI / 2 }]]));
    assert.equal(a.targetHeading, Math.PI / 2);
  });

  test('解鎖後角色重新加入人群', () => {
    const stage = new Stage();
    const a = stage.addAgent({ name: 'a', avatar: BUILDER_AVATAR });
    stage.lockStage(new Map([[a.id, { x: 100, y: 100, heading: 0 }]]));
    assert.equal(stage.locked, true);
    stage.unlockStage();
    assert.equal(stage.locked, false);
    assert.equal(a.targetX, null);
    assert.equal(a.targetHeading, null);
  });
});
