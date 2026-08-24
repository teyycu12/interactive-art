# 數位轉譯角色空間互動系統 - Claude Code 專案說明

## 專案概述
將實體穿著透過視覺識別技術數位化，轉譯為插畫角色，並在公共空間中透過群體演算法生成集體共創視覺圖。

**本專案已與 PersonaFlow2（Node.js 互動層）整合**，合成單一展場作品。
依 v4.0 計畫書決議：**PF2 為主幹**，本專案的 CV/VLM/生圖管線退為角色資產生成服務。

**校內實測期限：2026/9/30**

### 兩套系統並存，不要混淆

| | 整合版（主線） | 2D 備援（保留，不要刪） |
|---|---|---|
| 互動層 | `server/`（Node.js + ws） | `backend/app.py`（Flask + Socket.io） |
| 前端 | `public/`（controller / screen / host） | `frontend/`（p5.js + PixiJS） |
| 群聚 | `server/` 的 M2 α 仲裁 + Boids | `backend/swarm_logic.py` |
| 啟動 | `bash start.sh` | `bash start-2d.sh` |

備援版是「3D 若來不及，仍能完成實測」的保險，整套測試都還在跑，**請勿刪除**。

---

## 技術架構

| 層級 | 技術 | 職責 |
|------|------|------|
| 感知層 | Python + MediaPipe / OpenCV | 服裝色調、輪廓、姿勢提取 |
| 生成層 | Python + Gemini / 生圖 API | 去背人偶圖生成、切片成三張貼圖 |
| 互動層 | Node.js + ws | α 仲裁共治、任務、配對、問答、計分、社交圖譜 |
| 渲染層 | Three.js 3D 場景 + Canvas2D 角色圖層 | 角色與場景呈現 |
| 輸出層 | Python + Pillow | 大合照生成、QR Code |

---

## 目錄結構
```
/PersonaFlow
├── /backend
│   ├── app.py              # Flask 主程式、Socket 事件、生成併發閘門
│   ├── config.py           # 集中式環境設定（型別轉換與驗證，單一 config 物件）
│   ├── cv_module.py        # MediaPipe PoseLandmarker 特徵提取（網格色彩、body_poly）
│   ├── face_module.py      # MediaPipe FaceLandmarker 臉部特徵
│   ├── vlm_module.py       # Gemini VLM 服裝/臉部語意分類
│   ├── garment_gen.py      # AI 生圖入口（body_sprite / full_character / refined）
│   ├── avatar_pipeline.py  # generate_avatar 的純資料處理（影像解碼、服裝/臉部合併）
│   ├── swarm_logic.py      # Boids 群聚演算法（含邊界柔性轉向、打招呼持續）
│   ├── swarm_snapshot.py   # swarm 狀態持久化，重啟自動還原
│   ├── photo_composer.py   # M6 大合照合成（LEGO 排版、QR Code、中文字型後備鏈）
│   ├── bot_simulator.py    # 壓測用虛擬角色注入 / 移除
│   ├── circuit_breaker.py  # 外部 API 熔斷器與退避重試
│   ├── event_logger.py     # 結構化事件 log 落地（JSON lines，隱私遮除影像）
│   ├── stress_test.py      # 承載量壓測工具
│   ├── e2e_smoke.py        # 端到端煙霧測試（對真的跑起來的後端走完整流程）
│   ├── analyze_log.py      # 效能指標分析（延遲 / 失敗率）
│   ├── bench_generate.py   # 生成延遲基準線量測
│   ├── report_html.py      # HTML 效能報告產生器
│   ├── pytest.ini          # 測試設定（testpaths / pythonpath）
│   ├── service.py          # ★ 角色資產生成 HTTP 服務（整合版用，只綁 127.0.0.1）
│   ├── slicer.py           # ★ 生成圖正規化 + 切成 head/torso/legs 三張貼圖
│   ├── validate_cuts.py    # ★ 切片比例穩定度驗證工具（計畫書 §3.3 驗收項）
│   └── tests/              # 單元測試（236 個，pytest；conftest.py 提供 fixture）
├── /frontend
│   ├── index.html          # 互動端主頁
│   ├── projection.html     # 投影牆渲染（PixiJS）
│   ├── sketch.js           # p5.js 主渲染迴圈（僅渲染，不放業務邏輯）
│   ├── character.js        # class Character（角色模型）+ 組件繪製、動態換色
│   ├── socket.js           # Socket.io 前後端通訊（自動偵測 LAN）
│   └── themes/lego.js      # LEGO 樂高風格渲染
├── /server                 # ★ PF2 互動層（Node.js）
│   ├── index.js            # Gateway：靜態服務、WebSocket、/api/generate 代理、TLS
│   ├── arbiter.js          # α 權重仲裁與速度合成
│   ├── boids.js state.js   # 群聚引擎與狀態矩陣
│   ├── missions.js pairing.js quiz.js scores.js socialgraph.js
│   └── persistence.js scheduler.js ratelimit.js config.js
├── /shared                 # ★ 前後端共用的單一事實來源
│   ├── protocol.js         # 事件名、節流頻率、場域尺寸、EMOTE_GLYPH
│   ├── avatars.js          # 捏臉素材 + CV 角色驗證 + CV_CUTS 切片比例
│   ├── character.js        # ★ 程式化步態（大螢幕與手機 POV 共用）
│   ├── avatarSprite.js     # ★ 角色圖像組裝（兩端共用）
│   └── scene.js            # 場景障礙物佈局
├── /public                 # ★ 整合版前端
│   ├── controller/         # 手機端：拍照生成 / 捏臉（備援）、搖桿、任務
│   │   └── avatarRenderer.js # ★ 個人視角畫布（CLIENT_SYNC、鄰居、腳步震動）
│   ├── screen/             # 大螢幕（3D 房間背景 + 2D 角色疊加）
│   │   └── 3d/RoomScene.js # ★ Three.js 場景、燈光、透視投影 projectToScreen()
│   ├── host/               # 主辦端控制台
│   └── assets/gen/         # 生成貼圖落地處（gitignore，每場重新產生）
├── /test                   # ★ Node 單元測試（228 個，node --test）
│   ├── idle-still.test.mjs # ★ 靜止待機（預設 IDLE_MOTION）
│   └── wander-mode.test.mjs # ★ 漫遊模式，需 npm run test:wander
├── /scripts
│   ├── e2e.mjs             # ★ 端對端測試（103 項，會自行啟動伺服器）
│   ├── make-cert.sh        # ★ 現場用 TLS 憑證產生
│   └── scene-preview.mjs   # 場景離線預覽
├── /docs                   # 所有規格與設計文件（PRD、TechStack、INTERFACES、SPEC…）
├── start.sh                # ★ 整合版一鍵啟動（主線）
├── start-2d.sh             # 2D 備援版一鍵啟動
├── package.json            # ★ Node 相依與指令
├── requirements.txt        # 執行相依（mediapipe 已釘 <1.0，原因見下）
└── requirements-dev.txt    # 測試相依（pytest）
```

