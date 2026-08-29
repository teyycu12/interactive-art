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

import { renderAvatarSVG, CV_CUTS, CV_PARTS, CV_FULL_PART } from './avatars.js';

// 角色畫布的解析度。
//
// 200x260 是捏臉 SVG 的 viewBox 尺寸，CV 掃描角色原本沿用同一組數字 ——
// 但兩者的性質不同：捏臉是向量圖，放大不失真；CV 角色是點陣貼圖，
// 這個尺寸就成了硬上限。實測（2026-08-29）在 2560x1664 的 Retina 螢幕上，
// 靠近相機的角色需要約 533 個實際像素，而資料只有 260 —— 等於放大兩倍，
// 眼鏡框、衣服印花、鞋子邊緣全部糊掉。
//
// 提高到 1024 之後：
//   - AI 生成的人像本身就有約 975px 高，先前有 73% 的像素被丟掉
//   - backend/slicer.py 的 NORMALIZED_HEIGHT 必須一起提到 1024，
//     只改這裡會卡在上游的 512（兩道都是瓶頸，改一道沒有效果）
//
// 寬度維持 200:260 的比例（788:1024），畫布比例一變，drawFull 的
// 「底部對齊」與 composite 的三段疊圖都會跟著偏。
// 捏臉路徑不受影響：renderAvatarSVG 以 width/height 為參數、viewBox 固定，
// 放大是向量重繪。
export const AVATAR_W = 788;
export const AVATAR_H = 1024;

/**
 * 掃描生成的角色：優先畫未切割的整張圖，缺它才把三張貼圖疊回去。
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

  /**
   * 整張圖：等比縮放後底部對齊。
   *
   * 不能直接鋪滿畫布 —— 角色的寬高比實測平均約 0.642，畫布是 200x260 =
   * 0.769，直接填滿會把每個人橫向拉寬約 20%。底部對齊而非置中，是為了讓
   * 所有角色站在同一條基準線上；置中會讓矮的角色浮在半空。
   *
   * 畫之前清空且不重畫替身：整張圖已經是完整的角色，替身的實心矩形只會
   * 從透明處透出來（與下方 composite() 不畫替身是同一個理由）。
   */
  const drawFull = (img) => {
    const scale = Math.min(AVATAR_W / img.naturalWidth, AVATAR_H / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.clearRect(0, 0, AVATAR_W, AVATAR_H);
    if (enhance) ctx.filter = 'contrast(1.15) saturate(1.15) brightness(1.05)';
    ctx.drawImage(img, (AVATAR_W - w) / 2, AVATAR_H - h, w, h);
    ctx.filter = 'none';
  };

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

  const loadParts = () => {
    for (const part of CV_PARTS) {
      const img = new Image();
      img.addEventListener('load', () => { loaded[part] = img; if (--pending === 0) composite(); });
      img.addEventListener('error', () => { if (--pending === 0) composite(); });
      img.src = avatar.textures[part];
    }
  };

  // 整張圖是選用的：改版前生成的資產目錄只有三張切片，那些角色仍在場上，
  // 把它列為必要會讓一次改版就把先前生成的人全部踢出場。
  // 載入失敗也退回切片 —— 兩條路都通到同一個替身，參與者不會看到空白。
  const fullUrl = avatar.textures?.[CV_FULL_PART];
  if (fullUrl) {
    const img = new Image();
    img.addEventListener('load', () => drawFull(img));
    img.addEventListener('error', loadParts);
    img.src = fullUrl;
  } else {
    loadParts();
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
