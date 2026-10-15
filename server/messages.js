/**
 * 私訊：參與者在手機畫面上點別人的角色，傳一句文字給對方。
 *
 * ── 這個功能與專案判準的關係 ──
 * INTERACTION-DESIGN 的判準是「通關路徑上要有一步必須開口講話」。私訊本身不滿足它，
 * 所以刻意做得短（60 字）、沒有聊天紀錄串，定位是「開場」—— 叫人過來、說我在哪裡，
 * 真正的對話還是要走過去講。
 *
 * ── 自由文字的防護 ──
 * 現場是陌生人、可能是學生，沒有人能即時審每一則訊息，因此：
 *   - 收件人可以封鎖寄件人：之後的訊息靜默丟棄。寄件人收到的仍是「已送出」——
 *     告訴他「你被封鎖了」只會換來換個方式繼續騷擾。
 *     封鎖的人自己也不能再傳給對方，要先解除封鎖 —— 否則就成了「我可以傳你、你不能回我」。
 *   - 收件人可以檢舉：那一則（只有那一則）進入主辦端清單，主辦端可以直接移除那個人。
 *   - 主辦端看不到一般私訊，只看得到被檢舉的那幾則。
 *   - 頻率限制：擋連按與洗版。
 *
 * 全部只在記憶體：私訊不寫快照，伺服器重開就沒了。封鎖名單也一樣 ——
 * 這是單場活動的工具，不是通訊軟體。
 */

import { randomBytes } from 'node:crypto';
import { DIRECT_MESSAGE, MSG_ERRORS } from '../shared/protocol.js';
import { DIRECT_MESSAGES } from './config.js';

/** 剝除控制字元（含換行）並去頭尾空白。訊息會畫進對方手機，控制字元會破壞排版 */
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return [...raw]
    .filter((ch) => { const c = ch.codePointAt(0); return c > 0x1f && c !== 0x7f && !(c >= 0x200b && c <= 0x200f) && c !== 0x2028 && c !== 0x2029; })
    .join('')
    .trim();
}

export class MessageRelay {
  constructor(options = {}) {
    this.opts = { ...DIRECT_MESSAGES, maxLength: DIRECT_MESSAGE.maxLength, ...options };
    /** 收件人 → 他封鎖的寄件人 @type {Map<string, Set<string>>} */
    this.blocks = new Map();
    /** 最近的訊息，供檢舉查回原文 @type {Map<string, {id, from, to, text, at}>} */
    this.recent = new Map();
    /** 寄件人 → 最近一分鐘內的送出時間 @type {Map<string, number[]>} */
    this.sentAt = new Map();
    /** 主辦端的檢舉清單，新的在前 */
    this.reports = [];
  }

  /**
   * 送出一則訊息。
   * @param {string} from 寄件人 id
   * @param {string} to 收件人 id
   * @param {unknown} rawText
   * @param {{exists: (id: string) => boolean, online: (id: string) => boolean}} presence
   * @returns {{ok: true, delivered: boolean, message?: object} | {ok: false, reason: string}}
   *   delivered=false 代表被收件人封鎖（對寄件人仍回報成功）
   */
  send(from, to, rawText, presence, now = Date.now()) {
    if (from === to) return { ok: false, reason: MSG_ERRORS.SELF };
    const text = cleanText(rawText);
    if (!text) return { ok: false, reason: MSG_ERRORS.EMPTY };
    // 以字元（code point）計，不是 UTF-16 長度：emoji 算一個字，中文也是
    if ([...text].length > this.opts.maxLength) return { ok: false, reason: MSG_ERRORS.TOO_LONG };
    if (typeof to !== 'string' || !presence.exists(to)) return { ok: false, reason: MSG_ERRORS.NOT_FOUND };
    if (this.isBlocked(from, to)) return { ok: false, reason: MSG_ERRORS.BLOCKED };
    if (!presence.online(to)) return { ok: false, reason: MSG_ERRORS.OFFLINE };

    // 頻率限制放在驗證之後：打錯字被拒不該吃掉額度
    const times = (this.sentAt.get(from) ?? []).filter((t) => now - t < 60000);
    if ((times.length && now - times.at(-1) < this.opts.minIntervalMs) || times.length >= this.opts.perMinute) {
      this.sentAt.set(from, times);
      return { ok: false, reason: MSG_ERRORS.RATE_LIMITED };
    }
    times.push(now);
    this.sentAt.set(from, times);

    if (this.blocks.get(to)?.has(from)) return { ok: true, delivered: false };

    const message = { id: randomBytes(8).toString('hex'), from, to, text, at: now };
    this.recent.set(message.id, message);
    this.#prune(now);
    return { ok: true, delivered: true, message };
  }

  /**
   * 收件人封鎖寄件人。回傳是否真的新增了一筆
   *
   * 只收場上真的有的人，每人另有上限：否則任何一支手機都能送上千個捏造的 id，
   * 每一個都在記憶體裡留到活動結束。
   *
   * @param {{exists: (id: string) => boolean}} [presence]
   */
  block(by, target, presence) {
    if (typeof target !== 'string' || !target || by === target) return false;
    if (presence && !presence.exists(target)) return false;
    const set = this.blocks.get(by) ?? new Set();
    if (set.has(target) || set.size >= this.opts.maxBlocks) return false;
    set.add(target);
    this.blocks.set(by, set);
    return true;
  }

  /** 解除封鎖。回傳是否真的移除了一筆 */
  unblock(by, target) {
    const set = this.blocks.get(by);
    if (!set?.delete(target)) return false;
    if (!set.size) this.blocks.delete(by);
    return true;
  }

  /** 某人封鎖了哪些人（給他自己的手機顯示用） */
  blockedBy(by) {
    return [...(this.blocks.get(by) ?? [])];
  }

  isBlocked(by, target) {
    return this.blocks.get(by)?.has(target) ?? false;
  }

  /**
   * 檢舉一則訊息。只有那則訊息的收件人能檢舉 —— 否則任何人都能拿猜到的 id
   * 去翻別人的私訊原文。
   * @returns {object|null} 新增的檢舉；不合格或重複時回 null
   */
  report(by, messageId, now = Date.now()) {
    const message = typeof messageId === 'string' ? this.recent.get(messageId) : null;
    if (!message || message.to !== by) return null;
    if (this.reports.some((r) => r.messageId === messageId)) return null;
    const entry = { messageId, from: message.from, to: message.to, text: message.text, at: message.at, reportedAt: now };
    this.reports.unshift(entry);
    this.reports.length = Math.min(this.reports.length, this.opts.reportsMax);
    return entry;
  }

  dismissReport(messageId) {
    const before = this.reports.length;
    this.reports = this.reports.filter((r) => r.messageId !== messageId);
    return this.reports.length !== before;
  }

  /**
   * 某人離場（主動或被移除）：清掉他的頻率紀錄與封鎖關係。檢舉保留，主辦端還要看得到。
   *
   * 封鎖要兩個方向都清：他封鎖的人、以及別人名單裡的他。離場後 id 不會再被用到
   * （重新進場是新的 id），留著只會讓記憶體隨活動時間一直長。
   */
  forget(id) {
    this.sentAt.delete(id);
    this.blocks.delete(id);
    for (const [by, set] of this.blocks) {
      if (set.delete(id) && !set.size) this.blocks.delete(by);
    }
  }

  #prune(now) {
    for (const [id, m] of this.recent) {
      if (now - m.at <= this.opts.keepForReportMs && this.recent.size <= this.opts.keepMax) break;
      this.recent.delete(id);   // Map 依插入順序，最舊的在前
    }
  }
}
