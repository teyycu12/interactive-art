(function () {
  'use strict';

  const THREE = window.THREE;
  if (!THREE) {
    console.error('[brick-v2-model] Three.js is not available');
    return;
  }

  const safeColor = (value, fallback) =>
    /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;

  const bounded = (value, low, high, fallback = 1) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };

  // Mirrors STYLE_BASE["materials"] in backend/style_base.py, measured from
  // docs/style_reference/base_character.png. A single global roughness cannot
  // reproduce the reference: its hair highlight is a sharp streak while the
  // skin falls off broadly and the denim is almost matte. This spread is the
  // largest visual gap between the render and the reference.
  const SPECIES_MATERIALS = {
    hair: { roughness: 0.18, clearcoat: 0.55 },
    garment_print: { roughness: 0.22, clearcoat: 0.50 },
    skin: { roughness: 0.34, clearcoat: 0.42 },
    rubber: { roughness: 0.38, clearcoat: 0.30 },
    denim: { roughness: 0.52, clearcoat: 0.12 },
  };

  function speciesMaterial(className, color) {
    const preset = SPECIES_MATERIALS[className] || SPECIES_MATERIALS.skin;
    return new THREE.MeshPhysicalMaterial({
      color: safeColor(color, '#808080'),
      roughness: preset.roughness,
      metalness: 0.01,
      clearcoat: preset.clearcoat,
      clearcoatRoughness: 0.2,
    });
  }

  function plastic(color, roughness = 0.3) {
    return new THREE.MeshPhysicalMaterial({
      color: safeColor(color, '#808080'),
      roughness,
      metalness: 0.01,
      clearcoat: 0.42,
      clearcoatRoughness: 0.2,
    });
  }

  async function loadTexture(source, renderer) {
    if (!String(source || '').startsWith('data:image/')) throw new Error('brick_v2_texture_missing');
    try {
      const texture = await new THREE.TextureLoader().loadAsync(source);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return texture;
    } catch (error) {
      throw new Error('brick_v2_texture_load_failed');
    }
  }

  function mesh(geometry, material, parent, position = {}) {
    const item = new THREE.Mesh(geometry, material);
    item.position.set(position.x || 0, position.y || 0, position.z || 0);
    item.castShadow = true;
    item.receiveShadow = true;
    parent.add(item);
    return item;
  }

  function roundedRectShape(width, height, radius) {
    const x = -width / 2, y = -height / 2;
    const shape = new THREE.Shape();
    shape.moveTo(x + radius, y);
    shape.lineTo(x + width - radius, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + radius);
    shape.lineTo(x + width, y + height - radius);
    shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    shape.lineTo(x + radius, y + height);
    shape.quadraticCurveTo(x, y + height, x, y + height - radius);
    shape.lineTo(x, y + radius);
    shape.quadraticCurveTo(x, y, x + radius, y);
    return shape;
  }

  function roundedTaperedShape(topWidth, bottomWidth, height, radius) {
    const top = height / 2, bottom = -height / 2;
    const topHalf = topWidth / 2, bottomHalf = bottomWidth / 2;
    const r = Math.min(radius, topWidth / 4, bottomWidth / 4, height / 4);
    const shape = new THREE.Shape();
    shape.moveTo(-bottomHalf + r, bottom);
    shape.lineTo(bottomHalf - r, bottom);
    shape.quadraticCurveTo(bottomHalf, bottom, bottomHalf, bottom + r);
    shape.lineTo(topHalf, top - r);
    shape.quadraticCurveTo(topHalf, top, topHalf - r, top);
    shape.lineTo(-topHalf + r, top);
    shape.quadraticCurveTo(-topHalf, top, -topHalf, top - r);
    shape.lineTo(-bottomHalf, bottom + r);
    shape.quadraticCurveTo(-bottomHalf, bottom, -bottomHalf + r, bottom);
    return shape;
  }

  function separateFrontSurface(source, depth) {
    const geometry = source.index ? source.toNonIndexed() : source;
    geometry.computeVertexNormals();
    const attributes = ['position', 'normal', 'uv'];
    const buckets = [Object.fromEntries(attributes.map(name => [name, []])), Object.fromEntries(attributes.map(name => [name, []]))];
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    for (let start = 0; start < position.count; start += 3) {
      let averageZ = 0, averageNormalZ = 0;
      for (let offset = 0; offset < 3; offset++) {
        averageZ += position.getZ(start + offset) / 3;
        averageNormalZ += normal.getZ(start + offset) / 3;
      }
      const materialIndex = averageZ > depth * 0.28 && averageNormalZ > 0.22 ? 0 : 1;
      for (let offset = 0; offset < 3; offset++) {
        const index = start + offset;
        buckets[materialIndex].position.push(position.getX(index), position.getY(index), position.getZ(index));
        buckets[materialIndex].normal.push(normal.getX(index), normal.getY(index), normal.getZ(index));
        const uv = geometry.getAttribute('uv');
        buckets[materialIndex].uv.push(uv.getX(index), uv.getY(index));
      }
    }
    const result = new THREE.BufferGeometry();
    const positions = [...buckets[0].position, ...buckets[1].position];
    const normals = [...buckets[0].normal, ...buckets[1].normal];
    const uvs = [...buckets[0].uv, ...buckets[1].uv];
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    result.addGroup(0, buckets[0].position.length / 3, 0);
    result.addGroup(buckets[0].position.length / 3, buckets[1].position.length / 3, 1);
    if (source !== geometry) geometry.dispose();
    source.dispose();
    return result;
  }

  function extrudeSurfaceGeometry(shape, widthAtY, height, depth, bevel) {
    const uvGenerator = {
      generateTopUV(_geometry, vertices, a, b, c) {
        return [a, b, c].map(index => {
          const y = vertices[index * 3 + 1];
          const width = Math.max(0.01, widthAtY(y));
          return new THREE.Vector2(vertices[index * 3] / width + 0.5, y / height + 0.5);
        });
      },
      generateSideWallUV(_geometry, vertices, a, b, c, d) {
        return [a, b, c, d].map(index => new THREE.Vector2(
          vertices[index * 3] / Math.max(0.01, widthAtY(vertices[index * 3 + 1])) + 0.5,
          vertices[index * 3 + 1] / height + 0.5,
        ));
      },
    };
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 8,
      steps: 1,
      UVGenerator: uvGenerator,
    });
    geometry.translate(0, 0, -depth / 2);
    return separateFrontSurface(geometry, depth);
  }

  function roundedExtrudeGeometry(width, height, depth, radius, bevel = 0.05) {
    return extrudeSurfaceGeometry(roundedRectShape(width, height, radius), () => width, height, depth, bevel);
  }

  function roundedTaperedExtrudeGeometry(topWidth, bottomWidth, height, depth, radius, bevel = 0.05) {
    const widthAtY = y => {
      const ratio = Math.max(0, Math.min(1, y / height + 0.5));
      return bottomWidth + (topWidth - bottomWidth) * ratio;
    };
    return extrudeSurfaceGeometry(
      roundedTaperedShape(topWidth, bottomWidth, height, radius),
      widthAtY,
      height,
      depth,
      bevel,
    );
  }

  function curvedFaceGeometry(radius = 0.797, height = 0.80, angle = 1.42, segments = 28) {
    const positions = [], normals = [], uvs = [], indices = [];
    for (let index = 0; index <= segments; index++) {
      const u = index / segments;
      const theta = (u - 0.5) * angle;
      const x = Math.sin(theta) * radius;
      const z = Math.cos(theta) * radius;
      for (const v of [0, 1]) {
        positions.push(x, (v - 0.5) * height, z);
        normals.push(Math.sin(theta), 0, Math.cos(theta));
        uvs.push(u, v);
      }
      if (index < segments) {
        const base = index * 2;
        indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  function addCHand(parent, material, side) {
    const group = new THREE.Group();
    group.position.set(side * 0.14, -1.31, 0);
    parent.add(group);
    mesh(new THREE.CylinderGeometry(0.13, 0.145, 0.24, 20), material, group, { y: -0.02 });
    const opening = Math.PI * 0.54;
    const claw = mesh(
      new THREE.TorusGeometry(0.255, 0.082, 12, 32, Math.PI * 2 - opening),
      material,
      group,
      { y: -0.31 },
    );
    claw.rotation.z = opening / 2 + (side < 0 ? 0 : Math.PI);
    return group;
  }

  function addHairLock(parent, material, options) {
    const radius = options.radius || 0.16;
    const length = Math.max(0.04, options.length || 0.42);
    const lock = mesh(
      new THREE.CapsuleGeometry(radius, length, 7, 14),
      material,
      parent,
      { x: options.x || 0, y: options.y || 0, z: options.z || 0 },
    );
    lock.rotation.set(options.rx || 0, options.ry || 0, options.rz || 0);
    lock.scale.set(options.sx || 1, options.sy || 1, options.sz || 1);
    return lock;
  }

  function hairShellGeometry(radius, options = {}) {
    const radialSegments = 48, verticalSegments = 18;
    const frontCoverage = Math.PI * bounded(options.front_coverage, 0.44, 0.56, 0.50);
    const backCoverage = Math.PI * bounded(options.back_coverage, 0.62, 0.88, 0.76);
    const partAngle = bounded(options.part_position, -0.55, 0.55, 0) * 0.72;
    const positions = [], normals = [], uvs = [], indices = [];
    for (let radial = 0; radial <= radialSegments; radial++) {
      const u = radial / radialSegments;
      const theta = u * Math.PI * 2;
      const frontness = (Math.cos(theta) + 1) / 2;
      let phiMax = backCoverage + (frontCoverage - backCoverage) * Math.pow(frontness, 1.6);
      const wrapped = Math.atan2(Math.sin(theta - partAngle), Math.cos(theta - partAngle));
      phiMax -= Math.PI * 0.055 * Math.exp(-(wrapped * wrapped) / 0.035);
      for (let vertical = 0; vertical <= verticalSegments; vertical++) {
        const v = vertical / verticalSegments;
        const phi = phiMax * v;
        const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
        const x = Math.sin(theta) * sinPhi * radius;
        const y = cosPhi * radius;
        const z = Math.cos(theta) * sinPhi * radius * 0.97;
        positions.push(x, y, z);
        const normal = new THREE.Vector3(x, y, z / 0.97).normalize();
        normals.push(normal.x, normal.y, normal.z);
        uvs.push(u, 1 - v);
        if (radial < radialSegments && vertical < verticalSegments) {
          const row = verticalSegments + 1;
          const a = radial * row + vertical;
          const b = (radial + 1) * row + vertical;
          indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  function addModularHair(hairMount, hairSpec, material) {
    const style = String(hairSpec?.style || 'short').toLowerCase();
    if (style === 'bald') return;
    const volume = bounded(hairSpec?.volume, 0.88, 1.16, 1);
    const wave = bounded(hairSpec?.wave_amount, 0, 1, /wave|curl/.test(style) ? 0.65 : 0.15);
    const long = /long/.test(style);
    const medium = long || /bob|medium|wave|curl/.test(style);
    const cap = mesh(
      hairShellGeometry(0.82 * volume, {
        front_coverage: 0.49,
        back_coverage: long ? 0.86 : (medium ? 0.76 : 0.65),
        part_position: hairSpec?.part_position,
      }),
      material,
      hairMount,
      { y: 0.12 },
    );
    cap.userData.part = 'hair_shell';

    if (medium) {
      const sideLength = bounded(hairSpec?.side_length, 0.45, 1.18, long ? 1.02 : 0.64);
      for (const side of [-1, 1]) {
        addHairLock(hairMount, material, {
          x: side * 0.73 * volume,
          y: -0.14 - sideLength * 0.20,
          z: 0.05,
          radius: (0.19 + wave * 0.035) * volume,
          length: sideLength,
          rz: side * (0.08 + wave * 0.08),
          sz: 0.86,
        });
      }
      const backLength = bounded(hairSpec?.back_length, 0.30, 1.30, long ? 1.10 : 0.55);
      for (const offset of [-0.52, -0.26, 0, 0.26, 0.52]) {
        addHairLock(hairMount, material, {
          x: offset * volume,
          y: -0.18 - backLength * 0.28,
          z: -0.64,
          radius: (0.17 + wave * 0.025) * volume,
          length: backLength,
          rx: -0.06,
          rz: offset * wave * 0.12,
          sz: 0.86,
        });
      }
    }

    if (/curl/.test(style)) {
      for (const side of [-1, 1]) {
        for (let index = 0; index < 3; index++) {
          mesh(
            new THREE.SphereGeometry((0.20 - index * 0.018) * volume, 16, 12),
            material,
            hairMount,
            { x: side * (0.68 + index * 0.015), y: 0.05 - index * 0.30, z: 0.22 - index * 0.05 },
          );
        }
      }
    }
    if (/bun/.test(style)) {
      mesh(new THREE.SphereGeometry(0.38 * volume, 24, 16), material, hairMount, { y: 0.75, z: -0.28 });
    }
    if (/ponytail/.test(style)) {
      addHairLock(hairMount, material, { y: -0.18, z: -0.86, radius: 0.25 * volume, length: 0.68, rx: -0.22 });
    }
  }

  async function buildCharacter(spec, renderer) {
    if (!spec || spec.style_id !== 'brick_v2') throw new Error('invalid_brick_v2_spec');
    if (spec.quality?.ai_texture_status !== 'enhanced') throw new Error('brick_v2_ai_print_not_enhanced');
    const required = ['face_decal', 'torso_front', 'left_leg_front', 'right_leg_front'];
    if (required.some(key => !String(spec.textures?.[key] || '').startsWith('data:image/'))) {
      throw new Error('brick_v2_print_atlas_incomplete');
    }

    const outfit = spec.outfit || {};
    const shape = spec.body_shape || {};
    const garment = spec.garment_geometry || {
      sleeve_profile: 'short', lower_shell: 'trousers', legwear: 'covered', outer_shell: 'none', fit: 'regular', attachments: [],
    };
    const root = new THREE.Group();
    const visual = new THREE.Group();
    root.add(visual);
    const skin = speciesMaterial('skin', spec.skin_color || '#FFD0A8');
    const upper = speciesMaterial('garment_print', outfit.upper_color || '#607D8B');
    const lower = speciesMaterial('denim', outfit.lower_color || '#263238');
    const shoe = speciesMaterial('rubber', outfit.shoe_color || '#F2F2F0');
    const sole = speciesMaterial('rubber', '#D7D9DA');
    const heightScale = bounded(shape.height_scale, 0.90, 1.10);
    const torsoScale = bounded(shape.torso_width, 0.90, 1.10);
    const shoulderScale = bounded(shape.shoulder_width, 0.92, 1.08);
    const limbScale = bounded(shape.limb_thickness, 0.94, 1.08);
    const fitScale = garment.fit === 'relaxed' ? 1.06 : (garment.fit === 'slim' ? 0.96 : 1);
    const renderedTorsoScale = torsoScale * fitScale;
    visual.scale.y = heightScale;

    const [torsoTexture, leftLegTexture, rightLegTexture, faceTexture] = await Promise.all([
      loadTexture(spec.textures.torso_front, renderer),
      loadTexture(spec.textures.left_leg_front, renderer),
      loadTexture(spec.textures.right_leg_front, renderer),
      loadTexture(spec.textures.face_decal, renderer),
    ]);
    const printMaterial = (texture, className = 'garment_print') => new THREE.MeshStandardMaterial({
      map: texture,
      roughness: (SPECIES_MATERIALS[className] || SPECIES_MATERIALS.garment_print).roughness,
      metalness: 0.0,
    });

    const torso = mesh(
      roundedTaperedExtrudeGeometry(1.84 * renderedTorsoScale, 1.62 * renderedTorsoScale, 1.54, 0.78, 0.10, 0.045),
      [printMaterial(torsoTexture), upper],
      visual,
      { y: 2.87 },
    );
    torso.userData.part = 'torso';

    const head = mesh(
      new THREE.CylinderGeometry(0.79, 0.79, 1.15, 32, 1, false),
      skin,
      visual,
      { y: 4.32 },
    );
    head.userData.part = 'head';
    const faceMaterial = new THREE.MeshStandardMaterial({
      map: faceTexture,
      roughness: SPECIES_MATERIALS.skin.roughness,
      metalness: 0,
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const facePrint = mesh(curvedFaceGeometry(), faceMaterial, visual, { y: 4.29 });
    facePrint.renderOrder = 2;
    facePrint.userData.part = 'face_print';
    if (String(spec.hair?.style || 'short').toLowerCase() === 'bald') {
      const topBevel = mesh(new THREE.TorusGeometry(0.72, 0.075, 8, 32), skin, visual, { y: 4.88 });
      topBevel.rotation.x = Math.PI / 2;
    }
    const bottomBevel = mesh(new THREE.TorusGeometry(0.72, 0.075, 8, 32), skin, visual, { y: 3.76 });
    bottomBevel.rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.18, 24), skin, visual, { y: 3.72 });
    mesh(roundedExtrudeGeometry(1.68 * renderedTorsoScale, 0.36, 0.74, 0.06, 0.025), [lower, lower], visual, { y: 1.93 });

    const attachments = new Set(garment.attachments || []);
    if (attachments.has('hood')) {
      const hood = mesh(new THREE.TorusGeometry(0.52, 0.15, 12, 30, Math.PI * 1.55), upper, visual, { y: 3.78, z: -0.30 });
      hood.rotation.z = Math.PI * 0.72;
      hood.userData.part = 'hood';
    }
    if (attachments.has('coat_tail')) {
      const coat = mesh(
        roundedTaperedExtrudeGeometry(1.58 * renderedTorsoScale, 1.76 * renderedTorsoScale, 0.92, 0.80, 0.08, 0.04),
        [upper, upper],
        visual,
        { y: 1.70, z: 0.015 },
      );
      coat.userData.part = 'coat_tail';
    }
    if (attachments.has('skirt_shell')) {
      const skirtMaterial = garment.lower_shell === 'dress_skirt' ? upper : lower;
      const skirt = mesh(
        roundedTaperedExtrudeGeometry(1.50 * renderedTorsoScale, 1.88 * renderedTorsoScale, 0.92, 0.80, 0.08, 0.04),
        [skirtMaterial, skirtMaterial],
        visual,
        { y: 1.63, z: 0.02 },
      );
      skirt.userData.part = 'skirt_shell';
    }

    const limbs = {};
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 1.02 * shoulderScale * fitScale, 3.50, 0);
      arm.rotation.z = side * -THREE.MathUtils.degToRad(7);
      visual.add(arm);
      limbs[side < 0 ? 'leftArm' : 'rightArm'] = arm;
      const armPart = side < 0 ? 'left_arm' : 'right_arm';
      if (garment.sleeve_profile === 'short') {
        const sleeve = mesh(
          roundedTaperedExtrudeGeometry(0.48 * limbScale, 0.41 * limbScale, 0.56, 0.50 * limbScale, 0.10, 0.03),
          [upper, upper], arm, { y: -0.25 },
        );
        const forearm = mesh(
          roundedTaperedExtrudeGeometry(0.39 * limbScale, 0.34 * limbScale, 0.74, 0.47 * limbScale, 0.10, 0.03),
          [skin, skin], arm, { y: -0.89 },
        );
        sleeve.userData.part = `${armPart}_sleeve`;
        forearm.userData.part = `${armPart}_forearm`;
      } else {
        const armMaterial = garment.sleeve_profile === 'sleeveless' ? skin : upper;
        const armMesh = mesh(
          roundedTaperedExtrudeGeometry(0.48 * limbScale, 0.34 * limbScale, 1.30, 0.50 * limbScale, 0.11, 0.035),
          [armMaterial, armMaterial], arm, { y: -0.62 },
        );
        armMesh.userData.part = armPart;
      }
      addCHand(arm, skin, side);

      const leg = new THREE.Group();
      leg.position.set(side * 0.405 * torsoScale, 1.90, 0);
      visual.add(leg);
      limbs[side < 0 ? 'leftLeg' : 'rightLeg'] = leg;
      const legTexture = side < 0 ? leftLegTexture : rightLegTexture;
      const legPart = side < 0 ? 'left_leg' : 'right_leg';
      if (garment.lower_shell === 'shorts') {
        const shorts = mesh(
          roundedExtrudeGeometry(0.72 * limbScale, 0.64, 0.72, 0.07, 0.03),
          [printMaterial(legTexture, 'denim'), lower], leg, { y: -0.31 },
        );
        const lowerLeg = mesh(
          roundedExtrudeGeometry(0.70 * limbScale, 0.76, 0.70, 0.07, 0.03),
          [skin, skin], leg, { y: -1.03 },
        );
        shorts.userData.part = `${legPart}_shorts`;
        lowerLeg.userData.part = `${legPart}_skin`;
      } else if (['skirt', 'dress_skirt'].includes(garment.lower_shell)) {
        const legMaterial = garment.legwear === 'bare' ? skin : lower;
        const visibleLeg = mesh(
          roundedExtrudeGeometry(0.70 * limbScale, 0.78, 0.70, 0.07, 0.03),
          [legMaterial, legMaterial], leg, { y: -1.03 },
        );
        visibleLeg.userData.part = `${legPart}_${garment.legwear || 'bare'}`;
      } else {
        const legMesh = mesh(
          roundedExtrudeGeometry(0.72 * limbScale, 1.38, 0.72, 0.07, 0.035),
          [printMaterial(legTexture, 'denim'), lower], leg, { y: -0.73 },
        );
        legMesh.userData.part = legPart;
      }
      const shoeGroup = new THREE.Group();
      shoeGroup.position.set(0, -1.59, 0.15);
      leg.add(shoeGroup);
      mesh(roundedExtrudeGeometry(0.78, 0.34, 1.02, 0.12, 0.05), [shoe, shoe], shoeGroup, { y: 0 });
      mesh(roundedExtrudeGeometry(0.80, 0.09, 1.05, 0.04, 0.02), [sole, sole], shoeGroup, { y: -0.235 });
    }

    const hairMount = new THREE.Group();
    hairMount.name = 'hair_mount';
    hairMount.position.set(0, 4.32, 0);
    visual.add(hairMount);
    const hairMaterial = new THREE.MeshPhysicalMaterial({
      color: safeColor(spec.hair?.color, '#3B2314'),
      roughness: SPECIES_MATERIALS.hair.roughness,
      metalness: 0.0,
      clearcoat: SPECIES_MATERIALS.hair.clearcoat,
      clearcoatRoughness: 0.18,
    });
    addModularHair(hairMount, spec.hair || {}, hairMaterial);
    root.userData.hairMount = hairMount;
    root.userData.visual = visual;
    root.userData.limbs = limbs;
    return root;
  }

  function disposeCharacter(root) {
    const disposedMaterials = new Set();
    root.traverse(item => {
      if (item.geometry) item.geometry.dispose();
      const materials = Array.isArray(item.material) ? item.material : [item.material];
      materials.filter(Boolean).forEach(material => {
        if (disposedMaterials.has(material)) return;
        disposedMaterials.add(material);
        if (material.map) material.map.dispose();
        material.dispose();
      });
    });
  }

  window.PersonaFlowBrickV2 = { buildCharacter, disposeCharacter };
})();
