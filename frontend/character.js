// PersonaFlow – character component definitions
// Loaded as a plain <script> before sketch.js; all symbols are global.

const ACCESSORIES_LIST = [
  { value: 'none', label: '— None —' },
  { value: 'bouquet', label: '💐 Bouquet' },
  { value: 'camera', label: '📷 Camera' },
  { value: 'hat', label: '🎩 Hat' },
  { value: 'bag', label: '👜 Bag' },
  { value: 'glasses', label: '👓 Glasses' },
  { value: 'cat', label: '🐱 Pet Cat' },
];

function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 255, g: 255, b: 255 };
  const n = hex.trim().replace('#', '');
  if (n.length !== 6) return { r: 255, g: 255, b: 255 };
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  if ([r, g, b].some(v => Number.isNaN(v))) return { r: 255, g: 255, b: 255 };
  return { r, g, b };
}

// ─────────────────────────────────────────
//  HAIR DRAWING  (back layer — behind head)
// ─────────────────────────────────────────

function _hairBack(style, hc) {
  fill(hc);
  switch (style) {
    case 'long_straight': _hairBack_longStraight(); break;
    case 'curly': _hairBack_curly(); break;
    case 'wavy': _hairBack_wavy(); break;
    case 'ponytail': _hairBack_ponytail(hc); break;
    case 'bun': _hairBack_bun(); break;
    case 'buzz_cut': _hairBack_buzzCut(); break;
    case 'bald': break;
    default: _hairBack_shortStraight(); break;
  }
}

function _hairBack_shortStraight() {
  // Back layer: wider than face (±58) so edges peek from behind; crown at y=-116
  beginShape();
  vertex(-58, -76);
  bezierVertex(-58, -116, 58, -116, 58, -76);
  endShape(CLOSE);
}

function _hairBack_longStraight() {
  // Back layer: dome (crown y=-116) + hair flowing down the back past waist
  beginShape();
  vertex(-58, -76);
  bezierVertex(-58, -116, 58, -116, 58, -76);  // dome — aligned with front
  bezierVertex(60, -50, 62, -5, 58, 22);        // right side flows down
  bezierVertex(38, 30, -38, 30, -58, 22);       // bottom panel
  bezierVertex(-62, -5, -60, -50, -58, -76);    // left side
  endShape(CLOSE);
}

function _hairBack_curly() {
  // Large puffy blob
  ellipse(0, -92, 130, 110);
  ellipse(-52, -74, 40, 56);
  ellipse(52, -74, 40, 56);
}

function _hairBack_wavy() {
  beginShape();
  vertex(-52, -80);
  bezierVertex(-66, -102, -38, -122, 0, -122);
  bezierVertex(38, -122, 66, -102, 52, -80);
  vertex(60, -50);
  bezierVertex(64, -30, 48, -15, 54, 5);
  bezierVertex(58, 20, 46, 26, 52, 36);
  vertex(-52, 36);
  bezierVertex(-46, 26, -58, 20, -54, 5);
  bezierVertex(-48, -15, -64, -30, -60, -50);
  endShape(CLOSE);
}

function _hairBack_ponytail(hc) {
  // Smooth back of head
  arc(0, -80, 112, 96, PI, 0);
  // Ponytail strand at centre-back
  fill(hc);
  beginShape();
  vertex(-10, -58);
  bezierVertex(-18, -20, -14, 10, -10, 44);
  vertex(10, 44);
  bezierVertex(14, 10, 18, -20, 10, -58);
  endShape(CLOSE);
}

function _hairBack_bun() {
  arc(0, -80, 110, 94, PI, 0);
}

function _hairBack_buzzCut() {
  // Very thin cap — draw as thin filled shape
  beginShape();
  vertex(-50, -77);
  bezierVertex(-56, -102, -30, -118, 0, -118);
  bezierVertex(30, -118, 56, -102, 50, -77);
  bezierVertex(42, -76, 42, -77, 36, -77);
  bezierVertex(36, -108, 20, -112, 0, -112);
  bezierVertex(-20, -112, -36, -108, -36, -77);
  vertex(-42, -77);
  endShape(CLOSE);
}

// ─────────────────────────────────────────
//  HAIR DRAWING  (front layer — above face)
// ─────────────────────────────────────────

function _hairFront(style, hc) {
  fill(hc);
  switch (style) {
    case 'long_straight': _hairFront_longStraight(); break;
    case 'curly': _hairFront_curly(); break;
    case 'wavy': _hairFront_wavy(); break;
    case 'ponytail': _hairFront_ponytail(); break;
    case 'bun': _hairFront_bun(hc); break;
    case 'buzz_cut': _hairFront_buzzCut(); break;
    case 'bald': break;
    default: _hairFront_shortStraight(); break;
  }
}

