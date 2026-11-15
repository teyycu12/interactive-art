/**
 * 大螢幕的進場 QR（2026-11-15，REVIEW E1）。
 *
 * 原本系統裡沒有進場 QR：參與者要進場，得有人把終端機印出的網址另外做成 QR，
 * 主辦端「活動列表」的說明卻寫著「請大家用手機掃 QR Code 進場」。
 * 這是每個參與者的第一步，也是遲到的人唯一的入口，不該在系統之外。
 *
 * 在伺服器產生 SVG（qrcode-generator，零相依，由 node_modules 提供）：
 * - 不走 CDN 或線上 QR 服務 —— 展場網路不通時那正是最需要 QR 的時候（CLAUDE.md 第 2 條）
 * - 不靠 Python 生成服務 —— 生成服務沒開時，大家更需要掃得進來
 */

import qrcode from 'qrcode-generator';

/**
 * @param {string} text 要編進 QR 的網址
 * @returns {string} data:image/svg+xml 的網址，可以直接放進 <img src>
 */
export function qrSvgDataUrl(text) {
  // 錯誤修正 M：投影在牆上、隔著人群斜著掃，比 L 耐得住一點模糊；網址很短，格子不會因此變太密
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  // margin 4 是 QR 規格要求的安靜區：少了它，手機在深色背景前常常認不出來
  const svg = q.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** 進場網址：手機頁面的位址 */
export const joinUrlOf = (origin) => `${origin.replace(/\/+$/, '')}/controller/`;
