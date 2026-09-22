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
