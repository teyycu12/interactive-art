// PersonaFlow – LEGO character theme
//
// Color pipeline per frame:
//   1. _filterHairCells()   – remove grid cells that match person.hairColor
//   2. _clusterGrid()       – BFS region growing (threshold 22) → average each cluster
//                             Lower threshold than before: preserves real pattern edges
//                             while still smoothing lighting noise.
//   3. _enhanceGrid()       – per-grid contrast stretch (luma range → [L_MIN, L_MAX])
//                             + saturation boost (HSL).  Makes subtle differences pop.
//   4. _makeSymmetric()     – mirror-average left↔right halves of the torso grid so
//                             the pattern reads as clean bilateral symmetry on the body.
//   5. Camera correction    – baked into _enhanceGrid (×CAMERA_CORRECTION before HSL).

// ─── Tuning knobs ────────────────────────────────────────────────────────────
const CAMERA_CORRECTION  = 1.18; // compensates for camera underexposure
const CLUSTER_THRESHOLD  = 22;   // max per-edge RGB distance to merge cells
const SAT_BOOST          = 2.2;  // saturation multiplier (HSL)
const CONTRAST_L_MIN     = 0.32; // after stretch: darkest active cell → this luma
const CONTRAST_L_MAX     = 0.82; // after stretch: brightest active cell → this luma
const HAIR_CELL_DIST     = 40;   // cell filtered if within this RGB dist of hairColor
const HAIR_SHIRT_MIN     = 35;   // skip hair filter when shirt≈hair (dark shirt + dark hair)
const SHIRT_CELL_DIST    = 45;   // lower-body cell filtered if within this dist of shirt color
const SHIRT_PANTS_MIN    = 30;   // skip shirt filter when pants≈shirt (can't distinguish)

// ─── Public entry point ──────────────────────────────────────────────────────

