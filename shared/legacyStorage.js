/**
 * 系統改名 PersonaFlow → PixelAir（2026-10-18）：瀏覽器裡存的鍵從 personaflow.* 改成 pixelair.*。
 * 這支在頁面其他程式讀取之前，把舊鍵搬到新鍵 —— 否則手機會被當成新的人（userId、
 * rejoinToken 不見），主辦端的題庫、節目單、現場動態也會消失。新鍵已存在時不覆蓋。
 */
const OLD = 'personaflow.';
const NEW = 'pixelair.';

for (const store of ['localStorage', 'sessionStorage']) {
  try {
    const s = globalThis[store];
    const oldKeys = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(OLD)) oldKeys.push(k);
    }
    for (const k of oldKeys) {
      const nk = NEW + k.slice(OLD.length);
      if (s.getItem(nk) === null) s.setItem(nk, s.getItem(k));
      s.removeItem(k);
    }
  } catch { /* 私密視窗或封鎖網站資料時存取會丟例外，略過即可 */ }
}
