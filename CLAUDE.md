# 數位轉譯角色空間互動系統 - Claude Code 專案說明

## 專案概述
將實體穿著透過視覺識別技術數位化，轉譯為插畫角色，並在公共空間中透過群體演算法生成集體共創視覺圖。

**期中審查截止日：2025/5/7**

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
│   ├── app.py                    # Flask、Socket.io、正式生成與開發 API
│   ├── cv_module.py              # MediaPipe 人體、服裝色彩、區域與姿勢特徵
│   ├── face_module.py            # 本機臉部特徵
│   ├── vlm_module.py             # 雲端服裝、髮型與臉部語意辨識
│   ├── style_registry.py         # 可擴充角色風格註冊表
│   ├── style_base.py             # 從參考圖量出的風格標準（數值化）
│   ├── style_fingerprint.py      # 風格指紋與跨角色物種漂移量測
│   ├── style_normalizer.py       # 方向性明暗量測與正規化
│   ├── garment_gen.py            # 完整角色生成流程與 prompt 模板
│   ├── avatar_quality.py         # 生成角色圖結構完整性驗證
│   ├── capture_quality.py        # 拍攝品質、站位與穩定度判定
│   ├── detail_quality.py         # 最終畫面細節指標
│   ├── height_profiles.py        # short／medium／tall 身高校正
│   ├── swarm_logic.py            # Boids 群聚演算法
│   ├── generation_history.py     # SQLite 生成紀錄、Token、成本與快速審查
│   ├── blind_review.py           # 外部結果匯入、原照縮圖與多人匿名盲評
│   ├── metrics_logger.py         # 匿名流程指標與輪替紀錄
│   ├── /models                   # MediaPipe／分割模型資產
│   ├── /tests                    # unittest：CV、生成、規格、歷史與盲評
│   └── /logs                     # 執行期資料；gitignored，不提交版本庫
│       ├── generation_history.sqlite3
│       ├── /generated            # AI attempt 與最終角色快照
│       └── /review_sources       # 經同意、去 EXIF 的評測縮圖，可批次刪除
├── /frontend
│   ├── index.html                # 拍攝與生成主操作頁
│   ├── sketch.js                 # p5.js 畫面、狀態與拍攝流程
│   ├── character.js              # 2D 預覽角色資料與組件
│   ├── socket.js                 # Socket.io 前後端事件橋接
│   ├── projection.html           # 2D sprite 群聚投影牆
│   ├── dev.html                  # 生成歷史、成本、外部匯入與盲評操作台
│   ├── /themes
│   │   ├── lego.js               # LEGO 主題渲染
│   │   └── registry.js           # 前端主題註冊表
│   └── wedding_bg.png            # 投影背景素材
├── AGENTS.md                     # Agent 專案結構、規範與啟動方式
├── README.md                     # 安裝、設定、流程與使用說明
├── PRD.md                        # 產品需求與驗收定義
├── TechStack.md                  # 技術選型
├── STYLE_BASE.md                 # 基底風格標準與量測方法
├── EXTERNAL_AI_RESEARCH_BRIEF.md # 提供外部研究 AI 的研究任務說明
├── RESUME_PROJECT.md             # 專案接續與目前狀態
└── requirements.txt              # Python 相依套件
```

---

## 核心演算法：Boids 群聚

每個角色速度向量由以下三力加權合成：
- **Separation（避障）**：遠離過近的鄰居
- **Alignment（對齊）**：匹配鄰近角色的速度方向
- **Cohesion（凝聚）**：往群體中心靠攏

實作位置：`backend/swarm_logic.py`，每 tick 輸出所有角色的新座標，透過 Socket.io 推送至前端。

---

## 期中審查優先功能（5/7 前必須完成）

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
- Socket.io 預設 polling 模式，需設定強制 WebSocket：`{ transports: ['websocket'] }`
- Flask 開發模式下 Socket 用 `eventlet` 或 `gevent`，不要用預設 thread

---

## 常用指令

```bash
# 後端啟動
python backend/app.py

# 前端啟動（在專案根目錄執行）
python -m http.server 8000 --directory frontend
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
