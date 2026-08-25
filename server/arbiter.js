/**
 * 模組 M2（上半）— 半自主共治仲裁器 (Shared Agency Arbiter)
 *
 * 這是整個系統要解決的核心矛盾：
 *   純手動 → 現場有人掛機，畫面死寂；
 *   純自動 → 使用者沒有掌控感，淪為觀看。
 *
 * 解法是不做二選一的硬切換，而是讓兩種控制權以連續權重 α 共存：
 *
 *     V_final = (1 - α) · V_Boids + α · V_Manual
 *
 * α 的時間行為刻意設計成非對稱：
 *   - 升起要「快而線性」（0.3 秒）—— 使用者一推搖桿就必須立刻感到回應，
 *     任何緩啟動都會被知覺為延遲，直接破壞掌控感。
 *   - 落下要「慢而餘弦」（1.2 秒，起訖點斜率皆為 0）—— 放開搖桿時若線性
 *     衰減，交接瞬間會出現速度的一階不連續，觀眾看得出「角色被接管了」。
 *     餘弦曲線讓交接在視覺上無法察覺。
 */

import {
  IDLE_THRESHOLD_MS, ALPHA_RAMP_UP_MS, ALPHA_DECAY_MS,
  DISCONNECT_GRACE_MS, MAX_SPEED, WALK_THRESHOLD,
  ARRIVE, HEADING_TURN_RATE, IDLE_MOTION, FACING_FLIP_SPEED, FACING_DWELL_MS,
  MANUAL_SMOOTH_TAU,
} from './config.js';
import { STAGE, AGENT_STATE, AGENT_MODE } from '../shared/protocol.js';
import { integrateBoids, resolveObstacleOverlap, obstacleAvoidance } from './boids.js';

/**
 * 更新主動控制權重 α。
 * @returns {boolean} 該角色目前是否處於離線狀態（供大螢幕顯示離線符號）
 */
function updateAlpha(agent, now, dt) {
  // 斷線寬限期內仍視為在線，避免現場網路瞬斷造成角色抽搐（§6 風險 1）
  const offline = agent.disconnectedAt !== null
    && now - agent.disconnectedAt > DISCONNECT_GRACE_MS;

  const idleMs = now - agent.lastInputAt;
  const engaged = !offline && idleMs < IDLE_THRESHOLD_MS;

  if (engaged) {
    // 主動控制態：線性升權。以「全程 0.3 秒」為基準，
    // 因此從衰減途中被打斷時，剩餘距離所需時間會等比縮短。
    agent.alpha = Math.min(1, agent.alpha + (dt * 1000) / ALPHA_RAMP_UP_MS);
    agent.decayStartAt = null;
  } else {
    // 湧現漫遊態：餘弦衰減。記錄衰減起點的 α 值，
    // 讓中途才被放開的角色也能從當下權重平滑歸零，而非跳回 1 再衰減。
    if (agent.decayStartAt === null) {
      agent.decayStartAt = now;
      agent.decayFrom = agent.alpha;
    }
    const t = Math.min(1, (now - agent.decayStartAt) / ALPHA_DECAY_MS);
    agent.alpha = agent.decayFrom * 0.5 * (1 + Math.cos(Math.PI * t));
  }
  return offline;
}

/** 沿最短路徑轉向目標角度，每步的轉幅受 rate 限制 */
function turnToward(current, desired, maxStep) {
  let diff = desired - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxStep) return desired;
  return current + Math.sign(diff) * maxStep;
}

/**
 * 抵達式轉向（arrive）：朝目標前進，並在接近時線性減速。
 *
 * 刻意使用速度而非受力控制。合照需要的是「可預期地停在指定位置」，
 * 受力控制會有慣性超調，角色會滑過定位再折返，觀感像沒站穩。
 *
 * @returns {{vx:number, vy:number, arrived:boolean}}
 */
