# 場景銜接約束（Scene Contract）

> 對象：要替 PersonaFlow 互動層做**新場景**的專案。
> 參考實作：本專案的 `public/screen/screen.js` ＋ `public/screen/3d/RoomScene.js`。
> 版本：2026-09-17，對應 `shared/protocol.js` 現行協定。

## 0. 這份文件管什麼、不管什麼

**場景怎麼做，這份文件不管。** 房間、戶外、抽象空間、2D 插畫、Three.js、
Babylon、Pixi、純 Canvas、預渲染影片當底圖都可以；光線、鏡頭、材質、後製、
道具模型、美術風格全由場景專案自行決定。

**人怎麼進到場景裡，這份文件管。** 「人」指的是參與者的角色：伺服器送來的
名冊與座標、生成服務產出的貼圖，以及它們被畫到場景上的方式。這些是跨專案、
跨語言的耦合，對不上時**多半不會報錯**，只會出現角色穿牆、浮空、脖子錯位、
手機與大螢幕長得不一樣之類的現場故障。

下文以「**必須**」標示硬約束，「**建議**」標示可以偏離但要有理由的做法。
每條約束附上「違反時會怎樣」，方便判斷能不能妥協。

---

## 0.1 開發方式與交付範圍

**只拿這份文件無法開工。** 本文件引用的 `shared/` 模組是角色繪製的唯一來源，
前端的 `/shared/...`、`/vendor/three.module.js` 等路徑也依賴本專案的伺服器
（`server/httplayer.js` 由 `node_modules` 直出，import map 在
`public/screen/index.html`）。

### 建議做法：在本 repo 的分支上開發

1. 取得本 repo 存取權（或 fork），從 `main` 開分支。
2. 允許修改的範圍：

   | 路徑 | 內容 |
   |---|---|
   | `public/screen/` | 替換 `3d/RoomScene.js`；必要時調整 `screen.js` 與場景銜接的部分 |
   | `public/assets/` | 場景的模型、貼圖、字型（不可放進 `assets/gen/`，那是角色貼圖落地處） |
   | `shared/scene.js` | 佈局改變時才動（C6），改完須通過 `test/scene.test.mjs` |
   | `package.json` | 新增前端相依時；該相依須經 `server/httplayer.js` 由 `node_modules` 直出（C9） |

3. **不可修改**：`server/`（上一列的直出路由除外）、`public/controller/`、
   `public/host/`、`backend/`，以及 `shared/` 中除 `scene.js` 以外的檔案。
   需要改到這些地方，代表違反了某條約束，請先與本專案討論。

4. 本機開發不需要真人或手機：

   ```bash
   npm install
   bash start.sh                    # 互動層 :3000；只需互動層可改跑 node server/index.js
   npm run bots -- --count 9        # 放 9 個虛擬參與者進場
   # 瀏覽器開 http(s)://localhost:3000/screen/
   ```

   `bots` 以捏臉角色進場。要驗證掃描生成的貼圖角色（C4），需另外啟動
   生成服務並設定生圖 API，見 `docs/notes/LOCAL-PREVIEW.md`。

5. 交付：開 PR 回 `main`。驗收依第 5 節檢查表，另加：
   - PR 的變更檔案未超出第 2 點的範圍
   - `npm test` 與 `npm run test:e2e` 通過

### 若必須在獨立 repo 開發

最少需要取得：本文件、`shared/` 整個目錄、`public/screen/`（參考實作）、
`test/scene.test.mjs`，以及一個可連線的互動層伺服器（搭配 `npm run bots`）。

- `shared/` **必須**以 git submodule 或等價方式引用本 repo，**不可**複製一份
  自行修改 —— 那會產生第二份切片比例與步態常數（C4、C5），日後兩邊漂移
  不會報錯。
- 合併回本專案時，一律改回引用本 repo 的 `shared/`。
- `/shared/...` 與 `/vendor/...` 的絕對路徑需由開發伺服器提供相同的對應。

---

## 1. 場景專案的自由（明文不限制）

| 項目 | 說明 |
|---|---|
| 渲染技術 | 任何可在瀏覽器執行的技術；也可以不是 3D |
| 空間形狀與尺寸 | 世界單位、房間大小、地形都自訂，只要能提供第 3 節的映射 |
| 鏡頭 | 透視／正交、固定／可移動、運鏡動畫皆可 |
| 光線、材質、後製 | 不限，包含日夜切換、Bloom、AO |
| 道具與裝飾 | 視覺自訂；**但會擋路的東西見 C6** |
| 氛圍動態 | 植物擺動、粒子、天氣等不限 |
| 角色以外的 UI | 任務公告、排行榜、問答面板的版面可自訂（事件內容不可改） |

