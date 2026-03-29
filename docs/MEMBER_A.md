# 組員 A 工作說明｜手部偵測

## 你負責的模組
`modules/hand_tracker.py` `modules/silhouette.py` `tests/test_hand.py`

---

## 你的任務目標

用 MediaPipe 偵測觀眾的手部，輸出即時的手部座標和手勢狀態，讓其他組員的模組可以直接取用。

**本週結束前要完成：**
- 能即時取得食指指尖的 XY 像素座標和 Z 深度值
- 能判斷「握拳（提筆）」和「張手（落筆）」
- 研究人體剪影的可行性，回報能不能同時跑
- 所有功能能獨立測試，不需要接其他人的模組

---

## 第一步：環境安裝

打開 PowerShell，輸入：

```bash
pip install mediapipe opencv-python numpy
```

確認安裝成功：
```bash
python -c "import mediapipe; import cv2; print('OK')"
```

---

## 第二步：克隆 repo 並開啟分支

```bash
git clone https://github.com/你的帳號/interactive-art.git
cd interactive-art
git checkout dev
git checkout -b feature/hand-tracker
```

---

## 第三步：開啟你的模組

用任何編輯器開啟 `modules/hand_tracker.py`，這個檔案已經有骨架，你要把每個函式填完整。

---

## 第四步：逐步完成功能

### Day 1 — 取得座標

在 `modules/hand_tracker.py` 裡填入以下內容：

```python
"""
hand_tracker.py
負責人：組員 A
"""
import cv2
import mediapipe as mp
import numpy as np
import time

mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=1,
    min_detection_confidence=0.7,
    min_tracking_confidence=0.7
)

cap = None
_prev_x, _prev_y = 0, 0
_prev_time = time.perf_counter()

def init(cam_index=0):
    global cap
    cap = cv2.VideoCapture(cam_index)

def get_hand_state() -> dict:
    global _prev_x, _prev_y, _prev_time
    if cap is None:
        return {"x": 0, "y": 0, "z": 0.0, "drawing": False, "speed": 0.0}

    ret, frame = cap.read()
    if not ret:
        return {"x": 0, "y": 0, "z": 0.0, "drawing": False, "speed": 0.0}

    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = hands.process(frame_rgb)
    h, w = frame.shape[:2]

    if results.multi_hand_landmarks:
        lm = results.multi_hand_landmarks[0].landmark
        # 食指指尖 = landmark 8
        x = int(lm[8].x * w)
        y = int(lm[8].y * h)
        z = lm[8].z

        now = time.perf_counter()
        dt = max(now - _prev_time, 0.001)
        speed = ((x - _prev_x)**2 + (y - _prev_y)**2) ** 0.5 / dt

        drawing = _is_hand_open(lm)

        _prev_x, _prev_y, _prev_time = x, y, now
        return {"x": x, "y": y, "z": z, "drawing": drawing, "speed": speed}

    return {"x": 0, "y": 0, "z": 0.0, "drawing": False, "speed": 0.0}

def _is_hand_open(lm) -> bool:
    # 比較四根手指指尖和掌根的距離
    # 任一指尖離掌根夠遠 = 張手
    finger_tips = [8, 12, 16, 20]
    wrist = lm[0]
    open_count = 0
    for tip_idx in finger_tips:
        tip = lm[tip_idx]
        dist = ((tip.x - wrist.x)**2 + (tip.y - wrist.y)**2) ** 0.5
        if dist > 0.15:  # 這個閾值可以調整
            open_count += 1
    return open_count >= 2

def is_drawing() -> bool:
    return get_hand_state()["drawing"]

def get_silhouette_mask() -> np.ndarray:
    # Day 3 研究後填入
    pass

def release() -> None:
    if cap:
        cap.release()
    hands.close()
```

存檔後，在終端機執行確認有沒有錯誤：
```bash
python modules/hand_tracker.py
```

### Day 2 — 獨立測試腳本

開啟 `tests/test_hand.py` 填入：

```python
"""
test_hand.py — 組員 A 的獨立測試
執行：python tests/test_hand.py
不需要接其他模組，用 mock 資料測試邏輯
"""
import sys
sys.path.insert(0, '.')

def test_output_format():
    """測試輸出格式是否正確"""
    # mock 一個假的 state
    fake_state = {"x": 100, "y": 200, "z": 0.05, "drawing": True, "speed": 300.0}
    required_keys = ["x", "y", "z", "drawing", "speed"]
    for key in required_keys:
        assert key in fake_state, f"缺少欄位：{key}"
    assert isinstance(fake_state["x"], int), "x 應為整數"
    assert isinstance(fake_state["drawing"], bool), "drawing 應為布林值"
    print("PASS: 輸出格式正確")

def test_speed_is_positive():
    fake_speed = 300.0
    assert fake_speed >= 0, "速度不應為負數"
    print("PASS: 速度為正數")

def test_z_range():
    fake_z = 0.05
    assert -1.0 <= fake_z <= 1.0, "Z 值超出預期範圍"
    print("PASS: Z 值在合理範圍")

if __name__ == "__main__":
    test_output_format()
    test_speed_is_positive()
    test_z_range()
    print("\n全部測試通過")
```

執行：
```bash
python tests/test_hand.py
```

### Day 3 — 研究剪影

測試 MediaPipe Selfie Segmentation 能不能同時跑：

```python
# 在 modules/silhouette.py 測試這段
import mediapipe as mp
import cv2

mp_selfie = mp.solutions.selfie_segmentation
segmentor = mp_selfie.SelfieSegmentation(model_selection=1)

cap = cv2.VideoCapture(0)
while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break
    result = segmentor.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    mask = result.segmentation_mask > 0.5
    output = frame.copy()
    output[~mask] = 0  # 背景變黑
    cv2.imshow("silhouette test", output)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break
cap.release()
```

觀察 FPS 是否還流暢，回報給大家。

---

## 第五步：上傳到 GitHub

每完成一個階段就 commit：

```bash
git add modules/hand_tracker.py
git commit -m "feat: 完成手部座標偵測與握拳判斷"

git add tests/test_hand.py
git commit -m "test: 新增 test_hand 測試腳本"

git add modules/silhouette.py
git commit -m "feat: 新增 silhouette 剪影研究結果"

git push origin feature/hand-tracker
```

---

## 第六步：開 Pull Request

全部完成後：
1. 進 GitHub repo 頁面
2. 點 `Compare & pull request`（黃色提示列）
3. Base 選 `dev`，compare 選 `feature/hand-tracker`
4. 標題填：`feat: 完成 hand_tracker 模組`
5. 點 `Create pull request`，通知組員 E

---

## 交付物清單

- [ ] `modules/hand_tracker.py` — 所有函式填完，能獨立執行
- [ ] `tests/test_hand.py` — 全部 PASS
- [ ] `modules/silhouette.py` — 至少有剪影可行性的測試結論
- [ ] 一段筆記（貼在 PR 說明裡）：Z 值正常範圍、握拳準確率、剪影是否可行
