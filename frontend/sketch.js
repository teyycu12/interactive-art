const APP_STATES = {
  LIVE: 0,
  PROCESSING: 1,
  CUSTOMIZE: 2,
  SWARM: 3,
};

const DEFAULT_STYLE_ID = 'lego';

let currentState = APP_STATES.LIVE;
const characters = [];
let capture;

// State transition variables
let countdownValue = 0;
let countdownStartTime = 0;
let countdownInvalidFrames = 0;
let isDetecting = false;
let cameraEnabled = false;
let lastFrameSent = 0;
let latestFeatures = null;
let frameSequence = 0;
let activeAvatarRequestId = null;
let activeGenerationMode = 'full_character';
let generationStartedAt = 0;
let pendingRenderedSnapshot = null;
const savedRenderedRequestIds = new Set();
let generationProgress = {
  stage: 'queued', percent: 0, displayPercent: 0,
  message: '準備送出生成請求',
};

// UI Elements
let accessoryPanel;
let downloadBtn;
let retryBtn;
let joinProjectionBtn;
let leaveSwarmBtn;
let loadPhotoBtn;
let photoFileInput;

// Swarm state
const swarmPersons = {};
let myAvatarData = null;

// hexToRgb is defined in character.js (loaded before sketch.js)

class Person {
  constructor(x, y) {
    this.x = x;
    this.y = y;

    // Walking animation state (used by lego.js drawLegoCharacter)
    this.vel = { x: 0, y: 0 };
    this.walkPhase = 0;

    // Clothing
    this.innerColor = { r: 200, g: 200, b: 200 };
    this.outerColor = null;
    this.lowerColor = { r: 100, g: 100, b: 100 };
    this.innerType = 'tshirt';
    this.outerType = 'none';
    this.lowerType = 'shorts';
    this.upperKind = 'short_sleeve';   // 'short_sleeve' | 'long_sleeve' — drives bare-arm rendering
    this.stencilImg = null;
    this.accessories = [];
    this.alpha = 255;
    // Legacy image sprites are retained only for full-character history compatibility.
    this.clothSprite = null;  // p5.Image (legacy: upper-only)
    this.lowerSprite = null;  // p5.Image (legacy: lower-only)
    this.bodySprite = null;  // p5.Image (NEW: full LEGO body, neck down)

    // Face / hair (defaults — overwritten by updateFace)
    this.armColor = null;  // detected sleeve colour; overrides outerColor for arm rendering
    this.skinColor = { r: 255, g: 224, b: 196 };
    this.hairColor = { r: 45, g: 35, b: 30 };
    this.eyeColor = { r: 55, g: 35, b: 20 }; // dark brown default
    this.lipColor = { r: 220, g: 110, b: 110 };
    this.hairStyle = 'short_straight';
    this.faceShape = 'oval';
    this.eyeShape = 'almond';
    this.eyebrowStyle = 'normal';
    this.smileScore = 0.0;
    this.hasBeard = false;
    this.beardStyle = 'none';

    // 'full_character': one AI image covers the entire figure, so the
    // programmatic LEGO parts are skipped entirely.
    this.renderMode = 'full_character';
    this.styleId = DEFAULT_STYLE_ID;
    this.heightClass = 'medium';
    this.heightProfile = { id: 'medium', display_scale: 1, torso_scale_y: 1, leg_scale_y: 1 };

    // Forward-compat slots for future skeletal rigging (out of scope here, but
    // populated by a downstream pipeline so themes/animation can read them).
    this.skeleton = null;   // { joints: [...], bones: [...] }
    this.animState = 'idle'; // 'idle' | 'walking' | 'greeting' | ...
  }

  setRenderMode(mode) {
    if (mode === 'full_character') {
      this.renderMode = mode;
    }
  }

  updateFromVLM(outfit, stencilB64, face) {
    if (outfit.inner_color) this.innerColor = hexToRgb(outfit.inner_color);
    if (outfit.outer_color) this.outerColor = hexToRgb(outfit.outer_color);
    if (outfit.lower_color) this.lowerColor = hexToRgb(outfit.lower_color);
    this.innerType = outfit.inner || 'tshirt';
    this.outerType = outfit.outer || 'none';
    this.lowerType = outfit.lower || 'jeans';
    if (stencilB64) {
      loadImage('data:image/png;base64,' + stencilB64, img => { this.stencilImg = img; });
    } else {
      this.stencilImg = null;
    }
    this.updateFace(face);
  }

  // Load OpenAI-generated full-body LEGO sprite (base64 PNG, no data: prefix)
  updateBodySprite(bodyPng) {
    // Prevent a delayed load from capturing an older request's sprite.
    this.bodySprite = null;
    if (bodyPng) {
      loadImage('data:image/png;base64,' + bodyPng,
        img => { this.bodySprite = img; },
        () => { console.warn('body sprite load failed'); }
      );
    } else {
      this.bodySprite = null;
    }
  }

  updateFace(face) {
    if (!face) return;
    // Use VLM-detected skin tone (head + hands + bare arms render in this colour)
    if (face.skin_tone) this.skinColor = hexToRgb(face.skin_tone);
    if (face.hair_color) this.hairColor = hexToRgb(face.hair_color);
    if (face.eye_color) this.eyeColor = hexToRgb(face.eye_color);
    if (face.lip_color) this.lipColor = hexToRgb(face.lip_color);
    if (face.hair_style) this.hairStyle = face.hair_style;
    if (face.face_shape) this.faceShape = face.face_shape;
    if (face.eye_shape) this.eyeShape = face.eye_shape;
    if (face.eyebrow_style) this.eyebrowStyle = face.eyebrow_style;
    if (face.smile_score !== undefined) this.smileScore = face.smile_score;
    if (face.has_beard !== undefined) this.hasBeard = face.has_beard;
    if (face.beard_style) this.beardStyle = face.beard_style;
  }