function _hairFront_shortStraight() {
  // Front layer (short): dome crown y=-116 + two clear anime bangs, no shoulder curtains
  beginShape();
  vertex(-53, -76);
  bezierVertex(-53, -116, 53, -116, 53, -76);  // dome — crown aligned with back layer
  bezierVertex(40, -74, 28, -72, 18, -74);      // right bang tip (y≈-72, below hairline)
  bezierVertex(8, -84, -8, -84, -18, -74);      // arch between bangs (y≈-84, above hairline)
  bezierVertex(-28, -72, -40, -74, -53, -76);   // left bang tip
  endShape(CLOSE);
}

function _hairFront_longStraight() {
  // Front layer (long): dome crown y=-116, no bangs + symmetric shoulder curtains
  beginShape();
  vertex(-52, -76);
  bezierVertex(-52, -116, 52, -116, 52, -76);   // dome — crown aligned with back layer
  endShape(CLOSE);
  // Left shoulder curtain
  beginShape();
  vertex(-50, -76);
  bezierVertex(-56, -52, -56, -34, -52, -26);
  vertex(-38, -26);
  bezierVertex(-38, -34, -38, -52, -36, -76);
  endShape(CLOSE);
  // Right shoulder curtain (mirror)
  beginShape();
  vertex(50, -76);
  bezierVertex(56, -52, 56, -34, 52, -26);
  vertex(38, -26);
  bezierVertex(38, -34, 38, -52, 36, -76);
  endShape(CLOSE);
}

function _hairFront_curly() {
  // Bumpy circles around the top arc
  const positions = [
    [-48, -82], [-34, -108], [-14, -118], [8, -118], [28, -108], [46, -82],
    [-56, -70], [56, -70],
  ];
  for (const [ex, ey] of positions) circle(ex, ey, 32);
  // Fill gaps in centre
  arc(0, -96, 80, 56, PI, 0);
}

function _hairFront_wavy() {
  // 3 soft wavy bangs
  beginShape();
  vertex(-50, -75);
  bezierVertex(-50, -118, 50, -118, 50, -75);
  bezierVertex(40, -76, 26, -64, 14, -70);       // right bang (lower than short)
  bezierVertex(8, -92, 0, -80, -4, -74);         // wavy center
  bezierVertex(-10, -92, -26, -64, -38, -70);    // left bang
  bezierVertex(-44, -76, -50, -75, -50, -75);
  endShape(CLOSE);
}

function _hairFront_ponytail() {
  // Pulled-back smooth dome — minimal bangs, clean silhouette
  beginShape();
  vertex(-50, -76);
  bezierVertex(-50, -118, 50, -118, 50, -76);
  bezierVertex(42, -76, 22, -70, 0, -72);
  bezierVertex(-22, -70, -42, -76, -50, -76);
  endShape(CLOSE);
  // Elastic band
  noStroke();
  fill(80, 50, 30);
  circle(0, -60, 9);
}

function _hairFront_bun(hc) {
  // Sides swept up
  fill(hc);
  beginShape();
  vertex(-50, -75); vertex(-44, -100);
  bezierVertex(-30, -118, -10, -120, -5, -116);
  vertex(-5, -112); vertex(-44, -86);
  endShape(CLOSE);
  beginShape();
  vertex(50, -75); vertex(44, -100);
  bezierVertex(30, -118, 10, -120, 5, -116);
  vertex(5, -112); vertex(44, -86);
  endShape(CLOSE);
  // Bun circle
  circle(0, -128, 34);
  // Bun base stub
  beginShape();
  vertex(-7, -114); bezierVertex(-10, -120, 10, -120, 7, -114);
  endShape(CLOSE);
}

function _hairFront_buzzCut() {
  // Thin cap on crown
  arc(0, -100, 88, 44, PI, 0);
}

// ─────────────────────────────────────────
//  EYEBROWS
// ─────────────────────────────────────────

function _drawEyebrows(style) {
  noFill();
  stroke('#3a2a18');
  strokeCap(ROUND);
  if (style === 'thick') {
    strokeWeight(5);
    arc(-28, -83, 30, 12, PI, 0);
    arc(28, -83, 30, 12, PI, 0);
  } else {
    strokeWeight(3);
    arc(-28, -83, 28, 10, PI, 0);
    arc(28, -83, 28, 10, PI, 0);
  }
}

// ─────────────────────────────────────────
//  EYES  (anime style, shape-aware)
// ─────────────────────────────────────────

