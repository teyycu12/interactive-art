/**
 * 大螢幕的「場景可用區」。
 *
 * ── 為什麼需要這個 ──
 * 問題橫幅（問答／問卷／任務）原本是 position: fixed 疊在場景上，而房間本身
 * 的長寬比正好是 16:9、填滿整個投影畫面 —— 橫幅蓋住的那一塊就是房間的上緣。
 * 現場的後果是：題目出來的那一刻，站在房間上半部的人在畫面上消失了，
 * 他們找不到自己在哪，而「看著大螢幕找到自己」正是這件作品的前提。
 *
 * 因此改成：橫幅不疊在場景上，它佔掉的高度從場景可用區扣掉，房間縮小並置中
 * 在剩下的空間裡。角色會變小，那是這個取捨真實的代價 —— 但「看得到全部的人」
 * 比「人大一點」重要，看不到的人等於不存在。
 *
 * ── 為什麼是共用模組而不是各自算 ──
 * 房間背景（PixelScene / RoomScene）與角色圖層（screen.js）是兩張不同的畫布，
 * 各自把世界座標投影到螢幕。兩邊的可用區只要差一點，角色就會浮在房間外面或
 * 陷進地板裡，而畫面上看起來只是「位置怪怪的」，不會有任何錯誤。
 */

/** 橫幅佔掉的上緣高度（CSS 像素）。0 代表沒有橫幅。 */
let topInset = 0;

const listeners = new Set();

/**
 * 目前的場景可用區。
 * y 是上緣起點，height 已扣掉橫幅 —— 兩者都要用，只用 height 會讓房間置中在
 * 整個視窗而不是剩下的那一塊，等於白扣。
 */
export function stageViewport() {
  return {
    x: 0,
    y: topInset,
    width: innerWidth,
    height: Math.max(1, innerHeight - topInset),
  };
}

/**
 * 設定橫幅佔掉的高度。值沒變就不通知 —— 這個函式會被 ResizeObserver 以
 * 每幀的頻率呼叫，每次都重算會讓整個場景（含靜態房間重繪）跟著跑。
 */
export function setStageTopInset(px) {
  const next = Math.max(0, Math.round(Number(px) || 0));
  if (next === topInset) return;
  topInset = next;
  for (const fn of listeners) fn();
}

/** 可用區變動時回呼。回傳取消訂閱的函式 —— 場景切換時要解掉，否則舊場景會繼續被叫醒。 */
export function onStageViewportChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