  drawSelf(scaleFactor = 1.2) {
    const theme = window.PersonaFlowThemes?.get(this.styleId || DEFAULT_STYLE_ID);
    const heightScale = Number(this.heightProfile?.display_scale) || 1;
    const footAnchor = typeof theme?.footAnchor === 'function' ? theme.footAnchor(this) : 0;
    const baseFootAnchor = Number(theme?.baseFootAnchor) || footAnchor;
    push();
    // Keep the feet on the same baseline while applying both the profile's
    // geometry and its uniform display scale.
    translate(this.x, this.y + scaleFactor * (baseFootAnchor - footAnchor * heightScale));
    scale(scaleFactor * heightScale);

    if (theme?.draw) {
      theme.draw(this);
      if (typeof drawAccessories === 'function') drawAccessories(this.accessories, 1, theme.accessoryOptions || {});
      pop();
      return;
    }

    // Build p5 color objects from instance state
    const sc = color(this.skinColor.r, this.skinColor.g, this.skinColor.b);
    const hc = color(this.hairColor.r, this.hairColor.g, this.hairColor.b);
    const ec = this.eyeColor;   // kept as {r,g,b} for _drawEyes
    // lc (lip color) used inline below via this.lipColor
    const iColor = color(this.innerColor.r, this.innerColor.g, this.innerColor.b);
    const lColor = color(this.lowerColor.r, this.lowerColor.g, this.lowerColor.b);

    stroke('#5a3a29');
    strokeWeight(2);
    strokeJoin(ROUND);

    // 1. Back hair (behind everything)
    _hairBack(this.hairStyle, hc);

    // 2. Legs
    fill(sc); noStroke();
    rect(-18, 20, 12, 60, 6);
    rect(6, 20, 12, 60, 6);
    stroke('#5a3a29'); strokeWeight(2);

    // 3. Lower body
    fill(lColor);
    if (this.lowerType === 'jeans' || this.lowerType === 'suit_pants' || this.lowerType === 'long_pants') {
      rect(-20, 20, 16, 55, 2, 2, 5, 5);
      rect(4, 20, 16, 55, 2, 2, 5, 5);
    } else if (this.lowerType === 'shorts') {
      rect(-20, 20, 16, 20, 2);
      rect(4, 20, 16, 20, 2);
    } else if (this.lowerType === 'pleated_skirt' || this.lowerType === 'skirt') {
      quad(-25, 15, 25, 15, 40, 40, -40, 40);
      fill(this.lowerColor.r * 0.85, this.lowerColor.g * 0.85, this.lowerColor.b * 0.85);
      rect(-40, 40, 80, 6, 3);
      stroke(0, 40); strokeWeight(1.5);
      for (let i = -30; i <= 30; i += 10) line(i * 0.8, 15, i, 40);
      stroke('#5a3a29'); strokeWeight(2);
    }

    // 4. Inner torso
    fill(iColor);
    if (this.innerType === 'vneck') {
      quad(-20, -40, 20, -40, 25, 20, -25, 20);
      fill(sc); triangle(-10, -40, 10, -40, 0, -25);
    } else if (this.innerType === 'button_up') {
      quad(-20, -40, 20, -40, 25, 20, -25, 20);
      stroke(0, 50); strokeWeight(1.5);
      line(0, -40, 0, 20);
      for (let y = -30; y < 15; y += 10) circle(0, y, 3);
      stroke('#5a3a29'); strokeWeight(2);
    } else {
      quad(-20, -40, 20, -40, 25, 20, -25, 20);
    }

    // 5. Legacy stencil overlay (never used by the formal CharacterSpec renderer)
    if (this.stencilImg && this.stencilImg.width > 0) {
      push();
      imageMode(CENTER);
      drawingContext.save();
      drawingContext.beginPath();
      drawingContext.moveTo(-20, -40); drawingContext.lineTo(20, -40);
      drawingContext.lineTo(25, 20); drawingContext.lineTo(-25, 20);
      drawingContext.clip();
      tint(255, 220);
      image(this.stencilImg, 0, -10, 40, 40);
      drawingContext.restore();
      pop();
    }

    // 6. Outer jacket / blazer
    if (this.outerType !== 'none' && this.outerColor) {
      const oColor = color(this.outerColor.r, this.outerColor.g, this.outerColor.b);
      fill(oColor);
      if (this.outerType === 'blazer' || this.outerType === 'cardigan') {
        beginShape(); vertex(-22, -42); vertex(0, -15); vertex(-5, 22); vertex(-27, 22); endShape(CLOSE);
        beginShape(); vertex(22, -42); vertex(0, -15); vertex(5, 22); vertex(27, 22); endShape(CLOSE);
        if (this.outerType === 'blazer') {
          fill(this.outerColor.r * 0.9, this.outerColor.g * 0.9, this.outerColor.b * 0.9);
          triangle(-20, -40, 0, -15, -12, -25);
          triangle(20, -40, 0, -15, 12, -25);
        }
      } else if (this.outerType === 'denim_jacket') {
        rect(-27, -42, 22, 60, 4); rect(5, -42, 22, 60, 4);
        stroke(200, 150, 50, 100); strokeWeight(2);
        line(-16, -42, -16, 18); line(16, -42, 16, 18);
        stroke('#5a3a29'); strokeWeight(4);
      }
    }

    // 7. Arms
    const _arm = (x, rot) => {
      push(); translate(x, -35); rotate(rot);
      fill(sc); rect(-6, 0, 12, 50, 6);
      const sleeveC = (this.outerType !== 'none' && this.outerColor)
        ? color(this.outerColor.r, this.outerColor.g, this.outerColor.b) : iColor;
      const longSleeve = this.outerType !== 'none' || this.innerType === 'button_up';
      fill(sleeveC);
      rect(-7, 0, 14, longSleeve ? 45 : 18, 4, 4, 2, 2);
      pop();
    };
    _arm(-20, PI / 6);
    _arm(20, -PI / 6);

    // 8. Head & neck
    fill(sc);
    rect(-8, -45, 16, 18); // neck (taller to fill gap)

    // Ears — at face edge, same style as reference arc(85,225,...) / arc(315,225,...)
    stroke('#5a3a29'); strokeWeight(2);
    arc(-50, -62, 22, 28, HALF_PI, PI + HALF_PI);
    arc(50, -62, 22, 28, -HALF_PI, HALF_PI);

    // Chibi face — round, wide cheeks
    beginShape();
    vertex(-50, -75);
    bezierVertex(-54, -48, -30, -27, 0, -26);
    bezierVertex(30, -27, 54, -48, 50, -75);
    bezierVertex(50, -118, -50, -118, -50, -75);
    endShape(CLOSE);

    // 9. Blush — horizontal ovals, matching reference ellipse(115,268,25,12) proportions
    //    reference y=268 is ~47% below face top (y=200→330); mapped → y≈-47
    //    reference x=115 is ±85 from center, scaled → ±37
    noStroke();
    fill(255, 99, 71, 90);
    ellipse(-36, -47, 28, 12);
    ellipse(36, -47, 28, 12);

    // 10. Eyes (shape + color aware, from character.js)
    _drawEyes(this.eyeShape, ec);

    // 11. Eyebrows
    _drawEyebrows(this.eyebrowStyle);

    // 12. Mouth (smile-score driven)
    noFill(); stroke('#5a3a29'); strokeWeight(2);
    const smileW = 7 + this.smileScore * 10;
    const smileH = 4 + this.smileScore * 8;
    arc(0, -40, smileW, smileH, 0, PI);

    // 13. Lip tint
    noStroke(); fill(this.lipColor.r, this.lipColor.g, this.lipColor.b, 70);
    ellipse(0, -39, smileW * 0.9, 4);

    // 14. Beard / facial hair
    if (this.hasBeard) _drawBeard(this.beardStyle, this.skinColor, this.hairColor);

    // 15. Front hair (on top of face)
    stroke('#5a3a29'); strokeWeight(2);
    _hairFront(this.hairStyle, hc);

    // 16. Accessories (multi)
    if (typeof drawAccessories === 'function') drawAccessories(this.accessories, 1);

    pop();
  }
}

function createBtn(label, bg, action) {
  const btn = document.createElement('button');
  btn.innerText = label;
  btn.style.background = bg;
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.padding = '12px 24px';
  btn.style.borderRadius = '8px';
  btn.style.fontSize = '16px';
  btn.style.fontWeight = 'bold';
  btn.style.cursor = 'pointer';
  btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
  btn.onclick = action;
  btn.style.display = 'none';
  btn.style.position = 'absolute';
  document.body.appendChild(btn);
  return btn;
}

