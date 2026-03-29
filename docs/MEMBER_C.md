# 組員 C 工作說明｜速度映射與筆觸參數

## 你負責的模組
`modules/stroke_mapper.py` `tests/test_stroke.py`

---

## 你的任務目標

根據手部移動速度和 Z 軸深度，計算出即時的筆觸粗細和透明度。你的模組**完全不需要接手部偵測**，全程用假數字測試，Day 1 就能開始。

**完成細項：**
- 速度（px/s）→ 筆觸粗細的映射邏輯
- Z 軸深度 → 額外的粗細加成
- 平滑演算法（避免筆觸跳動）
- 三組參數的視覺對比截圖

---

## 第一步：環境安裝

```bash
pip install numpy opencv-python
```

---

## 第二步：克隆 repo 並開啟分支

```bash
git clone https://github.com/你的帳號/interactive-art.git
cd interactive-art
git checkout dev
git checkout -b feature/stroke-mapper
```

---

## 第三步：逐步完成功能

### Day 1 — 映射邏輯

開啟 `modules/stroke_mapper.py`，填入：

```python
"""
stroke_mapper.py
負責人：組員 C
功能：手部移動速度與 Z 軸深度映射為筆觸參數
"""
import numpy as np
from config import SPEED_MIN, SPEED_MAX, THICKNESS_MIN, THICKNESS_MAX, SMOOTH_FACTOR

_prev_thickness = float(THICKNESS_MIN)

def compute_stroke(speed: float, z: float) -> dict:
    """
    輸入速度（px/s）和 Z 軸值，輸出筆觸參數。

    速度慢 → 細線（控制感）
    速度快 → 粗線（奔放感）
    手靠近鏡頭（Z 為負）→ 粗細加成
    """
    global _prev_thickness

    # 1. 速度映射到基礎粗細（線性映射）
    speed_clamped = np.clip(speed, SPEED_MIN, SPEED_MAX)
    base_thickness = np.interp(
        speed_clamped,
        [SPEED_MIN, SPEED_MAX],
        [THICKNESS_MIN, THICKNESS_MAX]
    )

    # 2. Z 軸加成：手靠近（z 為負值）時增加粗細
    # MediaPipe Z 約在 -0.3（近）到 0.3（遠）
    z_clamped = np.clip(z, -0.3, 0.3)
    z_bonus = np.interp(z_clamped, [-0.3, 0.3], [4, 0])  # 最多加 4px
    raw_thickness = base_thickness + z_bonus

    # 3. 平滑處理（避免粗細跳動）
    smooth_thickness = smooth(raw_thickness, _prev_thickness)
    _prev_thickness = smooth_thickness

    # 4. 透明度：速度越快越不透明（衝擊感）
    alpha = float(np.interp(speed_clamped, [SPEED_MIN, SPEED_MAX], [0.6, 1.0]))

    return {
        "thickness": int(round(smooth_thickness)),
        "alpha": alpha,
        "color_mod": float(z_bonus / 4.0)  # 0.0–1.0，供風格模組調色用
    }

def smooth(value: float, prev: float) -> float:
    """指數移動平均，讓數值變化更平滑"""
    return SMOOTH_FACTOR * prev + (1 - SMOOTH_FACTOR) * value

def reset() -> None:
    global _prev_thickness
    _prev_thickness = float(THICKNESS_MIN)
```

在終端機執行快速測試：
```bash
python -c "
import sys; sys.path.insert(0,'.')
from modules.stroke_mapper import compute_stroke
print('慢速:', compute_stroke(50, 0.0))
print('中速:', compute_stroke(300, 0.0))
print('快速:', compute_stroke(800, 0.0))
print('靠近:', compute_stroke(300, -0.2))
"
```

### Day 2 — 視覺化調參工具

建一個互動工具，讓你直接用滑鼠感受映射效果，找到最自然的參數：

