// Kitchen theme: procedural pixel illustration. All floor furniture is supplied by shared PROPS.
import { INK, brush, hash, pill as drawPill, ROOM_W, ROOM_H, ROOM_PAD } from './pixelKit.js';

// Room palette: mid-tone floor so pale avatars and dark nameplates both read; dark walls frame the stage.
const ROOM = {
  cap: '#25292f', capEdge: '#4b525b',
  wall: '#4b6661', wallSeam: '#425a55', wallLight: '#57736d',
  wood: '#b0754a', woodLight: '#d89c66', woodDark: '#7a4c31',
  seam: '#77604e', planks: ['#a0836b', '#9a7d66', '#a5886f', '#967963'], plankHi: '#ad9179', grain: '#8c7160',
  counterTop: '#e9dfca', counterEdge: '#c9bca2', cabinet: '#6e8b83', cabinetDark: '#5a746d',
  tile: '#e4ded0', grout: '#c6bfae', sky: '#a7cfd8', leafA: '#6f9b6a', leafB: '#5a8759', leafC: '#8db77c',
};

// The 2240-wide room sits centred, with a garden (left) and terrace (right) in the margins.

export function paintKitchenRoom(c, zones) {
  paintGrounds(c);
  c.save(); c.translate(ROOM_PAD, 0); paintRoomCore(c, zones); c.restore();
  paintGarden(c);
  paintTerrace(c);
}

const GRASS = { base: '#6a8a58', light: '#7b9c66', dark: '#5b7a4c', stone: '#b9b2a2', stoneDark: '#8f887a' };
const stones = (rect, oval, points) => {
  for (const [x, y, r] of points) { oval(x + 2, y + 4, r, r * .6, '#3f53353a'); oval(x, y, r, r * .6, GRASS.stoneDark); oval(x, y - 2, r - 2, r * .6 - 2, GRASS.stone); rect(x - r * .4, y - 6, r * .5, 2, '#d6d0c2'); }
};
const flower = (rect, x, y, color) => { rect(x - 3, y, 6, 3, color); rect(x, y - 3, 3, 9, color); rect(x, y, 3, 3, '#f5e27a'); };
const bush = (oval, x, y, r, tone = 0) => {
  oval(x + 3, y + r * .6, r, r * .45, '#3f53353a');
  for (let i = 0; i < 6; i++) oval(x + Math.cos(i) * r * .45, y + Math.sin(i * 1.7) * r * .3, r * .6, r * .55, [GRASS.dark, '#6f9660', '#83aa6c'][(i + tone) % 3]);
};

function paintGrounds(c) {
  const { rect, oval } = brush(c);
  rect(0, 0, ROOM_W, ROOM_H, GRASS.base);
  for (let i = 0; i < 2600; i++) {
    const x = hash(i, 1) * ROOM_W, y = hash(i, 2) * ROOM_H;
    rect(x, y, 4, 2, hash(i, 3) > .5 ? GRASS.light : GRASS.dark);
  }
  // Hedge along the very top and bottom edges.
  for (let x = 20; x < ROOM_W; x += 46) { bush(oval, x, 8, 26, x % 3); bush(oval, x + 23, 1448, 24, x % 2); }
  // Stepping-stone path from the kitchen door down to the garden and terrace.
  const door = ROOM_PAD + 970;
  stones(rect, oval, [[door - 30, 1402, 20], [door + 26, 1410, 18], [door - 6, 1440, 17]]);
  for (let x = door - 120; x > 330; x -= 64) stones(rect, oval, [[x, 1416 + (x % 3) * 6, 15]]);
  for (let x = door + 120; x < 2270; x += 64) stones(rect, oval, [[x, 1416 + (x % 3) * 6, 15]]);
  for (let i = 0; i < 40; i++) flower(rect, 340 + hash(i, 9) * 1900, 1392 + hash(i, 8) * 50, ['#f0a0b4', '#f4e2a0', '#b9a3e3', '#f7f3ea'][i % 4]);
}

