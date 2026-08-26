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
/PersonaFlow
├── /backend
│   ├── app.py                    # 2D 備援版 Flask／Socket.io、生成併發閘門與開發 API
│   ├── service.py                # ★ 整合版角色資產生成 HTTP 服務（只綁 127.0.0.1:5055）
│   ├── slicer.py                 # ★ 生成圖正規化 + 切成 head/torso/legs 三張貼圖
│   ├── validate_cuts.py          # ★ 切片比例穩定度驗證工具
│   ├── config.py                 # 集中式環境設定（型別轉換與驗證，單一 config 物件）
│   ├── cv_module.py              # MediaPipe 人體、服裝色彩、區域與姿勢特徵
│   ├── face_module.py            # 本機臉部特徵
│   ├── vlm_module.py             # 雲端服裝、髮型與臉部語意辨識
│   ├── avatar_pipeline.py        # generate_avatar 的純資料處理（影像解碼、色表、特徵合併）
│   ├── garment_gen.py            # 完整角色生成流程與 prompt 模板
│   ├── style_registry.py         # 可擴充角色風格註冊表
│   ├── style_base.py             # 從參考圖量出的風格標準（數值化）
│   ├── style_fingerprint.py      # 風格指紋與跨角色物種漂移量測
│   ├── style_normalizer.py       # 方向性明暗量測與正規化
│   ├── style_probe.py            # 把指紋接到實際生成圖上的漂移量測
│   ├── reference_bleed.py        # 參考圖滲漏偵測
│   ├── identity_fidelity.py      # 個體特徵保真度量測
│   ├── avatar_quality.py         # 生成角色圖結構完整性驗證
│   ├── capture_quality.py        # 拍攝品質、站位與穩定度判定
│   ├── capture_session.py        # ★ 跨影格的可拍攝判定（站位引導的時序邏輯）
│   ├── detail_quality.py         # 最終畫面細節指標
│   ├── height_profiles.py        # short／medium／tall 身高校正
│   ├── swarm_logic.py            # Boids 群聚演算法（2D 備援版用；整合版走 server/boids.js）
│   ├── swarm_snapshot.py         # swarm 狀態持久化，重啟自動還原
│   ├── photo_composer.py         # 大合照合成（LEGO 排版、QR Code、中文字型後備鏈）
│   ├── bot_simulator.py          # 壓測用虛擬角色注入／移除
│   ├── circuit_breaker.py        # 外部 API 熔斷器與退避重試
│   ├── generation_history.py     # SQLite 生成紀錄、Token、成本與快速審查
│   ├── blind_review.py           # 外部結果匯入、原照縮圖與多人匿名盲評
│   ├── metrics_logger.py         # 匿名流程指標與輪替紀錄
│   ├── event_logger.py           # 結構化事件 log 落地（JSON lines，隱私遮除影像）
│   ├── analyze_log.py            # 效能指標分析（延遲／失敗率）
│   ├── report_html.py            # HTML 效能報告產生器
│   ├── stress_test.py            # 承載量壓測工具
│   ├── bench_generate.py         # 生成延遲基準線量測
│   ├── e2e_smoke.py              # 端到端煙霧測試（對真的跑起來的後端走完整流程）
│   ├── pytest.ini                # 測試設定（testpaths／pythonpath）
│   ├── /models                   # MediaPipe／分割模型資產
│   ├── /tests                    # pytest：CV、生成、規格、歷史、盲評與 Socket handler
│   └── /logs                     # 執行期資料；gitignored，不提交版本庫
│       ├── generation_history.sqlite3
│       ├── /generated            # AI attempt 與最終角色快照
│       └── /review_sources       # 經同意、去 EXIF 的評測縮圖，可批次刪除
├── /server                       # ★ 整合版互動層（Node.js）
│   ├── index.js                  # Gateway：靜態服務、WebSocket、/api/generate 代理、TLS
│   ├── arbiter.js                # α 權重仲裁與速度合成
│   ├── boids.js  state.js        # 群聚引擎與狀態矩陣
│   ├── missions.js  pairing.js  quiz.js  scores.js  socialgraph.js
│   ├── treasure.js               # ★ 尋寶（先知模式）：規則與冷熱判定
│   ├── certcheck.js              # ★ 啟動時比對憑證 SAN 與當下 LAN IP
│   └── persistence.js  scheduler.js  ratelimit.js  config.js
├── /shared                       # ★ 前後端共用的單一事實來源
│   ├── protocol.js               # 事件名、節流頻率、場域尺寸
│   ├── avatars.js                # 捏臉素材 + CV 角色驗證 + CV_CUTS 切片比例
│   ├── avatarSprite.js           # 角色圖組裝（整張圖優先，缺它才疊三張切片）
│   ├── character.js              # 角色與名牌繪製（大螢幕與控制器共用）
│   ├── capture-guidance.js       # 站位引導文案與指示燈判定
│   ├── colorFamily.js            # ★ 顏色分族（COLOR_HUNT 任務，三端共用）
│   ├── heat.js                   # ★ 尋寶冷熱等級與判定半徑（三端共用）
│   └── scene.js                  # 場景障礙物佈局
├── /public                       # ★ 整合版前端
│   ├── controller/               # 手機端：拍照生成／捏臉（備援）、搖桿、任務
│   ├── screen/                   # 大螢幕
│   │   └── 3d/RoomScene.js       # three.js 房間場景
│   ├── host/                     # 主辦端控制台
│   └── assets/gen/               # 生成貼圖落地處（gitignored，每場重新產生）
├── /frontend                     # 2D 備援版前端
│   ├── index.html                # 拍攝與生成主操作頁
│   ├── sketch.js                 # p5.js 畫面、狀態與拍攝流程（只放渲染）
│   ├── character.js              # class Character（角色資料模型）與組件繪製
│   ├── socket.js                 # Socket.io 前後端事件橋接（自動偵測 LAN）
│   ├── projection.html           # 2D sprite 群聚投影牆（PixiJS，自有格柵實作）
│   ├── dev.html                  # 生成歷史、成本、外部匯入與盲評操作台
│   ├── package.json              # 只做一件事：把此目錄標回 CommonJS（見下方注意事項）
│   ├── /themes
│   │   ├── lego.js               # LEGO 主題渲染
│   │   └── registry.js           # 前端主題註冊表
│   ├── /tests                    # Node 內建測試執行器（harness.js 提供 p5 樁）
│   └── wedding_bg.png            # 投影背景素材
├── /test                         # ★ 整合版 Node 單元測試（node --test）
├── /scripts
│   ├── e2e.mjs                   # ★ 端對端測試（會自行啟動伺服器）
│   ├── make-cert.sh              # ★ 現場用 TLS 憑證產生
│   ├── scene-preview.mjs         # ★ 場景離線預覽
│   └── ...                       # 參考圖集與髮色取樣的離線檢查工具
├── /docs
│   ├── INTERFACES.md             # Socket.io 事件與 payload 介面規格
│   ├── STYLE_BASE.md             # 基底風格標準與量測方法
│   ├── STYLE_PROBE_FOLLOWUPS.md  # 已知但刻意延後的量測與管線細節
│   ├── TECHNICAL_ARCHITECTURE.md # 技術架構文件
│   ├── TECH-PersonaFlow2.md      # ★ 整合版互動層技術說明
│   ├── README-PersonaFlow2.md    # ★ 整合版說明
│   ├── PRD.md                    # 產品需求與驗收定義（驗收條件仍寫在已退役模式上，待重寫）
│   ├── TechStack.md              # 技術選型
│   ├── /m3                       # M3 交接說明與效能報告
│   └── /style_reference          # 風格參考圖集（含圖檔，見 PROVENANCE.md）
├── /.github/workflows/ci.yml     # CI：前端 Node 測試＋整合版 npm test＋後端 pytest
├── package.json                  # ★ 整合版 Node 相依與指令
├── start.sh                      # 2D 備援版一鍵啟動腳本（macOS／Linux）
├── CLAUDE.md                     # 本檔：專案結構、規範與啟動方式
├── README.md                     # 安裝、設定、流程與使用說明
├── .env.example                  # 環境變數範本
├── requirements.txt              # Python 執行相依（mediapipe 已釘 <1.0）
└── requirements-dev.txt          # 測試相依（pytest）
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
                                   # 偵測到 certs/ 就自動走 HTTPS（相機需要），
                                   # 沒有憑證則以 HTTP 啟動並說明代價

