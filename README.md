# PersonaFlow · 數位轉譯角色空間互動系統

將實體穿著透過視覺識別技術數位化，轉譯為樂高風格插畫角色，並透過群體演算法在公共空間中生成集體共創視覺圖。

---

## 📌 整合現況

本專案已與 **PersonaFlow2**（Node.js 互動層）整合為單一展場作品。
依 v4.0 計畫書決議：PF2 為主幹，本專案的 CV/VLM/生圖管線退為**角色資產生成服務**。

| | 整合版（主線） | 2D 備援（保留） |
|---|---|---|
| 互動層 | `server/` — α 仲裁共治、任務、配對、問答、計分、社交圖譜 | `backend/app.py` |
| 前端 | `public/` — 手機控制器 / 大螢幕 / 主辦端 | `frontend/` |
| 啟動 | `npm start` + `python backend/service.py` | `bash start.sh` |
| 測試 | 188 單元 + 87 端對端 + 170 Python | 同左（共用） |

**參與者有兩條入場路徑**：拍照掃描生成角色，或模組捏臉。
掃描失敗（相機權限被拒、非 HTTPS、生成服務未啟動）一律降級回捏臉，不會擋人進場。

```bash
npm install && pip install -r requirements.txt
npm start                     # 互動層，印出三個網址
python backend/service.py     # 角色生成服務（127.0.0.1:5055）
```

> **現場要用手機相機必須有 HTTPS** —— `getUserMedia` 在 `http://192.168.x.x` 上會被瀏覽器直接拒絕。
> 執行 `bash scripts/make-cert.sh` 產生憑證後，以
> `TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start` 啟動。

完整說明見 [CLAUDE.md](CLAUDE.md) 與 [docs/](docs/)。

---

## 以下為 2D 備援版說明


## ✨ 核心功能

| 功能 | 說明 |
|---|---|
| 即時人體偵測 | MediaPipe Pose + Face Landmarker 抓取姿勢、面部特徵 |
| 服裝色調提取 | OpenCV K-Means 取出上下身主色，產生 grid 色塊網格 |
| AI 角色生成 | 三種模式可即時切換（見下方） |
| Boids 群聚演算法 | 角色在共創畫布上自然漫遊 / 打招呼 |
| 程式化樂高渲染 | p5.js 即時合成頭、髮、手、腳等 LEGO 部件 |
| 攝影機開關 | 前端可即時關閉 / 重啟攝影機，方便展示中切換隱私狀態 |

---

## 🎭 三種生成模式

| 模式 | 行為 | 特點 |
|---|---|---|
| **body_sprite**（穩定、快） | AI 只生成上下身衣物，頭/手/腳由程式繪製 LEGO 標準件 | 速度快、穩定度高、易疊加配件 |
| **full_character**（細節豐富、較慢） | AI 一次生成完整樂高 minifigure（頭 + 髮 + 臉 + 身 + 腳） | 細節豐富、預留骨架欄位以利未來動畫擴充 |
| **full_character_refined**（最精緻、最慢） | 兩段式 pipeline：先產生 full_character 底圖，再以「原始照片 + 底圖」雙圖輸入做精修 pass | 五官、髮型、鞋子等細節最銳利；任一段失敗會自動回退到底圖 |

前端 UI 可逐次切換；後端用獨立環境變數設定各自模型，方便 A/B 測試生圖品質。

### 🔁 full_character_refined 兩段式流程

```
       原始照片
          │
          ▼
[Pass 1] generate_full_character_png   ←─ FULL_CHARACTER_MODEL
   (產出帶白底的底圖，方便 Pass 2 對齊)
          │
          ▼
[Pass 2] generate_refine_character_png ←─ REFINE_CHARACTER_MODEL
   (同時看「原始照片 + Pass 1 底圖」，鎖構圖、銳化臉/髮/鞋細節)
          │
          ▼
   去白底 → 回傳前端 (body_png + body_bbox)
```

若 Pass 2 失敗，後端會自動 fallback 回去白底處理後的 Pass 1 底圖，前端體驗不會中斷。

---

## 🏗 技術架構

| 層級 | 技術 | 職責 |
|---|---|---|
| 感知層 | Python + MediaPipe / OpenCV | 服裝色調、輪廓、姿勢、面部特徵 |
| 邏輯層 | Python + Flask-SocketIO（threading 模式） | CV 數據處理、Boids 演算法、Socket 通訊 |
| 生成層 | OpenRouter (Google Nano Banana 系列) | image-to-image 樂高化 |
| 渲染層 | JavaScript + p5.js + Socket.io | 角色動態渲染、群體互動 |

---

## 📁 目錄結構

