import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { STAGE } from '/shared/protocol.js';

// ===== 房間尺寸 =====
const RW = 36, RD = 28, WALL_H = 9;      // 房間寬(x)、深(z)、牆高
const HALF_W = RW / 2, HALF_D = RD / 2;

// 模型 URL
const PROP_URLS = {
  couch: 'https://static.poly.pizza/7ac6188b-72be-4c82-81c8-85deab020a1c.glb',
  shelf: 'https://static.poly.pizza/673e29d8-beff-45ff-94d9-2104d01baece.glb',
  plant: 'https://static.poly.pizza/1683c0b1-4dd9-4d45-910e-cf3e46f163f5.glb',
  lowtable: 'https://static.poly.pizza/2a849bd9-b82d-4e5d-8fab-df03b4017b29.glb', // 使用 plant2 當作矮桌/其他佔位
  speaker: 'https://static.poly.pizza/673e29d8-beff-45ff-94d9-2104d01baece.glb', // 使用 shelf 當作音箱佔位
  table: 'https://static.poly.pizza/2a849bd9-b82d-4e5d-8fab-df03b4017b29.glb', // 使用 plant2 當作高腳桌佔位
};

// 光線預設
const PRESETS = {
  day:     { bg: 0xe9e2d6, sun: 0xffffff, sunI: 2.2, pos: [22, 26, 18], hemi: 1.0, hSky: 0xffffff, hGround: 0x9a9488, amb: 0.34, lamp: 0, exp: 1.0 },
  evening: { bg: 0xd8b892, sun: 0xffb066, sunI: 1.8, pos: [20, 12, 16], hemi: 0.6, hSky: 0xf3c58a, hGround: 0x5a4838, amb: 0.26, lamp: 1.2, exp: 1.0 },
  night:   { bg: 0x0f1420, sun: 0x4a5c92, sunI: 0.3, pos: [-16, 24, 14], hemi: 0.13, hSky: 0x2a3a5c, hGround: 0x0a0f16, amb: 0.05, lamp: 2.4, exp: 0.8 },
};

export class RoomScene {
  constructor(containerElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    
    containerElement.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe7e0d4);
    this.scene.fog = new THREE.Fog(0xe7e0d4, 45, 130);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; 
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance = 8; 
    this.controls.maxDistance = 90;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.setupLights();
    this.buildRoom();
    
