import { DEFAULT_THEME, isThemeId } from '/shared/themes.js';
import { KitchenScene } from './KitchenScene.js';
import { OfficeScene } from './OfficeScene.js';

// Each scene owns its visuals and local interactions; participant state stays upstream.
// Layout variants must use the server's shared/scene.js, never a browser-only layout.
// Ids and labels live in shared/themes.js so the host menu and server validation stay in sync.
export const SCENES = Object.freeze({
  kitchen: { create: (host, props) => new KitchenScene(host, props) },
  office: { create: (host, props) => new OfficeScene(host, props) },
  room: { async create(host, props) {
    const { RoomScene, populateProps } = await import('../3d/RoomScene.js');
    const scene = new RoomScene(host);
    await populateProps(scene, props);
    return scene;
  } },
});

/**
 * 道具在某個主題下叫什麼（「湯鍋」而不是 tbl_3）。
 *
 * 主辦端與大螢幕都要顯示問卷選項對應的地點名稱。名稱的唯一來源是各場景的
 * ITEMS —— 在別處再抄一份，換主題或改名時兩邊就會不一致，
 * 而症狀是「主辦端說湯鍋、大螢幕寫洗手台」且兩邊都不報錯。
 * 3D 客廳沒有自己的道具名稱，回傳道具 id 本身。
 */
const NAMED_SCENES = { kitchen: KitchenScene, office: OfficeScene };

export function propLabel(themeId, propId) {
  if (!propId) return null;
  return NAMED_SCENES[themeId]?.ITEMS?.[propId]?.[1] ?? propId;
}

/** `?scene=<id>` pins a theme for development; otherwise the screen follows the host's choice. */
export function pinnedSceneId() {
  const id = new URLSearchParams(location.search).get('scene');
  return isThemeId(id) ? id : null;
}

export async function createScene(host, props, id = pinnedSceneId() ?? DEFAULT_THEME) {
  try { return await (SCENES[id] ?? SCENES[DEFAULT_THEME]).create(host, props); }
  catch (error) {
    console.error('場景載入失敗，使用程序化廚房備援', error);
    host.replaceChildren();
    return new KitchenScene(host, props);
  }
}
