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
│   └── tests/              # 單元測試（106 個，pytest；conftest.py 提供 fixture）
├── /frontend
│   ├── index.html          # 互動端主頁
│   ├── projection.html     # 投影牆渲染（PixiJS）
│   ├── sketch.js           # p5.js 主渲染迴圈（僅渲染，不放業務邏輯）
│   ├── character.js        # class Character（角色模型）+ 組件繪製、動態換色
│   ├── socket.js           # Socket.io 前後端通訊（自動偵測 LAN）
│   └── themes/lego.js      # LEGO 樂高風格渲染
├── start.sh                # 一鍵啟動腳本
├── requirements.txt        # 執行相依（mediapipe 已釘 <1.0，原因見下）
├── requirements-dev.txt    # 測試相依（pytest）
├── INTERFACES.md           # Socket.io 事件與 payload 介面規格
├── PRD.md
└── TechStack.md
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
cd backend
pip install -r requirements.txt          # 注意：mediapipe 已釘 <1.0，見下方
python app.py

# 跑測試（需另裝開發相依）
pip install -r requirements-dev.txt
cd backend && pytest tests/

# 端到端煙霧測試（需後端已啟動）
python backend/e2e_smoke.py

# 前端測試（Node 內建執行器，無需 npm 安裝）
node --test frontend/tests/

# 前端（用 Live Server 或 Node）
cd frontend
npx live-server
```
