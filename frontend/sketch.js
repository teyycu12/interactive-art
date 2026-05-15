const APP_STATES = {
  LIVE: 0,
  PROCESSING: 1,
  CUSTOMIZE: 2,
  SWARM: 3,
};

// Character theme: 'anime' | 'lego'
// Add more themes by creating frontend/themes/<name>.js and a case below.
let ACTIVE_THEME = 'lego';

let currentState = APP_STATES.LIVE;
const characters = [];
let capture;

// State transition variables
let countdownValue = 0;
let countdownStartTime = 0;
let isDetecting = false;
let lastFrameSent = 0;
let latestFeatures = null;

// UI Elements
let accessorySelect;
let downloadBtn;
let retryBtn;
let joinProjectionBtn;
let leaveSwarmBtn;
let loadPhotoBtn;
let photoFileInput;

// Swarm state
const swarmPersons = {};
let myAvatarData = null;

function hexToRgb(hex) {
  if (typeof hex !== "string") return { r: 255, g: 255, b: 255 };
  const normalized = hex.trim().replace("#", "");
  if (normalized.length !== 6) return { r: 255, g: 255, b: 255 };
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) {
    return { r: 255, g: 255, b: 255 };
  }
  return { r, g, b };
}

class Person {
  constructor(x, y) {
    this.x = x;
    this.y = y;

    // Clothing
    this.innerColor = { r: 200, g: 200, b: 200 };
    this.outerColor = null;
    this.lowerColor = { r: 100, g: 100, b: 100 };
    this.innerType  = 'tshirt';
    this.outerType  = 'none';
    this.lowerType  = 'shorts';
    this.upperKind  = 'short_sleeve';   // 'short_sleeve' | 'long_sleeve' — drives bare-arm rendering
    this.stencilImg = null;
    this.accessory  = 'none';
    this.alpha      = 255;
    // Colour-grid (from cv_module contour sampling)
    this.clothGrid  = null;   // { cols, rows, cells:[{r,g,b,active}] }
    this.lowerGrid  = null;
    // OpenAI-generated garment sprites (preferred over grid when loaded)
    this.clothSprite = null;  // p5.Image (legacy: upper-only)
    this.lowerSprite = null;  // p5.Image (legacy: lower-only)
    this.bodySprite  = null;  // p5.Image (NEW: full LEGO body, neck down)

    // Face / hair (defaults — overwritten by updateFace)
    this.skinColor    = { r: 255, g: 224, b: 196 };
    this.hairColor    = { r: 45,  g: 35,  b: 30  };
    this.eyeColor     = { r: 55,  g: 35,  b: 20  }; // dark brown default
    this.lipColor     = { r: 220, g: 110, b: 110 };
    this.hairStyle    = 'short_straight';
    this.faceShape    = 'oval';
    this.eyeShape     = 'almond';
    this.eyebrowStyle = 'normal';
    this.smileScore   = 0.0;
    this.hasBeard     = false;
    this.beardStyle   = 'none';

    // Render mode — chosen at avatar-generation time. 'body_sprite' = upper+lower
    // garment sprites + programmatic LEGO head/hands/feet. 'full_character' = single
    // AI image covers the entire figure; programmatic parts skipped.
    this.renderMode   = 'body_sprite';

    // Forward-compat slots for future skeletal rigging (out of scope here, but
    // populated by a downstream pipeline so themes/animation can read them).
    this.skeleton     = null;   // { joints: [...], bones: [...] }
    this.animState    = 'idle'; // 'idle' | 'walking' | 'greeting' | ...
  }

  setRenderMode(mode) {
    if (mode === 'body_sprite' || mode === 'full_character') this.renderMode = mode;
  }

  updateFromVLM(outfit, stencilB64, face, clothGrid, lowerGrid) {
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
    // Update grids if provided
    if (clothGrid && clothGrid.cells && clothGrid.cells.length > 0) this.clothGrid = clothGrid;
    if (lowerGrid && lowerGrid.cells && lowerGrid.cells.length > 0) this.lowerGrid = lowerGrid;
    this.updateFace(face);
  }

