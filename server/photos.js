/**
 * 大合照的存檔與下載網址。
 *
 * 合照右下角的 QR Code 要讓參與者用手機掃了就能下載。沒設雲端圖床
 * （.env 的 IMGBB_API_KEY / IMGUR_CLIENT_ID）時，照片由這台電腦自己供應：
 * 合成完存進 data/photos/，Gateway 以 /photos/<id>.png 送出去。
 *
 * 原本 QR 指向 http://127.0.0.1:5055/photos/... —— 127.0.0.1 在手機上是手機
 * 自己，而生成服務也沒有那條路由，掃得到、打不開（2026-10-17 現場回報
 * 「大合照的 QR Code 無法掃」）。網址一定要是手機連得到的區網位址。
 */

import fs from 'node:fs';
import path from 'node:path';

/** photo_composer 產生的 id：photo_<時間>_<人數>p_<隨機碼>。只認這個形狀，擋掉路徑穿越 */
const PHOTO_FILE = /^photo_[0-9]+_[0-9]+p_[0-9a-f]+\.png$/;

/**
 * QR 裡的網址前綴。
 *
 * 位址優先用環境變數 PUBLIC_HOST（電腦有好幾張網卡、預設挑到的不是場館 Wi-Fi
 * 那張時指定；Node 不讀 .env，要設在啟動互動層的那個 shell）；否則用第一個
 * 區網位址，與啟動時印給手機的那組相同。
 * 一個區網位址都沒有時退回 localhost：至少在這台電腦上點得開。
 */
export function photoUrlBase({ scheme, port, lanAddrs, publicHost }) {
  const host = publicHost || lanAddrs[0] || 'localhost';
  return `${scheme}://${host}:${port}/photos`;
}

/** 存一張合照（photo_b64 是 data URL）。id 不合格式或寫入失敗回傳 null，不拋例外 */
export function savePhoto(dir, photoId, dataUrl) {
  const file = `${photoId}.png`;
  if (!PHOTO_FILE.test(file) || typeof dataUrl !== 'string') return null;
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, file);
    fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    return target;
  } catch {
    return null;
  }
}

/** /photos/<檔名> 對應到的檔案；不是合照檔名就回傳 null */
export function photoPath(dir, urlPath) {
  const file = urlPath.slice('/photos/'.length);
  return PHOTO_FILE.test(file) ? path.join(dir, file) : null;
}
