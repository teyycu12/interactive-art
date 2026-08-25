/**
 * 模組 M2 行為測試
 *
 * 執行：node --test
 *
 * M2 的正確性幾乎全是「時間行為」——α 何時升起、以什麼曲線落下。
 * 這類行為在畫面上只能靠肉眼估算，因此 stepAgent() 刻意把 now 與 dt 設計成
 * 傳入參數而非內部讀取 Date.now()，讓測試能注入模擬時間，精確驗證曲線。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stepAgent } from '../server/arbiter.js';
import { Stage } from '../server/state.js';
import {
  IDLE_THRESHOLD_MS, ALPHA_RAMP_UP_MS, ALPHA_DECAY_MS,
  MAX_SPEED, BOIDS, MAX_AGENTS,
} from '../server/config.js';
import { STAGE } from '../shared/protocol.js';

/** 建立一個乾淨的測試角色，Boids 影子速度歸零以排除隨機漫遊干擾 */
function makeAgent(stage, overrides = {}) {
  const agent = stage.addAgent({
    name: 'T',
    avatar: {
      head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
      accentColor: '#E76F51', skinTone: '#F4A261',
    },
  });
  agent.boidsVx = 0;
  agent.boidsVy = 0;
  Object.assign(agent, overrides);
  return agent;
}

/** 推進 n 個時間步，回傳每步結束時的 α 序列 */
function advance(agent, agents, { steps, dt, startAt }) {
  const alphas = [];
  let now = startAt;
  for (let i = 0; i < steps; i++) {
    now += dt * 1000;
    stepAgent(agent, agents, dt, now);
    alphas.push(agent.alpha);
  }
  return alphas;
}

describe('M2 主動控制權重 α', () => {
  test('偵測到輸入後，於 0.3 秒內線性升至 1.0', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { alpha: 0, lastInputAt: t0 });
    const agents = [agent];

    const dt = 0.01;
    const steps = ALPHA_RAMP_UP_MS / 1000 / dt; // 30 步 = 0.3 秒
    const alphas = advance(agent, agents, { steps, dt, startAt: t0 });

    assert.ok(Math.abs(alphas.at(-1) - 1) < 1e-9, `0.3 秒後 α 應為 1，實得 ${alphas.at(-1)}`);

    // 線性：中點應約為 0.5
    const mid = alphas[steps / 2 - 1];
    assert.ok(Math.abs(mid - 0.5) < 0.02, `升權中點應約 0.5，實得 ${mid}`);
  });

  test('α 不會超過 1.0', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { alpha: 0, lastInputAt: t0 });
    // 持續輸入遠超過 0.3 秒
    const alphas = advance(agent, [agent], { steps: 100, dt: 0.01, startAt: t0 });
    assert.equal(Math.max(...alphas), 1);
  });

  test('閒置未滿 3 秒時仍保持主動控制態', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { alpha: 1, lastInputAt: t0 });
    // 從 t0 起算推進 2.9 秒，尚未跨過閒置門檻
    stepAgent(agent, [agent], 0.03, t0 + IDLE_THRESHOLD_MS - 100);
    assert.equal(agent.alpha, 1, '未達閒置門檻不應開始衰減');
  });

  test('閒置逾 3 秒後，以餘弦曲線在 1.2 秒內衰減回 0', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    // lastInputAt 設在很久以前，使角色一開始就處於閒置狀態
    const agent = makeAgent(stage, { alpha: 1, lastInputAt: t0 - IDLE_THRESHOLD_MS - 1 });
    const agents = [agent];

    const dt = 0.01;
    // 衰減計時器是在「第一個閒置 tick」才啟動的，該 tick 的經過時間為 0。
    // 因此走完完整 1.2 秒需要 (1200/10 + 1) 步，索引 i 對應經過時間 i×10ms。
    const stepMs = dt * 1000;
    const steps = ALPHA_DECAY_MS / stepMs + 1;
    const alphas = advance(agent, agents, { steps, dt, startAt: t0 });
    const atElapsed = (ms) => alphas[ms / stepMs];

    assert.equal(atElapsed(0), 1, '衰減起始 tick 的 α 應仍為 1');
    assert.ok(alphas.at(-1) < 1e-12, `衰減結束後 α 應為 0，實得 ${alphas.at(-1)}`);

    // 餘弦而非線性：半程 α = 0.5·(1+cos(π/2)) = 0.5，與線性相同，
    // 但兩端斜率為 0，故四分之一程處應為 0.5·(1+cos(π/4)) ≈ 0.854，
    // 明顯高於線性的 0.75 —— 這正是交接不被察覺的原因。
    const quarter = atElapsed(ALPHA_DECAY_MS / 4);
    assert.ok(Math.abs(quarter - 0.8536) < 0.01,
      `1/4 程應約 0.854（線性會是 0.75），實得 ${quarter}`);
    const half = atElapsed(ALPHA_DECAY_MS / 2);
    assert.ok(Math.abs(half - 0.5) < 0.01, `半程應約 0.5，實得 ${half}`);

    // 單調遞減
    for (let i = 1; i < alphas.length; i++) {
      assert.ok(alphas[i] <= alphas[i - 1] + 1e-12, `α 應單調遞減，於第 ${i} 步回升`);
    }
  });

  test('衰減途中重新推桿，會從當下權重接續升起而非跳回 1', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { alpha: 1, lastInputAt: t0 - IDLE_THRESHOLD_MS - 1 });

    // 先衰減 0.6 秒（半程）
    let now = t0;
    for (let i = 0; i < 60; i++) { now += 10; stepAgent(agent, [agent], 0.01, now); }
    const midAlpha = agent.alpha;
    assert.ok(midAlpha > 0.2 && midAlpha < 0.8, `半程 α 應在 0.2~0.8，實得 ${midAlpha}`);

    // 重新推桿一步：α 應上升且未跳到 1
    agent.lastInputAt = now;
    now += 10;
    stepAgent(agent, [agent], 0.01, now);
    assert.ok(agent.alpha > midAlpha, 'α 應開始回升');
    assert.ok(agent.alpha < 1, 'α 不應瞬間跳回 1');
    assert.equal(agent.decayStartAt, null, '重新接手後應清除衰減起點');
  });
});

