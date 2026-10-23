import { ZONES } from '/shared/scene.js';
import { THEME_MAP } from '/shared/themes.js';
import { ROOM_W as W, ROOM_H as H, FLOOR_Y, CHARACTER_SCALE, spotBadge } from './pixelKit.js';
import { stageViewport, onStageViewportChange } from '../stageViewport.js';

// 舞台座標 → 圖面座標：純平移，沒有縮放。舞台寬度就是整張圖的寬度，
// 因此 x 是 1:1；y 只差一個 FLOOR_Y（上方那段牆不屬於舞台）。
// 與 shared/protocol.js 的 STAGE 必須同進退，見那裡的註解。
const GX = 0, GY = FLOOR_Y;

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
    // 題目橫幅出現／消失時可用區會變，房間要重新置中到剩下的空間
    this.offViewport = onStageViewportChange(this.onResize);
    this.resize();
  }
  projectToScreen(x, y) { return { x: this.ox + (GX + x) * this.zoom, y: this.oy + (GY + y) * this.zoom }; }
  scaleAt(x, y, height) { return Number.isFinite(x + y + height) ? height * CHARACTER_SCALE * this.zoom : 0; }
  resetCamera() { this.resize(); }
  /** 房間在視窗裡的位置（CSS px）。合照只截這一塊：剛好 16:9，不含兩側的深色邊（screen.js captureStageFrame） */
  roomRect() { return { x: this.ox, y: this.oy, w: W * this.zoom, h: H * this.zoom }; }
  applyLight(name) { if (['day', 'evening', 'night'].includes(name)) this.light = name; }
  resize() {
    // 畫布仍是整個視窗（背景色要鋪滿），但房間只縮放並置中到可用區裡 ——
    // 橫幅佔掉的那一條因此不會蓋到任何角色。
    const vp = stageViewport();
    this.zoom = Math.min(vp.width / W, vp.height / H);
    this.ox = vp.x + (vp.width - W * this.zoom) / 2;
    this.oy = vp.y + (vp.height - H * this.zoom) / 2;
    // 主控台的預覽小窗（screen.js 的 ?preview=1）只有幾百 px 寬，用密度 1 省下四分之三的填色
    const maxDpr = document.documentElement.classList.contains('is-preview') ? 1 : 2;
    this.dpr = Math.min(devicePixelRatio || 1, maxDpr);
    this.canvas.width = Math.ceil(innerWidth * this.dpr);
    this.canvas.height = Math.ceil(innerHeight * this.dpr);
  }
  makeControls() {
    // 大螢幕上不放任何可點的東西（2026-10-17）：投影畫面現場沒人點得到，原本物件上的
    // 透明按鈕與底部「點一下物件……」的提示列都拿掉了。標題卡（活動名稱）由 screen.js
    // 依主辦端設定繪製；大螢幕的操作都在主辦端。角色走近物件時的小動畫仍在（updateAgents）。
    this.ui = document.createElement('div');
    this.ui.className = 'scene-ui';
    this.host.append(this.ui);
  }
  item(p) { return this.constructor.ITEMS[p.id] ?? this.constructor.FALLBACK; }
  spots() { return THEME_MAP[this.constructor.THEME_ID]?.spots ?? {}; }
  activate(p, now = performance.now()) {
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
        if (!this.nearby.has(key)) this.activate(p, performance.now());
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
    for (const p of [...this.props].sort((a, b) => a.y - b.y)) {
      const started = this.effects.get(p.id);
      const elapsed = started === undefined ? -1 : (now - started) / 1000;
      this.constructor.paintProp(c, p, this.item(p)[0], elapsed, this.reduced.matches);
      if (elapsed > 4.5) this.effects.delete(p.id);
    }
    const spots = this.spots();
    for (const p of this.props) if (spots[p.id]) spotBadge(c, GX + p.x, GY + p.y + 46, spots[p.id]);  // below the prop's front chair, not on it
    if (this.light !== 'day') {
      c.fillStyle = this.light === 'night' ? 'rgba(31,49,65,.34)' : 'rgba(221,131,68,.18)';
      c.fillRect(-this.ox / this.zoom, -this.oy / this.zoom, innerWidth / this.zoom, innerHeight / this.zoom);
    }
  }
  /**
   * 畫一張靜止的房間（底圖、道具、桌號、燈光）到另一張畫布，給大合照用（screen/photoRender.js）。
   * 不碰這個場景自己的畫布與動畫狀態：拍合照不能改變大螢幕的畫面。
   */
  paintStill(c) {
    c.drawImage(this.staticCanvas, 0, 0);
    for (const p of [...this.props].sort((a, b) => a.y - b.y)) {
      this.constructor.paintProp(c, p, this.item(p)[0], -1, true);
    }
    const spots = this.spots();
    for (const p of this.props) if (spots[p.id]) spotBadge(c, GX + p.x, GY + p.y + 46, spots[p.id]);
    if (this.light !== 'day') {
      c.fillStyle = this.light === 'night' ? 'rgba(31,49,65,.34)' : 'rgba(221,131,68,.18)';
      c.fillRect(0, 0, W, H);
    }
  }
  dispose() { removeEventListener('resize', this.onResize); this.offViewport?.(); this.canvas.remove(); this.ui.remove(); }
}
