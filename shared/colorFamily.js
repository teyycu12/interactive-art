/**
 * 顏色分族（COLOR_HUNT 任務）
 *
 * 任務條件是「找一位身上帶紅色的人」，因此需要把角色的取樣色歸類成
 * 人眼講得出名字的幾個族。三端都要用同一份：
 *   - 主辦端：渲染顏色選單
 *   - 伺服器：驗證配對是否符合條件（不能信任客戶端）
 *   - 手機端：顯示「你要找的是 🔴 紅色」
 * 各自存一份必然漂移，屆時會出現「手機說找紅色、伺服器判定不符」
 * 這種完全無法除錯的現象（與 QUIZ_CHOICES 是同一個理由）。
 *
 * ⚠ 分族走 HSL 的色相角度，而非比對 ACCENT_COLORS 白名單 ——
 *   因為 CV 角色的顏色取樣自真實照片，無法事先列舉（見 avatars.js 的
 *   HEX_RE 說明）。捏臉角色的調色盤色也會落進同一套規則，兩種來源
 *   因此共用一條判定路徑。
 */

/**
 * 色族定義。hueRange 為色相角度區間（0–360，可跨 0 度）。
 *
 * 刻意只留 6 族：現場是隔著幾公尺、在有色燈光下辨認衣服顏色，
 * 分太細（靛/青/洋紅）會讓參與者對「這算不算藍」產生爭議，
 * 而爭議會直接變成客訴。寧可粗一點但人人判斷一致。
 */
export const COLOR_FAMILIES = [
  { id: 'RED',    label: '紅色', glyph: '🔴', swatch: '#E63946', hueRange: [340, 20] },
  { id: 'ORANGE', label: '橘黃', glyph: '🟠', swatch: '#F4A261', hueRange: [20, 65] },
  { id: 'GREEN',  label: '綠色', glyph: '🟢', swatch: '#2A9D8F', hueRange: [65, 175] },
  { id: 'BLUE',   label: '藍色', glyph: '🔵', swatch: '#457B9D', hueRange: [175, 255] },
  { id: 'PURPLE', label: '紫色', glyph: '🟣', swatch: '#8E7CC3', hueRange: [255, 340] },
  /**
   * 無彩色自成一族。純以色相判定會把白襯衫歸進某個隨機顏色 ——
   * 灰階的 hue 在數學上沒有意義（飽和度為 0 時 hue 恆為 0，會全被判成紅），
   * 因此必須在色相之前先攔截。
   */
  { id: 'MONO',   label: '黑白灰', glyph: '⚪', swatch: '#6D6875', hueRange: null },
];

export const COLOR_FAMILY_MAP = Object.fromEntries(
  COLOR_FAMILIES.map((f) => [f.id, f]),
);

/**
 * 飽和度低於此值視為無彩色。
 *
 * 取 0.12 而非更高：調色盤裡的鼠尾草綠 #84A98C 飽和度只有 0.18，
 * 門檻設在 0.18 會讓它被判成「黑白灰」—— 而它在大螢幕上明顯是綠的。
 * 「看起來有顏色卻被判無彩色」是最難跟現場參與者解釋的一種失敗。
 */
const MONO_SATURATION = 0.12;

/** #RRGGBB → {h: 0–360, s: 0–1, l: 0–1} */
export function hexToHSL(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** 色相是否落在區間內（區間可跨越 0 度，如紅色的 345–20） */
function hueIn(h, [lo, hi]) {
  return lo <= hi ? h >= lo && h < hi : h >= lo || h < hi;
}

/**
 * 把任一 #RRGGBB 歸類到色族。
 * @returns {string|null} 色族 id，非法輸入回傳 null
 */
export function familyOf(hex) {
  const hsl = hexToHSL(hex);
  if (!hsl) return null;
  // 極暗、極亮或低飽和一律歸為無彩色。順序不能調到色相判定之後，
  // 理由見 COLOR_FAMILIES 的 MONO 註解。
  if (hsl.s < MONO_SATURATION || hsl.l < 0.12 || hsl.l > 0.92) return 'MONO';
  for (const f of COLOR_FAMILIES) {
    if (f.hueRange && hueIn(hsl.h, f.hueRange)) return f.id;
  }
  return 'MONO';
}

/**
 * 取出角色「身上的顏色」。
 *
 * 兩種角色來源的欄位不同（見 avatars.js 的 renderAvatarSVG）：
 * CV 角色用取樣回來的 fallbackColors，捏臉角色用調色盤的 accentColor。
 * 這裡與那邊取同一個欄位，因此「大螢幕上看到的顏色」與「任務判定的顏色」
 * 必定一致 —— 不一致的話參與者會覺得系統在騙人。
 *
 * 同時看軀幹與褲子：任務說的是「身上帶這個顏色」，只看上衣會讓
 * 穿紅褲子的人明明符合卻被判不符。
 *
 * @returns {string[]} 該角色涵蓋的色族 id（去重）
 */
export function familiesOfAvatar(avatar) {
  if (!avatar || typeof avatar !== 'object') return [];
  const hexes = avatar.source === 'CV'
    ? [avatar.fallbackColors?.torso, avatar.fallbackColors?.legs]
    : [avatar.accentColor];
  const out = new Set();
  for (const hex of hexes) {
    const f = familyOf(hex);
    if (f) out.add(f);
  }
  return [...out];
}

/** 角色是否符合指定色族 */
export function avatarMatchesFamily(avatar, familyId) {
  if (!COLOR_FAMILY_MAP[familyId]) return false;
  return familiesOfAvatar(avatar).includes(familyId);
}
