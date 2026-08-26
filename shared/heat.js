/**
 * 尋寶的冷熱等級（先知模式，見 server/treasure.js）
 *
 * 放在 shared/ 而非 server/：伺服器據此判定等級，主辦端與手機端
 * 據此顯示文字與顏色。三端各存一份必然漂移，屆時會出現
 * 「伺服器說 HOT、手機顯示未知」這種只有現場才發現的錯位
 * （與 QUIZ_CHOICES、EMOTE_GLYPH 是同一個理由）。
 */

/**
 * 由遠到近。先知看到的就是這幾個字。
 *
 * 用文字而非距離數字，是因為先知要用「喊」的：
 * 「溫！」比「還有 430」好喊得多，也不會讓參與者去心算座標。
 */
export const HEAT_LEVELS = [
  { id: 'FREEZING', label: '結冰', glyph: '🧊', color: '#457B9D' },
  { id: 'COLD',     label: '冷',   glyph: '❄️', color: '#6FA8C7' },
  { id: 'WARM',     label: '溫',   glyph: '🌤', color: '#E9C46A' },
  { id: 'HOT',      label: '熱',   glyph: '🔥', color: '#F4845F' },
  { id: 'BURNING',  label: '燙',   glyph: '🌋', color: '#E63946' },
];

export const HEAT_MAP = Object.fromEntries(HEAT_LEVELS.map((h) => [h.id, h]));

/**
 * 踩中判定半徑（邏輯單位）。
 *
 * 放在 shared/ 是因為兩端都要用同一個值：伺服器據此判定「踩到了」，
 * 大螢幕據此畫出光圈。兩邊各存一份的話，會出現「畫面上明明踩進圈裡
 * 卻沒有反應」——而參與者只會覺得系統壞了，現場也無從解釋。
 * server/config.js 的 TREASURE.claimRadius 直接再匯出本常數。
 *
 * 取 70 而非更小：角色是被搖桿推著走的，不是滑鼠點的，
 * 要求精準停在某一點會讓最後幾步變成惱人的微調 ——
 * 這個遊戲的樂趣在於聽指令跑，不在停車入庫。
 */
export const TREASURE_RADIUS = 70;
