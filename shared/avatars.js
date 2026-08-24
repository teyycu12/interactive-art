/**
 * 模組 M1 — 結構化模組捏臉素材目錄（Curated Component System）
 *
 * 設計原則：角色不是 AI 全圖生成，而是由「有限、策展過的模組」組裝而成。
 * 每個模組是一個 token（如 head_curly_02），Avatar Config JSON 只傳 token，
 * 不傳圖像資料 —— 這是手機端能在 1 秒內載入、且伺服器能做嚴格驗證的前提。
 *
 * 座標系：viewBox 0 0 200 260
 *   - 頭部橢圓中心 (100, 78)，rx 37 / ry 41
 *   - 肩線 y ≈ 136，軀幹延伸至 y = 260（半身像）
 *
 * ⚠ 本檔的 SVG 為風格對齊的手繪佔位素材。WP-A 若要換成官方 Open Peeps
 *   向量資產，只需替換各 part 的 svg 字串，組裝與驗證邏輯無須更動。
 */

const INK = '{{ink}}';

/* ── 手臂共用路徑 ─────────────────────────────────────────────
   手臂以「粗墨線打底 + 細填色線覆蓋」的方式繪製，
   兩者寬度差即形成 3.5px 的手繪外框，省去逐一描邊路徑。 */
const ARM_L = 'M72 150 Q52 168 50 200';
const ARM_R = 'M128 150 Q148 168 150 200';
const HANDS = `
  <circle cx="50" cy="205" r="9" fill="{{skin}}" stroke="${INK}" stroke-width="3"/>
  <circle cx="150" cy="205" r="9" fill="{{skin}}" stroke="${INK}" stroke-width="3"/>`;

/** 長袖：整條手臂為衣服顏色 */
function armsLong(color) {
  return `
  <path d="${ARM_L}" fill="none" stroke="${INK}" stroke-width="25" stroke-linecap="round"/>
  <path d="${ARM_R}" fill="none" stroke="${INK}" stroke-width="25" stroke-linecap="round"/>
  <path d="${ARM_L}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round"/>
  <path d="${ARM_R}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round"/>
  ${HANDS}`;
}

/** 短袖：裸露膚色手臂，肩頭覆蓋一小段衣袖 */
function armsShort() {
  return armsLong('{{skin}}') + `
  <path d="M72 150 Q60 158 55 173" fill="none" stroke="${INK}" stroke-width="26" stroke-linecap="round"/>
  <path d="M128 150 Q140 158 145 173" fill="none" stroke="${INK}" stroke-width="26" stroke-linecap="round"/>
  <path d="M72 150 Q60 158 55 173" fill="none" stroke="{{accent}}" stroke-width="19" stroke-linecap="round"/>
  <path d="M128 150 Q140 158 145 173" fill="none" stroke="{{accent}}" stroke-width="19" stroke-linecap="round"/>`;
}

/** 無袖：純膚色手臂 */
const armsBare = () => armsLong('{{skin}}');

/** 標準軀幹輪廓 */
const TORSO = 'M64 260 L64 176 Q64 142 100 136 Q136 142 136 176 L136 260 Z';

