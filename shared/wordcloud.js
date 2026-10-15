/**
 * 文字雲：主持人出一題，參與者用手機輸入短答，大螢幕即時以文字雲呈現。
 *
 * 伺服器（驗證、彙整）、手機（maxlength、作答面板）、主辦端（出題、隱藏）、
 * 大螢幕（版面）四端共用本檔的限制與正規化。正規化各寫一份的話，
 * 「開心」與「開心 」在大螢幕上會變成兩個詞，而主辦端隱藏的是另一個。
 */

export const WORDCLOUD = {
  maxQuestionLength: 40,  // 大螢幕標題一行放得下
  maxAnswerLength: 12,    // 一個詞或一句短語。太長的話文字雲排不下，也不再是「一個詞」
  maxPerPerson: 3,        // 每人最多幾個答案：夠表達，又不會讓單一個人洗版
  maxShown: 60,           // 大螢幕最多畫幾個詞（依票數），再多就糊成一片
};

/**
 * 剝除控制字元與零寬字元、收合空白、去頭尾空白。
 * 不做 NFKC：那會把中文的全形標點（？！，）轉成半形，題目與答案顯示起來就怪了。
 * 正規化只用在彙整（wordKey）。
 */
export function cleanAnswer(raw) {
  if (typeof raw !== 'string') return '';
  // 先把換行、tab 等空白收成一個空格（換行換成空格，不是直接黏起來），再剝控制字元
  return [...raw.replace(/\s+/g, ' ')]
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 0x1f && c !== 0x7f && !(c >= 0x200b && c <= 0x200f) && c !== 0x2028 && c !== 0x2029 && c !== 0xfeff;
    })
    .join('')
    .trim();
}

/**
 * 彙整用的鍵：同一個詞的不同寫法算同一個。
 * NFKC 把全形英數轉半形，英文不分大小寫，去掉空白與常見標點
 * （「開心！」「開心」「開 心」都是同一個詞）。
 */
export function wordKey(text) {
  return cleanAnswer(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s!！?？。，,、.~～…·'"「」『』()（）]/g, '');
}
