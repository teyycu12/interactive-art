# 伺服器結構與測試

> 由 [CLAUDE.md](../../CLAUDE.md) 拆出。這裡是踩過的坑與當初的取捨理由 ——
> 動到相關程式碼之前先讀，多數條目都附了「不這樣做會怎樣」。

### 連線角色不可中途轉換

`CLIENT_JOIN` / `SCREEN_HELLO` / `HOST_AUTH` 三者互斥，已在 `server/index.js`
加上守衛。拿掉任何一個都會讓 agent 的 `disconnectedAt` 永遠是 null，
`AGENT_TTL` 不回收，反覆操作即可耗盡 `MAX_AGENTS` 上限。端對端測試有回歸防護。

### e2e 的三個間歇性失敗（都是測試的錯，不是伺服器）

`scripts/e2e.mjs` 曾約每四次就失敗一次，而三個原因**全都在測試這一側** ——
伺服器行為自始至終是對的。這類「本機偶爾紅、重跑就綠」最容易被當成環境問題
而長期忽略，實際上每一個都指向測試沒把前置條件講清楚。

**1. EPIPE 讓整個行程崩潰（`引導端點擋下過大的影格`）**

伺服器對超過上限的 body 會在讀到一半時 `req.destroy()` 切線（這是對的，
不能為了讓客戶端寫完而先收下 2MB）。但客戶端此時還在寫，那個 write 收到
EPIPE —— 而且是在 **socket** 上觸發，不是 request 物件，`req.on('error')`
接不到，未處理的 'error' 事件直接帶走整個 e2e 行程。

單獨用 curl 連打 20 次全部正確回 `frame_too_large`，所以壞的是客戶端。
`sendPost()` 現在會 `req.on('socket', s => s.on('error', () => {}))`。

**2. 殘留角色搶先找到寶藏（一次四條同時失敗）**

前面的安全性測試留下的角色（實測兇手叫「攻擊者」）**關掉 socket 不等於離場**
—— 賓客關分頁角色仍留 `AGENT_TTL_MS`＝45 秒，遠長於整套 e2e。
而 `treasure.check()` 掃的是場上**所有**非先知角色，不管有沒有連線。
藏寶點隨機落在它附近時，它會在阿賓走到之前就「找到」寶藏。

修法是在開始尋寶前用 `HOST_KICK` 明確清場，**不是**把 TTL 調短或讓尋寶
忽略離線角色 —— 後者會改掉現場真正想要的行為（角色留在場上是刻意設計）。

**3. 走路預算寫死，等於在擲骰子（`未踩中`）**

原本寫死 120 圈 × 40ms＝4.8 秒，而 `MAX_SPEED` 是 190 px/s，最遠只走得了
約 912px；但藏寶點是在 1920×1080（對角線約 2200px）裡隨機挑的。
藏寶點落在對角就必然失敗。現在依起始距離估算再乘 3 倍餘裕
（繞道具、α 爬升、對齊誤差都會讓實際路徑長於直線）。

**另外**：`藏寶座標不會外洩給手機` 那條要排除 `TREASURE_FOUND` ——
本輪結束後公布座標是刻意的（見 INTERACTION-DESIGN.md「中止尋寶不公布座標，找到才公布」），
少了排除會在阿賓踩中得夠快時把**正確行為**判成外洩。

改動這一帶時請至少連跑 10 次 `npm run test:e2e` 再下結論，
單次綠燈對這種機率性失敗沒有意義。

### AppConfig 的欄位凍結在 import 當下，測試不能用 mock.patch.dict 打它

`backend/config.py` 的 `AppConfig` 是 `@dataclass(frozen=True)`，每個欄位寫成
`X: str = _get_str("X", "預設")` —— 那是 **dataclass 的 field default**，
在 class 定義（即 import config）的當下就求值完畢並凍結。

因此下面這種寫法**測不到它想測的東西**，連 `clear=True` 都救不回來：