describe('M2 速度合成公式 V_final = (1-α)·V_Boids + α·V_Manual', () => {
  test('α = 1 時完全採用手動速度', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, {
      // 座標固定在空地：spawnPoint() 是隨機的，剛好生在道具旁時繞行力會
      // 介入速度，讓這裡的精確相等斷言偶發失敗（與合成公式本身無關）。
      x: 900, y: 750,
      alpha: 1, lastInputAt: t0,
      inputX: 1, inputY: 0, inputIntensity: 1,
      boidsVx: 999, boidsVy: 999, // 蓄意設成極端值，若有洩漏必然被測出
    });
    // 手動速度有一階低通（MANUAL_SMOOTH_TAU），單步到不了終值 ——
    // 推進足夠時間讓它收斂，驗的是「α=1 時速度完全由手動決定」，
    // 而不是「第一幀就滿速」。平滑的理由見 arbiter.js：輸入方向是單位
    // 向量，沒有平滑的話回中時的手指抖動會變成全速的方向反轉。
    let now = t0;
    for (let i = 0; i < 60; i++) { now += 16; stepAgent(agent, [agent], 0.016, now); }
    assert.ok(Math.abs(agent.vx - MAX_SPEED) < 0.5, `vx 應收斂到 MAX_SPEED，實得 ${agent.vx}`);
    assert.ok(Math.abs(agent.vy) < 0.5, `vy 應為 0，實得 ${agent.vy}`);
  });

  test('α = 1 時推桿強度按比例縮放速度', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, {
      x: 900, y: 750, // 同上，固定在空地
      alpha: 1, lastInputAt: t0,
      inputX: 1, inputY: 0, inputIntensity: 0.5,
    });
    let now = t0;
    for (let i = 0; i < 60; i++) { now += 16; stepAgent(agent, [agent], 0.016, now); }
    assert.ok(Math.abs(agent.vx - MAX_SPEED * 0.5) < 0.5, `半推應收斂到半速，實得 ${agent.vx}`);
  });

  test('α = 0 時完全採用 Boids 速度，手動輸入不生效', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, {
      x: 900, y: 750, // 同上，固定在空地
      alpha: 0,
      lastInputAt: t0 - IDLE_THRESHOLD_MS - 1,
      decayStartAt: t0 - ALPHA_DECAY_MS * 2, // 已完成衰減
      decayFrom: 0,
      inputX: 1, inputY: 0, inputIntensity: 1,
    });
    stepAgent(agent, [agent], 0.016, t0);
    assert.equal(agent.alpha, 0);
    assert.equal(agent.vx, agent.boidsVx, '應完全等於 Boids 速度');
    assert.equal(agent.vy, agent.boidsVy);
  });
});