> ★ 為整合後新增。文件已全數移入 `docs/`，根目錄只留 README 與本檔。

---

## 核心演算法：Boids 群聚

每個角色速度向量由以下三力加權合成：
- **Separation（避障）**：遠離過近的鄰居（半徑 80px）
- **Alignment（對齊）**：匹配鄰近角色的速度方向（半徑 150px）
- **Cohesion（凝聚）**：往群體中心靠攏（半徑 200px）
- **Boundary Steering（邊界轉向）**：接近螢幕邊緣時柔性推力轉向
- **Wander（漫遊微力）**：隨機微力產生自然有機移動
- **Greeting Hold（打招呼持續）**：兩角色距離 < 80px 觸發 GREETING，持續約 1.5 秒並減速

實作位置：`backend/swarm_logic.py`，每 tick 輸出所有角色的新座標，透過 Socket.io 推送至前端。

---

## 期中審查優先功能（M1–M3；日期同上待更新）

1. **[M1] 服裝色調抓取** (`cv_module.py`)
   - 用 MediaPipe 偵測人體區域
   - 用 OpenCV 提取主色調（K-Means 或直方圖）
   - 輸出：`{ "hex": "#RRGGBB", "rgb": [R, G, B] }`

2. **[M2] 角色動態換色** (`character.js`)
   - 接收後端色碼，即時更新 p5.js 角色填色

3. **[M3] 單角色狀態機** (`character.js` + `sketch.js`)
   - 狀態：`ROAMING`（漫遊）↔ `GREETING`（打招呼）
   - 觸發條件：兩角色距離 < 閾值時切換為 GREETING

---

## 開發規範

- **Python**：函式命名用 snake_case，回傳資料統一用 JSON
- **JavaScript**：類別命名用 PascalCase（如 `Character`）
- **Socket 事件命名**：動詞_名詞格式（如 `update_positions`、`new_character`）
- **不要**在 `sketch.js` 裡寫業務邏輯，只放渲染程式碼

