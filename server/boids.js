/**
 * 模組 M2（下半）— Boids 群體動力學引擎
 *
 * 採 Reynolds (1987) 三力模型：Separation / Alignment / Cohesion，
 * 外加邊界回推與漫遊擾動兩項工程性補強：
 *   - 邊界回推：場域是有界的投影畫面，純 Boids 會讓群體整團飄出畫面外。
 *   - 漫遊擾動：現場只有 1～2 人連線時鄰居數為 0，三力全為零會導致角色靜止，
 *     與「湧現漫遊態」的設計意圖相悖，故補一項隨機遊走的自走力。
 *
 * ⚠ 關鍵設計：boidsVx/boidsVy 是與實際速度分離的「影子速度」，無論使用者
 *   是否正在手動操控，它都持續整合群體受力。因此當 α 從 1 衰減回 0 時，
 *   Boids 速度早已與周遭群體同調，交還控制權不會出現方向突跳。
 *
 * 效能：鄰居搜尋為 O(n²)。技術文件目標為 30 個角色 → 每 tick 約 900 次距離
 *   計算，在 30Hz 下負擔可忽略。角色數若超過約 200 才需引入空間雜湊分格。
 */

import {
  BOIDS, MAX_SPEED, MAX_FORCE, BOUNDARY_MARGIN, BOUNDARY_WEIGHT,
  OBSTACLE_WEIGHT, IDLE_MOTION,
} from './config.js';
import { STAGE } from '../shared/protocol.js';
import { OBSTACLES } from '../shared/scene.js';

/** 將向量長度限制在 max 以內 */
function limit(x, y, max) {
  const sq = x * x + y * y;
  if (sq > max * max && sq > 0) {
    const scale = max / Math.sqrt(sq);
    return [x * scale, y * scale];
  }
  return [x, y];
}

/**
 * Reynolds 轉向力：把「期望速度」與「當前速度」的差視為加速度，
 * 再夾限到最大轉向力。這是讓群體轉向平滑而非瞬間變向的關鍵。
 */
function steer(dirX, dirY, agent) {
  const mag = Math.hypot(dirX, dirY);
  if (mag === 0) return [0, 0];
  const desiredX = (dirX / mag) * MAX_SPEED;
  const desiredY = (dirY / mag) * MAX_SPEED;
  return limit(desiredX - agent.boidsVx, desiredY - agent.boidsVy, MAX_FORCE);
}

/**
 * 三力模型：回傳加權後的合力。
 *
 * @param {Set<string>|null} affinity 此角色曾配對過的對象。
 *   凝聚質心會給這些人較高的權重，讓「互動過的人」在畫面上自然聚成小圈子
 *   （規格 v3.0 §4.2）。這是刻意不畫連線的替代方案 —— 30 人各配對數次，
 *   畫線會糊成毛球，改由既有的群體動力把關係表現為空間現象。
 */
function flockingForce(agent, agents, affinity) {
  let sepX = 0, sepY = 0, sepCount = 0;
  let aliX = 0, aliY = 0, aliCount = 0;
  let cohX = 0, cohY = 0, cohWeight = 0;

  const neighborSq = BOIDS.neighborRadius ** 2;
  const separationSq = BOIDS.separationRadius ** 2;

  for (const other of agents) {
    if (other === agent) continue;
    const dx = other.x - agent.x;
    const dy = other.y - agent.y;
    const distSq = dx * dx + dy * dy;
    if (distSq === 0 || distSq > neighborSq) continue;

    if (distSq < separationSq) {
      // 排斥力與距離成反比：越近推得越用力，形成剛體避障半徑。
      // 分離刻意不受社交親和力影響 —— 認識的人也需要個人空間，
      // 若讓熟人靠得更近，群體會黏成一坨硬塊而失去湧現感。
      sepX -= dx / distSq;
      sepY -= dy / distSq;
      sepCount++;
    }
    aliX += other.vx; aliY += other.vy; aliCount++;

    // 加權質心：配對過的鄰居貢獻較大，凝聚方向因此偏向熟人
    const w = affinity?.has(other.id) ? 1 + BOIDS.affinityBonus : 1;
    cohX += other.x * w;
    cohY += other.y * w;
    cohWeight += w;
  }

  let fx = 0, fy = 0;

  if (sepCount > 0) {
    const [sx, sy] = steer(sepX / sepCount, sepY / sepCount, agent);
    fx += sx * BOIDS.separationWeight;
    fy += sy * BOIDS.separationWeight;
  }
  if (aliCount > 0) {
    const [ax, ay] = steer(aliX / aliCount, aliY / aliCount, agent);
    fx += ax * BOIDS.alignmentWeight;
    fy += ay * BOIDS.alignmentWeight;
  }
  if (cohWeight > 0) {
    // 凝聚：朝加權後的鄰居質心前進
    const [cx, cy] = steer(cohX / cohWeight - agent.x, cohY / cohWeight - agent.y, agent);
    fx += cx * BOIDS.cohesionWeight;
    fy += cy * BOIDS.cohesionWeight;
  }
  return [fx, fy];
}

