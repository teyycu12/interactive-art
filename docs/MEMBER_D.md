# 組員 D 工作說明｜效能測量

## 你負責的模組
`modules/perf_monitor.py` `tests/test_perf.py`

---

## 你的任務目標

測量系統效能（FPS 和延遲），提供教授看得懂的數據。同時研究展場配置方案。你的模組**不需要接任何其他模組**，從 Day 1 就能完全獨立進行。

**完成細項：**
- 效能測量模組（FPS、延遲、畫面顯示）
- 至少兩台電腦的 MediaPipe 基準測試數據

---

## 第一步：環境安裝

```bash
pip install mediapipe opencv-python numpy
```

---

## 第二步：克隆 repo 並開啟分支

```bash
git clone https://github.com/你的帳號/interactive-art.git
cd interactive-art
git checkout dev
git checkout -b feature/perf-monitor
```

---

## 第三步：逐步完成功能

### Day 1 — 效能測量模組

開啟 `modules/perf_monitor.py`，填入：

```python
"""
perf_monitor.py
負責人：組員 D
功能：FPS 測量、端到端延遲測量、數字疊加在畫面上
"""
import cv2
import time
import numpy as np
from collections import deque

# 用過去 30 幀算平均 FPS
_frame_times = deque(maxlen=30)
_last_tick = time.perf_counter()
_latency_ms = 0.0
_latency_start = 0.0

def tick() -> None:
    """每幀開始時呼叫，計算 FPS"""
    global _last_tick
    now = time.perf_counter()
    _frame_times.append(now - _last_tick)
    _last_tick = now

def mark_input() -> None:
    """手部座標讀取完成時呼叫（延遲計算起點）"""
    global _latency_start
    _latency_start = time.perf_counter()

def mark_output() -> None:
    """筆觸畫出時呼叫（延遲計算終點）"""
    global _latency_ms
    if _latency_start > 0:
        _latency_ms = (time.perf_counter() - _latency_start) * 1000

def get_fps() -> float:
    if not _frame_times:
        return 0.0
    avg = sum(_frame_times) / len(_frame_times)
    return 1.0 / avg if avg > 0 else 0.0

def get_latency() -> float:
    """回傳延遲（ms）"""
    return _latency_ms

def draw_overlay(frame: np.ndarray) -> np.ndarray:
    """在畫面左上角顯示 FPS 和延遲"""
    out = frame.copy()
    fps = get_fps()
    lat = get_latency()

    color = (0, 255, 0) if fps >= 25 else (0, 165, 255) if fps >= 15 else (0, 0, 255)

    cv2.putText(out, f"FPS: {fps:.1f}", (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    cv2.putText(out, f"Latency: {lat:.1f}ms", (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    return out
```

### Day 2 — 基準測試腳本

建一個獨立測試腳本，直接跑 MediaPipe 測量你電腦的效能：

```python
# 存成 tests/benchmark.py
"""
benchmark.py — MediaPipe 基準效能測試
執行：python tests/benchmark.py
測試完會在終端機印出結果，複製下來存進 docs/
"""
import sys
sys.path.insert(0, '.')
import cv2
import mediapipe as mp
import time
import numpy as np
from modules.perf_monitor import tick, get_fps, get_latency, mark_input, mark_output

mp_hands = mp.solutions.hands
hands = mp_hands.Hands(max_num_hands=1, min_detection_confidence=0.7)

cap = cv2.VideoCapture(0)
fps_log = []
latency_log = []

print("測試開始，60 秒後自動結束...")
start = time.time()

while time.time() - start < 60:
    tick()
    ret, frame = cap.read()
    if not ret:
        break

    mark_input()
    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = hands.process(frame_rgb)
    mark_output()

    fps = get_fps()
    lat = get_latency()
    if fps > 0:
        fps_log.append(fps)
    if lat > 0:
        latency_log.append(lat)

    display = frame.copy()
    from modules.perf_monitor import draw_overlay
    display = draw_overlay(display)
    cv2.imshow("benchmark", display)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
hands.close()

if fps_log and latency_log:
    print("\n===== 測試結果 =====")
    print(f"平均 FPS:     {np.mean(fps_log):.1f}")
    print(f"最低 FPS:     {np.min(fps_log):.1f}")
    print(f"平均延遲:     {np.mean(latency_log):.1f} ms")
    print(f"最高延遲:     {np.max(latency_log):.1f} ms")
    print("=====================")
    print("複製以上結果，填進 docs/PERF_REPORT.md")
```

