# 組員 B 工作說明｜畫布與筆觸

## 你負責的模組
`modules/canvas.py` `tests/test_canvas.py`

---

## 你的任務目標

建立一個 OpenCV 畫布，能接收座標畫出連續筆觸，並把 webcam 畫面疊加進去。你的模組**完全不需要等組員 A**，用滑鼠模擬手部就能從 Day 1 開始做。

**本週結束前要完成：**
- 黑色畫布上能用滑鼠畫出連續線條
- webcam 畫面半透明疊加在畫布上
- 按 S 儲存當前畫布為 PNG
- 四種風格的視覺效果截圖（用不同顏色和透明度呈現）

---

## 第一步：環境安裝

```bash
pip install opencv-python numpy
```

確認：
```bash
python -c "import cv2; import numpy; print('OK')"
```

---

## 第二步：克隆 repo 並開啟分支

```bash
git clone https://github.com/你的帳號/interactive-art.git
cd interactive-art
git checkout dev
git checkout -b feature/canvas
```

---

## 第三步：逐步完成功能

### Day 1 — 用滑鼠畫線（不需要等 A）

開啟 `modules/canvas.py`，填入：

```python
"""
canvas.py
負責人：組員 B
功能：建立畫布、筆觸繪製、webcam 疊加、存圖
"""
import cv2
import numpy as np
import os
from datetime import datetime
from config import CANVAS_W, CANVAS_H, OUTPUT_DIR

# 畫布狀態
_canvas = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.uint8)
_prev_x, _prev_y = None, None
_cap = None

def init(cam_index=0):
    global _cap
    _cap = cv2.VideoCapture(cam_index)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

def draw_stroke(x: int, y: int, thickness: int, color: tuple) -> None:
    global _prev_x, _prev_y
    if _prev_x is not None and _prev_y is not None:
        cv2.line(_canvas, (_prev_x, _prev_y), (x, y), color, thickness,
                 lineType=cv2.LINE_AA)
    _prev_x, _prev_y = x, y

def stop_stroke() -> None:
    """提筆時呼叫，讓下一筆不連接上一筆"""
    global _prev_x, _prev_y
    _prev_x, _prev_y = None, None

def get_frame() -> np.ndarray:
    """取得目前畫布"""
    return _canvas.copy()

def overlay_webcam(frame: np.ndarray, alpha: float = 0.3) -> np.ndarray:
    """把 webcam 畫面半透明疊在畫布上"""
    resized = cv2.resize(frame, (CANVAS_W, CANVAS_H))
    return cv2.addWeighted(resized, alpha, _canvas, 1 - alpha, 0)

def clear() -> None:
    global _canvas
    _canvas = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.uint8)
    stop_stroke()

def save(path: str = None) -> str:
    if path is None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(OUTPUT_DIR, f"output_{ts}.png")
    cv2.imwrite(path, _canvas)
    print(f"儲存：{path}")
    return path

def release() -> None:
    if _cap:
        _cap.release()
```

存檔後，用這段測試腳本確認畫布能用滑鼠畫線：

```python
# 直接在 canvas.py 最下面加，測試完記得移除
if __name__ == "__main__":
    import sys
    sys.path.insert(0, '.')
    from config import CANVAS_W, CANVAS_H

    drawing = False

    def mouse_callback(event, x, y, flags, param):
        global drawing
        if event == cv2.EVENT_LBUTTONDOWN:
            drawing = True
        elif event == cv2.EVENT_LBUTTONUP:
            drawing = False
            stop_stroke()
        elif event == cv2.EVENT_MOUSEMOVE and drawing:
            draw_stroke(x, y, thickness=5, color=(255, 255, 255))

    canvas_win = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.uint8)
    cv2.namedWindow("test")
    cv2.setMouseCallback("test", mouse_callback)

    while True:
        cv2.imshow("test", get_frame())
        key = cv2.waitKey(1) & 0xFF
        if key == ord('s'):
            save()
        elif key == ord('c'):
            clear()
        elif key == ord('q'):
            break
    cv2.destroyAllWindows()
```

執行：
```bash
python modules/canvas.py
```

