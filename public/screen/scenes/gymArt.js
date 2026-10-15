// Gym theme: procedural pixel illustration of a school sports hall.
// Same shared PROPS / ZONES / DOORWAYS as every other theme; only the look and the prop names change.
//   west margin  → outdoor running track (grd_1/2/3 are hurdle, vault box, tyre)
//   room         → hardwood court; stage = hoop key, bar = warm-up corner, lounge = bench area
//   east margin  → locker room
import { DOORWAYS } from '/shared/scene.js';
import { INK, brush, hash, pill, ROOM_W, ROOM_H, ROOM_PAD, FLOOR_Y, doorway } from './pixelKit.js';

const G = {
  outside: '#d9cfbf', outsideLine: '#cfc3b1',
  cap: '#26324a', capEdge: '#47577a', wall: '#34466a', wallSeam: '#2d3d5e', wallLight: '#3f527a',
  seam: '#b88552', planks: ['#d9a46a', '#d29c62', '#ddab73', '#cf975d'], plankHi: '#e6b882', grain: '#c58f58',
  line: '#f6efe0', key: '#c8553d', keyHi: '#d4664c',
  glass: '#8fd0cc', glassHi: '#c3ebe6', frame: '#26324a',
  orange: '#e8833a', orangeDark: '#b85f22', steel: '#9aa4b1', steelDark: '#6b7684',
  mat: '#3f6fa8', matHi: '#5584bd', rubber: '#4a4f5a', rubberHi: '#575d69',
  track: '#c4553f', trackLine: '#f3e6d4', grass: '#6fa85a', grassHi: '#85bb6c',
  wood: '#c69a6c', woodLight: '#dcb487', woodDark: '#8d6645',
  leafA: '#4f8a55', leafB: '#63a063', leafC: '#80b96f', pot: '#e9e5dc',
};

export function paintGymRoom(c, zones) {
  paintOutside(c);
  c.save(); c.translate(ROOM_PAD, 0); paintCourt(c, zones); c.restore();
  paintTrack(c);
  paintLockerRoom(c);
}

// Small reusable pieces -------------------------------------------------------
function kit(c) {
  const b = brush(c);
  const { rect, box, oval, leaf, line } = b;
  const plant = (x, y, s = 1, variant = 0) => {
    oval(x + 3, y + 4, 20 * s, 7 * s, '#2a1f1a33');
    box(x - 12 * s, y - 20 * s, 24 * s, 22 * s, G.pot); rect(x - 12 * s, y - 20 * s, 24 * s, 4 * s, '#f7f5f0');
    const tones = [[G.leafA, G.leafB, G.leafC], ['#3f7a5b', '#56946d', '#79b58a'], ['#5b8c3f', '#77a852', '#9cc46a']][variant % 3];
    for (let i = 0; i < 9; i++) leaf(x + Math.sin(i * 2.4) * 16 * s, y - 36 * s + Math.cos(i * 2.4) * 14 * s, tones[i % 3]);
  };
  // Basketball: orange disc with the two seams.
  const ball = (x, y, r = 9, color = G.orange) => {
    oval(x, y, r + 1, r + 1, INK); oval(x, y, r, r, color);
    line(x - r, y, x + r, y, '#5a2e12', 1.5); line(x, y - r, x, y + r, '#5a2e12', 1.5);
    rect(x - r * .5, y - r * .6, 3, 3, '#ffffff50');
  };
  // Volleyball / soccer ball: white disc with coloured panels.
  const whiteBall = (x, y, r = 9, accent = '#3f6fa8') => {
    oval(x, y, r + 1, r + 1, INK); oval(x, y, r, r, '#f4f1ea');
    rect(x - r * .5, y - 2, r, 4, accent); rect(x - 2, y - r * .5, 4, r * .5, accent);
  };
  const towel = (x, y, color) => { box(x, y, 26, 10, color); rect(x + 2, y + 2, 22, 2, '#ffffff50'); };
  return { ...b, plant, ball, whiteBall, towel };
}

function paintOutside(c) {
  const { rect, plant } = kit(c);
  rect(0, 0, ROOM_W, ROOM_H, G.outside);
  for (let y = 0; y < ROOM_H; y += 48) rect(0, y, ROOM_W, 2, G.outsideLine);
  for (let x = 0; x < ROOM_W; x += 96) for (let y = 0; y < ROOM_H; y += 96) rect(x + (y / 96 % 2) * 48, y, 2, 48, G.outsideLine);
  for (let x = 360; x < 2260; x += 220) plant(x, 1440, .8, x % 3);
}