---

## 已知問題與注意事項

- p5.js 大量角色時注意 `draw()` 效能，角色超過 50 個考慮用 `createGraphics()` 分層
- MediaPipe 在低光源環境偵測率下降，展示時確保場地光源足夠

### ⚠️ mediapipe 必須釘在 1.0 以下

`requirements.txt` 已指定 `mediapipe>=0.10.35,<1.0`，**不要放寬這個限制**。

1.0.1 在 macOS arm64 上初始化 Metal 失敗，以 absl CHECK 直接 `abort()`
整個行程（Pose 與 FaceLandmarker 皆然）：

```
F0000 graph_service.h:139] Check failed: service_ Service is unavailable.
    @ -[DrishtiMetalHelper initWithCalculatorContext:]
```

那是 C++ 層的 abort，Python 的 `try/except` **完全攔不到** ——
展場第一個人拍照，後端連同所有已連線客戶端與投影牆一起死。
單元測試也測不到（它們不會真的載入 MediaPipe），只有 `e2e_smoke.py` 會發現。
- Socket.io 預設 polling 模式，需設定強制 WebSocket：`{ transports: ['websocket'] }`

### ⚠️ 不要改用 eventlet / gevent（實測結論）

本文件早期版本建議「Socket 用 `eventlet` 或 `gevent`，不要用預設 thread」。
**實測後確認不可行**，目前刻意維持 `async_mode="threading"`：

gevent monkey-patch 之下 MediaPipe 會直接死鎖，連 `patch_all(thread=False)`
（保留真實 OS 執行緒）也一樣：

```
gevent.exceptions.LoopExit: This operation would block forever
```

原因是 MediaPipe 的原生 C++ 執行緒與綠色執行緒排程互不相容。切換過去會讓
整個感知層停擺 —— 比 threading 模式的連線上限更糟。

**已知代價**：Werkzeug 開發伺服器 + threading 在約 50 條並行 WebSocket 連線
時會開始崩潰（伺服器 log 出現 WebSocket 幀被當成 HTTP 解析的 400 錯誤）。
目前的因應方式是**降低所需連線數**而非提高上限：角色 id 已與連線脫鉤，
賓客關掉分頁角色仍留在場上（見 docs/INTERFACES.md §4），因此同時在線數只取決於
「正在拍照的人 + 投影牆」，不隨賓客總數成長。

### ⚠️ 投影牆目前不使用後端座標

`swarm_logic.py` 的 Boids 結果會推送給 `sketch.js`，但 `projection.html`
跑的是自己的一套本地 Boids，並未採用 `char.x` / `char.y`。
開關 `USE_SERVER_POSITIONS` 預設關閉，開啟前需在真實場館網路量測廣播抖動。
詳見 GitHub issue #8。

---

## 常用指令

### 整合版（主線）

```bash
# 一次安裝
npm install
pip install -r requirements.txt requirements-dev.txt   # mediapipe 已釘 <1.0，見下方

# 啟動：一行帶起兩個行程
bash start.sh                      # 生成服務 :5055 + 互動層 :3000

# 或分別啟動（除錯時比較好看 log）
npm start                          # 互動層，印出大螢幕/手機/主辦端三個網址
python backend/service.py          # 角色生成服務（127.0.0.1:5055）

# 現場要用手機相機就必須有 HTTPS（getUserMedia 的硬性要求）
bash scripts/make-cert.sh
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start

# 測試
npm test                           # Node 單元測試（228 + wander 模式 5）
npm run test:wander                # 只跑漫遊模式那一組（PERSONAFLOW_IDLE_MOTION=wander）
npm run test:e2e                   # 端對端，會自行啟動伺服器（103）
pytest backend/                    # Python（236）

# 切片比例驗證（計畫書 §3.3 的 R1 驗收項）
python backend/validate_cuts.py --sprites samples/ --sheet report.png
python backend/validate_cuts.py --photos photos/ --out samples/
```

### 2D 備援版

```bash
bash start-2d.sh                   # 後端 5001 + 前端 8080
python backend/e2e_smoke.py        # 煙霧測試（需後端已啟動）
node --test frontend/tests/        # 前端測試
```

> **埠號**：備援版後端佔用 5001，生成服務刻意改用 5055，兩者可並存。

---

## 整合後的注意事項

### 切片比例是跨語言耦合

