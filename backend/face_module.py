"""
MediaPipe FaceLandmarker-based face feature extraction.
Extracts skin tone, hair color, eye color, face/eye shape,
eyebrow style, and blendshape smile score.
"""
from __future__ import annotations

import os
import threading
import urllib.request
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np

try:
    from mediapipe.tasks.python.core.base_options import BaseOptions
    from mediapipe.tasks.python.vision.core.image import Image, ImageFormat
    from mediapipe.tasks.python.vision.face_landmarker import (
        FaceLandmarker,
        FaceLandmarkerOptions,
    )
    _HAS_MEDIAPIPE_FACE = True
except (ModuleNotFoundError, ImportError):
    _HAS_MEDIAPIPE_FACE = False

_face_landmarker: Optional[Any] = None
_face_lock = threading.Lock()

_MODEL_FILENAME = "face_landmarker.task"
_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return "#{:02X}{:02X}{:02X}".format(r, g, b)


def _get_models_dir() -> str:
    return os.path.join(os.path.dirname(__file__), "models")


def _download_if_missing(model_path: str, url: str, timeout: int = 120) -> None:
    if os.path.exists(model_path):
        return
    os.makedirs(os.path.dirname(model_path), exist_ok=True)
    tmp = model_path + ".download"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        with open(tmp, "wb") as f:
            f.write(resp.read())
    os.replace(tmp, model_path)


def _get_face_landmarker(*, allow_download: bool = True) -> Any:
    global _face_landmarker
    if _face_landmarker is not None:
        return _face_landmarker
    if not _HAS_MEDIAPIPE_FACE:
        raise ModuleNotFoundError("mediapipe.tasks 未可用，請確認 mediapipe 安裝正確。")
    with _face_lock:
        if _face_landmarker is not None:
            return _face_landmarker
        model_path = os.path.join(_get_models_dir(), _MODEL_FILENAME)
        if not os.path.exists(model_path):
            if not allow_download:
                raise FileNotFoundError(f"缺少模型：{model_path}")
            _download_if_missing(model_path, _MODEL_URL)
        base_opts = BaseOptions(model_asset_path=model_path)
        opts = FaceLandmarkerOptions(
            base_options=base_opts,
            num_faces=1,
            output_face_blendshapes=True,
        )
        _face_landmarker = FaceLandmarker.create_from_options(opts)
    return _face_landmarker


def _sample_color(rgb: np.ndarray, cx: float, cy: float, radius: int) -> Tuple[int, int, int]:
    h, w = rgb.shape[:2]
    px, py = int(cx * w), int(cy * h)
    x1, x2 = max(0, px - radius), min(w, px + radius)
    y1, y2 = max(0, py - radius), min(h, py + radius)
    if x2 <= x1 or y2 <= y1:
        return (200, 180, 160)
    patch = rgb[y1:y2, x1:x2]
    if patch.size == 0:
        return (200, 180, 160)
    mean = patch.reshape(-1, 3).mean(axis=0)
    return (int(mean[0]), int(mean[1]), int(mean[2]))


