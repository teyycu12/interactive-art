// Office theme: procedural pixel illustration in the spirit of a virtual co-working floor plan.
// Same shared PROPS / ZONES as every other theme; only the look and the prop names change.
import { INK, brush, hash, pill, ROOM_W, ROOM_H, ROOM_PAD } from './pixelKit.js';

const O = {
  corridor: '#ede3d3', corridorLine: '#e2d6c3',
  cap: '#2e343e', capEdge: '#566070', wall: '#465260', wallSeam: '#3e4956', wallLight: '#52606f',
  seam: '#c2b29a', planks: ['#dccdb6', '#d6c7af', '#e0d2bc', '#d2c2a9'], plankHi: '#e6dac6', grain: '#cbbba2',
  glass: '#8fd0cc', glassHi: '#c3ebe6', frame: '#2e343e',
  desk: '#f1f2f0', deskEdge: '#c9cdd1', wood: '#c69a6c', woodLight: '#dcb487', woodDark: '#8d6645',
  chair: '#3a4049', chairHi: '#555d69', screen: '#3d6f8f', screenHi: '#7fb8d8',
  leafA: '#4f8a55', leafB: '#63a063', leafC: '#80b96f', pot: '#e9e5dc',
  peach: '#e8a07a', peachHi: '#f2b894', peachDark: '#c47e5c',
};

export function paintOfficeRoom(c, zones) {
  paintCorridors(c);
  c.save(); c.translate(ROOM_PAD, 0); paintOfficeCore(c, zones); c.restore();
  paintLobby(c);
  paintGameRoom(c);
}

// Small reusable pieces -------------------------------------------------------
function kit(c) {
  const b = brush(c);
  const { rect, box, oval, leaf } = b;
  const plant = (x, y, s = 1, variant = 0) => {
    oval(x + 3, y + 4, 20 * s, 7 * s, '#2a1f1a33');
    box(x - 12 * s, y - 20 * s, 24 * s, 22 * s, O.pot); rect(x - 12 * s, y - 20 * s, 24 * s, 4 * s, '#f7f5f0');
    const tones = [[O.leafA, O.leafB, O.leafC], ['#3f7a5b', '#56946d', '#79b58a'], ['#5b8c3f', '#77a852', '#9cc46a']][variant % 3];
    for (let i = 0; i < 9; i++) leaf(x + Math.sin(i * 2.4) * 16 * s, y - 36 * s + Math.cos(i * 2.4) * 14 * s, tones[i % 3]);
    for (let i = 0; i < 3; i++) leaf(x + (i - 1) * 7 * s, y - (34 + (i % 2) * 10) * s, tones[(i + 1) % 3]);
  };
  const monitor = (x, y, lit) => { box(x - 16, y - 24, 32, 20, O.chair); rect(x - 13, y - 21, 26, 14, lit ? '#8fe0a6' : O.screen); rect(x - 13, y - 21, 26, 3, lit ? '#c9f5d4' : O.screenHi); rect(x - 3, y - 4, 6, 5, O.chair); };
  const chairTop = (x, y, color = O.chair) => { oval(x + 2, y + 6, 15, 6, '#2a1f1a33'); box(x - 13, y - 22, 26, 12, color); box(x - 15, y - 10, 30, 16, color); rect(x - 11, y - 8, 22, 3, O.chairHi); };
  const book = (x, y, h, color) => { rect(x, y - h, 8, h, color); rect(x, y - h, 8, 2, '#ffffff40'); };
  return { ...b, plant, monitor, chairTop, book };
}

function paintCorridors(c) {
  const { rect, plant } = kit(c);
  rect(0, 0, ROOM_W, ROOM_H, O.corridor);
  for (let y = 0; y < ROOM_H; y += 48) rect(0, y, ROOM_W, 2, O.corridorLine);
  for (let x = 0; x < ROOM_W; x += 96) for (let y = 0; y < ROOM_H; y += 96) rect(x + (y / 96 % 2) * 48, y, 2, 48, O.corridorLine);
  for (let x = 360; x < 2260; x += 220) { plant(x, 1440, .8, x % 3); }
}

