# Interactive Art Installation
**互動藝術裝置專題**

> 讓任何人，用自己的身體，創作一幅屬於自己風格的畫。

觀眾站在鏡頭前，透過手部動作即時生成風格化畫作，最終可印成明信片帶走。不需要任何藝術背景，不需要學操作方式——你的動作就是畫筆。

---

## 專題定位

| | 說明 |
|---|---|
| 目標觀眾 | 一般展覽觀眾，任何年齡與背景 |
| 核心體驗 | 30 秒內完成一幅屬於自己風格的畫 |
| 輸出 | 可列印帶走的明信片（PNG 檔） |
| 與業界差異 | 觀眾是「創作者」，不是「觸發器」 |

---

## 技術架構

```
interactive-art/
├── modules/
│   ├── hand_tracker.py     # 手部偵測與骨架追蹤（組員 A）
│   ├── canvas.py           # 畫布建立與筆觸繪製（組員 B）
│   ├── stroke_mapper.py    # 速度映射與筆觸參數（組員 C）
│   ├── perf_monitor.py     # 效能測量與 FPS 顯示（組員 D）
│   ├── style_manager.py    # 風格切換管理（組員 E）
│   └── silhouette.py       # 人體剪影疊加（組員 A + E）
├── assets/
│   └── styles.json         # 四種風格的參數設定
├── outputs/                # 生成的作品圖檔（自動建立）
├── tests/                  # 各模組的獨立測試腳本
├── main.py                 # 主程式入口（組員 E 整合）
├── config.py               # 全組共用設定
└── requirements.txt        # 套件清單
```

---

## 快速開始

### 環境需求
- Python 3.9 以上
- webcam 或外接攝影機
- 建議：有獨立 GPU 效能更佳，但一般筆電也能跑

### 安裝

```bash
git clone https://github.com/your-org/interactive-art.git
cd interactive-art
pip install -r requirements.txt
```

### 執行

```bash
# 跑完整主程式
python main.py

# 各模組獨立測試（不需要整合其他人的程式）
python tests/test_hand.py
python tests/test_canvas.py
python tests/test_stroke.py
python tests/test_perf.py
```

### 操作說明

| 動作 | 效果 |
|---|---|
| 張開手 + 移動 | 落筆，開始畫線 |
| 握拳 | 提筆，暫停繪製 |
| 手往前（靠近鏡頭） | 筆觸變粗，模擬用力壓筆 |
| 快速移動 | 筆觸飛濺，奔放感 |
| 慢速移動 | 細膩線條，控制感 |
| 按 `1`–`4` | 切換風格（油畫 / 素描 / 水墨 / 名畫風）|
| 按 `S` | 儲存當前畫作到 `outputs/` |
| 按 `C` | 清除畫布 |
| 按 `Q` | 結束程式 |

---

## 模組介面規範

所有模組必須遵守以下介面，方便 E 整合進 `main.py`。

### hand_tracker.py（組員 A 負責）

```python
get_hand_state() -> dict
# 回傳：{"x": int, "y": int, "z": float, "drawing": bool, "speed": float}
# x, y 已換算為畫布像素座標
# z 為 MediaPipe 原始值（約 -0.3 ~ 0.3）
# drawing: True = 張手落筆，False = 握拳提筆
# speed: 移動速度（px/s）

is_drawing() -> bool
get_silhouette_mask() -> np.ndarray  # 人體剪影遮罩
release() -> None                    # 釋放資源，程式結束前呼叫
```

### canvas.py（組員 B 負責）

```python
draw_stroke(x: int, y: int, thickness: int, color: tuple) -> None
overlay_webcam(frame: np.ndarray, alpha: float) -> np.ndarray
clear() -> None
save(path: str) -> str  # 回傳實際儲存路徑
```

### stroke_mapper.py（組員 C 負責）

```python
compute_stroke(speed: float, z: float) -> dict
# 回傳：{"thickness": int, "alpha": float, "color_mod": float}

smooth(value: float, prev: float) -> float  # 指數移動平均
reset() -> None
```

### perf_monitor.py（組員 D 負責）

```python
tick() -> None                          # 每幀呼叫一次
get_fps() -> float
get_latency() -> float                  # 單位 ms
draw_overlay(frame: np.ndarray) -> np.ndarray  # 在畫面左上角顯示數字
```

### style_manager.py（組員 E 負責）

```python
get_styles() -> list                    # 回傳所有風格名稱
set_style(name: str) -> None
get_params() -> dict                    # 回傳目前風格的筆觸參數
draw_selector(frame: np.ndarray) -> np.ndarray  # 在畫面顯示風格選擇 UI
```

---

## 全組共用設定（config.py）

**修改前請先通知所有人，這個檔案的改動影響全部模組。**

```python
CANVAS_W    = 1920      # 畫布寬度（px）
CANVAS_H    = 1080      # 畫布高度（px）
CAM_INDEX   = 0         # 攝影機編號（外接鏡頭通常是 1）
OUTPUT_DIR  = "outputs/"
FPS_TARGET  = 30
MIN_CONFIDENCE = 0.7    # MediaPipe 最低信心值，低於此不輸出座標
```

---

## 分工與負責範圍

| 組員 | 負責模組 | 核心任務 |
|---|---|---|
| A | `hand_tracker.py` | MediaPipe 手部偵測、握拳判斷、剪影研究 |
| B | `canvas.py` | OpenCV 畫布、筆觸繪製、webcam 疊加 |
| C | `stroke_mapper.py` | 速度計算、速度→粗細映射、Z 軸映射 |
| D | `perf_monitor.py` | FPS 測量、延遲測量、展場配置研究 |
| E | `style_manager.py` + `main.py` | 風格設計、Day 4 整合所有模組 |

---

## 開發進度

- [ ] A：`hand_tracker.py` 完成並通過獨立測試
- [ ] B：`canvas.py` 完成，滑鼠可畫線
- [ ] C：`stroke_mapper.py` 完成，附參數對比截圖
- [ ] D：效能測試表完成（至少兩台電腦的數據）
- [ ] E：四種風格介面截圖完成
- [ ] 整合：`main.py` 能完整跑起來
- [ ] 示範影片錄製完成（30 秒）
- [ ] 教授報告素材準備完成

---

## requirements.txt

```
mediapipe>=0.10.0
opencv-python>=4.8.0
numpy>=1.24.0
```
