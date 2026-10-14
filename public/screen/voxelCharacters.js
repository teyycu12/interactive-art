/**
 * 體素角色：把 shared/voxelRig.js 的骨架建成 Three.js 網格，每幀擺好走路
 * 姿勢，畫進一張離屏的圖集，再由 drawCharacter 貼回 2D 角色畫布。
 *
 * 為什麼不直接疊一張 WebGL 畫布在場景上：大螢幕的名牌、進場箭頭、配對
 * 脈衝都畫在 2D 畫布上，而且依 Y 排序和角色交錯；合照（captureStageFrame）
 * 也只合成「場景畫布 + 2D 畫布」兩張。另開一層會讓名牌被角色蓋住、
 * 合照裡沒有人。走圖集，這些全部照舊。
 *
 * 走路：
 *   - 整個人不再左右轉（舊的 wobble 就是「抖」的來源）
 *   - 雙腿繞髖關節前後交替，雙手反向擺，軀幹隨步伐微微扭轉、前傾
 *   - 身體在兩腿交會時最高（cos²），起伏很小
 *   - 朝向依速度連續轉；停下且伺服器回報正面後轉回面向觀眾
 *
 * 任何一步失敗（WebGL 不能用、貼圖還沒到、骨架建不出來）都回傳 null，
 * 呼叫端退回原本的 2D 貼圖 —— 與「掃描失敗一律降級」同一個原則。
 */

import * as THREE from 'three';
import { buildRig, PARTS } from '/shared/voxelRig.js';
import { AGENT_VIEW, WALK_THRESHOLD } from '/shared/protocol.js';

// 圖集：每個角色一格 TILE×TILE 裝置像素
const TILE = 384;
const COLS = 8;

// 世界單位：整張角色貼圖高 100。腳底在 y = 0。
const WORLD_H = 100;
// 每格涵蓋的世界範圍（正方形）；角色最高 100，留邊給擺手與抬腳
const FRUSTUM = 124;
// 腳底在格子裡的高度（世界單位，自格子底部算起）
const FOOT_MARGIN = 8;
// 鏡頭俯角：看得到一點頭頂與肩膀，與場景的俯視角一致
const TILT = THREE.MathUtils.degToRad(18);

// 步態（與 shared/character.js 的步頻同一組常數：12 rad/s × cadence）
const BOB_OMEGA = 12;
const LEG_SWING = THREE.MathUtils.degToRad(28);
const ARM_SWING = THREE.MathUtils.degToRad(24);
const TORSO_TWIST = THREE.MathUtils.degToRad(6);
const TORSO_LEAN = THREE.MathUtils.degToRad(4);
const BOB_HEIGHT = 1.2;   // 體素
const TURN_RATE = 9;      // rad/s

function cadence(speed, maxSpeed) {
  return 0.55 + 0.45 * Math.min(1, speed / maxSpeed);
}

