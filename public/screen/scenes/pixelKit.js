// Shared toolkit for the procedural pixel scenes (kitchen, office, …).
// Every theme paints on the same 16:9 canvas with the same collision layout from shared/scene.js.

/** 16:9 canvas so a 1920×1080 projector fills edge to edge; the room is centred with ROOM_PAD on each side. */
export const ROOM_W = 2596, ROOM_H = 1460, ROOM_PAD = 178;
/** Logical floor origin inside the room (before ROOM_PAD). Character feet (x,y) land at (ROOM_PAD+FLOOR_X+x, FLOOR_Y+y). */
export const FLOOR_X = 160, FLOOR_Y = 270;

export const INK = '#302a2d';

export function brush(c) {
  const rect = (x,y,w,h,color) => { c.fillStyle=color; c.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h)); };
  const box = (x,y,w,h,color) => { rect(x-2,y-2,w+4,h+4,INK); rect(x,y,w,h,color); };
  const oval = (x,y,rx,ry,color) => { c.fillStyle=color;c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fill(); };
  const line = (x,y,xx,yy,color,width=2) => {c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x,y);c.lineTo(xx,yy);c.stroke();};
  const plate = (x,y,r=13) => { oval(x,y,r,r*.55,INK);oval(x,y-1,r-2,r*.55-2,'#f5efdc');oval(x,y-1,r*.62,r*.3,'#bdd2cf'); };
  const bottle = (x,y,color) => {box(x-6,y-18,12,19,color);rect(x-3,y-24,6,7,'#b59b7c');rect(x-4,y-11,8,6,'#f2e2bc');rect(x-3,y-17,2,5,'#ffffff70');};
  const leaf = (x,y,color) => {rect(x-8,y-5,16,10,color);rect(x-5,y-9,10,18,color);rect(x-3,y-4,5,6,'#ffffff20');};
  return {rect,box,oval,line,plate,bottle,leaf};
}

// Deterministic 0..1 noise so the static layer is identical on every screen and reload.
export const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/** Floating name pill, as used for zone labels. */
export function pill(c, x, y, text, dot = '#7fd28a', alignRight = false) {
  c.font = 'bold 17px "Microsoft JhengHei", sans-serif';
  const w = c.measureText(text).width + 46;
  if (alignRight) x -= w;
  c.fillStyle = '#23272dd9'; c.beginPath(); c.roundRect(x, y, w, 32, 16); c.fill();
  c.fillStyle = dot; c.beginPath(); c.ellipse(x + 18, y + 16, 5, 5, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#f4ecdc'; c.textAlign = 'left'; c.fillText(text, x + 31, y + 22);
}

/**
 * Numbered spot badge (「1號桌」). Spots come from shared/themes.js so future missions
 * ("wearing white? meet at desk 1") and the picture always agree on which prop is which.
 */
export function spotBadge(c, x, y, label) {
  c.font = 'bold 18px "Microsoft JhengHei", sans-serif';
  const w = c.measureText(label).width + 22;
  c.fillStyle = INK; c.beginPath(); c.roundRect(x - w / 2 - 2, y - 2, w + 4, 30, 8); c.fill();
  c.fillStyle = '#ffd66b'; c.beginPath(); c.roundRect(x - w / 2, y, w, 26, 7); c.fill();
  c.fillStyle = INK; c.textAlign = 'center'; c.fillText(label, x, y + 19);
}