function _drawEyes(eyeShape, ec) {
  // Follows the reference pattern:
  //   arc(0→PI) = eye white (bottom half of tall ellipse)
  //   rect = colored iris
  //   arc(0→PI) = rounded iris bottom
  const ey = -70;
  const ew = eyeShape === 'narrow' ? 26 : eyeShape === 'round' ? 20 : 22;
  const eh = ew * 2.2;
  const iw = ew * 0.55;
  const ih = eh / 2 - iw / 2;  // iris height so its arc bottom meets sclera bottom

  for (const cx of [-28, 28]) {
    // 1. Eye white — bottom-half arc (visible below eyelid line)
    noStroke();
    fill(255, 248, 244);
    arc(cx, ey, ew, eh, 0, PI);

    // 2. Shadow at top of eye
    fill(0, 0, 0, 18);
    rect(cx - ew / 2, ey, ew, eh * 0.16);

    // 3. Iris rectangle
    fill(ec.r, ec.g, ec.b);
    noStroke();
    rect(cx - iw / 2, ey, iw, ih);

    // 4. Outline: eyelid + iris sides + iris rounded bottom
    stroke('#3a2a18');
    strokeWeight(2);
    strokeCap(ROUND);
    line(cx - ew / 2, ey, cx + ew / 2, ey);       // flat eyelid top
    line(cx - iw / 2, ey, cx - iw / 2, ey + ih);  // iris left
    line(cx + iw / 2, ey, cx + iw / 2, ey + ih);  // iris right
    noFill();
    arc(cx, ey + ih, iw, iw, 0, PI);               // iris rounded bottom

    // 5. Highlights
    //noStroke();
    //fill(255, 255, 255, 55);
    //ellipse(cx, ey + ih, iw * 0.85, iw * 0.5);    // glow at iris base
    //fill(255, 255, 255, 215);
    //ellipse(cx + iw * 0.18, ey + ih * 0.28, iw * 0.44, iw * 0.28);  // bright highlight
  }
}

// ─────────────────────────────────────────
//  BEARD / FACIAL HAIR
// ─────────────────────────────────────────

function _drawBeard(style, _skinColor, hairColor) {
  if (!style || style === 'none') return;
  push();
  noStroke();

  if (style === 'stubble') {
    // Dot matrix on jaw
    fill(hairColor.r, hairColor.g, hairColor.b, 160);
    for (let dx = -24; dx <= 24; dx += 7) {
      for (let dy = -52; dy <= -35; dy += 6) {
        circle(dx + random(-1, 1), dy + random(-1, 1), 2.5);
      }
    }

  } else if (style === 'mustache') {
    fill(hairColor.r, hairColor.g, hairColor.b);
    stroke('#3a2a18'); strokeWeight(2);
    beginShape();
    vertex(-18, -56);
    bezierVertex(-14, -60, -4, -60, 0, -56);
    bezierVertex(4, -60, 14, -60, 18, -56);
    bezierVertex(14, -52, 4, -54, 0, -52);
    bezierVertex(-4, -54, -14, -52, -18, -56);
    endShape(CLOSE);

  } else if (style === 'full_beard') {
    fill(hairColor.r, hairColor.g, hairColor.b);
    stroke('#3a2a18'); strokeWeight(2);
    // Jaw fill
    beginShape();
    vertex(-36, -55);
    bezierVertex(-38, -44, -34, -32, -28, -28);
    bezierVertex(-14, -22, 14, -22, 28, -28);
    bezierVertex(34, -32, 38, -44, 36, -55);
    bezierVertex(26, -52, 0, -50, -26, -52);
    endShape(CLOSE);
    // Mustache
    beginShape();
    vertex(-18, -56);
    bezierVertex(-10, -62, -2, -62, 0, -56);
    bezierVertex(2, -62, 10, -62, 18, -56);
    bezierVertex(8, -50, -8, -50, -18, -56);
    endShape(CLOSE);
  }
  pop();
}

// ─────────────────────────────────────────
//  ACCESSORIES  (unchanged)
// ─────────────────────────────────────────

// opts: { hatY, handYBoost }
function drawAccessory(name, a, opts = {}) {
  if (!name || name === 'none') return;
  const yb = opts.handYBoost ?? 0;
  if (name === 'bouquet') _drawBouquet(a, yb);
  else if (name === 'camera') _drawCamera(a, yb);
  else if (name === 'hat')    _drawHat(a, opts.hatY ?? -122);
  else if (name === 'bag')    _drawBag(a, yb);
  else if (name === 'glasses') _drawGlasses(a);
  else if (name === 'cat')    _drawCat(a);
}

function drawAccessories(names, a, opts = {}) {
  if (!names || names.length === 0) return;
  // lego.js (and any theme) may leave rectMode(CENTER) active; accessories expect CORNER
  push();
  rectMode(CORNER);
  for (const name of names) drawAccessory(name, a, opts);
  pop();
}