  // Load OpenAI-generated full-body LEGO sprite (base64 PNG, no data: prefix)
  updateBodySprite(bodyPng) {
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
    if (face.hair_color)    this.hairColor    = hexToRgb(face.hair_color);
    if (face.eye_color)     this.eyeColor     = hexToRgb(face.eye_color);
    if (face.lip_color)     this.lipColor     = hexToRgb(face.lip_color);
    if (face.hair_style)    this.hairStyle    = face.hair_style;
    if (face.face_shape)    this.faceShape    = face.face_shape;
    if (face.eye_shape)     this.eyeShape     = face.eye_shape;
    if (face.eyebrow_style) this.eyebrowStyle = face.eyebrow_style;
    if (face.smile_score  !== undefined) this.smileScore = face.smile_score;
    if (face.has_beard    !== undefined) this.hasBeard   = face.has_beard;
    if (face.beard_style)   this.beardStyle   = face.beard_style;
  }

  drawSelf(scaleFactor = 1.2) {
    push();
    translate(this.x, this.y);
    scale(scaleFactor);

    if (ACTIVE_THEME === 'lego') {
      drawLegoCharacter(this);
      pop();
      return;
    }

    // Build p5 color objects from instance state
    const sc  = color(this.skinColor.r,  this.skinColor.g,  this.skinColor.b);
    const hc  = color(this.hairColor.r,  this.hairColor.g,  this.hairColor.b);
    const ec  = this.eyeColor;   // kept as {r,g,b} for _drawEyes
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
    rect(  6, 20, 12, 60, 6);
    stroke('#5a3a29'); strokeWeight(2);

    // 3. Lower body
    fill(lColor);
    if (this.lowerType === 'jeans' || this.lowerType === 'suit_pants' || this.lowerType === 'long_pants') {
      rect(-20, 20, 16, 55, 2, 2, 5, 5);
      rect(  4, 20, 16, 55, 2, 2, 5, 5);
      // Grid overlay: two leg rectangles
      if (this.lowerGrid) {
        _drawClothGrid(drawingContext, [[-20,20],[-4,20],[-4,75],[-20,75]], this.lowerGrid, true);
        _drawClothGrid(drawingContext, [[4,20],[20,20],[20,75],[4,75]],    this.lowerGrid, false);
      }
    } else if (this.lowerType === 'shorts') {
      rect(-20, 20, 16, 20, 2);
      rect(  4, 20, 16, 20, 2);
      if (this.lowerGrid) {
        _drawClothGrid(drawingContext, [[-20,20],[-4,20],[-4,40],[-20,40]], this.lowerGrid, true);
        _drawClothGrid(drawingContext, [[4,20],[20,20],[20,40],[4,40]],    this.lowerGrid, false);
      }
    } else if (this.lowerType === 'pleated_skirt' || this.lowerType === 'skirt') {
      quad(-25, 15, 25, 15, 40, 40, -40, 40);
      if (this.lowerGrid) {
        _drawClothGrid(drawingContext, [[-25,15],[25,15],[40,40],[-40,40]], this.lowerGrid);
      }
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

    // 4b. Colour-grid overlay on shirt (masks to shirt polygon)
    if (this.clothGrid) {
      _drawClothGrid(
        drawingContext,
        [[-20,-40],[20,-40],[25,20],[-25,20]],
        this.clothGrid
      );
    }

    // 5. Stencil overlay on shirt (only when no grid)
    if (!this.clothGrid && this.stencilImg && this.stencilImg.width > 0) {
      push();
      imageMode(CENTER);
      drawingContext.save();
      drawingContext.beginPath();
      drawingContext.moveTo(-20, -40); drawingContext.lineTo(20, -40);
      drawingContext.lineTo(25, 20);  drawingContext.lineTo(-25, 20);
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
        beginShape(); vertex(-22,-42); vertex(0,-15); vertex(-5,22); vertex(-27,22); endShape(CLOSE);
        beginShape(); vertex( 22,-42); vertex(0,-15); vertex( 5,22); vertex( 27,22); endShape(CLOSE);
        if (this.outerType === 'blazer') {
          fill(this.outerColor.r*0.9, this.outerColor.g*0.9, this.outerColor.b*0.9);
          triangle(-20,-40, 0,-15, -12,-25);
          triangle( 20,-40, 0,-15,  12,-25);
        }
      } else if (this.outerType === 'denim_jacket') {
        rect(-27,-42, 22, 60, 4); rect(5,-42, 22, 60, 4);
        stroke(200,150,50,100); strokeWeight(2);
        line(-16,-42,-16,18); line(16,-42,16,18);
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
    _arm(-20,  PI/6);
    _arm( 20, -PI/6);

    // 8. Head & neck
    fill(sc);
    rect(-8, -45, 16, 18); // neck (taller to fill gap)

    // Ears — at face edge, same style as reference arc(85,225,...) / arc(315,225,...)
    stroke('#5a3a29'); strokeWeight(2);
    arc(-50, -62, 22, 28, HALF_PI, PI + HALF_PI);
    arc( 50, -62, 22, 28, -HALF_PI, HALF_PI);

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
    ellipse( 36, -47, 28, 12);
    
    // 10. Eyes (shape + color aware, from character.js)
    _drawEyes(this.eyeShape, ec);

    // 11. Eyebrows
    _drawEyebrows(this.eyebrowStyle);

    // 12. Mouth (smile-score driven)
    noFill(); stroke('#5a3a29'); strokeWeight(2);
    const smileW = 7  + this.smileScore * 10;
    const smileH = 4  + this.smileScore * 8;
    arc(0, -40, smileW, smileH, 0, PI);

    // 13. Lip tint
    noStroke(); fill(this.lipColor.r, this.lipColor.g, this.lipColor.b, 70);
    ellipse(0, -39, smileW * 0.9, 4);

    // 14. Beard / facial hair
    if (this.hasBeard) _drawBeard(this.beardStyle, this.skinColor, this.hairColor);

    // 15. Front hair (on top of face)
    stroke('#5a3a29'); strokeWeight(2);
    _hairFront(this.hairStyle, hc);

    // 16. Accessory
    if (typeof drawAccessory === 'function') drawAccessory(this.accessory, 1);

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

function createSelectDOM() {
  const sel = document.createElement('select');
  sel.style.position = 'absolute';
  sel.style.padding = '10px';
  sel.style.background = '#21262d';
  sel.style.color = '#c9d1d9';
  sel.style.border = '1px solid #30363d';
  sel.style.borderRadius = '6px';
  sel.style.outline = 'none';
  sel.style.cursor = 'pointer';
  sel.style.fontSize = '16px';
  sel.style.fontWeight = 'bold';
  sel.style.display = 'none';
  document.body.appendChild(sel);
  
  return {
    sel: sel,
    addOption: (label, val) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.text = label;
      sel.appendChild(opt);
    },
    position: (x, y) => {
      sel.style.left = x + 'px';
      sel.style.top = y + 'px';
    },
    value: () => sel.value,
    show: () => sel.style.display = 'block',
    hide: () => sel.style.display = 'none'
  };
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  capture = createCapture(VIDEO);
  capture.size(640, 480);
  capture.hide();

  characters.push(new Person(0, 0));

  accessorySelect = createSelectDOM();
  if (typeof ACCESSORIES_LIST !== 'undefined') {
    for (const acc of ACCESSORIES_LIST) accessorySelect.addOption(acc.label, acc.value);
  }
  
  downloadBtn = createBtn('💾 DOWNLOAD AVATAR', '#2ea043', () => {
    saveCanvas('PersonaFlow_Avatar', 'png');
  });
  
  retryBtn = createBtn('🔄 RETRY', '#da3633', () => {
    currentState = APP_STATES.LIVE;
    isDetecting = false;
    countdownValue = 0;
    accessorySelect.hide();
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
        window.personaFlow.socket.emit("generate_avatar", { image: dataUrl, mode: _getSelectedMode() });
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
    currentState = APP_STATES.CUSTOMIZE;
  });

  window.addEventListener("clothing_features", (e) => {
    latestFeatures = e.detail;
    // Live-update grids on the main character so preview reflects latest scan
    if (latestFeatures?.cloth_grid) {
      characters[0].clothGrid = latestFeatures.cloth_grid;
    }
    if (latestFeatures?.lower_grid) {
      characters[0].lowerGrid = latestFeatures.lower_grid;
    }
  });

  window.addEventListener("avatar_generated", (e) => {
    const payload = e.detail;
    if (payload.ok) {
      myAvatarData = payload;
      // Set render mode FIRST so subsequent sprite/face updates can read it if needed
      if (payload.character_mode) characters[0].setRenderMode(payload.character_mode);
      characters[0].updateFromVLM(
        payload.outfit,
        payload.stencil,
        null,
        payload.cloth_grid || null,
        payload.lower_grid || null
      );
      // body_sprite mode: sprite is just the torso+legs, overlaid with programmatic LEGO parts
      // full_character mode: sprite is the entire figure (head→feet), programmatic parts skipped
      characters[0].updateBodySprite(payload.body_png);
      // Sleeve length (from cv_module): drives bare-arm rendering in lego theme
      if (payload.upper_type) characters[0].upperKind = payload.upper_type;
      if (payload.face) characters[0].updateFace(payload.face);
      currentState = APP_STATES.CUSTOMIZE;
    } else {
      console.error("Avatar Gen Failed", payload.error);
      alert("Generation Failed: " + payload.error);
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
        if (c.accessory) p.accessory = c.accessory;
        swarmPersons[c.id] = p;
      }
      const p = swarmPersons[c.id];
      p.x = c.x / 1920 * width;
      p.y = c.y / 1080 * height;
      p.swarmState = c.state || 'ROAMING';
    }
  });
}

function draw() {
  background('#0d1117');
  
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
  const headerH = 80;
  const pad = 16;
  const btnW = 180;
  const btnH = 36;
  const previewW = 155;

  const panelW = width - margin * 2;
  const panelH = height - headerH - margin * 2;

  // Constrain video by both available width and height
  const availW = panelW - pad * 3 - previewW;
  const availH = panelH - pad * 3 - btnH;
  const aspect = 3 / 4; // h/w for 640×480

  let vidW = Math.min(1280, availW);
  let vidH = vidW * aspect;
  if (vidH > availH) { vidH = availH; vidW = vidH / aspect; }

  const imgX = Math.max(margin + pad, width / 2 - vidW / 2);
  const imgY = headerH + margin + pad;
  const btnX = imgX + vidW / 2 - btnW / 2;
  const btnY = imgY + vidH + pad;

  return { margin, headerH, pad, panelW, panelH, vidW, vidH, imgX, imgY, previewW, btnW, btnH, btnX, btnY };
}

function drawLiveState() {
  accessorySelect.hide();
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
  text("STEP 1: POSITION YOURSELF FOR CAPTURE", 20, 50);

  const { margin, headerH, panelW, panelH, vidW, vidH, imgX, imgY, btnH, btnY } = _getLiveLayout();

  fill('#161b22'); stroke('#30363d'); strokeWeight(2);
  rect(margin, headerH + margin, panelW, panelH, 12);

  if (capture && capture.loadedmetadata) {
    push();
    translate(imgX + vidW, imgY);
    scale(-1, 1);
    image(capture, 0, 0, vidW, vidH);
    pop();

    noFill(); stroke('#30363d'); strokeWeight(2);
    rect(imgX, imgY, vidW, vidH, 8);

    // 定期送 frame 給後端做骨架偵測
    const now = millis();
    if (isDetecting && now - lastFrameSent > 500 && window.personaFlow?.socket) {
      const b64 = _captureBase64(0.5);
      if (b64) { lastFrameSent = now; window.personaFlow.socket.emit("process_frame", { image: b64 }); }
    }

    // 骨架疊加
    if (latestFeatures?.landmarks) {
      _drawSkeleton(latestFeatures.landmarks, imgX, imgY, vidW, vidH);
    }

    // 上下半身顏色預覽（影像右側）
    _drawColorPreview(latestFeatures, imgX + vidW + 16, imgY);

    // 按鈕群組
    const gap = 12;
    const startW = 90;
    const pauseW = 90;
    const captureW = 130;
    const totalBtnW = startW + gap + pauseW + gap + captureW;
    const startX = imgX + vidW / 2 - totalBtnW / 2;
    
    const btns = [
      { id: 'start', label: '▶ START', x: startX, w: startW, color: isDetecting ? '#238636' : '#2ea043' },
      { id: 'pause', label: '⏸ PAUSE', x: startX + startW + gap, w: pauseW, color: !isDetecting && countdownValue === 0 ? '#da3633' : '#a42e2c' },
      { id: 'capture', label: countdownValue > 0 ? "📸 CAPTURING..." : "📸 3s CAPTURE", x: startX + startW + pauseW + gap * 2, w: captureW, color: countdownValue > 0 ? '#1f6feb' : '#1f6feb' }
    ];

    for (const b of btns) {
      fill(b.color);
      noStroke(); rect(b.x, btnY, b.w, btnH, 8);
      fill(255); textSize(14); textStyle(BOLD); textAlign(CENTER, CENTER);
      text(b.label, b.x + b.w / 2, btnY + btnH / 2);
    }

    // 倒數邏輯
    if (countdownValue > 0) {
      const elapsed = millis() - countdownStartTime;
      const remaining = Math.ceil(3 - elapsed / 1000);

      if (remaining > 0) {
        fill(255, 255, 255, 200); textSize(100);
        text(remaining.toString(), imgX + vidW / 2, imgY + vidH / 2);
      } else {
        countdownValue = 0;
        const b64 = _captureBase64(0.8);
        if (b64 && window.personaFlow?.socket) {
          window.personaFlow.socket.emit("generate_avatar", { image: b64, mode: _getSelectedMode() });
          currentState = APP_STATES.PROCESSING;
        }
      }
    }
  }
}

function drawProcessingState() {
  accessorySelect.hide();
  downloadBtn.style.display = 'none';
  retryBtn.style.display = 'none';
  joinProjectionBtn.style.display = 'none';
  leaveSwarmBtn.style.display = 'none';
  loadPhotoBtn.style.display = 'none';
  const t = millis() / 1000;
  fill(255); noStroke();
  textSize(32); textStyle(BOLD); textAlign(CENTER, CENTER);
  text("🤖 AI IS ANALYZING YOUR OUTFIT...", width/2, height/2 - 50);
  
  textSize(16); fill('#8b949e');
  text("Extracting components, colors, and stencil patterns", width/2, height/2);

  // Spinner
  push();
  translate(width/2, height/2 + 80);
  rotate(t * 5);
  stroke('#58a6ff'); strokeWeight(4); noFill();
  arc(0, 0, 40, 40, 0, PI + HALF_PI);
  pop();
}

function drawCustomizeState() {
  fill('#58a6ff'); noStroke();
  textSize(24); textStyle(BOLD); textAlign(LEFT, TOP);
  text("PERSONAFLOW: CUSTOMIZE AVATAR", 20, 20);
  fill('#8b949e'); textSize(14); textStyle(NORMAL);
  text("STEP 2: ADD ACCESSORIES AND DOWNLOAD", 20, 50);

  // Center avatar
  const person = characters[0];
  person.x = width/2 - 100; // shift slightly left to make room for UI
  person.y = height/2 + (height * 0.15);
  person.accessory = accessorySelect.value();

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

  // Accessory Select position
  const uiX = width/2 + 150;
  const uiY = height/2 - 50;
  
  accessorySelect.show();
  accessorySelect.position(uiX, uiY);

  // Buttons
  downloadBtn.style.display = 'block';
  downloadBtn.style.left = uiX + 'px';
  downloadBtn.style.top = (uiY + 60) + 'px';

  retryBtn.style.display = 'block';
  retryBtn.style.left = uiX + 'px';
  retryBtn.style.top = (uiY + 120) + 'px';

  joinProjectionBtn.style.display = myAvatarData ? 'block' : 'none';
  joinProjectionBtn.style.left = uiX + 'px';
  joinProjectionBtn.style.top = (uiY + 180) + 'px';

  leaveSwarmBtn.style.display = 'none';
  loadPhotoBtn.style.display = 'none';

  // Label for accessory
  fill('#c9d1d9'); noStroke(); textSize(14); textAlign(LEFT, BOTTOM);
  text("ADD ACCESSORY:", uiX, uiY - 5);
}

function mousePressed() {
  if (currentState === APP_STATES.LIVE && countdownValue === 0) {
    const { imgX, vidW, btnY, btnH } = _getLiveLayout();
    const gap = 12;
    const startW = 90;
    const pauseW = 90;
    const captureW = 130;
    const totalBtnW = startW + gap + pauseW + gap + captureW;
    const startX = imgX + vidW / 2 - totalBtnW / 2;
    
    if (mouseY >= btnY && mouseY <= btnY + btnH) {
      if (mouseX >= startX && mouseX <= startX + startW) {
        isDetecting = true;
      } else if (mouseX >= startX + startW + gap && mouseX <= startX + startW + gap + pauseW) {
        isDetecting = false;
      } else if (mouseX >= startX + startW + pauseW + gap * 2 && mouseX <= startX + totalBtnW) {
        countdownValue = 3;
        countdownStartTime = millis();
        isDetecting = true;
      }
    }
  }
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

function _getSelectedMode() {
  const checked = document.querySelector('input[name="genMode"]:checked');
  return checked ? checked.value : 'body_sprite';
}

function _drawSkeleton(landmarks, ix, iy, vw, vh) {
  const CONNS = [
    [11,12],[11,13],[13,15],[12,14],[14,16],
    [11,23],[12,24],[23,24],
    [23,25],[25,27],[24,26],[26,28]
  ];
  const lx = lm => ix + (1 - lm.x) * vw;
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
  accessorySelect.hide();
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

  for (const [, p] of Object.entries(swarmPersons)) {
    p.drawSelf(0.7);
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
  const p = characters[0];
  const toHex = c => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
  window.personaFlow.socket.emit("join_swarm", {
    x: 960, y: 540,
    upper: { hex: toHex(p.innerColor), rgb: [p.innerColor.r, p.innerColor.g, p.innerColor.b] },
    lower: { hex: toHex(p.lowerColor), rgb: [p.lowerColor.r, p.lowerColor.g, p.lowerColor.b] },
    upper_type: 'short_sleeve',
    lower_type: (p.lowerType === 'jeans' || p.lowerType === 'suit_pants' || p.lowerType === 'long_pants')
      ? 'long_pants' : 'shorts',
    accessory: p.accessory,
    face:   myAvatarData?.face   || null,
    outfit: myAvatarData?.outfit || null,
  });
  currentState = APP_STATES.SWARM;
}

// ─────────────────────────────────────────
//  CLOTH GRID RENDERER
//  poly   : [[x,y], ...] vertices in current p5 transform space
//  grid   : { cols, rows, cells:[{r,g,b,active}] }  (row-major)
//  mirrorX: if true, flip the UV mapping horizontally (for right leg)
// ─────────────────────────────────────────
function _drawClothGrid(ctx, poly, grid, mirrorX = false) {
  if (!grid || !grid.cells || grid.cells.length === 0) return;

  const { cols, rows, cells } = grid;

  // Compute bounding box of the polygon in p5 coordinates
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of poly) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw <= 0 || bh <= 0) return;

  const cellW = bw / cols;
  const cellH = bh / rows;

  // Build clip path from polygon
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
  ctx.clip();

  // Draw each active cell
  for (let row = 0; row < rows; row++) {
    // UV col index: mirrorX flips left↔right so right-leg mirrors left-leg grid
    for (let col = 0; col < cols; col++) {
      const uvCol = mirrorX ? (cols - 1 - col) : col;
      const cell = cells[row * cols + uvCol];
      if (!cell || !cell.active) continue;

      const cx = minX + col * cellW;
      const cy = minY + row * cellH;

      ctx.fillStyle = `rgb(${cell.r},${cell.g},${cell.b})`;
      ctx.fillRect(cx, cy, cellW + 0.5, cellH + 0.5);  // +0.5 prevents hairline gaps
    }
  }

  ctx.restore();
}

// ─────────────────────────────────────────
//  CLOTH SPRITE RENDERER  (OpenAI-generated PNG)
//  Draws the sprite scaled to the polygon's bounding box, clipped to the
//  polygon shape so it follows the character silhouette.
// ─────────────────────────────────────────
function _drawClothSprite(ctx, poly, img, mirrorX = false) {
  if (!img || !img.width || !img.height) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of poly) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw <= 0 || bh <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
  ctx.clip();

  if (mirrorX) {
    ctx.translate(minX + bw, minY);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, bw, bh);
  } else {
    ctx.drawImage(img, minX, minY, bw, bh);
  }

  ctx.restore();
}

// ─────────────────────────────────────────
//  CLOTH SPRITE SLICE — draw a sub-region (UV source rect) of the sprite,
//  fitted to the polygon's bounding box and clipped to its outline.
//  Used so LEGO arms get the cardigan's sleeve texture instead of solid colour.
// ─────────────────────────────────────────
function _drawClothSpriteSlice(ctx, poly, img, sx, sy, sw, sh) {
  if (!img || !img.width || !img.height) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of poly) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw <= 0 || bh <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, minX, minY, bw, bh);
  ctx.restore();
}
