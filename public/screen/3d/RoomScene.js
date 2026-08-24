import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { STAGE } from '/shared/protocol.js';

// ===== 房間尺寸 =====
// 房間尺寸（3D 世界單位）。
//
// 這組數字決定角色相對於空間的份量感。原本是 36×28×9 —— 那是一個大廳的
// 尺度，角色只佔牆高的 23%，看起來像玩具散落在空地上。動森那種質感來自
// 「角色相對大、空間相對緊湊」，因此縮到約一半。
//
// 場域邏輯座標（STAGE 1920×1080）與 Boids 物理完全不受影響：
// logicTo3D() 只是把邏輯座標等比映射到這個範圍，改的是視覺尺度而非玩法。
const RW = 17, RD = 13, WALL_H = 4.6;    // 房間寬(x)、深(z)、牆高
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
// 光線預設。
//
// day 是展場的預設，調性參照動森：明亮、偏暖、陰影柔而不重。
// 具體手法是「主光偏暖 + 天空光偏藍」—— 冷暖對比會讓白色牆面產生層次，
// 全白光源則會讓整個房間看起來像沒打光的 3D 模型。
const PRESETS = {
  day:     { bg: 0xf2ede1, sun: 0xfff2d6, sunI: 2.6, pos: [11, 13, 9], hemi: 1.25, hSky: 0xdceeff, hGround: 0xb8a98e, amb: 0.42, lamp: 0, exp: 1.08 },
  evening: { bg: 0xd8b892, sun: 0xffb066, sunI: 1.8, pos: [20, 12, 16], hemi: 0.6, hSky: 0xf3c58a, hGround: 0x5a4838, amb: 0.26, lamp: 1.2, exp: 1.0 },
  night:   { bg: 0x0f1420, sun: 0x4a5c92, sunI: 0.3, pos: [-16, 24, 14], hemi: 0.13, hSky: 0x2a3a5c, hGround: 0x0a0f16, amb: 0.05, lamp: 2.4, exp: 0.8 },
};