// Room ------------------------------------------------------------------------
function paintCourt(c, zones) {
  const { rect, box, oval, line, plant, ball, whiteBall } = kit(c);
  const FX = 160, FY = 270, FW = 1920, FH = 1080, FR = FX + FW, FB = FY + FH;
  const CX = FX + FW / 2, CY = FY + FH / 2;

  // Floor: maple sports planks, laid lengthwise.
  rect(FX, FY, FW, FH, G.seam);
  for (let row = 0; row < FH / 30; row++) {
    const y = FY + row * 30;
    let x = FX - Math.floor(hash(row, 23) * 260), i = 0;
    while (x < FR) {
      const len = 220 + Math.floor(hash(row, ++i + 500) * 4) * 50;
      const l = Math.max(x, FX), r = Math.min(x + len - 2, FR);
      if (r > l) {
        rect(l, y, r - l, 28, G.planks[Math.floor(hash(i + 60, row) * 4)]);
        rect(l, y, r - l, 2, G.plankHi);
        if (r - l > 120) rect(l + 24 + hash(row, i) * (r - l - 100), y + 14, 60, 2, G.grain);
      }
      x += len;
    }
  }

  // Court markings: boundary, half-court line, centre circle with the school crest.
  c.strokeStyle = G.line; c.lineWidth = 5;
  c.strokeRect(FX + 40, FY + 40, FW - 80, FH - 80);
  line(CX, FY + 40, CX, FB - 40, G.line, 5);
  c.beginPath(); c.arc(CX, CY, 120, 0, Math.PI * 2); c.stroke();
  oval(CX, CY, 70, 70, G.key); oval(CX, CY, 60, 60, G.keyHi);
  c.fillStyle = G.line; c.font = 'bold 30px "Microsoft JhengHei", sans-serif'; c.textAlign = 'center'; c.fillText('體', CX, CY + 11);
  // Three-point arcs at both ends (they run off under the zones, like a real half court).
  c.beginPath(); c.arc(FX + 40, CY, 330, -Math.PI / 2, Math.PI / 2); c.stroke();
  c.beginPath(); c.arc(FR - 40, CY, 330, Math.PI / 2, Math.PI * 1.5); c.stroke();

  // Zones: painted key under the hoop, rubber tiles for warm-up, blue mats for the bench area.
  for (const z of zones) {
    // 分區座標已經是圖面座標，而這裡還在 ROOM_PAD 的位移裡
    const x = z.x - ROOM_PAD, y = FY + z.y;
    rect(x - 5, y - 3, z.w + 10, z.h + 10, '#2b221c26');
    if (z.id === 'stage') {
      rect(x, y, z.w, z.h, G.key);
      for (let yy = 0; yy < z.h; yy += 14) rect(x, y + yy, z.w, 2, G.keyHi);
      c.strokeStyle = G.line; c.lineWidth = 5; c.strokeRect(x + 6, y + 6, z.w - 12, z.h - 12);
      // Free-throw semicircle hanging off the bottom of the key.
      c.beginPath(); c.arc(x + z.w / 2, y + z.h - 6, 90, 0, Math.PI); c.stroke();
    } else if (z.id === 'bar') {
      rect(x, y, z.w, z.h, G.rubber);
      for (let yy = 0; yy < z.h; yy += 50) for (let xx = 0; xx < z.w; xx += 50) {
        rect(x + xx + 1, y + yy + 1, Math.min(48, z.w - xx - 2), Math.min(48, z.h - yy - 2), (xx / 50 + yy / 50) % 2 ? G.rubber : G.rubberHi);
        for (let k = 0; k < 5; k++) rect(x + xx + 6 + hash(xx + k, yy) * 36, y + yy + 6 + hash(yy + k, xx) * 36, 3, 3, ['#d9593f', '#e7b54a', '#5f8fa5'][k % 3]);
      }
    } else {
      rect(x, y, z.w, z.h, G.mat);
      for (let xx = 0; xx < z.w; xx += 104) { rect(x + xx, y, 2, z.h, '#2f5a8c'); rect(x + xx + 2, y, 2, z.h, G.matHi); }
      c.strokeStyle = '#2f5a8c'; c.lineWidth = 8; c.strokeRect(x + 4, y + 4, z.w - 8, z.h - 8);
    }
    const label = { stage: '籃框區 HOOP', bar: '暖身區 WARM-UP', lounge: '休息區 BENCH' }[z.id] ?? z.label;
    // Same placement rule as the office: the ball cart and treadmill crowd the left edges of these two zones.
    const right = z.id === 'bar' || z.id === 'stage';
    pill(c, right ? x + z.w - 12 : x + 12, y - 16, label, { stage: '#f0b36b', bar: '#7fd28a', lounge: '#8fb7ef' }[z.id], right);
  }

  // Ambient occlusion and high-window light shafts.
  rect(FX, FY, FW, 12, '#2b1f1830'); rect(FX, FY + 12, FW, 10, '#2b1f1818');
  rect(FX, FY, 10, FH, '#2b1f181f'); rect(FR - 10, FY, 10, FH, '#2b1f181f');
  c.save(); c.globalAlpha = .12; c.fillStyle = '#ffffff';
  for (const x of [340, 1490]) { c.beginPath(); c.moveTo(x, FY); c.lineTo(x + 260, FY); c.lineTo(x + 380, FY + 220); c.lineTo(x + 120, FY + 220); c.fill(); }
  c.restore();

  // ── Back wall ──
  rect(FX, 44, FW, FY - 44, G.wall);
  for (let x = FX; x < FR; x += 64) { rect(x, 44, 2, 176, G.wallSeam); rect(x + 2, 44, 1, 176, G.wallLight); }
  // Padded safety strip along the bottom of the wall.
  for (let x = FX; x < FR; x += 80) { box(x + 3, 170, 74, 40, x % 160 ? '#2f5a8c' : '#3f6fa8'); rect(x + 6, 173, 68, 4, '#ffffff25'); }

  // High clerestory windows.
  const windowAt = (x, w) => {
    box(x, 58, w, 70, G.frame); rect(x + 4, 62, w - 8, 62, '#a9dcd8');
    for (let i = 0; i < 2; i++) oval(x + 50 + i * 120, 80 + (i % 2) * 8, 26, 7, '#e8f6f4');
    for (let k = 1; k < 4; k++) rect(x + k * w / 4 - 2, 62, 4, 62, G.frame);
    rect(x + 12, 68, 3, 30, '#ffffff80');
  };
  windowAt(300, 300); windowAt(1450, 300);

  // Scoreboard above the hoop.
  box(860, 56, 300, 104, '#1f2430'); rect(868, 64, 284, 88, '#2b3242');
  c.fillStyle = '#ff6b4a'; c.font = 'bold 40px monospace'; c.textAlign = 'center';
  c.fillText('24', 935, 120); c.fillText('18', 1085, 120);
  c.fillStyle = '#ffd66b'; c.font = 'bold 22px monospace'; c.fillText('12:00', 1010, 96);
  c.fillStyle = '#c9d8e6'; c.font = 'bold 13px monospace'; c.fillText('HOME', 935, 142); c.fillText('GUEST', 1085, 142);
  for (const x of [868, 1144]) rect(x, 160, 8, 10, '#1f2430');

  // Championship pennants and a wall clock.
  const pennant = (x, color, text) => {
    c.fillStyle = INK; c.beginPath(); c.moveTo(x - 2, 64); c.lineTo(x + 58, 64); c.lineTo(x + 28, 156); c.fill();
    c.fillStyle = color; c.beginPath(); c.moveTo(x, 66); c.lineTo(x + 56, 66); c.lineTo(x + 28, 150); c.fill();
    c.fillStyle = '#f6efe0'; c.font = 'bold 13px monospace'; c.textAlign = 'center'; c.fillText(text, x + 28, 92);
  };
  pennant(200, '#c8553d', '2024'); pennant(640, '#e7b54a', 'CHAMP'); pennant(1210, '#4f8a55', '2025'); pennant(1800, '#7c6aa8', 'MVP');
  oval(1960, 104, 28, 28, G.cap); oval(1960, 104, 24, 24, '#f4f4f0');
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; rect(1960 + Math.cos(a) * 18 - 1, 104 + Math.sin(a) * 18 - 1, 3, 3, '#6d6f74'); }
  line(1960, 104, 1960, 90, INK, 3); line(1960, 104, 1971, 110, INK, 3);
  // Motto board.
  box(1840, 66, 92, 56, '#f6efe0'); c.fillStyle = INK; c.font = 'bold 16px "Microsoft JhengHei", sans-serif'; c.textAlign = 'center'; c.fillText('團隊', 1886, 90); c.fillText('精神', 1886, 112);

  // Low equipment ledge along the wall with balls and gear.
  rect(FX, 216, FW, 12, G.woodLight); rect(FX, 216, FW, 3, '#ecc99d'); rect(FX, 226, FW, 3, G.woodDark);
  rect(FX, 229, FW, 35, '#e3e6ea');
  for (let x = FX; x < FR; x += 96) { box(x + 4, 233, 88, 27, '#d3d8de'); rect(x + 44, 244, 8, 3, G.steelDark); }
  rect(FX, 262, FW, 8, G.cap);
  for (const x of [260, 560, 1620, 2000]) plant(x, 218, .8, x % 3);
  for (let i = 0; i < 4; i++) ball(330 + i * 22, 206, 9);
  for (let i = 0; i < 3; i++) whiteBall(720 + i * 22, 206, 9, ['#3f6fa8', '#e7b54a', '#c8553d'][i]);
  box(1250, 196, 60, 20, '#3a4049'); rect(1256, 200, 48, 4, '#e7b54a');
  for (let i = 0; i < 3; i++) box(1340 + i * 16, 186 - i * 4, 12, 30 + i * 4, ['#c8553d', '#3f6fa8', '#4f8a55'][i]);
  box(1760, 194, 40, 22, '#f7f8f6'); rect(1764, 198, 32, 4, '#c9cdd1');

  // ── Side and bottom walls; double doors at the bottom ──
  rect(120, 24, 2000, 22, G.cap); rect(120, 44, 2000, 3, G.capEdge);
  for (const x of [122, FR]) {
    const d = DOORWAYS.find((o) => o.x - ROOM_PAD === x);
    const top = d ? d.y : FB + 36, bot = d ? d.y + d.h : FB + 36;
    const ex = x === 122 ? FX - 4 : FR;
    rect(x, 24, 38, top - 24, G.cap); rect(ex, 46, 4, top - 46, G.capEdge);
    if (d) { rect(x, bot, 38, FB + 36 - bot, G.cap); rect(ex, bot, 4, FB - bot, G.capEdge); }
    for (let y = 150; y < FB; y += 260) {
      if (d && y + 60 > d.y && y < bot) continue;
      box(x + 8, y, 22, 60, G.glass); rect(x + 10, y + 4, 4, 30, G.glassHi);
    }
    if (d) doorway(c, x, d, G.seam, G.outside, G.cap, G.capEdge);
  }
  for (const [l, r] of [[122, 830], [1110, 2118]]) { rect(l, FB, r - l, 36, G.cap); rect(l, FB, r - l, 3, G.capEdge); }
  for (const x of [814, 1110]) box(x, FB - 6, 16, 44, G.steel);
  rect(830, FB + 4, 280, 28, G.glass); rect(968, FB + 4, 4, 28, G.frame); rect(840, FB + 8, 40, 4, G.glassHi); rect(980, FB + 8, 40, 4, G.glassHi);
  box(846, 1288, 248, 50, '#2f5a8c'); rect(854, 1296, 232, 34, '#3f6fa8');
  c.fillStyle = '#f6efe0'; c.font = 'bold 18px monospace'; c.textAlign = 'center'; c.fillText('GO TEAM!', 970, 1320);
}

