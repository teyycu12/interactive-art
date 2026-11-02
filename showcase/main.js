/* PixelAir 專題介紹頁：純前端，不需要伺服器。 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================= 像素角色 ================= */
  const PAL = {
    skin: ['#f6d3b3', '#eabf98', '#d6a074', '#a8714a', '#7a4e30'],
    hair: ['#1d1b22', '#2b2b33', '#4a3426', '#7a4b2a', '#c99a4b', '#8a8f99', '#b5532f'],
    shirt: ['#e8684a', '#3fa79c', '#f4b942', '#4f6db5', '#f4f1ea', '#2b2f3a', '#a8457a', '#5f9e4a', '#9ecbe8', '#e7a2b8'],
    pants: ['#2f3a5a', '#2b2f3a', '#5a4a3a', '#3d5f8a', '#d8cbb0', '#6b6f7a'],
    shoe: ['#fffaf0', '#2b2f3a', '#8a4b2a', '#e8684a'],
  };
  const OUTLINE = '#2b2f3a';

  const HEAD = {
    down: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhsssssshh.', '.hsessssesh.', '.hssssssssh.', '..sssmmsss..', '...ssssss...'],
    up: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '..hhhhhhhh..', '...ssssss...'],
    side: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhhssssss.', '.hhhsssssess', '.hhssssssss.', '..hhssssmss.', '...hsssss...'],
  };
  const BODY = {
    front: ['..tttttttt..', '.tttttttttt.', '.atttttttta.', '.atttttttta.', '.k.tttttt.k.'],
    side: ['...tttttt...', '...tttttt...', '...ttaatt...', '...ttaatt...', '...ttkktt...'],
  };
  const LEGS = {
    front: [
      ['...pppppp...', '...pp..pp...', '...pp..pp...', '...pp..pp...', '..bbb..bbb..'],
      ['...pppppp...', '...pp..pp...', '...pp..pp...', '..bbb..pp...', '.......bbb..'],
      ['...pppppp...', '...pp..pp...', '...pp..pp...', '...pp..bbb..', '..bbb.......'],
    ],
    skirt: [
      ['..pppppppp..', '..pppppppp..', '.pppppppppp.', '...kk..kk...', '..bbb..bbb..'],
      ['..pppppppp..', '..pppppppp..', '.pppppppppp.', '..bbb..kk...', '.......bbb..'],
      ['..pppppppp..', '..pppppppp..', '.pppppppppp.', '...kk..bbb..', '..bbb.......'],
    ],
    side: [
      ['....pppp....', '....pppp....', '....pppp....', '....pppp....', '....bbbbb...'],
      ['....pppp....', '...pp..pp...', '..pp....pp..', '..pp....pp..', '.bbb....bbb.'],
    ],
  };

  // 畢業袍（團隊頭像用，只有正面）
  const GOWN_BODY = ['..wwgccgww..', '.gwwgccgwwg.', '.ggwwggwwgg.', '.gggwwwwggg.', '.kgggrrgggk.'];
  const GOWN_LEGS = [
    ['..gggggggg..', '..gggggggg..', '..gggggggg..', '...pp..pp...', '..bbb..bbb..'],
    ['..gggggggg..', '..gggggggg..', '..gggggggg..', '..bbb..pp...', '.......bbb..'],
    ['..gggggggg..', '..gggggggg..', '..gggggggg..', '...pp..bbb..', '..bbb.......'],
  ];
  const HEADS = {
    messy: ['..h.hhhh.h..', '..hhhhhhhhh.', '.hhhhhhhhhhh', '.hhsshsshhh.', '.hsessssesh.', '.hssssssssh.', '..sssmmsss..', '...ssssss...'],
    fringe: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '.hsessssesh.', '.hssssssssh.', '..sssmmsss..', '...ssssss...'],
    part: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhshhhhh.', '.hhsssssshh.', '.hsessssesh.', '.hssssssssh.', '..sssmmsss..', '...ssssss...'],
  };

  function randLook(rnd = Math.random) {
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    return {
      skin: pick(PAL.skin), hair: pick(PAL.hair), shirt: pick(PAL.shirt),
      pants: pick(PAL.pants), shoe: pick(PAL.shoe),
      long: rnd() < 0.4, skirt: rnd() < 0.22, sleeve: rnd() < 0.5,
    };
  }

  // dir: down | up | right | left；frame: 0 站立、1、2 跨步
  function buildSprite(look, dir, frame) {
    const side = dir === 'left' || dir === 'right';
    const gown = look.gown && !side;
    const head = side ? HEAD.side : (dir === 'down' && HEADS[look.head]) || HEAD[dir];
    const body = side ? BODY.side : gown ? GOWN_BODY : BODY.front;
    let legs;
    if (side) legs = LEGS.side[frame === 0 ? 0 : 1];
    else if (gown) legs = GOWN_LEGS[frame];
    else legs = (look.skirt ? LEGS.skirt : LEGS.front)[frame];
    const rows = [...head, ...body, ...legs].map((r) => r.split(''));
    const set = (x, y, c) => { if (rows[y] && x >= 0 && x < 12) rows[y][x] = c; };
    if (look.long) {
      if (dir === 'down') {
        const to = look.longTo || 10;  // 頭髮長到第幾列
        for (let y = 3; y <= to; y++) { set(1, y, 'h'); set(10, y, 'h'); }
        for (let y = 4; y <= to - 1; y++) { set(0, y, 'h'); set(11, y, 'h'); }
      } else if (dir === 'up') {
        for (let y = 7; y <= 11; y++) for (let x = 2; x <= 9; x++) set(x, y, 'h');
      } else {
        for (let y = 3; y <= 10; y++) { set(1, y, 'h'); set(2, y, 'h'); set(3, y, 'h'); }
      }
    }
    if (gown && look.tie) { set(5, 8, 'n'); set(6, 8, 'n'); set(5, 9, 'n'); set(6, 9, 'n'); set(5, 10, 'n'); set(6, 10, 'n'); }
    if (gown && look.camera) {
      set(4, 9, 'x'); set(7, 9, 'x'); set(4, 10, 'x'); set(7, 10, 'x');
      for (let x = 3; x <= 8; x++) { set(x, 12, 'x'); set(x, 13, 'x'); }
      set(5, 13, 'y'); set(6, 13, 'y');
    }
    const col = {
      h: look.hair, s: look.skin, k: look.skin, e: OUTLINE, m: '#b5534a',
      t: look.shirt, a: look.sleeve ? look.shirt : look.skin, p: look.pants, b: look.shoe,
      g: '#35353c', w: '#f4f1ea', c: '#ffffff', r: '#e0457b', n: '#3d4a6b', x: '#4a4a52', y: '#c9ced6',
    };
    const W = 14, H = rows.length + 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const filled = (x, y) => rows[y - 1] && rows[y - 1][x - 1] && rows[y - 1][x - 1] !== '.';
    // 外框
    g.fillStyle = OUTLINE;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (filled(x, y)) continue;
      if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) g.fillRect(x, y, 1, 1);
    }
    rows.forEach((r, y) => r.forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = col[ch];
      g.fillRect(x + 1, y + 1, 1, 1);
    }));
    if (dir === 'left') {
      const f = document.createElement('canvas');
      f.width = W; f.height = H;
      const fg = f.getContext('2d');
      fg.translate(W, 0); fg.scale(-1, 1); fg.drawImage(c, 0, 0);
      return f;
    }
    return c;
  }

  function spriteSet(look) {
    const s = {};
    for (const d of ['down', 'up', 'right', 'left']) s[d] = [0, 1, 2].map((f) => buildSprite(look, d, f));
    return s;
  }

  /* ================= 群體（Boids + α 仲裁） ================= */
  class Crowd {
    constructor(canvas, o) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.o = o;
      this.params = { sep: 2.2, ali: 0.9, coh: 0.75, wan: 0.55 };
      this.agents = [];
      this.pairs = new Set();
      this.running = false;
      this.last = 0;
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
      new IntersectionObserver(([e]) => (e.isIntersecting ? this.start() : this.stop())).observe(canvas);
    }
    resize() {
      const r = this.c.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      this.c.width = Math.max(1, Math.round(r.width * dpr));
      this.c.height = Math.max(1, Math.round(r.height * dpr));
      if (this.o.world) { this.W = this.o.world.w; this.H = this.o.world.h; }
      else { this.W = r.width; this.H = r.height; }
      this.k = this.c.width / this.W;
      this.bounds = this.o.bounds(this.W, this.H);
      if (!this.agents.length && r.width > 0) this.spawn();
      for (const a of this.agents) this.clampIn(a);
    }
    spawn() {
      const b = this.bounds;
      const n = typeof this.o.n === 'function' ? this.o.n(this.W) : this.o.n;
      for (let i = 0; i < n; i++) {
        const look = randLook();
        const ang = Math.random() * Math.PI * 2;
        this.agents.push({
          id: i, look, spr: spriteSet(look),
          x: b.x0 + Math.random() * (b.x1 - b.x0), y: b.y0 + Math.random() * (b.y1 - b.y0),
          vx: Math.cos(ang) * 10, vy: Math.sin(ang) * 10,
          th: ang, dir: 'down', step: 0, jump: 0, say: '', sayT: 0,
        });
      }
      if (this.o.player) {
        const p = this.agents[0];
        p.player = true;
        p.alpha = 0; p.idle = 99; p.alphaFrom = 0;
        p.x = (b.x0 + b.x1) / 2; p.y = (b.y0 + b.y1) / 2;
        this.player = p;
      }
    }
    clampIn(a) {
      const b = this.bounds;
      a.x = Math.min(b.x1, Math.max(b.x0, a.x));
      a.y = Math.min(b.y1, Math.max(b.y0, a.y));
    }
    start() { if (this.running) return; this.running = true; this.last = performance.now(); requestAnimationFrame((t) => this.tick(t)); }
    stop() { this.running = false; }
    tick(t) {
      if (!this.running) return;
      const dt = Math.max(0, Math.min(0.05, (t - this.last) / 1000));
      this.last = t;
      if (!reduceMotion || this.o.player) this.update(dt);
      this.draw();
      this.o.onFrame && this.o.onFrame(this);
      requestAnimationFrame((tt) => this.tick(tt));
    }
    paired(a, b) { return this.pairs.has(a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id); }
    addPair(a, b) { this.pairs.add(a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id); }
    update(dt) {
      const { perc, sep, speed, accel } = this.o;
      const P = this.params, perc2 = perc * perc, sep2 = sep * sep, b = this.bounds;
      const next = [];
      for (const a of this.agents) {
        let sx = 0, sy = 0, ax = 0, ay = 0, an = 0, cx = 0, cy = 0, cw = 0;
        for (const o of this.agents) {
          if (o === a) continue;
          const dx = o.x - a.x, dy = o.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 > perc2) continue;
          an++; ax += o.vx; ay += o.vy;
          const w = this.paired(a, o) ? 2.5 : 1;
          cx += o.x * w; cy += o.y * w; cw += w;
          if (d2 < sep2 && d2 > 0.01) { const d = Math.sqrt(d2); sx -= (dx / d) * (1 - d / sep); sy -= (dy / d) * (1 - d / sep); }
        }
        const nz = (x, y) => { const l = Math.hypot(x, y); return l > 1e-6 ? [x / l, y / l] : [0, 0]; };
        let fx = 0, fy = 0, v;
        v = nz(sx, sy); fx += v[0] * P.sep; fy += v[1] * P.sep;
        if (an) {
          v = nz(ax / an - a.vx, ay / an - a.vy); fx += v[0] * P.ali; fy += v[1] * P.ali;
          v = nz(cx / cw - a.x, cy / cw - a.y); fx += v[0] * P.coh; fy += v[1] * P.coh;
        }
        a.th += (Math.random() - 0.5) * 3 * dt;
        fx += Math.cos(a.th) * P.wan; fy += Math.sin(a.th) * P.wan;
        const m = sep * 0.6;
        if (a.x < b.x0 + m) fx += 3 * (1 - (a.x - b.x0) / m);
        if (a.x > b.x1 - m) fx -= 3 * (1 - (b.x1 - a.x) / m);
        if (a.y < b.y0 + m) fy += 3 * (1 - (a.y - b.y0) / m);
        if (a.y > b.y1 - m) fy -= 3 * (1 - (b.y1 - a.y) / m);
        let bvx = a.vx + fx * accel * dt, bvy = a.vy + fy * accel * dt;
        const bs = Math.hypot(bvx, bvy);
        if (bs > speed) { bvx *= speed / bs; bvy *= speed / bs; }
        bvx *= 1 - 0.3 * dt; bvy *= 1 - 0.3 * dt;
        let vx = bvx, vy = bvy;
        if (a.player) {
          const al = a.alpha, mx = this.input.x * this.o.manual, my = this.input.y * this.o.manual;
          vx = (1 - al) * bvx + al * mx;
          vy = (1 - al) * bvy + al * my;
        }
        next.push([vx, vy]);
      }
      this.agents.forEach((a, i) => {
        [a.vx, a.vy] = next[i];
        a.x += a.vx * dt; a.y += a.vy * dt;
        this.clampIn(a);
        const s = Math.hypot(a.vx, a.vy);
        if (s > speed * 0.15) {
          a.dir = Math.abs(a.vx) > Math.abs(a.vy) ? (a.vx > 0 ? 'right' : 'left') : (a.vy > 0 ? 'down' : 'up');
          a.step += s * dt;
        } else a.step = 0;
        if (a.jump > 0) a.jump -= dt;
        if (a.sayT > 0) a.sayT -= dt;
      });
    }
    draw() {
      const g = this.g, k = this.k, S = this.o.scale;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.c.width, this.c.height);
      g.imageSmoothingEnabled = false;
      if (this.o.bg && this.o.bg.complete && this.o.bg.naturalWidth) g.drawImage(this.o.bg, 0, 0, this.c.width, this.c.height);
      g.setTransform(k, 0, 0, k, 0, 0);
      this.o.beforeAgents && this.o.beforeAgents(this, g);
      const sorted = [...this.agents].sort((a, b) => a.y - b.y);
      const w = 14 * S, h = 20 * S;
      for (const a of sorted) {
        const seq = [1, 0, 2, 0];
        const f = a.step ? seq[Math.floor(a.step / (S * 5)) % 4] : 0;
        const img = a.spr[a.dir][f];
        const jy = a.jump > 0 ? Math.sin((a.jump / 0.45) * Math.PI) * S * 5 : 0;
        g.fillStyle = 'rgba(43,47,58,.22)';
        g.fillRect(a.x - w * 0.32, a.y - S, w * 0.64, S * 2);
        g.drawImage(img, Math.round(a.x - w / 2), Math.round(a.y - h - jy + (f ? 0 : 0)), w, h);
        this.o.afterAgent && this.o.afterAgent(this, g, a, w, h, jy);
        if (a.sayT > 0) this.bubble(g, a.say, a.x, a.y - h - jy - S * 3, S);
      }
    }
    bubble(g, text, x, y, S) {
      const fs = Math.max(12, S * 5);
      g.font = `700 ${fs}px "Noto Sans TC", sans-serif`;
      const tw = g.measureText(text).width, pad = fs * 0.5, bw = tw + pad * 2, bh = fs * 1.6;
      g.fillStyle = OUTLINE; g.fillRect(x - bw / 2 - 2, y - bh - 2, bw + 4, bh + 4);
      g.fillStyle = '#fffaf0'; g.fillRect(x - bw / 2, y - bh, bw, bh);
      g.fillStyle = OUTLINE; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, x, y - bh / 2 + 1);
    }
    nearest(x, y, max, filter = () => true) {
      let best = null, bd = max;
      for (const a of this.agents) {
        if (!filter(a)) continue;
        const d = Math.hypot(a.x - x, a.y - y);
        if (d < bd) { bd = d; best = a; }
      }
      return best;
    }
  }

  /* ---------- Hero 小人群 ---------- */
  const heroCanvas = $('#heroCrowd');
  if (heroCanvas) {
    const hello = ['嗨！', '你是哪一型？', '配對碼幾號？', '一起拍合照！', '你也是無尾熊？', '👋'];
    const hero = new Crowd(heroCanvas, {
      n: (w) => Math.max(7, Math.min(18, Math.round(w / 95))),
      scale: 3, perc: 140, sep: 56, speed: 26, accel: 30,
      bounds: (W, H) => ({ x0: 24, x1: W - 24, y0: 66, y1: H - 26 }),
    });
    heroCanvas.addEventListener('click', (e) => {
      const r = heroCanvas.getBoundingClientRect();
      const a = hero.nearest(e.clientX - r.left, e.clientY - r.top + 30, 70);
      if (a) { a.jump = 0.45; a.say = hello[Math.floor(Math.random() * hello.length)]; a.sayT = 1.6; }
    });
    // 偶爾自己打招呼，讓畫面有生氣
    setInterval(() => {
      if (!hero.running || document.hidden || reduceMotion) return;
      const a = hero.agents[Math.floor(Math.random() * hero.agents.length)];
      if (a && a.sayT <= 0) { a.say = hello[Math.floor(Math.random() * hello.length)]; a.sayT = 1.8; a.jump = 0.45; }
    }, 2600);
  }

  /* ---------- 共治引擎 Demo ---------- */
  const demoCanvas = $('#demo');
  if (demoCanvas) {
    const bg = new Image();
    bg.src = 'img/office.webp';
    const input = { x: 0, y: 0 };
    const keys = new Set();
    let drag = null;
    let helpHidden = false;
    const UP = 0.3, HOLD = 3, DOWN = 1.2;

    const demo = new Crowd(demoCanvas, {
      world: { w: 1920, h: 1080 }, bg, player: true,
      n: 26, scale: 5, perc: 260, sep: 95, speed: 70, accel: 110, manual: 300,
      bounds: () => ({ x0: 280, x1: 1640, y0: 300, y1: 985 }),
      beforeAgents(cr, g) {
        const p = cr.player;
        g.save();
        g.strokeStyle = '#e8684a'; g.lineWidth = 4; g.setLineDash([12, 10]);
        for (const a of cr.agents) {
          if (a === p || !cr.paired(a, p)) continue;
          g.beginPath(); g.moveTo(p.x, p.y - 30); g.lineTo(a.x, a.y - 30); g.stroke();
        }
        g.restore();
      },
      afterAgent(cr, g, a, w, h, jy) {
        const top = a.y - h - jy;
        if (a.player) {
          const bob = Math.sin(performance.now() / 180) * 4;
          g.fillStyle = '#e8684a';
          g.beginPath(); g.moveTo(a.x - 12, top - 26 + bob); g.lineTo(a.x + 12, top - 26 + bob); g.lineTo(a.x, top - 10 + bob); g.closePath(); g.fill();
          g.strokeStyle = OUTLINE; g.lineWidth = 3; g.stroke();
          g.font = '700 26px "Noto Sans TC", sans-serif';
          g.fillStyle = OUTLINE; g.fillRect(a.x - 26, a.y + 6, 52, 34);
          g.fillStyle = '#f4b942'; g.fillRect(a.x - 23, a.y + 9, 46, 28);
          g.fillStyle = OUTLINE; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('你', a.x, a.y + 24);
        } else if (cr.paired(a, cr.player)) {
          g.font = '28px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
          g.fillText('💗', a.x, top - 6);
        }
      },
      onFrame: hud,
    });
    demo.input = input;

    function stepAlpha(dt) {
      const p = demo.player, active = Math.hypot(input.x, input.y) > 0.05;
      if (active) { p.idle = 0; p.alpha = Math.min(1, p.alpha + dt / UP); p.alphaFrom = p.alpha; }
      else {
        p.idle += dt;
        if (p.idle > HOLD) {
          const t = Math.min(1, (p.idle - HOLD) / DOWN);
          p.alpha = p.alphaFrom * 0.5 * (1 + Math.cos(Math.PI * t));
        }
      }
    }
    // α 每幀在 update 之前推進
    const origUpdate = demo.update.bind(demo);
    demo.update = (dt) => { readKeys(); stepAlpha(dt); origUpdate(dt); };

    function readKeys() {
      if (drag) return;
      let x = 0, y = 0;
      if (keys.has('arrowleft') || keys.has('a')) x -= 1;
      if (keys.has('arrowright') || keys.has('d')) x += 1;
      if (keys.has('arrowup') || keys.has('w')) y -= 1;
      if (keys.has('arrowdown') || keys.has('s')) y += 1;
      const l = Math.hypot(x, y) || 1;
      input.x = x / l; input.y = y / l;
    }
    const alphaFill = $('#alphaFill'), alphaVal = $('#alphaVal'), alphaState = $('#alphaState'), formula = $('#formula');
    let lastTxt = '';
    function hud(cr) {
      const p = cr.player, al = p.alpha;
      alphaFill.style.width = (al * 100).toFixed(1) + '%';
      alphaVal.textContent = al.toFixed(2);
      let s;
      if (Math.hypot(input.x, input.y) > 0.05) s = al < 1 ? '推搖桿：α 線性上升中（0.3 秒升到 1）' : '手動操控中：α = 1，完全聽你的';
      else if (p.idle <= HOLD && al > 0.001) s = `放手 ${p.idle.toFixed(1)} 秒：先停在原地，滿 3 秒交還群體`;
      else if (al > 0.001) s = '餘弦交接中：α 平滑降回 0，起點與終點斜率都是 0';
      else s = '群體接手中：角色跟著 Boids 漫遊';
      if (s !== lastTxt) { alphaState.textContent = s; lastTxt = s; }
      const a = al.toFixed(2);
      formula.innerHTML = `V<sub>final</sub> = (1 − <b>${a}</b>)·V<sub>Boids</sub> + <b>${a}</b>·V<sub>Manual</sub>`;
      if (drag) {
        const g = cr.g, d = Math.min(devicePixelRatio || 1, 2);
        g.setTransform(d, 0, 0, d, 0, 0);
        g.strokeStyle = 'rgba(43,47,58,.6)'; g.lineWidth = 3;
        g.beginPath(); g.arc(drag.x0, drag.y0, 46, 0, Math.PI * 2); g.stroke();
        g.fillStyle = 'rgba(232,104,74,.85)';
        g.beginPath(); g.arc(drag.x0 + input.x * 46, drag.y0 + input.y * 46, 18, 0, Math.PI * 2); g.fill();
      }
    }
    const hideHelp = () => { if (!helpHidden) { helpHidden = true; $('#demoHelp').style.opacity = 0; } };
    demoCanvas.addEventListener('pointerdown', (e) => {
      const r = demoCanvas.getBoundingClientRect();
      drag = { id: e.pointerId, x0: e.clientX - r.left, y0: e.clientY - r.top };
      demoCanvas.setPointerCapture(e.pointerId);
      hideHelp();
    });
    demoCanvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = demoCanvas.getBoundingClientRect();
      let dx = e.clientX - r.left - drag.x0, dy = e.clientY - r.top - drag.y0;
      const l = Math.hypot(dx, dy), R = 46;
      if (l < 6) { input.x = input.y = 0; return; }
      const m = Math.min(1, l / R);
      input.x = (dx / l) * m; input.y = (dy / l) * m;
    });
    const endDrag = (e) => { if (drag && e.pointerId === drag.id) { drag = null; input.x = input.y = 0; } };
    demoCanvas.addEventListener('pointerup', endDrag);
    demoCanvas.addEventListener('pointercancel', endDrag);

    const inDemoView = () => { const r = demoCanvas.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
    addEventListener('keydown', (e) => {
      if (!inDemoView() || e.target.closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) {
        keys.add(k); hideHelp();
        if (k.startsWith('arrow')) e.preventDefault();
      } else if (k === 'e') pair();
    });
    addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => keys.clear());

    const toastEl = $('#toast');
    let toastT;
    function toast(msg) {
      toastEl.textContent = msg; toastEl.classList.add('is-on');
      clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('is-on'), 2200);
    }
    function pair() {
      const p = demo.player;
      const left = demo.agents.filter((a) => a !== p && !demo.paired(a, p));
      if (!left.length) return toast('全場都配對過了！去拍大合照吧 📸');
      const a = demo.nearest(p.x, p.y, 300, (o) => o !== p && !demo.paired(o, p));
      if (!a) return toast('附近沒有人——走近一點再按');
      demo.addPair(p, a);
      a.jump = 0.45; a.say = '配對成功！'; a.sayT = 1.6;
      $('#pairCount').textContent = demo.agents.filter((o) => o !== p && demo.paired(o, p)).length;
      toast('配對成功！你們之間的凝聚權重 ×2.5');
    }
    $('#pairBtn').addEventListener('click', pair);

    for (const k of ['sep', 'ali', 'coh', 'wan']) {
      const inp = $('#p-' + k), out = $('#o-' + k);
      inp.addEventListener('input', () => { demo.params[k] = +inp.value; out.textContent = inp.value; });
    }
  }

  /* ================= 導覽列 ================= */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('is-shown', scrollY > innerHeight * 0.55);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const toggle = $('#navToggle'), links = $('#navLinks');
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open);
  });
  $$('a', links).forEach((a) => a.addEventListener('click', () => { links.classList.remove('is-open'); toggle.setAttribute('aria-expanded', false); }));
  const navMap = new Map($$('a', links).map((a) => [a.getAttribute('href').slice(1), a]));
  const secObs = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { navMap.forEach((a) => a.classList.remove('is-active')); navMap.get(e.target.id)?.classList.add('is-active'); }
  }), { rootMargin: '-45% 0px -50% 0px' });
  $$('main > section[id]').forEach((s) => secObs.observe(s));

  /* ================= 進場動畫與數字 ================= */
  function countUp(el) {
    const to = +el.dataset.count, dec = +(el.dataset.dec || 0);
    const fmt = (v) => (to >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(dec));
    if (reduceMotion) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 1300;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const revObs = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in');
    $$('[data-count]', e.target).forEach(countUp);
    revObs.unobserve(e.target);
  }), { threshold: 0.15 });
  $$('.reveal').forEach((el) => revObs.observe(el));

  /* ================= 系統架構 ================= */
  const NODES = {
    phone: ['手機控制器', ['掃描入場 QR Code，拍照、從相簿選照片或自訂角色', '浮動搖桿操控自己的角色、揮手、私訊', '輸入配對碼、填賓果格子、作答與問卷', '私人資訊（配對碼、賓果卡）只出現在本人手機上']],
    screen: ['大螢幕（投影）', ['Canvas2D 角色圖層＋場景：日常廚房、共享辦公室、活力體育館', '顯示排行榜、題目、文字雲與合照 QR Code', '在看不見的畫布上另外合成大合照，場上的人照常走動', '30 人時每幀繪製約 6.0 ms（60 fps 預算 16.7 ms）']],
    host: ['主辦端控制台', ['以每次啟動產生的 6 碼密鑰登入', '節目單：依場合套用範本，再自行增刪步驟', '發任務、出題、換場景、拍大合照', '查看生成歷史，匯出活動紀錄與參與者名單（CSV）']],
    core: ['互動層（Node.js + ws，:3000）', ['30 Hz 主迴圈：α 仲裁 + Boids 群體行為', '任務、配對、問答、計分、社交圖譜、生成排隊（上限 60 人）', '每 5 秒「先寫暫存檔再改名」存快照，斷電最多退回 5 秒', '手機關掉 45 秒內重連可接回同一個角色；Token Bucket 速率限制防窮舉', '40 人壓測：CPU 約 9%、記憶體約 78 MB、操控延遲中位數 9 ms']],
    gen: ['生成服務（Python + Flask，只綁 127.0.0.1:5055）', ['MediaPipe 站位檢查：肩、髖、膝、腳踝、腳跟、腳尖都要入框', 'OpenCV 擷取上身、下身、手臂顏色', '本機結構驗證，通過後切成頭、身、腿三張貼圖', '大合照標題與 QR Code；每次生成的耗時、token、費用寫入 SQLite']],
    api: ['外部生圖 API', ['Gemini 影像模型：一次畫出正面、側面、背面三視圖', '送入照片、特寫拼版、姿勢結構與風格參考表', '429 / 5xx 自動重試，連續失敗時熔斷器跳開', '實測每次約 US$0.07，外部 API 佔總耗時約 85%']],
  };
  const archDetail = $('#archDetail');
  function showNode(key) {
    $$('.node').forEach((n) => n.classList.toggle('is-on', n.dataset.node === key));
    const [t, items] = NODES[key];
    archDetail.innerHTML = `<h4>${t}</h4><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  }
  $$('.node').forEach((n) => n.addEventListener('click', () => showNode(n.dataset.node)));
  showNode('core');

  /* ================= 入場流程 ================= */
  const STEPS = [
    ['掃描入場', '掃 QR Code 進場，選一條路：<b>拍照</b>、<b>從相簿選照片</b>，或<b>自訂角色</b>。相機預設關閉，按下「開啟攝影機」才請求權限。', ['QR Code', 'HTTPS']],
    ['站位檢查', 'MediaPipe 確認肩、髖、膝、腳踝、腳跟與腳尖都在畫面內，<b>連續五幀穩定</b>才允許按快門。', ['MediaPipe Pose']],
    ['擷取服裝色彩', 'OpenCV 取得上身、下身與手臂顏色——這就是「找顏色」任務與賓果格子的條件。依人體佔畫面比例分為矮、中、高三級，只影響顯示倍率。', ['OpenCV']],
    ['生成＋人格問卷', '照片、特寫拼版、姿勢結構與風格參考表一起送進影像模型。等待的十幾秒，用來回答 3–5 題進場人格問卷。', ['Gemini 影像模型', 'DISC 四型']],
    ['結構驗證', '前景佔 5%–85%、不碰畫布邊界、最大連通區 ≥ 75%、底部左右都有內容；背面頭部膚色過多代表畫成側臉，丟掉重來。沒過就回傳<b>中文原因與重拍建議</b>。', ['本機驗證']],
    ['切片進場', '切成頭、身、腿三張貼圖與一張整圖，角色走進大螢幕。實測成功率 <b>92%</b>，中位數 <b>16.9 秒</b>；自訂角色不呼叫外部 API，約 4 秒。', ['92%', '16.9 s', 'US$0.07 / 次']],
  ];
  const flow = $('#flow'), stepsEl = $('.flow__steps', flow), flowText = $('#flowText');
  STEPS.forEach(([t], i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button role="tab"><span class="n">0${i + 1}</span><span class="t">${t}</span><span class="bar"></span></button>`;
    stepsEl.appendChild(li);
  });
  const stepBtns = $$('button', stepsEl);
  let cur = 0, flowTimer, flowAuto = !reduceMotion;
  function setStep(i) {
    cur = i;
    stepBtns.forEach((b, j) => {
      b.classList.toggle('is-done', j < i);
      b.classList.remove('is-on'); void b.offsetWidth;
      b.classList.toggle('is-on', j === i);
      b.setAttribute('aria-selected', j === i);
    });
    const [t, d, tags] = STEPS[i];
    flowText.innerHTML = `<h4>${t}</h4><p>${d}</p>${tags.map((x) => `<span class="tag">${x}</span>`).join('')}`;
    clearTimeout(flowTimer);
    if (flowAuto) flowTimer = setTimeout(() => setStep((cur + 1) % STEPS.length), 4500);
  }
  stepBtns.forEach((b, i) => b.addEventListener('click', () => { flowAuto = false; stepsEl.classList.add('is-paused'); setStep(i); }));
  if (!flowAuto) stepsEl.classList.add('is-paused');
  setStep(0);

  /* ---------- 角色轉身 ---------- */
  const stage = $('#turnStage'), turnImg = $('img', stage), turnBtns = $$('.turn__ctrl button');
  const CENTERS = [0.218, 0.5, 0.785];
  let view = 0, turnAuto = !reduceMotion;
  function setView(v) {
    view = (v + 3) % 3;
    const W = turnImg.getBoundingClientRect().width || turnImg.offsetWidth;
    const tx = stage.clientWidth / 2 - CENTERS[view] * W;
    turnImg.style.setProperty('--tx', tx + 'px');
    turnBtns.forEach((b, i) => b.classList.toggle('is-on', i === view));
  }
  turnBtns.forEach((b) => b.addEventListener('click', () => { turnAuto = false; setView(+b.dataset.view); }));
  let dx0 = null;
  stage.addEventListener('pointerdown', (e) => { dx0 = e.clientX; turnAuto = false; });
  addEventListener('pointerup', (e) => {
    if (dx0 === null) return;
    const d = e.clientX - dx0; dx0 = null;
    if (Math.abs(d) > 25) setView(view + (d < 0 ? 1 : -1));
  });
  turnImg.complete ? setView(0) : turnImg.addEventListener('load', () => setView(0));
  addEventListener('resize', () => setView(view));
  setInterval(() => { if (turnAuto && !document.hidden) setView(view + 1); }, 2200);

  /* ================= 玩法卡片 ================= */
  const GAMES = [
    ['🔢', '配對任務', '每人一組 4 位數配對碼，每 100 秒換一次；輸入對方的碼，由對方確認。', '必須問對方號碼——把「搭訕」這個社交難題，降級成「請問你的號碼幾號」這個任務難題。', true],
    ['🐯', '找同類／找不同類', '依進場人格類型配對：找同類、找不同類，或找某一類。', '類型從外表看不出來，只能當面問「你是哪一型？」實測發布後 11 秒就出現第一組。'],
    ['🎨', '找顏色', '找身上有指定色系的人配對。', '逼人抬頭看真實的人，而不是看螢幕。'],
    ['⭕', '湊人數集合', 'N 個人同時站進大螢幕上的集合圈，並停留 2 秒。', '必須喊人一起過去。'],
    ['🎯', '人物賓果', '3×3 卡片，每格「找一個〔條件〕的人」，輸入對方配對碼才算。條件來自衣服顏色、人格類型與自我介紹。', '每一格都要開口問人；同一人在一張卡上原則上只能填一格。開放題中被提到最多次的環節。'],
    ['❓', '即時問答', 'Kahoot 式作答，可設討論時間；正解在公布前不離開伺服器。', '討論時間讓人轉頭商量。'],
    ['☁️', '文字雲', '全場回答同一題，大螢幕即時組成文字雲。', '作為轉場與共同話題。實測第二名是「我的人胖胖的」。'],
    ['👋', '揮手', '對別人揮手，對方 8 秒內回揮才算數。', '要讓對方注意到你，才會回揮。'],
    ['🪑', '話題桌', '兩人以上在同一張號碼牌桌停留 2 秒，手機跳出同一題聊天題。', '拿到同一題的人，自然會問「那你呢？」'],
    ['💬', '私訊', '點附近的角色傳一句話，單則最多 60 字；紀錄只存在雙方手機，伺服器不保存。', '字數短，適合約對方「當面聊」。'],
    ['📸', '集體大合照', '依當天互動計算熟悉度，越熟的人站得越近；QR Code 下載。', '把當天的互動變成「我們曾一起在場」的紀念物。'],
  ];
  const cardsEl = $('#cards');
  GAMES.forEach(([ic, name, front, back, code]) => {
    const c = document.createElement('div');
    c.className = 'card reveal';
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-pressed', 'false');
    c.setAttribute('aria-label', `${name}：翻面看為什麼需要開口`);
    c.innerHTML = `<div class="card__in">
      <div class="card__f"><span class="card__icon">${ic}</span><span class="card__name">${name}</span><p>${front}</p>
        ${code ? '<span class="code" aria-hidden="true"><span class="js-code">0000</span><small class="js-cd">100s</small></span>' : ''}
        <span class="card__flip">CLICK TO FLIP ↻</span></div>
      <div class="card__b"><span class="k">為什麼需要開口？</span><p>${back}</p></div></div>`;
    const flip = () => { const on = c.classList.toggle('is-flipped'); c.setAttribute('aria-pressed', on); };
    c.addEventListener('click', flip);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    cardsEl.appendChild(c);
    revObs.observe(c);
  });
  const codeEl = $('.js-code'), cdEl = $('.js-cd');
  let cd = 100;
  const newCode = () => { codeEl.textContent = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); };
  newCode();
  setInterval(() => { cd--; if (cd <= 0) { cd = 100; newCode(); } cdEl.textContent = cd + 's'; }, 1000);

  /* ================= 人格問卷 ================= */
  // 與實測時手機上的進場人格問卷相同
  const QS = [
    ['團隊要辦一場活動，你最想負責？', [['定目標、分配工作', 'D'], ['宣傳、炒熱氣氛', 'I'], ['幫大家打點、補位', 'S'], ['規劃流程、檢查細節', 'C']]],
    ['遇到意見不合時，你通常會？', [['直接說出我的決定', 'D'], ['用說服或開玩笑化解', 'I'], ['先聽大家、找折衷', 'S'], ['拿出資料講道理', 'C']]],
    ['朋友最常用哪個詞形容你？', [['果斷', 'D'], ['有趣', 'I'], ['可靠', 'S'], ['細心', 'C']]],
    ['截止日前一天，你會？', [['衝刺把事情做完', 'D'], ['揪人一起趕工', 'I'], ['照原本步調穩穩做', 'S'], ['再檢查一遍確保沒錯', 'C']]],
  ];
  const TYPES = {
    D: ['tiger', '老虎', '目標導向、行動派，習慣先開口的那一個。'],
    I: ['peacock', '孔雀', '熱情、愛表達，走到哪裡都能聊起來。'],
    S: ['koala', '無尾熊', '溫和、重視和諧，是大家安心的存在。實測現場最多的一型（14 人）。'],
    C: ['owl', '貓頭鷹', '細心、講求精確，先觀察再出手。'],
    X: ['chameleon', '變色龍', '沒有明顯偏向，看場合調整自己。'],
  };
  const quizBody = $('#quizBody');
  let qi = 0, score = {};
  function renderQ() {
    if (qi >= QS.length) return renderResult();
    const [q, opts] = QS[qi];
    quizBody.innerHTML = `<p class="quiz__prog">Q${qi + 1} / ${QS.length}</p><p class="quiz__q">${q}</p>
      <div class="quiz__opts">${opts.map(([t, k]) => `<button data-k="${k}">${t}</button>`).join('')}</div>`;
    $$('button', quizBody).forEach((b) => b.addEventListener('click', () => {
      score[b.dataset.k] = (score[b.dataset.k] || 0) + 1; qi++; renderQ();
    }));
  }
  function renderResult() {
    const top = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const k = top.length && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : 'X';
    const [ic, name, desc] = TYPES[k];
    quizBody.innerHTML = `<div class="quiz__result" aria-live="polite">
      <img class="quiz__animal" src="img/badge-${ic}.webp" alt="${name}徽章" width="160" height="160"><p class="quiz__type">你是${name}型</p><p>${desc}</p>
      <span class="quiz__bingo">🎯 賓果格子：找一個「${name}型」的人</span>
      <p>這個標籤會顯示在手機頂欄名字旁——但大螢幕上看不到。想找到同類，只能轉頭問身邊的人。</p>
      <p><button class="btn" id="quizAgain">↺ 再測一次</button></p>
      <p class="quiz__fine">四型取自坊間常見的 DISC 分類通俗版；沒有明顯偏向者為變色龍。分類結果不宜解讀為心理測驗。</p></div>`;
    $('#quizAgain').addEventListener('click', () => { qi = 0; score = {}; renderQ(); });
  }
  renderQ();

  /* ================= 前後測斜線圖 ================= */
  const slope = $('#slope');
  if (slope) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (n, a, txt) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
    const y = (v) => 310 - (v - 1) * 90, X0 = 110, X1 = 330;
    for (let v = 1; v <= 4; v++) {
      slope.append(el('line', { x1: 60, x2: 500, y1: y(v), y2: y(v), stroke: '#e4d9c2', 'stroke-width': 2 }));
      slope.append(el('text', { x: 50, y: y(v) + 6, 'text-anchor': 'end', class: 'num', fill: '#6b6f7a' }, v));
    }
    slope.append(el('text', { x: X0, y: 334, 'text-anchor': 'middle', 'font-weight': 700, 'font-size': 15 }, '前測'));
    slope.append(el('text', { x: X1, y: 334, 'text-anchor': 'middle', 'font-weight': 700, 'font-size': 15 }, '後測'));
    const DATA = [
      ['群體歸屬感', 2.52, 3.40, '#3fa79c', 'p ≈ .003・r = .60', -10],
      ['與現場同學認識程度', 2.44, 2.88, '#4f6db5', 'p ≈ .013・r = .50', 6],
      ['用手機做無關的事', 2.32, 1.64, '#e8684a', 'p ≈ .018・r = .47', 22],
    ];
    const groups = DATA.map(([name, a, b, color, p, off]) => {
      const g = el('g', { class: 'grp', tabindex: 0 });
      g.append(el('path', { class: 'line', d: `M${X0} ${y(a)} L${X1} ${y(b)}`, stroke: color }));
      g.append(el('rect', { x: X0 - 7, y: y(a) - 7, width: 14, height: 14, fill: color, stroke: '#2b2f3a', 'stroke-width': 2 }));
      g.append(el('text', { x: X0 - 14, y: y(a) + off - 4, 'text-anchor': 'end', class: 'num', fill: color }, a.toFixed(2)));
      const end = el('g', { class: 'end' });
      end.append(el('rect', { x: X1 - 7, y: y(b) - 7, width: 14, height: 14, fill: color, stroke: '#2b2f3a', 'stroke-width': 2 }));
      end.append(el('text', { x: X1 + 16, y: y(b) - 2, class: 'num', fill: color }, b.toFixed(2)));
      end.append(el('text', { x: X1 + 64, y: y(b) - 4, 'font-size': 14, 'font-weight': 700, fill: '#2b2f3a' }, name));
      end.append(el('text', { x: X1 + 64, y: y(b) + 14, 'font-size': 12, fill: '#6b6f7a' }, p));
      g.append(end);
      slope.append(g);
      return g;
    });
    const focus = (g) => groups.forEach((o) => o.classList.toggle('dim', g && o !== g));
    groups.forEach((g) => {
      g.addEventListener('mouseenter', () => focus(g)); g.addEventListener('focus', () => focus(g));
      g.addEventListener('mouseleave', () => focus(null)); g.addEventListener('blur', () => focus(null));
    });
    new IntersectionObserver(([e], o) => { if (e.isIntersecting) { slope.classList.add('in'); o.disconnect(); } }, { threshold: 0.3 }).observe(slope);
  }

  /* ================= 回饋問卷長條 ================= */
  const FB = [
    ['投入與趣味', [['這次的互動過程很好玩', 4.38], ['我對今天的活動投入程度', 4.27], ['我會想再參加一次類似的活動', 4.04], ['我會推薦別人參加', 4.08]]],
    ['角色與參與感', [['在大螢幕上很快找到自己的角色', 4.31], ['看到自己的角色讓我有參與感', 4.19], ['我喜歡自己的角色', 4.12], ['想把大合照分享到社群', 3.46]]],
    ['易用性', [['很容易使用，可以輕易上手', 4.23], ['能在手機上清楚看到任務與進度', 4.27], ['很快學會怎麼參加各個任務', 4.12]]],
    ['社交效果', [['系統讓我比較容易開口搭話', 3.58], ['更願意主動跟不熟的人互動', 3.58], ['對群體的歸屬感增加了', 3.46], ['任務確實幫助我認識了現場的人', 3.23]]],
    ['系統表現', [['進場到開始互動的等待可以接受', 3.73], ['操控時角色反應很即時', 3.54], ['功能足以支撐整場活動', 3.08], ['沒有遇到卡住、斷線或延遲', 2.77]]],
  ];
  const barsEl = $('#bars');
  const color = (v) => (v >= 4 ? '#3fa79c' : v >= 3.4 ? '#f4b942' : '#e8684a');
  FB.forEach(([name, items]) => {
    const avg = items.reduce((s, [, v]) => s + v, 0) / items.length;
    const b = document.createElement('button');
    b.className = 'bar';
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = `<div class="bar__top"><span class="bar__name">${name}</span><span class="bar__track"><span class="bar__fill" style="display:block;background:${color(avg)}" data-w="${((avg - 1) / 4) * 100}"></span></span><span class="bar__val">${avg.toFixed(2)}</span></div>
      <div class="bar__items">${items.map(([t, v]) => `<div><span>${t}</span><span style="color:${color(v) === '#f4b942' ? '#a77a14' : color(v)}">${v.toFixed(2)}</span></div>`).join('')}</div>`;
    b.addEventListener('click', () => { const o = b.classList.toggle('is-open'); b.setAttribute('aria-expanded', o); });
    barsEl.appendChild(b);
  });
  const axis = document.createElement('div');
  axis.className = 'bars__axis';
  axis.innerHTML = '<span></span><div><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div><span></span>';
  barsEl.appendChild(axis);
  new IntersectionObserver(([e], o) => {
    if (!e.isIntersecting) return;
    $$('.bar__fill', barsEl).forEach((f) => (f.style.width = f.dataset.w + '%'));
    o.disconnect();
  }, { threshold: 0.3 }).observe(barsEl);

  /* ================= 團隊頭像 ================= */
  const lines = ['嗨！', '你是哪一型？', '配對碼幾號？', '一起拍合照！', '謝謝來玩！'];
  $$('.avatar').forEach((cv) => {
    const host = cv.closest('.member, .advisor');
    const hi = () => {
      cv.classList.remove('jump'); void cv.offsetWidth; cv.classList.add('jump');
      host.querySelector('.bubble')?.remove();
      const b = document.createElement('span');
      b.className = 'bubble';
      b.textContent = host.classList.contains('advisor') ? '加油！' : lines[Math.floor(Math.random() * lines.length)];
      if (host.classList.contains('advisor')) { b.style.left = '58px'; }
      host.style.position = 'relative';
      host.appendChild(b);
      setTimeout(() => b.remove(), 1400);
    };
    host.addEventListener('click', hi);
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hi(); } });
  });

  /* ================= 燈箱 ================= */
  const lb = $('#lightbox'), lbImg = $('img', lb), lbCap = $('p', lb);
  let lastFocus;
  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    lastFocus = b;
    lbImg.src = b.dataset.zoom; lbImg.alt = b.dataset.cap; lbCap.textContent = b.dataset.cap;
    lb.hidden = false; $('.lightbox__close', lb).focus();
  }));
  const closeLb = () => { lb.hidden = true; lastFocus && lastFocus.focus(); };
  lb.addEventListener('click', (e) => { if (e.target !== lbImg) closeLb(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.hidden) closeLb(); });
})();
