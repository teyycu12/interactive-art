/**
 * 手機個人視角的場景底圖 —— 與大螢幕同一張圖。
 *
 * 直接沿用大螢幕像素主題的繪圖程式（public/screen/scenes/），不另畫一份：
 * 參與者低頭看到的那一角，要與抬頭看到的大螢幕是同一個地方、同一組道具。
 * 另抄一份的話，大螢幕改了擺設，手機不會跟著改，而且兩邊都不會報錯。
 *
 * 道具以靜止狀態烘進底圖（大螢幕上點擊觸發的小動畫只屬於那台大螢幕）。
 * 3D 主題（room）沒有像素底圖，回傳 null，由呼叫端退回原本的地面網格。
 */

import { PROPS, ZONES } from '/shared/scene.js';
import { THEME_MAP } from '/shared/themes.js';
import {
  ROOM_W, ROOM_H, FLOOR_Y, CHARACTER_SCALE, spotBadge,
} from '../screen/scenes/pixelKit.js';
import { KitchenScene } from '../screen/scenes/KitchenScene.js';
import { OfficeScene } from '../screen/scenes/OfficeScene.js';
import { GymScene } from '../screen/scenes/GymScene.js';

const PIXEL_SCENES = { kitchen: KitchenScene, office: OfficeScene, gym: GymScene };

/**
 * 場域邏輯座標 → 底圖座標的原點（與 PixelScene.projectToScreen 的 GX/GY 相同）。
 * 舞台寬度就是整張圖的寬度，x 不再有位移；兩邊不同步時手機視角會整片錯位，且不會報錯。
 */
export const ORIGIN_X = 0;
export const ORIGIN_Y = FLOOR_Y;
export { ROOM_W, ROOM_H };

/**
 * 角色在底圖上的高度（底圖單位）。
 * = PixelScene.scaleAt 的 CHARACTER_SCALE × screen.js 的 CHARACTER_WORLD_HEIGHT（2.1）。
 * 手機上的角色與道具因此維持與大螢幕相同的比例。
 */
export const BODY_UNITS = CHARACTER_SCALE * 2.1;

/** 底圖外的顏色，與大螢幕像素場景的邊框同色 */
export const OUTSIDE = '#383c43';

// 底圖是 2596×1460 的畫布（約 15 MB），手機上只留目前主題那一張
let cached = { id: null, canvas: null };

export function sceneBackdrop(themeId) {
  const Scene = PIXEL_SCENES[themeId];
  if (!Scene) return null;
  if (cached.id === themeId) return cached.canvas;

  const canvas = document.createElement('canvas');
  canvas.width = ROOM_W;
  canvas.height = ROOM_H;
  const c = canvas.getContext('2d');
  Scene.paintRoom(c, ZONES);
  for (const p of [...PROPS].sort((a, b) => a.y - b.y)) {
    const item = Scene.ITEMS[p.id] ?? Scene.FALLBACK;
    Scene.paintProp(c, p, item[0], -1, true);
  }
  const spots = THEME_MAP[themeId]?.spots ?? {};
  for (const p of PROPS) if (spots[p.id]) spotBadge(c, ORIGIN_X + p.x, ORIGIN_Y + p.y + 46, spots[p.id]);

  cached = { id: themeId, canvas };
  return canvas;
}