function createAccessoryPanel() {
  const panel = document.createElement('div');
  panel.style.position = 'absolute';
  panel.style.display = 'none';
  panel.style.flexWrap = 'wrap';
  panel.style.gap = '6px';
  panel.style.width = '170px';
  document.body.appendChild(panel);

  const selected = new Set();
  const buttons = {};
  const items = typeof ACCESSORIES_LIST !== 'undefined'
    ? ACCESSORIES_LIST.filter(a => a.value !== 'none') : [];

  for (const acc of items) {
    const btn = document.createElement('button');
    btn.innerText = acc.label;
    btn.style.cssText = 'width:82px;height:36px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;font-size:13px;cursor:pointer;';
    btn.onclick = () => {
      if (selected.has(acc.value)) {
        selected.delete(acc.value);
        btn.style.background = '#21262d';
        btn.style.border = '1px solid #30363d';
      } else {
        selected.add(acc.value);
        btn.style.background = '#1f6feb';
        btn.style.border = '1px solid #58a6ff';
      }
    };
    panel.appendChild(btn);
    buttons[acc.value] = btn;
  }

  return {
    values: () => Array.from(selected),
    show: () => { panel.style.display = 'flex'; },
    hide: () => { panel.style.display = 'none'; },
    position: (x, y) => { panel.style.left = x + 'px'; panel.style.top = y + 'px'; },
    reset: () => {
      selected.clear();
      for (const b of Object.values(buttons)) {
        b.style.background = '#21262d';
        b.style.border = '1px solid #30363d';
      }
    },
  };
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  // Camera is intentionally opt-in. Do not request permission or create a
  // MediaStream until the visitor presses 「開啟攝影機」.
  capture = null;
  cameraEnabled = false;
  isDetecting = false;

  characters.push(new Person(0, 0));

  accessoryPanel = createAccessoryPanel();

  downloadBtn = createBtn('💾 DOWNLOAD AVATAR', '#2ea043', () => {
    saveCanvas('PersonaFlow_Avatar', 'png');
  });

  retryBtn = createBtn('🔄 RETRY', '#da3633', () => {
    currentState = APP_STATES.LIVE;
    isDetecting = cameraEnabled;
    countdownValue = 0;
    accessoryPanel.hide();
    accessoryPanel.reset();
    downloadBtn.style.display = 'none';
    retryBtn.style.display = 'none';
    joinProjectionBtn.style.display = 'none';
  });

  joinProjectionBtn = createBtn('🌐 JOIN PROJECTION WALL', '#8250df', _joinSwarm);

  // 測試用：載入本地照片取代拍照，走相同 generate_avatar 路徑
  photoFileInput = document.createElement('input');
  photoFileInput.type = 'file';
  photoFileInput.accept = 'image/*';
  photoFileInput.style.display = 'none';
  photoFileInput.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      if (window.personaFlow?.socket) {
        _requestAvatarGeneration(dataUrl, 'upload');
        currentState = APP_STATES.PROCESSING;
      }
    };
    reader.readAsDataURL(file);
    photoFileInput.value = '';
  };
  document.body.appendChild(photoFileInput);

  loadPhotoBtn = createBtn('📁 LOAD TEST PHOTO', '#6e7681', () => {
    photoFileInput.click();
  });

  leaveSwarmBtn = createBtn('← BACK', '#6e7681', () => {
    if (window.personaFlow?.socket && window.personaFlow.myCharId) {
      window.personaFlow.socket.emit("leave_swarm", { id: window.personaFlow.myCharId });
    }
    window.personaFlow._lastJoinPayload = null;
    currentState = APP_STATES.CUSTOMIZE;
  });

  window.addEventListener("clothing_features", (e) => {
    latestFeatures = e.detail;
    if (latestFeatures?.arm_color) {
      characters[0].armColor = hexToRgb(latestFeatures.arm_color.hex);
    }
  });

  window.addEventListener("generation_progress", (e) => {
    const payload = e.detail || {};
    if (payload.request_id && activeAvatarRequestId && payload.request_id !== activeAvatarRequestId) return;
    generationProgress.stage = payload.stage || generationProgress.stage;
    generationProgress.percent = Math.max(generationProgress.percent, Number(payload.percent || 0));
    generationProgress.message = payload.message || generationProgress.message;
  });

  window.addEventListener("avatar_generated", (e) => {
    const payload = e.detail;
    if (payload.request_id && activeAvatarRequestId && payload.request_id !== activeAvatarRequestId) return;
    if (payload.ok) {
      if (payload.is_final) {
        generationProgress.percent = 100;
        generationProgress.stage = 'complete';
        generationProgress.message = '角色生成完成';
      }
      myAvatarData = payload;
      // Set render mode FIRST so subsequent sprite/face updates can read it if needed
      if (payload.character_mode) characters[0].setRenderMode(payload.character_mode);
      characters[0].updateFromVLM(
        payload.outfit,
        payload.stencil,
        null
      );
      // The sprite is the entire figure (head→feet); programmatic parts are skipped.
      characters[0].updateBodySprite(payload.body_png);
      // Sleeve length (from cv_module): drives bare-arm rendering in lego theme
      if (payload.upper_type) characters[0].upperKind = payload.upper_type;
      if (payload.face) characters[0].updateFace(payload.face);
      if (payload.arm_color) characters[0].armColor = hexToRgb(payload.arm_color.hex);
      characters[0].styleId = payload.style_id || DEFAULT_STYLE_ID;
      characters[0].heightClass = payload.height_class || null;
      characters[0].heightProfile = payload.height_profile || null;
      if (payload.is_final !== false && payload.request_id && !savedRenderedRequestIds.has(payload.request_id)) {
        pendingRenderedSnapshot = {
          requestId: payload.request_id,
          waitsForSprite: Boolean(payload.body_png),
          queuedAt: Date.now(),
        };
      }
      currentState = payload.is_final === false ? APP_STATES.PROCESSING : APP_STATES.CUSTOMIZE;
    } else {
      // A pending deterministic CharacterSpec is only an internal preview.
      // Formal mode must never expose it as a finished character after the AI
      // atlas fails its species/detail contract.
      myAvatarData = null;
      generationProgress.stage = 'failed';
      generationProgress.message = payload.guidance || payload.error || '生成未通過檢查';
      console.error("Avatar Gen Failed", payload.error);
      const reason = payload.guidance || payload.error || 'unknown_error';
      // Billing is split out from 'service' because "暫時" would be a lie: the
      // request never reached the model and waiting changes nothing.
      const title = payload.error_kind === 'billing'
        ? '生圖服務餘額不足，請求未送出。'
        : payload.error_kind === 'service'
          ? '生圖服務暫時無法完成請求。'
          : '生成結果需要重新拍攝或上傳。';
      alert(title + "\n\n原因：" + reason);
      currentState = APP_STATES.LIVE;
    }
  });

  window.addEventListener("update_positions", (e) => {
    const chars = e.detail.characters || [];
    const incoming = new Set(chars.map(c => c.id));
    for (const id of Object.keys(swarmPersons)) {
      if (!incoming.has(id)) delete swarmPersons[id];
    }
    for (const c of chars) {
      if (!swarmPersons[c.id]) {
        const p = new Person(0, 0);
        if (c.outfit) {
          p.updateFromVLM(c.outfit, null);
        } else {
          if (c.upper?.hex) p.innerColor = hexToRgb(c.upper.hex);
          if (c.lower?.hex) p.lowerColor = hexToRgb(c.lower.hex);
          p.lowerType = c.lower_type === 'long_pants' ? 'jeans' : 'shorts';
        }
        if (c.face) p.updateFace(c.face);
        p.styleId = c.style_id || DEFAULT_STYLE_ID;
        p.heightClass = c.height_class || 'medium';
        p.heightProfile = c.height_profile || { id: 'medium', display_scale: 1, torso_scale_y: 1, leg_scale_y: 1 };
        if (Array.isArray(c.accessories)) p.accessories = c.accessories;
        else if (c.accessory && c.accessory !== 'none') p.accessories = [c.accessory];
        swarmPersons[c.id] = p;
      }
      const p = swarmPersons[c.id];
      p.styleId = c.style_id || p.styleId || DEFAULT_STYLE_ID;
      p.heightClass = c.height_class || p.heightClass || 'medium';
      p.heightProfile = c.height_profile || p.heightProfile;
      const newX = c.x / 1920 * width;
      const newY = c.y / 1080 * height;
      // Compute velocity from position delta for walking animation
      p.vel = { x: newX - (p.x || newX), y: newY - (p.y || newY) };
      p.x = newX;
      p.y = newY;
      p.swarmState = c.state || 'ROAMING';
    }
  });
}

function draw() {
  background('#0d1117');
  const modelSelector = document.getElementById('model-selector');
  if (modelSelector) {
    if (currentState === APP_STATES.LIVE) modelSelector.style.removeProperty('display');
    else modelSelector.style.display = 'none';
  }

  // Grid
  stroke('#161b22'); strokeWeight(1);
  for (let x = 0; x < width; x += 40) line(x, 0, x, height);
  for (let y = 0; y < height; y += 40) line(0, y, width, y);

  if (currentState === APP_STATES.LIVE) {
    drawLiveState();
  } else if (currentState === APP_STATES.PROCESSING) {
    drawProcessingState();
  } else if (currentState === APP_STATES.CUSTOMIZE) {
    drawCustomizeState();
  } else if (currentState === APP_STATES.SWARM) {
    drawSwarmState();
  }
}