# 或分別啟動（除錯時比較好看 log）
npm start                          # 互動層，印出大螢幕/手機/主辦端三個網址
python backend/service.py          # 角色生成服務（127.0.0.1:5055）

# 現場要用手機相機就必須有 HTTPS（getUserMedia 的硬性要求）
bash scripts/make-cert.sh
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start

# 後端啟動
python backend/app.py

# 前端啟動（在專案根目錄執行）
python -m http.server 8000 --directory frontend

# 後端測試
pip install -r requirements-dev.txt
python -m pytest backend/tests

# 測試
npm test                           # Node 單元測試（294 + wander 模式 5）
npm run test:wander                # 只跑漫遊模式那一組（PERSONAFLOW_IDLE_MOTION=wander）
npm run test:e2e                   # 端對端，會自行啟動伺服器（116）
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

### 風格的四樣東西必須成套

一個生成風格由四件事構成，全部掛在 `style_registry.GenerationStyle` 上：
prompt 模板、negative、姿勢參考圖（`pose_builder`）、策展參考圖集（`reference_set`）。

**任兩個風格共用其中任何一項，都不會報錯。** 參考圖集在 prompt 裡被明文宣告為
「工藝的最高權威」（`_ROLE_STYLE`），所以拿樂高的 sheet 配皮克斯的 prompt，
模型只會自己選一邊 —— 現場看起來像模型不穩，不像配錯檔案。姿勢參考同理：
樂高那張畫的是梯形軀幹加爪手，餵給皮克斯會把玩具比例一起帶進去。

