/**
 * 入站訊息速率限制（Token Bucket）
 *
 * 協定規定搖桿為 20 Hz。未設限時實測單一連線可送出約 28,600 則/秒且不被斷線，
 * 現場只要有一支手機的程式失控就能拖垮整個場域。
 *
 * 參數取捨：
 *   - 容量 60、每秒補充 60 —— 為規格值的 3 倍，正常客戶端永遠不會耗盡水桶。
 *     留這麼寬是因為手機從背景喚醒、或現場 Wi-Fi 壅塞後恢復時，
 *     排隊的訊息會一次湧入，這是正常行為，不該被當成攻擊。
 *   - 逾量的訊息「丟棄」而非立即斷線。偶發突發不應讓使用者的角色消失。
 *   - 只有持續逾量（違規計數累積到門檻）才斷線。違規計數會隨時間衰減，
 *     避免一次瞬間突發在數分鐘後才把無辜的連線判死。
 *
 * 時間一律由呼叫端提供，且應使用單調時鐘（performance.now）。
 * 若在內部自行讀取牆鐘，NTP 校時造成的時間倒退會使補充邏輯永久停擺；
 * 統一交由呼叫端提供也讓本類別成為純函式，可用合成時間精確測試。
 */

import { performance } from 'node:perf_hooks';

export class RateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity]        水桶容量（可承受的突發量）
   * @param {number} [opts.refillPerSec]    每秒補充的 token 數
   * @param {number} [opts.violationLimit]  違規累積達此值即判定為濫用
   * @param {number} [opts.violationDecayPerSec] 違規計數每秒衰減量
   * @param {number} [now]  起始時間戳，必須與後續 check() 使用同一時鐘域
   */
  constructor({
    capacity = 60,
    refillPerSec = 60,
    violationLimit = 400,
    violationDecayPerSec = 100,
  } = {}, now = performance.now()) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.violationLimit = violationLimit;
    this.violationDecayPerSec = violationDecayPerSec;

    this.tokens = capacity;
    this.violations = 0;
    this.lastAt = now;
  }

  /** 依經過時間補充 token 並衰減違規計數 */
  #advance(now) {
    const elapsedSec = (now - this.lastAt) / 1000;
    if (elapsedSec < 0) {
      // 時間倒退（時鐘域錯置或系統校時）。重新對齊基準點但不補充，
      // 否則後續每次 check 都會 early-return，水桶將永遠無法回補。
      this.lastAt = now;
      return;
    }
    if (elapsedSec === 0) return;
    this.lastAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.violations = Math.max(0, this.violations - elapsedSec * this.violationDecayPerSec);
  }

  /**
   * 嘗試放行一則訊息。
   * @param {number} [now] 與建構時同一時鐘域的時間戳
   * @returns {'ok' | 'drop' | 'abuse'} abuse 代表持續濫用，呼叫端應中斷連線
   */
  check(now = performance.now()) {
    this.#advance(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 'ok';
    }
    this.violations += 1;
    return this.violations >= this.violationLimit ? 'abuse' : 'drop';
  }
}