// ─────────────────────────────────────────────────────────────
// 頭部 / 髮型模組
// ─────────────────────────────────────────────────────────────
export const HEADS = [
  {
    id: 'head_short_01', label: '俐落短髮', hair: '#3A2E27',
    svg: `<path d="M63 76 Q60 38 100 36 Q140 38 137 76 Q132 52 100 50 Q68 52 63 76 Z"
            fill="{{hair}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`,
  },
  {
    id: 'head_curly_02', label: '蓬鬆捲髮', hair: '#4A2C1A',
    // 以數個交疊圓形堆出捲度，外露的交界線在手繪風格中正好讀作捲曲
    svg: `<g fill="{{hair}}" stroke="${INK}" stroke-width="3">
            <circle cx="70" cy="62" r="14"/><circle cx="86" cy="46" r="15"/>
            <circle cx="108" cy="43" r="15"/><circle cx="127" cy="55" r="14"/>
            <circle cx="134" cy="72" r="12"/><circle cx="65" cy="78" r="12"/>
          </g>`,
  },
  {
    id: 'head_bun_03', label: '丸子頭', hair: '#2B2B33',
    svg: `<circle cx="100" cy="28" r="16" fill="{{hair}}" stroke="${INK}" stroke-width="3.5"/>
          <path d="M63 74 Q62 40 100 38 Q138 40 137 74 Q130 54 100 52 Q70 54 63 74 Z"
            fill="{{hair}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`,
  },
  {
    id: 'head_long_04', label: '及肩長髮', hair: '#5B3A29',
    svg: `<path d="M60 70 Q58 34 100 34 Q142 34 140 70 L140 142 Q131 149 127 139
                   L127 84 Q119 60 100 58 Q81 60 73 84 L73 139 Q69 149 60 142 Z"
            fill="{{hair}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`,
  },
  {
    id: 'head_cap_05', label: '毛帽', hair: '#457B9D',
    svg: `<path d="M62 70 Q60 30 100 30 Q140 30 138 70 Z"
            fill="{{hair}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
          <rect x="57" y="64" width="86" height="15" rx="7.5"
            fill="{{hair}}" stroke="${INK}" stroke-width="3.5"/>`,
  },
  {
    id: 'head_bald_06', label: '光頭', hair: '#3A2E27',
    svg: `<path d="M76 52 Q86 42 100 44" fill="none" stroke="${INK}"
            stroke-width="3" stroke-linecap="round" opacity="0.3"/>`,
  },
];

// ─────────────────────────────────────────────────────────────
// 臉部 / 表情模組
// ─────────────────────────────────────────────────────────────
export const FACES = [
  {
    id: 'face_smile_01', label: '微笑',
    svg: `<circle cx="85" cy="78" r="4.5" fill="${INK}"/>
          <circle cx="115" cy="78" r="4.5" fill="${INK}"/>
          <path d="M88 96 Q100 106 112 96" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>`,
  },
  {
    id: 'face_smile_glasses', label: '眼鏡微笑',
    svg: `<circle cx="85" cy="78" r="4" fill="${INK}"/>
          <circle cx="115" cy="78" r="4" fill="${INK}"/>
          <circle cx="85" cy="78" r="12" fill="none" stroke="${INK}" stroke-width="3"/>
          <circle cx="115" cy="78" r="12" fill="none" stroke="${INK}" stroke-width="3"/>
          <path d="M97 78 L103 78" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
          <path d="M88 98 Q100 107 112 98" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>`,
  },
  {
    id: 'face_wink_02', label: '眨眼',
    svg: `<circle cx="85" cy="78" r="4.5" fill="${INK}"/>
          <path d="M108 80 Q115 72 122 80" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>
          <path d="M88 96 Q100 106 112 96" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>`,
  },
  {
    id: 'face_calm_03', label: '恬靜',
    svg: `<path d="M78 80 Q85 72 92 80" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>
          <path d="M108 80 Q115 72 122 80" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>
          <path d="M93 98 L107 98" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`,
  },
  {
    id: 'face_grin_04', label: '大笑',
    svg: `<circle cx="85" cy="76" r="4.5" fill="${INK}"/>
          <circle cx="115" cy="76" r="4.5" fill="${INK}"/>
          <path d="M84 94 Q100 112 116 94 Z" fill="${INK}" stroke="${INK}"
            stroke-width="3.5" stroke-linejoin="round"/>`,
  },
  {
    id: 'face_shades_05', label: '墨鏡',
    svg: `<path d="M68 71 L132 71" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
          <rect x="70" y="70" width="26" height="18" rx="7" fill="${INK}"/>
          <rect x="104" y="70" width="26" height="18" rx="7" fill="${INK}"/>
          <path d="M96 76 L104 76" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
          <path d="M90 100 Q100 106 110 100" fill="none" stroke="${INK}"
            stroke-width="3.5" stroke-linecap="round"/>`,
  },
];

