"""
canvas.py
負責人：組員 B
功能：OpenCV 畫布建立、筆觸繪製、webcam 疊加、存圖
"""
import cv2
import numpy as np
from config import CANVAS_W, CANVAS_H, OUTPUT_DIR

def draw_stroke(x: int, y: int, thickness: int, color: tuple) -> None:
    pass

def overlay_webcam(frame: np.ndarray, alpha: float) -> np.ndarray:
    pass

def clear() -> None:
    pass

def save(path: str) -> str:
    pass

if __name__ == "__main__":
    print("canvas 獨立測試")
