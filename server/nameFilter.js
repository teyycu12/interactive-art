/**
 * 顯示名稱的不雅字詞過濾。
 *
 * 名稱會直接投影在大螢幕上，而現場是校園公共空間 —— 一個髒字被投出來，
 * 主辦方只能當場踢人，而那時全場都已經看到了。這裡在入場時就擋下來。
 *
 * 刻意只做「明顯的」那一層，不追求滴水不漏：
 *
 * - **不擋單字「幹」「屌」「靠」**。「幹部」「能幹」「屌打」「靠譜」都是正常用語，
 *   12 字以內的名稱誤殺一個就是一位參與者進不了場。
 * - **英文一律只比整個字**，不比子字串：否則「Cassie」「Dickson」被擋，
 *   拼音名字黏起來更會撞上（Chen Shi Ting → chenshiting），見下方 WHOLE_WORD。
 * - 擋得住「f u c k」「幹 你 娘」「ｆｕｃｋ」「sh1t」這類加空白、全形、數字代換的寫法。
 *
 * 真正鑽過去的，主辦端仍可踢人（HOST_KICK）。這份詞表是第一道，不是唯一一道。
 */

/** 中文：正規化後只要「包含」就擋。中文名字不會意外拼出這些詞 */
const CONTAINS = [
  // 台灣常見髒話
  '幹你娘', '幹您娘', '幹恁娘', '幹拎娘', '干你娘', '姦你娘', '操你', '肏',
  '靠北', '靠杯', '靠腰', '機掰', '機八', '雞掰', '雞巴', '鸡巴', '屄',
  '三小', '尛', '王八蛋', '他媽的', '你媽的', '去你的', '婊子', '賤人', '賤貨',
  '白痴', '白癡', '智障', '腦殘', '低能', '去死', '廢物',
  '傻逼', '傻屄', '煞筆', '屌你',
  // 性相關
  '淫', '強姦', '性交', '做愛', '陰莖', '陰道', '色情',
];

/**
 * 英文：只比「整個字」，連同明列的變形。
 *
 * **英文不做子字串比對。** 原本 shit、fuk、cunt 是子字串比對，而且是在拿掉空白
 * 之後比 —— 拼音名字整串黏起來就撞上了：Chen Shi Ting → chenshiting（shit）、
 * Fu Kai → fukai（fuk）、Cun Ting → cunting（cunt）。被擋的人只看到「這個名稱
 * 不能使用」，不知道為什麼，就進不了場。在台灣校園，這比漏掉一個髒字嚴重得多。
 */
const WHOLE_WORD = new Set([
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin', 'motherfucker', 'fuk', 'fk', 'fck',
  'shit', 'shits', 'shitty', 'bullshit',
  'bitch', 'bitches', 'cunt', 'cunts', 'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots',
  'whore', 'whores', 'slut', 'sluts', 'asshole', 'assholes', 'pussy', 'penis', 'vagina', 'porn', 'dildo',
  'ass', 'dick', 'cock', 'sex', 'wtf', 'stfu', 'rape', 'kys', 'nazi', 'cum', 'tits',
]);

/**
 * 黏在別的字前面也擋（fuckyou、bitchass）。只收**拼音拼不出來**的字：
 * shit 不能放（Shi Tao → shitao）、cunt 不能放（Cun Ting → cunting）。
 * 要加字之前先想一遍有沒有哪個拼音或日文名字以它開頭。
 */
const PREFIX = ['fuck', 'bitch', 'nigger', 'nigga', 'faggot', 'whore', 'asshole', 'motherfuck'];

/** 常見的數字／符號代換。在剝除符號之前套用，否則 @ 與 $ 會先被刪掉 */
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

function deLeet(s) {
  return [...s].map((ch) => LEET[ch] ?? ch).join('');
}

/** 全形轉半形、大小寫統一 */
function fold(raw) {
  return raw.normalize('NFKC').toLowerCase();
}

/** @returns {boolean} 名稱含不雅字詞時為 true */
export function isBlockedName(raw) {
  if (typeof raw !== 'string') return false;
  const folded = fold(raw);

  // 整字比對要用原本的分隔：「my ass」要擋，「Cassie」不擋
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.some((w) => WHOLE_WORD.has(w) || WHOLE_WORD.has(deLeet(w)))) return true;

  // 拿掉空白與符號後：整串剛好是一個髒字（「f u c k」「b!tch」），或以拼音拼不出的髒字開頭
  const compact = deLeet(folded).replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '');
  if (WHOLE_WORD.has(compact)) return true;
  if (PREFIX.some((p) => compact.startsWith(p))) return true;

  // 中文：包含就擋，抓「幹_你_娘」
  const compactRaw = folded.replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '');
  return CONTAINS.some((term) => compact.includes(term) || compactRaw.includes(term));
}
