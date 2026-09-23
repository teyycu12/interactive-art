/**
 * 模組 M1 — 結構化模組捏臉素材目錄（Curated Component System）
 *
 * 設計原則：角色不是 AI 全圖生成，而是由「有限、策展過的模組」組裝而成。
 * 每個模組是一個 token（如 head_curly_02），Avatar Config JSON 只傳 token，
 * 不傳圖像資料 —— 這是手機端能在 1 秒內載入、且伺服器能做嚴格驗證的前提。
 *
 * 畫法在 shared/pixelAvatar.js：像素 Q 版角色、四個方向、三格步態，
 * 與大螢幕的像素場景同一套畫風。本檔只管目錄、調色盤與驗證 ——
 * token 與白名單是協定的一部分，換畫風不能動到它們。
 */

import { pixelGrid, pixelPalette, gridToSVG, PIXEL_W, PIXEL_H } from './pixelAvatar.js';

// ─────────────────────────────────────────────────────────────
// 頭部 / 髮型模組（hair 為該髮型的預設髮色；毛帽則是帽子顏色）
// ─────────────────────────────────────────────────────────────
export const HEADS = [
  { id: 'head_short_01', label: '俐落短髮', hair: '#3A2E27' },
  { id: 'head_curly_02', label: '蓬鬆捲髮', hair: '#4A2C1A' },
  { id: 'head_bun_03', label: '丸子頭', hair: '#2B2B33' },
  { id: 'head_long_04', label: '及肩長髮', hair: '#5B3A29' },
  { id: 'head_cap_05', label: '毛帽', hair: '#457B9D' },
  { id: 'head_bald_06', label: '光頭', hair: '#3A2E27' },
];

// ─────────────────────────────────────────────────────────────
// 臉部 / 表情模組
// ─────────────────────────────────────────────────────────────
export const FACES = [
  { id: 'face_smile_01', label: '微笑' },
  { id: 'face_smile_glasses', label: '眼鏡微笑' },
  { id: 'face_wink_02', label: '眨眼' },
  { id: 'face_calm_03', label: '恬靜' },
  { id: 'face_grin_04', label: '大笑' },
  { id: 'face_shades_05', label: '墨鏡' },
];

// ─────────────────────────────────────────────────────────────
// 身體 / 服裝模組（accentColor 作為主要填色）
// ─────────────────────────────────────────────────────────────
export const BODIES = [
  { id: 'body_tee_01', label: '素T' },
  { id: 'body_hoodie_01', label: '連帽衫' },
  { id: 'body_shirt_02', label: '襯衫' },
  { id: 'body_dress_03', label: '洋裝' },
  { id: 'body_jacket_04', label: '外套' },
  { id: 'body_tank_05', label: '背心' },
];

// ─────────────────────────────────────────────────────────────
// 色彩調色盤
// ─────────────────────────────────────────────────────────────
export const SKIN_TONES = ['#FFD9B8', '#F4A261', '#E8B48C', '#C68642', '#8D5524', '#5C3A21'];
export const ACCENT_COLORS = [
  '#E76F51', '#2A9D8F', '#E9C46A', '#457B9D',
  '#B56576', '#6D6875', '#84A98C', '#F4845F',
];

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

/**
 * 未切割的整張角色圖。
 *
 * 選用欄位：2D 大螢幕優先用它，因為切了又照同一組比例疊回去等於沒切，
 * 卻換來三個請求、三次載入失敗風險，以及三張各自被拉伸到固定寬度造成的
 * 整體變形。三張切片保留給之後貼到 3D 部件、做肢體動作的用途。
 *
 * 刻意設為選用而非必要：舊的資產目錄沒有 full.png，把它列為必要會讓
 * 那些角色在驗證階段整個被拒，等於一次改版就把先前生成的人全部踢出場。
 */
export const CV_FULL_PART = 'full';

/** 貼圖 URL：路徑形狀完全鎖死，杜絕路徑穿越與任意檔案讀取 */
const TEXTURE_URL_RE = /^\/assets\/gen\/([0-9a-f]{32})\/(head|torso|legs|full)\.webp$/;
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

  // 整張圖：有才驗，沒有就當這是改版前生成的資產，走三張切片那條路。
  // 驗法與必要部位完全相同，包含「必須同屬一個資產目錄」——
  // 少了那一條，就等於允許把別人的整張圖拼進自己的角色。
  if (textures[CV_FULL_PART] !== undefined) {
    const url = textures[CV_FULL_PART];
    if (typeof url !== 'string') return { ok: false, reason: 'textures.full 必須是字串' };
    const m = TEXTURE_URL_RE.exec(url);
    if (!m) return { ok: false, reason: 'textures.full 不是合法的貼圖路徑' };
    if (m[2] !== CV_FULL_PART) return { ok: false, reason: 'textures.full 的檔名與部位不符' };
    if (m[1] !== assetId) return { ok: false, reason: 'textures 混用了不同的資產目錄' };
    cleanTextures[CV_FULL_PART] = url;
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
 * 像素角色需要的「部位 token + 調色盤」。
 *
 * CV 角色沒有 token 與調色盤欄位：改用生成服務取樣回來的顏色套在預設身形上
 * （連下身顏色也用取樣的），呼叫端要的是「一眼認得出是誰」的小圖。
 * 若不接這個分支，這些欄位會是 undefined 並被插值成 fill="undefined"。
 */
export function avatarPixelSpec(cfg) {
  if (cfg?.source === 'CV') {
    const c = cfg.fallbackColors;
    return {
      parts: { head: HEADS[0].id, face: FACES[0].id, body: BODIES[0].id },
      pal: pixelPalette({ skin: c.skin, hair: c.hair, accent: c.torso, pants: c.legs }),
    };
  }
  const head = HEAD_MAP[cfg.head] ?? HEADS[0];
  return {
    parts: {
      head: head.id,
      face: (FACE_MAP[cfg.face] ?? FACES[0]).id,
      body: (BODY_MAP[cfg.body] ?? BODIES[0]).id,
    },
    pal: pixelPalette({ skin: cfg.skinTone, hair: head.hair, accent: cfg.accentColor }),
  };
}

/**
 * 給手機名冊用的精簡外觀：捏臉原樣（本來就只有 token 與白名單色），
 * CV 只留取樣色、丟掉貼圖網址。手機據此把鄰居畫成像素角色。
 */
export function avatarLook(cfg) {
  if (!cfg) return null;
  if (cfg.source === 'CV') return { source: 'CV', fallbackColors: cfg.fallbackColors };
  return cfg;
}

/** 單一方向、單一步態格的像素格子（見 shared/pixelAvatar.js） */
export function avatarGrid(cfg, dir = 'down', frame = 0, pose = null) {
  const { parts, pal } = avatarPixelSpec(cfg);
  return pixelGrid(parts, pal, dir, frame, pose);
}

/** 像素角色的寬高比（寬 / 高）。版面與大螢幕的繪製尺寸都以它為準。 */
export const AVATAR_ASPECT = PIXEL_W / PIXEL_H;

/**
 * 依 Avatar Config 輸出正面站立的像素 SVG（捏臉預覽、縮圖、主辦端名單）。
 * 大螢幕與手機 POV 不走這裡，而是由 avatarSprite.js 直接把格子畫進 canvas。
 */
export function renderAvatarSVG(cfg, { width = 200, height = 270 } = {}) {
  return gridToSVG(avatarGrid(cfg, 'down', 0), { width, height });
}
