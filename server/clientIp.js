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
  // 多層代理時是「原始, 代理1, 代理2」，最左邊是手機
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || direct;
}