// Room ------------------------------------------------------------------------
function paintOfficeCore(c, zones) {
  const { rect, box, oval, line, plant, book, monitor } = kit(c);
  const FX = 160, FY = 270, FW = 1920, FH = 1080, FR = FX + FW, FB = FY + FH;

  // Floor: light oak vinyl planks.
  rect(FX, FY, FW, FH, O.seam);
  for (let row = 0; row < FH / 36; row++) {
    const y = FY + row * 36;
    let x = FX - Math.floor(hash(row, 17) * 240), i = 0;
    while (x < FR) {
      const len = 180 + Math.floor(hash(row, ++i + 300) * 4) * 40;
      const l = Math.max(x, FX), r = Math.min(x + len - 2, FR);
      if (r > l) {
        rect(l, y, r - l, 34, O.planks[Math.floor(hash(i + 40, row) * 4)]);
        rect(l, y, r - l, 2, O.plankHi);
        if (r - l > 100) rect(l + 20 + hash(row, i) * (r - l - 90), y + 16, 50, 2, O.grain);
      }
      x += len;
    }
  }

  // Zones: carpet tiles for desks, patterned carpet for meetings, diamond carpet for the lounge.
  for (const z of zones) {
    const x = FX + z.x, y = FY + z.y;
    rect(x - 5, y - 3, z.w + 10, z.h + 10, '#2b221c26');
    if (z.id === 'bar') {
      rect(x, y, z.w, z.h, '#7b818a');
      for (let yy = 0; yy < z.h; yy += 48) for (let xx = 0; xx < z.w; xx += 48) {
        const w = Math.min(46, z.w - xx - 1), h = Math.min(46, z.h - yy - 1), alt = (xx / 48 + yy / 48) % 2;
        rect(x + xx + 1, y + yy + 1, w, h, alt ? '#8a9099' : '#838992');
        for (let k = 0; k < 4; k++) rect(x + xx + 6 + k * 10, y + yy + (alt ? 8 + k * 9 : 36 - k * 9), 6, 2, alt ? '#959ba4' : '#7a808a');
      }
    } else if (z.id === 'stage') {
      rect(x, y, z.w, z.h, '#5f6f84');
      for (let yy = 0; yy < z.h; yy += 12) for (let xx = (yy / 12 % 2) * 12; xx < z.w; xx += 24) rect(x + xx, y + yy, 10, 4, '#687a90');
      c.strokeStyle = '#8697ab'; c.lineWidth = 3; c.strokeRect(x + 12, y + 12, z.w - 24, z.h - 24);
    } else {
      rect(x, y, z.w, z.h, '#e9ecef');
      for (let yy = 0; yy < z.h; yy += 40) for (let xx = 0; xx < z.w; xx += 40) {
        c.fillStyle = (xx / 40 + yy / 40) % 2 ? '#dfe3e8' : '#f2f4f6';
        c.beginPath(); c.moveTo(x + xx + 20, y + yy + 2); c.lineTo(x + xx + 38, y + yy + 20); c.lineTo(x + xx + 20, y + yy + 38); c.lineTo(x + xx + 2, y + yy + 20); c.fill();
      }
      c.strokeStyle = '#b9c0c9'; c.lineWidth = 8; c.strokeRect(x + 4, y + 4, z.w - 8, z.h - 8);
    }
    const label = { stage: '會議室 MEETING', bar: '開放工作區 DESKS', lounge: '休息區 LOUNGE' }[z.id] ?? z.label;
    // The whiteboard and coffee machine crowd the left edges of these two zones, so their pills hang from the right.
    const right = z.id === 'bar' || z.id === 'stage';
    pill(c, right ? x + z.w - 12 : x + 12, y - 16, label, { stage: '#8fb7ef', bar: '#7fd28a', lounge: '#f0b36b' }[z.id], right);
  }

  // Round rug under the shared table.
  oval(1332, 1276, 200, 96, '#2b221c26'); oval(1330, 1270, 196, 92, '#8d9bb0'); oval(1330, 1270, 180, 80, '#a6b3c6');
  for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; rect(1330 + Math.cos(a) * 150 - 3, 1270 + Math.sin(a) * 64 - 3, 6, 6, '#c9d2de'); }

  // Ambient occlusion along the walls.
  rect(FX, FY, FW, 12, '#2b1f1830'); rect(FX, FY + 12, FW, 10, '#2b1f1818');
  rect(FX, FY, 10, FH, '#2b1f181f'); rect(FR - 10, FY, 10, FH, '#2b1f181f');
  c.save(); c.globalAlpha = .12; c.fillStyle = '#ffffff';
  for (const x of [580, 1270]) { c.beginPath(); c.moveTo(x, FY); c.lineTo(x + 300, FY); c.lineTo(x + 400, FY + 180); c.lineTo(x + 90, FY + 180); c.fill(); }
  c.restore();

  // ── Back wall ──
  rect(FX, 44, FW, FY - 44, O.wall);
  for (let x = FX; x < FR; x += 64) { rect(x, 44, 2, 176, O.wallSeam); rect(x + 2, 44, 1, 176, O.wallLight); }

  // Floor-to-ceiling windows with a city skyline.
  const windowAt = (x, w) => {
    box(x, 56, w, 158, O.frame); rect(x + 4, 60, w - 8, 150, '#a9dcd8');
    for (let i = 0; i < 3; i++) oval(x + 50 + i * 110, 84 + (i % 2) * 10, 28, 8, '#e8f6f4');
    for (let i = 0, bx = x + 6; bx < x + w - 10; i++) {
      const bw = 30 + Math.floor(hash(i, x) * 3) * 12, bh = 40 + Math.floor(hash(x, i) * 5) * 16;
      const right = Math.min(bx + bw, x + w - 4);
      rect(bx, 210 - bh, right - bx, bh, i % 2 ? '#6fa9a8' : '#7fb8b5');
      for (let wy = 216 - bh; wy < 204; wy += 12) for (let wx = bx + 5; wx < right - 6; wx += 10) rect(wx, wy, 5, 6, '#b9e2de');
      bx += bw + 4;
    }
    for (let k = 1; k < 3; k++) rect(x + k * w / 3 - 2, 60, 5, 150, O.frame);
    rect(x + 4, 132, w - 8, 4, O.frame);
    rect(x + 12, 66, 3, 50, '#ffffff80'); rect(x + 18, 66, 3, 28, '#ffffff60');
  };
  windowAt(580, 330); windowAt(1270, 330);

  // Whiteboard with a chart and sticky notes.
  box(190, 62, 220, 116, '#f7f8f6'); rect(190, 62, 220, 5, '#d5d9dd');
  line(210, 150, 250, 118, '#d9593f', 3); line(250, 118, 290, 132, '#d9593f', 3); line(290, 132, 340, 90, '#d9593f', 3);
  for (let i = 0; i < 4; i++) rect(214 + i * 30, 160 - i * 8, 18, i * 8 + 4, '#5f8fa5');
  for (const [x, y, col] of [[356, 80, '#ffe07a'], [382, 92, '#9fd8a3'], [356, 116, '#f4a7b9'], [384, 128, '#8fc4ea']]) { rect(x, y, 20, 20, col); rect(x, y, 20, 4, '#ffffff50'); }
  rect(200, 180, 200, 5, '#9aa1a8'); rect(230, 176, 16, 4, '#2f5b92'); rect(252, 176, 16, 4, '#d9593f');

  // Round greeting sign (generic, no brand).
  oval(488, 116, 46, 46, INK); oval(488, 116, 42, 42, '#f3e5c3'); oval(488, 116, 36, 36, '#f7eed8');
  c.fillStyle = INK; c.textAlign = 'center'; c.font = 'italic bold 14px Georgia, serif'; c.fillText('Hello', 488, 108);
  c.font = 'bold 18px "Microsoft JhengHei", sans-serif'; c.fillText('TEAM', 488, 132);

  // TV with a dashboard and a wall clock.
  box(960, 70, 190, 110, '#23272d'); rect(966, 76, 178, 98, '#304a60');
  for (let i = 0; i < 6; i++) rect(978 + i * 26, 160 - (hash(i, 5) * 60 + 14), 16, hash(i, 5) * 60 + 14, ['#7fd28a', '#8fc4ea', '#f0b36b'][i % 3]);
  rect(978, 86, 70, 5, '#c9d8e6'); rect(978, 96, 44, 3, '#8aa5bd');
  rect(1050, 180, 10, 10, '#23272d');
  oval(1204, 104, 28, 28, O.cap); oval(1204, 104, 24, 24, '#f4f4f0');
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; rect(1204 + Math.cos(a) * 18 - 1, 104 + Math.sin(a) * 18 - 1, 3, 3, '#6d6f74'); }
  line(1204, 104, 1204, 90, INK, 3); line(1204, 104, 1215, 110, INK, 3);

  // Cork pinboard, team poster and a wall bookshelf.
  box(1630, 66, 160, 110, '#c49a6c'); rect(1636, 72, 148, 98, '#d7b184');
  for (let i = 0; i < 8; i++) { const x = 1644 + (i % 4) * 34, y = 80 + Math.floor(i / 4) * 44; rect(x, y, 26, 30, ['#ffe07a', '#9fd8a3', '#f4a7b9', '#8fc4ea', '#f7f3ea'][i % 5]); oval(x + 13, y + 2, 3, 3, '#c9463a'); rect(x + 4, y + 12, 16, 2, '#9a8b74'); }
  box(1812, 70, 96, 110, '#f7f3ea'); rect(1818, 76, 84, 40, '#2f5b92');
  c.fillStyle = '#f7f3ea'; c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.fillText('TEAM', 1860, 94); c.fillText('WORK', 1860, 110);
  for (let i = 0; i < 3; i++) oval(1836 + i * 24, 146, 9, 9, ['#e98b3a', '#7fd28a', '#d9593f'][i]);
  for (const y of [110, 170]) { box(1930, y, 132, 8, O.wood); rect(1930, y, 132, 3, O.woodLight); }
  for (let i = 0; i < 11; i++) book(1936 + i * 11, 110, 26 + (i % 3) * 6, ['#c9463a', '#2f5b92', '#e7b54a', '#4f8a55', '#7c6aa8'][i % 5]);
  for (let i = 0; i < 6; i++) book(1936 + i * 11, 170, 30 - (i % 2) * 6, ['#e98b3a', '#5f8fa5', '#b58585'][i % 3]);
  oval(2030, 158, 12, 12, '#4d8fc0'); rect(2024, 152, 8, 6, '#7fb86f'); box(2020, 166, 20, 4, O.woodDark);

  // Low credenza along the wall, with everyday office clutter.
  rect(FX, 216, FW, 12, O.woodLight); rect(FX, 216, FW, 3, '#ecc99d'); rect(FX, 226, FW, 3, O.woodDark);
  rect(FX, 229, FW, 35, O.desk);
  for (let x = FX; x < FR; x += 96) { box(x + 4, 233, 88, 27, '#e1e4e6'); rect(x + 44, 244, 8, 3, '#9aa1a8'); }
  rect(FX, 262, FW, 8, O.cap);
  for (const x of [260, 540, 940, 1240, 1620, 1990]) plant(x, 218, .8, x % 3);
  box(330, 196, 52, 20, '#e7e9eb'); rect(334, 192, 44, 6, '#f7f8f6'); rect(340, 204, 32, 3, '#9aa1a8');
  for (let i = 0; i < 3; i++) box(420 + i * 14, 184 - i * 6, 10, 32 + i * 6, ['#e7b54a', '#c9463a', '#2f5b92'][i]);
  box(1010, 196, 18, 20, '#e7b54a'); rect(1004, 188, 30, 10, '#e7b54a'); rect(1012, 184, 14, 4, '#f5d77a');
  box(1100, 194, 40, 22, '#f7f8f6'); rect(1104, 198, 32, 4, '#c9cdd1');
  box(1350, 200, 70, 16, '#c9cdd1'); box(1440, 194, 26, 22, '#5f8fa5'); rect(1446, 190, 14, 4, INK);
  box(1760, 190, 60, 26, '#3d4a4e'); rect(1766, 194, 48, 14, '#7fb8d8');
  monitor(1880, 216, false);

  // ── Side and bottom walls; glass entrance door at the bottom ──
  rect(120, 24, 2000, 22, O.cap); rect(120, 44, 2000, 3, O.capEdge);
  for (const x of [122, FR]) {
    rect(x, 24, 38, FB + 36 - 24, O.cap);
    rect(x === 122 ? FX - 4 : FR, 46, 4, FB - 46, O.capEdge);
    for (let y = 150; y < FB; y += 260) { box(x + 8, y, 22, 60, O.glass); rect(x + 10, y + 4, 4, 30, O.glassHi); }
  }
  for (const [l, r] of [[122, 830], [1110, 2118]]) { rect(l, FB, r - l, 36, O.cap); rect(l, FB, r - l, 3, O.capEdge); }
  for (const x of [814, 1110]) box(x, FB - 6, 16, 44, '#9aa1a8');
  rect(830, FB + 4, 280, 28, O.glass); rect(968, FB + 4, 4, 28, O.frame); rect(840, FB + 8, 40, 4, O.glassHi); rect(980, FB + 8, 40, 4, O.glassHi);
  box(846, 1288, 248, 50, '#4a5260'); rect(854, 1296, 232, 34, '#5d6675');
  c.fillStyle = '#e9edf2'; c.font = 'bold 18px monospace'; c.textAlign = 'center'; c.fillText('WELCOME', 970, 1320);
}

