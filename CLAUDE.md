# 數位轉譯角色空間互動系統 - Claude Code 專案說明

## 專案概述
將實體穿著透過視覺識別技術數位化，轉譯為插畫角色，並在公共空間中透過群體演算法生成集體共創視覺圖。

**期中審查截止日：2025/5/7** ⚠️ 此日期已過期（版控紀錄顯示開發持續至 2026/8），請更新為實際期限

---

## 技術架構

| 層級 | 技術 | 職責 |
|------|------|------|
| 感知層 | Python + MediaPipe / OpenCV | 服裝色調、輪廓、姿勢提取 |
| 邏輯層 | Python + Flask | CV 數據處理、Boids 演算法、Socket 通訊 |
| 渲染層 | JavaScript + p5.js + Socket.io | 角色動態渲染、群體互動 |
| 輸出層 | Node.js + Canvas API | 大合照生成、QR Code |

---

## 目錄結構
```
/PersonaFlow
├── /backend
│   ├── app.py                    # Flask、Socket.io、生成併發閘門與開發 API
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
│   ├── detail_quality.py         # 最終畫面細節指標
│   ├── height_profiles.py        # short／medium／tall 身高校正
│   ├── swarm_logic.py            # Boids 群聚演算法（含邊界柔性轉向、打招呼持續）
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
├── /frontend
│   ├── index.html                # 拍攝與生成主操作頁
│   ├── sketch.js                 # p5.js 畫面、狀態與拍攝流程（只放渲染）
│   ├── character.js              # class Character（角色資料模型）與組件繪製
│   ├── socket.js                 # Socket.io 前後端事件橋接（自動偵測 LAN）
│   ├── projection.html           # 2D sprite 群聚投影牆（PixiJS，自有格柵實作）
│   ├── dev.html                  # 生成歷史、成本、外部匯入與盲評操作台
│   ├── /themes
│   │   ├── lego.js               # LEGO 主題渲染
│   │   └── registry.js           # 前端主題註冊表
│   ├── /tests                    # Node 內建測試執行器（harness.js 提供 p5 樁）
│   └── wedding_bg.png            # 投影背景素材
├── /scripts                      # 參考圖集與髮色取樣的離線檢查工具
├── /.github/workflows/ci.yml     # CI：前端 Node 測試＋後端 pytest（skip 一律視為失敗）
├── start.sh                      # 一鍵啟動腳本
├── CLAUDE.md                     # 本檔：專案結構、規範與啟動方式
├── README.md                     # 安裝、設定、流程與使用說明
├── PRD.md                        # 產品需求與驗收定義
├── TechStack.md                  # 技術選型
├── STYLE_BASE.md                 # 基底風格標準與量測方法
├── STYLE_PROBE_FOLLOWUPS.md      # 已知但刻意延後的量測與管線細節
├── INTERFACES.md                 # Socket.io 事件與 payload 介面規格
├── EXTERNAL_AI_RESEARCH_BRIEF.md # 提供外部研究 AI 的研究任務說明
├── RESUME_PROJECT.md             # 專案接續與目前狀態
├── requirements.txt              # Python 執行相依（mediapipe 已釘 <1.0）
└── requirements-dev.txt          # 測試相依（pytest）
```

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
賓客關掉分頁角色仍留在場上（見 INTERFACES.md §4），因此同時在線數只取決於
「正在拍照的人 + 投影牆」，不隨賓客總數成長。

### ⚠️ 投影牆目前不使用後端座標

`swarm_logic.py` 的 Boids 結果會推送給 `sketch.js`，但 `projection.html`
跑的是自己的一套本地 Boids，並未採用 `char.x` / `char.y`。
開關 `USE_SERVER_POSITIONS` 預設關閉，開啟前需在真實場館網路量測廣播抖動。
詳見 GitHub issue #8。

---

## 常用指令

```bash
# 後端啟動
python backend/app.py

# 前端啟動（在專案根目錄執行）
python -m http.server 8000 --directory frontend

# 後端測試
pip install -r requirements-dev.txt
python -m pytest backend/tests

# 前端測試（Node 內建執行器，無需 npm 安裝）
node --test frontend/tests/

# 端到端煙霧測試（需後端已啟動）
python backend/e2e_smoke.py
```

## 本機預覽：開啟與關閉

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

主操作頁：`http://127.0.0.1:8000/index.html`
投影頁：`http://127.0.0.1:8000/projection.html`
生成歷史與成本：`http://127.0.0.1:8000/dev.html`
後端健康檢查：`http://127.0.0.1:5001/health`