```python
with mock.patch.dict(os.environ, {"GENERATION_MODE": ""}, clear=True):
    self.assertEqual(AppConfig().GENERATION_MODE, "full_character")  # 讀到的是 import 當下的值
```

而 `config.py` 在 import 時就 `load_dotenv()`，所以它實際釘的是
**跑測試那台機器的 `.env`**。這支測試曾因本機 `.env` 留著已退役的
`GENERATION_MODE=body_sprite` 而失敗，CI 上因為沒有 `.env`、剛好落在
預設值，所以一直是綠的 —— 「本機紅、CI 綠」是這個坑的特徵。

要驗預設值請直接測 `_get_str()`（純函式，不受凍結影響），
預設值本身是否合法則另寫一支讀原始碼的測試。兩者都在
`backend/tests/test_config.py`，拿掉任一支就會漏掉一半。

**順帶**：`GENERATION_MODE` 的預設值必須是還在線上的模式。
`body_sprite` 與 `brick_ai_texture` 已退役，`app.py` 會在付費呼叫前
直接以 `mode_retired` 拒絕 —— 預設值落在那上面，等於沒設這個環境變數的人
一啟動就全部生成失敗，而錯誤訊息只會說「此生成模式已退役」。

### HTTP 層抽在 httplayer.js，依賴用注入的不要用 import

`server/index.js` 曾經是 2032 行，一個檔案同時管靜態資源、生成服務代理、
WebSocket 生命週期與 30Hz 主迴圈。靜態服務與代理那 540 行與場域狀態完全無關，
已抽到 `server/httplayer.js`（index.js 降到 1490 行）。

**`createHttpLayer()` 的依賴是參數注入，不是 import。** 這一點是刻意的：
若 httplayer.js 反過來 `import { stage } from './index.js'`，兩個檔案就成了
循環相依，抽出來的意義也沒了 —— 它之所以能獨立測試與閱讀，正是因為
方向是單向的（index.js → httplayer.js）。

唯一與互動層的接點是 `/api/screen-capture`（大螢幕把合照底圖 POST 回來），
以 `onScreenCapture` 回呼傳入，回傳 false 代表 requestId 認不得。

**踩過的坑**：`pendingCaptures` 必須定義在 `createHttpLayer()` 呼叫之前。
它原本跟 `requestScreenCapture()` 放在檔案後段，而 `const` 沒有變數提升 ——
放在後面的話啟動當下就 ReferenceError，且因為是模組載入期，
整個伺服器根本起不來。

### frontend/ 必須維持 CommonJS

根目錄的 `package.json` 帶著 `"type": "module"`（PF2 全套是 ESM）。
Node 會據此把**所有**子目錄的 `.js` 當成 ES module —— 但 `frontend/` 是
2D 備援版的瀏覽器腳本與 `require()` 寫成的測試，整合當下就整批壞掉
（`ReferenceError: require is not defined`，CI 的 `node --test frontend/tests/` 失敗）。

`frontend/package.json` 只做一件事：把模組型別重新限定成 `commonjs`。
**不要刪除它**，也不要在 `frontend/` 底下改用 `import`／`export`。

### 閒置時角色靜止（IDLE_MOTION，預設 'still'）

沒有人操控時角色**停在原地**，不再自動漫遊。由 `server/config.js` 的
`IDLE_MOTION` 控制，可用環境變數覆寫：

```bash
PERSONAFLOW_IDLE_MOTION=wander npm start   # 改回原本的自由漫遊
```

| 值 | 行為 |
|---|---|
| `still`（預設） | 完全靜止，只播 IDLE 待機 |
| `wander` | 原始設計：Boids 三力 + 漫遊擾動 |
| `flock` | 保留三力但關掉漫遊擾動：有鄰居才動，孤身一人時停下 |