---

## 2. 資料流總覽

```
生成服務 ──貼圖檔──▶ /assets/gen/<assetId>/{full,head,torso,legs}.webp
                                   │
手機 ──CLIENT_JOIN(avatar)──▶ 互動層 server/ ──STAGE_ROSTER──▶ ┐
                                   │   └──STAGE_SYNC 30Hz───▶ ├─ 大螢幕
                                   │   └──STAGE_LINKS────────▶ ┘   ├ 場景層（自由）
                                   │                                └ 角色層（受本文件約束）
shared/scene.js（ZONES / PROPS）──▶ 伺服器 Boids 避障 ＋ 場景視覺對位
```

場景專案**只在大螢幕端**接上這條管線。伺服器、手機端、生成服務都不需要為了
新場景而修改 —— 若發現需要改，代表違反了下列某條約束。

---

## 3. 硬約束

### C1　邏輯座標系是唯一的位置語言

- 伺服器所有位置都在 **邏輯平面 `STAGE = { width: 1920, height: 1080 }`**
  （`shared/protocol.js`），原點左上，**x 向右、y 向下**。
- 每個角色的 `(x, y)` 代表**腳底接地點**，不是中心、不是頭頂。
- `heading` 為弧度，定義為 `atan2(vy, vx)`，**以邏輯平面的 y 向下為準**。
  `Math.PI / 2` 在本系統的語意是「面向觀眾」（合照定位用，見 C8）。
- **必須**：場景不得要求伺服器改用其他座標系或尺寸；場景自己的世界座標
  一律在大螢幕端由映射函式換算（見 C2）。

> 違反時：伺服器的 Boids、分區判定（`zoneAt`）、尋寶判定、合照定位全部以
> 1920×1080 計算。改了尺寸，角色會走不到場景邊緣或走出場景，而且分區
> 與寶箱位置會與畫面對不上。

### C2　場景必須提供「邏輯座標 → 畫面」的映射

場景物件**必須**對外提供下列兩個函式（名稱沿用參考實作，方便直接替換）：

```js
/**
 * 邏輯座標的「地面接地點」投影到角色圖層的座標。
 * @returns {{x:number, y:number}}  CSS 像素，原點為角色畫布左上角
 */
projectToScreen(logicX, logicY)

/**
 * 在該邏輯座標處，一個高 worldHeight（場景世界單位）的直立物
 * 投影到畫面上的像素高度。
 * @returns {number}  CSS 像素；無法計算（畫面外、鏡頭背後）時回傳 0
 */
scaleAt(logicX, logicY, worldHeight)
```

- **必須**回傳 CSS 像素，而且與角色畫布的座標空間一致
  （角色畫布以 `ctx.setTransform(dpr, …)` 畫在 CSS 像素上）。
- **必須**在每一幀重新計算。鏡頭會動的場景不可快取投影結果。
- **必須**投影「地面」：地形有高低時，`projectToScreen` 回傳的是該點地表的
  位置，而不是固定高度平面。
- 2D 場景的最簡實作：`projectToScreen` 做等比縮放加置中位移，
  `scaleAt` 回傳常數乘以縮放比。
- 參考實作的角色身高為 `CHARACTER_WORLD_HEIGHT = 2.1`（房間牆高 4.6）。
  場景可自訂這個值，但**必須**讓角色與場景道具的比例看起來合理。

> 違反時：投影成中心點而非地面，角色會浮空或陷進地板；不隨深度縮放，
> 角色會像「貼紙浮在畫面上」（參考實作中房間最深處到最近處相距 2.45 倍）。

### C3　角色狀態只讀，不自行模擬

大螢幕只能從以下事件取得角色資料，欄位定義以 `server/state.js` 為準：

| 事件 | 頻率 | 內容 |
|---|---|---|
| `STAGE_META` | 連線時一次 | `{ stage, fps }` |
| `STAGE_ROSTER` | 成員變動時 | `agents: [{ id, name, avatar }]` |
| `STAGE_SYNC` | 30 Hz | `agents: [{ id, x, y, vx, vy, heading, state, mode, alpha, facing, offline, emote, emoteT?, arrived? }]` |
| `STAGE_LINKS` | 配對成功時 | `edges: [{ a, b, at }]` |