`STYLE_REFERENCE_SET` 現在是**全域覆寫**而非主要來源。設了它就會把所有風格
壓到同一組圖，也就是上面那個錯誤配對。平常留空；被覆寫的風格會出現在
生成服務 `/health` 的 `degraded` 裡。`backend/tests/test_style_registry.py`
擋住共用，並檢查每個風格指名的圖集在磁碟上真的存在。

### VLM 預設關閉，而且模型名不可寫死

服裝／臉部的 Gemini 呼叫由 `FULL_MODE_VLM_ENABLED` 控制，**預設關閉**，
`service.py`（整合版）與 `app.py`（2D 備援）都讀同一個 `config` 欄位。

關閉是因為生圖模型本來就收到原始照片，這兩次呼叫是重複的視覺分析；
而 Gemini 免費方案是**每個模型每天 20 次請求**，一位參與者吃掉 2 次 ——
開著的話一天只夠 10 個人，第 11 個人開始靜默退回純 CV 顏色。

兩個踩過的坑：

1. **模型名不可寫死。** `gemini-2.0-flash` 曾寫死在 `vlm_module.py` 兩處，
   Google 讓它退役後兩支都回 404，VLM 全數失敗 —— 但**生成照樣成功**，
   只是 prompt 裡的髮色／髮型／眼睛／鬍子／服裝款式欄位默默全空。
   錢照付、東西拿不到，畫面上完全看不出來。現在走 `config.VLM_MODEL`，
   且模型物件在**呼叫當下**才建立（存成模組常數等於凍結在 import 當下）。

2. **測試必須把 VLM 也 stub 掉，不只生圖。** `test_service.py` 的 fixture
   原本只替換 `generate_full_character_png`，於是每個 `/generate` 測試都對
   Gemini 發兩次真實請求。長期沒被發現是因為那個模型已退役、秒回 404，
   看起來只像「有點慢」；模型修好之後整個套件從 20 秒變成 86 秒，
   而且每跑一次測試就付一次錢，還會吃掉當天的配額。

`/health` 會回報 `vlm_enabled` 與 `vlm_model` —— 「關著」與「開著卻一直失敗」
在現場長得一模一樣（兩者都是 prompt 少掉語意欄位），不報出來分不出來。

### style_registry 只能有一份（雙重匯入路徑的陷阱）

`backend/` 底下同時存在兩種匯入寫法：`from backend.style_registry import ...`
（garment_gen 用）與 `from style_registry import ...`（service.py 用，因為它以
`python backend/service.py` 啟動，`sys.path[0]` 就是 `backend/`）。