用滑鼠在視窗上畫線，確認線條連續、按 S 存圖、按 C 清除。

### Day 2 — 加入 webcam 疊加，研究四種風格

在 `if __name__ == "__main__":` 的測試段加入 webcam：

```python
cap = cv2.VideoCapture(0)
# 在迴圈裡：
ret, frame = cap.read()
if ret:
    display = overlay_webcam(frame, alpha=0.3)
    cv2.imshow("test", display)
```

四種風格的視覺測試，改變 color 和 alpha 觀察效果：

| 風格 | color（BGR） | thickness | alpha（webcam） |
|---|---|---|---|
| 油畫 | (150, 200, 255) | 8 | 0.25 |
| 素描 | (220, 220, 220) | 3 | 0.15 |
| 水墨 | (40, 40, 40) | 6 | 0.2 |
| 名畫風 | (70, 130, 180) | 7 | 0.3 |

**每種風格截一張圖存進 `assets/` 資料夾**，命名為 `style_oilpaint.png` 等，這是給教授看的視覺對比。

### Day 3 — 測試腳本

開啟 `tests/test_canvas.py`：

```python
"""
test_canvas.py — 組員 B 的獨立測試
執行：python tests/test_canvas.py
"""
import sys
sys.path.insert(0, '.')
import numpy as np

def test_canvas_init_shape():
    from config import CANVAS_W, CANVAS_H
    from modules.canvas import get_frame, clear
    clear()
    frame = get_frame()
    assert frame.shape == (CANVAS_H, CANVAS_W, 3), f"畫布尺寸錯誤：{frame.shape}"
    print("PASS: 畫布尺寸正確")

def test_canvas_is_black_after_clear():
    from modules.canvas import clear, get_frame
    clear()
    frame = get_frame()
    assert frame.sum() == 0, "clear() 後畫布應為全黑"
    print("PASS: clear() 正常")

def test_draw_stroke_changes_canvas():
    from modules.canvas import clear, draw_stroke, get_frame, stop_stroke
    clear()
    stop_stroke()
    draw_stroke(100, 100, 5, (255, 255, 255))
    draw_stroke(200, 200, 5, (255, 255, 255))
    frame = get_frame()
    assert frame.sum() > 0, "draw_stroke 後畫布應有像素"
    print("PASS: draw_stroke() 正常")

def test_overlay_webcam_output_shape():
    from modules.canvas import overlay_webcam
    from config import CANVAS_W, CANVAS_H
    fake_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    result = overlay_webcam(fake_frame, alpha=0.3)
    assert result.shape == (CANVAS_H, CANVAS_W, 3), "overlay 輸出尺寸錯誤"
    print("PASS: overlay_webcam() 輸出尺寸正確")

if __name__ == "__main__":
    test_canvas_init_shape()
    test_canvas_is_black_after_clear()
    test_draw_stroke_changes_canvas()
    test_overlay_webcam_output_shape()
    print("\n全部測試通過")
```

執行：
```bash
python tests/test_canvas.py
```

---

## 第四步：上傳到 GitHub

```bash
git add modules/canvas.py
git commit -m "feat: 完成畫布基本繪製與 webcam 疊加"

git add tests/test_canvas.py
git commit -m "test: 新增 test_canvas 測試腳本"

git add assets/
git commit -m "docs: 新增四種風格視覺截圖"

git push origin feature/canvas
```

---

## 第五步：開 Pull Request

1. 進 GitHub repo 頁面
2. 點 `Compare & pull request`
3. Base 選 `dev`，compare 選 `feature/canvas`
4. 標題填：`feat: 完成 canvas 模組`
5. 在說明欄貼上四種風格截圖的觀察（哪種最好看、建議用什麼背景色）
6. 點 `Create pull request`，通知組員 E

---

## 交付物清單

- [ ] `modules/canvas.py` — 滑鼠可畫線，webcam 疊加正常，S 存圖，C 清除
- [ ] `tests/test_canvas.py` — 全部 PASS
- [ ] `assets/` 裡有四張風格截圖
- [ ] PR 說明裡有視覺觀察筆記