在**自己的電腦**跑一次，記錄結果。如果能借到另一台電腦再跑一次，數據越多越好。

執行：
```bash
python tests/benchmark.py
```

### Day 3 — 整理測試結果 + 展場研究

**建立效能報告文件** `docs/PERF_REPORT.md`：

```markdown
# 效能測試報告

## 測試結果

| 硬體 | CPU | RAM | 平均 FPS | 最低 FPS | 平均延遲 | 體感流暢度（1-5）|
|---|---|---|---|---|---|---|
| 電腦 A | __ | __ | __ | __ | __ ms | __ |
| 電腦 B | __ | __ | __ | __ | __ ms | __ |

## 結論

在 __ 規格的電腦上，延遲約 __ ms，FPS 約 __，體驗 __。
建議展場使用至少 __ 規格的電腦。


```

把你測到的數字填進去。

### Day 3 — 測試腳本

開啟 `tests/test_perf.py`：

```python
"""
test_perf.py — 組員 D 的獨立測試
執行：python tests/test_perf.py
"""
import sys
sys.path.insert(0, '.')
import time
from modules.perf_monitor import tick, get_fps, get_latency, mark_input, mark_output, _frame_times

def test_fps_after_ticks():
    _frame_times.clear()
    for _ in range(10):
        tick()
        time.sleep(1/30)
    fps = get_fps()
    assert 20 <= fps <= 40, f"模擬 30fps 時應在 20-40 之間，實際：{fps:.1f}"
    print(f"PASS: FPS 計算正確（{fps:.1f}）")

def test_latency_measurement():
    mark_input()
    time.sleep(0.02)
    mark_output()
    lat = get_latency()
    assert 15 <= lat <= 40, f"模擬 20ms 延遲時應在 15-40ms，實際：{lat:.1f}ms"
    print(f"PASS: 延遲計算正確（{lat:.1f}ms）")

def test_draw_overlay_returns_frame():
    import numpy as np
    from modules.perf_monitor import draw_overlay
    fake = np.zeros((480, 640, 3), dtype=np.uint8)
    result = draw_overlay(fake)
    assert result.shape == fake.shape, "overlay 輸出尺寸應與輸入相同"
    print("PASS: draw_overlay 輸出尺寸正確")

if __name__ == "__main__":
    test_fps_after_ticks()
    test_latency_measurement()
    test_draw_overlay_returns_frame()
    print("\n全部測試通過")
```

執行：
```bash
python tests/test_perf.py
```

---

## 第四步：上傳到 GitHub

```bash
mkdir docs
git add modules/perf_monitor.py
git commit -m "feat: 完成效能測量模組"

git add tests/test_perf.py tests/benchmark.py
git commit -m "test: 新增效能測試腳本"


git push origin feature/perf-monitor
```

---

## 第五步：開 Pull Request

1. 進 GitHub repo 頁面
2. 點 `Compare & pull request`
3. Base 選 `dev`，compare 選 `feature/perf-monitor`
4. 標題填：`feat: 完成 perf_monitor 模組`
5. 說明裡直接貼效能測試數字
6. 點 `Create pull request`，通知組員 E

---

## 交付物清單

- [ ] `modules/perf_monitor.py` — FPS 和延遲測量正常
- [ ] `tests/test_perf.py` — 全部 PASS
- [ ] `tests/benchmark.py` — 能獨立跑基準測試
- [ ] `docs/PERF_REPORT.md` — 至少一台電腦的數據