- 連線後**必須**先送 `SCREEN_HELLO` 註冊為顯示端。
- **必須**以伺服器座標為準。允許做**內插**（參考實作每幀
  `v += (target - v) * 0.35`），**不允許外推**，也不允許在大螢幕端跑自己的
  群聚或物理。
- **必須**把 `STAGE_ROSTER`（外觀）與 `STAGE_SYNC`（座標）分開處理：
  外觀只在 `avatar` 內容改變時才重建圖像。
- 選用欄位（`emoteT`、`arrived`）缺席時視為預設值。

> 違反時：本地模擬會讓畫面與伺服器分歧 —— 手機上看到角色卡在牆邊，
> 大螢幕上卻已穿過去（issue #8 的教訓）。每次名冊都重建圖像會讓十張貼圖
> 反覆重新下載與解碼。

### C4　角色圖像一律用 `shared/avatarSprite.js` 組裝

- **必須** `import { avatarImage } from '/shared/avatarSprite.js'`，
  大螢幕呼叫時帶 `{ enhance: true }`（投影機亮度補償）。
- **不可**在場景專案裡另寫一份貼圖組裝、切片比例或替身邏輯。
- 組裝規則（僅供理解，不要重寫）：
  - `avatar.source === 'CV'`：先載 `textures.full`，失敗或不存在才依
    `CV_CUTS` 把 `head / torso / legs` 疊回；**等比縮放、底部對齊**。
  - 貼圖未到之前先畫 `fallbackColors` 取樣色替身，**角色不可有空白期**。
  - 其他來源：捏臉 SVG（備援路徑，**不可移除**）。
- 畫布尺寸固定 `AVATAR_W × AVATAR_H = 788 × 1024`，寬高比 200:260。
- 若 3D 場景要把角色做成 billboard／貼圖平面，**必須**以 `avatarImage()`
  回傳的 canvas 作為材質來源，並維持 200:260 比例與底部錨點。

> 違反時：`CV_CUTS` 與 `backend/slicer.py` 的 `CUTS` 是跨語言耦合，
> 自行實作一份就多了第三份事實來源，比例一漂移角色就脖子錯位或腿被壓扁，
> 且沒有任何錯誤訊息。自行鋪滿畫布會把每個人橫向拉寬約 20%。

### C5　角色繪製契約

若角色畫在 2D 圖層（參考實作的做法）：

- **必須**使用 `shared/character.js` 的
  `drawCharacter` / `drawNameplate` / `drawEmote` / `drawOffline`。
  步態常數（`BOB_OMEGA` 等）與手機端共用，不可另抄。
- 錨點是 `projectToScreen(x, y)` 的回傳值，高度是 `scaleAt(x, y, 角色身高)`；
  `scaleAt` 回傳 ≤ 1 時退回固定高度，**角色不可因此消失**。
- **必須**依邏輯 `y` 由小到大排序後繪製（近者蓋遠者）。
  若場景的鏡頭方向讓「y 大 = 離鏡頭近」不成立，**必須**改以投影後的
  深度排序，並在場景文件中註明。
- 名牌字級隨角色高度縮放（參考：`max(10, height * 0.12)`），
  且**不隨步態晃動**。
- 繪製順序（下 → 上）：寶箱 → 社交連線 → 配對光束 → 配對脈衝環／進場箭頭
  → 角色 → 名牌 → 表情 → 離線標記。

若角色做成 3D 物件：

- **必須**讓步態觀感與 `shared/character.js` 一致：速度低於
  `WALK_THRESHOLD`（18）時步態連續淡出至靜止，**不可**以 `state` 布林硬切；
  步頻依 `MAX_SPEED`（190）縮放。
- 朝向使用 `heading`（完整角度）；2D 圖層使用 `facing`（±1 鏡像）。
- 名牌、表情、離線標記仍**必須**出現，內容與 2D 版一致。

> 違反時：步態硬切會讓角色停下瞬間抽一下；自訂步頻會讓「手機上的我」
> 與「大螢幕上的我」走路節奏不同。

### C6　會擋路的東西必須登記在 `shared/scene.js`

