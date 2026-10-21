/**
 * 大合照的合成管線：在看不見的畫布上畫一張「全員到齊」的房間。
 *
 * 原本的合照是把場上的人定住、轉向鏡頭（依互動排位時還要走到隊形裡），
 * 再截大螢幕當下的畫面 —— 拍照那十幾秒現場所有人都動不了，大螢幕也跟著變。
 * 而且只拍得到還在場的人。2026-10-19 主持人決定：拍合照要走另一條合成管線，
 * 不能影響大螢幕的畫面。
 *
 * 這裡用的繪圖程式與大螢幕完全相同（房間底圖、道具、角色、名牌），所以合照長得
 * 跟大家看到的房間一樣；但畫在另一張畫布上、不讀也不寫 screen.js 的任何狀態，
 * 大螢幕上的人照常走動。誰站在哪由伺服器決定（含已經離場、但今天有參與的人），
 * 這裡只負責畫。
 *
 * 只支援像素主題（有 staticCanvas 的場景）。3D 主題回傳 null，由伺服器退回 Python 自畫的舞台。
 */

import { MAX_SPEED } from '/shared/protocol.js';
import { avatarImage, cvAvatarImage } from '/shared/avatarSprite.js';
import { drawCharacter, drawNameplate, measureNameplate, NAMEPLATE_DROP } from '/shared/character.js';
import { layoutNameplates } from '/shared/nameplateLayout.js';
import { FLOOR_Y, CHARACTER_SCALE as PIXEL_SCALE } from './scenes/pixelKit.js';

/** 面向鏡頭（與伺服器 FACING_CAMERA 相同） */
const FACING_CAMERA = Math.PI / 2;
/** 拍照生成的角色要等原圖載入；最多等這麼久，逾時就用取色替身，合照不能因為一張圖卡住 */
const IMAGE_WAIT_MS = 4000;

/** 角色圖：生成角色等原圖畫好再用（同 avatarSprite.js 的 cvPortrait），捏臉角色是同步畫好的 */
function loadAvatar(avatar) {
  if (avatar?.source !== 'CV') return Promise.resolve(avatarImage(avatar, { enhance: true }));
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(img); } };
    const img = cvAvatarImage(avatar, { enhance: true, onPaint: done });
    setTimeout(done, IMAGE_WAIT_MS);
  });
}

/**
 * @param {object} scene 目前的像素場景（PixelScene）：借它的底圖與道具繪製，不改它的狀態
 * @param {{id: string, name: string, avatar: object, x: number, y: number}[]} people 舞台座標
 * @param {{heightScale: number, worldHeight: number}} size 與大螢幕相同的角色大小設定
 * @returns {Promise<string|null>} PNG data URL；場景不支援時 null
 */
export async function renderGroupPhoto(scene, people, { heightScale, worldHeight }) {
  if (!scene?.staticCanvas || typeof scene.paintStill !== 'function') return null;
  const W = scene.staticCanvas.width;
  const H = scene.staticCanvas.height;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const c = out.getContext('2d');

  // 房間與靜止的道具（不帶「有人走近」的小動畫：那是大螢幕當下的狀態，不屬於合照）
  scene.paintStill(c);

  const sprites = await Promise.all(people.map((p) => loadAvatar(p.avatar)));
  // 角色身高：同大螢幕 characterHeightAt，只是縮放倍率固定為 1（底圖原尺寸）
  const height = worldHeight * PIXEL_SCALE * heightScale;
  const list = people
    .map((p, i) => ({ ...p, sprite: sprites[i], pos: { x: p.x, y: FLOOR_Y + p.y } }))
    .sort((a, b) => a.y - b.y);   // 前面的人蓋住後面的人

  const fontSize = Math.max(10, height * 0.12);
  const plates = list.map((p) => {
    const { w, h } = measureNameplate(c, p.name || '', { fontSize });
    return { id: p.id, x: p.pos.x, y: p.pos.y + NAMEPLATE_DROP, w, h };
  });
  const target = layoutNameplates(plates, { bottom: H });

  for (const p of list) {
    const agent = { id: p.id, x: p.x, y: p.y, vx: 0, vy: 0, heading: FACING_CAMERA, state: 'IDLE', facing: 1 };
    drawCharacter(c, agent, p.pos, p.sprite, { time: 0, maxSpeed: MAX_SPEED, height });
  }
  // 名牌全部畫在最上層（大螢幕是跟著角色一起畫、會被前面的人擋住）：合照是紀念品，
  // 每個人的名字都要看得到 —— 30 人排成四排時，後排的名牌原本會被前排的頭蓋掉（2026-10-19 實拍）
  for (const p of list) {
    if (p.name) drawNameplate(c, p.pos, p.name, { fontSize, offset: target.get(p.id) });
  }
  return out.toDataURL('image/png');
}
