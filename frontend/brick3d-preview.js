(function () {
  'use strict';

  const THREE = window.THREE;
  if (!THREE) {
    console.error('[brick3d-preview] Three.js is not available');
    return;
  }

  const safeColor = (value, fallback) =>
    /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;

  const bounded = (value, low, high, fallback = 1) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };

  function plastic(color, roughness = 0.3) {
    return new THREE.MeshPhysicalMaterial({
      color: safeColor(color, '#808080'),
      roughness,
      metalness: 0.02,
      clearcoat: 0.42,
      clearcoatRoughness: 0.2,
    });
  }

  async function materialTexture(source, renderer) {
    if (!source || !String(source).startsWith('data:image/')) throw new Error('missing_ai_texture');
    try {
      const texture = await new THREE.TextureLoader().loadAsync(source);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return texture;
    } catch (error) {
      console.warn('[brick3d-preview] required texture load failed', error);
      throw new Error('ai_texture_load_failed');
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

  async function buildCharacter(spec, renderer) {
    const root = new THREE.Group();
    const outfit = spec.outfit || {};
    const face = spec.face || {};
    const shape = spec.body_shape || {};
    const skin = plastic(spec.skin_color || '#FFD0A8', 0.32);
    const upper = plastic(outfit.upper_color || '#607D8B');
    const lower = plastic(outfit.lower_color || '#263238');
    const hair = plastic(spec.hair?.color || '#3B2314', 0.36);
    const ink = plastic('#111318', 0.4);
    const shoe = plastic('#151A22', 0.38);
    const heightScale = bounded(
      shape.height_scale,
      0.85,
      1.15,
      { short: 0.9, medium: 1, tall: 1.1 }[spec.height_profile] || 1,
    );
    const shoulderScale = bounded(shape.shoulder_width, 0.85, 1.15);
    const torsoWidth = bounded(shape.torso_width, 0.85, 1.15);
    const torsoDepth = bounded(shape.torso_depth, 0.9, 1.1);
    const limbThickness = bounded(shape.limb_thickness, 0.88, 1.12);
    root.scale.y = heightScale;

    const torsoTexturePromise = materialTexture(spec.textures?.torso_front, renderer);
    const faceTexturePromise = materialTexture(spec.textures?.face_decal, renderer);
    const leftLegTexturePromise = materialTexture(
      spec.textures?.left_leg_front || spec.textures?.legs_front,
      renderer,
    );
    const rightLegTexturePromise = materialTexture(
      spec.textures?.right_leg_front || spec.textures?.legs_front,
      renderer,
    );
    const [torsoTexture, faceTexture, leftLegTexture, rightLegTexture] = await Promise.all([
      torsoTexturePromise,
      faceTexturePromise,
      leftLegTexturePromise,
      rightLegTexturePromise,
    ]);

    const torso = mesh(new THREE.BoxGeometry(1.65, 1.85, 0.72), upper, root, { y: 3.28 });
    torso.scale.set(torsoWidth, 1, torsoDepth);
    const torsoDecal = mesh(
      new THREE.PlaneGeometry(1.55, 1.72),
      new THREE.MeshStandardMaterial({ map: torsoTexture, roughness: 0.32, metalness: 0.01 }),
      root,
      { y: 3.28, z: 0.366 * torsoDepth + 0.003 },
    );
    torsoDecal.scale.x = torsoWidth;

    mesh(new THREE.CylinderGeometry(0.72, 0.72, 1.15, 16), skin, root, { y: 4.95 });
    if (faceTexture) {
      mesh(
        new THREE.PlaneGeometry(1.12, 0.9),
        new THREE.MeshStandardMaterial({
          map: faceTexture,
          roughness: 0.3,
          metalness: 0.01,
          transparent: true,
          alphaTest: 0.06,
          depthWrite: false,
        }),
        root,
        { y: 4.96, z: 0.724 },
      );
    } else {
      mesh(new THREE.SphereGeometry(0.075, 8, 6), ink, root, { x: -0.25, y: 5.03, z: 0.69 });
      mesh(new THREE.SphereGeometry(0.075, 8, 6), ink, root, { x: 0.25, y: 5.03, z: 0.69 });
      const mouth = new THREE.Mesh(
        new THREE.TorusGeometry(0.19, 0.035, 5, 16, face.expression === 'smile' ? Math.PI : Math.PI * 0.55),
        ink,
      );
      mouth.position.set(0, 4.78, 0.7);
      root.add(mouth);
    }

    const hairStyle = spec.hair?.style || 'short';
    if (hairStyle !== 'bald') {
      mesh(new THREE.SphereGeometry(0.76, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, root, { y: 5.48 });
      if (['long', 'bob', 'wave'].includes(hairStyle)) {
        mesh(
          new THREE.BoxGeometry(1.48, hairStyle === 'long' ? 1.35 : 0.72, 0.34),
          hair,
          root,
          { y: hairStyle === 'long' ? 4.95 : 5.15, z: -0.48 },
        );
      }
      if (hairStyle === 'bun') mesh(new THREE.SphereGeometry(0.38, 12, 8), hair, root, { y: 6.05, z: -0.2 });
      if (hairStyle === 'ponytail') mesh(new THREE.SphereGeometry(0.34, 12, 8), hair, root, { y: 5.25, z: -0.8 });
    }

    if (face.glasses) {
      for (const x of [-0.25, 0.25]) {
        mesh(new THREE.TorusGeometry(0.18, 0.035, 5, 12), ink, root, { x, y: 5.02, z: 0.73 });
      }
      mesh(new THREE.BoxGeometry(0.16, 0.04, 0.04), ink, root, { y: 5.02, z: 0.73 });
    }
    if (face.beard && face.beard !== 'none') {
      mesh(new THREE.BoxGeometry(0.62, 0.22, 0.05), hair, root, { y: 4.68, z: 0.71 });
    }

    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 1.02 * shoulderScale, 3.86, 0);
      arm.rotation.z = side * 0.14;
      root.add(arm);
      const armMesh = mesh(new THREE.BoxGeometry(0.48, 1.55, 0.5), upper, arm, { y: -0.72 });
      armMesh.scale.x = armMesh.scale.z = limbThickness;
      mesh(new THREE.SphereGeometry(0.34, 12, 8), skin, arm, { y: -1.62 });

      const leg = new THREE.Group();
      leg.position.set(side * 0.38 * torsoWidth, 2.34, 0);
      root.add(leg);
      const legMesh = mesh(new THREE.BoxGeometry(0.62, 1.55, 0.68), lower, leg, { y: -0.72 });
      legMesh.scale.x = legMesh.scale.z = limbThickness;
      mesh(
        new THREE.PlaneGeometry(0.55, 1.4),
        new THREE.MeshStandardMaterial({
          map: side < 0 ? leftLegTexture : rightLegTexture,
          roughness: 0.34,
        }),
        leg,
        { y: -0.72, z: 0.345 },
      );
      mesh(new THREE.BoxGeometry(0.68, 0.38, 1), shoe, leg, { y: -1.64, z: 0.15 });
    }

    return root;
  }

  function disposeObject(root) {
    root.traverse((item) => {
      if (item.geometry) item.geometry.dispose();
      const materials = Array.isArray(item.material) ? item.material : [item.material];
      materials.filter(Boolean).forEach((material) => {
        if (material.map) material.map.dispose();
        material.dispose();
      });
    });
  }

  async function renderCharacter(spec, options = {}) {
    if (!spec || !['brick_v1', 'brick_v2'].includes(spec.style_id)) throw new Error('invalid_brick_character_spec');
    if (spec.quality?.ai_texture_status !== 'enhanced') throw new Error('ai_texture_not_enhanced');
    const requiredTextures = ['face_decal', 'torso_front', 'left_leg_front', 'right_leg_front'];
    if (requiredTextures.some((key) => !String(spec.textures?.[key] || '').startsWith('data:image/'))) {
      throw new Error('incomplete_ai_texture_atlas');
    }
    const width = Math.max(320, Math.min(1024, Number(options.width) || 640));
    const height = Math.max(420, Math.min(1280, Number(options.height) || 800));
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 100);
    camera.position.set(0, 4.55, 13.8);
    camera.lookAt(0, 2.70, 0);
    scene.add(new THREE.HemisphereLight(0xbed8ff, 0x172033, 2.1));
    const key = new THREE.DirectionalLight(0xffead2, 4.2);
    key.position.set(-10, 18, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6b8cff, 2.2);
    rim.position.set(12, 9, -8);
    scene.add(rim);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 8),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.26 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.receiveShadow = true;
    scene.add(shadow);

    let character;
    try {
      character = spec.style_id === 'brick_v2'
        ? await window.PersonaFlowBrickV2?.buildCharacter(spec, renderer)
        : await buildCharacter(spec, renderer);
      if (!character) throw new Error('brick_v2_model_not_ready');
      scene.add(character);
      renderer.render(scene, camera);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    } finally {
      if (character) {
        if (spec.style_id === 'brick_v2' && window.PersonaFlowBrickV2?.disposeCharacter) {
          window.PersonaFlowBrickV2.disposeCharacter(character);
        } else {
          disposeObject(character);
        }
      }
      shadow.geometry.dispose();
      shadow.material.dispose();
      renderer.dispose();
    }
  }

  window.PersonaFlowBrick3D = { renderCharacter };
})();