function drawLegoCharacter(person) {
  const s = 1.5;

  // ── Geometry ────────────────────────────────────────────────────
  const tTop   = 38 * s, tBottom = 50 * s, torsoH = 50 * s;
  const legW   = 21 * s, legH    = 38 * s, footH  = 10 * s, legGap = 2 * s;
  const aW     = 13 * s, aL      = 40 * s;
  const shldY  = -torsoH / 2 + 3 * s;
  const headS  = 35 * s;
  const headY  = -torsoH / 2 - headS / 2 - 4 * s;
  const lLegCx = -(legW / 2 + legGap);
  const rLegCx =   legW / 2 + legGap;
  const legTop = torsoH / 2;

  const torsoPoly = [
    [-tTop / 2, -torsoH / 2], [tTop / 2, -torsoH / 2],
    [ tBottom / 2, torsoH / 2], [-tBottom / 2, torsoH / 2],
  ];
  const lLegLeft = lLegCx - legW / 2, rLegLeft = rLegCx - legW / 2;
  const lLegPoly = [
    [lLegLeft,        legTop], [lLegLeft + legW, legTop],
    [lLegLeft + legW, legTop + legH], [lLegLeft, legTop + legH],
  ];
  const rLegPoly = [
    [rLegLeft,        legTop], [rLegLeft + legW, legTop],
    [rLegLeft + legW, legTop + legH], [rLegLeft, legTop + legH],
  ];

  // ── Grid pipeline ────────────────────────────────────────────────
  //   torso: hair-filter → cluster → enhance → bilateral symmetry
  //   legs:  cluster → enhance  (no symmetry; mirrorX handles it per-leg)
  const clothGrid = person.clothGrid
    ? _makeSymmetric(_enhanceGrid(_clusterGrid(
        _filterHairCells(person.clothGrid, person.hairColor, person.innerColor)
      )))
    : null;
  const lowerGrid = person.lowerGrid
    ? _enhanceGrid(_clusterGrid(
        _filterShirtFromLower(person.lowerGrid, person.innerColor, person.lowerColor)
      ))
    : null;

  // ── Solid colors for areas without grid data (arms, fallback) ───
  const [br, bg, bb] = _enhanceSolid(person.innerColor);
  const [lr, lg, lb] = _enhanceSolid(person.lowerColor);
  const bodyColor = color(br, bg, bb);
  const legColor  = color(lr, lg, lb);
  // Detected skin tone (VLM), falls back to anime-default when unavailable
  const skinColor = color(person.skinColor.r, person.skinColor.g, person.skinColor.b);

  // Adaptive outline: light if body is still dark after enhancement
  const bodyOutline = _luma(br, bg, bb) < 0.42 ? color(205, 205, 205) : color(0);
  const legOutline  = _luma(lr, lg, lb) < 0.42 ? color(205, 205, 205) : color(0);

  strokeJoin(ROUND); strokeCap(ROUND);
  strokeWeight(2 * s);
  rectMode(CENTER);

  // ══ FULL-CHARACTER MODE — the AI sprite IS the entire figure (head→feet).
  //     Skip every programmatic LEGO part; just draw the sprite at full
  //     character height. T-pose / front view, so future skeletal rigging
  //     can hang a rig over this image directly.
  const bodySpriteReady = person.bodySprite && person.bodySprite.width > 0;
  if (bodySpriteReady && person.renderMode === 'full_character') {
    const headTop      = headY - headS / 2;                       // very top of head
    const figureBottom = legTop + legH + footH;                   // bottom of feet
    const fullH        = figureBottom - headTop;
    const aspectRatio  = person.bodySprite.width / person.bodySprite.height;
    const fullW        = fullH * aspectRatio;
    const centerY      = (headTop + figureBottom) / 2;

    imageMode(CENTER);
    image(person.bodySprite, 0, centerY, fullW, fullH);
    imageMode(CORNER);
    rectMode(CENTER);
    return;
  }

  // ══ BODY-SPRITE MODE — sprite covers torso+legs only; head, hands, feet
  //     are programmatic LEGO parts with detected skin tone.
  if (bodySpriteReady) {
    // Sprite is tight-cropped server-side to its actual content bbox.
    // Position it so its TOP edge sits flush against the bottom of the head,
    // and scale it by HEIGHT preserving the sprite's native aspect ratio so
    // the cardigan + jeans don't get distorted by being squished into a square.
    const headBottom  = headY + headS / 2;       // bottom of LEGO head
    const bodyTop     = headBottom + 1 * s;      // tiny overlap to hide seams
    const bodyBottom  = legTop + legH + footH;
    const targetH     = bodyBottom - bodyTop;
    const aspectRatio = person.bodySprite.width / person.bodySprite.height;
    const targetW     = targetH * aspectRatio;
    const bodyCenterY = (bodyTop + bodyBottom) / 2;

    imageMode(CENTER);
    image(person.bodySprite, 0, bodyCenterY, targetW, targetH);
    imageMode(CORNER);

    // ── Arms — skin colour for short sleeves, shirt colour for long sleeves ──
    // Drawn on top of the sprite so canonical LEGO arms always sit at 15°.
    const isShortSleeve = (person.upperKind || 'short_sleeve') === 'short_sleeve';
    const armFill = isShortSleeve ? skinColor : bodyColor;

    strokeWeight(2 * s);
    push();
    translate(-tTop / 2, shldY); rotate(radians(15));
    fill(armFill); stroke(bodyOutline); rectMode(CORNER);
    rect(-aW, 0, aW, aL, 5 * s);
    translate(-aW / 2, aL + 5 * s);
    _legoHand(s, skinColor, bodyOutline);
    pop();

    push();
    translate(tTop / 2, shldY); rotate(radians(-15));
    fill(armFill); stroke(bodyOutline); rectMode(CORNER);
    rect(0, 0, aW, aL, 5 * s);
    translate(aW / 2, aL + 5 * s);
    _legoHand(s, skinColor, bodyOutline);
    pop();

    // ── Dark LEGO feet ──
    rectMode(CENTER);
    fill(35); stroke(0); strokeWeight(2 * s);
    rect(lLegCx, legTop + legH + footH / 2, legW + 2 * s, footH, 2 * s);
    rect(rLegCx, legTop + legH + footH / 2, legW + 2 * s, footH, 2 * s);

    // ── Head, neck stud, hair, eyes, mouth — all in detected skin tone ──
    fill(skinColor); stroke(0);
    rect(0, -torsoH / 2 - 2 * s, 16 * s, 4 * s);              // neck stud
    rect(0, headY, headS * 1.1, headS, 8 * s);                // head
    rect(0, headY - headS / 2 - 3 * s, 18 * s, 7 * s, 2 * s); // hair bar

    fill(0); noStroke();
    circle(-7 * s, headY - 2 * s, 5 * s);
    circle( 7 * s, headY - 2 * s, 5 * s);

    noFill(); stroke(0); strokeWeight(2 * s);
    const smileW = (14 + (person.smileScore || 0) * 8) * s;
    const smileH = ( 8 + (person.smileScore || 0) * 4) * s;
    arc(0, headY + 7 * s, smileW, smileH, 0, PI);

    rectMode(CENTER);
    return;
  }

  // ══ PASS A – Solid fills ═══════════════════════════════════════

  fill(bodyColor); stroke(bodyOutline);
  beginShape();
  for (const [vx, vy] of torsoPoly) vertex(vx, vy);
  endShape(CLOSE);

  fill(legColor); stroke(legOutline);
  rect(lLegCx, legTop + legH / 2, legW, legH);
  rect(rLegCx, legTop + legH / 2, legW, legH);
  // Feet always solid legColor
  rect(lLegCx, legTop + legH + footH / 2, legW + 2 * s, footH, 2 * s);
  rect(rLegCx, legTop + legH + footH / 2, legW + 2 * s, footH, 2 * s);

  // ══ PASS B – Sprite overlay (OpenAI) OR grid overlay (CV fallback) ═══

  const upperSpriteReady = person.clothSprite && person.clothSprite.width > 0;
  const lowerSpriteReady = person.lowerSprite && person.lowerSprite.width > 0;

  if (upperSpriteReady) {
    _drawClothSprite(drawingContext, torsoPoly, person.clothSprite.canvas || person.clothSprite.elt);
  } else if (clothGrid) {
    _drawClothGrid(drawingContext, torsoPoly, clothGrid);
  }

  if (lowerSpriteReady) {
    // Sprite is a single PNG showing both legs; draw it once across the
    // combined leg region (including the centre gap) so we don't double-render.
    const spriteEl = person.lowerSprite.canvas || person.lowerSprite.elt;
    const combinedLegsPoly = [
      [lLegLeft,         legTop],
      [rLegLeft + legW,  legTop],
      [rLegLeft + legW,  legTop + legH],
      [lLegLeft,         legTop + legH],
    ];
    _drawClothSprite(drawingContext, combinedLegsPoly, spriteEl);
  } else if (lowerGrid) {
    _drawClothGrid(drawingContext, lLegPoly, lowerGrid, true);
    _drawClothGrid(drawingContext, rLegPoly, lowerGrid, false);
  }

  // ══ PASS C – Outlines on top of grid ══════════════════════════

  noFill();
  stroke(bodyOutline);
  beginShape();
  for (const [vx, vy] of torsoPoly) vertex(vx, vy);
  endShape(CLOSE);
  stroke(legOutline);
  rect(lLegCx, legTop + legH / 2, legW, legH);
  rect(rLegCx, legTop + legH / 2, legW, legH);

  // ══ PASS D – Arms, head, face ══════════════════════════════════

  // Pre-compute sprite slices for arms (used only when upper sprite is ready).
  // Prompt asks for T-shape flat-lay: torso centred, sleeves to far left/right.
  // → left arm samples the left ~25% of the sprite, right arm the right ~25%.
  const upperSprEl = upperSpriteReady ? (person.clothSprite.canvas || person.clothSprite.elt) : null;
  const sliceW = upperSprEl ? upperSprEl.width * 0.25 : 0;
  const sliceH = upperSprEl ? upperSprEl.height : 0;
  const rightSliceX = upperSprEl ? upperSprEl.width * 0.75 : 0;

  push();
  translate(-tTop / 2, shldY); rotate(radians(15));
  rectMode(CORNER);
  if (upperSprEl) {
    // Texture-only fill, no opaque rect underneath
    const armPoly = [[-aW, 0], [0, 0], [0, aL], [-aW, aL]];
    _drawClothSpriteSlice(drawingContext, armPoly, upperSprEl, 0, 0, sliceW, sliceH);
    noFill(); stroke(bodyOutline);
    rect(-aW, 0, aW, aL, 5 * s);
  } else {
    fill(bodyColor); stroke(bodyOutline);
    rect(-aW, 0, aW, aL, 5 * s);
  }
  translate(-aW / 2, aL + 5 * s);
  _legoHand(s, skinColor, bodyOutline);
  pop();

  push();
  translate(tTop / 2, shldY); rotate(radians(-15));
  rectMode(CORNER);
  if (upperSprEl) {
    const armPoly = [[0, 0], [aW, 0], [aW, aL], [0, aL]];
    _drawClothSpriteSlice(drawingContext, armPoly, upperSprEl, rightSliceX, 0, sliceW, sliceH);
    noFill(); stroke(bodyOutline);
    rect(0, 0, aW, aL, 5 * s);
  } else {
    fill(bodyColor); stroke(bodyOutline);
    rect(0, 0, aW, aL, 5 * s);
  }
  translate(aW / 2, aL + 5 * s);
  _legoHand(s, skinColor, bodyOutline);
  pop();

  fill(skinColor); stroke(0); rectMode(CENTER);
  rect(0, -torsoH / 2 - 2 * s, 16 * s, 4 * s);
  rect(0, headY, headS * 1.1, headS, 8 * s);
  rect(0, headY - headS / 2 - 3 * s, 18 * s, 7 * s, 2 * s);

  fill(0); noStroke();
  circle(-7 * s, headY - 2 * s, 5 * s);
  circle( 7 * s, headY - 2 * s, 5 * s);

  noFill(); stroke(0); strokeWeight(2 * s);
  const smileW = (14 + (person.smileScore || 0) * 8) * s;
  const smileH = ( 8 + (person.smileScore || 0) * 4) * s;
  arc(0, headY + 7 * s, smileW, smileH, 0, PI);

  rectMode(CENTER);
}

