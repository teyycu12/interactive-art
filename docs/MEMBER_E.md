# 組員 E 工作說明｜風格設計與整合

## 你負責的模組
`modules/style_manager.py` `main.py` `tests/test_style.py`

---

## 你的任務目標

Day 1–3 獨立研究四種風格的視覺設計。Day 4 把所有人的模組整合進 `main.py`。你是最後一道關卡，負責讓整個系統跑起來。

**本週結束前要完成：**
- 四種風格的參數設計（色彩、背景、筆觸個性）
- 風格選擇介面（畫面上的按鈕）
- Day 4 整合所有模組進 `main.py`

---

## 第一步：環境安裝

```bash
pip install opencv-python numpy mediapipe
```

---

## 第二步：克隆 repo 並開啟分支

```bash
git clone https://github.com/你的帳號/interactive-art.git
cd interactive-art
git checkout dev
git checkout -b feature/style-main
```

---

## 第三步：Day 1–3 獨立完成風格模組

### Day 1 — 設計四種風格參數

開啟 `assets/styles.json`，把參數填完整：

```json
{
  "油畫": {
    "bg_color": [15, 10, 5],
    "stroke_color": [150, 180, 220],
    "thickness_multiplier": 1.5,
    "alpha": 0.85,
    "blur": 1,
    "description": "厚重、堆疊感，背景深色"
  },
  "素描": {
    "bg_color": [245, 245, 245],
    "stroke_color": [30, 30, 30],
    "thickness_multiplier": 0.7,
    "alpha": 1.0,
    "blur": 0,
    "description": "細線、清晰，白色背景"
  },
  "水墨": {
    "bg_color": [235, 230, 220],
    "stroke_color": [20, 20, 20],
    "thickness_multiplier": 1.2,
    "alpha": 0.55,
    "blur": 2,
    "description": "暈染感，米白背景"
  },
  "名畫風": {
    "bg_color": [15, 10, 25],
    "stroke_color": [180, 140, 80],
    "thickness_multiplier": 1.0,
    "alpha": 0.9,
    "blur": 1,
    "description": "金棕色調，深色背景"
  }
}
```

開啟 `modules/style_manager.py`，填入：

```python
"""
style_manager.py
負責人：組員 E
功能：風格切換管理、取得目前風格參數、顯示風格選擇 UI
"""
import cv2
import json
import numpy as np
from config import STYLES

_styles = {}
_current = STYLES[0]

def _load():
    global _styles
    try:
        with open("assets/styles.json", "r", encoding="utf-8") as f:
            _styles = json.load(f)
    except FileNotFoundError:
        # 預設值，避免找不到檔案時崩潰
        _styles = {name: {"bg_color": [0,0,0], "stroke_color": [255,255,255],
                           "thickness_multiplier": 1.0, "alpha": 1.0, "blur": 0}
                   for name in STYLES}

_load()

def get_styles() -> list:
    return list(_styles.keys())

def set_style(name: str) -> None:
    global _current
    if name in _styles:
        _current = name

def get_current() -> str:
    return _current

def get_params() -> dict:
    return _styles.get(_current, {})

def get_bg_canvas(w: int, h: int) -> np.ndarray:
    """回傳目前風格的背景顏色畫布"""
    params = get_params()
    bg = params.get("bg_color", [0, 0, 0])
    canvas = np.zeros((h, w, 3), dtype=np.uint8)
    canvas[:] = bg[::-1]  # RGB 轉 BGR
    return canvas

def draw_selector(frame: np.ndarray) -> np.ndarray:
    """在畫面右上角顯示風格選擇按鈕"""
    out = frame.copy()
    h, w = out.shape[:2]
    styles = get_styles()
    btn_w, btn_h = 120, 36
    margin = 10
    start_x = w - btn_w - margin
    start_y = margin

    for i, style in enumerate(styles):
        y = start_y + i * (btn_h + 6)
        is_active = (style == _current)

        bg_color = (60, 60, 60) if not is_active else (200, 160, 60)
        cv2.rectangle(out, (start_x, y), (start_x + btn_w, y + btn_h),
                      bg_color, -1)
        cv2.rectangle(out, (start_x, y), (start_x + btn_w, y + btn_h),
                      (150, 150, 150), 1)
        text_color = (255, 255, 255) if not is_active else (20, 20, 20)
        cv2.putText(out, style, (start_x + 8, y + 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, text_color, 1,
                    cv2.LINE_AA)
    return out

def handle_key(key: int) -> bool:
    """按 1-4 切換風格，回傳是否有切換"""
    styles = get_styles()
    if ord('1') <= key <= ord('4'):
        idx = key - ord('1')
        if idx < len(styles):
            set_style(styles[idx])
            print(f"切換風格：{styles[idx]}")
            return True
    return False
```