// ─────────────────────────────────────────────────────────────
// 身體 / 服裝模組（accentColor 作為主要填色）
// ─────────────────────────────────────────────────────────────
export const BODIES = [
  {
    id: 'body_tee_01', label: '素T',
    svg: armsShort() + `
      <path d="${TORSO}" fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M88 138 Q100 149 112 138" fill="none" stroke="${INK}"
        stroke-width="3.5" stroke-linecap="round"/>`,
  },
  {
    id: 'body_hoodie_01', label: '連帽衫',
    svg: armsLong('{{accent}}') + `
      <path d="${TORSO}" fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M75 145 Q100 127 125 145 Q118 164 100 166 Q82 164 75 145 Z"
        fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M90 162 L88 186" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <path d="M110 162 L112 186" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <path d="M79 208 L121 208 L125 238 L75 238 Z" fill="none" stroke="${INK}"
        stroke-width="3.5" stroke-linejoin="round"/>`,
  },
  {
    id: 'body_shirt_02', label: '襯衫',
    svg: armsLong('{{accent}}') + `
      <path d="${TORSO}" fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M86 137 L100 158 L114 137" fill="none" stroke="${INK}"
        stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M100 162 L100 250" stroke="${INK}" stroke-width="3" stroke-dasharray="1 14"
        stroke-linecap="round"/>`,
  },
  {
    id: 'body_dress_03', label: '洋裝',
    svg: armsBare() + `
      <path d="M52 260 Q60 200 66 176 Q66 142 100 136 Q134 142 134 176
               Q140 200 148 260 Z"
        fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M86 137 Q100 150 114 137" fill="none" stroke="${INK}"
        stroke-width="3.5" stroke-linecap="round"/>
      <path d="M64 214 Q100 226 136 214" fill="none" stroke="${INK}"
        stroke-width="3" stroke-linecap="round" opacity="0.5"/>`,
  },
  {
    id: 'body_jacket_04', label: '外套',
    svg: armsLong('{{accent}}') + `
      <path d="${TORSO}" fill="#FAF8F5" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M64 260 L64 176 Q64 142 100 136 L92 260 Z"
        fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M136 260 L136 176 Q136 142 100 136 L108 260 Z"
        fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`,
  },
  {
    id: 'body_tank_05', label: '背心',
    svg: armsBare() + `
      <path d="${TORSO}" fill="{{accent}}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M82 139 Q100 168 118 139" fill="{{skin}}" stroke="${INK}"
        stroke-width="3.5" stroke-linejoin="round"/>`,
  },
];

// ─────────────────────────────────────────────────────────────
// 色彩調色盤
// ─────────────────────────────────────────────────────────────
export const SKIN_TONES = ['#FFD9B8', '#F4A261', '#E8B48C', '#C68642', '#8D5524', '#5C3A21'];
export const ACCENT_COLORS = [
  '#E76F51', '#2A9D8F', '#E9C46A', '#457B9D',
  '#B56576', '#6D6875', '#84A98C', '#F4845F',
];

/** 手繪風格的墨線顏色，全系統統一 */
export const INK_COLOR = '#2F2A26';

// ─────────────────────────────────────────────────────────────
// 查詢與驗證
// ─────────────────────────────────────────────────────────────
const byId = (list) => Object.fromEntries(list.map((p) => [p.id, p]));
const HEAD_MAP = byId(HEADS);
const FACE_MAP = byId(FACES);
const BODY_MAP = byId(BODIES);

// ─────────────────────────────────────────────────────────────
// CV 角色（掃描生成）
//
// 參與者拍照後由 vision/ 服務生成去背人偶圖，切成三張貼圖落地到
// public/assets/gen/<assetId>/，Avatar Config 只帶 URL 而非影像資料 ——
// 與 token 分支「只傳 token 不傳圖像」是同一個理由：名冊訊息不能膨脹。
//
// assetId 由生成服務配發，刻意與 userId 脫鉤：初次參與者在 CLIENT_JOIN
// 之前還沒有 userId，若用 userId 當目錄名，生成與入場就會互相等待。
// ─────────────────────────────────────────────────────────────

