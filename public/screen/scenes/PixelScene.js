import { ZONES } from '/shared/scene.js';
import { THEME_MAP } from '/shared/themes.js';
import { ROOM_W as W, ROOM_H as H, ROOM_PAD, FLOOR_X, FLOOR_Y, spotBadge } from './pixelKit.js';

const GX = ROOM_PAD + FLOOR_X, GY = FLOOR_Y;

/**
 * Base for the procedural 2D pixel themes. Subclasses supply static config:
 *   THEME_ID, TITLE, SUBTITLE, ITEMS {propId: [kind, label, line]}, FALLBACK, paintRoom(c, zones), paintProp(c, p, kind, elapsed, reduced)
 * Interaction state is local to this screen and never written back to participants, scores or the server.
 */
export class PixelScene {
  constructor(host, props) {
    this.host = host;
    this.props = props;
    this.effects = new Map();
    this.nearby = new Set();
    this.light = 'day';
    this.manualUntil = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', `像素風互動場景：${this.constructor.TITLE}`);
    this.ctx = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.width = W; this.staticCanvas.height = H;
    this.constructor.paintRoom(this.staticCanvas.getContext('2d'), ZONES);
    this.makeControls();
    this.onResize = () => this.resize();
    addEventListener('resize', this.onResize);
    this.resize();
  }
  projectToScreen(x, y) { return { x: this.ox + (GX + x) * this.zoom, y: this.oy + (GY + y) * this.zoom }; }
  scaleAt(x, y, height) { return Number.isFinite(x + y + height) ? height * 57 * this.zoom : 0; }
  resetCamera() { this.resize(); }
  applyLight(name) { if (['day', 'evening', 'night'].includes(name)) this.light = name; }
  resize() {
    this.zoom = Math.min(innerWidth / W, innerHeight / H);
    this.ox = (innerWidth - W * this.zoom) / 2;
    this.oy = (innerHeight - H * this.zoom) / 2;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.ceil(innerWidth * this.dpr);
    this.canvas.height = Math.ceil(innerHeight * this.dpr);
    for (const [p, button] of this.buttons) {
      const point = this.projectToScreen(p.x, p.y);
      Object.assign(button.style, { left: `${point.x}px`, top: `${point.y - 28 * this.zoom}px`, width: `${Math.max(30, p.r * 1.5 * this.zoom)}px`, height: `${Math.max(30, (p.r + 75) * this.zoom)}px` });
    }
  }
  makeControls() {
    const { TITLE, SUBTITLE } = this.constructor;
    this.ui = document.createElement('div');
    this.ui.className = 'scene-ui';
    const header = document.createElement('header');
    const title = document.createElement('h1'); title.textContent = TITLE;
    const subtitle = document.createElement('p'); subtitle.textContent = SUBTITLE;
    header.append(title, subtitle);
    this.status = document.createElement('p');
    this.status.className = 'scene-status'; this.status.setAttribute('role', 'status');
    this.status.textContent = '點一下物件，或帶著角色靠近，讓場景熱鬧起來。';
    const nav = document.createElement('nav'); nav.setAttribute('aria-label', '場景光線');
    for (const [key, label] of [['day', '日光'], ['evening', '黃昏'], ['night', '夜晚']]) {
      const b = document.createElement('button'); b.textContent = label;
      b.addEventListener('click', () => this.applyLight(key)); nav.append(b);
    }
    const reset = document.createElement('button'); reset.textContent = '清除效果';
    reset.addEventListener('click', () => { this.effects.clear(); this.status.textContent = '效果已清除。'; }); nav.append(reset);
    const save = document.createElement('button'); save.textContent = '儲存畫面';
    save.addEventListener('click', () => dispatchEvent(new Event('scene-capture'))); nav.append(save);
    this.ui.append(header, nav, this.status);
    this.buttons = this.props.map(p => {
      const b = document.createElement('button');
      b.className = 'scene-object'; b.setAttribute('aria-label', `互動：${this.item(p)[1]}`);
      b.title = this.item(p)[1];
      b.addEventListener('click', () => this.activate(p));
      this.ui.append(b); return [p, b];
    });
    this.host.append(this.ui);
  }
  item(p) { return this.constructor.ITEMS[p.id] ?? this.constructor.FALLBACK; }
  spots() { return THEME_MAP[this.constructor.THEME_ID]?.spots ?? {}; }
  activate(p, now = performance.now(), manual = true) {
    if (manual) this.manualUntil = now + 4500;
    if (manual || now >= this.manualUntil) this.status.textContent = `${this.item(p)[1]} · ${this.item(p)[2]}`;
    if (now - (this.effects.get(p.id) ?? -Infinity) < 800) return;
    this.effects.set(p.id, now);
  }
  // Read-only proximity feedback. Never writes positions, avatar state, scores or protocol events.
  updateAgents(agents) {
    const next = new Set();
    for (const p of this.props) for (const a of agents) {
      if (a.offline || a.mode === 'STAGED') continue;
      if (Math.hypot(a.x - p.x, a.y - p.y) < p.r + 65) {
        const key = `${a.id}:${p.id}`; next.add(key);
        if (!this.nearby.has(key)) this.activate(p, performance.now(), false);
      }
    }
    this.nearby = next;
  }
  render(now = performance.now()) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#383c43'; c.fillRect(0, 0, innerWidth, innerHeight);
    c.translate(this.ox, this.oy); c.scale(this.zoom, this.zoom); c.imageSmoothingEnabled = false;
    c.drawImage(this.staticCanvas, 0, 0);
    c.save(); c.translate(ROOM_PAD, 0);
    for (const p of [...this.props].sort((a, b) => a.y - b.y)) {
      const started = this.effects.get(p.id);
      const elapsed = started === undefined ? -1 : (now - started) / 1000;
      this.constructor.paintProp(c, p, this.item(p)[0], elapsed, this.reduced.matches);
      if (elapsed > 4.5) this.effects.delete(p.id);
    }
    c.restore();
    const spots = this.spots();
    for (const p of this.props) if (spots[p.id]) spotBadge(c, GX + p.x, GY + p.y + 46, spots[p.id]);  // below the prop's front chair, not on it
    if (this.light !== 'day') {
      c.fillStyle = this.light === 'night' ? 'rgba(31,49,65,.34)' : 'rgba(221,131,68,.18)';
      c.fillRect(-this.ox / this.zoom, -this.oy / this.zoom, innerWidth / this.zoom, innerHeight / this.zoom);
    }
  }
  dispose() { removeEventListener('resize', this.onResize); this.canvas.remove(); this.ui.remove(); }
}