兩條路徑**都成立**的時候（pytest、或任何把專案根目錄放進 `sys.path` 的環境），
Python 會建立**兩個獨立的模組物件**，各自帶一份空的 `_STYLES` ——
garment_gen 把風格註冊進其中一份，service.py 從另一份查詢，查到的永遠是空的。

後果全程無聲：沒有例外、沒有 log、`/health` 的 `degraded` 也是空的，
只是每一個請求都靜默退回預設風格。症狀是「選了皮克斯卻生出樂高」，
看起來像模型的問題。

`style_registry.py` 檔尾用 `sys.modules.setdefault()` 把兩個名字釘成同一個
模組物件來根除它。**不要刪掉那幾行**，也不要因為「看起來像多餘的魔法」而
改寫成一般的 import。`backend/tests/test_style_registry.py` 的
`SingleRegistryInstanceTests` 有回歸防護（拿掉那幾行會有兩個測試立刻失敗）。

任何**持有可變全域狀態**的模組都有同樣的問題；純函式模組則無所謂。

### 參與者選的風格是 per-request，不是活動層級

`CHARACTER_STYLE` 從「一場活動一種風格」降級成「參與者沒選時的預設」。
手機端的選單由 `/api/styles` 餵資料（Gateway 轉問生成服務的 `/health`），
**不要在前端寫死風格清單** —— 某個風格的參考圖集沒放進去時，後端會據實回報，
寫死的話選項照樣出現，選了卻靜默退回預設，參與者只會覺得按鈕沒作用。

`resolve_style_id()` 對認不得的字串一律退回預設而不是報錯（現場原則：掃描
失敗一律降級，不擋人進場），因此 `/generate` 的回應帶 `styleId` 說明實際採用
的是哪一個 —— 沒有這個欄位就看不出退回發生過。

### 貼圖走 URL，不走 base64

30 人的貼圖若內嵌進 `STAGE_ROSTER`，名冊訊息會膨脹到現場無線網路難以負荷。
`roster()` 只在名冊變動時廣播，`snapshot()` 每幀 30Hz 只送座標 —— 這個分離要維持。

### 渲染程式碼放 shared/，兩端 import 同一份

`shared/character.js`（程式化步態）與 `shared/avatarSprite.js`（貼圖組裝）
同時被大螢幕與手機端 POV 畫布使用。**不要為了方便在手機端另抄一份。**

抄一份之後 `BOB_OMEGA` 之類的常數就成了第二份事實來源 —— 改了一邊另一邊
不會報錯，只會默默走出不同步頻，或讓「手機上的我」與「大螢幕上的我」長得不一樣。
與上面的切片比例是同一類跨檔案耦合。`EMOTE_GLYPH` 因為同樣理由放在 `shared/protocol.js`。

### CLIENT_SYNC / CLIENT_ROSTER：手機端個人視角

手機除了送搖桿輸入，也會收到自己的座標與半徑內的鄰居（相對座標），
供 `public/controller/avatarRenderer.js` 繪製個人視角畫布。

**兩個容易改壞的地方**，端對端測試都有回歸防護：

1. 推送必須放在主迴圈 `screens.size === 0` 早退**之前**。放在後面的話，
   大螢幕沒接上時所有手機畫面會整個凍結 —— 而「先開手機、投影機還沒接」
   正是佈場時最常見的狀態。
2. 節流比較要帶半個 tick 的容差（`>= CLIENT_SYNC_MS - TICK_MS / 2`）。
   主迴圈是 30Hz（33.3ms），若頻率不整除 tick，嚴格比較會讓某些格子
   差零點幾毫秒被擋下，實際頻率掉一整格（10Hz 曾因此實測只有 7.5Hz）。
   **選頻率時優先取能整除 30 的值**（15、10、6…），15Hz 實測抖動只有 ±1ms。

### 「找到自己」是這件作品的前提

參與者在手機上完成捏臉／生成後會抬頭找自己，而十個角色散在 1920×1080
上並不好認。認不出來的話，「這是我」的連結就建立不起來 ——
而整件作品正是建立在那個連結上。

