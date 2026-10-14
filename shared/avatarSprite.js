/**
 * 角色圖像組裝 —— 大螢幕與手機端 POV 共用。
 *
 * 兩種來源：
 *   掃描生成（source: 'CV'）  優先畫未切割的整張圖（缺它才把三張貼圖依 CV_CUTS
 *                             疊回去）；側面與背面是生成的三視圖，掛在 views 上。
 *                             縮圖 avatarPortrait 也用同一張正面原圖（cvPortrait）
 *   模組捏臉（備援路徑）      像素角色，四方向 × 三格步態（shared/pixelAvatar.js）
 *
 * 與 shared/character.js 同理放在 shared/：手機畫的角色若與大螢幕不是
 * 同一份組裝邏輯，比例或替身顏色一旦漂移，兩邊都不會報錯 ——
 * 只會出現「手機上的我」和「大螢幕上的我」長得不一樣。
 */

import { avatarGrid, CV_CUTS, CV_PARTS, CV_FULL_PART, CV_VIEW_PARTS } from './avatars.js';
import { PIXEL_W, PIXEL_H, PIXEL_DIRS, PIXEL_FRAMES, PIXEL_POSES } from './pixelAvatar.js';

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
// 捏臉路徑不受影響：像素角色以原尺寸（20×27）保存，放大時由 drawCharacter
// 關掉影像平滑、以整數倍像素繪製。
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
 * @param {{enhance?: boolean, onPaint?: () => void}} opts
 *   enhance 為真時套用對比與飽和度增強。投影機的實際亮度遠低於製作時的
 *   螢幕，大螢幕需要這層補償；手機是直視發光面板，套下去只會過曝。
 *   onPaint 在貼圖載入、畫布重畫之後呼叫（cvPortrait 用它等原圖畫好再交出肖像）。
 */