/**
 * 三張貼圖在角色全身高度上的垂直比例區間。
 *
 * ⚠ 必須與 backend/slicer.py 的 CUTS 完全一致 —— 那邊照這個比例把圖切開，
 *   這邊照同一個比例把圖疊回去。任一邊改了而另一邊沒跟上，角色會出現
 *   脖子錯位或腿被壓扁，而且不會有任何錯誤訊息。
 *   backend/tests/test_slicer.py 有一條測試會直接比對兩邊的數值。
 */
export const CV_CUTS = {
  head: [0.00, 0.30],
  torso: [0.30, 0.64],
  legs: [0.64, 1.00],
};

/** 貼圖部位順序（由上到下） */
export const CV_PARTS = ['head', 'torso', 'legs'];

/** 貼圖 URL：路徑形狀完全鎖死，杜絕路徑穿越與任意檔案讀取 */
const TEXTURE_URL_RE = /^\/assets\/gen\/([0-9a-f]{32})\/(head|torso|legs)\.webp$/;
const TEXTURE_PARTS = CV_PARTS;

/**
 * 取樣色的十六進位格式。
 *
 * 這裡不能沿用調色盤白名單 —— CV 的顏色取樣自真實照片，無法事先列舉。
 * 改用嚴格錨定的 regex：6 位十六進位的字元集本身就排除了 `<`、`"`、`;`，
 * 因此即使被插值進 markup 也同樣不可能注入，安全性與白名單等價。
 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_KEYS = ['skin', 'hair', 'torso', 'legs'];

/**
 * 驗證掃描生成的角色外觀。
 *
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
function validateCVAvatar(cfg) {
  const { textures, fallbackColors } = cfg;
  if (!textures || typeof textures !== 'object') {
    return { ok: false, reason: 'CV 角色缺少 textures' };
  }

  const cleanTextures = {};
  let assetId = null;
  for (const part of TEXTURE_PARTS) {
    const url = textures[part];
    if (typeof url !== 'string') return { ok: false, reason: `textures.${part} 必須是字串` };
    const m = TEXTURE_URL_RE.exec(url);
    if (!m) return { ok: false, reason: `textures.${part} 不是合法的貼圖路徑` };
    if (m[2] !== part) return { ok: false, reason: `textures.${part} 的檔名與部位不符` };
    // 三張貼圖必須同屬一個資產目錄，否則等於允許拼接他人的貼圖
    if (assetId === null) assetId = m[1];
    else if (m[1] !== assetId) return { ok: false, reason: 'textures 混用了不同的資產目錄' };
    cleanTextures[part] = url;
  }

  if (!fallbackColors || typeof fallbackColors !== 'object') {
    return { ok: false, reason: 'CV 角色缺少 fallbackColors' };
  }
  const cleanColors = {};
  for (const key of FALLBACK_KEYS) {
    const hex = fallbackColors[key];
    if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
      return { ok: false, reason: `fallbackColors.${key} 不是合法的 #RRGGBB` };
    }
    cleanColors[key] = hex;
  }

  // 同樣只取白名單欄位，丟棄客戶端夾帶的任何額外屬性
  return { ok: true, value: { source: 'CV', textures: cleanTextures, fallbackColors: cleanColors } };
}

/**
 * 驗證 Avatar Config（WP-A 驗收項：資料驗證）。
 *
 * 兩種來源：`source: 'CV'` 為掃描生成，其餘一律走原本的模組捏臉。
 * 捏臉是掃描失敗時的備援路徑（相機權限被拒、光線不足、生成失敗），
 * 因此它的驗證邏輯一個字都不能動。
 *
 * 顏色一律比對調色盤白名單，而非只用 hex regex —— 因為顏色會被字串插值進
 * SVG markup，白名單能從根本消除 SVG/CSS 注入的可能。
 *
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function validateAvatarConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, reason: 'avatarConfig 必須是物件' };
  if (cfg.source === 'CV') return validateCVAvatar(cfg);
  if (!HEAD_MAP[cfg.head]) return { ok: false, reason: `未知的 head token：${cfg.head}` };
  if (!FACE_MAP[cfg.face]) return { ok: false, reason: `未知的 face token：${cfg.face}` };
  if (!BODY_MAP[cfg.body]) return { ok: false, reason: `未知的 body token：${cfg.body}` };
  if (!ACCENT_COLORS.includes(cfg.accentColor)) return { ok: false, reason: 'accentColor 不在調色盤內' };
  if (!SKIN_TONES.includes(cfg.skinTone)) return { ok: false, reason: 'skinTone 不在調色盤內' };
  // 只取白名單欄位，丟棄客戶端夾帶的任何額外屬性
  return {
    ok: true,
    value: {
      head: cfg.head, face: cfg.face, body: cfg.body,
      accentColor: cfg.accentColor, skinTone: cfg.skinTone,
    },
  };
}

/** 隨機產生一組合法的 Avatar Config，用於捏臉初始值與「隨機一下」按鈕 */
export function randomAvatarConfig() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return {
    head: pick(HEADS).id,
    face: pick(FACES).id,
    body: pick(BODIES).id,
    accentColor: pick(ACCENT_COLORS),
    skinTone: pick(SKIN_TONES),
  };
}

