/**
 * 傳球＋投籃的共用常數與判定（伺服器判進球、手機畫投籃畫面、大螢幕畫球，三端共用）。
 *
 * 規則與理由見 docs/notes/INTERACTION-DESIGN.md「體育館：傳球＋投籃」。
 * 哪個道具是球車、哪個是籃框、哪一區可以投，寫在 shared/themes.js 的 `hoops`，
 * 這裡不寫死任何場景的東西。
 */
import { THEME_MAP } from './themes.js';
import { ZONE_MAP, propsForTheme } from './scene.js';

export const HOOPS = {
  /** 走到球車多近自動拿球（道具碰撞半徑之外再加這麼多；角色擠不進碰撞半徑） */
  pickupReach: 70,
  /** 傳球的最遠距離。要走近一點、喊一聲才傳得到，不是隔著整個場地點一下 */
  passRange: 520,
  /** 接到傳球後這麼久之內投進才算助攻 */
  assistMs: 20000,
  /** 兩次投籃之間至少隔多久（拿球本身就要走回球車，這只是防連點） */
  shootCooldownMs: 1200,
  /** 方向誤差（度）在這之內、力道誤差在 powerTol 之內才有機會進 */
  angleTol: 9,
  powerTol: 0.12,
  /** 準度都對的進球率；差一點（兩倍容許範圍內）的進球率 —— 留一點運氣，免得只剩手感 */
  cleanChance: 0.9,
  roughChance: 0.3,
  /** 計分偏向合作：一個人投進 1 分；有人助攻的進球，投的人與傳的人各 2 分 */
  points: { solo: 1, assisted: 2, assist: 2 },
};

/** 這個主題的投籃設定（沒有就是 null：這個場景不開投籃） */
export function hoopsFor(themeId) {
  const cfg = THEME_MAP[themeId]?.hoops;
  if (!cfg) return null;
  const props = propsForTheme(themeId);
  const cart = props.find((p) => p.id === cfg.cart);
  const hoop = props.find((p) => p.id === cfg.hoop);
  const zone = ZONE_MAP[cfg.zone];
  return cart && hoop && zone ? { cart, hoop, zone } : null;
}

export const inRect = (z, x, y) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h;

/** 離籃框愈遠要愈大力：0（貼著籃框）～ 1（場上最遠） */
export function idealPower(distance) {
  return 0.42 + 0.42 * Math.min(1, Math.max(0, distance / 420));
}

/**
 * 這一投的進球機率。angle：手指滑出去偏離正前方幾度；power：0～1。
 * 伺服器以此判定（手機送來的只是手勢，不是「進了沒」）。
 */
export function shotChance(distance, angle, power) {
  const da = Math.abs(angle) / HOOPS.angleTol;
  const dp = Math.abs(power - idealPower(distance)) / HOOPS.powerTol;
  const worst = Math.max(da, dp);
  if (!(worst <= 2)) return 0;
  return worst <= 1 ? HOOPS.cleanChance : HOOPS.roughChance;
}