// Left margin: reception lobby -------------------------------------------------
function paintLobby(c) {
  const { rect, box, oval, line, plant, monitor, chairTop } = kit(c);
  rect(0, 0, 14, ROOM_H, O.cap);
  // Reception desk.
  rect(40, 150, 230, 12, '#2a1f1a26');
  box(40, 96, 220, 54, O.woodLight); rect(40, 96, 220, 10, O.desk); rect(40, 104, 220, 3, O.deskEdge);
  for (let x = 48; x < 256; x += 24) rect(x, 112, 3, 34, O.wood);
  c.fillStyle = INK; c.font = 'bold 14px monospace'; c.textAlign = 'center'; c.fillText('RECEPTION', 150, 134);
  monitor(90, 98, false); oval(210, 96, 9, 5, '#e7b54a'); rect(206, 88, 8, 6, '#e7b54a'); plant(248, 96, .6, 1);
  chairTop(120, 70);

  // Two glass phone booths.
  for (const [y, lit] of [[260, false], [490, true]]) {
    rect(46, y + 170, 200, 10, '#2a1f1a26');
    box(44, y, 196, 168, '#3a4049'); rect(50, y + 6, 184, 156, lit ? '#c9e8e2' : '#b7dcd8');
    rect(56, y + 12, 6, 80, '#ffffff70');
    box(150, y + 40, 70, 28, O.woodLight); chairTop(120, y + 110, '#e98b3a');
    if (lit) monitor(186, y + 40, true); else box(172, y + 26, 22, 14, '#9aa1a8');
    rect(44, y + 166, 196, 4, '#3a4049');
    c.fillStyle = '#f4ecdc'; c.font = 'bold 12px monospace'; c.textAlign = 'center';
    rect(104, y - 16, 76, 18, '#3a4049'); c.fillText(lit ? 'IN USE' : 'PHONE', 142, y - 3);
  }

  // Lockers.
  for (let i = 0; i < 4; i++) {
    const y = 730 + i * 64;
    box(26, y, 60, 58, '#9fb0c2'); rect(30, y + 4, 52, 3, '#c3d0dc');
    rect(76, y + 22, 3, 14, '#5f6f84');
    c.fillStyle = '#3a4a5c'; c.font = 'bold 12px monospace'; c.textAlign = 'center'; c.fillText(String(i + 1).padStart(2, '0'), 48, y + 38);
  }
  // Waiting sofa and coffee table.
  rect(130, 820, 140, 12, '#2a1f1a26');
  box(130, 740, 140, 30, '#5f8fa5'); box(130, 768, 140, 44, '#6f9fb5'); rect(134, 772, 132, 5, '#8fbccf');
  for (const x of [130, 258]) box(x, 750, 12, 62, '#5f8fa5');
  oval(200, 890, 44, 22, INK); oval(200, 888, 41, 19, O.woodLight); oval(200, 884, 32, 13, '#e8c595');
  rect(186, 874, 26, 4, '#f7f3ea'); rect(190, 868, 18, 5, '#c9463a');
  // Coat rack, umbrella stand, plants.
  oval(210, 1070, 26, 8, '#2a1f1a33'); rect(208, 980, 5, 90, '#5c4a3a');
  for (const [dx, dy, col] of [[-18, 996, '#c9463a'], [16, 1000, '#2f5b92'], [-12, 1016, '#e7b54a']]) { line(210, 986, 210 + dx, dy, '#5c4a3a', 3); box(210 + dx - 7, dy, 14, 24, col); }
  box(80, 1040, 30, 36, '#3a4049'); for (const [dx, col] of [[-6, '#d9593f'], [4, '#2f5b92'], [12, '#4f8a55']]) rect(90 + dx, 1012, 4, 30, col);
  plant(60, 1200, 1.2, 0); plant(150, 1250, 1, 2); plant(240, 1190, 1.1, 1);
  plant(260, 690, .9, 2);
}

