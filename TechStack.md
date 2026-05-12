# 數位轉譯角色空間互動系統 - 技術架構文件 (TechStack)

## 1. 技術架構圖層
系統採用四層式架構設計：
1. **感知層 (Perception)**: Python (MediaPipe/OpenCV)
2. **邏輯運算層 (Logic)**: Python (Flask/FastAPI)
3. **渲染交互層 (Rendering)**: JavaScript (p5.js 或 Three.js) + Socket.io
4. **數據與結晶層 (Output)**: Node.js (Canvas API)

## 2. 核心演算法定義

### Boids 群聚演算法邏輯
每個角色 $\vec{v}$ 的加速度將由以下向量加權計算：
* **避障 (Separation)**: $\vec{S} = -\sum_{j \neq i} (\vec{p}_j - \vec{p}_i)$
* **對齊 (Alignment)**: $\vec{A} = \frac{1}{N} \sum_{j=1}^{N} \vec{v}_j$
* **凝聚 (Cohesion)**: $\vec{C} = \frac{1}{N} \sum_{j=1}^{N} (\vec{p}_j - \vec{p}_i)$

## 3. 開發工具鏈
* **AI 輔助開發**: Cursor (Claude 3.5 Sonnet 模型)
* **後端框架**: Flask (用於處理 CV 數據與 Socket 通訊)
* **前端渲染**: p5.js (負責處理大規模 2D 插畫角色動態)
* **通訊協定**: WebSocket (Socket.io) 確保低延遲數據傳輸

## 4. 檔案目錄結構建議
```text
/PersonaFlow
├── /backend            # Python Flask server
│   ├── app.py          # 核心邏輯
│   ├── cv_module.py    # MediaPipe 特徵提取
│   └── swarm_logic.py  # 群體演算法運算
├── /frontend           # p5.js 渲染前端
│   ├── sketch.js       # 主渲染邏輯
│   ├── character.js    # 角色組件定義
│   └── socket.js       # 通訊處理
├── /assets             # 插畫組件 (SVG/PNG)
├── PRD.md
└── TechStack.md