- 伺服器的避障只認得 `shared/scene.js` 的 `PROPS`（座標＋碰撞半徑 `r`）。
- **必須**：場景中任何**看起來會擋路**的物件（家具、柱子、牆角、水池），
  其邏輯座標與半徑都要登記在 `PROPS`；反之 `PROPS` 裡的每一項，場景中都
  要有對應的視覺物件。
- **必須**：`PROPS.type` 的每一種值，場景都要有對應的渲染方式（或明確的
  後備外觀）。參考實作中漏一種就會靜默退成盆栽。
- 分區 `ZONES` 是**可行走**區域，場景應讓觀眾看得出分區位置（地毯、燈光、
  地面標示皆可，形式不限），但不可在分區內擺放未登記的障礙物。
- 伺服器在距邊界 `BOUNDARY_MARGIN = 140` 內施加回推力。場景的**可見邊界**
  應落在邏輯平面邊緣附近，避免角色看似撞上空氣或走出牆外。
- 場景專案換掉整個佈局時，交付物**必須**包含一份新的 `shared/scene.js`
  （同時被伺服器與前端載入），並通過 `test/scene.test.mjs`（分區互不重疊等）。

> 違反時：只在視覺上擺沙發而沒登記，角色會直接穿過沙發；
> 只登記不擺視覺，角色會繞開一塊空地。兩者都不會報錯。

### C7　圖層與截圖

- 場景層在下、角色層在上，兩層都用**非負** `z-index`；
  `body` **不可**有不透明背景（背景色由場景自己畫）。
- 角色層必須透明且 `pointer-events: none`，不擋場景的鏡頭操作。
- **必須**支援合照截圖：收到 `SCREEN_CAPTURE_REQ` 時，把**場景＋角色**
  合成為一張 PNG，以 `POST /api/screen-capture { requestId, image }` 回傳
  （走 HTTP，不走 WebSocket）。
  - WebGL 場景需開 `preserveDrawingBuffer`，或在截圖前強制 render 一次。
  - 場景畫布與角色畫布像素尺寸可能不同，合成時**必須**拉伸到同一尺寸。
  - 場景若包含 `<video>` 或跨來源圖片，**必須**確認截圖不會被 taint。

> 違反時：`body` 有背景色會把 3D 場景整片蓋掉，畫面只剩米色且無錯誤訊息；
> 只截其中一層，合照會「有房間沒有人」或「有人沒有房間」。

### C8　角色生命週期的呈現

| 時機 | 必須呈現 | 理由 |
|---|---|---|
| 進場 | 頭頂指示箭頭約 6 秒，尾段淡出 | 參與者要能在十人中找到自己，這是作品前提 |
| 大螢幕首次收到名冊 | **不**標記進場 | 中途重開時十人一起閃，反而誰都認不出 |
| 離場 | 顯示「某某 離開了」 | 默默消失會被當成系統故障 |
| 斷線（`offline: true`） | 角色留在場上並加標記 | 斷線轉漫遊而非消失 |
| `mode: 'STAGED'` | 角色被帶往合照位置，`heading = π/2` 面向觀眾 | 合照要看得到每個人的臉 |
| 配對完成（`MISSION_COMPLETE`） | 雙方脈衝環＋ A→B 光束 | 現場的交談必須在共享畫面上被看見 |
| 社交圖譜（`STAGE_LINKS`） | 只畫兩端都在場的邊，新邊亮、舊邊淡 | 關係網是作品真正累積的東西 |

呈現形式（箭頭形狀、光束樣式、字體）可自訂；**是否呈現**不可省略。
場景若有運鏡，**必須**確保上述提示在角色被遮擋或出畫時仍可辨認
（例如鏡頭不離開可行走範圍，或提供重設鏡頭的方式）。

### C9　離線可用與降級

- **必須**：場景所需的程式庫、模型、貼圖、字型全部由本機提供
  （`node_modules` 直出或 `public/assets/`），**不走 CDN**。
- **必須**：場景資產載入失敗時退回程序化後備外觀，不可留空白或卡住。
- **必須**：角色層不等待場景載入。場景尚未就緒時，`projectToScreen` /
  `scaleAt` 的呼叫端要有等比縮放的退路（參考實作的 `characterHeightAt`），
  角色照常出現。
- 伺服器斷線時**必須**顯示明確的離線提示；因為閒置待機的畫面與伺服器
  掛掉的畫面長得一模一樣。

> 違反時：展場網路不通，整個場景消失 —— 這是本機永遠測不出來的故障。

