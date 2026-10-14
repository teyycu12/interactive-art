/**
 * 限流用的來源位址。
 *
 * 經 ngrok 這類本機代理轉發時，每一條連線的 remoteAddress 都是 127.0.0.1 ——
 * 全場共用同一個限流額度，生成那條 3 次 / 90 秒就變成「全場 90 秒內只能
 * 生成 3 次」，第 4 個人開始一律 rate_limited。在只有一台開發機測試時
 * 完全看不出來。
 *
 * 只有連線本身來自本機時才採信 X-Forwarded-For：區網手機直連時
 * remoteAddress 是它自己的位址，自己塞一個標頭也繞不過限流。
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function clientIp(req) {
  const direct = req.socket?.remoteAddress ?? 'unknown';
  if (!LOOPBACK.has(direct)) return direct;
  const forwarded = req.headers?.['x-forwarded-for'];
  // 取**最右邊**那一段：那是本機代理（ngrok）親手加上的、它看到的連線來源。
  // 最左邊是客戶端自己送來的標頭，代理只會往後接 —— 採信它的話，每次請求
  // 換一個假值就能拿到新的限流額度，一支手機塞滿整個生成排隊。
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = raw?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last || direct;
}