// Left margin: outdoor running track -------------------------------------------
function paintTrack(c) {
  const { rect, box, oval, plant } = kit(c);
  rect(0, 0, 14, ROOM_H, G.cap);
  // Grass verge, then three lanes of red track running top to bottom.
  rect(14, 40, 290, 1340, G.grass);
  for (let y = 40; y < 1380; y += 24) rect(14, y, 290, 2, G.grassHi);
  rect(40, 40, 238, 1340, G.track);
  for (let k = 0; k <= 3; k++) rect(40 + k * 78, 40, 4, 1340, G.trackLine);
  for (let k = 0; k < 3; k++) {
    c.fillStyle = G.trackLine; c.font = 'bold 26px monospace'; c.textAlign = 'center'; c.fillText(String(k + 1), 81 + k * 78, 1340);
  }
  rect(40, 1290, 238, 6, G.trackLine);
  // 標籤壓低到 y≈130：左上角是活動名稱卡（screen.js 的 #event-card），放在最上面會被蓋住
  c.fillStyle = '#23272dd9'; c.beginPath(); c.roundRect(70, 118, 170, 30, 15); c.fill();
  c.fillStyle = '#f4ecdc'; c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.fillText('RUNNING TRACK', 155, 139);
  // 跨欄、跳箱、輪胎已經移到 PROPS（grd_1/2/3），由 paintGymProp 畫 ——
  // 室外是可行走區，它們是真的障礙物，位置必須與伺服器判定的同一份座標一致。
  // Starting blocks and a stopwatch stand near the finish line.
  for (let k = 0; k < 3; k++) { box(66 + k * 78, 1250, 30, 12, '#3a4049'); rect(70 + k * 78, 1246, 22, 4, '#9aa4b1'); }
  oval(262, 1010, 18, 8, '#2a1f1a33'); rect(258, 940, 6, 70, G.steelDark); box(246, 920, 30, 24, '#f6efe0'); rect(250, 924, 22, 10, '#3d6f8f');
  plant(60, 1180, 1, 0); plant(270, 1150, .9, 2);
}