function _getLiveLayout() {
  const margin = 20;
  const pad = 16;
  const btnW = 180;
  const btnH = 36;
  const desktop = width >= 1280;
  const compactColumns = !desktop && width >= 800;
  const modelPanelW = desktop ? 260 : 0; // model-selector column, reserved INSIDE the frame
  const rightSidebarW = desktop ? 300 : 0;
  const colorPreviewW = 130;

  // The frame's top boundary sits just below the LOAD TEST PHOTO button
  // (top-right) rather than a guessed fixed height, so it never overlaps it.
  // The frame spans the full width; the model-selector, camera, colour
  // preview and status panel are all columns laid out inside that one
  // boundary, so they read as one group instead of the selector floating
  // outside it.
  const loadBtnBottom = loadPhotoBtn?.getBoundingClientRect()?.bottom;
  const frameY = Math.ceil(loadBtnBottom || 60) + pad;
  const frameX = margin;
  const frameW = width - frameX - margin;
  const frameH = height - frameY - margin;

  const contentLeft = frameX + pad + (modelPanelW ? modelPanelW + pad : 0);
  const desktopStatusX = frameX + frameW - pad - rightSidebarW;
  const desktopColorX = desktopStatusX - pad - colorPreviewW;
  const desktopVideoRight = desktopColorX - pad;
  const compactColumnStatusW = 230;
  const frameInnerW = frameW - pad * 2;
  const availW = desktop
    ? Math.max(260, desktopVideoRight - contentLeft)
    : compactColumns
      ? Math.max(260, frameInnerW - colorPreviewW - compactColumnStatusW - pad * 2)
      : Math.max(260, frameInnerW);
  const availH = Math.max(220, frameH - pad * 3 - btnH);
  // Portrait: a standing figure needs height, not the landscape width the raw
  // 640×480 capture is shaped for. Fill the available height first so the
  // camera box grows tall instead of being capped by a fixed max width.
  const aspect = 4 / 3; // h/w
  let vidW = Math.min(availW, availH / aspect);
  let vidH = vidW * aspect;

  const compactGroupW = vidW + colorPreviewW + compactColumnStatusW + pad * 2;
  const imgX = compactColumns
    ? frameX + pad + Math.max(0, (frameInnerW - compactGroupW) / 2)
    : Math.max(contentLeft, contentLeft + (availW - vidW) / 2);
  const imgY = frameY + pad;
  const btnX = imgX + vidW / 2 - btnW / 2;
  const btnY = imgY + vidH + pad;
  const compactColorGap = 12;
  const compactStatusMaxW = vidW - 24 - colorPreviewW - compactColorGap;
  const compactSplit = !desktop && !compactColumns && compactStatusMaxW >= 230;
  const compactStatusW = Math.min(300, Math.max(230, compactStatusMaxW));
  const statusLayout = desktop
    ? {
      x: desktopStatusX,
      y: imgY,
      w: rightSidebarW - pad * 2,
      h: Math.max(220, availH),
    }
    : compactColumns
      ? {
        x: imgX + vidW + pad + colorPreviewW + pad,
        y: imgY,
        w: compactColumnStatusW,
        h: Math.max(220, availH),
      }
      : {
        x: compactSplit ? imgX + vidW - 12 - compactStatusW : imgX + 12,
        y: imgY + 12,
        w: compactSplit ? compactStatusW : Math.min(320, Math.max(230, vidW - 24)),
        h: Math.min(218, Math.max(178, vidH - 24)),
      };
  const colorPreviewLayout = {
    x: desktop ? desktopColorX : compactColumns ? imgX + vidW + pad : imgX + 12,
    y: statusLayout.y,
    w: colorPreviewW,
    h: 164,
    visible: desktop || compactColumns || compactSplit,
  };
  // Same column the model-selector's contentLeft offset reserves; keeping it
  // as its own panel (rather than folding it into contentLeft's math) means
  // its x/y/w/h can be hand-tuned the same way status/colour panels are.
  const modelSelectorLayout = {
    x: frameX + pad,
    y: frameY + pad,
    w: modelPanelW,
    h: availH,
    visible: desktop && modelPanelW > 0,
  };

  return {
    margin, pad, frameX, frameY, frameW, frameH, vidW, vidH, imgX, imgY,
    desktop, modelPanelW, rightSidebarW, statusLayout, colorPreviewLayout, modelSelectorLayout,
    btnW, btnH, btnX, btnY,
  };
}

function drawLiveState() {
  accessoryPanel.hide();
  downloadBtn.style.display = 'none';
  retryBtn.style.display = 'none';
  joinProjectionBtn.style.display = 'none';
  leaveSwarmBtn.style.display = 'none';

  // 測試用照片載入按鈕（右上角）
  loadPhotoBtn.style.display = 'block';
  loadPhotoBtn.style.right = '20px';
  loadPhotoBtn.style.left = 'auto';
  loadPhotoBtn.style.top = '20px';

  fill('#58a6ff'); noStroke();
  textSize(24); textStyle(BOLD); textAlign(LEFT, TOP);
  text("PERSONAFLOW: DIGITAL TWIN DASHBOARD", 20, 20);
  fill('#8b949e'); textSize(14); textStyle(NORMAL);
  text("STEP 1: POSITION YOURSELF, THEN PRESS ENTER TO CAPTURE", 20, 50);

  const {
    frameX, frameY, frameW, frameH, vidW, vidH, imgX, imgY,
    desktop, statusLayout, colorPreviewLayout, modelSelectorLayout, btnH, btnY,
  } = _getLiveLayout();

  fill('#161b22'); stroke('#30363d'); strokeWeight(2);
  rect(frameX, frameY, frameW, frameH, 12);

  // Model-selector is a DOM element (needs a real <select>), but it now sits
  // as a panel inside the same frame boundary as the camera/colour/status
  // panels, positioned and sized from the layout just like they are.
  const modelSelector = document.getElementById('model-selector');
  if (modelSelector) {
    if (modelSelectorLayout.visible) {
      modelSelector.style.left = modelSelectorLayout.x + 'px';
      modelSelector.style.top = modelSelectorLayout.y + 'px';
      modelSelector.style.width = modelSelectorLayout.w + 'px';
      modelSelector.style.height = modelSelectorLayout.h + 'px';
      modelSelector.classList.add('in-frame');
    } else {
      modelSelector.style.removeProperty('left');
      modelSelector.style.removeProperty('top');
      modelSelector.style.removeProperty('width');
      modelSelector.style.removeProperty('height');
      modelSelector.classList.remove('in-frame');
    }
  }

  // The raw capture is a 4:3 landscape frame (640×480); the display box is
  // portrait, so crop a centred vertical slice instead of stretching it.
  const srcW = 640, srcH = 480;
  const cropW = Math.min(srcW, srcH * (vidW / vidH));
  const cropX = (srcW - cropW) / 2;

  // Video feed or camera-off placeholder
  if (!cameraEnabled) {
    fill('#0d1117'); stroke('#30363d'); strokeWeight(2);
    rect(imgX, imgY, vidW, vidH, 8);
    fill('#484f58'); noStroke(); textSize(18); textStyle(NORMAL); textAlign(CENTER, CENTER);
    text('攝影機已關閉', imgX + vidW / 2, imgY + vidH / 2);
  } else if (capture && capture.loadedmetadata) {
    push();
    translate(imgX + vidW, imgY);
    scale(-1, 1);
    image(capture, 0, 0, vidW, vidH, cropX, 0, cropW, srcH);
    pop();

    noFill(); stroke('#30363d'); strokeWeight(2);
    rect(imgX, imgY, vidW, vidH, 8);

    // 定期送 frame 給後端做骨架偵測
    const now = millis();
    if (isDetecting && now - lastFrameSent > 150 && window.personaFlow?.socket) {
      const b64 = _captureBase64(0.5);
      if (b64) {
        lastFrameSent = now;
        window.personaFlow.socket.emit("process_frame", { image: b64, frame_id: ++frameSequence });
      }
    }

    // 骨架疊加
    if (latestFeatures?.landmarks) {
      _drawSkeleton(latestFeatures.landmarks, imgX, imgY, vidW, vidH, cropX / srcW, cropW / srcW);
    }
    _drawCaptureGuide(imgX, imgY, vidW, vidH, latestFeatures);

    // 倒數邏輯
    if (countdownValue > 0) {
      // Live pose results can flicker for one or two frames. Keep validating,
      // but only cancel after a short run of invalid frames so a single noisy
      // heel/toe estimate does not make capture feel impossible.
      if (!latestFeatures?.capture_ready_raw) {
        countdownInvalidFrames += 1;
        if (countdownInvalidFrames >= 4) {
          countdownValue = 0;
          countdownInvalidFrames = 0;
          isDetecting = true;
          return;
        }
      } else {
        countdownInvalidFrames = 0;
      }
      const elapsed = millis() - countdownStartTime;
      const remaining = Math.ceil(3 - elapsed / 1000);

      if (remaining > 0) {
        fill(255, 255, 255, 200); textSize(100);
        text(remaining.toString(), imgX + vidW / 2, imgY + vidH / 2);
      } else {
        countdownValue = 0;
        countdownInvalidFrames = 0;
        if (!_allCaptureIndicatorsPassed(latestFeatures)) {
          isDetecting = true;
          return;
        }
        const b64 = _captureBase64(0.8);
        if (b64 && window.personaFlow?.socket) {
          _requestAvatarGeneration(b64);
          currentState = APP_STATES.PROCESSING;
        }
      }
    }
  }

  _drawCaptureStatusPanel(
    latestFeatures,
    statusLayout.x, statusLayout.y, statusLayout.w, statusLayout.h,
  );

  // Keep the live colour cards between the camera and capture instructions.
  // Compact layouts place both overlays side by side without overlap.
  if (colorPreviewLayout.visible) {
    _drawColorPreview(latestFeatures, colorPreviewLayout.x, colorPreviewLayout.y);
  }

  // 按鈕群組
  const gap = 12;
  const captureW = 190;
  const camW = 130;
  const totalBtnW = captureW + gap + camW;
  const startX = imgX + vidW / 2 - totalBtnW / 2;
  const captureGateReady = cameraEnabled && _allCaptureIndicatorsPassed(latestFeatures);

  const btns = [
    {
      id: 'capture', label: countdownValue > 0 ? "📸 CAPTURING..." : (captureGateReady ? "↵ ENTER｜3s 拍攝" : "🔒 等待全亮"),
      x: startX, w: captureW,
      color: captureGateReady ? '#1f6feb' : '#21262d'
    },
    {
      id: 'cam', label: cameraEnabled ? '📷 關閉攝影機' : '📷 開啟攝影機',
      x: startX + captureW + gap, w: camW,
      color: cameraEnabled ? '#6e7681' : '#388bfd'
    },
  ];

  for (const b of btns) {
    fill(b.color);
    noStroke(); rect(b.x, btnY, b.w, btnH, 8);
    fill(255); textSize(14); textStyle(BOLD); textAlign(CENTER, CENTER);
    text(b.label, b.x + b.w / 2, btnY + btnH / 2);
  }
}