因此 `screen.js` 對新進場者標記 `arrivals`，在頭頂畫 6 秒的下指箭頭。

**首次收到名冊時刻意不標記**：大螢幕中途重開時場上可能已有十個人，
全部一起閃會變成一片光暈，反而誰都認不出。`rosterSeenOnce` 就為此存在，
`test/screen-arrivals.test.mjs` 有回歸防護。

### 操控狀態一律以伺服器的 α 為準

`#agency` 的提示曾用本地計時器（距上次推桿是否 < IDLE_THRESHOLD_MS）猜控制權。
但 `CLIENT_SYNC` 已經帶著伺服器仲裁的真實 α，本地計時器只該在
「尚未收到同步」時當備援。

兩者不一致最明顯的情境是**拍大合照**：伺服器鎖定場域收回控制權
（`mode: STAGED`），本地計時器卻仍顯示「你正在操控」——
使用者猛推搖桿沒反應，會以為自己的手機壞了。現在該模式下會明說
「正在拍大合照，請看大螢幕」。

### 操控延遲的組成

實測「推桿 → CLIENT_SYNC 回報速度改變」中位 **9 ms**（p95 21 ms）。
三個來源與各自的改善手段：

| 來源 | 原本 | 現在 | 手段 |
|---|---|---|---|
| 手機 20Hz 節流 | 平均 25 ms | ~0 ms | 按下的**第一幀立即送出**，不等計時器 |
| 伺服器 30Hz tick | 平均 17 ms | 不變 | 提高會等比增加所有廣播成本 |
| CLIENT_SYNC 週期 | 平均 50 ms | 33 ms | 10Hz → 15Hz |

第一幀立即送出只多了「每次觸碰一則封包」，連續推桿仍走節流，頻寬幾乎不變。
**不要為了再快而拿掉節流** —— 連續推桿時 nipplejs 的 move 事件遠密於 20Hz，
全部送出會讓現場無線網路吃不消。

α 爬升（`ALPHA_RAMP_UP_MS = 300`）不算在上表：它是刻意的「接手要柔和」設計，
不是延遲。調小會讓操控變得神經質，且與放手時的餘弦煞停不對稱。

名字走 `CLIENT_ROSTER`（只在成員變動時送）而不是塞進每個鄰居 ——
名字是靜態資料，隨 15Hz 的座標重送等於每秒多耗 25 KB 的重複字串。
這與「貼圖走 URL，不走 base64」是同一組取捨。

**第三個坑（已踩過）**：名冊的重送條件**不能**沿用 `stage.rosterDirty`。
那個旗標要等主迴圈的大螢幕區段才清除，而該段在 `screens.size === 0`
早退之後 —— 沒有大螢幕連線時它永遠是 true，名冊會變成 30Hz 廣播
（實測 2 秒送出 60 次）。改為比對名冊內容指紋，與大螢幕的清除時機脫鉤。
指紋要涵蓋名字而不只是人數，否則改名不會觸發重送。

這個故障端對端測試抓不到（`scripts/e2e.mjs` 全程接著大螢幕），
由 `test/client-roster.test.mjs` 直接對節流條件把關。

手機端**不自行模擬位置**，這與 issue #8（投影牆跑自己的 Boids）刻意相反：
本地模擬會讓使用者低頭看到自己穿牆、抬頭卻看見角色卡在牆邊。
伺服器狀態過期時收斂到靜止，不以最後速度外推（否則角色會飄出場外）。

### 生成的 25 秒幾乎全在生圖 API，不是本機算不動

實測一次完整生成的耗時分布（M2 筆電）：

| 階段 | 耗時 | 佔比 |
|---|---|---|
| 影像解碼 | 2 ms | — |
| MediaPipe 服裝/骨架 | 199 ms | 0.9% |
| MediaPipe 臉部 | 20 ms | 0.1% |
| Gemini 服裝語意 | 367 ms | 1.6% |
| Gemini 臉部語意 | 237 ms | 1.0% |
| **生圖 API** | **22,372 ms** | **96%** |
| 切片+存檔 | 84 ms | 0.4% |

**換更快的電腦不會有任何幫助** —— 96% 是在等 OpenRouter 的
`gemini-3-pro-image-preview` 回話。要縮短只有兩條路：換更快的模型，
或改變動線（讓人先用捏臉進場，生成好再換貼圖）。