function paintGarden(c) {
  const { rect, box, oval, line, leaf } = brush(c);
  // Picket fence along the outer edge.
  for (let y = 40; y < 1400; y += 34) { box(10, y, 12, 26, '#e8dfcc'); rect(10, y - 4, 12, 4, '#f5efe2'); }
  rect(8, 40, 3, 1360, '#c8bda6'); rect(22, 40, 3, 1360, '#c8bda6');
  // Stepping stones running beside the kitchen wall.
  const path = []; for (let y = 80; y < 1400; y += 62) path.push([258 + (y % 4 ? 4 : -4), y, 16]); stones(rect, oval, path);

  // Orange tree.
  oval(128, 216, 86, 26, '#3f53354d'); rect(120, 160, 16, 60, '#7a5638');
  for (let i = 0; i < 9; i++) oval(128 + Math.cos(i * .7) * 44, 132 + Math.sin(i * 1.3) * 34, 46, 40, ['#4f7a48', '#5f8c54', '#73a063'][i % 3]);
  for (let i = 0; i < 11; i++) { const x = 70 + hash(i, 31) * 116, y = 92 + hash(i, 32) * 84; oval(x, y, 7, 7, INK); oval(x, y - 1, 6, 6, '#eb9a3c'); rect(x - 3, y - 4, 3, 2, '#fbd08a'); }

  // Raised vegetable beds: lettuce, tomatoes, carrots.
  const bed = (y, kind) => {
    rect(46, y + 8, 176, 122, '#3f53353a');
    box(40, y, 176, 118, '#8f5f3d'); rect(40, y, 176, 5, '#b77f55'); rect(50, y + 12, 156, 96, '#5a4031');
    for (let r = 0; r < 3; r++) for (let k = 0; k < 5; k++) {
      const x = 68 + k * 30, yy = y + 34 + r * 30;
      if (kind === 'lettuce') { oval(x, yy, 12, 10, '#6fa25c'); oval(x, yy - 2, 8, 6, '#9cc97a'); rect(x - 1, yy - 6, 2, 8, '#c9e2a4'); }
      else if (kind === 'tomato') { leaf(x, yy, '#5f8c54'); oval(x - 5, yy + 2, 5, 5, '#d9493a'); oval(x + 5, yy - 3, 5, 5, '#e2613f'); rect(x - 6, yy - 1, 2, 2, '#f4a28c'); }
      else { for (let j = 0; j < 3; j++) rect(x - 5 + j * 4, yy - 10, 2, 10, '#78ab5a'); rect(x - 4, yy, 9, 5, '#e98b3a'); }
    }
    box(164, y - 22, 52, 16, '#e8dfcc'); rect(188, y - 6, 4, 10, '#8f5f3d');
    c.fillStyle = INK; c.font = 'bold 10px monospace'; c.textAlign = 'center'; c.fillText({ lettuce: 'LETTUCE', tomato: 'TOMATO', carrot: 'CARROT' }[kind], 190, y - 10);
  };
  bed(320, 'lettuce'); bed(510, 'tomato'); bed(700, 'carrot');

  // Watering can, wheelbarrow of pumpkins and a garden bench.
  oval(96, 922, 26, 8, '#3f53353a'); box(78, 890, 34, 30, '#5f8fa5'); rect(78, 894, 34, 4, '#86b3c6'); line(112, 900, 132, 884, '#5f8fa5', 5); rect(130, 880, 8, 6, '#86b3c6'); c.strokeStyle = INK; c.lineWidth = 3; c.beginPath(); c.arc(95, 890, 14, Math.PI, 0); c.stroke();
  oval(170, 1060, 64, 14, '#3f53353a'); box(110, 1010, 104, 44, '#c7c9c4'); rect(116, 1016, 92, 8, '#e4e6e1');
  line(214, 1020, 246, 1004, '#8f5f3d', 5); line(214, 1046, 246, 1062, '#8f5f3d', 5); oval(104, 1054, 14, 14, INK); oval(104, 1054, 9, 9, '#6c7478');
  for (const [x, col] of [[134, '#e98b3a'], [162, '#f0a24b'], [190, '#d9793a']]) { oval(x, 1008, 15, 12, INK); oval(x, 1007, 13, 10, col); rect(x - 1, 993, 3, 7, '#6b7a3c'); line(x - 6, 998, x - 6, 1016, '#c96f2c', 2); line(x + 6, 998, x + 6, 1016, '#c96f2c', 2); }
  box(54, 1150, 170, 18, '#b77f55'); box(54, 1128, 170, 14, '#9c6a46'); for (const x of [60, 212]) box(x, 1168, 8, 20, '#7a5638');
  // Flower bed and a birdbath.
  box(40, 1230, 190, 110, '#5a4031'); for (let i = 0; i < 36; i++) flower(rect, 54 + (i % 9) * 20, 1248 + Math.floor(i / 9) * 24 + (i % 2) * 5, ['#f0a0b4', '#f4e2a0', '#b9a3e3', '#f7f3ea', '#e2613f'][i % 5]);
  for (let i = 0; i < 9; i++) leaf(54 + i * 20, 1334, '#6f9660');
  bush(oval, 238, 1210, 24, 1);
}

