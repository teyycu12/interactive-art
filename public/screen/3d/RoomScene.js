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
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { STAGE } from '/shared/protocol.js';

// ===== 房間尺寸 (3D 世界單位) =====
const RW = 17, RD = 13, WALL_H = 4.6;
const HALF_W = RW / 2, HALF_D = RD / 2;

// 模型路徑（Poly Pizza 低多邊形質感模型，已下載至本機）
//
// ⚠ 絕對不要改回 CDN URL。展場網路不通時，六個模型會全部走 loadProp() 的
// 程序化後備，畫面與本機調校結果完全不同 —— 而且要先等滿 6 秒 timeout。
// 這是「本機永遠測不出來」的那類故障（見 CLAUDE.md 鐵則 2）。
//
// key 必須涵蓋 shared/scene.js 的 PROPS.type 全集：
// speaker / table / sofa / lowtable / plant。少一個就靜默 fallback 成盆栽。
const PROP_URLS = {
  sofa: '/assets/models/couch.glb',
  shelf: '/assets/models/shelf.glb',
  plant: '/assets/models/plant.glb',
  lowtable: '/assets/models/lowtable.glb',
  speaker: '/assets/models/shelf.glb',
  table: '/assets/models/lowtable.glb',
};

// 光線與氛圍預設
const PRESETS = {
  day: {
    bg: 0xf3eee5,
    sun: 0xfff4dc,
    sunI: 2.6,
    pos: [12, 14, 9],
    hemi: 1.2,
    hSky: 0xddeeff,
    hGround: 0xb8a98e,
    amb: 0.42,
    lamp: 0.3,
    exp: 1.08,
    rayOp: 0.16,
    rayCol: 0xfff6dd,
    skyCol1: '#7db9e8',
    skyCol2: '#eaf4fc',
  },
  evening: {
    bg: 0xd8b48a,
    sun: 0xffa452,
    sunI: 2.0,
    pos: [18, 9, 14],
    hemi: 0.65,
    hSky: 0xf5c285,
    hGround: 0x5a4838,
    amb: 0.28,
    lamp: 1.6,
    exp: 1.02,
    rayOp: 0.26,
    rayCol: 0xff9944,
    skyCol1: '#de6845',
    skyCol2: '#fcd38d',
  },
  night: {
    bg: 0x0e131d,
    sun: 0x4a5d8f,
    sunI: 0.4,
    pos: [-16, 20, 14],
    hemi: 0.18,
    hSky: 0x253555,
    hGround: 0x090e16,
    amb: 0.09,
    lamp: 2.6,
    exp: 0.9,
    rayOp: 0.06,
    rayCol: 0x7799cc,
    skyCol1: '#090d16',
    skyCol2: '#1a233a',
  },
};

export class RoomScene {
  constructor(containerElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    containerElement.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe7e0d4);
    this.scene.fog = new THREE.Fog(0xe7e0d4, RD * 1.8, RD * 6.0);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 90;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.clock = new THREE.Clock();
    this.swayingObjects = [];
    this.currentLightName = 'day';

    this.setupLights();
    this.buildRoom();