// ─── Grid pipeline steps ─────────────────────────────────────────────────────

// 1a. Shirt-color filter for lower-body grid
//     The lower-body ROI often overlaps the shirt hem, contaminating the pants
//     colour with shirt pixels.  Remove any cell whose colour is close to the
//     detected shirt colour; the remaining dominant colour = actual pants.
//     Guard: when pants ≈ shirt (same-colour outfit) the filter is skipped so
//     we don't accidentally erase all lower-body data.
function _filterShirtFromLower(grid, shirtColor, pantsColor) {
  if (!grid || !shirtColor || !pantsColor) return grid;
  if (Math.hypot(
    pantsColor.r - shirtColor.r,
    pantsColor.g - shirtColor.g,
    pantsColor.b - shirtColor.b,
  ) < SHIRT_PANTS_MIN) return grid; // pants ≈ shirt — skip

  const cells = grid.cells.map(c => {
    if (!c.active) return c;
    const d = Math.hypot(c.r - shirtColor.r, c.g - shirtColor.g, c.b - shirtColor.b);
    return d <= SHIRT_CELL_DIST ? { ...c, active: false } : c;
  });
  return { ...grid, cells };
}

// 1b. Hair filter
function _filterHairCells(grid, hairColor, shirtColor) {
  if (!grid || !hairColor || !shirtColor) return grid;
  if (Math.hypot(
    shirtColor.r - hairColor.r,
    shirtColor.g - hairColor.g,
    shirtColor.b - hairColor.b,
  ) < HAIR_SHIRT_MIN) return grid; // shirt ≈ hair; can't distinguish — skip

  const cells = grid.cells.map(c => {
    if (!c.active) return c;
    const d = Math.hypot(c.r - hairColor.r, c.g - hairColor.g, c.b - hairColor.b);
    return d <= HAIR_CELL_DIST ? { ...c, active: false } : c;
  });
  return { ...grid, cells };
}

