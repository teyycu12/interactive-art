/**
 * 私訊的聊天紀錄，只存在這支手機的瀏覽器裡。
 *
 * 為什麼存在手機而不是伺服器：私訊原本的設計是「主辦端看不到一般私訊」
 * （見 server/messages.js）。紀錄若放伺服器，就多了一份所有人對話的存檔，
 * 而且得一起處理快照、重開與清除。放在手機上，看得到的就只有當事人自己 ——
 * 跟紙本一樣，訊息在誰手上就是誰的。
 *
 * 一個角色一份（key 帶 userId）：換新角色就是新的人，舊角色的對話不該
 * 帶過去；換角色時呼叫 dropOthers() 把舊的清掉，不在別人可能借用的手機上留著。
 *
 * storage 由外面傳入（瀏覽器是 localStorage），測試才能用假的；
 * 讀寫失敗（隱私模式、容量滿）一律當成沒有紀錄，私訊本身照常運作。
 */

export const CHATLOG_LIMITS = {
  perPeer: 100,   // 每個人最多留幾則：這是開場用的短訊息，一百則已經是整場在聊
  peers: 40,      // 最多留幾個人的對話，超過時丟掉最久沒聊的
};

const PREFIX = 'pf.chats.';

export class ChatLog {
  /** @param {Storage|null} storage */
  constructor(storage) {
    this.storage = storage;
    this.owner = null;
    /** 對象 id → { name, msgs: [{ mine, text, at, id? }], unread } */
    this.peersMap = new Map();
  }

  /** 換成某個角色的紀錄（進場拿到 userId 時呼叫） */
  setOwner(userId) {
    if (!userId || userId === this.owner) return;
    this.owner = userId;
    this.peersMap = new Map();
    try {
      const raw = JSON.parse(this.storage?.getItem(PREFIX + userId) ?? 'null');
      for (const [id, p] of Object.entries(raw?.peers ?? {})) {
        if (Array.isArray(p?.msgs)) {
          this.peersMap.set(id, { name: String(p.name ?? ''), msgs: p.msgs, unread: Math.max(0, Number(p.unread) || 0) });
        }
      }
    } catch { /* 壞掉的紀錄當成沒有 */ }
  }

  /**
   * 記一則訊息。
   * @param {string} peerId 對方
   * @param {{mine: boolean, text: string, at?: number, id?: string, name?: string, read?: boolean}} m
   *   read：收到時就已經看到了（正開著跟他的對話），不算未讀
   */
  add(peerId, { mine, text, at = Date.now(), id, name, read = false }) {
    if (!this.owner || !peerId || !text) return;
    const peer = this.peersMap.get(peerId) ?? { name: '', msgs: [], unread: 0 };
    if (name) peer.name = name;   // 對方改名或第一次知道名字時更新
    // 同一則收兩次（重連補送之類）只記一次
    if (id && peer.msgs.some((x) => x.id === id)) return;
    peer.msgs.push(id ? { mine, text, at, id } : { mine, text, at });
    // 自己回話代表已經看過對方先前的訊息
    peer.unread = mine ? 0 : (read ? 0 : (peer.unread ?? 0) + 1);
    if (peer.msgs.length > CHATLOG_LIMITS.perPeer) peer.msgs.splice(0, peer.msgs.length - CHATLOG_LIMITS.perPeer);
    // 重新插入：Map 的順序就是「最近聊過」的順序，最新的在最後
    this.peersMap.delete(peerId);
    this.peersMap.set(peerId, peer);
    while (this.peersMap.size > CHATLOG_LIMITS.peers) this.peersMap.delete(this.peersMap.keys().next().value);
    this.#save();
  }

  /** 跟某人的對話，舊的在前 */
  thread(peerId) {
    return this.peersMap.get(peerId)?.msgs ?? [];
  }

  nameOf(peerId) {
    return this.peersMap.get(peerId)?.name ?? '';
  }

  /** 打開跟某人的對話：他的訊息都算看過了 */
  markRead(peerId) {
    const peer = this.peersMap.get(peerId);
    if (!peer?.unread) return;
    peer.unread = 0;
    this.#save();
  }

  /** 全部未讀則數（「訊息」按鈕右上角的數字） */
  unreadTotal() {
    let n = 0;
    for (const p of this.peersMap.values()) n += p.unread ?? 0;
    return n;
  }

  /** 聊過的人，最近聊過的在前 */
  peers() {
    return [...this.peersMap].reverse().map(([id, p]) => ({ id, name: p.name, last: p.msgs.at(-1) ?? null, unread: p.unread ?? 0 }));
  }

  /** 清掉其他角色留下的紀錄（換新角色後呼叫） */
  dropOthers() {
    try {
      const stale = [];
      for (let i = 0; i < (this.storage?.length ?? 0); i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(PREFIX) && key !== PREFIX + this.owner) stale.push(key);
      }
      for (const key of stale) this.storage.removeItem(key);
    } catch { /* 略 */ }
  }

  #save() {
    try {
      this.storage?.setItem(PREFIX + this.owner, JSON.stringify({ peers: Object.fromEntries(this.peersMap) }));
    } catch { /* 容量滿或隱私模式：這次沒存到，不影響傳訊 */ }
  }
}