// Right margin: locker room -------------------------------------------------------
function paintLockerRoom(c) {
  const { rect, box, oval, plant, towel, ball } = kit(c);
  rect(ROOM_W - 14, 0, 14, ROOM_H, G.cap);
  const L = 2306, R = 2582;
  // Light tiled floor.
  rect(L, 40, R - L, 1340, '#dde3e8');
  for (let y = 40; y < 1380; y += 40) for (let x = L; x < R; x += 40) rect(x + 1, y + 1, 38, 38, (x / 40 + y / 40) % 2 ? '#e7ecf0' : '#d5dce2');
  c.fillStyle = '#23272dd9'; c.beginPath(); c.roundRect(L + 58, 52, 162, 30, 15); c.fill();
  c.fillStyle = '#f4ecdc'; c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.fillText('LOCKER ROOM', L + 139, 73);

  // Two banks of lockers.
  for (const [x0, y0] of [[2330, 110], [2330, 560]]) {
    rect(x0 + 4, y0 + 226, 240, 10, '#2a1f1a30');
    for (let i = 0; i < 5; i++) {
      const x = x0 + i * 48;
      box(x, y0, 44, 222, ['#3f6fa8', '#c8553d', '#e7b54a', '#4f8a55', '#7c6aa8'][i]);
      rect(x + 4, y0 + 4, 36, 4, '#ffffff35');
      for (let k = 0; k < 3; k++) rect(x + 10, y0 + 20 + k * 6, 24, 2, '#00000030');
      rect(x + 34, y0 + 100, 4, 18, '#23272d');
      c.fillStyle = '#f6efe0'; c.font = 'bold 12px monospace'; c.textAlign = 'center'; c.fillText(String(i + 1 + (y0 > 300 ? 5 : 0)).padStart(2, '0'), x + 22, y0 + 200);
    }
  }
  // Changing bench with towels and a sports bag.
  rect(2340, 430, 230, 10, '#2a1f1a30'); box(2340, 392, 228, 30, G.woodLight); rect(2340, 392, 228, 6, '#ecc99d');
  for (const x of [2350, 2552]) rect(x, 422, 8, 16, G.woodDark);
  towel(2366, 380, '#f4a7b9'); towel(2420, 380, '#8fc4ea');
  box(2480, 362, 70, 34, '#2f5a8c'); rect(2490, 356, 50, 8, '#23272d'); rect(2486, 374, 58, 4, '#e7b54a');
  // Showers: tiled stalls with curtains.
  for (let i = 0; i < 3; i++) {
    const x = 2330 + i * 82;
    box(x, 900, 76, 150, '#b9d8e6'); rect(x + 4, 904, 68, 142, '#cfe6ef');
    rect(x + 30, 912, 16, 6, G.steelDark); rect(x + 36, 918, 4, 16, G.steelDark);
    for (let k = 0; k < 6; k++) rect(x + 4 + k * 11, 960, 8, 86, ['#f6efe0', '#e7ecf0'][k % 2]);
  }
  // Scale, water bottles, a spare ball.
  box(2350, 1120, 60, 60, '#f1f2f0'); rect(2362, 1130, 36, 16, '#3d6f8f'); c.fillStyle = '#c9f5d4'; c.font = 'bold 12px monospace'; c.textAlign = 'center'; c.fillText('62.0', 2380, 1142);
  for (let i = 0; i < 4; i++) { box(2450 + i * 22, 1130, 14, 36, ['#3f6fa8', '#c8553d', '#4f8a55', '#e7b54a'][i]); rect(2453 + i * 22, 1124, 8, 6, '#f6efe0'); }
  ball(2540, 1170, 12);
  oval(2446, 1302, 70, 16, '#2a1f1a30');
  plant(2560, 1340, 1, 1); plant(2330, 1320, .9, 0);
}