function drawProcessingState() {
  accessoryPanel.hide();
  downloadBtn.style.display = 'none';
  retryBtn.style.display = 'none';
  joinProjectionBtn.style.display = 'none';
  leaveSwarmBtn.style.display = 'none';
  loadPhotoBtn.style.display = 'none';
  generationProgress.displayPercent = lerp(
    generationProgress.displayPercent,
    Math.max(2, generationProgress.percent),
    0.08
  );

  const cardW = Math.min(900, width - 80);
  const cardH = 430;
  const cardX = width / 2 - cardW / 2;
  const cardY = height / 2 - cardH / 2;
  const pad = 42;
  const barX = cardX + pad;
  const barY = cardY + 190;
  const barW = cardW - pad * 2;
  const barH = 18;
  const percent = constrain(generationProgress.displayPercent, 0, 100);
  const elapsed = generationStartedAt ? Math.floor((millis() - generationStartedAt) / 1000) : 0;
  const modeNames = {
    full_character: '完整角色生成',
  };
  const milestones = [
    { p: 5, label: '接收照片' }, { p: 30, label: '分析特徵' },
    { p: 72, label: '角色生成' }, { p: 90, label: '規則驗證' },
    { p: 100, label: '完成' },
  ];

  fill('#161b22'); stroke('#30363d'); strokeWeight(2);
  rect(cardX, cardY, cardW, cardH, 18);

  fill('#58a6ff'); noStroke(); textAlign(LEFT, TOP);
  textSize(14); textStyle(BOLD);
  text(modeNames[activeGenerationMode] || activeGenerationMode, cardX + pad, cardY + 34);
  fill('#f0f6fc'); textSize(30);
  text('正在建立你的數位角色', cardX + pad, cardY + 66);
  fill('#8b949e'); textSize(15); textStyle(NORMAL);
  text(generationProgress.message, cardX + pad, cardY + 116);
  textAlign(RIGHT, TOP);
  text(`${Math.round(percent)}%  ·  ${elapsed} 秒`, cardX + cardW - pad, cardY + 116);

  noStroke(); fill('#30363d'); rect(barX, barY, barW, barH, 9);
  fill('#238636'); rect(barX, barY, barW * percent / 100, barH, 9);
  // A moving highlight communicates that a long image-model request is still active.
  const shimmerX = barX + ((millis() / 8) % Math.max(1, barW));
  fill(255, 255, 255, 45); rect(shimmerX, barY, Math.min(70, barX + barW - shimmerX), barH, 9);

  for (const milestone of milestones) {
    const x = barX + barW * milestone.p / 100;
    const done = generationProgress.percent >= milestone.p;
    fill(done ? '#2ea043' : '#30363d'); stroke(done ? '#56d364' : '#484f58'); strokeWeight(2);
    circle(x, barY + barH / 2, 18);
    noStroke(); fill(done ? '#f0f6fc' : '#8b949e'); textSize(12); textStyle(done ? BOLD : NORMAL);
    textAlign(CENTER, TOP); text(milestone.label, x, barY + 31);
  }

  const statusY = cardY + 300;
  fill('#0d1117'); stroke('#30363d'); strokeWeight(1);
  rect(cardX + pad, statusY, cardW - pad * 2, 78, 10);
  noStroke(); fill('#c9d1d9'); textAlign(LEFT, TOP); textSize(14); textStyle(BOLD);
  const stageLabel = generationProgress.stage === 'refining'
    ? '底圖已完成，正在精修臉部、髮型與上半身'
    : generationProgress.message;
  text(stageLabel, cardX + pad + 18, statusY + 16);
  fill('#8b949e'); textSize(12); textStyle(NORMAL);
  text('生成時間會依模型與服務流量變化；里程碑由後端實際流程回報。', cardX + pad + 18, statusY + 43);
}

function drawCustomizeState() {
  fill('#58a6ff'); noStroke();
  textSize(24); textStyle(BOLD); textAlign(LEFT, TOP);
  text("PERSONAFLOW: CUSTOMIZE AVATAR", 20, 20);
  fill('#8b949e'); textSize(14); textStyle(NORMAL);
  text("STEP 2: ADD ACCESSORIES AND DOWNLOAD", 20, 50);

  _drawResultHeightCard(myAvatarData, 20, 88);

  // Center avatar
  const person = characters[0];
  person.x = width / 2 - 100; // shift slightly left to make room for UI
  person.y = height / 2 + (height * 0.05);
  person.accessories = accessoryPanel.values();
  // Dynamic scale based on screen height to avoid overflowing
  const dynamicScale = Math.max(1.2, Math.min(2.2, height / 450));

  // Stage frame behind avatar — gives a light-vs-dark contrast halo so dark
  // LEGO outfits (e.g. black hair + dark shirt) read clearly against the
  // #0d1117 page background. Geometry comes from drawLegoCharacter at s=1.5:
  //   figure top    = headY - headS/2 ≈ -83.5
  //   figure bottom = legTop + legH + footH ≈ 97
  //   center offset ≈ +6.75, height ≈ 180.5, max width ≈ 130 (arms+hands)
  const stageH = 280 * dynamicScale;
  const stageW = 230 * dynamicScale;
  const stageY = person.y + 7 * dynamicScale;
  push();
  rectMode(CENTER);
  fill('#586069'); stroke('#8b949e'); strokeWeight(2);
  rect(person.x, stageY, stageW, stageH, 18);
  pop();

  person.drawSelf(dynamicScale);
  _maybeSaveRenderedAvatar(person);

  // Accessory panel position
  const uiX = width / 2 + 150;
  const uiY = height / 2 - 120;

  accessoryPanel.show();
  accessoryPanel.position(uiX, uiY);

  // Buttons — pushed down to make room for the multi-select panel (~120px)
  downloadBtn.style.display = 'block';
  downloadBtn.style.left = uiX + 'px';
  downloadBtn.style.top = (uiY + 130) + 'px';

  retryBtn.style.display = 'block';
  retryBtn.style.left = uiX + 'px';
  retryBtn.style.top = (uiY + 190) + 'px';

  const projectionAssetReady = !!myAvatarData?.body_png;
  joinProjectionBtn.style.display = myAvatarData?.height_measurement_valid && myAvatarData?.height_class && projectionAssetReady ? 'block' : 'none';
  joinProjectionBtn.style.left = uiX + 'px';
  joinProjectionBtn.style.top = (uiY + 250) + 'px';

  leaveSwarmBtn.style.display = 'none';
  loadPhotoBtn.style.display = 'none';

  // Label for accessory panel
  fill('#c9d1d9'); noStroke(); textSize(14); textAlign(LEFT, BOTTOM);
  text("ACCESSORIES 選多個：", uiX, uiY - 5);
}

