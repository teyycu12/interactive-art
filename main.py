"""
main.py
負責人：組員 E
功能：整合所有模組，主程式入口
Day 4 整合後填入完整邏輯
"""
import cv2
from config import CAM_INDEX, OUTPUT_DIR
from modules.hand_tracker import get_hand_state, release
from modules.canvas import draw_stroke, overlay_webcam, clear, save
from modules.stroke_mapper import compute_stroke
from modules.perf_monitor import tick, draw_overlay
from modules.style_manager import get_params, draw_selector, set_style

def main():
    cap = cv2.VideoCapture(CAM_INDEX)
    print("啟動中... 按 Q 結束，按 S 儲存，按 C 清除畫布")

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        # TODO: 組員 E 在 Day 4 填入整合邏輯

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    release()
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
```

---

**`requirements.txt`**
```
mediapipe>=0.10.0
opencv-python>=4.8.0
numpy>=1.24.0
