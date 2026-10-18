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
 * QR 裡的網址前綴。優先順序：
 *
 * 1. 環境變數 PUBLIC_HOST：可以是完整網址（`https://xxx.ngrok-free.dev`，對外通道用；
 *    start-public.sh 會自動設）或單純主機名（電腦有好幾張網卡時指定場館 Wi-Fi 那張）。
 * 2. 主辦端自己連進來用的網址（viewerOrigin）：主持人經 ngrok 開主辦端，QR 就給 ngrok 網址；
 *    經區網位址開，就給那個位址 —— 主持人連得到，同一個網路的手機也連得到。
 *    主辦端開在 localhost 時這一條不算（手機上的 localhost 是手機自己）。
 * 3. 排序後的第一個區網位址（rankLanAddresses），與啟動時印給手機的那組相同。
 *
 * 原本只用第 3 條、而且不排序：這台電腦的第一張網卡是 VirtualBox 的
 * 192.168.56.1，QR 指向一個手機永遠連不到的位址（2026-10-19「QR code 不能用」）。
 */
export function photoUrlBase({ scheme, port, lanAddrs, publicHost, viewerOrigin }) {
  if (publicHost && /^https?:\/\//i.test(publicHost)) return `${publicHost.replace(/\/+$/, '')}/photos`;
  if (publicHost) return `${scheme}://${publicHost}:${port}/photos`;
  if (viewerOrigin && !isLoopbackOrigin(viewerOrigin)) return `${viewerOrigin}/photos`;
  const host = lanAddrs[0] || 'localhost';
  return `${scheme}://${host}:${port}/photos`;
}

function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.');
  } catch {
    return true;
  }
}

/**
 * 連線請求的對外網址（`https://host[:port]`）。經 ngrok 等代理時用代理轉來的
 * X-Forwarded-Proto／Host —— 代理到本機那一段是 https://localhost:3000，不是使用者看到的網址。
 * 只用來產生主辦端合照的 QR 網址，主辦端已通過密鑰驗證，不拿它做任何授權判斷。
 */
export function requestOrigin(req, scheme) {
  const first = (v) => (typeof v === 'string' ? v.split(',')[0].trim() : '');
  const host = first(req?.headers?.['x-forwarded-host']) || first(req?.headers?.host);
  if (!host || !/^[\w.\-:[\]]+$/.test(host)) return null;
  const proto = first(req?.headers?.['x-forwarded-proto']).toLowerCase();
  return `${proto === 'http' || proto === 'https' ? proto : scheme}://${host}`;
}

// 手機連不到的虛擬網卡：VirtualBox（預設 192.168.56.x）、Hyper-V／WSL／Docker（多在 172.16–31）、
// VPN。Windows 的網卡名稱會被翻譯（VirtualBox 那張在中文版叫「乙太網路」），只看名稱抓不到，
// 所以位址範圍也一起看。只是排到後面，不刪掉 —— 少數場館的 Wi-Fi 確實發 172.x。
const VIRTUAL_NAME = /virtual|vbox|vmware|vethernet|hyper-v|wsl|docker|tailscale|zerotier|loopback|vpn/i;
const VIRTUAL_ADDR = /^(192\.168\.56\.|172\.(1[6-9]|2\d|3[01])\.)/;
const WIFI_NAME = /wi-?fi|wlan|wireless|無線/i;

/**
 * 區網位址，手機最可能連得到的排前面：Wi-Fi > 其他實體網卡 > 虛擬網卡。
 * @param {Record<string, Array<{family: string|number, internal: boolean, address: string}>>} interfaces os.networkInterfaces()
 */
export function rankLanAddresses(interfaces) {
  const rows = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const i of list ?? []) {
      if (!i || i.internal || !(i.family === 'IPv4' || i.family === 4)) continue;
      const rank = VIRTUAL_NAME.test(name) || VIRTUAL_ADDR.test(i.address) ? 2 : WIFI_NAME.test(name) ? 0 : 1;
      rows.push({ address: i.address, rank, order: rows.length });
    }
  }
  return rows.sort((a, b) => a.rank - b.rank || a.order - b.order).map((r) => r.address);
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
