/**
 * TLS 憑證健檢的純函式部分。
 *
 * 與 index.js 分開是為了可測 —— index.js 一被 import 就會開起伺服器，
 * 而這裡要驗的邏輯（SAN 解析、到期天數）完全不需要網路。
 *
 * 這段程式碼防的是一個只在現場出現的故障：
 * 憑證按「產生當下的 IP」簽發，而區網 IP 多半由 DHCP 配發。
 * 筆電重連 Wi-Fi 或隔天再開機就可能換號，憑證隨即與實際位址不符。
 * 屆時服務照常啟動、位址看起來也正常，只有手機端會說憑證有問題，
 * 而那個錯誤訊息完全不會提到 IP。
 */

/**
 * @param {string|undefined} subjectAltName  X509Certificate.subjectAltName
 *   形如 "DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.104"
 * @param {string|Date} validTo  憑證到期時間
 * @param {string[]} addrs  當下偵測到的區網 IPv4 位址
 * @param {number} [now]  現在時間（測試用）
 * @returns {{expired: boolean, daysLeft: number, missing: string[]}}
 */
export function certificateReport(subjectAltName, validTo, addrs, now = Date.now()) {
  const covered = new Set(
    String(subjectAltName ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('IP Address:'))
      .map((part) => part.slice('IP Address:'.length).trim()),
  );

  const missing = (addrs ?? []).filter((a) => !covered.has(a));

  // 用無條件捨去：剩 0.5 天要顯示成 0 而不是 1，
  // 「還有 1 天」會讓人以為明天再處理就好。
  const validToMs = new Date(validTo).getTime();

  // 解析不出到期時間時視為「已過期」而非 NaN。
  //
  // NaN 會讓兩個警告分支同時失效（`NaN < 0` 與 `NaN <= 14` 都是 false），
  // 於是壞掉的憑證在啟動訊息上看起來完全健康 —— 正是這個模組要防的那種
  // 靜默失敗。寧可誤報一次要人重產憑證，也不要漏報。
  if (!Number.isFinite(validToMs)) {
    return { expired: true, daysLeft: NaN, missing };
  }

  const daysLeft = Math.floor((validToMs - now) / 86400000);
  return { expired: daysLeft < 0, daysLeft, missing };
}