### Day 2 — 做風格預覽工具

建一個獨立測試工具，確認四種風格的視覺效果：

```python
# 存成 tests/style_preview.py
"""
style_preview.py — 風格視覺預覽工具
執行：python tests/style_preview.py
用滑鼠在每種風格下畫線，截圖存進 assets/
"""
import sys
sys.path.insert(0, '.')
import cv2
import numpy as np
from modules.style_manager import get_params, set_style, draw_selector, handle_key, STYLES, get_styles

W, H = 1280, 720
prev_x, prev_y = None, None

styles = get_styles()
set_style(styles[0])

def get_canvas():
    params = get_params()
    bg = params.get("bg_color", [0,0,0])
    c = np.zeros((H, W, 3), dtype=np.uint8)
    c[:] = bg[::-1]
    return c

canvas = get_canvas()

def mouse_cb(event, x, y, flags, param):
    global prev_x, prev_y, canvas
    params = get_params()
    color = params.get("stroke_color", [255,255,255])
    thick = int(8 * params.get("thickness_multiplier", 1.0))
    if event == cv2.EVENT_MOUSEMOVE and (flags & cv2.EVENT_FLAG_LBUTTON):
        if prev_x is not None:
            cv2.line(canvas, (prev_x, prev_y), (x, y),
                     color[::-1], thick, cv2.LINE_AA)
        prev_x, prev_y = x, y
    elif event == cv2.EVENT_LBUTTONUP:
        prev_x, prev_y = None, None

cv2.namedWindow("style preview")
cv2.setMouseCallback("style preview", mouse_cb)

while True:
    display = draw_selector(canvas)
    cv2.imshow("style preview", display)
    key = cv2.waitKey(1) & 0xFF
    if handle_key(key):
        canvas = get_canvas()
    elif key == ord('s'):
        from modules.style_manager import _current
        path = f"assets/style_{_current}.png"
        cv2.imwrite(path, canvas)
        print(f"存圖：{path}")
    elif key == ord('c'):
        canvas = get_canvas()
    elif key == ord('q'):
        break
cv2.destroyAllWindows()
```

執行，每種風格各畫一下然後按 S 截圖：
```bash
python tests/style_preview.py
```

### Day 3 — 測試腳本

開啟 `tests/test_style.py`：

```python
"""
test_style.py — 組員 E 的獨立測試
"""
import sys
sys.path.insert(0, '.')
from modules.style_manager import get_styles, set_style, get_params, get_current
import numpy as np

def test_styles_loaded():
    styles = get_styles()
    assert len(styles) >= 4, f"應至少有 4 種風格，實際：{len(styles)}"
    print(f"PASS: 載入 {len(styles)} 種風格")

def test_set_style():
    styles = get_styles()
    set_style(styles[1])
    assert get_current() == styles[1], "set_style 後應切換成功"
    print("PASS: set_style 切換正常")

def test_params_has_required_keys():
    styles = get_styles()
    for s in styles:
        set_style(s)
        params = get_params()
        for key in ["bg_color", "stroke_color", "thickness_multiplier", "alpha"]:
            assert key in params, f"風格 '{s}' 缺少欄位 '{key}'"
    print("PASS: 所有風格參數欄位完整")

def test_draw_selector_output():
    import numpy as np
    from modules.style_manager import draw_selector
    fake = np.zeros((720, 1280, 3), dtype=np.uint8)
    result = draw_selector(fake)
    assert result.shape == fake.shape
    print("PASS: draw_selector 輸出尺寸正確")

if __name__ == "__main__":
    test_styles_loaded()
    test_set_style()
    test_params_has_required_keys()
    test_draw_selector_output()
    print("\n全部測試通過")
```