export function cvAvatarImage(avatar, { enhance = false, onPaint = null } = {}) {
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
  // 供 spriteCache 判斷要不要重新推導側面／背面：替身階段不推導，
  // 貼圖每畫一次版本就加一（見 shared/spriteCache.js）
  canvas.spriteReady = false;
  canvas.spriteVersion = 0;
  const markDrawn = () => { canvas.spriteReady = true; canvas.spriteVersion++; };

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
    markDrawn();
    onPaint?.();
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
    markDrawn();
    onPaint?.();
  };

  const loadParts = () => {
    for (const part of CV_PARTS) {
      const img = new Image();
      img.addEventListener('load', () => { loaded[part] = img; if (--pending === 0) composite(); });
      img.addEventListener('error', () => { if (--pending === 0) composite(); });
      img.src = avatar.textures[part];
    }
  };

  // 側面與背面（像素風的三視圖才有）。各自畫進一張與正面同尺寸的畫布、
  // 用同一套「等比縮放、底部對齊」：三張都經過 slicer.normalize() 縮到同一個
  // 高度，這樣換面時角色不會忽大忽小、腳底不會跳。
  // 沒有或載入失敗就不掛 —— spriteView() 會退回正面，不會消失。
  canvas.views = {};
  for (const part of CV_VIEW_PARTS) {
    const url = avatar.textures?.[part];
    if (!url) continue;
    const img = new Image();
    img.addEventListener('load', () => {
      const view = document.createElement('canvas');
      view.width = AVATAR_W;
      view.height = AVATAR_H;
      const vctx = view.getContext('2d');
      const scale = Math.min(AVATAR_W / img.naturalWidth, AVATAR_H / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      if (enhance) vctx.filter = 'contrast(1.15) saturate(1.15) brightness(1.05)';
      vctx.drawImage(img, (AVATAR_W - w) / 2, AVATAR_H - h, w, h);
      view.complete = true;
      view.naturalWidth = view.width;
      canvas.views[part] = view;
    });
    img.src = url;
  }

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

/**
 * 捏臉角色：四個方向 × 三格步態，每格一張原尺寸（PIXEL_W × PIXEL_H）的小 canvas。
 *
 * 回傳的是「正面站立」那一格，其餘掛在 pixelFrames 上 —— 這樣直接放進 DOM
 * 的呼叫端（手機的社交連結頭像）拿到的仍是一張正常的圖，而 drawCharacter
 * 看到 pixelFrames 就改走像素畫法（依朝向選方向、依步態換格）。
 *
 * 不經過 SVG → Image 解碼：12 格同步畫完，角色進場的第一幀就有圖。
 */
export function pixelAvatarImage(avatar) {
  const paint = (grid) => {
    const c = document.createElement('canvas');
    c.width = PIXEL_W;
    c.height = PIXEL_H;
    const ctx = c.getContext('2d');
    for (let y = 0; y < PIXEL_H; y++) {
      for (let x = 0; x < PIXEL_W; x++) {
        const color = grid[y][x];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    c.complete = true;
    c.naturalWidth = PIXEL_W;
    return c;
  };
  const frames = {};
  // 動作畫格（揮手、乾杯）：每個方向每種動作兩格，交替播放
  const poses = {};
  for (const dir of PIXEL_DIRS) {
    frames[dir] = [];
    for (let f = 0; f < PIXEL_FRAMES; f++) frames[dir].push(paint(avatarGrid(avatar, dir, f)));
    poses[dir] = {};
    for (const kind of Object.values(PIXEL_POSES)) {
      poses[dir][kind] = [1, 2].map((step) => paint(avatarGrid(avatar, dir, 0, `${kind}${step}`)));
    }
  }
  const sprite = frames.down[0];
  sprite.pixelFrames = frames;
  sprite.pixelPoses = poses;
  return sprite;
}


/**
 * 角色肖像：場上實際用的那一格像素畫格，放大成整數倍、不平滑。
 *
 * 手機左上角縮圖、拍照確認頁、配對確認、離場頁都用這個 —— 它們原本各自畫
 * （捏臉 SVG、或生成的原圖），拍照角色在確認頁是三頭身的原圖，進場後卻是
 * 兩頭身的像素角色，實測被指出「進場畫面跟實際在場景裡不一樣」。
 *
 * 拍照角色用生成的正面原圖（cvPortrait），最多等 4 秒載入。
 *
 * @returns {Promise<HTMLCanvasElement>}
 */
export function avatarPortrait(avatar, { dir = 'down', scale = 8 } = {}) {
  // 拍照角色在場上畫的是生成的原圖（見 avatarImage），肖像也要用同一張、同樣的 enhance，
  // 否則確認頁與縮圖會和大螢幕上的角色長得不一樣
  if (avatar?.source === 'CV') return cvPortrait(avatar);
  return new Promise((resolve) => {
    const done = (frames) => {
      const c = document.createElement('canvas');
      c.width = PIXEL_W * scale;
      c.height = PIXEL_H * scale;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(frames[dir][0], 0, 0, c.width, c.height);
      resolve(c);
    };
    done(pixelAvatarImage(avatar).pixelFrames);
  });
}

/** 拍照角色的肖像：大螢幕同一張正面生成圖（含 enhance）。最多等 4 秒，逾時就用取色替身 */
function cvPortrait(avatar) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(front); } };
    const front = cvAvatarImage(avatar, { enhance: true, onPaint: done });
    setTimeout(done, 4000);
  });
}

/** 依來源選用組裝方式。回傳物件皆帶有 complete / naturalWidth，可直接交給 drawCharacter。 */
export function avatarImage(avatar, opts) {
  // 拍照生成的角色在場上用生成的原圖：三視圖（正面、側面、背面）來自生成，
  // 走路的手腳擺動由 shared/walkFrames.js 從每一面分析（drawCharacter）。
  // 合併 fix/pixel-character-movement 時決定，生成角色的樣子與走路以那邊為準
  // （docs/notes/GENERATION.md）。原本把生成圖縮成捏臉像素格子、再由正面推導
  // 側背面的 cvPixelSprite 自那時起就沒有任何路徑會走到，已於 2026-10-15 移除；
  // 要找回請看 git 歷史。
  if (avatar?.source === 'CV') return cvAvatarImage(avatar, opts);
  return pixelAvatarImage(avatar);
}
