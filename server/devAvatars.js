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
    try {
      colors = validColors(JSON.parse(await fs.readFile(path.join(dir, 'colors.json'), 'utf8')));
    } catch {
      colors = null;  // 沒跑過取樣腳本
    }

    out.push({
      assetId: entry.name,
      textures: Object.fromEntries(
        REQUIRED_PARTS.map((part) => [part, `/assets/gen/${entry.name}/${part}.webp`]),
      ),
      colors,
      generatedAt: Math.max(...stats.map((s) => s.mtimeMs)),
    });
  }

  // 新的排前面：開發時最想重看的通常是剛生成的那幾個
  out.sort((a, b) => b.generatedAt - a.generatedAt);
  return out;
}