// Right margin: game room -------------------------------------------------------
function paintGameRoom(c) {
  const { rect, box, oval, line, plant, chairTop } = kit(c);
  rect(ROOM_W - 14, 0, 14, ROOM_H, O.cap);
  const L = 2306, R = 2582;
  // Warm wood floor for the game room.
  rect(L, 40, R - L, 1340, '#b58a62');
  for (let y = 40, r = 0; y < 1380; y += 30, r++) { rect(L, y + 1, R - L, 27, ['#c49a70', '#bd9269', '#c9a076'][r % 3]); rect(L, y + 1, R - L, 2, '#d3ab82'); }
  c.fillStyle = '#23272dd9'; c.beginPath(); c.roundRect(L + 64, 52, 150, 30, 15); c.fill();
  c.fillStyle = '#f4ecdc'; c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.fillText('GAME ROOM', L + 139, 73);

  // Ping-pong table (portrait) with paddles.
  rect(2360, 128, 180, 250, '#2a1f1a30');
  box(2352, 118, 176, 248, '#3f8f62'); rect(2356, 122, 168, 240, '#4fa272');
  c.strokeStyle = '#f4f4ee'; c.lineWidth = 3; c.strokeRect(2360, 126, 160, 232); line(2440, 126, 2440, 358, '#f4f4ee', 2);
  rect(2344, 238, 192, 8, '#e8e8e2'); for (let x = 2348; x < 2534; x += 8) rect(x, 240, 4, 4, '#9aa1a8');
  for (const [x, y, col] of [[2400, 100, '#d9493a'], [2480, 392, '#2f5b92']]) { oval(x, y, 13, 13, INK); oval(x, y, 11, 11, col); rect(x - 3, y + 10, 6, 12, '#8d6645'); }
  oval(2470, 190, 5, 5, '#fff7e0');

  // Foosball table.
  rect(2352, 474, 190, 130, '#2a1f1a30');
  box(2346, 462, 184, 126, '#3a4049'); rect(2354, 470, 168, 110, '#58a86f');
  line(2438, 470, 2438, 580, '#e8f3e6', 2); oval(2438, 525, 16, 16, '#58a86f'); c.strokeStyle = '#e8f3e6'; c.lineWidth = 2; c.beginPath(); c.arc(2438, 525, 16, 0, Math.PI * 2); c.stroke();
  for (let k = 0; k < 6; k++) {
    const x = 2364 + k * 30; rect(x, 450, 4, 150, '#c9cdd1'); box(x - 5, 444, 14, 10, '#23272d'); box(x - 5, 596, 14, 10, '#23272d');
    for (let j = 0; j < 3; j++) box(x - 4, 490 + j * 32, 12, 10, k % 2 ? '#d9493a' : '#2f5b92');
  }

  // Bean bags around a low table.
  oval(2444, 766, 40, 20, INK); oval(2444, 764, 37, 17, '#f1f2f0'); rect(2434, 752, 18, 8, '#e7b54a');
  for (const [x, y, col, hi] of [[2362, 720, '#4d8fc0', '#7ab3de'], [2526, 724, '#e7b54a', '#f5d77a'], [2380, 830, '#8f6ac0', '#b394de'], [2512, 836, '#e98b3a', '#f5ad6d']]) {
    oval(x + 3, y + 14, 30, 10, '#2a1f1a33'); oval(x, y, 30, 26, INK); oval(x, y - 1, 27, 23, col); oval(x - 8, y - 9, 11, 7, hi);
  }
  // Arcade cabinet and a dartboard.
  rect(2362, 1060, 80, 12, '#2a1f1a30');
  box(2360, 930, 76, 130, '#7c6aa8'); rect(2366, 944, 64, 46, '#23272d'); rect(2372, 950, 52, 34, '#59c2d4');
  for (let i = 0; i < 4; i++) rect(2378 + i * 11, 960 + (i % 2) * 8, 6, 6, ['#ffe07a', '#f4a7b9', '#7fd28a', '#ffffff'][i]);
  box(2364, 996, 68, 20, '#5b4c86'); oval(2382, 1006, 5, 5, '#d9493a'); oval(2400, 1006, 4, 4, '#ffe07a'); oval(2414, 1006, 4, 4, '#7fd28a');
  rect(2372, 932, 52, 10, '#f5d77a');
  oval(2520, 960, 32, 32, INK); for (let r = 0; r < 4; r++) oval(2520, 960, 30 - r * 8, 30 - r * 8, r % 2 ? '#f4ecdc' : '#c9463a'); oval(2520, 960, 4, 4, '#4f8a55');
  chairTop(2510, 1060, '#e98b3a');

  // Pink blossom tree in a big planter, plus plants.
  rect(2372, 1300, 150, 16, '#2a1f1a30'); box(2398, 1262, 98, 42, '#e9e5dc'); rect(2398, 1262, 98, 6, '#f7f5f0'); rect(2440, 1220, 14, 44, '#7a5638');
  for (let i = 0; i < 14; i++) oval(2446 + Math.cos(i * 1.3) * 52 * (i % 3 ? 1 : .5), 1166 + Math.sin(i * 1.9) * 44 * (i % 3 ? 1 : .5), 44, 36, ['#f2a6c6', '#f7bfd6', '#e88db3'][i % 3]);
  for (let i = 0; i < 18; i++) rect(2390 + hash(i, 71) * 110, 1120 + hash(i, 72) * 100, 4, 4, '#fde3ee');
  plant(2560, 130, 1, 1); plant(2330, 690, .9, 0); plant(2560, 1340, 1, 2);
}