/**
 * 依 Avatar Config 組裝完整 SVG。
 *
 * 圖層順序（由後至前）：脖子 → 身體 → 頭型底 → 髮型 → 臉部
 * 身體必須在脖子之後，衣領才能自然蓋住脖子根部。
 */
export function renderAvatarSVG(cfg, { width = 200, height = 260 } = {}) {
  const head = HEAD_MAP[cfg.head] ?? HEADS[0];
  const face = FACE_MAP[cfg.face] ?? FACES[0];
  const body = BODY_MAP[cfg.body] ?? BODIES[0];

  // CV 角色沒有 token 與調色盤欄位。這裡改用生成服務取樣回來的顏色，
  // 套在預設身形上 —— 呼叫端（配對確認、離場畫面、控制器縮圖）要的是
  // 「一眼認得出是誰」的小圖，取樣色已足夠；貼圖本人由大螢幕負責呈現。
  // 若不接這個分支，這些欄位會是 undefined 並被插值成 fill="undefined"。
  const isCV = cfg.source === 'CV';
  const skin = isCV ? cfg.fallbackColors.skin : cfg.skinTone;
  const accent = isCV ? cfg.fallbackColors.torso : cfg.accentColor;
  const hair = isCV ? cfg.fallbackColors.hair : head.hair;

  const fill = (svg) => svg
    .replaceAll('{{ink}}', INK_COLOR)
    .replaceAll('{{skin}}', skin)
    .replaceAll('{{accent}}', accent)
    .replaceAll('{{hair}}', hair);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 260"
    width="${width}" height="${height}" fill="none" stroke-linecap="round">
    <path d="M86 100 L86 124 Q100 134 114 124 L114 100 Z"
      fill="${skin}" stroke="${INK_COLOR}" stroke-width="3.5" stroke-linejoin="round"/>
    ${fill(body.svg)}
    <ellipse cx="62" cy="86" rx="9" ry="11" fill="${skin}" stroke="${INK_COLOR}" stroke-width="3"/>
    <ellipse cx="138" cy="86" rx="9" ry="11" fill="${skin}" stroke="${INK_COLOR}" stroke-width="3"/>
    <ellipse cx="100" cy="78" rx="37" ry="41" fill="${skin}" stroke="${INK_COLOR}" stroke-width="3.5"/>
    ${fill(head.svg)}
    ${fill(face.svg)}
  </svg>`;
}