function _drawResultHeightCard(data, x, y) {
  const heightClass = data?.height_class || 'unclassified';
  const profile = data?.height_profile || {};
  const valid = data?.height_measurement_valid === true;
  const labels = {
    short: { zh: '較矮', en: 'SHORT', color: '#79c0ff' },
    medium: { zh: '中等', en: 'MEDIUM', color: '#d2a8ff' },
    tall: { zh: '較高', en: 'TALL', color: '#ffa657' },
    unclassified: { zh: '未分類', en: 'UNCLASSIFIED', color: '#8b949e' },
  };
  const selected = labels[heightClass] || labels.unclassified;
  const cardW = Math.min(270, Math.max(205, width * 0.20));
  const ratio = data?.height_ratio == null ? null : Number(data.height_ratio);

  push();
  fill('#161b22ee'); stroke(selected.color); strokeWeight(1.5);
  rect(x, y, cardW, 116, 12);
  noStroke(); textAlign(LEFT, TOP);
  fill('#8b949e'); textSize(11); textStyle(BOLD);
  text('人物身高層級', x + 15, y + 13);
  fill(selected.color); textSize(22);
  text(`${selected.zh}　${selected.en}`, x + 15, y + 33);
  fill(valid ? '#7ee787' : '#d29922'); textSize(11); textStyle(NORMAL);
  text(valid ? '✓ 固定站位量測有效' : '⚠ 站位未校正，不套用身高層級', x + 15, y + 66);
  fill('#8b949e'); textSize(10);
  const ratioText = ratio != null && Number.isFinite(ratio) ? ratio.toFixed(3) : '—';
  const scaleText = profile.display_scale == null ? '—' : Number(profile.display_scale).toFixed(2);
  text(`height_ratio ${ratioText}　顯示倍率 ×${scaleText}`, x + 15, y + 91);
  pop();
}

