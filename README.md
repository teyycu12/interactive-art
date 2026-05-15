# PersonaFlow · 數位轉譯角色空間互動系統

將實體穿著透過視覺識別技術數位化，轉譯為樂高風格插畫角色，並透過群體演算法在公共空間中生成集體共創視覺圖。
---

## ✨ 核心功能

| 功能 | 說明 |
|---|---|
| 即時人體偵測 | MediaPipe Pose + Face Landmarker 抓取姿勢、面部特徵 |
| 服裝色調提取 | OpenCV K-Means 取出上下身主色，產生 grid 色塊網格 |
| AI 角色生成 | 兩種模式可即時切換（見下方） |
| Boids 群聚演算法 | 角色在共創畫布上自然漫遊 / 打招呼 |
| 程式化樂高渲染 | p5.js 即時合成頭、髮、手、腳等 LEGO 部件 |

---

## 🎭 兩種生成模式

| 模式 | 行為 | 特點 |
|---|---|---|
| **body_sprite**（穩定、快） | AI 只生成上下身衣物，頭/手/腳由程式繪製 LEGO 標準件 | 速度快、穩定度高、易疊加配件 |
| **full_character**（細節豐富、較慢） | AI 一次生成完整樂高 minifigure（頭 + 髮 + 臉 + 身 + 腳） | 細節豐富、預留骨架欄位以利未來動畫擴充 |

前端 UI 可逐次切換；後端用獨立環境變數設定各自模型，方便 A/B 測試生圖品質。

---

## 🏗 技術架構

| 層級 | 技術 | 職責 |
|---|---|---|
| 感知層 | Python + MediaPipe / OpenCV | 服裝色調、輪廓、姿勢、面部特徵 |
| 邏輯層 | Python + Flask-SocketIO + eventlet | CV 數據處理、Boids 演算法、Socket 通訊 |
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
│   ├── garment_gen.py      # 兩種模式的 AI 生圖入口
│   └── swarm_logic.py      # Boids 群聚演算法
├── frontend/
│   ├── index.html          # 模式選擇器 UI
│   ├── sketch.js           # p5.js 主迴圈、狀態機
│   ├── character.js        # Person 物件 / 渲染屬性
│   ├── socket.js           # Socket.io 前後端通訊
│   └── themes/lego.js      # LEGO 樂高風格渲染
├── .env.example            # 環境變數範本
├── requirements.txt
└── CLAUDE.md / PRD.md / TechStack.md
```

---

## 🚀 快速啟動

### 1. 後端

```bash
cd backend
pip install -r ../requirements.txt
cp ../.env.example .env       # 填入你的 API key
python app.py                 # 預設 http://0.0.0.0:5000
```

### 2. 前端

```bash
cd frontend
npx live-server               # 預設 http://127.0.0.1:8080
```

---

## 🔑 環境變數

複製 `.env.example` 為 `backend/.env`（或專案根目錄的 `.env`）後填入：

| 變數 | 用途 | 範例 |
|---|---|---|
| `OPENAI_API_KEY` | OpenRouter / OpenAI 金鑰 | `sk-or-v1-...` |
| `OUTFIT_GEN_MODEL` | body_sprite 模式用的生圖模型 | `google/gemini-3.1-flash-image-preview` |
| `FULL_CHARACTER_MODEL` | full_character 模式用的生圖模型 | `google/gemini-3-pro-image-preview` |
| `GENERATION_MODE` | 後端預設模式（前端可逐次覆蓋） | `body_sprite` |
| `GEMINI_API_KEY` | VLM 服裝屬性分析用 | `AIzaSy...` |

> ⚠️ **僅支援 chat-completions 多模態介面的模型**（Google Nano Banana 系列）。FLUX 等需走 `/images/generations` 的模型在這套程式碼裡會回 404。

---

## 🛣 未來規劃

- 角色骨架／IK 繫結（`Person.skeleton` 已預留欄位）
- 動畫狀態機（`Person.animState` 已預留欄位）
- 大合照輸出 + QR Code（Node + Canvas API）
- 從生成圖反推 landmark 以套用骨架動畫