function paintTerrace(c) {
  const { rect, box, oval, line, leaf, plate, bottle } = brush(c);
  const L = 2306, R = 2582, T = 170, B = 1290;
  // Wooden deck with railing.
  rect(L - 4, T + 6, R - L + 12, B - T + 6, '#3f53353a');
  rect(L, T, R - L, B - T, '#8a6547');
  for (let y = T, r = 0; y < B; y += 26, r++) { rect(L, y + 1, R - L, 23, ['#c0916a', '#b98a63', '#c6986f'][r % 3]); rect(L, y + 1, R - L, 2, '#d3a67d'); for (let x = L + (r % 2) * 70; x < R; x += 140) rect(x, y + 1, 2, 23, '#8a6547'); }
  for (let y = T; y <= B; y += 80) { box(R - 6, y - 4, 12, 16, '#7a5638'); }
  rect(R - 3, T, 6, B - T, '#9c6a46'); rect(L, B - 6, R - L, 6, '#9c6a46'); rect(L, T, R - L, 6, '#9c6a46');
  // Terrace sign.
  box(L + 40, T - 44, 190, 34, '#2f3a36'); c.fillStyle = '#f4e3bf'; c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.fillText('GARDEN TERRACE', L + 135, T - 22);
  for (const x of [L + 60, L + 210]) rect(x, T - 10, 5, 12, '#7a5638');

  // String lights zig-zagging over the deck.
  for (let i = 0; i < 6; i++) {
    const y = T + 30 + i * 170, x0 = L + 10, x1 = R - 10;
    c.strokeStyle = '#3b3530'; c.lineWidth = 2; c.beginPath(); c.moveTo(x0, y); c.quadraticCurveTo((x0 + x1) / 2, y + 36, x1, y + 12); c.stroke();
    for (let k = 1; k < 8; k++) { const t = k / 8, bx = x0 + (x1 - x0) * t, by = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * (y + 36) + t * t * (y + 12); oval(bx, by + 5, 5, 6, ['#ffe39a', '#ffc7a0', '#fff4cf'][k % 3]); oval(bx, by + 5, 10, 10, '#fff1b822'); }
  }

  // Two café tables under striped parasols, with chairs peeking out.
  const cafe = (cx, cy, colA) => {
    for (const [dx, dy] of [[-56, 10], [56, 10], [0, 62]]) { box(cx + dx - 16, cy + dy - 6, 32, 26, '#e8dfcc'); rect(cx + dx - 12, cy + dy - 2, 24, 4, '#f7f1e3'); }
    oval(cx + 10, cy + 56, 76, 22, '#3f53353a');
    for (let i = 0; i < 12; i++) {
      c.fillStyle = i % 2 ? '#f4ecdc' : colA; c.beginPath(); c.moveTo(cx, cy);
      c.arc(cx, cy, 70, i * Math.PI / 6, (i + 1) * Math.PI / 6); c.closePath(); c.fill();
    }
    c.strokeStyle = INK; c.lineWidth = 3; c.beginPath(); c.arc(cx, cy, 70, 0, Math.PI * 2); c.stroke();
    oval(cx, cy, 8, 8, INK); oval(cx, cy - 1, 5, 5, '#e9c775');
  };
  cafe(2440, 390, '#d9704f'); cafe(2440, 760, '#5f8fa5');

  // Produce crates stacked by the wall.
  for (const [x, y, fill] of [[2322, 530, '#d9493a'], [2322, 586, '#e98b3a'], [2376, 586, '#9ebe79'], [2322, 950, '#e7b54a'], [2376, 950, '#b58585']]) {
    box(x, y, 50, 46, '#b98a5a'); rect(x + 4, y + 4, 42, 22, '#6b4d36');
    for (let i = 0; i < 4; i++) oval(x + 10 + i * 10, y + 14 + (i % 2) * 4, 6, 6, fill);
    rect(x, y + 30, 50, 4, '#d3a67d'); rect(x, y + 40, 50, 3, '#8a6547');
  }
  // A-frame "OPEN" chalkboard.
  oval(2512, 1060, 36, 8, '#3f53353a'); box(2482, 990, 60, 66, '#9c6a46'); rect(2488, 996, 48, 50, '#34463f');
  c.fillStyle = '#f4e3bf'; c.font = 'bold 13px monospace'; c.textAlign = 'center'; c.fillText('OPEN', 2512, 1016); c.fillStyle = '#e3b777'; c.font = '10px monospace'; c.fillText('HOT SOUP', 2512, 1034);
  // Bicycle with a basket of bread and flowers.
  oval(2440, 1200, 80, 12, '#3f53353a');
  for (const x of [2386, 2494]) { oval(x, 1178, 26, 26, INK); oval(x, 1178, 21, 21, '#c0916a'); oval(x, 1178, 4, 4, '#b9bdc0'); }
  c.strokeStyle = '#3f8a82'; c.lineWidth = 5; c.beginPath(); c.moveTo(2386, 1178); c.lineTo(2428, 1178); c.lineTo(2474, 1140); c.lineTo(2420, 1140); c.closePath(); c.moveTo(2428, 1178); c.lineTo(2412, 1130); c.moveTo(2474, 1140); c.lineTo(2494, 1178); c.moveTo(2474, 1140); c.lineTo(2470, 1122); c.stroke();
  rect(2402, 1124, 22, 5, INK); rect(2462, 1118, 22, 4, INK);
  box(2476, 1100, 40, 24, '#c9a26a'); for (let i = 0; i < 4; i++) rect(2480 + i * 9, 1104, 3, 18, '#a8804e');
  oval(2488, 1096, 10, 6, '#e0b270'); rect(2500, 1082, 4, 16, '#e8c98e'); flower(rect, 2508, 1090, '#f0a0b4'); flower(rect, 2496, 1086, '#f4e2a0');
  // Potted plants and a lantern at the deck corners.
  for (const [x, y] of [[2330, 210], [2552, 210], [2330, 1250], [2552, 590]]) { box(x - 14, y, 28, 24, '#c9805c'); rect(x - 14, y, 28, 5, '#e09a74'); for (let i = 0; i < 7; i++) leaf(x + Math.sin(i * 2.4) * 14, y - 8 + Math.cos(i * 2.4) * 10, i % 2 ? '#6f9b6a' : '#8db77c'); }
  box(2540, 1230, 20, 26, '#3b3530'); rect(2544, 1236, 12, 14, '#ffe39a'); oval(2550, 1243, 22, 22, '#fff1b81c');
  // A water jug and cups waiting on a side table.
  box(2500, 860, 60, 40, '#e8dfcc'); rect(2500, 860, 60, 5, '#f7f1e3'); bottle(2516, 862, '#8fb3b0'); plate(2542, 866, 9);

  // Grass-side extras below and above the deck.
  bush(oval, 2360, 110, 34, 1); bush(oval, 2500, 96, 38, 2); bush(oval, 2440, 1340, 30, 0);
  for (let i = 0; i < 18; i++) flower(rect, 2320 + hash(i, 44) * 250, 1310 + hash(i, 45) * 70, ['#f0a0b4', '#f4e2a0', '#b9a3e3'][i % 3]);
}

