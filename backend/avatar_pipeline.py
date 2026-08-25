"""
generate_avatar 流程中的純資料處理邏輯。

從 app.py 的 handle_generate_avatar 抽出。原本那個函式 313 行、涵蓋約 10 種
職責，且與 request.sid / socketio.emit 焊死，因此完全無法測試 —— 它同時也是
整個後端最容易在展場出事的一段。這裡先抽出「不碰 socket、不碰全域狀態」的
純函式部分，讓它們可以被單獨驗證；編排流程仍留在 app.py。

此模組刻意不 import flask 或 socketio。
"""

import base64
import io
from typing import Any, Dict, Optional, Tuple

try:
    import cv2  # type: ignore
except ImportError:
    cv2 = None  # type: ignore

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore


# VLM 顏色名稱 → hex（取代 CV 取色）
HAIR_HEX = {
    "black": "#1C1008", "dark_brown": "#3B2314", "brown": "#6B3A2A",
    "light_brown": "#A0602A", "blonde": "#D4A843", "red": "#A0391A",
    "gray": "#888888", "white": "#E8E0D8",
}
SKIN_HEX = {
    "fair": "#FFE5D0", "light": "#FFD0A8", "medium": "#D4956A",
    "tan": "#C08040", "brown": "#8D5524", "dark": "#4A2912",
}
EYE_HEX = {
    "dark_brown": "#3B1C12", "brown": "#7A4A28", "hazel": "#8B6914",
    "green": "#4A7A50", "blue": "#4472A8", "gray": "#6B7A8D",
}

_LONG_SLEEVE_OUTERS = {"blazer", "cardigan", "denim_jacket"}
_LONG_SLEEVE_INNERS = {"button_up"}


def normalize_base64_image(img_str: str) -> bytes:
    """把前端送來的 data URL / 裸 base64 正規化成位元組。

    兩個實務上必要的修正：
    - 傳輸過程常把 '+' 解成空格，必須還原
    - 前端有時送出未補齊 padding 的 base64
    """
    if not img_str:
        raise ValueError("empty image string")
    b64 = img_str.split(",", 1)[1] if img_str.startswith("data:image") else img_str
    b64 = b64.replace(" ", "+")
    pad = len(b64) % 4
    if pad:
        b64 += "=" * (4 - pad)
    return base64.b64decode(b64)


def decode_frame(img_str: str) -> Tuple[Optional[Any], Optional[str]]:
    """base64 → OpenCV BGR frame。回傳 (frame, error)；成功時 error 為 None。

    先走 Pillow（支援 iPhone 的 HEIC），失敗再退回 OpenCV。

    注意：原本 app.py 的版本在 except 區塊直接使用 img_bytes，但若例外發生在
    b64decode 本身，該變數尚未定義 —— OpenCV 後備路徑會因 NameError 而靜默
    失效。這裡先解出位元組再進入解碼，兩條路徑都吃得到同一份資料。
    """
    if cv2 is None or np is None:
        return None, "opencv_or_numpy_missing"

    try:
        img_bytes = normalize_base64_image(img_str)
    except Exception as e:
        return None, f"base64_decode_failed: {e}"

    # 1) Pillow（含 HEIC 支援）
    try:
        try:
            from pillow_heif import register_heif_opener
            register_heif_opener()
        except ImportError:
            pass
        from PIL import Image
        pil_img = Image.open(io.BytesIO(img_bytes))
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")
        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR), None
    except Exception as pil_err:
        # 2) OpenCV 後備
        try:
            arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is not None:
                return frame, None
            return None, f"all_decoders_failed (pillow: {pil_err})"
        except Exception as cv_err:
            return None, f"all_decoders_failed (pillow: {pil_err}; opencv: {cv_err})"


def build_outfit_data(vlm_result: Optional[Dict[str, Any]],
                      cv_result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """合併 VLM 的服裝語意分類與 CV 的實際取色。

    覆寫規則：VLM 負責「這是什麼衣服」，CV 負責「實際是什麼顏色」，
    因此 CV 的 hex 會覆寫 VLM 的顏色欄位。

    ``ok`` 明確為 False 時，整包語意欄位一律丟棄，只保留 CV 量到的顏色。
    這與 build_face_data 的作法一致。少了這道檢查，任何在失敗回傳裡附帶
    服裝欄位的呼叫端都會讓捏造的款式流進生圖 prompt —— 而那看起來像是
    模型判斷錯誤，不像是呼叫失敗，現場沒有人會發現。
    """
    vlm_result = vlm_result if isinstance(vlm_result, dict) else {}
    outfit = {} if vlm_result.get("ok") is False else dict(vlm_result.get("outfit") or {})

    if isinstance(cv_result, dict):
        upper = cv_result.get("upper")
        if isinstance(upper, dict) and "hex" in upper:
            outfit["inner_color"] = upper["hex"]
        lower = cv_result.get("lower")
        if isinstance(lower, dict) and "hex" in lower:
            outfit["lower_color"] = lower["hex"]
    return outfit


def infer_sleeve_kind(outfit_data: Dict[str, Any],
                      cv_result: Optional[Dict[str, Any]]) -> str:
    """由 VLM 的服裝語意推斷袖長，比 CV 輪廓判斷可靠；否則退回 CV 結果。"""
    outer = (outfit_data.get("outer") or "none").lower()
    inner = (outfit_data.get("inner") or "tshirt").lower()
    if outer in _LONG_SLEEVE_OUTERS or inner in _LONG_SLEEVE_INNERS:
        return "long_sleeve"
    if isinstance(cv_result, dict):
        return cv_result.get("upper_type", "short_sleeve")
    return "short_sleeve"


def build_face_data(face_cv_result: Optional[Dict[str, Any]],
                    vlm_face_result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """合併 MediaPipe 的臉部幾何與 VLM 的外觀分類，顏色名稱轉為 hex。

    兩邊都可能失敗，任一邊有結果就用；都沒有則回傳空字典（呼叫端會視為無臉部資料）。
    """
    face: Dict[str, Any] = {}

    if isinstance(face_cv_result, dict) and face_cv_result.get("ok"):
        face.update({
            "face_shape":    face_cv_result.get("face_shape"),
            "eye_shape":     face_cv_result.get("eye_shape"),
            "eyebrow_style": face_cv_result.get("eyebrow_style"),
            "smile_score":   face_cv_result.get("smile_score"),
            "lip_color":     face_cv_result.get("lip_color"),
        })

    if isinstance(vlm_face_result, dict) and vlm_face_result.get("ok") and "face" in vlm_face_result:
        vf = vlm_face_result["face"] or {}
        face.update({
            "hair_style":      vf.get("hair_style", "short_straight"),
            "hair_color":      HAIR_HEX.get(vf.get("hair_color", "dark_brown"), "#3B2314"),
            "hair_color_name": vf.get("hair_color", "dark_brown"),
            "skin_tone":       SKIN_HEX.get(vf.get("skin_tone", "light"), "#FFD0A8"),
            "skin_tone_name":  vf.get("skin_tone", "light"),
            "eye_color":       EYE_HEX.get(vf.get("eye_color", "brown"), "#7A4A28"),
            "eye_color_name":  vf.get("eye_color", "brown"),
            "has_beard":       vf.get("has_beard", False),
            "beard_style":     vf.get("beard_style", "none"),
        })

    return face