```python
# 存成 tests/stroke_visual_test.py，不是正式測試，是調參用的工具
import sys
sys.path.insert(0, '.')
import cv2
import numpy as np
from modules.stroke_mapper import compute_stroke, reset

W, H = 1280, 720
canvas = np.zeros((H, W, 3), dtype=np.uint8)
prev_x, prev_y = None, None
prev_time = 0

def mouse_callback(event, x, y, flags, param):
    global prev_x, prev_y, canvas
    import time

    if event == cv2.EVENT_MOUSEMOVE and (flags & cv2.EVENT_FLAG_LBUTTON):
        if prev_x is not None:
            dt = max(time.perf_counter() - globals().get('_t', time.perf_counter()), 0.001)
            speed = ((x-prev_x)**2 + (y-prev_y)**2)**0.5 / dt
            result = compute_stroke(speed, 0.0)
            t = result["thickness"]
            cv2.line(canvas, (prev_x, prev_y), (x, y), (255, 255, 255), t, cv2.LINE_AA)
            # 顯示數值
            cv2.putText(canvas, f"speed:{speed:.0f} thick:{t}", (10, 30),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 200, 100), 1)
        prev_x, prev_y = x, y
    elif event == cv2.EVENT_LBUTTONUP:
        prev_x, prev_y = None, None

cv2.namedWindow("stroke test")
cv2.setMouseCallback("stroke test", mouse_callback)

while True:
    cv2.imshow("stroke test", canvas)
    key = cv2.waitKey(1) & 0xFF
    if key == ord('c'):
        canvas = np.zeros((H, W, 3), dtype=np.uint8)
        reset()
    elif key == ord('s'):
        cv2.imwrite("assets/stroke_test.png", canvas)
        print("存圖完成")
    elif key == ord('q'):
        break
cv2.destroyAllWindows()
```

執行並畫畫，觀察速度和粗細的對應感不感覺對：
```bash
python tests/stroke_visual_test.py
```

如果覺得「快速時不夠粗」就把 `THICKNESS_MAX` 調大，「慢速太細」就把 `THICKNESS_MIN` 調大。調好後更新 `config.py`。

截三張圖存起來：`assets/param_conservative.png`、`assets/param_default.png`、`assets/param_expressive.png`

### Day 3 — 測試腳本

開啟 `tests/test_stroke.py`：

```python
"""
test_stroke.py — 組員 C 的獨立測試
執行：python tests/test_stroke.py
"""
import sys
sys.path.insert(0, '.')
from modules.stroke_mapper import compute_stroke, smooth, reset
from config import THICKNESS_MIN, THICKNESS_MAX

def test_output_keys():
    result = compute_stroke(300.0, 0.0)
    for key in ["thickness", "alpha", "color_mod"]:
        assert key in result, f"缺少欄位：{key}"
    print("PASS: 輸出欄位正確")

def test_thickness_range():
    for speed in [0, 50, 300, 800, 1000]:
        result = compute_stroke(float(speed), 0.0)
        t = result["thickness"]
        assert THICKNESS_MIN - 1 <= t <= THICKNESS_MAX + 5, \
            f"speed={speed} 時 thickness={t} 超出預期範圍"
    print("PASS: 粗細在合理範圍內")

def test_fast_thicker_than_slow():
    reset()
    slow = compute_stroke(50.0, 0.0)["thickness"]
    reset()
    fast = compute_stroke(800.0, 0.0)["thickness"]
    assert fast >= slow, f"快速({fast})應該比慢速({slow})粗"
    print("PASS: 快速比慢速粗")

def test_close_hand_adds_thickness():
    reset()
    far = compute_stroke(300.0, 0.3)["thickness"]
    reset()
    close = compute_stroke(300.0, -0.3)["thickness"]
    assert close >= far, f"靠近({close})應該比遠離({far})粗"
    print("PASS: 靠近鏡頭時筆觸更粗")

def test_smooth_converges():
    val = smooth(10.0, 2.0)
    assert 2.0 < val < 10.0, "平滑結果應在前後值之間"
    print("PASS: smooth() 在合理範圍")

if __name__ == "__main__":
    test_output_keys()
    test_thickness_range()
    test_fast_thicker_than_slow()
    test_close_hand_adds_thickness()
    test_smooth_converges()
    print("\n全部測試通過")
```

執行：
```bash
python tests/test_stroke.py
```

---

## 第四步：上傳到 GitHub

```bash
git add modules/stroke_mapper.py
git commit -m "feat: 完成速度與 Z 軸映射邏輯"

git add tests/test_stroke.py
git commit -m "test: 新增 test_stroke 測試腳本"

git add assets/param_default.png assets/param_conservative.png assets/param_expressive.png
git commit -m "docs: 新增三組映射參數視覺對比截圖"

git push origin feature/stroke-mapper
```

---

## 第五步：開 Pull Request

1. 進 GitHub repo 頁面
2. 點 `Compare & pull request`
3. Base 選 `dev`，compare 選 `feature/stroke-mapper`
4. 標題填：`feat: 完成 stroke_mapper 模組`
5. 說明裡貼三組截圖，說明建議用哪組參數
6. 點 `Create pull request`，通知組員 E

---

## 交付物清單

- [ ] `modules/stroke_mapper.py` — 映射邏輯完整，平滑處理正常
- [ ] `tests/test_stroke.py` — 全部 PASS
- [ ] `assets/` 裡有三張參數對比截圖
- [ ] PR 說明裡有建議採用的參數組合與理由