export class RoomScene {
  constructor(containerElement) {
    // preserveDrawingBuffer：大合照要把這張 WebGL 畫布讀回來（見 screen.js
    // 的 captureStageFrame）。WebGL 預設在每次 render 後就把緩衝丟掉，
    // 少了這個旗標，toDataURL() 讀到的是一張全透明的圖 —— 而且不會報錯。
    this.renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    
    containerElement.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe7e0d4);
    this.scene.fog = new THREE.Fog(0xe7e0d4, RD * 1.6, RD * 5.5);

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
    this.setupComposer();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  /**
   * 後製鏈：bloom 讓亮處溢光、vignette 把視線收進畫面中央。
   *
   * 這兩者是「遊戲畫面」和「3D 模型檢視器」最明顯的差別 —— 沒有後製的
   * 渲染即使光影正確，看起來仍像預覽視窗。
   *
   * 可以整條關掉（見 setPostProcessing）：現場硬體尚未確定，效能不足時
   * 退回直接渲染仍是完整畫面，只是少了溢光與暗角。
   */
  setupComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // 閾值調高、強度壓低：動森那種明亮風格要的是窗邊與亮面的柔和溢光，
    // 不是整個畫面糊成一片光暈。
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight), 0.34, 0.85, 0.92);
    this.composer.addPass(this.bloom);

    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.05;
    this.vignette.uniforms.darkness.value = 1.12;
    this.composer.addPass(this.vignette);

    // OutputPass 負責色調映射與 sRGB 轉換。少了它，經過 composer 的畫面
    // 會比直接渲染暗一階 —— 因為 renderer 的 toneMapping 只作用在最後一步。
    this.composer.addPass(new OutputPass());
    this.postEnabled = true;
  }

  /** 關閉後製退回直接渲染（效能不足時的降級路徑） */
  setPostProcessing(on) {
    this.postEnabled = !!on && !!this.composer;
  }

  setupLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8577, 1.0); 
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.32); 
    this.scene.add(this.ambient);
    
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2); 
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); 
    this.sun.shadow.bias = -0.0002; 
    this.sun.shadow.normalBias = 0.02; 
    this.sun.shadow.radius = 3;
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
    // 地板只比房間大一圈。原本是 400×400 的無邊平面 —— 房間尺度縮小後，
    // 牆外那片地板會佔掉大半畫面，房間看起來像漂在荒野上的小盒子。
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW * 1.06, RD * 1.06),
      new THREE.MeshStandardMaterial({ map: this.noiseTex('#d8c8ad', 'rgba(120,95,60,A)', 18), roughness: 0.95, envMapIntensity: 0.3 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xcdd8c4, roughness: 0.95, envMapIntensity: 0.3 });
    const baseMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.7, envMapIntensity: 0.3 });
    
    const back = new THREE.Mesh(new THREE.BoxGeometry(RW, WALL_H, 0.22), wallMat);
    back.position.set(0, WALL_H / 2, -HALF_D); back.receiveShadow = true; back.castShadow = true; this.scene.add(back);
    
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.22, WALL_H, RD), wallMat);
    left.position.set(-HALF_W, WALL_H / 2, 0); left.receiveShadow = true; left.castShadow = true; this.scene.add(left);
    
    // 右牆與前牆：地板收邊之後，沒有牆的兩側會直接看到地板切口。
    // 前牆刻意做矮一截（不擋視線），只是把地板邊界收乾淨。
    const right = new THREE.Mesh(new THREE.BoxGeometry(0.22, WALL_H, RD), wallMat);
    right.position.set(HALF_W, WALL_H / 2, 0); right.receiveShadow = true; this.scene.add(right);

    const frontH = WALL_H * 0.16;
    const front = new THREE.Mesh(new THREE.BoxGeometry(RW, frontH, 0.22), baseMat);
    front.position.set(0, frontH / 2, HALF_D); front.receiveShadow = true; this.scene.add(front);

    const b1 = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.22, 0.28), baseMat); b1.position.set(0, 0.11, -HALF_D + 0.05); this.scene.add(b1);
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, RD), baseMat); b2.position.set(-HALF_W + 0.05, 0.11, 0); this.scene.add(b2);
    
    const win = new THREE.Mesh(new THREE.BoxGeometry(RW * 0.30, WALL_H * 0.42, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xbfe3f2, roughness: 0.1, metalness: 0.2, emissive: 0x88bcd6, emissiveIntensity: 0.15 }));
    win.position.set(RW * 0.22, WALL_H * 0.58, -HALF_D + 0.22); this.scene.add(win);
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(RW * 0.33, WALL_H * 0.47, 0.24), baseMat); winFrame.position.set(RW * 0.22, WALL_H * 0.58, -HALF_D + 0.17); this.scene.add(winFrame);
    
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(RW * 0.38, RD * 0.36),
      new THREE.MeshStandardMaterial({ color: 0x9c8f7a, roughness: 1, envMapIntensity: 0.3 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(-RW * 0.05, 0.015, -RD * 0.12); rug.receiveShadow = true; this.scene.add(rug);
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
  /**
   * 某個場域座標處，「一單位 3D 高度」對應多少螢幕像素。
   *
   * 角色是 2D 貼圖，位置雖然有投影，大小卻不會自動隨深度變化 ——
   * 少了這個係數，站在房間最深處與最靠近鏡頭的人畫得一樣大，
   * 看起來像貼紙浮在畫面上而不是站在地板上。
   *
   * 作法是投影同一點的地面與其上方一單位處，取兩者的螢幕距離。
   * 直接用「相機距離的倒數」會忽略 FOV 與畫布長寬比。
   */
  scaleAt(logicX, logicY, worldHeight = 1) {
    this.camera.updateMatrixWorld();
    const p = this.logicTo3D(logicX, logicY);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const foot = new THREE.Vector3(p.x, 0, p.z).project(this.camera);
    const head = new THREE.Vector3(p.x, worldHeight, p.z).project(this.camera);
    const px = Math.abs(head.y - foot.y) * 0.5 * rect.height;
    return Number.isFinite(px) ? px : 0;
  }

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
    // 相機取景：要讓整個場域（角色可走的範圍）都入鏡，同時看得到牆與地板的
    // 交界 —— 那條線是「這是一個房間」的關鍵線索，被裁掉就只剩一片地板。
    // 係數以房間尺寸表示，調整 RW/RD/WALL_H 時取景會自動跟著走。
    const START_POS = new THREE.Vector3(HALF_W * 0.95, WALL_H * 1.85, HALF_D * 1.55);
    const START_TARGET = new THREE.Vector3(0, WALL_H * 0.16, -RD * 0.06);
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
    // composer 與 bloom 各自持有 render target，不跟著 resize 會在換解析度後
    // 顯示上一個尺寸的畫面（拉伸或裁切），而且不會報錯。
    this.composer?.setSize(innerWidth, innerHeight);
    this.bloom?.setSize(innerWidth, innerHeight);
  }

  render() {
    this.controls.update();
    if (this.postEnabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

// 供外部呼叫的輔助函式，根據 PROPS 定義載入家具
export async function populateProps(roomScene, propsDefinition) {
  const promises = propsDefinition.map(p => {
    const p3d = roomScene.logicTo3D(p.x, p.y);
    const url = PROP_URLS[p.type] || PROP_URLS.plant;
    // 預設給一個合理高度 (依類型不同可再調整)
    // 家具高度以「佔牆高的比例」表示，而非絕對值 —— 調整房間尺度時
    // 這裡就不必跟著改，否則家具會相對房間忽大忽小。
    let h = WALL_H * 0.26;                                     // 沙發等
    if (p.type === 'table' || p.type === 'lowtable') h = WALL_H * 0.15;
    if (p.type === 'shelf' || p.type === 'speaker') h = WALL_H * 0.38;
    if (p.type === 'plant') h = WALL_H * 0.20;
    // 朝向來自 shared/scene.js 的 ry —— 那份定義是佈局的單一事實來源。
    // 原本這裡對 sofa 硬寫 Math.PI/2，等於把資料驅動的那半架空：
    // 音箱的 ±PI/4 永遠不會生效，改 shared/scene.js 也不會有任何反應。
    const ry = typeof p.ry === 'number' ? p.ry : 0;
    return roomScene.loadProp(url, h, p3d.x, p3d.z, ry);
  });
  await Promise.all(promises);
}