原始設計刻意讓閒置角色漫遊（`boids.js` 的 `wanderForce` 就是為此存在），
理由是「有人掛機時畫面不要死寂」；代價是參與者分不清畫面上的移動是自己
造成的還是系統自己在動。兩種取捨都成立，所以保留成參數而非寫死。

**三個踩過的坑**，測試都有回歸防護：

1. **煞停不能只靠 α 衰減。** α 要閒置滿 `IDLE_THRESHOLD_MS` 才開始衰減，
   而 `inputIntensity` 在手指離開搖桿的當下就歸零 —— 那一瞬間 α 還是 1，
   兩者相乘會讓速度從全速直接掉到 0。`wander` 模式看不出來，因為空缺由
   Boids 影子速度補上；自主項一旦歸零，缺口就直接變成畫面上的急煞。
   因此 `arbiter.js` 另外對「上一幀的實際速度」做餘弦煞停。

2. **靜止模式關掉的是「自主意圖」，不是「碰撞處理」。** 把整個自主項乘 0
   會連帶抹掉道具斥力的側向分量，而正面推向圓形道具時，位置修正只消去朝內
   的分量 —— 側向為零就沒有繞行方向，角色會卡在道具正面推不過去。
   故另備 `obstacleAvoidance()` 回傳**切向**速度，且疊加後要正規化回原速率
   （直接相加會超過 `MAX_SPEED`，也會讓煞停曲線彈回去）。

3. **影子速度仍要持續整合**，不要為了省事跳過 `integrateBoids()` ——
   否則現場把參數改回 `wander` 時，第一次交接會從一個過期的速度接手。

測試分成兩檔，因為 `IDLE_MOTION` 在模組載入時就定案，同一個行程內無法切換：
`test/idle-still.test.mjs`（預設）與 `test/wander-mode.test.mjs`
（需 `npm run test:wander`，`npm test` 已把兩輪都串起來）。

手機端的操控提示**不要寫死「放手後角色會漫遊」** —— 手機讀不到伺服器的
`IDLE_MOTION`，寫死其中一種，另一種模式下就成了假訊息。

### 場域人數上限刻意壓在 10

`MAX_AGENTS = 10`（原本 120）。這是「少而精緻」的取捨：角色數降下來之後，
每個人都負擔得起即時陰影、高解析度貼圖與後製效果，畫面質感遠勝過塞滿
一百個扁平貼紙。3D 房間、bloom、vignette 都建立在這個前提上。

**測試不要寫死角色數量**。曾有三處測試硬寫 12 / 50 個角色，上限降到 10 時
`addAgent` 開始回傳 null，整組測試以 `TypeError: Cannot set properties of null`
失敗 —— 而錯誤訊息完全看不出跟人數上限有關。需要「一群角色」時請用
`MAX_AGENTS` 當迴圈上界。

注意這是「同時在場」而非「總參與人數」：賓客關掉分頁後角色仍留在場上，
要等 `AGENT_TTL_MS`（45 秒）才回收，現場輪替速度取決於那個值。

### 前端相依一律由 node_modules 直出，不走 CDN

`nipplejs`、`roughjs`、`three` 都經由 `/vendor/*` 從本機 `node_modules` 提供
（見 `server/httplayer.js` 的 `resolveStatic`）。**不要為了省事改用 CDN。**

3D 整合初期曾把 three 指向 jsdelivr，本機開發完全正常 —— 因為開發機有網路。
但展場網路不通、或 CDN 被校園防火牆擋下時，大螢幕的整個 3D 背景會直接消失，
而這是**本機永遠測不出來的故障**。HTTPS 模式下（現場要用手機相機就必須開）
還會多一層混合內容風險。

`three/addons/` 是整棵目錄樹（OrbitControls 會再 import 同目錄的其他模組），
因此 `/vendor/three-addons/` 走的是目錄映射而非逐檔白名單，該分支自己做了
路徑穿越防護 —— 下方那套通用檢查只涵蓋 PUBLIC_DIR 與 shared，別誤以為它罩得到。

