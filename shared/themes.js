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
  },
  {
    id: 'office',
    label: '共享辦公室',
    occasion: '企業團建・新生訓練',
    brief: '開放工作區、會議室與休息區，適合團隊活動與新人認識彼此。',
    spots: { tbl_1: '1號桌', tbl_2: '2號桌', tbl_3: '3號桌', k_dining: '4號桌', ctbl_1: '5號桌' },
  },
  {
    id: 'room',
    label: '原始客廳（3D）',
    occasion: '展演備援',
    brief: '最初的 3D 客廳場景。需要 WebGL，較吃投影電腦效能。',
    spots: {},
  },
];

export const DEFAULT_THEME = 'kitchen';

export const THEME_MAP = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export const isThemeId = (id) => typeof id === 'string' && Object.hasOwn(THEME_MAP, id);