/**
 * 場景障礙避讓（技術文件 M3：裝飾物件作為物理剛體加入避障清單）。
 *
 * 與角色間的分離力分開處理，因為道具是靜態剛體：角色不會協商繞路，
 * 必須被明確推開，否則會卡在沙發裡抖動。力度隨侵入深度上升。
 */
function obstacleForce(agent) {
  let fx = 0, fy = 0;
  let deepest = 0;

  for (const o of OBSTACLES) {
    const dx = agent.x - o.x;
    const dy = agent.y - o.y;
    const distSq = dx * dx + dy * dy;
    const reach = o.r + BOIDS.obstacleMargin;
    if (distSq > reach * reach) continue;

    const dist = Math.sqrt(distSq);
    if (dist === 0) {
      // 剛好落在圓心：給一個任意方向推開，避免除以零後卡死
      fx += 1; fy += 1;
      deepest = 4;
      continue;
    }

    // 緩衝帶外緣為 0，碰到表面為 1，再深入則超過 1
    const push = Math.min((reach - dist) / BOIDS.obstacleMargin, 4);
    fx += (dx / dist) * push;
    fy += (dy / dist) * push;
    if (push > deepest) deepest = push;
  }

  if (fx === 0 && fy === 0) return [0, 0];

  // 侵入深度必須在 steer() 之後才乘進去。steer() 會把方向正規化成
  // 「以最高速朝外」的期望速度，累加出來的 push 大小在那一步會被抹平 ——
  // 早期版本把深度乘在 steer() 之前，導致無論陷多深，斥力都一樣大。
  const [sx, sy] = steer(fx, fy, agent);
  return [sx * OBSTACLE_WEIGHT * deepest, sy * OBSTACLE_WEIGHT * deepest];
}

/**
 * 位置修正：把已經陷入道具的角色直接推回表面。
 *
 * 轉向力只能逐漸改變速度，對高速衝入的角色來說永遠會有一段穿透。
 * 技術文件要求道具是「物理剛體」，而角色視覺上疊在沙發裡就是壞掉，
 * 因此除了柔性的閃避力，另外加一道硬性保證。
 *
 * 同時消去朝向道具的速度分量，角色才會沿著邊緣滑過去，
 * 而不是每一幀被推出來又撞回去地抖動。
 */
export function resolveObstacleOverlap(agent) {
  for (const o of OBSTACLES) {
    const dx = agent.x - o.x;
    const dy = agent.y - o.y;
    const distSq = dx * dx + dy * dy;
    if (distSq >= o.r * o.r) continue;

    let nx;
    let ny;
    if (distSq === 0) {
      nx = 1; ny = 0; // 落在正中心時任選一個方向推出
    } else {
      const dist = Math.sqrt(distSq);
      nx = dx / dist;
      ny = dy / dist;
    }

    agent.x = o.x + nx * o.r;
    agent.y = o.y + ny * o.r;

    const into = agent.vx * nx + agent.vy * ny;
    if (into < 0) {
      agent.vx -= into * nx;
      agent.vy -= into * ny;
    }

    // 影子速度也要一併消去朝內的分量。
    // 只修正 vx/vy 是不夠的：影子速度會持續指向道具內部，被斥力無止盡抵銷，
    // 而使用者一放開搖桿、α 交還給 Boids 的瞬間，角色就會朝道具衝進去 ——
    // 正是影子速度這個設計本來要避免的交接失真。
    const boidsInto = agent.boidsVx * nx + agent.boidsVy * ny;
    if (boidsInto < 0) {
      agent.boidsVx -= boidsInto * nx;
      agent.boidsVy -= boidsInto * ny;
    }
  }
}