function arriveVelocity(agent) {
  const dx = agent.targetX - agent.x;
  const dy = agent.targetY - agent.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= ARRIVE.epsilon) return { vx: 0, vy: 0, arrived: true };

  const speed = MAX_SPEED * Math.min(1, dist / ARRIVE.slowRadius);
  return { vx: (dx / dist) * speed, vy: (dy / dist) * speed, arrived: false };
}

/**
 * 更新朝向角。
 *
 * 由伺服器統一計算而非交給各渲染端，原因有二：
 *   1. 速度趨近 0 時 atan2 會劇烈跳動，需要「低速時保持前一次朝向」的狀態，
 *      而那個狀態天然屬於角色本身；
 *   2. 大螢幕與合照是兩個渲染端，各算一套必然會不一致 ——
 *      合照當下角色的朝向會與觀眾前一秒在大螢幕上看到的不同。
 */
function updateHeading(agent, dt) {
  const maxStep = HEADING_TURN_RATE * dt;

  // 已在定位上且指定了朝向（例如合照要面向鏡頭）
  if (agent.arrived && agent.targetHeading !== null) {
    agent.heading = turnToward(agent.heading, agent.targetHeading, maxStep);
    return;
  }
  // 移動中則朝向行進方向；靜止時保持原朝向，避免原地亂轉
  const speed = Math.hypot(agent.vx, agent.vy);
  if (speed > WALK_THRESHOLD) {
    agent.heading = turnToward(agent.heading, Math.atan2(agent.vy, agent.vx), maxStep);
  }
}

/**
 * 推進單一角色一個時間步：更新 α、整合 Boids、合成最終速度、積分位置。
 * @param {object} agent  狀態矩陣中的角色
 * @param {object[]} agents  全體角色（供 Boids 鄰居搜尋）
 * @param {number} dt  時間步長（秒）
 * @param {number} now  當前時間戳（ms）
 * @param {Set<string>|null} affinity  此角色配對過的對象，用於凝聚偏置
 */