// Props -----------------------------------------------------------------------
export function paintOfficeProp(c, p, kind, elapsed, reduced) {
  c.save(); c.translate(160 + p.x, 270 + p.y);
  const { rect, box, oval, line, leaf, plant, monitor, chairTop, book } = kit(c);
  const active = elapsed >= 0 && elapsed < 4.5, w = p.r * 1.65, t = active && !reduced ? elapsed : 0;
  oval(5, 15, p.r * .95, p.r * .33, '#2a1f1a40');

  if (kind === 'desk') {
    box(-w / 2, -58, w, 60, O.desk); rect(-w / 2, -58, w, 4, '#ffffff'); rect(-w / 2, -4, w, 6, O.deskEdge);
    for (const x of [-w / 2 + 4, w / 2 - 10]) rect(x, 2, 6, 14, '#9aa1a8');
    monitor(-18, -30, active); monitor(18, -30, active);
    box(-22, -24, 44, 10, '#dfe2e5'); for (let i = 0; i < 5; i++) rect(-19 + i * 8, -22, 6, 3, '#b9bec3');
    box(w / 2 - 22, -26, 12, 12, '#f3e1c7'); rect(w / 2 - 10, -22, 4, 6, '#f3e1c7');
    if (active) for (let i = 0; i < 3; i++) rect(-32 + i * 10, -50 - ((t * 20 + i * 6) % 18), 4, 4, '#c9f5d4');
    chairTop(0, 34 + (active ? Math.sin(t * 6) * 2 : 0));
  } else if (kind === 'meeting') {
    for (const x of [-w * .36, -w * .12, w * .12, w * .36]) { chairTop(x, -56, '#5f6f84'); }
    box(-w * .55, -48, w * 1.1, 52, O.woodLight); rect(-w * .55, -48, w * 1.1, 4, '#ecc99d'); rect(-w * .55, 0, w * 1.1, 6, O.woodDark);
    for (const x of [-w * .3, 0, w * .3]) { box(x - 12, -34, 24, 16, '#c9cdd1'); rect(x - 10, -32, 20, 10, active ? '#8fe0a6' : '#7fb8d8'); }
    rect(-6, -18, 12, 8, '#f7f3ea');
    for (const x of [-w * .24, w * .24]) chairTop(x, 36, '#5f6f84');
  } else if (kind === 'whiteboard') {
    for (const x of [-w / 2 + 6, w / 2 - 10]) { rect(x, -20, 4, 34, '#6d737a'); box(x - 6, 12, 16, 4, '#6d737a'); }
    box(-w / 2, -110, w, 90, '#f7f8f6'); rect(-w / 2, -110, w, 5, '#d5d9dd');
    const n = active && !reduced ? Math.min(4, Math.floor(t * 2) + 1) : 3;
    for (let i = 0; i < n; i++) rect(-w / 2 + 10, -94 + i * 16, w * .6 - i * 8, 3, ['#2f5b92', '#d9593f', '#4f8a55', '#7c6aa8'][i]);
    rect(w / 2 - 26, -96, 16, 16, '#ffe07a'); rect(w / 2 - 22, -72, 14, 14, '#9fd8a3');
  } else if (kind === 'roundtable' || kind === 'lowtable') {
    const rx = kind === 'roundtable' ? w * .5 : w * .45;
    if (kind === 'roundtable') for (const [x, y] of [[-rx - 6, -18], [rx + 6, -18]]) chairTop(x, y, '#e98b3a');
    rect(-4, -20, 8, 34, '#6d737a');
    oval(0, -30, rx + 2, rx * .45 + 2, INK); oval(0, -32, rx, rx * .45, kind === 'roundtable' ? '#f1f2f0' : O.woodLight); oval(-rx * .3, -38, rx * .35, rx * .12, '#ffffff60');
    if (kind === 'roundtable') {
      for (const x of [-rx * .45, rx * .45]) { box(x - 6, -42, 12, 12, '#f3e1c7'); if (active && !reduced) rect(x - 2, -54 - (t * 16) % 12, 3, 6, '#ffffffb0'); }
      box(-12, -44, 24, 14, '#dfe2e5');
    } else {
      box(-8, -58, 16, 22, '#8f6ac0'); rect(-5, -55, 4, 12, '#b394de');
      for (let i = 0; i < 4; i++) leaf(Math.sin(i * 1.6) * 8, -66 + Math.cos(i * 1.6) * 5, '#63a063');
    }
  } else if (kind === 'chair') {
    const spin = active && !reduced ? Math.sin(t * 8) * 4 : 0;
    rect(-2, -6, 4, 18, '#6d737a'); oval(0, 14, 16, 5, '#555d69');
    c.translate(spin, 0); chairTop(0, 0, '#e98b3a');
  } else if (kind === 'bookshelf' || kind === 'lockers') {
    box(-w / 2, -140, w, 158, kind === 'bookshelf' ? O.woodLight : '#9fb0c2');
    if (kind === 'bookshelf') {
      for (let row = 0; row < 3; row++) {
        const y = -96 + row * 44; box(-w / 2 + 6, y - 38, w - 12, 38, O.woodDark);
        for (let i = 0; i < Math.floor((w - 20) / 10); i++) book(-w / 2 + 10 + i * 10, y, 22 + ((i + row) % 3) * 6, ['#c9463a', '#2f5b92', '#e7b54a', '#4f8a55', '#7c6aa8', '#e98b3a'][(i + row * 2) % 6]);
        rect(-w / 2 + 4, y, w - 8, 5, O.woodLight);
      }
      plant(w / 2 - 18, -140, .6, 0);
      if (active) rect(-w / 2 + 12, -134, w - 24, 3, '#fff1b8');
    } else {
      for (let row = 0; row < 3; row++) {
        const y = -132 + row * 48; box(-w / 2 + 6, y, w - 12, 40, active && row === 1 ? '#c3d0dc' : '#b3c2d1');
        rect(-w / 2 + 12, y + 4, w - 24, 3, '#d4dee8'); rect(-8, y + 18, 16, 4, '#5f6f84');
        c.fillStyle = '#3a4a5c'; c.font = 'bold 10px monospace'; c.textAlign = 'center'; c.fillText(['A-C', 'D-M', 'N-Z'][row], 0, y + 34);
      }
    }
  } else if (kind === 'snack') {
    box(-w / 2, -60, w, 72, '#f1f2f0'); rect(-w / 2, -60, w, 12, O.woodLight); rect(-w / 2, -50, w, 3, O.woodDark);
    for (let i = 0; i < 3; i++) { box(-w / 2 + 8 + i * (w - 16) / 3, -40, (w - 16) / 3 - 6, 40, '#e1e4e6'); rect(-w / 2 + 12 + i * (w - 16) / 3, -18, 10, 3, '#9aa1a8'); }
    oval(-w / 4, -64, 20, 8, INK); oval(-w / 4, -65, 18, 6, '#e8c595');
    for (const [dx, col] of [[-8, '#d0593f'], [4, '#e7b54a'], [-2, '#9ebe79']]) oval(-w / 4 + dx, -70, 7, 7, col);
    for (let i = 0; i < 3; i++) box(w / 6 + i * 14, -84, 10, 22, ['#c9463a', '#2f5b92', '#e7b54a'][i]);
    if (active && !reduced) oval(-w / 4 + Math.sin(t * 6) * 10, -90 - (t * 20) % 20, 5, 5, '#e7b54a');
  } else if (kind === 'cooler') {
    box(-18, -70, 36, 84, '#f1f2f0'); rect(-14, -66, 28, 3, '#ffffff'); box(-8, -44, 16, 10, '#9aa1a8');
    rect(-4, -34, 3, 5, '#4d8fc0'); rect(3, -34, 3, 5, '#d9493a');
    box(-16, -122, 32, 50, '#8fc9ea'); rect(-12, -118, 8, 40, '#c7e6f5'); rect(-6, -76, 12, 6, '#5f8fa5');
    if (active && !reduced) for (let i = 0; i < 4; i++) oval(-6 + (i % 2) * 10, -80 - ((t * 30 + i * 12) % 40), 3, 3, '#e8f6fd');
    box(22, -8, 12, 14, '#f7f8f6');
  } else if (kind === 'vending') {
    box(-w / 2, -150, w, 164, '#2f5b92'); rect(-w / 2 + 6, -144, w * .62, 120, active ? '#dff2ff' : '#bcd9ee');
    for (let row = 0; row < 4; row++) for (let i = 0; i < 3; i++) box(-w / 2 + 12 + i * (w * .62 - 12) / 3, -132 + row * 28, 14, 18, ['#c9463a', '#e7b54a', '#4f8a55', '#e98b3a'][(i + row) % 4]);
    box(w * .18, -130, w * .22, 40, '#23272d'); rect(w * .2, -126, w * .18, 10, active ? '#7fd28a' : '#59c2d4');
    for (let i = 0; i < 3; i++) rect(w * .2 + i * 8, -110, 5, 5, '#c9cdd1');
    box(-w / 2 + 10, -18, w * .6, 16, '#23272d');
    c.fillStyle = '#f7f3ea'; c.font = 'bold 11px monospace'; c.textAlign = 'center'; c.fillText('COFFEE', 0, -154);
  } else if (kind === 'sofa') {
    box(-w / 2, -64, w, 30, O.peachDark); rect(-w / 2 + 4, -60, w - 8, 5, O.peach);
    box(-w / 2, -36, w, 46, O.peach); rect(-w / 2 + 4, -32, w - 8, 6, O.peachHi);
    for (let i = 1; i < 3; i++) rect(-w / 2 + i * w / 3, -34, 2, 40, O.peachDark);
    for (const x of [-w / 2 - 8, w / 2 - 6]) box(x, -50, 14, 60, O.peachDark);
    box(-w / 2 + 16, -58, 26, 20, active ? '#f5d77a' : '#e7b54a'); box(w / 2 - 44, -58, 26, 20, '#5f8fa5');
    for (const x of [-w / 2 + 6, w / 2 - 12]) rect(x, 10, 6, 8, O.woodDark);
  } else {
    // Office plant; varies by id so the room does not look copy-pasted.
    const v = Math.floor(hash(p.x, p.y) * 3);
    const sway = active && !reduced ? Math.sin(t * 7) * 4 : 0;
    c.translate(sway, 0); plant(0, 12, 1.5, v);
  }
  if (active) {
    c.strokeStyle = '#ffd66b'; c.lineWidth = 3; c.setLineDash([5, 5]); c.beginPath(); c.ellipse(0, 14, p.r + 6, p.r * .34, 0, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    if (!reduced) for (let i = 0; i < 4; i++) { const a = t * 3 + i * Math.PI / 2; rect(Math.cos(a) * (p.r + 10) - 3, -60 + Math.sin(a) * 18 - 3, 6, 6, '#fff1b8'); }
  }
  c.restore();
}