def get_face_features(
    frame: np.ndarray,
    *,
    max_width: int = 480,
    allow_download: bool = True,
) -> Dict[str, Any]:
    """
    Extract face-level features from a BGR frame.
    Returns skin_tone, hair_color, eye_color, lip_color,
    face_shape, eye_shape, eyebrow_style, smile_score.
    """
    if frame is None or frame.size == 0:
        return {"ok": False, "error": "empty_frame"}

    if frame.shape[1] > max_width:
        scale = max_width / frame.shape[1]
        frame = cv2.resize(
            frame,
            (max_width, int(frame.shape[0] * scale)),
            interpolation=cv2.INTER_AREA,
        )

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    try:
        landmarker = _get_face_landmarker(allow_download=allow_download)
    except Exception as e:
        return {"ok": False, "error": f"model_load: {e}"}

    mp_img = Image(image_format=ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_img)

    if not result.face_landmarks:
        return {"ok": False, "error": "no_face_detected"}

    lms = result.face_landmarks[0]

    def lm(i):
        return lms[i]

    # --- Geometry (normalized 0-1 coords) ---
    forehead  = lm(10)
    chin      = lm(152)
    l_temple  = lm(127)
    r_temple  = lm(356)
    l_jaw     = lm(172)
    r_jaw     = lm(397)

    face_w = abs(r_temple.x - l_temple.x)
    face_h = abs(chin.y - forehead.y)
    jaw_w  = abs(r_jaw.x - l_jaw.x)

    # Face shape
    wh_ratio  = face_w / max(face_h, 1e-6)
    jaw_ratio = jaw_w / max(face_w, 1e-6)
    if wh_ratio > 0.82:
        face_shape = "round"
    elif jaw_ratio > 0.85:
        face_shape = "square"
    else:
        face_shape = "oval"

    # Eye shape (use left eye landmarks)
    eye_top = lm(159)
    eye_bot = lm(145)
    eye_out = lm(33)
    eye_inn = lm(133)
    eye_openness = abs(eye_top.y - eye_bot.y)
    eye_width    = abs(eye_out.x - eye_inn.x)
    eye_ratio    = eye_openness / max(eye_width, 1e-6)
    if eye_ratio > 0.32:
        eye_shape = "round"
    elif eye_ratio < 0.20:
        eye_shape = "narrow"
    else:
        eye_shape = "almond"

    # Eyebrow style (proximity of brow to eye lid)
    brow_inner = lm(107)
    brow_gap   = abs(brow_inner.y - eye_top.y) / max(face_h, 1e-6)
    eyebrow_style = "thick" if brow_gap < 0.045 else "normal"

    # --- Color sampling ---
    l_cheek = lm(234)
    r_cheek = lm(454)
    s1 = _sample_color(rgb, l_cheek.x,  l_cheek.y,  12)
    s2 = _sample_color(rgb, r_cheek.x,  r_cheek.y,  12)
    s3 = _sample_color(rgb, forehead.x, max(0.01, forehead.y - 0.02), 10)
    skin_tone = _rgb_to_hex(
        (s1[0] + s2[0] + s3[0]) // 3,
        (s1[1] + s2[1] + s3[1]) // 3,
        (s1[2] + s2[2] + s3[2]) // 3,
    )

    # Hair: sample above forehead; fall back to temple if background bleed
    hair_y = max(0.01, forehead.y - face_h * 0.18)
    hair_rgb = _sample_color(rgb, forehead.x, hair_y, 20)
    if sum(hair_rgb) / 3 > 215:
        hair_rgb = _sample_color(rgb, l_temple.x - 0.04, l_temple.y - face_h * 0.08, 12)
    hair_color = _rgb_to_hex(*hair_rgb)

    # Eye iris: tiny sample at iris center
    iris_cx = (eye_out.x + eye_inn.x) / 2
    iris_cy = (eye_top.y + eye_bot.y) / 2
    eye_color = _rgb_to_hex(*_sample_color(rgb, iris_cx, iris_cy, 4))

    # Lip color: between lip landmarks
    upper_lip = lm(13)
    lower_lip = lm(14)
    mouth_l   = lm(61)
    mouth_r   = lm(291)
    lip_cx = (mouth_l.x + mouth_r.x) / 2
    lip_cy = (upper_lip.y + lower_lip.y) / 2
    lip_color = _rgb_to_hex(*_sample_color(rgb, lip_cx, lip_cy, 8))

    # --- Blendshapes ---
    smile_score = 0.0
    if result.face_blendshapes:
        bs = {b.category_name: b.score for b in result.face_blendshapes[0]}
        smile_score = max(
            bs.get("mouthSmileLeft", 0.0),
            bs.get("mouthSmileRight", 0.0),
        )

    return {
        "ok": True,
        "skin_tone":     skin_tone,
        "hair_color":    hair_color,
        "eye_color":     eye_color,
        "lip_color":     lip_color,
        "face_shape":    face_shape,
        "eye_shape":     eye_shape,
        "eyebrow_style": eyebrow_style,
        "smile_score":   round(smile_score, 3),
    }