// Props -----------------------------------------------------------------------
export function paintGymProp(c, p, kind, elapsed, reduced) {
  c.save(); c.translate(p.x, FLOOR_Y + p.y);
  const { rect, box, oval, line, plant, ball, whiteBall, towel } = kit(c);
  const active = elapsed >= 0 && elapsed < 4.5, w = p.r * 1.65, t = active && !reduced ? elapsed : 0;
  oval(5, 15, p.r * .95, p.r * .33, '#2a1f1a40');

  if (kind === 'ballcart') {
    // Wheeled cage full of basketballs; a ball hops out when activated.
    box(-w / 2, -64, w, 64, '#3a4049'); rect(-w / 2 + 4, -60, w - 8, 56, '#4a515c');
    for (let i = 0; i < 6; i++) ball(-w / 2 + 14 + (i % 3) * (w - 28) / 2, -46 + Math.floor(i / 3) * 22, 10);
    for (let x = -w / 2 + 8; x < w / 2; x += 12) rect(x, -64, 2, 64, G.steel);
    rect(-w / 2, -66, w, 4, G.steel);
    for (const x of [-w / 2 + 6, w / 2 - 6]) { oval(x, 6, 6, 6, INK); oval(x, 6, 4, 4, G.steel); }
    if (active && !reduced) ball(0, -84 - Math.abs(Math.sin(t * 5)) * 30, 10);
  } else if (kind === 'hoop') {
    // Portable hoop: base, pole, backboard, rim and net.
    box(-w * .45, -14, w * .9, 22, '#2f5a8c');
    rect(-5, -150, 10, 140, G.steelDark);
    box(-w * .55, -210, w * 1.1, 70, '#f4f7fa'); c.strokeStyle = '#c8553d'; c.lineWidth = 3; c.strokeRect(-18, -186, 36, 28);
    box(-20, -146, 40, 6, G.orange);
    for (let i = 0; i < 5; i++) line(-18 + i * 9, -140, -14 + i * 7, -112, '#f6efe0', 2);
    line(-14, -112, 14, -112, '#f6efe0', 2);
    if (active && !reduced) {
      const phase = (t * 1.2) % 1;
      ball(-w * .5 + phase * w * .5, -230 + Math.pow(phase * 2 - 1, 2) * 60 + phase * 40, 10);
    } else ball(w * .32, 2, 10);
  } else if (kind === 'scoretable') {
    box(-w / 2, -48, w, 54, '#2f5a8c'); rect(-w / 2, -48, w, 6, '#3f6fa8');
    box(-w * .34, -78, w * .68, 30, '#1f2430');
    const home = active && !reduced ? 24 + Math.floor(t * 2) : 24;
    c.fillStyle = '#ff6b4a'; c.font = 'bold 18px monospace'; c.textAlign = 'center';
    c.fillText(`${home}:18`, 0, -57);
    rect(-w / 2 + 10, -34, 20, 6, '#f6efe0'); rect(w / 2 - 30, -34, 20, 6, '#f6efe0');
    oval(-w * .3, -22, 6, 6, '#e7b54a'); box(w * .2, -28, 18, 12, '#f6efe0');
  } else if (kind === 'water') {
    box(-18, -70, 36, 84, '#f1f2f0'); rect(-14, -66, 28, 3, '#ffffff'); box(-8, -44, 16, 10, G.steel);
    rect(-4, -34, 3, 5, '#4d8fc0'); rect(3, -34, 3, 5, '#4d8fc0');
    box(-16, -122, 32, 50, '#8fc9ea'); rect(-12, -118, 8, 40, '#c7e6f5'); rect(-6, -76, 12, 6, '#5f8fa5');
    if (active && !reduced) for (let i = 0; i < 4; i++) oval(-6 + (i % 2) * 10, -80 - ((t * 30 + i * 12) % 40), 3, 3, '#e8f6fd');
    for (let i = 0; i < 3; i++) box(24, -4 - i * 8, 12, 8, '#f7f8f6');
    c.fillStyle = '#f6efe0'; c.font = 'bold 11px monospace'; c.textAlign = 'center';
    box(-26, -142, 52, 16, '#2f5a8c'); c.fillStyle = '#f6efe0'; c.fillText('WATER', 0, -130);
  } else if (kind === 'treadmill') {
    box(-w / 2, -18, w, 30, '#3a4049'); rect(-w / 2 + 6, -12, w - 12, 18, '#23272d');
    const shift = active && !reduced ? (t * 60) % 16 : 0;
    for (let x = -w / 2 + 8 + shift; x < w / 2 - 8; x += 16) rect(x, -10, 3, 14, '#3a4049');
    for (const x of [-w / 2 + 8, w / 2 - 14]) rect(x, -86, 6, 70, G.steelDark);
    box(-w / 2 + 4, -96, w - 8, 14, G.steel);
    box(-22, -118, 44, 24, '#1f2430'); rect(-18, -114, 36, 12, active ? '#8fe0a6' : '#3d6f8f');
  } else if (kind === 'bike') {
    oval(-w * .3, -8, 16, 16, INK); oval(-w * .3, -8, 12, 12, G.steel);
    box(-w * .25, -16, w * .55, 10, '#3a4049');
    rect(w * .22, -70, 8, 60, G.steelDark); box(w * .1, -76, 34, 10, '#23272d');
    rect(-w * .22, -58, 8, 44, G.steelDark); box(-w * .32, -64, 30, 10, '#c8553d');
    const crank = active && !reduced ? t * 10 : 0;
    oval(0, -16, 9, 9, INK); oval(0, -16, 7, 7, G.steel);
    line(0, -16, Math.cos(crank) * 14, -16 + Math.sin(crank) * 14, INK, 3);
    box(-10, 2, w * .5, 8, '#3a4049');
  } else if (kind === 'dumbbells') {
    box(-w / 2, -26, w, 12, G.steelDark); box(-w / 2, -64, w, 12, G.steelDark);
    for (const x of [-w / 2 + 4, w / 2 - 10]) rect(x, -64, 6, 76, G.steelDark);
    for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
      const x = -w / 2 + 16 + i * (w - 32) / 3, y = -32 - row * 38, size = 6 + i + row;
      const lift = active && !reduced && i === 1 && row === 0 ? Math.abs(Math.sin(t * 4)) * 20 : 0;
      rect(x - 10, y - lift - 2, 20, 4, '#6d737a');
      box(x - 14, y - lift - size / 2 - 2, 6, size + 4, '#23272d'); box(x + 8, y - lift - size / 2 - 2, 6, size + 4, '#23272d');
    }
  } else if (kind === 'podium') {
    // Three-step podium with numbers; confetti when activated.
    const step = (x, h, n, color) => { box(x - w * .18, -h, w * .36, h + 6, color); rect(x - w * .18, -h, w * .36, 5, '#ffffff50'); c.fillStyle = INK; c.font = 'bold 22px monospace'; c.textAlign = 'center'; c.fillText(String(n), x, -h + 30); };
    step(-w * .36, 40, 2, '#c9cdd1'); step(w * .36, 30, 3, '#d19a66'); step(0, 62, 1, '#f0c24b');
    if (active && !reduced) for (let i = 0; i < 14; i++) rect(Math.sin(i * 2.1) * w * .5, -80 - ((t * 40 + i * 13) % 80), 5, 5, ['#c8553d', '#e7b54a', '#3f6fa8', '#4f8a55'][i % 4]);
  } else if (kind === 'cone') {
    const wob = active && !reduced ? Math.sin(t * 9) * .15 : 0;
    c.rotate(wob);
    box(-16, -4, 32, 8, G.orangeDark);
    c.fillStyle = INK; c.beginPath(); c.moveTo(-14, -2); c.lineTo(0, -42); c.lineTo(14, -2); c.fill();
    c.fillStyle = G.orange; c.beginPath(); c.moveTo(-11, -4); c.lineTo(0, -38); c.lineTo(11, -4); c.fill();
    rect(-7, -22, 14, 5, '#f6efe0');
  } else if (kind === 'trophy') {
    box(-w / 2, -140, w, 158, G.woodLight); rect(-w / 2 + 6, -134, w - 12, 140, '#cfe6ef');
    for (let row = 0; row < 3; row++) {
      const y = -92 + row * 44; rect(-w / 2 + 6, y, w - 12, 4, G.woodDark);
      for (let i = 0; i < 3; i++) {
        const x = -w / 2 + 18 + i * (w - 36) / 2, gold = ['#f0c24b', '#c9cdd1', '#d19a66'][(i + row) % 3];
        box(x - 6, y - 8, 12, 8, G.woodDark); rect(x - 2, y - 16, 4, 8, gold); oval(x, y - 24, 9, 9, gold); rect(x - 3, y - 30, 6, 4, '#ffffff70');
      }
    }
    rect(-w / 2 + 10, -134, 6, 130, '#ffffff60');
    if (active && !reduced) rect(-w / 2 + 8 + ((t * 80) % (w - 16)), -134, 8, 140, '#ffffff50');
  } else if (kind === 'ballrack') {
    for (const x of [-w / 2 + 2, w / 2 - 8]) rect(x, -96, 6, 110, G.steelDark);
    for (const y of [-90, -56, -22]) rect(-w / 2, y, w, 5, G.steel);
    for (let row = 0; row < 3; row++) for (let i = 0; i < 3; i++) {
      const x = -w / 2 + 14 + i * (w - 28) / 2, y = -100 + row * 34;
      if (row === 1) whiteBall(x, y, 11, ['#3f6fa8', '#e7b54a', '#c8553d'][i]);
      else if (row === 0) ball(x, y, 11);
      else { oval(x, y, 12, 12, INK); oval(x, y, 11, 11, '#f4f1ea'); rect(x - 4, y - 4, 8, 8, INK); }
    }
    if (active && !reduced) ball(Math.sin(t * 4) * 20, -130 - Math.abs(Math.sin(t * 6)) * 14, 9);
  } else if (kind === 'basket') {
    // Equipment basket.
    box(-w / 2, -48, w, 54, '#c69a6c'); rect(-w / 2, -48, w, 6, '#dcb487');
    for (let x = -w / 2 + 8; x < w / 2; x += 12) rect(x, -42, 3, 46, G.woodDark);
    for (let y = -36; y < 4; y += 12) rect(-w / 2 + 4, y, w - 8, 2, G.woodDark);
    ball(-w * .2, -54, 11); whiteBall(w * .15, -56, 11, '#4f8a55');
    line(-w * .4, -52, -w * .1, -70, '#c8553d', 3); line(w * .4, -52, w * .1, -72, '#3f6fa8', 3);
    if (active && !reduced) ball(0, -70 - Math.abs(Math.sin(t * 5)) * 26, 9);
  } else if (kind === 'bleacher') {
    for (let row = 0; row < 3; row++) {
      const y = -70 + row * 26;
      box(-w / 2, y, w, 18, row % 2 ? '#3f6fa8' : '#2f5a8c'); rect(-w / 2, y, w, 4, '#ffffff35');
    }
    for (const x of [-w / 2 + 6, w / 2 - 12]) rect(x, 8, 6, 10, G.steelDark);
    towel(-w / 2 + 20, -64, '#f4a7b9'); towel(w / 2 - 50, -38, '#e7b54a');
    if (active && !reduced) for (let i = 0; i < 3; i++) rect(-30 + i * 28, -96 - Math.abs(Math.sin(t * 6 + i)) * 16, 8, 14, ['#c8553d', '#e7b54a', '#3f6fa8'][i]);
  } else if (kind === 'bench') {
    box(-w / 2, -30, w, 22, G.woodLight); rect(-w / 2, -30, w, 5, '#ecc99d');
    for (const x of [-w / 2 + 8, w / 2 - 14]) rect(x, -8, 6, 22, G.woodDark);
    towel(-w / 2 + 16, -40, '#8fc4ea');
    for (let i = 0; i < 3; i++) { box(w * .05 + i * 18, -50, 12, 20, ['#3f6fa8', '#c8553d', '#4f8a55'][i]); rect(w * .05 + i * 18 + 3, -54, 6, 4, '#f6efe0'); }
    if (active && !reduced) oval(-w / 4, -60 - (t * 20) % 20, 4, 4, '#c7e6f5');
  } else if (kind === 'cooler') {
    box(-w * .4, -50, w * .8, 56, '#3f6fa8'); rect(-w * .4, -50, w * .8, 10, '#f6efe0'); rect(-w * .4 + 4, -36, w * .8 - 8, 4, '#5584bd');
    for (let i = 0; i < 4; i++) { box(-w * .3 + i * w * .16, -66, 10, 22, ['#e7b54a', '#4f8a55', '#c8553d', '#8fc9ea'][i]); rect(-w * .3 + i * w * .16 + 2, -70, 6, 4, '#f6efe0'); }
    for (let i = 0; i < 5; i++) rect(-w * .3 + hash(i, 9) * w * .6, -50 + hash(9, i) * 6, 6, 6, '#e8f6fd');
    if (active && !reduced) for (let i = 0; i < 3; i++) rect(-10 + i * 10, -80 - ((t * 24 + i * 8) % 24), 3, 6, '#ffffffb0');
  } else if (kind === 'hurdle') {
    for (const x of [-w / 2 + 4, w / 2 - 10]) { rect(x, -54, 6, 64, G.steelDark); box(x - 8, 6, 22, 6, G.steelDark); }
    const tilt = active && !reduced ? Math.sin(t * 8) * 4 : 0;
    box(-w / 2, -64 + tilt, w, 14, '#f6efe0');
    for (let x = -w / 2 + 6; x < w / 2; x += 24) rect(x, -64 + tilt, 12, 14, INK);
  } else if (kind === 'vault') {
    for (let i = 0; i < 4; i++) { const y = -18 - i * 18; box(-w / 2 + i * 4, y, w - i * 8, 16, G.woodLight); rect(-w / 2 + i * 4, y, w - i * 8, 3, '#ecc99d'); }
    box(-w / 2 + 14, -98, w - 28, 18, '#f6efe0'); rect(-w / 2 + 18, -94, w - 36, 4, '#ffffff');
    if (active && !reduced) for (let i = 0; i < 3; i++) rect(-20 + i * 20, -112 - Math.abs(Math.sin(t * 5 + i)) * 18, 6, 6, '#fff1b8');
  } else if (kind === 'tire') {
    const bob = active && !reduced ? Math.abs(Math.sin(t * 6)) * 6 : 0;
    oval(0, -18 - bob, w * .42 + 2, w * .2 + 2, INK); oval(0, -20 - bob, w * .42, w * .2, '#3a3d44');
    oval(0, -22 - bob, w * .2, w * .09, G.outside);
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; rect(Math.cos(a) * w * .32 - 2, -20 - bob + Math.sin(a) * w * .14 - 2, 4, 4, '#55595f'); }
  } else {
    // Gym plant; varies by id so the hall does not look copy-pasted.
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
