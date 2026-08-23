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
| 啟動 | `npm start` + `python backend/service.py` | `bash start.sh` |

備援版是「3D 若來不及，仍能完成實測」的保險，整套測試都還在跑，**請勿刪除**。

---

## 技術架構

| 層級 | 技術 | 職責 |
|------|------|------|
| 感知層 | Python + MediaPipe / OpenCV | 服裝色調、輪廓、姿勢提取 |
| 生成層 | Python + Gemini / 生圖 API | 去背人偶圖生成、切片成三張貼圖 |
| 互動層 | Node.js + ws | α 仲裁共治、任務、配對、問答、計分、社交圖譜 |
| 渲染層 | Canvas2D（3D/Three.js 為進行中的重寫） | 角色與場景呈現 |
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
│   └── tests/              # 單元測試（170 個，pytest；conftest.py 提供 fixture）
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
│   ├── protocol.js         # 事件名、節流頻率、場域尺寸
│   ├── avatars.js          # 捏臉素材 + CV 角色驗證 + CV_CUTS 切片比例
│   └── scene.js            # 場景障礙物佈局
├── /public                 # ★ 整合版前端
│   ├── controller/         # 手機端：拍照生成 / 捏臉（備援）、搖桿、任務
│   ├── screen/             # 大螢幕
│   ├── host/               # 主辦端控制台
│   └── assets/gen/         # 生成貼圖落地處（gitignore，每場重新產生）
├── /test                   # ★ Node 單元測試（188 個，node --test）
├── /scripts
│   ├── e2e.mjs             # ★ 端對端測試（87 項，會自行啟動伺服器）
│   ├── make-cert.sh        # ★ 現場用 TLS 憑證產生
│   └── scene-preview.mjs   # 場景離線預覽
├── /docs                   # 所有規格與設計文件（PRD、TechStack、INTERFACES、SPEC…）
├── start.sh                # 2D 備援版一鍵啟動
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

# 啟動：兩個行程
npm start                          # 互動層，印出大螢幕/手機/主辦端三個網址
python backend/service.py          # 角色生成服務（127.0.0.1:5055）

# 現場要用手機相機就必須有 HTTPS（getUserMedia 的硬性要求）
bash scripts/make-cert.sh
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start

# 測試
npm test                           # Node 單元測試（188）
npm run test:e2e                   # 端對端，會自行啟動伺服器（87）
cd backend && pytest tests/        # Python（170）

# 切片比例驗證（計畫書 §3.3 的 R1 驗收項）
python backend/validate_cuts.py --sprites samples/ --sheet report.png
python backend/validate_cuts.py --photos photos/ --out samples/
```

### 2D 備援版

```bash
bash start.sh                      # 後端 5001 + 前端 8080
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

### 連線角色不可中途轉換

`CLIENT_JOIN` / `SCREEN_HELLO` / `HOST_AUTH` 三者互斥，已在 `server/index.js`
加上守衛。拿掉任何一個都會讓 agent 的 `disconnectedAt` 永遠是 null，
`AGENT_TTL` 不回收，反覆操作即可耗盡 120 人上限。端對端測試有回歸防護。

### 掃描失敗一律降級，不擋人進場

相機權限被拒、非安全情境、生成失敗、生成服務未啟動 —— 全部退回捏臉流程。
捏臉是刻意保留的備援路徑，**不要移除**。
