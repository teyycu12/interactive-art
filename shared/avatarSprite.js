/**
 * 角色圖像組裝 —— 大螢幕與手機端 POV 共用。
 *
 * 兩種來源：
 *   掃描生成（source: 'CV'）  三張貼圖依 CV_CUTS 的比例疊回一張畫布
 *   模組捏臉（備援路徑）      直接把 SVG 交給 Image 解碼
 *
 * 與 shared/character.js 同理放在 shared/：手機畫的角色若與大螢幕不是
 * 同一份組裝邏輯，比例或替身顏色一旦漂移，兩邊都不會報錯 ——
 * 只會出現「手機上的我」和「大螢幕上的我」長得不一樣。
 */

import { renderAvatarSVG, CV_CUTS, CV_PARTS } from './avatars.js';

export const AVATAR_W = 200;
export const AVATAR_H = 260;

/**
 * 掃描生成的角色：把三張貼圖依 CV_CUTS 的比例疊回一張畫布。
 *
 * 回傳 canvas 而非 Image —— drawCharacter 只要求 sprite 有 complete 與
 * naturalWidth（shared/character.js），canvas 兩者都能自行掛上，
 * 這樣就不必為了取得 Image 物件多繞一次 toDataURL 編解碼。
 *
 * 貼圖尚未載入時先用取樣色畫一個替身：現場的參與者在生成完成的瞬間
 * 就會看著大螢幕找自己，不能讓角色有一段時間是空白的。
 *
 * @param {object} avatar  source: 'CV' 的外觀設定
 * @param {{enhance?: boolean}} opts
 *   enhance 為真時套用對比與飽和度增強。投影機的實際亮度遠低於製作時的
 *   螢幕，大螢幕需要這層補償；手機是直視發光面板，套下去只會過曝。
 */
export function cvAvatarImage(avatar, { enhance = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_W;
  canvas.height = AVATAR_H;
  const ctx = canvas.getContext('2d');

  const paintPlaceholder = () => {
    const c = avatar.fallbackColors;
    for (const part of CV_PARTS) {
      const [top, bottom] = CV_CUTS[part];
      ctx.fillStyle = part === 'head' ? c.skin : (part === 'torso' ? c.torso : c.legs);
      ctx.fillRect(AVATAR_W * 0.25, AVATAR_H * top, AVATAR_W * 0.5, AVATAR_H * (bottom - top));
    }
    // 頭部上緣的髮色帶，比例與 slicer 取樣 hair 的區域一致
    const [, headBottom] = CV_CUTS.head;
    ctx.fillStyle = c.hair;
    ctx.fillRect(AVATAR_W * 0.25, 0, AVATAR_W * 0.5, AVATAR_H * headBottom * 0.35);
  };

  paintPlaceholder();
  // 先讓替身可被繪製；貼圖到齊後原地重畫，roster 不需要重新建立條目
  canvas.complete = true;
  canvas.naturalWidth = canvas.width;

  const loaded = {};
  let pending = CV_PARTS.length;
  const composite = () => {
    if (!CV_PARTS.some((p) => loaded[p])) return; // 三張都載入失敗就留著替身
    ctx.clearRect(0, 0, AVATAR_W, AVATAR_H);

    // 替身只在「有貼圖沒載到」時才畫。
    //
    // 貼圖是去背過的透明 PNG，而替身是不透明的實心矩形 —— 無條件先畫替身
    // 再疊貼圖，矩形就會從角色輪廓外的透明處透出來：頭部後方一塊髮色方塊、
    // 肩膀兩側各一塊，看起來就像根本沒去背（而去背其實是好的）。
    //
    // 仍然保留部分失敗的保險：只要有任一張沒到齊，該部位維持取樣色替身，
    // 總比角色在大螢幕上缺頭或缺腿好。
    const missing = CV_PARTS.filter((p) => !loaded[p]);
    if (missing.length > 0) paintPlaceholder();

    if (enhance) ctx.filter = 'contrast(1.15) saturate(1.15) brightness(1.05)';

    for (const part of CV_PARTS) {
      const img = loaded[part];
      if (!img) continue;
      const [top, bottom] = CV_CUTS[part];
      ctx.drawImage(img, 0, AVATAR_H * top, AVATAR_W, AVATAR_H * (bottom - top));
    }
    ctx.filter = 'none';
  };

  for (const part of CV_PARTS) {
    const img = new Image();
    img.addEventListener('load', () => { loaded[part] = img; if (--pending === 0) composite(); });
    img.addEventListener('error', () => { if (--pending === 0) composite(); });
    img.src = avatar.textures[part];
  }

  return canvas;
}

/** 依來源選用組裝方式。回傳物件皆帶有 complete / naturalWidth，可直接交給 drawCharacter。 */
export function avatarImage(avatar, opts) {
  if (avatar?.source === 'CV') return cvAvatarImage(avatar, opts);
  const svg = renderAvatarSVG(avatar, { width: AVATAR_W, height: AVATAR_H });
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return img;
}