    this.loader = new GLTFLoader();
    // 相機必須在這裡定位。少了這一行，camera.position 會停在原點 (0,0,0)，
    // 與 controls.target 重合 —— 投影矩陣退化，projectToScreen() 對每個
    // 座標都算出 NaN，於是所有角色被畫到 NaN 像素，大螢幕整片空白。
    // 而且這個故障不會拋任何例外，console 完全乾淨。
    this.resetCamera();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setupLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8577, 1.0); 
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.32); 
    this.scene.add(this.ambient);
    
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2); 
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024); 
    this.sun.shadow.bias = -0.0004; 
    this.sun.shadow.normalBias = 0.02; 
    this.sun.shadow.radius = 4;
    const r = Math.max(RW, RD);
    this.sun.shadow.camera.left = -r; this.sun.shadow.camera.right = r; 
    this.sun.shadow.camera.top = r; this.sun.shadow.camera.bottom = -r;
    this.sun.shadow.camera.near = 0.5; this.sun.shadow.camera.far = WALL_H * 10;
    this.scene.add(this.sun, this.sun.target);
    
    this.lamp = new THREE.PointLight(0xffcf8a, 0, 40, 1.4); 
    this.lamp.position.set(0, WALL_H * 0.7, 0); 
    this.scene.add(this.lamp);

    this.applyLight('day');
  }

  applyLight(name) {
    const p = PRESETS[name] || PRESETS.day;
    this.scene.background.setHex(p.bg); 
    this.scene.fog.color.setHex(p.bg);
    this.sun.color.setHex(p.sun); 
    this.sun.intensity = p.sunI; 
    this.sun.position.set(...p.pos); 
    this.sun.target.position.set(0, 0, 0);
    this.hemi.color.setHex(p.hSky); 
    this.hemi.groundColor.setHex(p.hGround); 
    this.hemi.intensity = p.hemi;
    this.ambient.intensity = p.amb; 
    this.lamp.intensity = p.lamp; 
    this.renderer.toneMappingExposure = p.exp;
  }

  noiseTex(base, spot, rep) {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 700; i++) { g.fillStyle = spot.replace('A', (0.03 + Math.random() * 0.06).toFixed(2)); g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 4 + Math.random() * 8, 0, 7); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  buildRoom() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ map: this.noiseTex('#d8c8ad', 'rgba(120,95,60,A)', 40), roughness: 0.95, envMapIntensity: 0.3 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xcdd8c4, roughness: 0.95, envMapIntensity: 0.3 });
    const baseMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.7, envMapIntensity: 0.3 });
    
    const back = new THREE.Mesh(new THREE.BoxGeometry(RW, WALL_H, 0.4), wallMat);
    back.position.set(0, WALL_H / 2, -HALF_D); back.receiveShadow = true; back.castShadow = true; this.scene.add(back);
    
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.4, WALL_H, RD), wallMat);
    left.position.set(-HALF_W, WALL_H / 2, 0); left.receiveShadow = true; left.castShadow = true; this.scene.add(left);
    
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.4, 0.5), baseMat); b1.position.set(0, 0.2, -HALF_D + 0.08); this.scene.add(b1);
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, RD), baseMat); b2.position.set(-HALF_W + 0.08, 0.2, 0); this.scene.add(b2);
    
    const win = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xbfe3f2, roughness: 0.1, metalness: 0.2, emissive: 0x88bcd6, emissiveIntensity: 0.15 }));
    win.position.set(6, 5, -HALF_D + 0.26); this.scene.add(win);
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(6.6, 4.6, 0.3), baseMat); winFrame.position.set(6, 5, -HALF_D + 0.2); this.scene.add(winFrame);
    
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(12, 8),
      new THREE.MeshStandardMaterial({ color: 0x9c8f7a, roughness: 1, envMapIntensity: 0.3 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(-2, 0.02, -4); rug.receiveShadow = true; this.scene.add(rug);
  }

  async loadProp(url, targetH, x, z, ry = 0) {
    if (!url) return;
    const gltf = await new Promise((res, rej) => this.loader.load(url, res, undefined, rej));
    const o = gltf.scene;
    o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; if (m.material) m.material.envMapIntensity = 0.5; } });
    let box = new THREE.Box3().setFromObject(o); const size = new THREE.Vector3(); box.getSize(size);
    o.scale.setScalar(targetH / size.y);
    box = new THREE.Box3().setFromObject(o); const c = new THREE.Vector3(); box.getCenter(c);
    o.position.x -= c.x; o.position.z -= c.z; o.position.y -= box.min.y;
    const pivot = new THREE.Group(); pivot.add(o); pivot.position.set(x, 0, z); pivot.rotation.y = ry; this.scene.add(pivot);
    return pivot;
  }

  // 將邏輯坐標 (1920x1080) 映射至 3D 空間
  logicTo3D(logicX, logicY) {
    return {
      x: (logicX / STAGE.width) * RW - HALF_W,
      z: (logicY / STAGE.height) * RD - HALF_D
    };
  }

  // 將 3D 坐標透視投影至螢幕像素 (用於 2D Canvas 疊加)
  projectToScreen(logicX, logicY) {
    // project() 讀的是 camera.matrixWorldInverse 與 projectionMatrix。
    // 前者由 updateMatrixWorld() 產生，平時只在 render() 內部被呼叫 ——
    // 因此在第一幀之前（或本函式先於 render 被呼叫時）矩陣仍是單位矩陣，
    // 投影結果會退化：所有座標算出同一個點，中心點甚至是 NaN。
    // 這裡明確更新，讓投影不依賴呼叫順序。
    this.camera.updateMatrixWorld();
    const p3d = this.logicTo3D(logicX, logicY);
    const vector = new THREE.Vector3(p3d.x, 0, p3d.z); // 地板高度 y=0
    vector.project(this.camera);

    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: (vector.x * 0.5 + 0.5) * rect.width,
      y: (-(vector.y * 0.5) + 0.5) * rect.height
    };
  }

  resetCamera() {
    const START_POS = new THREE.Vector3(HALF_W * 1.05, WALL_H * 2.35, HALF_D * 1.15);
    const START_TARGET = new THREE.Vector3(0, 1.2, 1);
    this.camera.position.copy(START_POS); 
    this.controls.target.copy(START_TARGET);
    // 相機的朝向由 controls 依 target 算出。少了這次 update()，
    // 在第一幀 render 之前相機仍朝著預設方向（-Z），投影會全部落在畫面外。
    this.controls.update();
    this.camera.updateMatrixWorld();
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight; 
    this.camera.updateProjectionMatrix(); 
    this.renderer.setSize(innerWidth, innerHeight);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// 供外部呼叫的輔助函式，根據 PROPS 定義載入家具
export async function populateProps(roomScene, propsDefinition) {
  const promises = propsDefinition.map(p => {
    const p3d = roomScene.logicTo3D(p.x, p.y);
    const url = PROP_URLS[p.type] || PROP_URLS.plant;
    // 預設給一個合理高度 (依類型不同可再調整)
    let h = 2.4;
    if (p.type === 'table' || p.type === 'lowtable') h = 1.2;
    if (p.type === 'shelf' || p.type === 'speaker') h = 3.6;
    if (p.type === 'plant') h = 2.6;
    // 朝向來自 shared/scene.js 的 ry —— 那份定義是佈局的單一事實來源。
    // 原本這裡對 sofa 硬寫 Math.PI/2，等於把資料驅動的那半架空：
    // 音箱的 ±PI/4 永遠不會生效，改 shared/scene.js 也不會有任何反應。
    const ry = typeof p.ry === 'number' ? p.ry : 0;
    return roomScene.loadProp(url, h, p3d.x, p3d.z, ry);
  });
  await Promise.all(promises);
}