    this.loader = new GLTFLoader();
    this.resetCamera();
    this.setupComposer();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setupComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // 接觸陰影（GTAO）。太陽光的 shadow map 只有 2048 撐整個 17x13 房間，
    // 家具與牆腳、角色與地板交界處那圈細微暗部它解析不出來，物件因此看起來
    // 是「浮在地上」而不是「放在地上」。GTAO 補的正是這一段。
    //
    // radius 的單位是世界單位（房間 17x13x4.6），0.5 約等於一個腳凳的寬度：
    // 再大會讓整面牆糊掉一層灰，再小則看不出接觸感。
    // 這是全場最貴的一個 pass，4K 大螢幕上若掉幀，setAmbientOcclusion(false)
    // 可以單獨關掉它而不影響 Bloom 與 Vignette。
    this.gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.62;
    this.gtao.updateGtaoMaterial({
      radius: 0.5,
      distanceExponent: 1.6,
      thickness: 0.6,
      scale: 1.0,
      samples: 12,
    });
    this.composer.addPass(this.gtao);
    this.aoEnabled = true;

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      0.35,
      0.82,
      0.90
    );
    this.composer.addPass(this.bloom);

    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.04;
    this.vignette.uniforms.darkness.value = 1.15;
    this.composer.addPass(this.vignette);

    this.composer.addPass(new OutputPass());
    this.postEnabled = true;
  }

  setPostProcessing(on) {
    this.postEnabled = !!on && !!this.composer;
  }

  /**
   * 單獨開關接觸陰影。GTAO 是整條後製鏈裡最貴的一個 pass，
   * 現場若掉幀，先關這個 —— 保留 Bloom 與 Vignette 的氛圍，
   * 比 setPostProcessing(false) 一次砍掉全部溫和得多。
   */
  setAmbientOcclusion(on) {
    this.aoEnabled = !!on && !!this.gtao;
    if (this.gtao) this.gtao.enabled = this.aoEnabled;
  }

  setupLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8577, 1.0);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    const r = Math.max(RW, RD);
    this.sun.shadow.camera.left = -r;
    this.sun.shadow.camera.right = r;
    this.sun.shadow.camera.top = r;
    this.sun.shadow.camera.bottom = -r;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = WALL_H * 10;
    this.scene.add(this.sun, this.sun.target);

    // 室內主吊燈
    this.lamp = new THREE.PointLight(0xffd59e, 0.4, 35, 1.3);
    this.lamp.position.set(0, WALL_H * 0.75, 0);
    this.scene.add(this.lamp);

    // 壁燈輔助光
    this.sconceLight = new THREE.PointLight(0xffbe76, 0.6, 12, 1.6);
    this.sconceLight.position.set(-RW * 0.15, WALL_H * 0.55, -HALF_D + 0.5);
    this.scene.add(this.sconceLight);

    this.applyLight('day');
  }

  applyLight(name) {
    this.currentLightName = name;
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
    this.sconceLight.intensity = p.lamp * 0.8;
    this.renderer.toneMappingExposure = p.exp;

    this.updateSkyTexture(p.skyCol1, p.skyCol2);
  }

  /**
   * 生成高品質木質拼接地板紋理 (Parquet Hardwood Texture)
   */
  createWoodFloorTexture() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 1024;
    const ctx = c.getContext('2d');

    // 底色：溫暖斯堪地那維亞原木色
    ctx.fillStyle = '#C2B19A';
    ctx.fillRect(0, 0, 1024, 1024);

    const plankH = 64;
    const plankW = 256;
    const tones = [
      'rgba(195, 175, 150, 0.55)',
      'rgba(215, 195, 170, 0.65)',
      'rgba(182, 160, 135, 0.60)',
      'rgba(202, 182, 158, 0.58)',
      'rgba(175, 152, 126, 0.62)',
    ];

    // 繪製交錯木板
    let rowIdx = 0;
    for (let y = 0; y < 1024; y += plankH) {
      const offsetX = (rowIdx % 2 === 0) ? 0 : plankW / 2;
      for (let x = -plankW; x < 1024 + plankW; x += plankW) {
        const px = x + offsetX;
        const tone = tones[Math.floor(Math.random() * tones.length)];
        ctx.fillStyle = tone;
        ctx.fillRect(px, y, plankW - 2, plankH - 2);

        // 細緻木纖維紋理 (Horizontal micro-fibers)
        ctx.fillStyle = 'rgba(100, 75, 50, 0.05)';
        for (let k = 0; k < 14; k++) {
          const fy = y + 2 + Math.random() * (plankH - 6);
          const fw = 30 + Math.random() * (plankW - 40);
          ctx.fillRect(px + 4 + Math.random() * 20, fy, fw, 1.2);
        }

        // 接縫陰影與倒角高光線
        ctx.fillStyle = 'rgba(70, 52, 35, 0.38)';
        ctx.fillRect(px, y + plankH - 2, plankW, 2);
        ctx.fillRect(px + plankW - 2, y, 2, plankH);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fillRect(px, y, plankW - 2, 1);
        ctx.fillRect(px, y, 1, plankH - 2);
      }
      rowIdx++;
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4.5, 4.5);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * 生成波希米亞/幾何現代編織地毯紋理
   */
  createRugTexture() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');

    // 奶油白羊毛基底
    ctx.fillStyle = '#E8DFD3';
    ctx.fillRect(0, 0, 512, 512);

    // 織物噪點
    for (let i = 0; i < 2000; i++) {
      ctx.fillStyle = (Math.random() > 0.5) ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }

    // 外圍邊框
    ctx.strokeStyle = '#3D5A80';
    ctx.lineWidth = 14;
    ctx.strokeRect(20, 20, 472, 472);

    ctx.strokeStyle = '#E07A5F';
    ctx.lineWidth = 6;
    ctx.strokeRect(34, 34, 444, 444);

    // 中央菱形幾何圖案
    ctx.fillStyle = 'rgba(224, 122, 95, 0.25)';
    ctx.beginPath();
    ctx.moveTo(256, 70);
    ctx.lineTo(440, 256);
    ctx.lineTo(256, 442);
    ctx.lineTo(72, 256);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#3D5A80';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#81B29A';
    ctx.beginPath();
    ctx.arc(256, 256, 45, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * 窗外漸層天空與景深
   */
  updateSkyTexture(c1 = '#7db9e8', c2 = '#eaf4fc') {
    if (!this.skyCanvas) {
      this.skyCanvas = document.createElement('canvas');
      this.skyCanvas.width = 256;
      this.skyCanvas.height = 256;
    }
    const ctx = this.skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    if (!this.skyTex) {
      this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
      this.skyTex.colorSpace = THREE.SRGBColorSpace;
    } else {
      this.skyTex.needsUpdate = true;
    }
    return this.skyTex;
  }

  /**
   * 建立極簡藝術掛畫 (Framed Canvas Art)
   */
  createWallArt() {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 360;
    const ctx = c.getContext('2d');

    // 雅緻米色畫布
    ctx.fillStyle = '#F5F2EB';
    ctx.fillRect(0, 0, 512, 360);

    // 現代幾何色塊構圖
    ctx.fillStyle = '#E76F51';
    ctx.beginPath();
    ctx.arc(170, 180, 95, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#264653';
    ctx.fillRect(230, 90, 160, 190);

    ctx.fillStyle = '#E9C46A';
    ctx.beginPath();
    ctx.moveTo(130, 290);
    ctx.lineTo(390, 290);
    ctx.lineTo(260, 120);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#2F2A26';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(260, 190, 120, 0.4, 2.8);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const group = new THREE.Group();
    // 橡木外框
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.6 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.7, 0.08), frameMat);
    frame.castShadow = true;
    group.add(frame);

    // 畫芯
    const artMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
    const art = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.5), artMat);
    art.position.z = 0.045;
    group.add(art);

    return group;
  }

  buildRoom() {
    // 1. 高級拼木地板
    const floorGeo = new THREE.PlaneGeometry(RW * 1.08, RD * 1.08);
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.createWoodFloorTexture(),
      roughness: 0.58,
      metalness: 0.04,
      envMapIntensity: 0.45,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 2. 雙色護牆板材質
    const upperWallMat = new THREE.MeshStandardMaterial({
      color: 0xc8d3c5, // 雅緻鼠尾草灰綠
      roughness: 0.94,
      envMapIntensity: 0.25,
    });
    const lowerWainscotMat = new THREE.MeshStandardMaterial({
      color: 0xede8df, // 暖調米白護牆板
      roughness: 0.72,
      envMapIntensity: 0.35,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xf5f2eb, // 象牙白飾條
      roughness: 0.55,
      envMapIntensity: 0.4,
    });

    const wainscotH = WALL_H * 0.36;
    const upperH = WALL_H - wainscotH;

    // 後牆 (上下分色)
    const backLower = new THREE.Mesh(new THREE.BoxGeometry(RW, wainscotH, 0.22), lowerWainscotMat);
    backLower.position.set(0, wainscotH / 2, -HALF_D);
    backLower.receiveShadow = true;
    backLower.castShadow = true;
    this.scene.add(backLower);

    const backUpper = new THREE.Mesh(new THREE.BoxGeometry(RW, upperH, 0.22), upperWallMat);
    backUpper.position.set(0, wainscotH + upperH / 2, -HALF_D);
    backUpper.receiveShadow = true;
    backUpper.castShadow = true;
    this.scene.add(backUpper);

    // 左牆 (上下分色)
    const leftLower = new THREE.Mesh(new THREE.BoxGeometry(0.22, wainscotH, RD), lowerWainscotMat);
    leftLower.position.set(-HALF_W, wainscotH / 2, 0);
    leftLower.receiveShadow = true;
    leftLower.castShadow = true;
    this.scene.add(leftLower);

    const leftUpper = new THREE.Mesh(new THREE.BoxGeometry(0.22, upperH, RD), upperWallMat);
    leftUpper.position.set(-HALF_W, wainscotH + upperH / 2, 0);
    leftUpper.receiveShadow = true;
    leftUpper.castShadow = true;
    this.scene.add(leftUpper);

    // 右牆
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.22, WALL_H, RD), upperWallMat);
    rightWall.position.set(HALF_W, WALL_H / 2, 0);
    rightWall.receiveShadow = true;
    this.scene.add(rightWall);

    // 前矮收邊牆
    const frontH = WALL_H * 0.16;
    const front = new THREE.Mesh(new THREE.BoxGeometry(RW, frontH, 0.22), trimMat);
    front.position.set(0, frontH / 2, HALF_D);
    front.receiveShadow = true;
    this.scene.add(front);

    // 護牆板壓頂飾條 (Wainscot Molding Rails)
    const railBack = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.10, 0.28), trimMat);
    railBack.position.set(0, wainscotH, -HALF_D + 0.04);
    this.scene.add(railBack);

    const railLeft = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.10, RD), trimMat);
    railLeft.position.set(-HALF_W + 0.04, wainscotH, 0);
    this.scene.add(railLeft);

    // 踢腳板 (Baseboards)
    const baseBack = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.24, 0.30), trimMat);
    baseBack.position.set(0, 0.12, -HALF_D + 0.05);
    this.scene.add(baseBack);

    const baseLeft = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.24, RD), trimMat);
    baseLeft.position.set(-HALF_W + 0.05, 0.12, 0);
    this.scene.add(baseLeft);

    // 天花線條 (Crown Molding)
    const crownBack = new THREE.Mesh(new THREE.BoxGeometry(RW, 0.16, 0.28), trimMat);
    crownBack.position.set(0, WALL_H - 0.08, -HALF_D + 0.04);
    this.scene.add(crownBack);

    // 3. 窗戶系統與窗外視差 (Window with Vista & Curtains)
    const winW = RW * 0.32;
    const winH = WALL_H * 0.44;
    const winX = RW * 0.22;
    const winY = WALL_H * 0.60;
    const winZ = -HALF_D;

    // 窗外景深天空板 (Outdoor Sky Backdrop)
    const skyMat = new THREE.MeshBasicMaterial({ map: this.updateSkyTexture() });
    const skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(winW * 1.6, winH * 1.5), skyMat);
    skyMesh.position.set(winX, winY, winZ - 0.3);
    this.scene.add(skyMesh);

    // 窗外遠景綠植 Silhouette
    const bushMat = new THREE.MeshBasicMaterial({ color: 0x5a7d5a, transparent: true, opacity: 0.85 });
    for (let b = 0; b < 3; b++) {
      const bush = new THREE.Mesh(new THREE.CircleGeometry(0.9 + b * 0.3, 16), bushMat);
      bush.position.set(winX - 1.6 + b * 1.4, winY - winH * 0.35, winZ - 0.2);
      this.scene.add(bush);
    }

    // 窗框主體 (Window Frame)
    const frameOuter = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, 0.26), trimMat);
    frameOuter.position.set(winX, winY, winZ + 0.14);
    this.scene.add(frameOuter);

    // 窗戶玻璃 (Glass Pane)
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xd6f0fa,
      roughness: 0.05,
      metalness: 0.15,
      transparent: true,
      opacity: 0.45,
      emissive: 0x90cde6,
      emissiveIntensity: 0.2,
    });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW * 0.88, winH * 0.86), glassMat);
    glass.position.set(winX, winY, winZ + 0.16);
    this.scene.add(glass);

    // 窗櫺十字格 (Mullions)
    const mullionV = new THREE.Mesh(new THREE.BoxGeometry(0.08, winH * 0.86, 0.1), trimMat);
    mullionV.position.set(winX, winY, winZ + 0.18);
    this.scene.add(mullionV);

    const mullionH = new THREE.Mesh(new THREE.BoxGeometry(winW * 0.88, 0.08, 0.1), trimMat);
    mullionH.position.set(winX, winY, winZ + 0.18);
    this.scene.add(mullionH);

    // 窗台 (Window Sill)
    const sill = new THREE.Mesh(new THREE.BoxGeometry(winW * 1.08, 0.12, 0.42), trimMat);
    sill.position.set(winX, winY - winH / 2 - 0.04, winZ + 0.20);
    this.scene.add(sill);

    // 飄逸窗簾 (Translucent Curtains)
    const curtainMat = new THREE.MeshStandardMaterial({
      color: 0xfcf9f2,
      roughness: 0.9,
      transparent: true,
      opacity: 0.88,
    });
    const curtainL = new THREE.Mesh(new THREE.BoxGeometry(0.55, winH * 1.12, 0.12), curtainMat);
    curtainL.position.set(winX - winW / 2 - 0.18, winY - 0.06, winZ + 0.24);
    curtainL.castShadow = true;
    this.scene.add(curtainL);

    const curtainR = new THREE.Mesh(new THREE.BoxGeometry(0.55, winH * 1.12, 0.12), curtainMat);
    curtainR.position.set(winX + winW / 2 + 0.18, winY - 0.06, winZ + 0.24);
    curtainR.castShadow = true;
    this.scene.add(curtainR);

    // 4. 精緻幾何編織地毯 (Boho Rug)
    const rugGeo = new THREE.PlaneGeometry(RW * 0.44, RD * 0.42);
    const rugMat = new THREE.MeshStandardMaterial({
      map: this.createRugTexture(),
      roughness: 0.98,
      envMapIntensity: 0.2,
    });
    const rug = new THREE.Mesh(rugGeo, rugMat);
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-RW * 0.05, 0.016, -RD * 0.08);
    rug.receiveShadow = true;
    this.scene.add(rug);

    // 5. 牆面現代藝術掛畫 (Wall Gallery Art)
    const artLeft = this.createWallArt();
    artLeft.position.set(-HALF_W + 0.08, WALL_H * 0.65, -RD * 0.12);
    artLeft.rotation.y = Math.PI / 2;
    this.scene.add(artLeft);

    const artBack = this.createWallArt();
    artBack.scale.set(0.85, 0.85, 0.85);
    artBack.position.set(-RW * 0.26, WALL_H * 0.66, -HALF_D + 0.08);
    this.scene.add(artBack);

    // 6. 現代黃銅壁燈 (Wall Sconces)
    const sconceMat = new THREE.MeshStandardMaterial({ color: 0xc49b45, metalness: 0.8, roughness: 0.25 });
    const shadeMat = new THREE.MeshStandardMaterial({
      color: 0xfff3db,
      roughness: 0.3,
      emissive: 0xffdb99,
      emissiveIntensity: 0.6,
    });

    const sconceGroup = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 12), sconceMat);
    rod.position.set(0, 0, 0.15);
    sconceGroup.add(rod);

    const shade = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), shadeMat);
    shade.position.set(0, 0.22, 0.18);
    sconceGroup.add(shade);

    sconceGroup.position.set(-RW * 0.15, WALL_H * 0.55, -HALF_D + 0.08);
    this.scene.add(sconceGroup);
  }

  /**
   * GLTF 載入失敗時的程序化備援模型生成器 (Procedural Geometry Fallback)
   */
  createFallbackProp(type, targetH) {
    const group = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5839, roughness: 0.65 });
    const fabricMat = new THREE.MeshStandardMaterial({ color: 0x457b9d, roughness: 0.85 });
    const plantMat = new THREE.MeshStandardMaterial({ color: 0x387042, roughness: 0.8 });
    const potMat = new THREE.MeshStandardMaterial({ color: 0xd9c5b2, roughness: 0.5 });

    if (type === 'couch' || type === 'sofa') {
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 1.2), fabricMat);
      base.position.y = 0.25;
      base.castShadow = true;
      group.add(base);

      const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 0.35), fabricMat);
      back.position.set(0, 0.7, -0.42);
      back.castShadow = true;
      group.add(back);
    } else if (type === 'plant') {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.6, 16), potMat);
      pot.position.y = 0.3;
      pot.castShadow = true;
      group.add(pot);

      for (let l = 0; l < 5; l++) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 8), plantMat);
        leaf.scale.set(1, 1.6, 0.3);
        leaf.position.set(Math.sin(l * 1.3) * 0.22, 0.7 + l * 0.12, Math.cos(l * 1.3) * 0.22);
        leaf.castShadow = true;
        group.add(leaf);
      }
    } else {
      // 預設桌几/音箱
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.1, 18), woodMat);
      top.position.y = 0.65;
      top.castShadow = true;
      group.add(top);

      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.65, 12), woodMat);
      leg.position.y = 0.32;
      group.add(leg);
    }

    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    group.scale.setScalar(targetH / (size.y || 1));
    return group;
  }

  async loadProp(url, targetH, x, z, ry = 0, type = 'prop') {
    let pivot = null;
    try {
      if (!url) throw new Error('No URL');
      const gltf = await new Promise((res, rej) => {
        const timeout = setTimeout(() => rej(new Error('GLTF load timeout')), 6000);
        this.loader.load(
          url,
          (data) => {
            clearTimeout(timeout);
            res(data);
          },
          undefined,
          (err) => {
            clearTimeout(timeout);
            rej(err);
          }
        );
      });

      const o = gltf.scene;
      o.traverse((m) => {
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          if (m.material) m.material.envMapIntensity = 0.55;
        }
      });
      let box = new THREE.Box3().setFromObject(o);
      const size = new THREE.Vector3();
      box.getSize(size);
      o.scale.setScalar(targetH / size.y);
      box = new THREE.Box3().setFromObject(o);
      const c = new THREE.Vector3();
      box.getCenter(c);
      o.position.x -= c.x;
      o.position.z -= c.z;
      o.position.y -= box.min.y;

      pivot = new THREE.Group();
      pivot.add(o);
    } catch (e) {
      // 離線或 CDN 異常時自動啟用高品質程序化後備
      pivot = new THREE.Group();
      pivot.add(this.createFallbackProp(type, targetH));
    }

    pivot.position.set(x, 0, z);
    pivot.rotation.y = ry;
    this.scene.add(pivot);

    if (type === 'plant') {
      this.swayingObjects.push({ obj: pivot, baseRy: ry, offset: Math.random() * 6 });
    }
    return pivot;
  }

  // 將邏輯坐標 (1920x1080) 映射至 3D 空間
  logicTo3D(logicX, logicY) {
    return {
      x: (logicX / STAGE.width) * RW - HALF_W,
      z: (logicY / STAGE.height) * RD - HALF_D,
    };
  }

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
    this.camera.updateMatrixWorld();
    const p3d = this.logicTo3D(logicX, logicY);
    const vector = new THREE.Vector3(p3d.x, 0, p3d.z);
    vector.project(this.camera);

    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: (vector.x * 0.5 + 0.5) * rect.width,
      y: (-(vector.y * 0.5) + 0.5) * rect.height,
    };
  }

  resetCamera() {
    const START_POS = new THREE.Vector3(HALF_W * 0.95, WALL_H * 1.85, HALF_D * 1.55);
    const START_TARGET = new THREE.Vector3(0, WALL_H * 0.16, -RD * 0.06);
    this.camera.position.copy(START_POS);
    this.controls.target.copy(START_TARGET);
    this.controls.update();
    this.camera.updateMatrixWorld();
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer?.setSize(innerWidth, innerHeight);
    this.bloom?.setSize(innerWidth, innerHeight);
    // 漏了這行的話，切換全螢幕或投影機改解析度之後，
    // AO 會沿用舊尺寸的 G-buffer，暗部整個對不上物件邊緣。
    this.gtao?.setSize(innerWidth, innerHeight);
  }

  render() {
    // getElapsedTime() 內部就會呼叫 getDelta()（見 three 的 Clock），
    // 因此這裡不需要、也不該另外取一次 delta —— 取了不用只會讓人以為
    // 這個迴圈是 delta-based 的。動畫一律吃 elapsed（絕對時間），
    // 掉幀時相位不會跟著漂。
    const elapsed = this.clock.getElapsedTime();

    this.controls.update();

    // 1. 植物微風輕晃動態
    for (const item of this.swayingObjects) {
      item.obj.rotation.y = item.baseRy + Math.sin(elapsed * 1.4 + item.offset) * 0.025;
      item.obj.rotation.z = Math.cos(elapsed * 1.1 + item.offset) * 0.012;
    }

    // 3. 壁燈微弱暖光呼吸
    if (this.sconceLight && this.currentLightName !== 'night') {
      const p = PRESETS[this.currentLightName] || PRESETS.day;
      this.sconceLight.intensity = p.lamp * 0.8 + Math.sin(elapsed * 3.2) * 0.04;
    }

    if (this.postEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

// 供外部呼叫的輔助函式，根據 PROPS 定義載入家具
export async function populateProps(roomScene, propsDefinition) {
  const promises = propsDefinition.map((p) => {
    const p3d = roomScene.logicTo3D(p.x, p.y);
    const url = PROP_URLS[p.type] || PROP_URLS.plant;
    let h = WALL_H * 0.26;
    if (p.type === 'table' || p.type === 'lowtable') h = WALL_H * 0.15;
    if (p.type === 'shelf' || p.type === 'speaker') h = WALL_H * 0.38;
    if (p.type === 'plant') h = WALL_H * 0.20;
    const ry = typeof p.ry === 'number' ? p.ry : 0;
    return roomScene.loadProp(url, h, p3d.x, p3d.z, ry, p.type);
  });
  await Promise.all(promises);
}
