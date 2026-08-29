/**
 * CROSS_TEAM（跨隊配對）任務測試
 *
 * 這個任務存在的理由是解藥：兩隊對抗天然產生敵我意識，若沒有一個
 * 「跨隊才得分」的路徑，兩隊會各自縮成小圈圈 —— 那比不分隊更不破冰。
 *
 * 最重要的一組測試是**防枚舉**：預檢路徑若在「同隊」時直接 return
 * 而不記冷卻，攻擊者可從 SAME_TEAM ↔ NOT_FOUND 的差異反推有效碼，
 * 繞過 claim() 的整套防護。這個漏洞不會有任何症狀，只能靠測試守住。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Stage } from '../server/state.js';
import { MissionBoard } from '../server/missions.js';
import { SocialGraph } from '../server/socialgraph.js';
import { PairingSession } from '../server/pairing.js';
import { MISSION_TYPES, PAIR_ERRORS } from '../shared/protocol.js';
import { randomAvatarConfig } from '../shared/avatars.js';

const mk = () => {
  const stage = new Stage();
  const graph = new SocialGraph();
  const pairing = new PairingSession(graph);
  const missions = new MissionBoard();
  return { stage, graph, pairing, missions };
};
const addPlayer = (stage, pairing, name, team) => {
  const a = stage.addAgent({ name, avatar: randomAvatarConfig(), team });
  pairing.register(a.id);
  return a;
};

/**
 * 重現 server/index.js 的跨隊預檢。
 *
 * 刻意複寫而非匯入：那段邏輯嵌在 WebSocket handler 裡取不出來，
 * 而這組測試要守的是「冷卻該不該記」的規則本身。兩邊若漂移，
 * 這裡的測試會繼續通過而正式路徑破功 —— 因此改動 handlePairClaim 時
 * 必須同步改這裡（與 color-hunt.test.mjs 的作法一致）。
 */
function precheck(ctx, fromId, code, now = Date.now()) {
  const { stage, pairing } = ctx;
  if (pairing.inCooldown(fromId, now)) return { ok: false, reason: PAIR_ERRORS.COOLDOWN };
  const me = stage.get(fromId);
  const target = stage.get(pairing.peekTarget(code, now));
  if (target && me && target.team === me.team) {
    return { ok: false, reason: PAIR_ERRORS.SAME_TEAM };  // 刻意不記冷卻
  }
  if (!target) pairing.noteClaim(fromId, now);
  return { ok: true };
}

describe('任務型別定義', () => {
  test('CROSS_TEAM 已註冊且不需額外參數', () => {
    const spec = MISSION_TYPES.CROSS_TEAM;
    assert.ok(spec, 'CROSS_TEAM 必須存在於 MISSION_TYPES');
    assert.equal(spec.param, undefined, '跨隊條件由伺服器比對，不該要求主辦端填參數');
    assert.ok(spec.crossTeam === true);
  });

  test('發布時不需要 colorFamily', () => {
    const { missions } = mk();
    const r = missions.publish({ type: 'CROSS_TEAM', target: 2 });
    assert.equal(r.ok, true, r.reason);
  });
});

describe('跨隊判定', () => {
  test('同隊會被擋下', () => {
    const ctx = mk();
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const b = addPlayer(ctx.stage, ctx.pairing, 'b', 'A');
    const r = precheck(ctx, a.id, ctx.pairing.codeOf(b.id));
    assert.equal(r.reason, PAIR_ERRORS.SAME_TEAM);
  });

  test('不同隊放行', () => {
    const ctx = mk();
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const b = addPlayer(ctx.stage, ctx.pairing, 'b', 'B');
    assert.equal(precheck(ctx, a.id, ctx.pairing.codeOf(b.id)).ok, true);
  });
});

describe('防枚舉：冷卻規則', () => {
  test('同隊不記冷卻 —— 正當使用者可立刻改找對面的人', () => {
    const ctx = mk();
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const same = addPlayer(ctx.stage, ctx.pairing, 'same', 'A');
    const other = addPlayer(ctx.stage, ctx.pairing, 'other', 'B');
    const now = Date.now();

    precheck(ctx, a.id, ctx.pairing.codeOf(same.id), now);
    assert.equal(ctx.pairing.inCooldown(a.id, now), false, '同隊不該罰冷卻');
    // 馬上改找對面的人要能成功
    assert.equal(precheck(ctx, a.id, ctx.pairing.codeOf(other.id), now).ok, true);
  });

  test('⚠ 查無此碼必須記冷卻 —— 否則可從 SAME_TEAM ↔ NOT_FOUND 反推有效碼', () => {
    const ctx = mk();
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const now = Date.now();

    precheck(ctx, a.id, '0000', now);
    assert.equal(ctx.pairing.inCooldown(a.id, now), true,
      '查無此碼未記冷卻，等於開放無限次試碼');
  });

  test('⚠ 無法靠連續試碼枚舉：第二次起一律被冷卻擋下', () => {
    const ctx = mk();
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const now = Date.now();

    // 模擬攻擊者連續試碼。除第一次外全部應該是 COOLDOWN，
    // 攻擊者因此分不出哪個碼有效。
    const reasons = [];
    for (let i = 0; i < 20; i++) {
      reasons.push(precheck(ctx, a.id, String(i).padStart(4, '0'), now).reason);
    }
    const cooled = reasons.filter((r) => r === PAIR_ERRORS.COOLDOWN).length;
    assert.equal(cooled, 19, `20 次試碼只有 ${cooled} 次被冷卻擋下`);
  });
});

describe('跨隊配對雙方都得分', () => {
  test('confirm 成功後兩人都被記一次進度', () => {
    // 兩隊對抗下，若只有發起方得分，被找的人就沒有配合動機，
    // 兩隊會各自縮成小圈圈 —— 這條測試守的是整個設計的前提。
    const ctx = mk();
    ctx.missions.publish({ type: 'CROSS_TEAM', target: 2 });
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const b = addPlayer(ctx.stage, ctx.pairing, 'b', 'B');

    const claim = ctx.pairing.claim(a.id, ctx.pairing.codeOf(b.id), Date.now(),
      ctx.missions.active.id);
    assert.equal(claim.ok, true, claim.reason);
    const done = ctx.pairing.confirm(b.id, true);
    assert.equal(done.ok, true, done.reason);

    // index.js 的 handlePairConfirm 對 [from, to] 兩邊各 credit 一次
    assert.equal(ctx.missions.credit(done.from, { with: done.to }).count, 1);
    assert.equal(ctx.missions.credit(done.to, { with: done.from }).count, 1);
  });

  test('配對成立後社交圖譜連起兩隊的人', () => {
    const ctx = mk();
    ctx.missions.publish({ type: 'CROSS_TEAM', target: 1 });
    const a = addPlayer(ctx.stage, ctx.pairing, 'a', 'A');
    const b = addPlayer(ctx.stage, ctx.pairing, 'b', 'B');
    ctx.pairing.claim(a.id, ctx.pairing.codeOf(b.id), Date.now(), ctx.missions.active.id);
    ctx.pairing.confirm(b.id, true);
    assert.equal(ctx.graph.connected(a.id, b.id), true);
  });
});
