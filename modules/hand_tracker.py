"""
hand_tracker.py
負責人：組員 A
功能：MediaPipe 手部偵測、握拳判斷、剪影遮罩
"""
import cv2
import mediapipe as mp
import numpy as np
from config import MIN_CONFIDENCE

def get_hand_state() -> dict:
    """回傳 {"x": int, "y": int, "z": float, "drawing": bool, "speed": float}"""
    pass

def is_drawing() -> bool:
    pass

def get_silhouette_mask() -> np.ndarray:
    pass

def release() -> None:
    pass

if __name__ == "__main__":
    # mock 測試，組員 A 在這裡填測試邏輯
    print("hand_tracker 獨立測試")