---

## 第四步：Day 4 整合 main.py

等其他人都開了 PR 並 merge 進 `dev` 之後，先 pull 最新版：

```bash
git checkout dev
git pull origin dev
git checkout feature/style-main
git merge dev
```

然後開啟 `main.py`，把整合邏輯填入：

```python
"""
main.py
負責人：組員 E
整合日：Day 4
"""
import cv2
import os
from config import CAM_INDEX, OUTPUT_DIR, CANVAS_W, CANVAS_H
from modules.hand_tracker import init as init_tracker, get_hand_state, release as release_tracker
from modules.canvas import init as init_canvas, draw_stroke, overlay_webcam, clear, save, stop_stroke
from modules.stroke_mapper import compute_stroke, reset as reset_mapper
from modules.perf_monitor import tick, draw_overlay, mark_input, mark_output
from modules.style_manager import get_params, draw_selector, handle_key, set_style, get_styles

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    init_tracker(CAM_INDEX)
    init_canvas(CAM_INDEX)

    print("啟動！按 1-4 切換風格，S 存圖，C 清畫布，Q 結束")

    cap = cv2.VideoCapture(CAM_INDEX)

    while cap.isOpened():
        tick()
        ret, frame = cap.read()
        if not ret:
            break

        # 取得手部狀態
        mark_input()
        state = get_hand_state()
        mark_output()

        # 計算筆觸參數
        stroke = compute_stroke(state["speed"], state["z"])

        # 取得目前風格
        params = get_params()
        color = params.get("stroke_color", [255, 255, 255])
        thickness = int(stroke["thickness"] * params.get("thickness_multiplier", 1.0))
        thickness = max(1, min(thickness, 40))

        # 畫筆觸
        if state["drawing"]:
            draw_stroke(state["x"], state["y"], thickness, tuple(color[::-1]))
        else:
            stop_stroke()
            reset_mapper()

        # 合成畫面
        display = overlay_webcam(frame, alpha=0.25)
        display = draw_selector(display)
        display = draw_overlay(display)
        cv2.imshow("Interactive Art", display)

        # 鍵盤控制
        key = cv2.waitKey(1) & 0xFF
        if handle_key(key):
            clear()
        elif key == ord('s'):
            save()
        elif key == ord('c'):
            clear()
        elif key == ord('q'):
            break

    release_tracker()
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
```

---

## 第五步：上傳到 GitHub

```bash
# Day 1–3：風格模組
git add modules/style_manager.py assets/styles.json tests/test_style.py
git commit -m "feat: 完成 style_manager 與四種風格參數設計"

git add assets/style_油畫.png assets/style_素描.png assets/style_水墨.png assets/style_名畫風.png
git commit -m "docs: 新增四種風格視覺截圖"

# Day 4：整合
git add main.py
git commit -m "feat: Day 4 整合完成，main.py 可完整執行"

git push origin feature/style-main
```

---

## 第六步：開 Pull Request

1. 進 GitHub repo 頁面
2. 點 `Compare & pull request`
3. Base 選 `dev`，compare 選 `feature/style-main`
4. 標題填：`feat: 完成 style_manager 與整合 main.py`
5. 點 `Create pull request`

整合完 PR merge 進 `dev` 後，再由你從 `dev` 開一個 PR 到 `main`，代表這週的里程碑完成。

---

## 交付物清單

- [ ] `modules/style_manager.py` — 四種風格可切換，UI 正常顯示
- [ ] `assets/styles.json` — 四種風格參數完整
- [ ] `tests/test_style.py` — 全部 PASS
- [ ] `assets/` 裡有四種風格截圖
- [ ] `main.py` — 整合完整，一鍵 `python main.py` 就能跑