const FACES = [
  { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * 一個部位的網格：只產生朝外的面（鄰格同部位就不畫）。
 * 部位之間的接縫要畫 —— 手腳擺動時那一面會露出來。
 */
function partGeometry(voxels, pivot) {
  // 體素座標是整數且範圍遠小於 ±512：三軸各 10 位元打包成一個數字當鍵
  const key = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  const set = new Set();
  for (let i = 0; i < voxels.length; i += 6) set.add(key(voxels[i], voxels[i + 1], voxels[i + 2]));

  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const color = new THREE.Color();
  for (let i = 0; i < voxels.length; i += 6) {
    const x = voxels[i], y = voxels[i + 1], z = voxels[i + 2];
    color.setRGB(voxels[i + 3] / 255, voxels[i + 4] / 255, voxels[i + 5] / 255, THREE.SRGBColorSpace);
    for (const f of FACES) {
      if (set.has(key(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;
      const base = pos.length / 3;
      for (const v of f.v) {
        pos.push(x + v[0] - pivot[0], y + v[1] - pivot[1], z + v[2] - pivot[2]);
        nor.push(...f.n);
        col.push(color.r, color.g, color.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/** 從 sprite（canvas 或 Image）讀出原解析度像素 */
function readPixels(sprite) {
  const w = sprite.naturalWidth || sprite.width;
  const h = sprite.naturalHeight || sprite.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sprite, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const shortestAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class VoxelCharacters {
  constructor() {
    this.ok = false;
    this.models = new Map();   // id → { sprite, version, root, parts, yaw, scale, frac, cx }
    this.tiles = new Map();    // id → 本幀的圖集位置
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    } catch {
      return; // 沒有 WebGL：全部退回 2D 貼圖
    }
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.rows = 0;
    this.budget = 0;

    this.scene = new THREE.Scene();
    // 光源固定在鏡頭這一側（偏左上）：正對觀眾的面最亮、側面暗一階、
    // 頂面介於兩者之間。角色轉身時明暗跟著換，那就是立體感的來源。
    //
    // 強度乘 π：Three.js r155 起預設是物理光照，Lambert 會再除以 π。
    // 不乘的話正面只剩原圖約 35% 的線性亮度（看起來暗三成五，實測過）。
    // 正面 ≈ 0.72 + 0.5 × 0.74 ≈ 1.09，比原圖略亮一點點，投影機上剛好。
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72 * Math.PI));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
    sun.position.set(-0.45, 0.8, 1);
    this.scene.add(sun);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

    const half = FRUSTUM / 2;
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, -500, 500);
    const centerY = FRUSTUM / 2 - FOOT_MARGIN;
    this.camera.position.set(0, centerY + Math.sin(TILT) * 200, Math.cos(TILT) * 200);
    this.camera.lookAt(0, centerY, 0);
    this.camera.updateMatrixWorld();

    // 腳底與頭頂（整張貼圖高）在格子裡的位置，貼回 2D 時用來對齊與縮放
    const foot = new THREE.Vector3(0, 0, 0).project(this.camera);
    const top = new THREE.Vector3(0, WORLD_H, 0).project(this.camera);
    this.footU = (foot.x + 1) / 2;
    this.footV = (1 - foot.y) / 2;
    this.heightV = (top.y - foot.y) / 2;   // 整張貼圖高 ↔ 格子高的比例
    this.ok = true;
  }

  /**
   * 確保這個角色有模型；sprite 換了（或貼圖剛到齊）就重建。
   * 回傳 false 代表這個角色這一幀走 2D。
   */
  ensure(id, sprite) {
    if (!this.ok || !sprite?.complete || !sprite.naturalWidth || sprite.spriteReady === false) return false;
    const version = sprite.spriteVersion ?? 0;
    const prev = this.models.get(id);
    if (prev && prev.sprite === sprite && prev.version === version) return prev.root !== null;
    if (prev?.root) this.dispose(id);
    // 每幀最多建一個（一個約 50~100ms）。大螢幕中途重開時場上可能已有
    // 30 人，同一幀全部建完會凍住好幾秒；排隊的人這幾幀先畫 2D。
    if (this.budget <= 0) return false;
    this.budget--;

    let rig = null;
    try { rig = buildRig(readPixels(sprite)); } catch { rig = null; }
    if (!rig) {
      this.models.set(id, { sprite, version, root: null });
      return false;
    }

    // 一顆體素的世界大小：整張貼圖高 = WORLD_H，角色外框佔其中 frac
    const scale = (WORLD_H * rig.frac) / rig.rows;
    const root = new THREE.Group();
    const body = new THREE.Group();   // 上下起伏
    root.add(body);
    root.scale.setScalar(scale);
    const groups = {};
    for (const name of PARTS) {
      const p = rig.parts[name];
      const g = new THREE.Group();
      g.position.set(...p.pivot);
      if (p.voxels.length) g.add(new THREE.Mesh(partGeometry(p.voxels, p.pivot), this.material));
      groups[name] = g;
    }
    // 頭與手臂掛在軀幹上：軀幹扭轉時它們跟著轉
    const torsoPivot = rig.parts.torso.pivot;
    for (const name of ['head', 'armL', 'armR']) {
      const g = groups[name];
      g.position.sub(new THREE.Vector3(...torsoPivot));
      groups.torso.add(g);
    }
    body.add(groups.torso, groups.legL, groups.legR);
    root.visible = false;
    this.scene.add(root);

    this.models.set(id, { sprite, version, root, body, groups, yaw: 0, scale, cx: rig.cx });
    return true;
  }

  dispose(id) {
    const m = this.models.get(id);
    if (!m) return;
    if (m.root) {
      m.root.traverse((o) => o.geometry?.dispose());
      this.scene.remove(m.root);
    }
    this.models.delete(id);
  }

  /** 名冊裡已經不在的人 */
  prune(alive) {
    for (const id of [...this.models.keys()]) if (!alive.has(id)) this.dispose(id);
  }

  /** 擺姿勢：依速度、時間、伺服器的 view */
  pose(m, agent, time, maxSpeed, dt) {
    const speed = Math.hypot(agent.vx, agent.vy);
    const gait = Math.min(1, speed / WALK_THRESHOLD);
    // 相位累加而不是 time × 步頻：步頻隨速度變，直接相乘會在轉彎減速時
    // 整段跳動（見 shared/character.js 的 stepPhase）
    m.phase = ((m.phase ?? 0) + BOB_OMEGA * cadence(speed, maxSpeed) * 0.5 * dt) % (Math.PI * 2);
    const phase = m.phase;
    const s = Math.sin(phase) * gait;

    // 朝向：走路時面向前進方向（邏輯 +y 是朝鏡頭 = 模型 +z）；停下後
    // 伺服器把 view 轉回正面時才轉回來面對觀眾（VIEW_RETURN_FRONT_MS）
    let target = m.yaw;
    if (speed > WALK_THRESHOLD) target = Math.atan2(agent.vx, agent.vy);
    else if ((agent.view ?? AGENT_VIEW.FRONT) === AGENT_VIEW.FRONT) target = 0;
    const diff = shortestAngle(target - m.yaw);
    const step = TURN_RATE * dt;
    m.yaw = shortestAngle(m.yaw + Math.max(-step, Math.min(step, diff)));
    m.root.rotation.y = m.yaw;

    const { groups } = m;
    groups.legL.rotation.x = s * LEG_SWING;
    groups.legR.rotation.x = -s * LEG_SWING;
    groups.armL.rotation.x = -s * ARM_SWING;
    groups.armR.rotation.x = s * ARM_SWING;
    groups.torso.rotation.y = s * TORSO_TWIST;
    groups.torso.rotation.x = gait * TORSO_LEAN;
    groups.head.rotation.y = -s * TORSO_TWIST * 0.6;
    // 兩腿交會（擺幅為零）時身體最高
    m.body.position.y = Math.cos(phase) ** 2 * BOB_HEIGHT * gait;
  }

  /**
   * 畫這一幀的圖集。
   * @param {Array<{id:string, agent:object}>} list  要畫的角色（已 ensure 成功）
   */
  render(list, { time, maxSpeed, dt }) {
    this.budget = 1;   // 給下一幀的 ensure()
    this.tiles.clear();
    if (!this.ok || !list.length) return;
    const rows = Math.ceil(list.length / COLS);
    if (rows !== this.rows) {
      this.rows = rows;
      this.renderer.setSize(TILE * COLS, TILE * rows, false);
    }
    const H = TILE * rows;
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setScissorTest(true);

    for (const m of this.models.values()) if (m.root) m.root.visible = false;
    list.forEach(({ id, agent }, i) => {
      const m = this.models.get(id);
      if (!m?.root) return;
      this.pose(m, agent, time, maxSpeed, dt);
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      this.renderer.setViewport(col * TILE, H - (row + 1) * TILE, TILE, TILE);
      this.renderer.setScissor(col * TILE, H - (row + 1) * TILE, TILE, TILE);
      m.root.visible = true;
      this.renderer.render(this.scene, this.camera);
      m.root.visible = false;
      this.tiles.set(id, { sx: col * TILE, sy: row * TILE, cx: m.cx });
    });
  }

  /**
   * 這個角色本幀在圖集裡的位置，交給 drawCharacter 的 opts.voxel。
   * 沒有（還沒建好、或這一幀沒畫）就是 null，drawCharacter 走 2D。
   */
  tile(id) {
    const t = this.tiles.get(id);
    if (!t) return null;
    return {
      canvas: this.canvas, sx: t.sx, sy: t.sy, size: TILE,
      footU: this.footU, footV: this.footV, heightV: this.heightV,
    };
  }
}
