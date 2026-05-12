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
│   ├── app.py          # Flask 主程式、Socket 事件
│   ├── cv_module.py    # MediaPipe 特徵提取（主色調 RGB/HEX、姿勢）
│   └── swarm_logic.py  # Boids 群聚演算法（Separation / Alignment / Cohesion）
├── /frontend
│   ├── sketch.js       # p5.js 主渲染迴圈
│   ├── character.js    # 角色組件定義、動態換色邏輯
│   └── socket.js       # Socket.io 前後端通訊
├── /assets             # 插畫組件（SVG/PNG）
├── PRD.md
└── TechStack.md
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
cd backend
pip install flask flask-socketio eventlet opencv-python mediapipe
python app.py

# 前端（用 Live Server 或 Node）
cd frontend
npx live-server
```