function _drawBouquet(a, yBoost = 0) {
  push();
  translate(-34, yBoost);
  stroke(70, 150, 70, a * 255); strokeWeight(3);
  line(0, 28, -6, 8); line(0, 28, 6, 8);
  const flowers = [
    { x: 0, y: -5, r: 255, g: 80, b: 120 },
    { x: -14, y: 2, r: 255, g: 200, b: 60 },
    { x: 14, y: 2, r: 200, g: 100, b: 255 },
    { x: -7, y: -18, r: 255, g: 150, b: 180 },
    { x: 7, y: -18, r: 100, g: 200, b: 255 },
  ];
  noStroke();
  for (const f of flowers) {
    fill(f.r, f.g, f.b, a * 210); circle(f.x, f.y, 15);
    fill(255, 255, 200, a * 255); circle(f.x, f.y, 5);
  }
  fill(255, 240, 220, a * 180); stroke(200, 180, 160, a * 160); strokeWeight(1);
  ellipse(0, 22, 22, 12);
  pop();
}

function _drawCamera(a, yBoost = 0) {
  push(); translate(30, -5 + yBoost);
  fill(40, 40, 40, a * 255); stroke(80, 80, 80, a * 255); strokeWeight(2);
  rect(-14, -10, 28, 20, 3);
  fill(20, 20, 50, a * 255); stroke(100, 150, 255, a * 200); strokeWeight(2);
  circle(0, 2, 14);
  fill(60, 100, 200, a * 180); noStroke(); circle(0, 2, 8);
  fill(255, 255, 200, a * 200); rect(7, -9, 6, 4, 1);
  noFill(); stroke(160, 100, 50, a * 160); strokeWeight(2);
  bezier(-14, -6, -28, -22, -22, -44, -12, -48);
  pop();
}

function _drawHat(a, y = -122) {
  push(); translate(0, y);
  fill(35, 25, 15, a * 255); stroke('#5a3a29'); strokeWeight(3);
  ellipse(0, 0, 88, 14);
  rect(-26, -38, 52, 38, 4, 4, 0, 0);
  fill(200, 50, 50, a * 220); noStroke(); rect(-26, -12, 52, 7);
  pop();
}

function _drawBag(a, yBoost = 0) {
  push(); translate(38, 8 + yBoost);
  fill(175, 115, 55, a * 255); stroke('#5a3a29'); strokeWeight(2);
  rect(-12, -14, 24, 28, 4);
  fill(155, 95, 45, a * 255); rect(-12, -14, 24, 12, 4, 4, 0, 0);
  fill(220, 190, 80, a * 255); noStroke(); circle(0, -4, 6);
  noFill(); stroke(155, 95, 45, a * 160); strokeWeight(3);
  bezier(-12, -8, -32, -28, -30, -58, -16, -62);
  pop();
}

function _drawGlasses(a) {
  push(); translate(0, -70);
  noFill(); stroke(20, 20, 20, a * 255); strokeWeight(3);
  rect(-36, -10, 28, 20, 4); rect(8, -10, 28, 20, 4);
  line(-8, 0, 8, 0);
  line(-36, -5, -45, -15); line(36, -5, 45, -15);
  fill(255, 255, 255, a * 60); noStroke();
  rect(-34, -8, 24, 16, 2); rect(10, -8, 24, 16, 2);
  pop();
}

function _drawCat(a) {
  push(); translate(-45, 30);
  fill(240, 240, 240, a * 255); stroke('#5a3a29'); strokeWeight(2);
  ellipse(0, 0, 30, 25); ellipse(0, -20, 25, 22);
  triangle(-10, -28, -15, -38, -2, -28); triangle(10, -28, 15, -38, 2, -28);
  fill(40, 40, 40, a * 255); noStroke();
  circle(-5, -22, 4); circle(5, -22, 4);
  stroke(240, 150, 150, a * 255); strokeWeight(2);
  line(0, -18, -3, -15); line(0, -18, 3, -15);
  pop();
}


// ── 角色模型 ────────────────────────────────────────────────────────
// 依 CLAUDE.md 的規範，角色的資料模型與換色邏輯屬於 character.js，
// sketch.js 只放渲染程式碼。此類別原本定義在 sketch.js（298 行），
// 而 character.js 反而完全沒有類別，與規範相反，故搬移至此。
// 對外仍以 Person 之名提供，避免變更既有呼叫點。
class Character {
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

// 沿用原本的名稱，index.html 的載入順序保證此檔先於 sketch.js 執行
const Person = Character;