// 2. BFS cluster + average (reduced threshold = preserves real pattern edges)
function _clusterGrid(grid) {
  if (!grid || !grid.cells || grid.cells.length === 0) return null;
  const { cols, rows } = grid;
  const n = cols * rows;
  const cells    = grid.cells.map(c => ({ r: c.r, g: c.g, b: c.b, active: c.active }));
  const visited  = new Uint8Array(n);

  for (let seed = 0; seed < n; seed++) {
    if (!cells[seed].active || visited[seed]) continue;
    const indices = [], queue = [seed];
    visited[seed] = 1;

    while (queue.length > 0) {
      const curr = queue.shift();
      indices.push(curr);
      const cr = (curr / cols) | 0, cc = curr % cols;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (!cells[ni].active || visited[ni]) continue;
        if (Math.hypot(
          cells[curr].r - cells[ni].r,
          cells[curr].g - cells[ni].g,
          cells[curr].b - cells[ni].b,
        ) < CLUSTER_THRESHOLD) { visited[ni] = 1; queue.push(ni); }
      }
    }

    let sr = 0, sg = 0, sb = 0;
    for (const i of indices) { sr += cells[i].r; sg += cells[i].g; sb += cells[i].b; }
    const mr = Math.round(sr / indices.length);
    const mg = Math.round(sg / indices.length);
    const mb = Math.round(sb / indices.length);
    for (const i of indices) { cells[i].r = mr; cells[i].g = mg; cells[i].b = mb; }
  }

  // Edge dilation (3 passes) — fill gaps at silhouette borders
  for (let pass = 0; pass < 3; pass++) {
    const upd = [];
    for (let i = 0; i < n; i++) {
      if (cells[i].active) continue;
      const cr = (i / cols) | 0, cc = i % cols;
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (!cells[ni].active) continue;
        sr += cells[ni].r; sg += cells[ni].g; sb += cells[ni].b; cnt++;
      }
      if (cnt > 0) upd.push({ i, r: Math.round(sr/cnt), g: Math.round(sg/cnt), b: Math.round(sb/cnt) });
    }
    for (const u of upd) { cells[u.i].r = u.r; cells[u.i].g = u.g; cells[u.i].b = u.b; cells[u.i].active = true; }
  }

  return { cols, rows, cells };
}

