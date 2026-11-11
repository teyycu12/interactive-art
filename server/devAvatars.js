/**
 * 開發用：把過去生成過的角色列出來，供人物匯入台重新放回場上。
 *
 * ── 為什麼需要 ──
 * 要驗「10 個人在場上時遊戲玩不玩得起來」，得真的有 10 個角色。但 10 個角色
 * 意味著 10 支手機、10 張照片、10 次約 25 秒的生成 —— 開發時湊不出來，
 * 而「任務指到的桌子擠不擠得下」「名牌會不會疊在一起」這類問題
 * 只能真的擺 10 個人上去才看得出來。
 *
 * ── 為什麼直接讀目錄，而不是查生成歷史資料庫 ──
 * backend/logs 的 generation_history 記的是「那一次生成做了什麼」（耗時、
 * token、花費、驗證結果），它存的是結果圖，不是切好的貼圖。而場上要的是
 * `/assets/gen/<id>/{head,torso,legs,full}.webp` 這組路徑 —— 那是
 * shared/avatars.js 的 TEXTURE_URL_RE 唯一接受的形狀。貼圖目錄本身就是
 * 「可以直接上場的角色」的權威清單，繞過資料庫反而少一層會對不上的轉換。
 *
 * ⚠ 這是開發／調校工具。匯入的角色會佔用 MAX_AGENTS 名額，
 *   現場請勿使用（與 scripts/bots.mjs 同一個理由）。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/** 與 shared/avatars.js 的 TEXTURE_URL_RE 同一組字元集：資產目錄名是 uuid4().hex */
const ASSET_ID_RE = /^[0-9a-f]{32}$/;

/**
 * 必須齊全的四張貼圖。
 *
 * 缺任何一張就整組跳過，而不是「有幾張算幾張」—— validateAvatarConfig 會
 * 把缺件的 textures 整個拒掉（CLIENT_REJECT），讓它出現在清單上只會變成
 * 匯入台上按了沒反應的那一格。
 */
const REQUIRED_PARTS = ['head', 'torso', 'legs', 'full'];
/**
 * 有就帶上的側面與背面。少了它們角色只有正面：不會轉身、走路也不會擺手
 * （shared/avatarSprite.js 只在有側面時才載入 arms.json、算擺手）。
 * 原本這裡只列必要的四張，從這份清單上場的 NPC 與匯入台角色因此永遠面向鏡頭、手腳不動。
 */
const VIEW_PARTS = ['side', 'back'];

const FALLBACK_KEYS = ['skin', 'hair', 'torso', 'legs'];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** colors.json 必須四個鍵齊全且都是合法色碼，否則視為沒有取樣過 */
function validColors(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of FALLBACK_KEYS) {
    if (typeof raw[key] !== 'string' || !HEX_RE.test(raw[key])) return null;
    out[key] = raw[key];
  }
  return out;
}

/**
 * 列出所有可以直接上場的歷史角色。
 *
 * colors 來自 scripts/asset_colors.py 離線取樣的 colors.json。取不到時回 null
 * 而不是就地補一組假的：顏色任務的色族判定讀的正是 fallbackColors
 * （shared/colorFamily.js），假色會讓任務叫大家去找「紅衣服的人」而那個人
 * 在畫面上是藍的。匯入台看到 null 會明確警告，而不是安靜地給出錯的答案。
 *
 * @param {string} publicDir 靜態站台根目錄
 * @returns {Promise<Array<{assetId: string, textures: object, colors: object|null, generatedAt: number}>>}
 *   依產生時間新到舊排序
 */
export async function listHistoricalAvatars(publicDir) {
  const root = path.join(publicDir, 'assets', 'gen');
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];   // 還沒有人生成過，不是錯誤
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ASSET_ID_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);

    let stats;
    try {
      stats = await Promise.all(
        REQUIRED_PARTS.map((part) => fs.stat(path.join(dir, `${part}.webp`))),
      );
    } catch {
      continue;  // 少一張（或是改版前的 .png 舊資產）就跳過
    }

    let colors = null;
    let outfit = [];
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'colors.json'), 'utf8'));
      colors = validColors(raw);
      // 身上的衣服顏色清單（generation 與 scripts/asset_colors.py 寫在同一個檔）
      if (Array.isArray(raw?.outfit)) outfit = raw.outfit.filter((h) => typeof h === 'string' && HEX_RE.test(h));
    } catch {
      colors = null;  // 沒跑過取樣腳本
    }

    const views = [];
    for (const part of VIEW_PARTS) {
      try {
        await fs.stat(path.join(dir, `${part}.webp`));
        views.push(part);
      } catch { /* 改版前的資產沒有側面／背面 */ }
    }

    out.push({
      assetId: entry.name,
      textures: Object.fromEntries(
        [...REQUIRED_PARTS, ...views].map((part) => [part, `/assets/gen/${entry.name}/${part}.webp`]),
      ),
      /** 側面與背面都有：會轉身、會擺手 */
      turns: views.length === VIEW_PARTS.length,
      colors,
      outfit,
      generatedAt: Math.max(...stats.map((s) => s.mtimeMs)),
    });
  }

  // 新的排前面：開發時最想重看的通常是剛生成的那幾個
  out.sort((a, b) => b.generatedAt - a.generatedAt);
  return out;
}

/**
 * CV 角色進場時沒帶 outfitColors，就從它的貼圖目錄的 colors.json 補上。
 *
 * 清單是 2026-11-04 才加的：在那之前就開著的手機分頁、存在 localStorage 的舊角色
 * 都不會送它，賓果與顏色任務就退回只看上衣、褲子各一色 —— 穿牛仔外套戴米色圍巾的人
 * 會被判成「只有橘黃」。生成服務寫的 colors.json 裡已經有清單，伺服器自己讀就不必
 * 等每支手機重新整理。讀不到、或角色不是生成服務做的（貼圖不在 /assets/gen/）就原樣回傳。
 *
 * @param {string} publicDir 靜態站台根目錄
 * @param {object} avatar validateAvatarConfig 驗過的 value
 * @param {number} max 最多幾個（shared/avatars.js 的 OUTFIT_COLORS_MAX）
 */
export function withAssetOutfit(publicDir, avatar, max) {
  if (avatar?.source !== 'CV' || avatar.outfitColors?.length) return avatar;
  const id = /^\/assets\/gen\/([0-9a-f]{32})\//.exec(avatar.textures?.full ?? '')?.[1];
  if (!id) return avatar;
  try {
    const raw = JSON.parse(fsSync.readFileSync(path.join(publicDir, 'assets', 'gen', id, 'colors.json'), 'utf8'));
    const outfit = Array.isArray(raw?.outfit)
      ? raw.outfit.filter((h) => typeof h === 'string' && HEX_RE.test(h)).slice(0, max)
      : [];
    return outfit.length ? { ...avatar, outfitColors: outfit } : avatar;
  } catch {
    return avatar;   // 舊資產沒有 colors.json：照舊只看上衣與褲子
  }
}
