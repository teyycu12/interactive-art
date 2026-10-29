/**
 * 手機個人視角的場景底圖 —— 與大螢幕同一張圖。
 *
 * 直接沿用大螢幕像素主題的繪圖程式（public/screen/scenes/），不另畫一份：
 * 參與者低頭看到的那一角，要與抬頭看到的大螢幕是同一個地方、同一組道具。
 * 另抄一份的話，大螢幕改了擺設，手機不會跟著改，而且兩邊都不會報錯。
 *
 * 底圖只烘房間本身；道具與桌號每幀另畫（scenePainter），因為有人走近時道具會動
 * （植物晃、書櫃冒光……），與大螢幕一樣。以前道具以靜止狀態烘進底圖，
 * 手機上就永遠看不到這些小動畫。
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

  cached = { id: themeId, canvas };
  return canvas;
}

/** 由後往前畫，前面的道具蓋住後面的（同 PixelScene.render） */
const PROPS_BY_DEPTH = [...PROPS].sort((a, b) => a.y - b.y);

/**
 * 走近道具多遠算「經過」。與大螢幕 PixelScene.updateAgents 相同（道具半徑 + 65），
 * 兩邊不一致的話，大螢幕上植物在晃、手機上卻沒動。
 */
export const PROP_REACH = 65;
/** 同一個道具 0.8 秒內不重複觸發、動畫播 4.5 秒（同 PixelScene） */
const RETRIGGER_MS = 800;
const EFFECT_S = 4.5;

/**
 * 道具的逐幀繪製與「有人走近」的小動畫。只是畫面回饋：
 * 不寫回位置、分數或任何事件（同大螢幕）。
 */
export class ScenePainter {
  constructor(themeId) {
    this.Scene = PIXEL_SCENES[themeId];
    this.spots = THEME_MAP[themeId]?.spots ?? {};
    this.effects = new Map();   // propId → 動畫開始時間
    this.near = new Set();      // `${角色 id}:${道具 id}`，只在剛走進範圍那一刻觸發
  }

  /** @param {Array<{id: string, x: number, y: number}>} walkers 舞台座標 */
  update(walkers, now) {
    const next = new Set();
    for (const p of PROPS) for (const a of walkers) {
      if (Math.hypot(a.x - p.x, a.y - p.y) >= p.r + PROP_REACH) continue;
      const key = `${a.id}:${p.id}`;
      next.add(key);
      if (!this.near.has(key) && now - (this.effects.get(p.id) ?? -Infinity) >= RETRIGGER_MS) {
        this.effects.set(p.id, now);
      }
    }
    this.near = next;
  }

  /**
   * 開始畫一幀：挑出 view 範圍內的道具，之後由 drawUntil 跟角色依前後穿插著畫。
   *
   * 道具原本在角色之前一次畫完，角色一律蓋在道具上 —— 走到桌子後面的人看起來
   * 就是踩在桌上（2026-10-29）。改成跟角色同一個前後順序：y（碰撞圓心）比角色腳底
   * 更後面的道具先畫，更前面的等角色畫完再畫，蓋住角色的腳。與大螢幕同一條規則
   * （PixelScene.occludersOf：道具 y 大於腳底才擋得到）。
   * @param {{x0: number, y0: number, x1: number, y1: number}} view 底圖座標
   */
  begin(view, now, reduced) {
    this.frame = { now, reduced };
    this.queue = PROPS_BY_DEPTH.filter((p) => {
      // 道具往上畫得比較高（籃架約 230），左右約 1.65 倍半徑；多留一點邊免得邊緣被切掉
      const x = ORIGIN_X + p.x, y = ORIGIN_Y + p.y, half = p.r * 1.65 + 60;
      return !(x + half < view.x0 || x - half > view.x1 || y + 90 < view.y0 || y - 250 > view.y1);
    });
    this.next = 0;
  }

  /**
   * 在底圖座標系（呼叫端已 translate/scale 好）畫出 y 不超過 maxY 的道具與它的桌號；
   * 畫過的不會再畫。一幀的最後傳 Infinity 把剩下的畫完。
   */
  drawUntil(c, maxY) {
    const { Scene, queue, frame } = this;
    if (!queue) return;
    while (this.next < queue.length && queue[this.next].y <= maxY) {
      const p = queue[this.next++];
      const started = this.effects.get(p.id);
      const elapsed = started === undefined ? -1 : (frame.now - started) / 1000;
      if (elapsed > EFFECT_S) this.effects.delete(p.id);
      Scene.paintProp(c, p, (Scene.ITEMS[p.id] ?? Scene.FALLBACK)[0], elapsed, frame.reduced);
      if (this.spots[p.id]) spotBadge(c, ORIGIN_X + p.x, ORIGIN_Y + p.y + 46, this.spots[p.id]);
    }
  }

  /**
   * 還沒畫的道具裡，有沒有擋得到站在 (x, y)（舞台座標）的人。
   * 名牌與表情要留到道具畫完再畫：站在冰箱後面的人，名字還是要看得到。
   */
  covers(x, y) {
    const { queue } = this;
    if (!queue) return false;
    for (let i = this.next; i < queue.length; i++) {
      const p = queue[i];
      // 道具最高往上畫約 250（籃架），名牌在腳底下約 40：前後差超過 290 就蓋不到
      if (p.y > y && Math.abs(p.x - x) < p.r * 1.65 + 90 && p.y - y < 290) return true;
    }
    return false;
  }
}

export function scenePainter(themeId) {
  return PIXEL_SCENES[themeId] ? new ScenePainter(themeId) : null;
}