/**
 * 靜止模式用的道具繞行速度（不經影子速度）。
 *
 * obstacleForce() 回傳的是相對於影子速度的轉向力，在 'still' 模式下影子速度
 * 不參與合成，那個力沒有著力點。
 *
 * ⚠ 這裡要的是「繞過去」而不是「被擋下來」。純徑向的斥力在正面直衝時
 *   恰好與行進方向反向，兩者相消，角色會停在道具前方動彈不得（而且是停在
 *   緩衝帶外緣，看起來像撞到空氣牆）。因此回傳的是**切向**分量：
 *   取徑向的垂直方向，並選與當前行進方向同側的那一邊，角色才會順勢滑開。
 *
 * @param {object} agent
 * @param {number} vx 目前的合成速度，用來決定往哪一側繞
 * @param {number} vy
 * @returns {[number, number]} 速度增量（邏輯單位/秒）
 */
export function obstacleAvoidance(agent, vx, vy) {
  const speed = Math.hypot(vx, vy);
  if (speed === 0) return [0, 0];

  let bestPush = 0;
  let nx = 0, ny = 0;

  for (const o of OBSTACLES) {
    const dx = agent.x - o.x;
    const dy = agent.y - o.y;
    const distSq = dx * dx + dy * dy;
    const reach = o.r + BOIDS.obstacleMargin;
    if (distSq > reach * reach) continue;

    const dist = Math.sqrt(distSq) || 1e-6;
    // 只在朝著道具前進時才需要繞行；已經在遠離就別再加力
    if ((vx * -dx + vy * -dy) / speed <= 0) continue;

    const push = Math.min((reach - dist) / BOIDS.obstacleMargin, 1);
    if (push > bestPush) {
      bestPush = push;
      nx = dx / dist;
      ny = dy / dist;
    }
  }

  if (bestPush === 0) return [0, 0];

  // 徑向的兩個垂直方向，取與行進方向夾角較小的那個 → 順勢繞行而非折返
  let tx = -ny, ty = nx;
  if (tx * vx + ty * vy < 0) { tx = ny; ty = -nx; }

  // 上限壓在 MAX_SPEED 之下：這是偏移量，不該強到蓋過使用者的操控
  const strength = bestPush * MAX_SPEED * 0.9;
  return [tx * strength, ty * strength];
}

/** 邊界回推：進入邊緣帶後施加朝內的力，力度隨深入程度線性上升 */
function boundaryForce(agent) {
  let fx = 0, fy = 0;
  const m = BOUNDARY_MARGIN;

  if (agent.x < m)                  fx += (m - agent.x) / m;
  else if (agent.x > STAGE.width - m)  fx -= (agent.x - (STAGE.width - m)) / m;
  if (agent.y < m)                  fy += (m - agent.y) / m;
  else if (agent.y > STAGE.height - m) fy -= (agent.y - (STAGE.height - m)) / m;

  if (fx === 0 && fy === 0) return [0, 0];
  const [sx, sy] = steer(fx, fy, agent);
  return [sx * BOUNDARY_WEIGHT, sy * BOUNDARY_WEIGHT];
}

/** 漫遊：對角色自身的漫遊方向做隨機遊走，產生自然的閒晃軌跡 */
function wanderForce(agent, dt) {
  agent.wanderAngle += (Math.random() - 0.5) * 2 * BOIDS.wanderJitter * dt;
  const [wx, wy] = steer(Math.cos(agent.wanderAngle), Math.sin(agent.wanderAngle), agent);
  return [wx * BOIDS.wanderWeight, wy * BOIDS.wanderWeight];
}

/**
 * 推進單一角色的 Boids 影子速度一個時間步。
 * 不直接改動 agent.x/y —— 位置由 arbiter 依合成後的最終速度更新。
 */
export function integrateBoids(agent, agents, dt, affinity = null) {
  const [flockX, flockY] = flockingForce(agent, agents, affinity);
  const [boundX, boundY] = boundaryForce(agent);
  const [obsX, obsY] = obstacleForce(agent);
  // 漫遊擾動是「無鄰居時仍要動」的來源，因此它正是 IDLE_MOTION 要關掉的東西。
  // 'flock' 模式關掉它之後，三力在孤身一人時全為零，角色自然停住。
  const [wanderX, wanderY] = IDLE_MOTION === 'wander'
    ? wanderForce(agent, dt)
    : [0, 0];

  agent.boidsVx += (flockX + boundX + obsX + wanderX) * dt;
  agent.boidsVy += (flockY + boundY + obsY + wanderY) * dt;

  [agent.boidsVx, agent.boidsVy] = limit(agent.boidsVx, agent.boidsVy, MAX_SPEED);
}