併發已經處理過了：`service.py` 的 `ThreadPoolExecutor(max_workers=16)`，
每個請求佔 4 個 slot，因此約 4 人可同時生成而不互相排隊。

### 現場連線：手機必須與電腦同一個區網

`192.168.x.x` 是私有位址，手機用行動網路或別的 Wi-Fi 都連不到 ——
不是「連不上」，是那個位址在外面根本不存在。啟動訊息已經會提醒這件事。

校園網路的三個坑，都要**在展場那個實際房間**測過才算數：

1. **AP 隔離（Client Isolation）**：公用 Wi-Fi 常開此設定防止裝置互連。
   開了之後即使同一個 SSID，手機與筆電也完全看不到彼此。最惡毒的一個，
   因為「看起來明明同一個網路」。
2. **不同 SSID 走不同子網**：學生網與訪客網可能完全隔開。
3. **DHCP 讓 IP 亂跳**：見下一節。

要繞開全部三個，最省事的是**自備一台路由器**開自己的 Wi-Fi。
本專案的前端相依全部走 `node_modules`（見「前端相依一律由 node_modules 直出」），
因此區網不通外網也能完整運作。只有生成服務呼叫外部 API 時才需要上游網路。

### 憑證與 IP 綁死，DHCP 換號就失效

`scripts/make-cert.sh` 按「產生當下的 LAN IP」簽發憑證。而 IP 多半是 DHCP
配發的 —— 筆電重連 Wi-Fi 或隔天再開機就可能換號（本專案開發期間就實際發生過，
`.104` → `.111`）。

憑證一旦與實際位址不符，**服務照常啟動、位址看起來也正常**，
只有手機端會多跳一個「網域不符」錯誤，而那個訊息完全不提 IP。
現場只會看到「手機掃不進來」。

因此 `server/certcheck.js` 在啟動時比對憑證 SAN 與當下的 LAN IP，
不符就大聲警告。**只警告、不阻擋啟動** —— 憑證不符仍可使用（點過警告即可），
展演進行中「能跑但有警告」永遠優於「直接不給啟動」。

換過網路之後重跑 `bash scripts/make-cert.sh` 即可。

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

### 互動遊戲的判準：這個機制需不需要開口講話

這件作品要的不只是「參與者操控角色」，而是**操控角色的人彼此開始交流**。
因此新增任何玩法之前先問一句：**通關路徑上有沒有一步必須跟另一個人講話？**

沒有的話，再好玩都會讓現場更安靜。`server/pairing.js` 開頭那句註解
（「這個索取動作本身就是破冰」）就是整個判準的原型 —— 配對碼的作用
不是驗證，是把「搭訕」這個社交難題降級成「請問你的號碼幾號」這個任務難題。

**普通尋寶是反例，已經評估後否決。** 每個人都看得到冷熱提示的話，
從看提示到找到的每一步都不需要另一個人，而且找到後告訴別人對自己
是純損失 —— 它主動獎勵「不講話」。實際畫面會是十個人低頭各走各的。

#### 尋寶：先知模式（`server/treasure.js`）

改成資訊不對稱之後才成立：

| | 看得到冷熱 | 能得分 |
|---|---|---|
| 先知（一人） | ✅ | ❌ |
| 其他人 | ❌ | ✅ |

先知只能用喊的把隊伍導過去。講話從「可有可無」變成唯一的通關路徑，
而先知沒有藏私的誘因。**三個不能動的地方**（測試都有回歸防護）：

1. **`publicView()` 絕不能含座標。** 手機只要拿得到座標，開發者工具
   就能直接看到答案，而現場一定有人會這麼做。大螢幕與主辦端另外收到
   座標是刻意的 —— 它們是公開畫面，不在參與者手上。
   `scripts/e2e.mjs` 直接檢查手機收到的原始封包字串。
2. **先知踩上去不算找到，且得 0 分。** 先知一旦能得分，就有動機自己
   走過去而不是喊出來，整個設計就垮了。
3. **冷熱回報的是「最近的非先知角色」的距離**，不是先知自己的。
   回報他自己的距離會讓他本能地往寶藏走，而那對隊伍毫無幫助。