`backend/slicer.py` 的 `CUTS` 與 `shared/avatars.js` 的 `CV_CUTS` 必須完全一致 ——
一邊照比例切、一邊照比例疊回去。對不上時角色會脖子錯位或腿被壓扁，
**而且兩邊都不會報錯**。`backend/tests/test_slicer.py` 有測試直接比對兩邊數值。

### 貼圖走 URL，不走 base64

30 人的貼圖若內嵌進 `STAGE_ROSTER`，名冊訊息會膨脹到現場無線網路難以負荷。
`roster()` 只在名冊變動時廣播，`snapshot()` 每幀 30Hz 只送座標 —— 這個分離要維持。

### 渲染程式碼放 shared/，兩端 import 同一份

`shared/character.js`（程式化步態）與 `shared/avatarSprite.js`（貼圖組裝）
同時被大螢幕與手機端 POV 畫布使用。**不要為了方便在手機端另抄一份。**

抄一份之後 `BOB_OMEGA` 之類的常數就成了第二份事實來源 —— 改了一邊另一邊
不會報錯，只會默默走出不同步頻，或讓「手機上的我」與「大螢幕上的我」長得不一樣。
與上面的切片比例是同一類跨檔案耦合。`EMOTE_GLYPH` 因為同樣理由放在 `shared/protocol.js`。

### CLIENT_SYNC：手機端個人視角（10Hz）

手機除了送搖桿輸入，也會收到自己的座標與半徑內的鄰居（相對座標），
供 `public/controller/avatarRenderer.js` 繪製個人視角畫布。

**兩個容易改壞的地方**，端對端測試都有回歸防護：

1. 推送必須放在主迴圈 `screens.size === 0` 早退**之前**。放在後面的話，
   大螢幕沒接上時所有手機畫面會整個凍結 —— 而「先開手機、投影機還沒接」
   正是佈場時最常見的狀態。
2. 節流比較要帶半個 tick 的容差（`>= CLIENT_SYNC_MS - TICK_MS / 2`）。
   主迴圈是 30Hz（33.3ms），嚴格的 `>= 100` 會讓第 3 個 tick 差 0.1ms 被擋下，
   實際變成每 4 個 tick 送一次 —— 7.5Hz 而非 10Hz。

手機端**不自行模擬位置**，這與 issue #8（投影牆跑自己的 Boids）刻意相反：
本地模擬會讓使用者低頭看到自己穿牆、抬頭卻看見角色卡在牆邊。
伺服器狀態過期時收斂到靜止，不以最後速度外推（否則角色會飄出場外）。

### navigator.vibrate 在 iOS 完全不支援

不是降級，是沒有。震動只能是加分項，不能是任何互動的唯一回饋 ——
每個震動點都另有畫面上的變化。腳步震動預設**關閉**並附開關：
走路時每秒約 2–3 次的持續震動，對電池與體感疲勞都有實際代價。
不支援的裝置上開關直接隱藏，而不是給一個按了沒反應的按鈕。

### 連線角色不可中途轉換

`CLIENT_JOIN` / `SCREEN_HELLO` / `HOST_AUTH` 三者互斥，已在 `server/index.js`
加上守衛。拿掉任何一個都會讓 agent 的 `disconnectedAt` 永遠是 null，
`AGENT_TTL` 不回收，反覆操作即可耗盡 `MAX_AGENTS` 上限。端對端測試有回歸防護。

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
（見 `server/index.js` 的 `resolveStatic`）。**不要為了省事改用 CDN。**

3D 整合初期曾把 three 指向 jsdelivr，本機開發完全正常 —— 因為開發機有網路。
但展場網路不通、或 CDN 被校園防火牆擋下時，大螢幕的整個 3D 背景會直接消失，
而這是**本機永遠測不出來的故障**。HTTPS 模式下（現場要用手機相機就必須開）
還會多一層混合內容風險。

`three/addons/` 是整棵目錄樹（OrbitControls 會再 import 同目錄的其他模組），
因此 `/vendor/three-addons/` 走的是目錄映射而非逐檔白名單，該分支自己做了
路徑穿越防護 —— 下方那套通用檢查只涵蓋 PUBLIC_DIR 與 shared，別誤以為它罩得到。

### 掃描失敗一律降級，不擋人進場

相機權限被拒、非安全情境、生成失敗、生成服務未啟動 —— 全部退回捏臉流程。
捏臉是刻意保留的備援路徑，**不要移除**。