function paintRoomCore(c, zones) {
  const { rect, box, oval, line, bottle, leaf, plate } = brush(c);
  const FX = 160, FY = 270, FW = 1920, FH = 1080, FR = FX + FW, FB = FY + FH;
  const pill = (...args) => drawPill(c, ...args);



  // Floor: staggered planks of varying length with highlight, grain and nail heads.
  rect(FX, FY, FW, FH, ROOM.seam);
  for (let row = 0; row < FH / 36; row++) {
    const y = FY + row * 36;
    let x = FX - Math.floor(hash(row, 99) * 220), i = 0;
    while (x < FR) {
      const len = 150 + Math.floor(hash(row, ++i) * 5) * 36;
      const l = Math.max(x, FX), r = Math.min(x + len - 2, FR);
      if (r > l) {
        rect(l, y, r - l, 34, ROOM.planks[Math.floor(hash(i, row + 7) * 4)]);
        rect(l, y, r - l, 2, ROOM.plankHi);
        const g = l + 14 + hash(row, i + 50) * Math.max(1, r - l - 90);
        if (r - l > 90) { rect(g, y + 11, 46, 2, ROOM.grain); rect(g + 26, y + 23, 38, 2, ROOM.grain); }
        if (x >= FX) { rect(x + 5, y + 7, 3, 3, ROOM.seam); rect(x + 5, y + 25, 3, 3, ROOM.seam); }
      }
      x += len;
    }
  }

  // Zones: each gets its own floor material and a floating name pill (visual aliases only).
  for (const z of zones) {
    const x = FX + z.x, y = FY + z.y;
    rect(x - 5, y - 3, z.w + 10, z.h + 10, '#2b221c38');
    if (z.id === 'bar') {
      const t = 38;
      rect(x, y, z.w, z.h, '#646b69');
      for (let yy = 0; yy < z.h; yy += t) for (let xx = 0; xx < z.w; xx += t) {
        const w = Math.min(t - 2, z.w - xx - 1), h = Math.min(t - 2, z.h - yy - 1), light = (xx / t + yy / t) % 2;
        rect(x + xx + 1, y + yy + 1, w, h, light ? '#bbb9ad' : '#8c948f');
        rect(x + xx + 1, y + yy + 1, w, 2, light ? '#d6d3c6' : '#9aa29c');
      }
    } else if (z.id === 'stage') {
      const t = 35;
      rect(x, y, z.w, z.h, '#87503f');
      for (let yy = 0, r = 0; yy < z.h; yy += t, r++) for (let xx = -(r % 2) * t / 2; xx < z.w; xx += t) {
        const l = Math.max(xx, 0), w = Math.min(xx + t - 2, z.w) - l, h = Math.min(t - 2, z.h - yy - 1);
        if (w <= 0) continue;
        rect(x + l + 1, y + yy + 1, w, h, hash(xx + 3, r) > .5 ? '#bd775c' : '#b36d53');
        rect(x + l + 1, y + yy + 1, w, 2, '#cf8e70');
      }
    } else {
      // Tweed carpet with a zig-zag weave and a stitched border.
      rect(x, y, z.w, z.h, '#4e5a6d');
      for (let yy = 0; yy < z.h; yy += 8) for (let xx = 0; xx < z.w; xx += 8) {
        const k = (xx / 8 + Math.abs((yy / 8) % 6 - 3)) % 4;
        if (k === 0) rect(x + xx, y + yy, 6, 3, '#5a677c'); else if (k === 2) rect(x + xx + 2, y + yy + 4, 4, 2, '#455064');
      }
      c.strokeStyle = '#3c4658'; c.lineWidth = 10; c.strokeRect(x + 5, y + 5, z.w - 10, z.h - 10);
      c.strokeStyle = '#c7a56b'; c.lineWidth = 2; c.setLineDash([8, 6]); c.strokeRect(x + 16, y + 16, z.w - 32, z.h - 32); c.setLineDash([]);
    }
    const label = { stage: '食材小站 PANTRY', bar: '暖心料理 COOK & BREW', lounge: '烘焙分享 BAKE & SHARE' }[z.id] ?? z.label;
    // The cook zone's left edge is crowded by the coffee machine, so its pill hangs from the right.
    const right = z.id === 'bar';
    pill(right ? x + z.w - 12 : x + 12, y - 16, label, { stage: '#f0b36b', bar: '#7fd28a', lounge: '#8fb7ef' }[z.id], right);
  }

  // Dining rug under the shared table: diamonds and fringe.
  rect(1124, 1156, 422, 162, '#2b221c30');
  rect(1128, 1156, 414, 156, '#9c4d3b'); rect(1140, 1166, 390, 136, '#c2704c');
  for (let i = 0; i < 9; i++) {
    const cx = 1162 + i * 43;
    c.fillStyle = i % 2 ? '#e2a468' : '#dc8f5a';
    c.beginPath(); c.moveTo(cx, 1184); c.lineTo(cx + 18, 1234); c.lineTo(cx, 1284); c.lineTo(cx - 18, 1234); c.fill();
    rect(cx - 3, 1231, 6, 6, '#9c4d3b');
  }
  for (let y = 1160; y < 1310; y += 8) { rect(1118, y, 10, 3, '#eadbb8'); rect(1542, y, 10, 3, '#eadbb8'); }

  // Soft ambient occlusion where floor meets walls.
  rect(FX, FY, FW, 12, '#2b1f1840'); rect(FX, FY + 12, FW, 10, '#2b1f1820');
  rect(FX, FY, 10, FH, '#2b1f1826'); rect(FR - 10, FY, 10, FH, '#2b1f1826');

  // Window light falling onto the floor. Painted only; never interpreted as obstacles.
  c.save(); c.globalAlpha = .1; c.fillStyle = '#fff4d0';
  for (const x of [620, 1330]) { c.beginPath(); c.moveTo(x, FY); c.lineTo(x + 180, FY); c.lineTo(x + 290, FY + 170); c.lineTo(x + 70, FY + 170); c.fill(); }
  c.restore();

  // ── Back wall ──────────────────────────────────────────────
  rect(FX, 44, FW, FY - 44, ROOM.wall);
  for (let x = FX; x < FR; x += 40) { rect(x, 44, 2, 110, ROOM.wallSeam); rect(x + 2, 44, 1, 110, ROOM.wallLight); }
  // Subway-tile backsplash behind the counter run.
  rect(FX, 150, FW, 70, ROOM.grout);
  for (let y = 150, r = 0; y < 220; y += 12, r++) for (let x = FX - (r % 2) * 14; x < FR; x += 28) {
    const l = Math.max(x, FX), w = Math.min(x + 26, FR) - l; if (w > 0) { rect(l, y + 1, w, 10, ROOM.tile); rect(l, y + 1, w, 2, '#f3efe6'); }
  }
  rect(FX, 148, FW, 4, ROOM.woodDark);

  // Windows interrupt the upper wall and the backsplash, with a garden view.
  const windowAt = x => {
    box(x - 6, 60, 232, 148, ROOM.woodLight); rect(x, 66, 220, 136, ROOM.sky);
    rect(x, 66, 220, 14, '#c5e1e5'); for (let i = 0; i < 3; i++) { oval(x + 40 + i * 70, 96 - (i % 2) * 8, 22, 8, '#e8f3f1'); }
    for (let i = 0; i < 9; i++) { oval(x + 8 + i * 26, 176 - (i % 3) * 10, 22, 26, i % 2 ? ROOM.leafA : ROOM.leafB); }
    rect(x, 186, 220, 16, '#7fa86f'); for (let i = 0; i < 11; i++) rect(x + 6 + i * 20, 188, 6, 4, '#e6c37a');
    rect(x + 107, 66, 6, 136, ROOM.woodLight); rect(x, 130, 220, 6, ROOM.woodLight);
    rect(x + 10, 72, 20, 4, '#ffffff90'); rect(x + 10, 72, 4, 30, '#ffffff90');
    box(x - 14, 204, 248, 10, ROOM.wood); rect(x - 14, 204, 248, 3, ROOM.woodLight);
    rect(x - 22, 52, 264, 6, ROOM.woodDark); for (const cx of [x - 20, x + 242]) oval(cx, 55, 5, 5, ROOM.woodLight);
    for (const xx of [x - 24, x + 204]) {
      box(xx, 58, 40, 118, '#cf7f5f'); for (let j = 0; j < 4; j++) rect(xx + 4 + j * 10, 62, 4, 110, '#e39c78');
      rect(xx + 6, 140, 28, 6, '#a45e45'); rect(xx + 2, 170, 36, 6, '#b86b50');
    }
  };
  windowAt(620); windowAt(1330);

  // Chalkboard menu.
  box(186, 62, 146, 82, ROOM.wood); rect(193, 69, 132, 68, '#34463f');
  c.fillStyle = '#f0e4c8'; c.font = 'bold 12px monospace'; c.textAlign = 'center'; c.fillText('TODAY’S MENU', 259, 86);
  for (let i = 0; i < 3; i++) { rect(205, 96 + i * 12, 68 - i * 10, 2, '#c9d1b3'); rect(300, 96 + i * 12, 12, 2, '#e3b777'); }
  rect(190, 144, 138, 5, ROOM.woodDark); rect(210, 141, 12, 3, '#f2efe4'); rect(236, 141, 8, 3, '#e5a3a0');

  // Upper cabinets with knobs and an under-cabinet glow.
  const cabinets = (x, n, w = 72) => {
    for (let i = 0; i < n; i++) { box(x + i * w, 50, w - 4, 88, ROOM.cabinet); rect(x + i * w + 6, 56, w - 16, 76, ROOM.cabinetDark); rect(x + i * w + 8, 58, w - 20, 3, '#87a39b'); oval(x + i * w + (i % 2 ? 12 : w - 16), 118, 3, 3, '#e3c38a'); }
    rect(x - 2, 140, n * w, 6, ROOM.woodDark); rect(x, 146, n * w - 4, 4, '#fff0b855');
  };
  cabinets(366, 3); cabinets(1886, 2, 88);

  // Clock.
  oval(892, 92, 30, 30, ROOM.cap); oval(892, 92, 26, 26, '#efe1bd');
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; rect(892 + Math.cos(a) * 20 - 1, 92 + Math.sin(a) * 20 - 1, 3, 3, '#6d5e52'); }
  line(892, 92, 892, 76, INK, 3); line(892, 92, 905, 99, INK, 3); oval(892, 92, 3, 3, '#c7563b');

  // Open shelves with jars, stacked plates, mugs and cookbooks.
  const shelf = y => { box(960, y, 320, 8, ROOM.wood); rect(960, y, 320, 3, ROOM.woodLight); for (const x of [976, 1256]) { rect(x, y + 8, 6, 12, ROOM.woodDark); } };
  shelf(98); shelf(142);
  for (let i = 0; i < 5; i++) bottle(982 + i * 26, 97, ['#c9805c', '#e0bf72', '#9bb57f', '#b58585', '#8fb3b0'][i]);
  for (let k = 0; k < 4; k++) plate(1142, 94 - k * 4, 16);
  for (let i = 0; i < 4; i++) box(1178 + i * 13, 64 + (i % 2) * 6, 10, 32 - (i % 2) * 6, ['#b5563f', '#5e7d8c', '#e0b25c', '#7c9468'][i]);
  box(1240, 76, 26, 20, '#c9805c'); for (let i = 0; i < 5; i++) leaf(1253 + Math.sin(i * 2.4) * 12, 66 + Math.cos(i * 2.4) * 8, i % 2 ? ROOM.leafA : ROOM.leafC);
  for (let i = 0; i < 6; i++) { const x = 986 + i * 34; box(x, 124, 18, 17, ['#efe6d2', '#d98f6c', '#8fb3b0'][i % 3]); rect(x + 18, 128, 5, 8, INK); }
  for (let i = 0; i < 3; i++) bottle(1200 + i * 24, 141, ['#6f8a5e', '#c7a26a', '#a3705a'][i]);

  // Pot rack with hanging pans and utensils above the cooktop.
  rect(1570, 64, 150, 6, '#8a8f93'); for (const x of [1574, 1712]) rect(x, 50, 4, 16, '#8a8f93');
  [[1590, 16], [1632, 22], [1682, 18]].forEach(([x, r]) => { line(x, 70, x, 84, '#8a8f93', 2); oval(x, 84 + r, r + 2, r + 2, INK); oval(x, 84 + r, r, r, '#c07b52'); oval(x, 84 + r, r - 5, r - 5, '#8e5a3f'); rect(x - 2, 72, 4, 12, '#6c4a37'); });
  for (const [x, head] of [[1612, 'spoon'], [1660, 'ladle'], [1706, 'whisk']]) {
    rect(x - 1, 70, 3, 44, '#b9bdc0');
    if (head === 'whisk') { oval(x, 118, 7, 11, '#b9bdc0'); oval(x, 118, 4, 8, ROOM.wall); } else oval(x, 116, head === 'ladle' ? 9 : 6, head === 'ladle' ? 7 : 5, '#c9ccce');
  }

  // Framed pictures: a fruit print and a colour-block print.
  box(1756, 62, 58, 72, ROOM.woodLight); rect(1761, 67, 48, 62, '#f3ead6');
  oval(1776, 100, 10, 10, '#d0593f'); oval(1792, 106, 10, 10, '#e7b54a'); leaf(1784, 86, ROOM.leafA);
  box(1826, 70, 46, 56, '#f5f0e6'); rect(1830, 74, 18, 22, '#c9463a'); rect(1850, 74, 18, 12, '#2f5b92'); rect(1850, 88, 18, 34, '#f5f0e6'); rect(1830, 98, 18, 24, '#e9c04a');
  line(1848, 74, 1848, 122, INK, 2); line(1830, 97, 1868, 97, INK, 2);

  // Hanging planters with trailing vines.
  for (const x of [349, 940]) {
    line(x - 12, 44, x, 70, '#8c7a60', 1); line(x + 12, 44, x, 70, '#8c7a60', 1);
    box(x - 14, 70, 28, 18, '#e2d2b4');
    for (let i = 0; i < 7; i++) leaf(x + Math.sin(i * 2.1) * 16, 72 + i * 7 + Math.cos(i) * 3, i % 2 ? ROOM.leafA : ROOM.leafC);
  }
  // Herb garland over the chalkboard side.
  for (let i = 0; i < 6; i++) { line(186 + i * 28, 50 + (i % 2) * 4, 214 + i * 28, 50 + ((i + 1) % 2) * 4, '#9a8263', 2); leaf(200 + i * 28, 56, i % 2 ? '#7fa06a' : '#9dbb7b'); }

  // Counter run along the wall with everyday objects on it.
  rect(FX, 214, FW, 14, ROOM.counterTop); rect(FX, 214, FW, 3, '#f7f0e0'); rect(FX, 226, FW, 3, ROOM.counterEdge);
  rect(FX, 229, FW, 35, ROOM.cabinet);
  for (let x = FX; x < FR; x += 80) { box(x + 4, 233, 72, 27, ROOM.cabinetDark); rect(x + 8, 236, 64, 2, '#87a39b'); rect(x + 34, 240, 12, 3, '#e3c38a'); }
  rect(FX, 262, FW, 8, ROOM.cap);
  // Items: toaster, bread box, kettle, sinks, fruit, mixer, dish rack, cooktop, knife block, microwave.
  box(190, 196, 36, 22, '#d9dcd8'); rect(198, 192, 8, 5, INK); rect(212, 192, 8, 5, INK); rect(194, 200, 28, 3, '#f5f6f2'); rect(222, 206, 6, 4, '#c7563b');
  box(240, 190, 56, 28, '#b98859'); rect(240, 198, 56, 3, '#8c6243'); rect(262, 204, 12, 3, '#e3c38a');
  box(420, 196, 30, 22, '#d86f4f'); oval(435, 196, 12, 5, '#ef9676'); rect(430, 188, 10, 5, INK); rect(450, 200, 8, 3, '#d86f4f');
  box(470, 206, 60, 10, '#d7ae7c'); rect(480, 203, 20, 4, '#9ebe79'); rect(506, 202, 12, 5, '#d9593f');
  for (const x of [650, 1360]) { box(x, 214, 150, 12, '#9fb2ae'); rect(x + 6, 216, 138, 8, '#6f8480'); box(x + 70, 186, 8, 28, '#b9bdc0'); box(x + 58, 182, 32, 6, '#c9ccce'); }
  oval(900, 212, 30, 10, INK); oval(900, 211, 27, 8, '#e5dcc6'); for (const [dx, col] of [[-12, '#d0593f'], [2, '#e7b54a'], [14, '#9ebe79'], [-4, '#c9463a']]) oval(900 + dx, 204 - (dx === -4 ? 6 : 0), 8, 8, col);
  box(1030, 208, 44, 8, '#8fb3b0'); box(1062, 170, 12, 40, '#8fb3b0'); box(1030, 164, 44, 16, '#8fb3b0'); rect(1034, 167, 30, 3, '#b3d0cd'); box(1036, 188, 26, 18, '#c9ccce'); rect(1040, 191, 18, 3, '#e8eaeb'); rect(1047, 180, 4, 8, '#9aa0a3');
  box(1390, 194, 90, 20, '#b9bdc0'); for (let i = 0; i < 6; i++) box(1396 + i * 14, 180 - (i % 2) * 4, 8, 22, '#efe6d2');
  box(1566, 210, 170, 10, '#2f3336'); for (const x of [1600, 1652, 1704]) { oval(x, 215, 16, 4, '#4a4f53'); oval(x, 215, 9, 2, '#6a7075'); }
  box(1646, 184, 34, 24, '#6c7478'); oval(1663, 184, 17, 5, '#8a9296');
  box(1760, 186, 26, 32, '#8c6243'); for (let i = 0; i < 4; i++) rect(1764 + i * 5, 176 + (i % 2) * 3, 3, 12, INK);
  bottle(1808, 218, '#b8913f'); bottle(1830, 218, '#6f8a5e');
  box(1940, 172, 96, 46, '#dfe1dc'); rect(1946, 178, 62, 34, '#3d4a4e'); rect(1950, 182, 20, 3, '#ffffff40'); for (let i = 0; i < 3; i++) rect(2016, 182 + i * 9, 12, 5, '#8a9296');
  for (const x of [336, 1236, 2060]) { box(x - 12, 196, 24, 22, '#c9805c'); for (let i = 0; i < 6; i++) leaf(x + Math.sin(i * 2.4) * 12, 186 + Math.cos(i * 2.4) * 9, i % 2 ? ROOM.leafA : ROOM.leafC); }

  // ── Side and bottom walls with timber caps; the doorway sits in the bottom wall ──
  rect(120, 24, 2000, 22, ROOM.cap); rect(120, 44, 2000, 3, ROOM.capEdge);
  for (const x of [122, FR]) {
    rect(x, 24, 38, FB + 36 - 24, ROOM.cap);
    rect(x === 122 ? FX - 4 : FR, 46, 4, FB - 46, ROOM.capEdge);
    for (let y = 120; y < FB; y += 240) { box(x + 6, y, 26, 34, ROOM.wood); rect(x + 6, y, 26, 5, ROOM.woodLight); }
  }
  for (const [l, r] of [[122, 830], [1110, 2118]]) { rect(l, FB, r - l, 36, ROOM.cap); rect(l, FB, r - l, 3, ROOM.capEdge); }
  for (const x of [814, 1110]) { box(x, FB - 6, 16, 44, ROOM.wood); rect(x, FB - 6, 16, 5, ROOM.woodLight); }
  rect(830, FB, 280, 36, '#6c5a4c'); for (let x = 836; x < 1106; x += 20) rect(x, FB + 4, 14, 28, '#7a6656');
  // Doormat just inside the entrance.
  box(846, 1288, 248, 50, '#6d5a3c'); rect(854, 1296, 232, 34, '#8a7249');
  for (let x = 858; x < 1084; x += 8) rect(x, 1298, 3, 30, '#7c6541');
  c.fillStyle = '#f4e3bf'; c.font = 'bold 16px monospace'; c.textAlign = 'center'; c.fillText('MAKE YOURSELF AT HOME', 970, 1319);
}