describe('M2 Boids 群體動力學', () => {

  test('角色永遠不會離開場域邊界', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    // 貼著右下角，並持續以最大強度往場外推
    const agent = makeAgent(stage, {
      x: STAGE.width - 10, y: STAGE.height - 10,
      inputX: 1, inputY: 1, inputIntensity: 1,
    });

    let now = t0;
    for (let i = 0; i < 300; i++) {
      now += 33;
      agent.lastInputAt = now; // 維持在主動控制態，測試最嚴苛的情境
      stepAgent(agent, [agent], 0.033, now);
      assert.ok(agent.x >= 0 && agent.x <= STAGE.width, `x 越界：${agent.x}`);
      assert.ok(agent.y >= 0 && agent.y <= STAGE.height, `y 越界：${agent.y}`);
    }
  });

  test('速度不超過 MAX_SPEED', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agents = [];
    // 綁在 MAX_AGENTS 上而非寫死：這裡要的是「一群角色互相影響」，
    // 具體幾個不重要，但超過場域上限時 addAgent 會回 null（曾寫死 12，
    // 上限降到 10 時整組測試以 TypeError 失敗）。
    for (let i = 0; i < MAX_AGENTS; i++) {
      agents.push(makeAgent(stage, {
        x: 900 + (i % 4) * 30, y: 500 + Math.floor(i / 4) * 30, lastInputAt: 0,
      }));
    }
    let now = t0;
    for (let i = 0; i < 200; i++) {
      now += 33;
      for (const ag of agents) {
        stepAgent(ag, agents, 0.033, now);
        const speed = Math.hypot(ag.vx, ag.vy);
        assert.ok(speed <= MAX_SPEED + 1e-6, `速度超限：${speed}`);
      }
    }
  });

});

describe('M2 斷線處理', () => {
  test('斷線寬限期內不視為離線', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { alpha: 1, lastInputAt: t0, disconnectedAt: t0 });
    stepAgent(agent, [agent], 0.016, t0 + 1000); // 才過 1 秒，未達 2 秒寬限
    assert.equal(agent.offline, false);
    assert.equal(agent.alpha, 1, '寬限期內應維持原控制權');
  });

  test('斷線逾 2 秒後標記離線並交還給 Boids', () => {
    const stage = new Stage();
    const t0 = 1_000_000;
    const agent = makeAgent(stage, { alpha: 1, lastInputAt: t0, disconnectedAt: t0 });
    stepAgent(agent, [agent], 0.016, t0 + 2500);
    assert.equal(agent.offline, true, '應標記為離線');
    assert.ok(agent.decayStartAt !== null, '應已進入衰減');
  });
});

describe('資料驗證', () => {
  test('搖桿向量會被正規化，超長向量不會造成超速', () => {
    const stage = new Stage();
    const agent = makeAgent(stage);
    stage.applyMove(agent.id, { x: 100, y: 0, intensity: 1 });
    assert.ok(Math.abs(agent.inputX - 1) < 1e-9, '方向應正規化為單位長度');
    assert.equal(agent.inputY, 0);
  });

  test('低於死區的推桿強度不算主動操控', () => {
    const stage = new Stage();
    const agent = makeAgent(stage, { lastInputAt: 0 });
    stage.applyMove(agent.id, { x: 1, y: 0, intensity: 0.02 });
    assert.equal(agent.inputIntensity, 0, '死區內強度應歸零');
    assert.equal(agent.lastInputAt, 0, '死區內不應重置閒置計時器');
  });

  test('社交動作有冷卻時間，防止洗版', () => {
    const stage = new Stage();
    const agent = makeAgent(stage);
    assert.equal(stage.applyAction(agent.id, 'CHEERS'), true);
    assert.equal(stage.applyAction(agent.id, 'CHEERS'), false, '冷卻期內應被拒絕');
  });

  test('STAGE_SYNC 快照不含捏臉外觀，以節省廣播頻寬', () => {
    const stage = new Stage();
    makeAgent(stage);
    const snap = stage.snapshot()[0];
    assert.equal(snap.avatar, undefined);
    assert.ok('alpha' in snap && 'mode' in snap && 'state' in snap);
  });
});
