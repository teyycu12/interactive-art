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
let cameraEnabled = true;
let lastFrameSent = 0;
let latestFeatures = null;

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

// class Person 已移至 character.js（見 CLAUDE.md：sketch.js 只放渲染程式碼）

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
    values:   () => Array.from(selected),
    show:     () => { panel.style.display = 'flex'; },
    hide:     () => { panel.style.display = 'none'; },
    position: (x, y) => { panel.style.left = x + 'px'; panel.style.top = y + 'px'; },
    reset:    () => {
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
  capture = createCapture(VIDEO);
  capture.size(640, 480);
  capture.hide();

  characters.push(new Person(0, 0));

  accessoryPanel = createAccessoryPanel();
  
  downloadBtn = createBtn('💾 DOWNLOAD AVATAR', '#2ea043', () => {
    saveCanvas('PersonaFlow_Avatar', 'png');
  });
  
  retryBtn = createBtn('🔄 RETRY', '#da3633', () => {
    currentState = APP_STATES.LIVE;
    isDetecting = false;
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
    window.personaFlow._lastJoinPayload = null;
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
    if (latestFeatures?.arm_color) {
      characters[0].armColor = hexToRgb(latestFeatures.arm_color.hex);
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
      if (payload.arm_color) characters[0].armColor = hexToRgb(payload.arm_color.hex);
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
        swarmPersons[c.id] = new Person(0, 0);
      }
      const p = swarmPersons[c.id];
      if (c.outfit) {
        p.updateFromVLM(c.outfit, null);
      } else {
        if (c.upper?.hex) p.innerColor = hexToRgb(c.upper.hex);
        if (c.lower?.hex) p.lowerColor = hexToRgb(c.lower.hex);
        p.lowerType = c.lower_type === 'long_pants' ? 'jeans' : 'shorts';
      }
      if (c.face) p.updateFace(c.face);
      if (Array.isArray(c.accessories)) p.accessories = c.accessories;
      else if (c.accessory && c.accessory !== 'none') p.accessories = [c.accessory];

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
  text("STEP 1: POSITION YOURSELF FOR CAPTURE", 20, 50);

  const { margin, headerH, panelW, panelH, vidW, vidH, imgX, imgY, btnH, btnY } = _getLiveLayout();

  fill('#161b22'); stroke('#30363d'); strokeWeight(2);
  rect(margin, headerH + margin, panelW, panelH, 12);

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
    image(capture, 0, 0, vidW, vidH);
    pop();

    noFill(); stroke('#30363d'); strokeWeight(2);
    rect(imgX, imgY, vidW, vidH, 8);

    // 定期送 frame 給後端做骨架偵測
    const now = millis();
    if (isDetecting && now - lastFrameSent > 150 && window.personaFlow?.socket) {
      const b64 = _captureBase64(0.5);
      if (b64) { lastFrameSent = now; window.personaFlow.socket.emit("process_frame", { image: b64 }); }
    }

    // 骨架疊加
    if (latestFeatures?.landmarks) {
      _drawSkeleton(latestFeatures.landmarks, imgX, imgY, vidW, vidH);
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

  // 上下半身顏色預覽（影像右側）
  _drawColorPreview(latestFeatures, imgX + vidW + 16, imgY);

  // 按鈕群組
  const gap = 12;
  const startW = 90;
  const pauseW = 90;
  const captureW = 130;
  const camW = 110;
  const totalBtnW = startW + gap + pauseW + gap + captureW + gap + camW;
  const startX = imgX + vidW / 2 - totalBtnW / 2;

  const btns = [
    { id: 'start',   label: '▶ START',   x: startX, w: startW,
      color: !cameraEnabled ? '#373e47' : (isDetecting ? '#238636' : '#2ea043') },
    { id: 'pause',   label: '⏸ PAUSE',   x: startX + startW + gap, w: pauseW,
      color: !cameraEnabled ? '#373e47' : (!isDetecting && countdownValue === 0 ? '#da3633' : '#a42e2c') },
    { id: 'capture', label: countdownValue > 0 ? "📸 CAPTURING..." : "📸 3s CAPTURE",
      x: startX + startW + pauseW + gap * 2, w: captureW,
      color: !cameraEnabled ? '#373e47' : '#1f6feb' },
    { id: 'cam',     label: cameraEnabled ? '📷 關閉攝影機' : '📷 開啟攝影機',
      x: startX + startW + pauseW + captureW + gap * 3, w: camW,
      color: cameraEnabled ? '#6e7681' : '#388bfd' },
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
  person.y = height/2 + (height * 0.05);
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

  // Accessory panel position
  const uiX = width/2 + 150;
  const uiY = height/2 - 120;

  accessoryPanel.show();
  accessoryPanel.position(uiX, uiY);

  // Buttons — pushed down to make room for the multi-select panel (~120px)
  downloadBtn.style.display = 'block';
  downloadBtn.style.left = uiX + 'px';
  downloadBtn.style.top = (uiY + 130) + 'px';

  retryBtn.style.display = 'block';
  retryBtn.style.left = uiX + 'px';
  retryBtn.style.top = (uiY + 190) + 'px';

  joinProjectionBtn.style.display = myAvatarData ? 'block' : 'none';
  joinProjectionBtn.style.left = uiX + 'px';
  joinProjectionBtn.style.top = (uiY + 250) + 'px';

  leaveSwarmBtn.style.display = 'none';
  loadPhotoBtn.style.display = 'none';

  // Label for accessory panel
  fill('#c9d1d9'); noStroke(); textSize(14); textAlign(LEFT, BOTTOM);
  text("ACCESSORIES 選多個：", uiX, uiY - 5);
}

function mousePressed() {
  if (currentState === APP_STATES.LIVE && countdownValue === 0) {
    const { imgX, vidW, btnY, btnH } = _getLiveLayout();
    const gap = 12;
    const startW = 90;
    const pauseW = 90;
    const captureW = 130;
    const camW = 110;
    const totalBtnW = startW + gap + pauseW + gap + captureW + gap + camW;
    const startX = imgX + vidW / 2 - totalBtnW / 2;

    if (mouseY >= btnY && mouseY <= btnY + btnH) {
      const camX = startX + startW + pauseW + captureW + gap * 3;
      if (mouseX >= camX && mouseX <= camX + camW) {
        _toggleCamera();
      } else if (cameraEnabled) {
        if (mouseX >= startX && mouseX <= startX + startW) {
          isDetecting = true;
        } else if (mouseX >= startX + startW + gap && mouseX <= startX + startW + gap + pauseW) {
          isDetecting = false;
        } else if (mouseX >= startX + startW + pauseW + gap * 2 && mouseX <= startX + startW + pauseW + gap * 2 + captureW) {
          countdownValue = 3;
          countdownStartTime = millis();
          isDetecting = true;
        }
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

function _toggleCamera() {
  if (cameraEnabled) {
    const stream = capture?.elt?.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (capture?.elt) capture.elt.srcObject = null;
    cameraEnabled = false;
    isDetecting = false;
  } else {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(stream => {
        if (capture?.elt) {
          capture.elt.srcObject = stream;
          capture.elt.play().catch(() => {});
          capture.loadedmetadata = true;
        }
        cameraEnabled = true;
      })
      .catch(err => console.error('[camera] restart failed:', err));
  }
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
  const eArm   = _enh(armSrc);

  // Build enhanced outfit so projection.html doesn't see the raw CV hex
  let enhancedOutfit = myAvatarData?.outfit ? { ...myAvatarData.outfit } : null;
  if (enhancedOutfit) {
    enhancedOutfit.inner_color = eInner.hex;
    enhancedOutfit.lower_color = eLower.hex;
    if (enhancedOutfit.outer_color) {
      enhancedOutfit.outer_color = _enh(hexToRgb(enhancedOutfit.outer_color)).hex;
    }
  }

  // Run the same grid pipeline that lego.js uses so projection.html gets pre-processed cells.
  const _procCloth = p.clothGrid
    ? _makeSymmetric(_enhanceGrid(_clusterGrid(
        _filterHairCells(p.clothGrid, p.hairColor, p.innerColor)
      )))
    : null;
  const _procLower = p.lowerGrid
    ? _enhanceGrid(_clusterGrid(
        _filterShirtFromLower(p.lowerGrid, p.innerColor, p.lowerColor)
      ))
    : null;

  const payload = {
    x: 960, y: 540,
    upper: { hex: eInner.hex, rgb: [eInner.r, eInner.g, eInner.b] },
    lower: { hex: eLower.hex, rgb: [eLower.r, eLower.g, eLower.b] },
    arm:   { hex: eArm.hex,   rgb: [eArm.r,   eArm.g,   eArm.b  ] },
    upper_type: 'short_sleeve',
    lower_type: (p.lowerType === 'jeans' || p.lowerType === 'suit_pants' || p.lowerType === 'long_pants')
      ? 'long_pants' : 'shorts',
    accessories: p.accessories,
    accessory:   p.accessories[0] || 'none',
    face:        myAvatarData?.face || null,
    outfit:      enhancedOutfit,
    cloth_grid:  _procCloth,
    lower_grid:  _procLower,
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
      boidId:      window.personaFlow.myCharId || 'user_0',
      topColor:    eInner.hex,
      bottomColor: eLower.hex,
      armColor:    eArm.hex,
      hasGlasses:  p.accessories.includes('glasses'),
    });
    bc.close();
  } catch (_) { /* BroadcastChannel not supported */ }

  // Open projection wall in a new tab after 300 ms so join_swarm reaches the
  // backend before projection.html's socket connects.
  setTimeout(() => window.open('projection.html', '_blank'), 300);
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