export function stepAgent(agent, agents, dt, now, affinity = null) {
  agent.offline = updateAlpha(agent, now, dt);

  // Boids 影子速度無條件持續整合 —— 這是 α 歸零時能無縫接手的前提
  integrateBoids(agent, agents, dt, affinity);

  // 手動速度：正規化方向 × 推桿強度 × 最高速，再做一階低通。
  //
  // 平滑是必要的，因為輸入方向是單位向量：靠近搖桿中心時，手指的一點
  // 偏移就是一個滿長度的方向，只有 intensity 在縮放。使用者把托盤拖回
  // 原點的途中方向會反覆換邊而速度仍有數十單位 —— 沒有平滑的話，
  // 角色會以接近全速的步態左右亂晃（實測回中期間場域速度維持在 26~52，
  // 遠高於 WALK_THRESHOLD，步態強度因此一路都是滿的）。
  //
  // 濾在這裡而不是濾步態：步態只是症狀，真正在跳動的是速度本身，
  // 位置與朝向也都吃同一份速度。
  const rawVx = agent.inputX * agent.inputIntensity * MAX_SPEED;
  const rawVy = agent.inputY * agent.inputIntensity * MAX_SPEED;
  const smoothK = 1 - Math.exp(-dt / MANUAL_SMOOTH_TAU);
  agent.manualVx += (rawVx - agent.manualVx) * smoothK;
  agent.manualVy += (rawVy - agent.manualVy) * smoothK;
  const manualVx = agent.manualVx;
  const manualVy = agent.manualVy;

  // ── M2 核心合成公式 ──
  //
  // IDLE_MOTION === 'still' 時，自主項的係數改為 0：合成式退化成
  // V = α · V_Manual，α 歸零後角色即完全靜止。
  //
  // 刻意乘以係數而非略過 integrateBoids() —— 影子速度仍要持續整合，
  // 否則現場把參數改回 'wander' 時，第一次交接會從一個過期的速度接手。
  const a = agent.alpha;
  const still = IDLE_MOTION === 'still';

  // 'still' 模式關掉的是「自主意圖」（漫遊、群聚），不是「碰撞處理」。
  //
  // 影子速度裡同時含有這兩者。把整個自主項乘 0，會連帶抹掉道具斥力貢獻的
  // 側向分量 —— 而正面推向圓形道具時，位置修正只會消去朝內的速度分量，
  // 側向為零就等於沒有繞行方向，角色會直接卡在道具正面推不過去。
  // （scene.test.mjs「沿邊緣滑過」正是為此把關。）
  //
  // 因此靜止模式下仍保留道具斥力，只是不讓它自己推著角色跑：
  // 唯有在角色本來就有移動意圖（推桿中或正在煞停）時才生效。
  const autonomy = still ? 0 : 1 - a;
  let vx = autonomy * agent.boidsVx + a * manualVx;
  let vy = autonomy * agent.boidsVy + a * manualVy;

  // ── 靜止模式的煞停 ──
  //
  // 'still' 模式下不能只靠 α 衰減來收速度。α 要閒置滿 IDLE_THRESHOLD_MS 才開始
  // 衰減，而 inputIntensity 在手指離開搖桿的當下就歸零 —— 那一瞬間 α 還是 1，
  // 但 manualV 已經是 0，兩者相乘直接從全速掉到 0。'wander' 模式看不出這件事，
  // 因為空缺由 Boids 影子速度補上；自主項一旦歸零，缺口就直接暴露成一階不連續。
  //
  // 因此改為對「上一幀的實際速度」做餘弦煞停，曲線與 ALPHA_DECAY_MS 一致：
  // 使用者放手後角色會滑行一小段再停住，而不是被瞬間拔掉電源。
  if (still) {
    const manualMag = Math.hypot(manualVx, manualVy);
    if (manualMag > 0) {
      // 仍在推桿：記住當下速度，作為之後煞停的起點
      agent.brakeFrom = null;
      agent.brakeStartAt = null;
    } else if (Math.hypot(agent.vx, agent.vy) > 0 || agent.brakeFrom !== null) {
      if (agent.brakeFrom === null) {
        agent.brakeFrom = { vx: agent.vx, vy: agent.vy };
        agent.brakeStartAt = now;
      }
      const t = Math.min(1, (now - agent.brakeStartAt) / ALPHA_DECAY_MS);
      const k = 0.5 * (1 + Math.cos(Math.PI * t)); // 1 → 0，起訖斜率皆為 0
      vx = agent.brakeFrom.vx * k;
      vy = agent.brakeFrom.vy * k;
      if (t >= 1) agent.brakeFrom = null;
    }
  }

  // 道具繞行放在煞停之後：煞停會直接覆寫 vx/vy，寫在前面的繞行結果會被丟掉，
  // 角色在滑行途中撞上道具就只剩位置修正硬擋，看起來像貼著道具急停。
  if (still && (vx !== 0 || vy !== 0)) {
    const [avoidX, avoidY] = obstacleAvoidance(agent, vx, vy);
    if (avoidX !== 0 || avoidY !== 0) {
      // 繞行只能改變「方向」，不能改變「速率」。
      //
      // 切向分量直接相加會有兩個症狀：全速時合成速度超過 MAX_SPEED（經過道具
      // 時莫名加速衝一下）；煞停途中則更糟 —— 疊加後的速率與正在餘弦衰減的
      // 速率脫鉤，畫面上會看到角色減速到一半又彈回去。
      // 因此把疊加結果正規化回原本的速率，只留下方向的改變。
      const before = Math.hypot(vx, vy);
      const sumX = vx + avoidX;
      const sumY = vy + avoidY;
      const after = Math.hypot(sumX, sumY);
      if (before > 0 && after > 0) {
        vx = (sumX / after) * before;
        vy = (sumY / after) * before;
      }
    }
  }

  // ── 定位鎖定：第三個速度來源 ──
  // 合照等情境需要把角色帶到指定位置。此時使用者操控與群體動力都不生效，
  // 但接管必須是漸進的 —— 瞬間切換會讓整場角色同時抽動一下。
  // 因此沿用與 α 相同的作法：以權重平滑過渡，而非硬切。
  if (agent.targetX !== null) {
    agent.lockAlpha = Math.min(1, agent.lockAlpha + (dt * 1000) / ARRIVE.takeoverMs);
    const arrive = arriveVelocity(agent);
    agent.arrived = arrive.arrived;
    const k = agent.lockAlpha;
    vx = (1 - k) * vx + k * arrive.vx;
    vy = (1 - k) * vy + k * arrive.vy;
  } else if (agent.lockAlpha > 0) {
    // 解除鎖定同樣是漸進的，角色會自然地重新加入人群
    agent.lockAlpha = Math.max(0, agent.lockAlpha - (dt * 1000) / ARRIVE.takeoverMs);
    agent.arrived = false;
  }

  agent.vx = vx;
  agent.vy = vy;

  agent.x += agent.vx * dt;
  agent.y += agent.vy * dt;

  // 硬夾限：邊界回推力是柔性的，這裡作為最後保險，確保角色絕不離開畫面
  agent.x = Math.max(0, Math.min(STAGE.width, agent.x));
  agent.y = Math.max(0, Math.min(STAGE.height, agent.y));

  // 剛體修正。刻意不受 α 影響 —— 手動操控的角色一樣不該穿過沙發，
  // 使用者體感是沿著道具邊緣滑過去，而不是被系統奪走控制權。
  resolveObstacleOverlap(agent);

  // 供渲染端使用的提示
  const speed = Math.hypot(agent.vx, agent.vy);
  agent.state = speed > WALK_THRESHOLD ? AGENT_STATE.WALK : AGENT_STATE.IDLE;
  if (agent.lockAlpha >= 0.5) agent.mode = AGENT_MODE.STAGED;
  else agent.mode = a >= 0.5 ? AGENT_MODE.ACTIVE : AGENT_MODE.SWARM;

  updateHeading(agent, dt);

  updateFacing(agent, dt);
}

