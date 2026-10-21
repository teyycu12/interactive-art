/**
 * 場景主題目錄。
 *
 * 伺服器（驗證 HOST_SET_THEME）、主辦端（渲染主題選單）、大螢幕（決定載入哪個場景）
 * 三端共用，理由與 MISSION_TYPES、QUIZ_CHOICES 相同：各存一份必然漂移，
 * 而漂移的症狀是「主辦端選了辦公室、大螢幕卻還是廚房」且兩邊都不報錯。
 *
 * 所有主題共用 shared/scene.js 的同一組 PROPS / ZONES（碰撞佈局在伺服器上，
 * 不能因主題而異），主題只換「外觀」與「這個道具叫什麼」。
 *
 * spots：把道具 id 對應成現場喊得出口的地點名稱（「1號桌」）。
 * 大螢幕會把它畫成號碼牌；之後以資料驅動的集合任務
 * （例：「今天穿白色的人到 1號桌集合」）也從這裡取道具座標，
 * 畫面上寫的和伺服器判定的才會是同一張桌子。
 */
export const THEMES = [
  {
    id: 'kitchen',
    label: '日常廚房',
    occasion: '交誼・破冰',
    brief: '溫暖的像素廚房，適合輕鬆的聚會與交流活動。',
    spots: { k_dining: '1號桌', ctbl_1: '2號桌' },
    // 解碼任務的符號（shared/decode.js）：要一眼叫得出名字，念出來才不會對錯
    decodeSymbols: [
      { glyph: '🍎', name: '蘋果' }, { glyph: '🍌', name: '香蕉' }, { glyph: '🍇', name: '葡萄' },
      { glyph: '🍋', name: '檸檬' }, { glyph: '🍓', name: '草莓' }, { glyph: '🍉', name: '西瓜' },
      { glyph: '🥕', name: '紅蘿蔔' }, { glyph: '🌽', name: '玉米' }, { glyph: '🍄', name: '香菇' },
      { glyph: '🥚', name: '蛋' },
    ],
  },
  {
    id: 'office',
    label: '共享辦公室',
    occasion: '企業團建・新生訓練',
    brief: '開放工作區、會議室與休息區，適合團隊活動與新人認識彼此。',
    spots: { tbl_1: '1號桌', tbl_2: '2號桌', tbl_3: '3號桌', k_dining: '4號桌', ctbl_1: '5號桌' },
    // 話題桌只在辦公室開（2026-10-17 試玩回饋）：其他場景的號碼牌是集合點與器材站，
    // 走過去是為了任務，跳出聊天題只會打斷人。spots 照樣給集合任務用
    topicTables: true,
    decodeSymbols: [
      { glyph: '📎', name: '迴紋針' }, { glyph: '✏️', name: '鉛筆' }, { glyph: '📌', name: '圖釘' },
      { glyph: '📁', name: '資料夾' }, { glyph: '💡', name: '燈泡' }, { glyph: '☕', name: '咖啡' },
      { glyph: '📅', name: '日曆' }, { glyph: '✂️', name: '剪刀' }, { glyph: '📏', name: '尺' },
      { glyph: '💻', name: '筆電' },
    ],
  },
  {
    id: 'gym',
    label: '活力體育館',
    occasion: '運動會・體育課・社團迎新',
    brief: '木地板球場、暖身區與看台，室外有跑道，適合動態的團體活動。',
    // 號碼牌給集合任務用：暖身區三台器材當「站」，頒獎台與飲料桶各一個集合點
    spots: { tbl_1: '1號站', tbl_2: '2號站', tbl_3: '3號站', k_dining: '集合點', ctbl_1: '補給站' },
    // 體育館不擺盆栽（2026-10-21）：球場上擺盆栽很怪，也擋住傳球的路線。
    // 拿掉的道具不畫也不擋人（shared/scene.js 的 propsForTheme）
    removedProps: ['plt_1', 'plt_2', 'plt_3', 'plt_4', 'plt_5'],
    // 傳球＋投籃（shared/hoops.js、server/hoops.js）：走到球車拿球、在籃框區投。
    // 用道具與分區的 id 指定，伺服器端不寫死「籃球」—— 換個場景也能接上別的投擲玩法
    hoops: { cart: 'k_cart', hoop: 'k_island', zone: 'stage' },
    decodeSymbols: [
      { glyph: '⚽', name: '足球' }, { glyph: '🏀', name: '籃球' }, { glyph: '🏐', name: '排球' },
      { glyph: '🎾', name: '網球' }, { glyph: '🏓', name: '桌球' }, { glyph: '🏸', name: '羽球' },
      { glyph: '🥇', name: '金牌' }, { glyph: '👟', name: '球鞋' }, { glyph: '⏱️', name: '碼錶' },
      { glyph: '🚩', name: '旗子' },
    ],
  },
  {
    id: 'room',
    label: '原始客廳（3D）',
    occasion: '展演備援',
    brief: '最初的 3D 客廳場景。需要 WebGL，較吃投影電腦效能。',
    spots: {},
    // 不是正式場景：主辦端選不到、伺服器也不接受。程式碼保留給 ?scene=room 開發預覽，
    // 以及 registry.js 的載入失敗備援 —— 所以不能直接從 THEMES 刪掉。
    selectable: false,
  },
];

export const DEFAULT_THEME = 'kitchen';

export const THEME_MAP = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export const isThemeId = (id) => typeof id === 'string' && Object.hasOwn(THEME_MAP, id);

/** 主辦端可以選、伺服器會接受的主題（排除 selectable: false 的開發用場景） */
export const SELECTABLE_THEMES = THEMES.filter((t) => t.selectable !== false);

export const isSelectableTheme = (id) => isThemeId(id) && THEME_MAP[id].selectable !== false;