function _trimTransparentCanvas(source, padding = 8) {
  const context = source.getContext('2d');
  const { width: sourceW, height: sourceH } = source;
  const pixels = context.getImageData(0, 0, sourceW, sourceH).data;
  let minX = sourceW, minY = sourceH, maxX = -1, maxY = -1;
  for (let y = 0; y < sourceH; y++) {
    for (let x = 0; x < sourceW; x++) {
      if (pixels[(y * sourceW + x) * 4 + 3] <= 4) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return source;
  minX = Math.max(0, minX - padding); minY = Math.max(0, minY - padding);
  maxX = Math.min(sourceW - 1, maxX + padding); maxY = Math.min(sourceH - 1, maxY + padding);
  const output = document.createElement('canvas');
  output.width = maxX - minX + 1; output.height = maxY - minY + 1;
  output.getContext('2d').drawImage(source, minX, minY, output.width, output.height, 0, 0, output.width, output.height);
  return output;
}

function _maybeSaveRenderedAvatar(person) {
  const pending = pendingRenderedSnapshot;
  if (!pending || savedRenderedRequestIds.has(pending.requestId)) return;
  if (pending.waitsForSprite && (!person.bodySprite || person.bodySprite.width <= 0)) return;
  // Give p5 one settled customize frame after an asynchronous sprite load.
  if (Date.now() - pending.queuedAt < 120) return;

  const snapshot = get();
  const previous = {
    x: person.x,
    y: person.y,
    vel: person.vel,
    accessories: person.accessories,
  };
  try {
    clear();
    person.x = width / 2;
    person.y = height / 2 - 12;
    person.vel = { x: 0, y: 0 };
    person.accessories = [];

    const exportW = Math.min(560, Math.max(280, width - 20));
    const exportH = Math.min(760, Math.max(380, height - 20));
    const exportScale = Math.min(3.1, exportH / 225);
    person.drawSelf(exportScale);

    const cropX = Math.max(0, Math.floor(person.x - exportW / 2));
    const cropY = Math.max(0, Math.floor(person.y - exportH / 2));
    const cropped = get(
      cropX,
      cropY,
      Math.min(exportW, width - cropX),
      Math.min(exportH, height - cropY),
    );
    const trimmedCanvas = _trimTransparentCanvas(cropped.canvas);
    const bodyPng = trimmedCanvas.toDataURL('image/png').split(',', 2)[1];
    if (myAvatarData && myAvatarData.request_id === pending.requestId) {
      myAvatarData.projection_png = bodyPng;
    }
    window.personaFlow?.socket?.emit('save_rendered_avatar', {
      request_id: pending.requestId,
      body_png: bodyPng,
    });
    savedRenderedRequestIds.add(pending.requestId);
    pendingRenderedSnapshot = null;
  } catch (error) {
    console.warn('final avatar snapshot failed', error);
  } finally {
    person.x = previous.x;
    person.y = previous.y;
    person.vel = previous.vel;
    person.accessories = previous.accessories;
    clear();
    imageMode(CORNER);
    image(snapshot, 0, 0, width, height);
  }
}

function mousePressed() {
  if (currentState === APP_STATES.LIVE && countdownValue === 0) {
    const { imgX, vidW, btnY, btnH } = _getLiveLayout();
    const gap = 12;
    const captureW = 190;
    const camW = 130;
    const totalBtnW = captureW + gap + camW;
    const startX = imgX + vidW / 2 - totalBtnW / 2;

    if (mouseY >= btnY && mouseY <= btnY + btnH) {
      const camX = startX + captureW + gap;
      if (mouseX >= camX && mouseX <= camX + camW) {
        _toggleCamera();
      } else if (mouseX >= startX && mouseX <= startX + captureW) {
        _startCaptureCountdown();
      }
    }
  }
}

function keyPressed() {
  if (keyCode !== ENTER || currentState !== APP_STATES.LIVE) return true;
  if (countdownValue === 0) _startCaptureCountdown();
  return false;
}

function _startCaptureCountdown() {
  if (currentState !== APP_STATES.LIVE || countdownValue > 0 || !cameraEnabled) return false;
  if (!_allCaptureIndicatorsPassed(latestFeatures)) return false;

  countdownValue = 3;
  countdownStartTime = millis();
  countdownInvalidFrames = 0;
  isDetecting = true;
  return true;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function _captureBase64(quality) {
  if (!capture || !capture.elt) return null;
  const tmp = document.createElement('canvas');
  tmp.width = 640; tmp.height = 480;
  tmp.getContext('2d').drawImage(capture.elt, 0, 0, 640, 480);
  return tmp.toDataURL('image/jpeg', quality);
}

function _newRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function _requestAvatarGeneration(image, sourceType = 'camera') {
  if (!window.personaFlow?.socket || !image) return;
  activeAvatarRequestId = _newRequestId();
  activeGenerationMode = 'full_character';
  const selectedModel = _getSelectedModel();
  generationStartedAt = millis();
  generationProgress = {
    stage: 'queued', percent: 2, displayPercent: 0,
    message: '照片已送出，等待後端接收',
  };
  window.personaFlow.socket.emit('generate_avatar', {
    image,
    mode: activeGenerationMode,
    request_id: activeAvatarRequestId,
    source_type: sourceType,
    ...(selectedModel ? { model: selectedModel } : {}),
  });
}

function _heightStationPassed(features) {
  const checks = features?.capture_quality?.capture_checks || {};
  const stationOffset = Number(features?.foot_baseline_offset);
  const stationTolerance = Number(features?.height_station_tolerance ?? 0.10);
  return !!(
    features?.height_station_valid
    || checks.height_station
    || checks.height
    || (Number.isFinite(stationOffset) && stationOffset <= stationTolerance)
  );
}

function _allCaptureIndicatorsPassed(features) {
  const checks = features?.capture_quality?.capture_checks || {};
  const rawReady = !!features?.capture_ready_raw;
  const poseOk = checks.pose ?? rawReady;
  const feetOk = checks.feet ?? rawReady;
  const framingOk = checks.framing ?? rawReady;
  const stationOk = _heightStationPassed(features);
  const heightOk = !!features?.height_measurement_ready;
  const stableOk = (features?.stability_count || 0) >= (features?.stability_required || 3);
  return !!features?.capture_ready && poseOk && feetOk && framingOk && stationOk && heightOk && stableOk;
}

function _captureGuidanceText(features) {
  const reason = features?.guidance_reason || 'person_not_detected';
  const quality = features?.capture_quality || {};

  if (reason === 'ready') return '✓ 全身已入鏡，按 Enter 開始 3 秒拍攝';
  if (reason === 'hold_still') {
    if (_heightStationPassed(features) && !features?.height_measurement_ready) {
      return `腳底位置正確，正在確認身高 (${features?.height_sample_count || 0}/${features?.height_samples_required || 3})`;
    }
    return `全身已入鏡，請保持不動 (${features?.stability_count || 0}/${features?.stability_required || 3})`;
  }
  if (reason === 'move_closer') return '人物佔畫面太小，請向前一步';
  if (reason === 'align_height_baseline') {
    const offset = Number(features?.foot_baseline_offset ?? quality?.foot_baseline_offset);
    const detail = Number.isFinite(offset) ? `（目前相差 ${(offset * 100).toFixed(1)}%）` : '';
    return `請站在地面腳印，讓雙腳貼近畫面底部基準線${detail}`;
  }

  if (reason === 'show_feet') {
    const sides = quality.missing_foot_sides || [];
    if (sides.length === 1) return sides[0] === 'left' ? '左腳尚未辨識，請露出完整左腳' : '右腳尚未辨識，請露出完整右腳';
    return '左右腳尚未完整辨識，請露出雙腳';
  }

  if (reason === 'body_clipped') {
    const edges = quality.clipped_edges || [];
    if (edges.includes('bottom')) return '腳太靠近畫面底部，請稍微後退';
    if (edges.includes('top')) return '頭頂被裁切，請稍微後退';
    if (edges.includes('left')) return '身體碰到畫面右側，請往左移';
    if (edges.includes('right')) return '身體碰到畫面左側，請往右移';
    return '身體碰到畫面邊緣，請稍微後退';
  }

  if (reason === 'align_with_guide') {
    const issues = quality.alignment_issues || [];
    if (issues.includes('move_screen_left')) return '身體偏右，請往畫面左側移動';
    if (issues.includes('move_screen_right')) return '身體偏左，請往畫面右側移動';
    if (issues.includes('feet_too_high')) return '雙腳位置太高，請向前一步對齊人形腳部';
    if (issues.includes('feet_too_low')) return '雙腳太靠近底部，請稍微後退';
    if (issues.includes('shoulders_too_high')) return '肩膀位置太高，請稍微後退';
    if (issues.includes('shoulders_too_low')) return '請讓肩膀對齊人形肩線';
    if (issues.includes('face_camera')) return '請面向鏡頭並自然站直';
    return '請讓肩膀、髖部與雙腳對齊人形';
  }

  if (reason === 'pose_incomplete') {
    const labels = {
      left_shoulder: '左肩', right_shoulder: '右肩',
      left_hip: '左髖', right_hip: '右髖',
      left_knee: '左膝', right_knee: '右膝',
    };
    const joints = (quality.low_visibility_joints || []).map(item => labels[item] || item);
    return joints.length ? `${joints.join('、')}辨識不穩，請面向鏡頭` : '肢體偵測不完整，請面向鏡頭';
  }

  if (reason === 'move_inside_guide') return '請將身體移到人形中央';
  if (reason === 'show_full_body') return '請保持全身與雙腳入鏡';
  return '尚未偵測到人物';
}

function _drawCaptureGuide(ix, iy, vw, vh, features) {
  const ready = !!features?.capture_ready_raw;
  const cx = ix + vw * 0.50;

  push();

  // Head and foot references only. They suggest a comfortable fixed-station
  // position but are not used as a pose template or body-proportion constraint.
  drawingContext.setLineDash([9, 7]);
  if (ready) stroke(46, 160, 67, 105);
  else stroke(88, 166, 255, 88);
  strokeWeight(3);
  fill(88, 166, 255, ready ? 10 : 6);

  // Head reference.
  ellipse(cx, iy + vh * 0.095, vh * 0.12, vh * 0.15);

  // Foot pads sit directly above the usable image bottom. Keeping the physical
  // floor spot fixed is what makes relative height measurement meaningful.
  noFill();
  const footY = iy + vh * 0.955;
  ellipse(cx - vw * 0.055, footY, vw * 0.075, vh * 0.025);
  ellipse(cx + vw * 0.055, footY, vw * 0.075, vh * 0.025);
  line(cx - vw * 0.13, iy + vh * 0.975, cx + vw * 0.13, iy + vh * 0.975);
  drawingContext.setLineDash([]);

  pop();
}

function _drawCaptureStatusPanel(features, x, y, panelW, panelH = 282) {
  const checks = features?.capture_quality?.capture_checks || {};
  const rawReady = !!features?.capture_ready_raw;
  const mark = value => value ? '✓' : '○';
  const poseOk = checks.pose ?? rawReady;
  const feetOk = checks.feet ?? rawReady;
  const framingOk = checks.framing ?? rawReady;
  const heightOffset = Number(features?.foot_baseline_offset ?? features?.capture_quality?.foot_baseline_offset);
  const heightStationOk = _heightStationPassed(features);
  const heightMeasurementOk = !!features?.height_measurement_ready;
  const heightRowLabel = heightStationOk
    ? '身高站位有效'
    : (Number.isFinite(heightOffset) ? `身高站位（差 ${(heightOffset * 100).toFixed(1)}%）` : '身高站位待確認');
  const stableNow = (features?.stability_count || 0) >= (features?.stability_required || 3);

  push();
  fill('#161b22ee'); stroke(rawReady ? '#2ea043' : '#30363d'); strokeWeight(1.5);
  rect(x, y, panelW, panelH, 12);
  noStroke(); textAlign(LEFT, TOP);
  fill('#f0f6fc'); textSize(15); textStyle(BOLD);
  text('即時拍攝指示', x + 16, y + 14);
  fill(rawReady ? '#7ee787' : '#f0b45d'); textSize(12);
  text(_captureGuidanceText(features), x + 16, y + 42, panelW - 32, 38);

  const compact = panelH < 250;
  const rows = [
    ['姿勢偵測', poseOk],
    ['左右腳入鏡', feetOk],
    ['全身未被裁切', framingOk],
    [heightRowLabel, heightStationOk],
    [`身高量測 ${features?.height_sample_count || 0}/${features?.height_samples_required || 3}`, heightMeasurementOk],
    [`保持穩定 ${features?.stability_count || 0}/${features?.stability_required || 3}`, stableNow],
  ];
  textSize(compact ? 10 : 12); textStyle(NORMAL);
  rows.forEach((row, index) => {
    const rowY = y + (compact ? 76 : 88) + index * (compact ? 18 : 26);
    fill(row[1] ? '#3fb950' : '#6e7681');
    circle(x + 21, rowY + 6, compact ? 8 : 10);
    fill(row[1] ? '#c9d1d9' : '#8b949e');
    text(`${mark(row[1])} ${row[0]}`, x + 34, rowY);
  });

  const heightValid = !!features?.height_measurement_ready;
  const heightLabels = { short: '較矮', medium: '中等', tall: '較高' };
  fill('#8b949e'); textSize(10);
  const ratio = Number(features?.height_ratio);
  const ratioLabel = Number.isFinite(ratio) ? ratio.toFixed(3) : '—';
  const heightText = heightValid
    ? `身高分級：${heightLabels[features?.height_class] || '中等'}　比例 ${ratioLabel}`
    : `身高分級：站定位並完成 ${features?.height_samples_required || 3} 幀量測後才採用`;
  text(heightText, x + 16, y + panelH - 23);
  pop();
}

function _toggleCamera() {
  if (cameraEnabled) {
    const stream = capture?.elt?.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (capture) capture.remove();
    capture = null;
    cameraEnabled = false;
    isDetecting = false;
    countdownValue = 0;
    countdownInvalidFrames = 0;
    latestFeatures = null;
  } else {
    try {
      capture = createCapture({ video: true, audio: false }, () => {
        if (!capture) return;
        capture.loadedmetadata = true;
        cameraEnabled = true;
        isDetecting = true;
      });
      capture.size(640, 480);
      capture.hide();
      if (capture.elt) {
        capture.elt.playsInline = true;
        capture.elt.addEventListener('loadedmetadata', () => {
          if (!capture) return;
          capture.loadedmetadata = true;
          cameraEnabled = true;
          isDetecting = true;
        }, { once: true });
      }
    } catch (err) {
      capture = null;
      cameraEnabled = false;
      isDetecting = false;
      console.error('[camera] open failed:', err);
    }
  }
}

function _getSelectedModel() {
  return document.getElementById('modelSelect')?.value || '';
}

function _drawSkeleton(landmarks, ix, iy, vw, vh, cropLeftNorm = 0, cropWidthNorm = 1) {
  const CONNS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28]
  ];
  // Landmarks are normalized against the full uncropped capture; remap into
  // the displayed (cropped) box before mirroring, or points drift outward.
  const lx = lm => ix + (1 - (lm.x - cropLeftNorm) / cropWidthNorm) * vw;
  const ly = lm => iy + lm.y * vh;
  const vis = lm => (lm.v === undefined || lm.v > 0.4);

  push();
  stroke('#00FF88'); strokeWeight(2); noFill();
  for (const [a, b] of CONNS) {
    if (landmarks[a] && landmarks[b] && vis(landmarks[a]) && vis(landmarks[b])) {
      line(lx(landmarks[a]), ly(landmarks[a]), lx(landmarks[b]), ly(landmarks[b]));
    }
  }
  fill('#00FF88'); noStroke();
  for (const lm of landmarks) {
    if (vis(lm)) circle(lx(lm), ly(lm), 6);
  }
  pop();
}

function _drawColorPreview(feat, px, py) {
  push();
  textAlign(LEFT, TOP); noStroke();

  fill('#8b949e'); textSize(11); textStyle(NORMAL);
  text("即時色調", px, py);

  const labels = ["上半身", "下半身"];
  const cols = [feat?.upper, feat?.lower];

  for (let i = 0; i < 2; i++) {
    const c = cols[i];
    const y = py + 20 + i * 72;

    fill('#161b22'); stroke('#30363d'); strokeWeight(1);
    rect(px, y, 130, 62, 6);

    if (c) {
      fill(c.rgb[0], c.rgb[1], c.rgb[2]); noStroke();
      rect(px + 5, y + 5, 52, 52, 4);
      fill('#c9d1d9'); textSize(11); textStyle(BOLD);
      text(labels[i], px + 64, y + 8);
      fill('#8b949e'); textSize(10); textStyle(NORMAL);
      text(c.hex, px + 64, y + 24);
    } else {
      fill('#484f58'); textSize(10);
      text(labels[i] + "\n偵測中...", px + 8, y + 16);
    }
  }

  if (feat && !feat.ok && feat.error === 'no_person_detected') {
    fill('#f85149'); textSize(10);
    text("請站在鏡頭前", px, py + 174);
  }
  pop();
}

// ─────────────────────────────────────────
//  SWARM PROJECTION WALL
// ─────────────────────────────────────────

function drawSwarmState() {
  accessoryPanel.hide();
  downloadBtn.style.display = 'none';
  retryBtn.style.display = 'none';
  joinProjectionBtn.style.display = 'none';
  loadPhotoBtn.style.display = 'none';
  leaveSwarmBtn.style.display = 'block';
  leaveSwarmBtn.style.left = '20px';
  leaveSwarmBtn.style.top = (height - 60) + 'px';

  background('#0d1117');
  stroke('#161b22'); strokeWeight(1);
  for (let x = 0; x < width; x += 40) line(x, 0, x, height);
  for (let y = 0; y < height; y += 40) line(0, y, width, y);

  fill('#58a6ff'); noStroke();
  textSize(20); textStyle(BOLD); textAlign(LEFT, TOP);
  text("PERSONAFLOW: PROJECTION WALL", 20, 20);
  const n = Object.keys(swarmPersons).length;
  fill('#8b949e'); textSize(13); textStyle(NORMAL);
  text(n + ' character' + (n !== 1 ? 's' : '') + ' on the wall', 20, 46);

  // Sort by Y for correct depth layering (characters lower on screen = in front)
  const sorted = Object.values(swarmPersons).sort((a, b) => a.y - b.y);
  for (const p of sorted) {
    // Perspective scale: characters near bottom of screen appear larger
    const tDepth = Math.max(0, Math.min(1, (p.y / height - 0.1) / 0.8));
    const perspScale = lerp(0.45, 0.95, tDepth);
    p.drawSelf(perspScale);
    if (p.swarmState === 'GREETING') {
      _drawGreetingBubble(p.x, p.y);
    }
  }
}

function _drawGreetingBubble(x, y) {
  push();
  translate(x, y - 110);
  fill(255, 255, 255, 210);
  stroke('#58a6ff'); strokeWeight(2);
  ellipse(0, 0, 60, 28);
  noStroke(); fill(255, 255, 255, 210);
  triangle(-6, 13, 6, 13, 0, 23);
  fill(30, 30, 30);
  textSize(12); textStyle(BOLD); textAlign(CENTER, CENTER); noStroke();
  text("Hi! 👋", 0, 1);
  pop();
}

function _joinSwarm() {
  if (!window.personaFlow?.socket) return;
  if (!myAvatarData?.height_measurement_valid || !myAvatarData?.height_class || !myAvatarData?.height_profile) {
    alert('這個角色沒有有效的固定站位身高資料，無法匯入投影牆。請重新站到地面腳印並拍照。');
    return;
  }
  const p = characters[0];

  // _enhanceSolid is from lego.js (loaded before sketch.js): camera correction + saturation boost.
  // Apply it here so projection.html receives already-enhanced colors instead of raw CV hex.
  const _enh = (src) => {
    const [r, g, b] = _enhanceSolid(src);
    const clamp = v => Math.min(255, Math.max(0, Math.round(v)));
    const hex = '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
    return { r: clamp(r), g: clamp(g), b: clamp(b), hex };
  };

  // Mirror lego.js armSource: armColor > outerColor > innerColor
  const armSrc = p.armColor
    || (p.outerType && p.outerType !== 'none' && p.outerColor ? p.outerColor : null)
    || p.innerColor;

  const eInner = _enh(p.innerColor);
  const eLower = _enh(p.lowerColor);
  const eArm = _enh(armSrc);

  // Build enhanced outfit so projection.html doesn't see the raw CV hex
  let enhancedOutfit = myAvatarData?.outfit ? { ...myAvatarData.outfit } : null;
  if (enhancedOutfit) {
    enhancedOutfit.inner_color = eInner.hex;
    enhancedOutfit.lower_color = eLower.hex;
    if (enhancedOutfit.outer_color) {
      enhancedOutfit.outer_color = _enh(hexToRgb(enhancedOutfit.outer_color)).hex;
    }
  }

  const characterId = activeAvatarRequestId || undefined;
  const payload = {
    id: characterId,
    x: 960, y: 540,
    upper: { hex: eInner.hex, rgb: [eInner.r, eInner.g, eInner.b] },
    lower: { hex: eLower.hex, rgb: [eLower.r, eLower.g, eLower.b] },
    arm: { hex: eArm.hex, rgb: [eArm.r, eArm.g, eArm.b] },
    upper_type: 'short_sleeve',
    lower_type: (p.lowerType === 'jeans' || p.lowerType === 'suit_pants' || p.lowerType === 'long_pants')
      ? 'long_pants' : 'shorts',
    accessories: p.accessories,
    accessory: p.accessories[0] || 'none',
    face: myAvatarData?.face || null,
    outfit: enhancedOutfit,
    body_png: myAvatarData?.projection_png || myAvatarData?.body_png || null,
    body_bbox: myAvatarData?.body_bbox || null,
    character_mode: 'full_character',
    height_class: myAvatarData.height_class,
    height_profile: myAvatarData.height_profile,
    height_measurement_valid: true,
    style_id: p.styleId || myAvatarData?.style_id || DEFAULT_STYLE_ID,
  };

  // ✅ FIX 1: Stay on CUSTOMIZE — don't switch currentState to SWARM.
  // The old page remains unchanged; projection.html is the virtual scene.

  // ✅ FIX 2: Emit join_swarm FIRST, then open the new tab after a short delay.
  // This ensures the character is registered in the backend swarm state before
  // projection.html's socket connects and starts receiving update_positions.
  window.personaFlow._lastJoinPayload = payload; // saved so socket.js can re-join on reconnect
  window.personaFlow.socket.emit("join_swarm", payload);

  // BroadcastChannel: projection.html listens and applies colors immediately.
  try {
    const bc = new BroadcastChannel('avatar_sync');
    bc.postMessage({
      boidId: window.personaFlow.myCharId || 'user_0',
      topColor: eInner.hex,
      bottomColor: eLower.hex,
      armColor: eArm.hex,
      hasGlasses: p.accessories.includes('glasses'),
    });
    bc.close();
  } catch (_) { /* BroadcastChannel not supported */ }

  // Open projection wall in a new tab after 300 ms so join_swarm reaches the
  // backend before projection.html's socket connects.
  const focusQuery = characterId ? `&focus=${encodeURIComponent(characterId)}` : '';
  setTimeout(() => window.open(`projection.html?v=20260822-full-character${focusQuery}`, '_blank'), 300);
}