/**
 * 更新左右鏡像（2D 版；3D 改用 heading，此欄保留是為了讓 2D 備援版本仍能運作）。
 *
 * 翻面是整個角色的水平鏡像 —— 畫面上最醒目的變化，比步態擺動大得多，
 * 因此判定要比「是否在走路」保守得多，這裡疊了兩道防抖：
 *
 *   1. 速度門檻 FACING_FLIP_SPEED（高於 WALK_THRESHOLD，形成遲滯區）
 *   2. 停留時間 FACING_DWELL_MS：新方向要站得住腳才真的翻面
 *
 * 兩道缺一不可。使用者把搖桿托盤拖回原點時，手指回中途不可能走直線，
 * 向量會在零附近反覆換邊，而每次換邊的瞬時速度都可能衝過門檻 ——
 * 只有速度門檻時實測仍會翻面 6 次，看起來就是角色瘋狂左右擺動。
 * 加上停留時間後降到 0，而真正的轉身只慢 150ms，操作上感覺不出來。
 */
function updateFacing(agent, dt) {
  if (Math.abs(agent.vx) <= FACING_FLIP_SPEED) return;

  const want = agent.vx > 0 ? 1 : -1;
  if (want === agent.facing) {
    // 方向與現況一致：清掉累積中的反向計時
    agent.facingPendingDir = null;
    agent.facingPendingMs = 0;
    return;
  }

  // 反向：必須連續維持 FACING_DWELL_MS 才真的翻面
  if (agent.facingPendingDir === want) {
    agent.facingPendingMs += dt * 1000;
  } else {
    agent.facingPendingDir = want;
    agent.facingPendingMs = dt * 1000;
  }

  if (agent.facingPendingMs >= FACING_DWELL_MS) {
    agent.facing = want;
    agent.facingPendingDir = null;
    agent.facingPendingMs = 0;
  }
}
