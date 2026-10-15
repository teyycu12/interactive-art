/**
 * 「今天遇見的人」是怎麼遇見的。伺服器記帳、手機顯示與紀念卡共用同一份。
 *
 * 陣列順序就是顯示順序：關係愈實的排愈前面。
 * `oneWay` 的互動只記在主動的那一方（見 server/encounters.js）。
 */
export const ENCOUNTER_KINDS = [
  { id: 'pair', label: '配對認識' },
  { id: 'harvest', label: '交接籃子' },   // 採水果已移除；留著標籤，舊紀錄才顯示得出來
  { id: 'message', label: '傳過訊息' },
  { id: 'topic', label: '同桌聊天' },
  { id: 'cheers', label: '一起乾杯' },
  { id: 'wave', label: '互相揮手' },
  { id: 'bingo', label: '賓果找到', oneWay: true },
];

export const VIA = Object.fromEntries(ENCOUNTER_KINDS.map((k) => [k.id.toUpperCase(), k.id]));

const LABEL = new Map(ENCOUNTER_KINDS.map((k) => [k.id, k.label]));

/** 「配對認識・一起乾杯」。不認得的種類略過：舊版手機收到新種類時不該顯示 undefined */
export const encounterLabel = (via) =>
  (Array.isArray(via) ? via : []).map((v) => LABEL.get(v)).filter(Boolean).join('・');
