/**
 * 今天的紀念卡：自己的角色、名字、人格類型，加上今天遇見的人與怎麼遇見的。
 *
 * 參考 AI 拍照亭與活動平台的「帶得走的東西」。原本手機上只有「你認識了 N 個人」
 * 這個數字，活動一結束就什麼都沒留下；而那些人正是這場活動真正的產物。
 * 名單來自 server/encounters.js，伺服器已依關係深淺排好序，這裡取前 8 位。
 *
 * 全部在手機上畫，不經伺服器：不多一個端點，也不必把別人的頭像打包傳來傳去 ——
 * 手機本來就有 SOCIAL_SELF 送來的名單與外觀。
 */

import { avatarPortrait } from '/shared/avatarSprite.js';
import { encounterLabel } from '/shared/encounters.js';

const W = 1080;
const H = 1350;
const INK = '#3A2E27';
const SOFT = '#6B5A4E';
const PAPER = '#F7F1E3';
const SAGE = '#6E9B84';
const FONT = 'system-ui, "Noto Sans TC", "PingFang TC", sans-serif';

/** 肖像最多等 4 秒（avatarPortrait 自己也有逾時）；拿不到就畫名字首字 */
const portrait = (avatar) => (avatar
  ? Promise.race([avatarPortrait(avatar), new Promise((r) => setTimeout(() => r(null), 4500))]).catch(() => null)
  : Promise.resolve(null));

/**
 * @param {{name: string, avatar: object, persona: {emoji: string, name: string}|null,
 *          peers: {name: string, avatar: object|null}[]}} me
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function makeKeepsake({ name, avatar, persona, peers }) {
  // 最多畫 8 位（兩列）：第三列會壓到底下的「還有幾位」與日期
  const shown = peers.filter((p) => p.name).slice(0, 8);
  const [mine, ...theirs] = await Promise.all([portrait(avatar), ...shown.map((p) => portrait(p.avatar))]);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = INK;
  g.lineWidth = 10;
  g.strokeRect(30, 30, W - 60, H - 60);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  // 標題
  g.fillStyle = INK;
  g.font = `900 64px ${FONT}`;
  g.fillText(peers.length ? `今天我遇見了 ${peers.length} 個人` : '今天我來過這裡', W / 2, 140);

  // 自己：肖像、名字、類型
  const drawFace = (img, cx, top, size, fallback) => {
    if (img) {
      const h = size;
      const w = (img.width / img.height) * h;
      g.imageSmoothingEnabled = false;
      g.drawImage(img, cx - w / 2, top, w, h);
    } else {
      g.fillStyle = '#E3EADF';
      g.beginPath();
      g.arc(cx, top + size / 2, size * 0.35, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = INK;
      g.font = `800 ${Math.round(size * 0.3)}px ${FONT}`;
      g.fillText((fallback || '?').slice(0, 1), cx, top + size * 0.6);
    }
  };
  drawFace(mine, W / 2, 180, 340, name);
  g.fillStyle = INK;
  g.font = `900 56px ${FONT}`;
  g.fillText(name, W / 2, 600);
  if (persona) {
    g.fillStyle = SAGE;
    g.font = `700 36px ${FONT}`;
    g.fillText(`${persona.emoji} ${persona.name}`, W / 2, 652);
  }

  // 認識的人：4 欄
  if (shown.length) {
    g.strokeStyle = SAGE;
    g.lineWidth = 3;
    g.setLineDash([10, 10]);
    g.beginPath();
    g.moveTo(120, 700);
    g.lineTo(W - 120, 700);
    g.stroke();
    g.setLineDash([]);
    const cols = 4;
    const cellW = (W - 200) / cols;
    shown.forEach((p, i) => {
      const cx = 100 + cellW * (i % cols) + cellW / 2;
      const top = 730 + Math.floor(i / cols) * 215;   // 每格多一行「怎麼遇見的」
      drawFace(theirs[i], cx, top, 130, p.name);
      g.fillStyle = INK;
      g.font = `700 28px ${FONT}`;
      g.fillText(clip(g, p.name, cellW - 16), cx, top + 165);
      // 只寫最主要的那一種（伺服器排在第一個）：格子只有四分之一寬，寫不下一串
      const how = encounterLabel(p.via?.slice(0, 1));
      if (how) {
        g.fillStyle = SOFT;   // 鼠尾草綠當文字對比不足（UI-STYLING）
        g.font = `600 22px ${FONT}`;
        g.fillText(how, cx, top + 196);
      }
    });
    if (peers.length > shown.length) {
      g.fillStyle = SOFT;
      g.font = `600 28px ${FONT}`;
      g.fillText(`還有 ${peers.length - shown.length} 位`, W / 2, 1190);
    }
  }

  // 日期
  const d = new Date();
  g.fillStyle = SOFT;
  g.font = `600 30px ${FONT}`;
  g.fillText(`${d.getFullYear()} / ${d.getMonth() + 1} / ${d.getDate()}`, W / 2, H - 60);
  return c;
}

/** 名字太長就截斷加刪節號，不要擠到隔壁格 */
function clip(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  const chars = [...text];
  while (chars.length && g.measureText(`${chars.join('')}…`).width > maxW) chars.pop();
  return `${chars.join('')}…`;
}

/**
 * 交給系統分享（iOS／Android 會出現「儲存影像」）；不支援就直接下載。
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveKeepsake(canvas, filename = 'keepsake.png') {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '今天的紀念卡' });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // 分享失敗（權限、瀏覽器限制）就退回下載
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