### C10　貼圖路徑與安全

- 角色貼圖 URL 形狀固定為
  `/assets/gen/<32 位小寫十六進位>/{full|head|torso|legs}.webp`
  （`shared/avatars.js` 的 `TEXTURE_URL_RE`），**不可**放寬或改寫。
- 場景**不可**以其他管道（base64 內嵌、外部 URL）載入角色貼圖。
- 角色名字一律以 `textContent` 或 Canvas `fillText` 輸出，**不可**插入 HTML。

### C11　效能預算

以下為現場上限，場景**必須**在此負載下維持流暢：

| 項目 | 值 |
|---|---|
| 同時在場角色 | `MAX_AGENTS = 10`（壓測時請測到上限） |
| 座標更新 | 30 Hz，大螢幕以 `requestAnimationFrame` 內插到顯示更新率 |
| 目標幀率 | 投影機原生更新率（通常 60 fps） |
| 單幀順序 | 場景 render 與角色繪製在**同一個** rAF 回呼內完成 |

場景與角色分在不同 rAF 會造成角色相對地面抖動（投影用的鏡頭矩陣與畫面不同幀）。

---

## 4. 最小銜接介面（建議）

場景專案只要提供符合下列形狀的物件，就能直接替換參考實作的 `RoomScene`：

```js
export class MyScene {
  constructor(containerElement) {}          // 掛到 #bg3d（或等價容器）
  projectToScreen(logicX, logicY) {}        // C2
  scaleAt(logicX, logicY, worldHeight) {}   // C2
  render() {}                               // 由大螢幕的 rAF 每幀呼叫（C11）
  resetCamera() {}                          // 選用：現場按 R 重設鏡頭
  applyLight(name) {}                       // 選用：'day' | 'evening' | 'night'
  get canvas() {}                           // C7：截圖時取用的場景畫布
}

// C6：依 shared/scene.js 的 PROPS 擺放道具；失敗須退回後備外觀
export async function populateProps(scene, props) {}
```

大螢幕端（`screen.js`）只以這幾個入口與場景互動，其餘皆屬場景內部實作。

---

## 5. 交付前檢查表

- [ ] 不修改 `server/`、`public/controller/`、`backend/` 即可運作
- [ ] `projectToScreen` 回傳腳底接地點，CSS 像素，每幀重算（C2）
- [ ] 角色走到房間深處會變小，走近會變大（C2）
- [ ] 角色圖像來自 `shared/avatarSprite.js`，未另寫切片或替身（C4）
- [ ] 貼圖未載入時看得到替身，不是空白（C4）
- [ ] 近的角色蓋住遠的角色（C5）
- [ ] 角色停下時不抽動，步態平順淡出（C5）
- [ ] 每個看起來會擋路的物件都在 `PROPS` 內，角色不穿過任何可見物件（C6）
- [ ] `PROPS.type` 每種值都有對應外觀（C6）
- [ ] `npm test` 通過（含 `test/scene.test.mjs`）
- [ ] 合照截圖同時含場景與角色（C7）
- [ ] 新進場有指示、離場有提示、斷線有標記、首次名冊不閃（C8）
- [ ] 拔掉網路線後重新整理，場景與角色仍正常（C9）
- [ ] 關掉伺服器時大螢幕出現離線提示（C9）
- [ ] 10 人同時在場，投影機上維持流暢（C11）
- [ ] `npm run test:e2e` 通過

---

## 6. 相關檔案

| 檔案 | 在本約束中的角色 |
|---|---|
| `shared/protocol.js` | 事件名、`STAGE`、`MAX_SPEED`、`WALK_THRESHOLD` |
| `shared/scene.js` | `ZONES`、`PROPS`、`OBSTACLES`、`zoneAt` |
| `shared/avatars.js` | `CV_CUTS`、貼圖 URL 驗證、捏臉備援 |
| `shared/avatarSprite.js` | 角色圖像組裝（C4） |
| `shared/character.js` | 角色／名牌／表情／離線標記繪製（C5） |
| `server/state.js` | `snapshot()`、`roster()` 的欄位定義（C3） |
| `public/screen/screen.js` | 大螢幕參考實作 |
| `public/screen/3d/RoomScene.js` | 場景參考實作 |
| `docs/notes/GENERATION.md` | 切片、貼圖、手機同步的踩坑紀錄 |
