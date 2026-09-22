# 場景主題

大螢幕的背景依活動場合切換。主題目錄在 [shared/themes.js](../../../shared/themes.js)，
伺服器、主辦端、大螢幕三端共用。

| id | 名稱 | 適合場合 | 實作 |
|---|---|---|---|
| `kitchen` | 日常廚房（預設） | 交誼・破冰 | `KitchenScene` + `kitchenArt.js` |
| `office` | 共享辦公室 | 企業團建・新生訓練 | `OfficeScene` + `officeArt.js` |
| `room` | 原始客廳（3D） | 展演備援 | `../3d/RoomScene.js` |

## 切換流程

主辦端控制台最上方的「場景主題」面板 → `HOST_SET_THEME` → 伺服器驗證後以
`STAGE_THEME` 廣播給所有大螢幕與主辦端 → 大螢幕 `dispose()` 舊場景、建立新場景，**不重新載入頁面**。

- 角色、分數、進行中的任務與問答都不受影響；切換只換背景與道具外觀。
- 大螢幕連線（`SCREEN_HELLO`）與主辦端認證（`HOST_AUTH`）時都會補送 `STAGE_THEME` ——
  主題選單只由這個事件驅動，少了補送，重整後就不知道目前選的是哪個。
- 目前主題寫進伺服器快照，活動中途重開伺服器不會跳回預設。
- 大螢幕開機先用上次的主題（localStorage），避免投影機重開時先閃一下預設場景。
- 網址帶 `?scene=<id>` 會**釘住**該主題、不跟隨主辦端，供開發預覽用。
- 載入期間又切換時，過期的場景會被丟棄，不會兩張畫布疊在一起。

## 像素主題的共同約束（PixelScene）

- 畫布 16:9 的 2596 × 1460（1920×1080 投影機可滿版、無黑邊），房間置中，
  左右延伸為裝飾區（廚房：菜園與露台；辦公室：接待大廳與遊戲室），不可行走。
- 正交 2D 投影，等比縮放與置中。角色腳底 `(x,y)` 映射為 `(338+x,270+y)`，再轉為 CSS 像素；
  角色高度 `worldHeight * 57 * zoom`。依 C2 的 2D 特例，遠近高度相同。
- 所有主題共用 `shared/scene.js` 的同一組 PROPS / ZONES；主題只換外觀與道具名稱。
  分區名稱是視覺別名，區域 id 及手機端原區域名稱維持既有協定。
- 點擊物件（或 Tab 聚焦、Enter 啟動）、或角色走到碰撞半徑外 65 邏輯單位內，會播放約 4.5 秒的物件動畫；
  支援 reduced-motion。離線與合照定位中的角色不觸發。互動狀態只存在這一台大螢幕，不寫回伺服器。
- `shared/themes.js` 的 `spots` 會畫成黃色號碼牌（「1號桌」）。之後的集合任務從同一份資料取座標，
  畫面上寫的和伺服器判定的才會是同一張桌子。
- 所有外觀由本地 Canvas 程序繪製，無 CDN、圖片載入或生圖服務依賴。

## 新增主題

1. 在 `shared/themes.js` 的 `THEMES` 加一筆（id、label、occasion、brief、spots）。
2. 在這個目錄新增 `XxxScene extends PixelScene`，提供 `THEME_ID`、`TITLE`、`SUBTITLE`、
   `ITEMS`（每個非盆栽道具都要有，測試會擋）、`FALLBACK`、`paintRoom`、`paintProp`。
   共用的畫筆、雜湊、名牌與號碼牌在 `pixelKit.js`。
3. 在 `registry.js` 的 `SCENES` 註冊。`test/themes.test.mjs` 會檢查目錄與註冊表一致。
4. 非像素場景（如 3D）需提供 `projectToScreen`、`scaleAt`、`render`、`canvas`（或 `renderer.domElement`）
   與 `dispose()` —— 少了 `dispose()`，每切換一次就多留一個 WebGL context。
5. 角色層不可移入場景模組；任何新互動不得改寫 `updateAgents` 傳入的資料。

## 驗證

```bash
npm test                 # 含 test/themes.test.mjs
npm run test:e2e         # 含主題切換、補送、未認證拒絕、重開後保留
node --import ./test/helpers/shared-path-hook-register.mjs --test public/screen/scenes/KitchenScene.test.mjs
```
