// PersonaFlow – legacy solid-colour／full-character p5.js theme.
// Formal brick_ai_texture results are rendered exclusively by Three.js.

// ─── Tuning knobs ────────────────────────────────────────────────────────────
const CAMERA_CORRECTION  = 1.18; // compensates for camera underexposure
const SAT_BOOST          = 1.6;  // saturation multiplier (HSL)
const CONTRAST_L_MIN     = 0.20; // after stretch: darkest active cell → this luma
const CONTRAST_L_MAX     = 0.82; // after stretch: brightest active cell → this luma

// ─── Public entry point ──────────────────────────────────────────────────────

function drawLegoCharacter(person) {
  const s = 1.5;
  const usesProgrammaticRig = person.renderMode === 'body_sprite';
  const torsoScaleY = usesProgrammaticRig ? (Number(person.heightProfile?.torso_scale_y) || 1) : 1;
  const legScaleY = usesProgrammaticRig ? (Number(person.heightProfile?.leg_scale_y) || 1) : 1;

  // ── Geometry ────────────────────────────────────────────────────
  const tTop   = 38 * s, tBottom = 50 * s, torsoH = 50 * s * torsoScaleY;
  const legW   = 21 * s, legH    = 38 * s * legScaleY, footH  = 10 * s, legGap = 2 * s;
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

  // ── Walking animation state ──────────────────────────────────────
  const vx    = (person.vel && person.vel.x) || 0;
  const vy    = (person.vel && person.vel.y) || 0;
  const speed = Math.hypot(vx, vy);
  const isWalking    = speed > 0.3;
  const isMovingRight = vx >= 0;
  if (isWalking) person.walkPhase = ((person.walkPhase || 0) + speed * 0.12);
  const wp     = person.walkPhase || 0;
  const swing  = isWalking ? Math.sin(wp) : 0;
  const armDeg = 22 * swing;   // arm swing in degrees
  const legDeg = 20 * swing;   // leg swing in degrees
  const leftFront = isMovingRight; // left limbs closer to viewer when moving right
  const bounce = isWalking ? Math.abs(Math.sin(wp)) * 3 * s : 0;

  // Limb angles: arms counter-swing relative to same-side leg (natural gait)
  // Positive rotation = clockwise in p5, pivot at limb top
  const lArmDeg =  armDeg;  // left arm forward when swing > 0
  const rArmDeg = -armDeg;  // right arm backward when swing > 0
  const lLegDeg = -legDeg;  // left leg backward when swing > 0
  const rLegDeg =  legDeg;  // right leg forward when swing > 0

  // ── Solid colors for the legacy renderer ────────────────────────
  const [br, bg2, bb] = _enhanceSolid(person.innerColor);
  const [lr, lg,  lb] = _enhanceSolid(person.lowerColor);
  const bodyColor = color(br, bg2, bb);
  const legColor  = color(lr, lg,  lb);
  // Detected skin tone (VLM), falls back to default when unavailable
  const skinColor = person.skinColor 
    ? color(person.skinColor.r, person.skinColor.g, person.skinColor.b) 
    : color(255, 204, 0);

  const hasOuter  = person.outerType && person.outerType !== 'none' && person.outerColor;
  const armSource = person.armColor || (hasOuter ? person.outerColor : person.innerColor);
  const [ar, ag, ab] = _enhanceSolid(armSource);
  const armColor  = color(ar, ag, ab);
  // Darker variants for back limbs (depth illusion, same as boids_concept.html)
  const armColorDk = color(Math.round(ar * 0.6), Math.round(ag * 0.6), Math.round(ab * 0.6));
  const legColorDk = color(Math.round(lr * 0.6), Math.round(lg * 0.6), Math.round(lb * 0.6));

  const armOutline  = _luma(ar, ag, ab) < 0.42 ? color(205, 205, 205) : color(0);
  const bodyOutline = _luma(br, bg2, bb) < 0.42 ? color(205, 205, 205) : color(0);
  const legOutline  = _luma(lr, lg,  lb) < 0.42 ? color(205, 205, 205) : color(0);

  strokeJoin(ROUND); strokeCap(ROUND);
  strokeWeight(2 * s);
  rectMode(CENTER);

  // ══ FULL-CHARACTER MODE — the AI sprite IS the entire figure (head→feet).
  //     Skip every programmatic LEGO part; just draw the sprite at full
  //     character height. T-pose / front view, so future skeletal rigging
  //     can hang a rig over this image directly.
  const bodySpriteReady = person.bodySprite && person.bodySprite.width > 0;
  if (bodySpriteReady && (person.renderMode === 'full_character' || person.renderMode === 'full_character_refined')) {
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

  // ── Limb draw helpers (closures over geometry/colors above) ─────

  // Draw one arm: pivotX = shoulder X, deg = rotation in degrees,
  // fc/oc = fill/outline colors, isLeft = left vs right geometry
  const _drawArm = (pivotX, deg, fc, oc, isLeft) => {
    push();
    translate(pivotX, shldY);
    rotate(radians(deg));
    fill(fc); stroke(oc); rectMode(CORNER);
    if (isLeft) {
      rect(-aW, 0, aW, aL, 5 * s);
      translate(-aW / 2, aL + 5 * s);
    } else {
      rect(0, 0, aW, aL, 5 * s);
      translate(aW / 2, aL + 5 * s);
    }
    _legoHand(s, skinColor, oc);
    pop();
  };

  // Draw one leg: pivotX = hip X, deg = rotation, fc/oc = fill/outline
  const _drawLeg = (pivotX, deg, fc, oc) => {
    push();
    translate(pivotX, legTop);
    rotate(radians(deg));
    fill(fc); stroke(oc); rectMode(CENTER);
    rect(0, legH / 2, legW, legH);
    rect(0, legH + footH / 2, legW + 2 * s, footH, 2 * s);
    pop();
  };

  // ── Apply body bounce, then draw in depth order ──────────────────
  push();
  translate(0, -bounce);

  if (isWalking) {
    // ── Depth-sorted walk: back arm → back leg → torso → front leg → front arm ──

    if (leftFront) {
      // Right side is back
      _drawArm(tTop / 2, rArmDeg, armColorDk, armOutline, false);
      _drawLeg(rLegCx,   rLegDeg, legColorDk, legOutline);
    } else {
      // Left side is back
      _drawArm(-tTop / 2, lArmDeg, armColorDk, armOutline, true);
      _drawLeg(lLegCx,    lLegDeg, legColorDk, legOutline);
    }

    // Torso
    fill(bodyColor); stroke(bodyOutline);
    beginShape();
    for (const [px, py] of torsoPoly) vertex(px, py);
    endShape(CLOSE);
    noFill(); stroke(bodyOutline);
    beginShape();
    for (const [px, py] of torsoPoly) vertex(px, py);
    endShape(CLOSE);

    if (leftFront) {
      // Left side is front
      _drawLeg(lLegCx,    lLegDeg, legColor, legOutline);
      _drawArm(-tTop / 2, lArmDeg, armColor, armOutline, true);
    } else {
      // Right side is front
      _drawLeg(rLegCx,   rLegDeg, legColor, legOutline);
      _drawArm(tTop / 2, rArmDeg, armColor, armOutline, false);
    }

  } else {
    // ── Static pose: original draw order (both legs behind torso) ───

    fill(legColor); stroke(legOutline);
    rect(lLegCx, legTop + legH / 2, legW, legH);
    rect(rLegCx, legTop + legH / 2, legW, legH);
    rect(lLegCx, legTop + legH + footH / 2, legW + 2 * s, footH, 2 * s);
    rect(rLegCx, legTop + legH + footH / 2, legW + 2 * s, footH, 2 * s);

    fill(bodyColor); stroke(bodyOutline);
    beginShape();
    for (const [px, py] of torsoPoly) vertex(px, py);
    endShape(CLOSE);
    noFill(); stroke(bodyOutline);
    beginShape();
    for (const [px, py] of torsoPoly) vertex(px, py);
    endShape(CLOSE);
    stroke(legOutline);
    rect(lLegCx, legTop + legH / 2, legW, legH);
    rect(rLegCx, legTop + legH / 2, legW, legH);

    // Static arms at fixed angles
    _drawArm(-tTop / 2,  15, armColor, armOutline, true);
    _drawArm( tTop / 2, -15, armColor, armOutline, false);
  }

  // ── Head (always on top) ─────────────────────────────────────────
  fill(skinColor); stroke(0); rectMode(CENTER);
  rect(0, -torsoH / 2 - 2 * s, 16 * s, 4 * s); // neck

  push();
  if (!isMovingRight) scale(-1, 1); // flip head to face movement direction
  rect(0, headY, headS * 1.1, headS, 8 * s);
  rect(0, headY - headS / 2 - 3 * s, 18 * s, 7 * s, 2 * s);
  fill(0); noStroke();
  circle(-7 * s, headY - 2 * s, 5 * s);
  circle( 7 * s, headY - 2 * s, 5 * s);
  noFill(); stroke(0); strokeWeight(2 * s);
  const smileW = (14 + (person.smileScore || 0) * 8) * s;
  const smileH = ( 8 + (person.smileScore || 0) * 4) * s;
  arc(0, headY + 7 * s, smileW, smileH, 0, PI);
  pop();

  pop(); // end bounce translate

  rectMode(CENTER);
}

// ─── Grid pipeline (removed) ────────────────────────────────────────────────
// _filterShirtFromLower / _filterHairCells / _clusterGrid / _enhanceGrid /
// _makeSymmetric 連同繪製它們的 _drawClothGrid 一併移除。這個主題自 2026-08
// 起只畫 AI 生成的完整角色 sprite（見上方 FULL-CHARACTER MODE），格柵已無消費者。
// 投影牆的格柵是 projection.html 內另一套 PIXI 實作，與此處無關。

// ─── Solid-color enhancement (for arms / no-grid fallback) ───────────────────

function _enhanceSolid({ r, g, b }) {
  const origLuma = _luma(r, g, b);
  const cr = Math.min(255, r * CAMERA_CORRECTION);
  const cg = Math.min(255, g * CAMERA_CORRECTION);
  const cb = Math.min(255, b * CAMERA_CORRECTION);
  const { h, s, l } = _rgbToHsl(cr, cg, cb);

  let newS, newL;
  if (origLuma < 0.12) {
    // Near-black: stay dark, kill camera blue-bias
    newS = Math.min(s, 0.07);
    newL = Math.max(0.06, Math.min(0.38, l * 1.2));
  } else if (origLuma > 0.60) {
    // Near-white/cream: stay bright, no saturation boost
    newS = s;
    newL = Math.max(0.60, Math.min(0.93, l * 1.05));
  } else {
    // Mid-tone: boost saturation + push to comfortable visible range
    const satScale = Math.min(1.0, s / 0.22);
    newS = Math.min(1.0, s * (1 + (SAT_BOOST - 1) * satScale));
    newL = Math.max(CONTRAST_L_MIN + 0.05, Math.min(CONTRAST_L_MAX - 0.05, l * 1.25));
  }
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

if (window.PersonaFlowThemes) {
  window.PersonaFlowThemes.register('lego', {
    draw: drawLegoCharacter,
    baseFootAnchor: 109.5,
    footAnchor(person) {
      const modeOne = person.renderMode === 'body_sprite';
      const torso = modeOne ? (Number(person.heightProfile?.torso_scale_y) || 1) : 1;
      const legs = modeOne ? (Number(person.heightProfile?.leg_scale_y) || 1) : 1;
      return (25 * 1.5 * torso) + (38 * 1.5 * legs) + (10 * 1.5);
    },
    accessoryOptions: { hatY: -96, handYBoost: 22 },
    supportedModes: ['body_sprite', 'full_character'],
  });
}