冷熱推播與踩中判定放在主迴圈的 `screens.size === 0` 早退**之前**，
理由與 CLIENT_SYNC 完全相同（投影機還沒接上時整場尋寶不能沒有反應）。
冷熱只在**等級變動**時推送，不是每幀 —— 先知要的是「變熱了」這個事件。

#### COLOR_HUNT：找特定顏色的人配對

驗證模型與 PAIRING 相同（雙方確認），只多一道顏色條件，因此
`server/index.js` 的 `PAIR_MISSION_TYPES` 把兩者一起放行。
它逼人抬頭看**真實的人**而不是看螢幕，正好破解「大家盯著手機」的問題；
而角色顏色本來就取樣自真實服裝，條件天然成立，不必另建資料。

**顏色判定的三個坑**：

1. **不能沿用調色盤白名單。** CV 角色的顏色取樣自真實照片，無法事先
   列舉（與 `avatars.js` 的 `HEX_RE` 是同一個理由），因此走 HSL 色相分族。
2. **無彩色必須在色相之前攔截。** 飽和度為 0 時 hue 恆為 0，
   純以色相判定會把白襯衫全判成紅色。
3. **飽和度門檻不能設太高。** 調色盤裡的鼠尾草綠 `#84A98C` 飽和度只有
   0.18，門檻設在 0.18 會讓它被判成「黑白灰」—— 而它在畫面上明顯是綠的。
   「看起來有顏色卻被判無彩色」是最難跟現場參與者解釋的失敗。現值 0.12。

顏色不符在**提交碼那一步就擋下**，不等對方確認：讓 A 白等 30 秒才被
告知「他不是紅色的」很差，而且會佔用雙方的 pending 名額。為此
`pairing.js` 多了唯讀的 `peekTarget()` —— 它**刻意不碰 `lastClaimAt`**，
否則顏色不符會白白吃掉冷卻，使用者馬上改找正確的人時會被擋下。

#### 尋寶會卡死的兩種情況（已由伺服器自己收拾）

賓客關掉分頁後角色仍留在場上 45 秒（`AGENT_TTL_MS`）才回收，
一場活動下來必然發生好幾次，因此下面兩種都不是假設：

| 情況 | 後果 |
|---|---|
| 先知離場 | 冷熱照算但沒有人收得到，其他人只能亂走 |
| 除了先知沒有別人 | 先知不能撿，沒有人結束得了 |

`treasure.viability()` 每幀檢查，不成立就自動中止並廣播原因。
**不能在主迴圈裡 `return`** —— 下面還有大螢幕的整段廣播，提早跳出會讓
投影畫面停一幀。用旗標往下讓它自然跳過。

還有兩處「補送」容易漏：中途進場與**斷線重連**走的是不同分支
（重連那段會提前 `return`），兩邊都要呼叫 `sendTreasureCatchUp()`。
先知重連時還要 `resendHeat()` 強制重送 —— 否則要等冷熱**等級變動**
才收得到，隊伍停在原地時可以是好幾十秒，而他正是所有人等著聽的那個人。

#### 顏色預檢不可成為枚舉管道

`peekTarget()` 刻意不含冷卻（顏色不符時不該罰正當使用者），
但呼叫端**必須自己把關**：4 位碼只有 10000 組，沒有冷卻就能在
幾毫秒內試完（實測 15ms）。若「顏色不符」直接 return 而不記冷卻，
攻擊者可從 `COLOR_MISMATCH` ↔ `NOT_FOUND` 的差異反推有效碼，
等於繞過 `claim()` 的整套防枚舉。規則是**只有真的顏色不符才免計冷卻**。

#### 大螢幕的寶箱要跟著透視縮放

`toScreen()` 是 3D 透視投影，但尺寸不能用 2D 的 `scale` ——
那會讓房間深處的寶箱畫得跟最前方一樣大，就是「貼紙浮在畫面上」。
要走 `roomScene.scaleAt()`，與角色的 `characterHeightAt()` 同一條路徑。

#### CSS 類名撞名：主辦端的 .swatch 已經有人在用