// 3. Contrast stretch + saturation boost (HSL)
//    Camera correction applied first (×CAMERA_CORRECTION) so the stretch
//    operates on perceptually correct values.
function _enhanceGrid(grid) {
  if (!grid) return null;
  const active = grid.cells.filter(c => c.active);
  if (active.length === 0) return grid;

  // Compute luma range of corrected active cells
  let minL = 1, maxL = 0;
  for (const c of active) {
    const l = _luma(
      Math.min(255, c.r * CAMERA_CORRECTION),
      Math.min(255, c.g * CAMERA_CORRECTION),
      Math.min(255, c.b * CAMERA_CORRECTION),
    );
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }
  const lumaRange = maxL - minL;
  const hasRange  = lumaRange > 0.03;

  const cells = grid.cells.map(c => {
    if (!c.active) return c;

    // Camera correction
    const cr = Math.min(255, c.r * CAMERA_CORRECTION);
    const cg = Math.min(255, c.g * CAMERA_CORRECTION);
    const cb = Math.min(255, c.b * CAMERA_CORRECTION);

    const { h, s, l } = _rgbToHsl(cr, cg, cb);

    // Contrast stretch: remap luma into [CONTRAST_L_MIN, CONTRAST_L_MAX]
    const newL = hasRange
      ? CONTRAST_L_MIN + ((l - minL) / lumaRange) * (CONTRAST_L_MAX - CONTRAST_L_MIN)
      : (CONTRAST_L_MIN + CONTRAST_L_MAX) / 2; // uniform region → push to comfortable mid-tone

    // Saturation boost — non-grays get vivid; near-achromatic stays neutral
    const newS = Math.min(1.0, s * SAT_BOOST);

    const [r, g, b] = _hslToRgb(h, newS, newL);
    return { ...c, r, g, b };
  });

  return { cols: grid.cols, rows: grid.rows, cells };
}