export function paintKitchenProp(c,p,kind,elapsed,reduced) {
  c.save();c.translate(160+p.x,270+p.y);
  const {rect,box,oval,line,plate,bottle,leaf}=brush(c);
  const active=elapsed>=0&&elapsed<4.5,w=p.r*1.65;
  oval(5,15,p.r*.95,p.r*.33,'#2a1f1a4d');
  const cabinet=(color='#83a596',top='#eee0bf')=>{
    box(-w/2,-43,w,64,color);rect(-w/2+4,16,w-8,6,'#53695b');
    box(-w/2,-65,w,30,top);rect(-w/2+2,-63,w-4,4,'#fff2d2');rect(-w/2+3,-38,w-6,4,'#b7a88b');
    for(let i=0;i<2;i++){box(-w/2+6+i*w/2,-26,w/2-12,35,color);rect(-w/2+10+i*w/2,-22,w/2-20,3,'#c0cdb0');rect(-w/2+15+i*w/2,-12,15,4,'#d9bd85');}
  };
  if(kind==='herb'){
    box(-19,-12,38,31,'#ae7257');rect(-15,-7,5,23,'#d59a73');box(-23,-20,46,12,'#d79e75');
    rect(-3,-66,7,51,'#6b7751');
    const sway=active&&!reduced?Math.sin(elapsed*7)*5:0;
    for(let i=0;i<12;i++)leaf(sway+Math.sin(i*2.4)*24,-46+Math.cos(i*2.4)*25,['#6c9260','#94b779','#b0c588'][i%3]);
    for(let i=0;i<4;i++)rect(-19+i*13,-66+(i%2)*10,5,5,'#e4c28a');
  } else if(kind==='stool'){
    for(const x of [-17,13])box(x,-1,7,25,'#8f694f');
    box(-23,-40,46,25,'#ac7757');rect(-19,-36,38,5,'#d2a27a');
    box(-24,-15,48,22,active?'#d8bd7d':'#d3a270');rect(-21,-12,42,4,'#ecc69a');
  } else if(kind==='pantry'||kind==='dishes'){
    box(-w/2,-140,w,160,'#b38c67');rect(w/2-9,-136,7,151,'#805f4d');
    for(let row=0;row<3;row++){
      box(-w/2+7,-130+row*45,w-21,36,'#687d72');
      if(kind==='pantry')for(let j=0;j<4;j++)bottle(-w/2+20+j*(w-36)/4,-97+row*45,['#be7358','#d9b971','#95ac78','#b38485'][j]);
      else for(let j=0;j<3;j++)for(let k=0;k<3;k++)plate(-w/2+20+j*(w-32)/3,-99+row*45-k*4,11);
      rect(-w/2+4,-93+row*45,w-15,6,'#d5b48c');
    }
    rect(-w/2,-145,w,6,'#dfbd91');
    if(active)rect(-w/2+7,-132,w-20,3,'#ffe2a6');
  } else if(kind==='dining'||kind==='tea'){
    for(const x of [-w*.34,w*.27])box(x,-19,8,41,'#8b654d');
    oval(0,-32,w*.53,32,INK);oval(0,-35,w*.51,29,'#c19264');oval(-2,-39,w*.49,24,'#e1b784');
    rect(-13,-63,26,53,'#ede0b9');for(let i=0;i<5;i++)rect(-11,-60+i*10,22,2,'#95a896');
    plate(-w*.29,-36,14);plate(w*.29,-36,14);
    bottle(0,-41,'#819786');leaf(0,-75,'#789b69');
    if(kind==='tea'){box(-9,-60,18,18,'#ce9b75');box(8,-57,8,10,'#efcaa0');}
    else for(const x of [-w*.29,w*.29]){oval(x,-36,8,4,'#ba7653');rect(x-18,-43,3,16,'#eee3c9');}
  } else if(kind==='cart'||kind==='market'){
    box(-w/2,-55,w,64,'#a47a55');
    for(let row=0;row<2;row++){
      box(-w/2+5,-51+row*31,w-10,25,'#645a49');
      for(let j=0;j<5;j++){const x=-w/2+14+j*(w-22)/5,y=-40+row*31;leaf(x,y,['#9daf67','#bd7855','#d6af64'][(j+row)%3]);}
      rect(-w/2,-28+row*31,w,6,'#d3ab79');
    }
    for(const x of [-w/2+8,w/2-15])box(x,12,10,9,'#59635c');
    rect(w/2-4,-69,4,73,'#6b6555');rect(w/2-16,-71,16,5,'#bcb28f');
  } else {
    cabinet(kind==='bread'?'#b58368':kind==='board'||kind==='island'?'#7c9d9d':'#86a492');
    if(kind==='fridge'){
      box(-w/2,-150,w,173,'#739b92');box(-w/2+3,-147,w-11,161,'#bbcec0');rect(w/2-9,-145,6,161,'#72968d');
      if(active){for(let row=0;row<3;row++){box(-w/2+8,-131+row*44,w-24,35,'#617d72');for(let i=0;i<3;i++)bottle(-w/2+20+i*17,-101+row*44,['#c38562','#cdb476','#95b381'][i]);}}
      else{rect(-w/2+4,-94,w-15,4,'#72968d');box(w/2-23,-134,6,25,'#eee6cd');box(w/2-23,-76,6,37,'#eee6cd');box(-23,-71,23,28,'#eee2b0');rect(-18,-65,14,3,'#a17d64');rect(-18,-57,10,3,'#a17d64');rect(-15,-80,7,7,'#c77d5c');}
      rect(-w/2+8,-158,w-20,7,'#d8b087');
    }else if(kind==='oven'){
      box(-w/2+5,-29,w-10,42,'#596b69');box(-w/2+11,-20,w-22,23,active?'#e0a55d':'#859d94');rect(-w/2+12,-25,w-24,5,'#dccbb0');
      for(const x of [-w*.23,w*.23]){oval(x,-53,14,9,INK);oval(x,-54,8,5,'#84918a');}
      for(let i=0;i<4;i++)oval(-w/2+13+i*15,-33,4,4,'#eee1bf');
      if(active)for(let i=0;i<3;i++)box(-23+i*17,-14,13,10,'#edc17c');
    }else if(kind==='coffee'){
      box(-29,-119,54,65,'#566c65');box(-24,-113,44,22,'#c1c8ad');rect(-17,-106,25,5,'#819a85');box(-15,-82,27,23,'#3e514e');
      box(-10,-73,16,15,'#f5e6c7');box(5,-70,7,8,'#c9b99b');rect(-7,-76,10,4,'#765240');
      bottle(39,-58,'#ba8d62');plate(-w/2+14,-49,10);rect(-23,-88,6,4,active?'#e9c775':'#99b28e');
    }else if(kind==='sink'){
      box(-w/2+10,-60,w-20,25,'#789b9b');box(-w/2+17,-56,w-34,17,'#b8cec3');oval(0,-47,5,3,'#6d8984');
      box(9,-91,7,41,'#b4c2b4');box(-6,-95,23,7,'#cdd7c5');rect(-6,-88,5,8,'#9eb9b0');
      bottle(-w/2+11,-64,'#a7bb83');box(w/2-18,-50,13,8,'#e1c987');
      if(active)for(let i=0;i<4;i++)rect(-5,-76+i*7,4,5,'#e5f2de');
    }else if(kind==='pot'){
      oval(0,-47,29,13,INK);oval(0,-49,24,10,active?'#dca864':'#7c8271');
      box(-24,-87,48,31,'#c17e58');oval(0,-87,24,10,'#e0ac76');oval(0,-87,19,7,active?'#b78d52':'#e8c090');
      for(const x of [-34,25])box(x,-81,10,10,'#795e48');
      bottle(w/2-10,-65,'#9faa73');rect(-w/2+4,-68,5,25,'#c69c6c');
    }else if(kind==='board'||kind==='island'){
      box(-w/2+8,-60,w*.57,22,'#c8a16e');
      for(let i=0;i<4;i++){leaf(-w/2+20+i*14,-50,active?'#aac477':'#bb7a55');}
      box(w/2-32,-61,23,18,'#ded4b4');oval(w/2-20,-62,13,7,'#a0b785');
      rect(-w/2+17,-73,32,5,'#dce1cf');rect(-w/2+48,-73,15,5,'#6c6151');
      box(w/2-27,-26,16,39,'#d9c6a8');for(let i=0;i<3;i++)rect(w/2-25+i*5,-23,2,33,'#b77662');
    }else if(kind==='bread'){
      box(-w/2+8,-61,w-16,23,'#d3b488');
      for(const x of [-34,2,34]){oval(x,-53,15,8,'#a77345');oval(x,-56,14,8,'#e0b270');line(x-6,-61,x-1,-54,'#f7d99a',3);line(x+2,-61,x+7,-54,'#f7d99a',3);}
      rect(-35,-77,60,7,'#ba895b');rect(-42,-75,8,3,'#8c664a');rect(25,-75,8,3,'#8c664a');
      bottle(w/2-9,-69,'#cda79a');
    }
  }
  if(active){
    c.strokeStyle='#f4d79b';c.lineWidth=3;c.setLineDash([5,5]);c.beginPath();c.ellipse(0,14,p.r+6,p.r*.34,0,0,Math.PI*2);c.stroke();c.setLineDash([]);
    if(!reduced)for(let i=0;i<3;i++){const rise=(elapsed*19+i*17)%48;rect(-16+i*16+Math.sin(elapsed*4+i)*4,-110-rise,5,7,'#fff1ca');}
  }
  c.restore();
}