`.swatch` 同時被三個地方使用：名冊縮圖（`avatarThumb`）、生成歷史縮圖
（`historyThumb`）、以及 COLOR_HUNT 的顏色選單。前兩者是既有的，
因此顏色選單改用 `.color-swatch`。

共用會讓名冊與歷史的縮圖被套上 flex 版面與 `::before` 色塊而變形 ——
**與控制器 `.bar` 撞名（頂端狀態列 vs 生成進度條）是同一類問題**，
那次的症狀是頭像／名字／積分／離開鍵被壓扁裁切。

這類 bug 不會有任何錯誤訊息，只會在某個頁面上默默壞掉。在共用的
樣式檔裡加通用類名之前，先 grep 一次那個名字。

#### 兩者的共用常數都在 shared/

`shared/colorFamily.js`（色族）與 `shared/heat.js`（冷熱等級 + 判定半徑）
被伺服器、大螢幕、手機三端共用，理由與 `EMOTE_GLYPH`、`QUIZ_CHOICES`
完全相同。特別是 `TREASURE_RADIUS`：伺服器據此判定「踩到了」、大螢幕
據此畫出光圈，兩邊各存一份會出現「畫面上明明踩進圈裡卻沒有反應」，
而參與者只會覺得系統壞了。`server/config.js` 直接再匯出，不另行定義。

### 掃描失敗一律降級，不擋人進場

相機權限被拒、非安全情境、生成失敗、生成服務未啟動 —— 全部退回捏臉流程。
捏臉是刻意保留的備援路徑，**不要移除**。

## 本機預覽：開啟與關閉

### 整合版（主線）

先照上方「常用指令 → 整合版（主線）」啟動兩個服務（`npm start` +
`python backend/service.py`，或 `bash start.sh` 一次帶起），服務就緒後開啟
三個角色各自的頁面：

```powershell
# 大螢幕
Start-Process 'http://localhost:3000/screen/'

# 手機控制（現場請改用終端機印出的區網 IP，例如 http://192.168.x.x:3000/controller/）
Start-Process 'http://localhost:3000/controller/'

# 主辦端控制台（需要終端機印出的通行密鑰）
Start-Process 'http://localhost:3000/host/'

# 生成服務健康檢查
Start-Process 'http://127.0.0.1:5055/health'
```

要關閉服務，回到執行 `npm start` 與 `python backend/service.py` 的終端機按
`Ctrl+C`。若終端機已關閉或行程卡住，可在新的 PowerShell 視窗查詢並停止：

```powershell
# 查詢目前監聽 3000（互動層）與 5055（生成服務）的程序
Get-NetTCPConnection -LocalPort 3000,5055 -State Listen |
  Select-Object LocalPort, OwningProcess

# 停止指定程序；將 <PID> 換成上方的 OwningProcess 數字
Stop-Process -Id <PID>
```

### 2D 備援版

以下是 2D 備援版（`backend/app.py` + `frontend/`）的本機操作，埠與整合版不同
（備援 5001／8000，整合版 3000／5055），可並存。

請在專案根目錄 `PersonaFlow` 開啟兩個終端機視窗，各自執行一個服務：

```powershell
# 終端機 A：後端（Socket.io / API）
python backend/app.py

# 終端機 B：前端靜態網站
python -m http.server 8000 --directory frontend
```

服務啟動後，可在終端機直接開啟頁面：

```powershell
# 主操作頁
Start-Process 'http://127.0.0.1:8000/index.html'

# 投影頁
Start-Process 'http://127.0.0.1:8000/projection.html'

# 開發端生成歷史／Token／成本
Start-Process 'http://127.0.0.1:8000/dev.html'

# 後端健康檢查
Start-Process 'http://127.0.0.1:5001/health'
```

要關閉服務時，回到各自正在執行服務的終端機並按 `Ctrl+C`。若終端機已關閉或服務卡住，可在新的 PowerShell 視窗查詢並停止對應連接埠：

```powershell
# 查詢目前監聽 5001（後端）與 8000（前端）的程序
Get-NetTCPConnection -LocalPort 5001,8000 -State Listen |
  Select-Object LocalPort, OwningProcess

# 停止指定程序；將 <PID> 換成上方的 OwningProcess 數字
Stop-Process -Id <PID>
```