// 4. Conditional bilateral symmetry
//    First measure average RGB distance between mirror-pair cells.
//    Only apply mirror-average when that distance is below SYMMETRY_THRESHOLD —
//    meaning the garment is already roughly symmetric (plain shirt, simple pattern)
//    and any asymmetry is likely lighting noise, not intentional design.
//    If the distance is above the threshold (single pocket, asymmetric print,
//    side stripe, etc.) the grid is returned unchanged.
const SYMMETRY_THRESHOLD = 28; // avg mirror-pair RGB distance that triggers correction

function _makeSymmetric(grid) {
  if (!grid) return null;
  const { cols, rows } = grid;
  const half = Math.floor(cols / 2);

  // Measure how symmetric the garment already is
  let totalDist = 0, pairs = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < half; col++) {
      const lc = grid.cells[row * cols + col];
      const rc = grid.cells[row * cols + (cols - 1 - col)];
      if (!lc.active || !rc.active) continue;
      totalDist += Math.hypot(lc.r - rc.r, lc.g - rc.g, lc.b - rc.b);
      pairs++;
    }
  }

  // Not enough overlapping pairs or design is clearly asymmetric → keep original
  if (pairs === 0 || totalDist / pairs > SYMMETRY_THRESHOLD) return grid;

  // Left ↔ right are similar enough: mirror-average to clean up lighting asymmetry
  const cells = grid.cells.map(c => ({ ...c }));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < half; col++) {
      const li = row * cols + col;
      const ri = row * cols + (cols - 1 - col);
      const lc = cells[li], rc = cells[ri];
      if (lc.active && rc.active) {
        const r = (lc.r + rc.r) >> 1;
        const g = (lc.g + rc.g) >> 1;
        const b = (lc.b + rc.b) >> 1;
        cells[li] = { ...lc, r, g, b };
        cells[ri] = { ...rc, r, g, b };
      } else if (lc.active) {
        cells[ri] = { active: true, r: lc.r, g: lc.g, b: lc.b };
      } else if (rc.active) {
        cells[li] = { active: true, r: rc.r, g: rc.g, b: rc.b };
      }
    }
  }
  return { cols, rows, cells };
}

// ─── Solid-color enhancement (for arms / no-grid fallback) ───────────────────

function _enhanceSolid({ r, g, b }) {
  const cr = Math.min(255, r * CAMERA_CORRECTION);
  const cg = Math.min(255, g * CAMERA_CORRECTION);
  const cb = Math.min(255, b * CAMERA_CORRECTION);
  const { h, s, l } = _rgbToHsl(cr, cg, cb);
  const newS = Math.min(1.0, s * SAT_BOOST);
  // Push dark solids to a minimum visible lightness
  const newL = Math.max(CONTRAST_L_MIN + 0.05, Math.min(CONTRAST_L_MAX - 0.05, l * 1.25));
  return _hslToRgb(h, newS, newL);
}

// ─── HSL utilities ────────────────────────────────────────────────────────────

function _luma(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h, s, l };
}

function _hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(p, q, h + 1/3) * 255),
    Math.round(hue(p, q, h)       * 255),
    Math.round(hue(p, q, h - 1/3) * 255),
  ];
}

// ─── Drawing helper ───────────────────────────────────────────────────────────

function _legoHand(s, col, outlineColor) {
  fill(col); stroke(outlineColor); strokeWeight(2 * s);
  const rIn = 5 * s, rOut = 10 * s;
  beginShape();
  for (let a = 180; a <= 360; a += 10) vertex(rOut * cos(radians(a)), rOut * sin(radians(a)));
  for (let a = 360; a >= 180; a -= 10) vertex(rIn  * cos(radians(a)), rIn  * sin(radians(a)));
  endShape(CLOSE);
}