```
PersonaFlow/
├── backend/
│   ├── app.py              # Flask + SocketIO 主程式
│   ├── cv_module.py        # MediaPipe 姿勢 / 色塊網格擷取
│   ├── face_module.py      # 面部特徵偵測
│   ├── vlm_module.py       # Gemini VLM 服裝屬性分析
│   ├── garment_gen.py      # 三種模式的 AI 生圖入口
│   ├── avatar_pipeline.py  # generate_avatar 的純資料處理（可單獨測試）
│   ├── config.py           # 集中式環境設定（型別轉換與驗證）
│   ├── swarm_logic.py      # Boids 群聚演算法（含邊界轉向 / 打招呼持續）
│   ├── swarm_snapshot.py   # swarm 狀態持久化，重啟自動還原
│   ├── photo_composer.py   # M6 大合照合成（排版、QR、中文字型後備鏈）
│   ├── bot_simulator.py    # 壓測用虛擬角色注入 / 移除
│   ├── circuit_breaker.py  # 外部 API 熔斷器與退避重試
│   ├── event_logger.py     # 結構化事件 log 落地（JSON lines）
│   ├── e2e_smoke.py        # 端到端煙霧測試（對真的跑起來的後端）
│   ├── stress_test.py      # 承載量壓測工具
│   ├── analyze_log.py      # 效能指標分析（延遲 / 失敗率）
│   ├── bench_generate.py   # 生成延遲基準線量測
│   ├── report_html.py      # HTML 效能報告產生器
│   └── tests/              # 單元測試（125 個，pytest）
├── frontend/
│   ├── index.html          # 互動端主頁（模式選擇器 UI）
│   ├── projection.html     # 投影牆渲染（PixiJS）
│   ├── sketch.js           # p5.js 主迴圈、狀態機
│   ├── character.js        # class Character（角色模型）+ 組件繪製
│   ├── socket.js           # Socket.io 前後端通訊（自動偵測 LAN）
│   ├── themes/lego.js      # LEGO 樂高風格渲染（含格柵記憶化）
│   └── tests/              # 前端測試（Node 內建執行器）
├── docs/                   # 所有規格與設計文件
│   ├── INTERFACES.md       # Socket.io 事件與 payload 介面規格
│   ├── PRD.md TechStack.md TECHNICAL_ARCHITECTURE.md
│   ├── README-PersonaFlow2.md TECH-PersonaFlow2.md SPEC-v3.html SPEC-v4.html
│   └── m3/                 # M3 交接文件與效能報告
├── start.sh                # 2D 備援版一鍵啟動（後端 + 前端 + LAN IP 顯示）
├── .env.example            # 環境變數範本
├── requirements.txt
└── CLAUDE.md               # 專案說明（含整合後的注意事項）
```

---

## 🚀 快速啟動

### 一鍵啟動（推薦）

```bash
pip install -r requirements.txt
cp .env.example .env          # 填入你的 API key
bash start.sh                 # 同時啟動後端 + 前端，顯示 LAN IP
```

啟動後終端會顯示 LAN IP，現場手機 / 平板直接用該 IP 連入互動端。

### 分別啟動

```bash
# 後端（Flask-SocketIO on :5001）
python3 backend/app.py

# 前端靜態伺服器（:8080）
python3 -m http.server 8080 --directory frontend --bind 0.0.0.0
```

### 跑測試

測試使用 pytest（`backend/tests/conftest.py` 提供 fixture，unittest 已無法 discover）。

```bash
# 首次安裝測試相依
pip install -r requirements.txt -r requirements-dev.txt

# 執行
cd backend && pytest tests/

# 前端測試（Node 內建執行器，無需 npm 安裝）
node --test frontend/tests/
```

Flask 與 Pillow 缺少時，photo_composer 合成測試與 socket handler 測試會 **skip
而非失敗** —— 看到 skip 代表環境沒裝齊、那些路徑實際沒被測到。兩者都在
`requirements.txt` 裡，CI 也會在出現任何 skip 時直接失敗。

---

## 🔑 環境變數

複製 `.env.example` 為 `backend/.env`（或專案根目錄的 `.env`）後填入：

| 變數 | 用途 | 範例 |
|---|---|---|
| `OPENAI_API_KEY` | OpenRouter / OpenAI 金鑰 | `sk-or-v1-...` |
| `OUTFIT_GEN_MODEL` | body_sprite 模式用的生圖模型 | `google/gemini-3.1-flash-image-preview` |
| `FULL_CHARACTER_MODEL` | full_character 模式用的生圖模型 | `google/gemini-3-pro-image-preview` |
| `REFINE_CHARACTER_MODEL` | full_character_refined 第二段精修用的模型；省略時依序 fallback 到 `FULL_CHARACTER_MODEL` → `OUTFIT_GEN_MODEL` | `google/gemini-3-pro-image-preview` |
| `GENERATION_MODE` | 後端預設模式（前端可逐次覆蓋） | `body_sprite` / `full_character` / `full_character_refined` |
| `GEMINI_API_KEY` | VLM 服裝屬性分析用（**必填**，不再有內建 fallback） | `AIzaSy...` |

> ⚠️ **僅支援 chat-completions 多模態介面的模型**（Google Nano Banana 系列）。FLUX 等需走 `/images/generations` 的模型在這套程式碼裡會回 404。

---

## 🛣 未來規劃

- 角色骨架／IK 繫結（`Person.skeleton` 已預留欄位）
- 動畫狀態機（`Person.animState` 已預留欄位）
- ~~大合照輸出 + QR Code~~（M6 已完成；改以 Python + Pillow 實作，見 photo_composer.py）
- 從生成圖反推 landmark 以套用骨架動畫
