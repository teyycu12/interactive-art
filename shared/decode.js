/**
 * 解碼任務的共用常數與符號集（伺服器出題、手機顯示、測試共用）。
 *
 * 符號跟著場景換（shared/themes.js 的 decodeSymbols）：伺服器端不寫死任何符號，
 * 否則這個玩法就只能在一個場景跑（INTERACTION-DESIGN「場合適配」）。
 * 每個符號帶一個念得出來的名字 —— 目的是讓人開口，不是考視力。
 */
import { THEME_MAP } from './themes.js';

export const DECODE = {
  /** 密碼本上列幾個符號。比密碼用到的多：只列用得到的幾個，拿密碼本的人就猜得到題目 */
  bookSize: 8,
  /** 連錯幾次要冷卻 */
  wrongLimit: 3,
  /** 冷卻多久。4 碼只有一萬種組合，不冷卻的話可以直接亂按 */
  cooldownMs: 10000,
  /** 搭檔斷線多久才當他離開（手機鎖螢幕很常見，不要一斷就拆組） */
  dropOfflineMs: 15000,
  /** 解開的人等多久等不到新搭檔，才讓他跟剛合作過的人再一組 */
  repeatAfterMs: 8000,
  /** 開始多久還沒解開，才在手機上提示搭檔是誰。之前只給顏色，要開口問「你也是綠色鑰匙嗎？」 */
  revealAfterMs: 30000,
  /**
   * 每一組的鑰匙顏色。手機上只寫顏色、不寫搭檔名字，所以每個顏色都要**念得出來**、
   * 而且彼此一眼分得開（不能同時有橘和橙）。同時進行的組不撞色，用完才加號碼
   */
  keyColors: [
    { hex: '#E63946', name: '紅' }, { hex: '#2A9D8F', name: '綠' }, { hex: '#457B9D', name: '藍' },
    { hex: '#F4A261', name: '橘' }, { hex: '#9B5DE5', name: '紫' }, { hex: '#E9C46A', name: '黃' },
    { hex: '#F15BB5', name: '粉紅' }, { hex: '#8B5A2B', name: '咖啡' }, { hex: '#F7F7F2', name: '白' },
    { hex: '#2B2B30', name: '黑' },
  ],
};

/** 沒有設定符號的場景用的通用形狀 */
export const DEFAULT_DECODE_SYMBOLS = [
  { glyph: '★', name: '星星' }, { glyph: '▲', name: '三角形' }, { glyph: '●', name: '圓形' },
  { glyph: '■', name: '方形' }, { glyph: '◆', name: '菱形' }, { glyph: '♥', name: '愛心' },
  { glyph: '☀', name: '太陽' }, { glyph: '☂', name: '雨傘' }, { glyph: '♪', name: '音符' },
  { glyph: '✿', name: '花' },
];

/** 這個場景的符號集（至少 bookSize 個；不夠就用通用形狀） */
export function decodeSymbolsFor(themeId) {
  const list = THEME_MAP[themeId]?.decodeSymbols;
  return Array.isArray(list) && list.length >= DECODE.bookSize ? list : DEFAULT_DECODE_SYMBOLS;
}
