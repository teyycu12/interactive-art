"""
MediaPipe Pose Landmarker feature extraction.

使用 `mediapipe.tasks` 的 PoseLandmarker 取代影像分割，
以雙肩、骨盆、雙膝等關節點推算衣服與褲子的採樣中心，直接在原圖擷取小區塊計算顏色。
"""

from __future__ import annotations

import base64
import os
import threading
import urllib.request
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

try:
    from mediapipe import Image, ImageFormat
    from mediapipe.tasks.python.core.base_options import BaseOptions
    from mediapipe.tasks.python.vision.pose_landmarker import (
        PoseLandmarker,
        PoseLandmarkerOptions,
    )

    _HAS_MEDIAPIPE_TASKS = True
except ModuleNotFoundError:
    _HAS_MEDIAPIPE_TASKS = False


_landmarker: Optional[Any] = None
_landmarker_lock = threading.Lock()

_MODEL_FILENAME = "pose_landmarker_lite.task"
_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    r, g, b = rgb
    return "#{:02X}{:02X}{:02X}".format(r, g, b)


def _resize_if_needed(frame: np.ndarray, max_width: int) -> Tuple[np.ndarray, float]:
    h, w = frame.shape[:2]
    if w <= max_width:
        return frame, 1.0
    scale = max_width / float(w)
    new_w = max_width
    new_h = max(1, int(h * scale))
    resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized, scale


def _get_backend_models_dir() -> str:
    return os.path.join(os.path.dirname(__file__), "models")


def _download_if_missing(model_path: str, url: str, timeout_sec: int = 60) -> None:
    if os.path.exists(model_path):
        return

    os.makedirs(os.path.dirname(model_path), exist_ok=True)
    tmp_path = model_path + ".download"

    req_timeout = timeout_sec
    with urllib.request.urlopen(url, timeout=req_timeout) as resp:
        with open(tmp_path, "wb") as f:
            f.write(resp.read())

    os.replace(tmp_path, model_path)


def _get_landmarker(*, allow_download: bool = True) -> Any:
    global _landmarker
    if _landmarker is not None:
        return _landmarker

    if not _HAS_MEDIAPIPE_TASKS:
        raise ModuleNotFoundError("mediapipe.tasks 未可用，請確認 mediapipe 安裝正確。")

    with _landmarker_lock:
        if _landmarker is not None:
            return _landmarker

        model_path = os.path.join(_get_backend_models_dir(), _MODEL_FILENAME)
        if not os.path.exists(model_path):
            if not allow_download:
                raise FileNotFoundError(
                    f"缺少模型檔：{model_path}；請手動下載 {_MODEL_FILENAME}。"
                )
            _download_if_missing(model_path, _MODEL_URL)

        base_options = BaseOptions(model_asset_path=model_path)
        options = PoseLandmarkerOptions(
            base_options=base_options,
            output_segmentation_masks=False,
        )
        _landmarker = PoseLandmarker.create_from_options(options)
        return _landmarker


def _extract_stencil(img: np.ndarray, cx: float, cy: float, p_size: int) -> Optional[str]:
    """從影像中心點擷取一個帶羽化遮罩的矩形區塊，編碼為 base64 PNG，供 VLM 使用。"""
    h, w = img.shape[:2]
    px = int(cx * w)
    py = int(cy * h)
    half = int(p_size)

    x1 = max(0, px - half)
    x2 = min(w, px + half)
    y1 = max(0, py - half)
    y2 = min(h, py + half)

    if x2 <= x1 or y2 <= y1:
        return None

    patch = img[y1:y2, x1:x2]
    if patch.size == 0:
        return None

    ph, pw = patch.shape[:2]
    Y, X = np.ogrid[:ph, :pw]
    dist = np.sqrt((X - pw / 2.0) ** 2 + (Y - ph / 2.0) ** 2)
    max_r = min(pw / 2.0, ph / 2.0)
    alpha = np.clip(1.0 - (dist / max_r) ** 2, 0, 1) * 255.0

    rgba = cv2.cvtColor(patch, cv2.COLOR_RGB2RGBA)
    rgba[:, :, 3] = alpha.astype(np.uint8)

    success, buffer = cv2.imencode(".png", cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    if not success:
        return None
    return base64.b64encode(buffer).decode("utf-8")


def _sample_grid_with_mask(
    img: np.ndarray,
    poly_pts_norm: np.ndarray,
    grid_cols: int,
    grid_rows: int,
    min_coverage: float = 0.20,
    n_colors: int = 5,
) -> Dict[str, Any]:
    """
    三步驟格柵取樣：
      1. 對輪廓遮罩內所有像素做 K-Means(k=n_colors) → 取得色彩調色盤
         （消除光線差異：同色衣服的輕微亮度/色差被吸收至同一調色盤顏色）
      2. 每格以中位數映射到最近調色盤顏色（而非直接使用原始像素色）
      3. BFS 邊緣延伸：inactive 格（輪廓外或覆蓋率不足）
         從最近 active 格取調色盤索引，自動補全邊緣至完整矩形
    """
    h, w = img.shape[:2]

    px_pts = (poly_pts_norm * np.array([w, h], dtype=np.float32)).astype(np.int32)

    bb_x1 = max(0, int(px_pts[:, 0].min()))
    bb_y1 = max(0, int(px_pts[:, 1].min()))
    bb_x2 = min(w, int(px_pts[:, 0].max()))
    bb_y2 = min(h, int(px_pts[:, 1].max()))

    def _inactive_grid() -> Dict[str, Any]:
        return {
            "cols": grid_cols, "rows": grid_rows,
            "cells": [{"r": 128, "g": 128, "b": 128, "active": False}
                      for _ in range(grid_cols * grid_rows)],
        }

    if bb_x2 <= bb_x1 or bb_y2 <= bb_y1:
        return _inactive_grid()

    # ── 步驟 1：建立多邊形遮罩，對所有 mask 內像素做 K-Means ──
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [px_pts], 255)

    valid_all = img[mask == 255]  # (N, 3) RGB
    if len(valid_all) < n_colors * 4:
        return _inactive_grid()

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, _lbl, centers = cv2.kmeans(
        np.float32(valid_all), n_colors, None, criteria, 5,
        cv2.KMEANS_PP_CENTERS,
    )
    # centers: (n_colors, 3) float32, RGB

    # 對調色盤做一次性飽和度提升（所有格子統一，保持色彩一致性）
    enhanced = np.empty((n_colors, 3), dtype=np.uint8)
    for i, c in enumerate(centers):
        r_c, g_c, b_c = int(round(float(c[0]))), int(round(float(c[1]))), int(round(float(c[2])))
        hsv = cv2.cvtColor(np.uint8([[[r_c, g_c, b_c]]]), cv2.COLOR_RGB2HSV)[0][0]
        hsv[1] = min(255, int(hsv[1] * 1.35))
        if hsv[2] < 40:
            hsv[2] = min(255, int(hsv[2] * 1.3))
        enhanced[i] = cv2.cvtColor(np.uint8([[hsv]]), cv2.COLOR_HSV2RGB)[0][0]
    enh_f = enhanced.astype(np.float32)  # for distance computation

    # ── 步驟 2：逐格以中位數映射到最近調色盤顏色 ──
    bb_w = bb_x2 - bb_x1
    bb_h = bb_y2 - bb_y1
    cell_w = bb_w / grid_cols
    cell_h = bb_h / grid_rows

    # ci_grid: -1 = inactive, 0~n_colors-1 = palette index
    ci_grid = np.full((grid_rows, grid_cols), -1, dtype=np.int32)

    for row in range(grid_rows):
        for col in range(grid_cols):
            cx1 = bb_x1 + int(col * cell_w)
            cy1 = bb_y1 + int(row * cell_h)
            cx2 = min(w, bb_x1 + int((col + 1) * cell_w))
            cy2 = min(h, bb_y1 + int((row + 1) * cell_h))

            if cx2 <= cx1 or cy2 <= cy1:
                continue

            cell_mask = mask[cy1:cy2, cx1:cx2]
            valid_px = img[cy1:cy2, cx1:cx2][cell_mask == 255]

            total = cell_mask.size
            if total == 0 or len(valid_px) / total < min_coverage:
                continue  # stays -1

            # 中位數映射：比均值更抗條紋邊緣雜訊
            med = np.median(valid_px, axis=0)
            dists = np.linalg.norm(enh_f - med, axis=1)
            ci_grid[row, col] = int(np.argmin(dists))

    # ── 步驟 3：BFS 邊緣延伸 ──
    # 從所有 active 格出發，向 4 方向擴散，填補 inactive 格
    q: deque = deque()
    for r in range(grid_rows):
        for c in range(grid_cols):
            if ci_grid[r, c] >= 0:
                q.append((r, c))

    while q:
        r, c = q.popleft()
        ci = ci_grid[r, c]
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < grid_rows and 0 <= nc < grid_cols and ci_grid[nr, nc] < 0:
                ci_grid[nr, nc] = ci
                q.append((nr, nc))

    # ── 建立最終格柵 ──
    cells: List[Dict[str, Any]] = []
    for row in range(grid_rows):
        for col in range(grid_cols):
            ci = ci_grid[row, col]
            if ci < 0:
                # BFS 未觸達（極端情況：整個多邊形無 active 格）
                cells.append({"r": 128, "g": 128, "b": 128, "active": False})
            else:
                ec = enhanced[ci]
                cells.append({
                    "r": int(ec[0]), "g": int(ec[1]), "b": int(ec[2]),
                    "active": True,
                })

    return {"cols": grid_cols, "rows": grid_rows, "cells": cells}


def get_clothing_features(
    frame: np.ndarray,
    *,
    max_width: int = 480,
    allow_download: bool = True,
    patch_size: int = 40,
) -> Dict[str, Any]:
    """
    從影像擷取人體骨架，計算使用者上半身與下半身衣著區域的顏色格柵。
    使用輪廓遮罩過濾，確保每格只採計輪廓內像素，避免邊緣背景污染。
    """

    if frame is None or frame.size == 0:
        return {"ok": False, "error": "empty_frame"}

    # 縮放以提升效能
    resized, _scale = _resize_if_needed(frame, max_width=max_width)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)

    landmarker = _get_landmarker(allow_download=allow_download)
    mp_image = Image(image_format=ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_image)

    if not result.pose_landmarks or len(result.pose_landmarks) == 0:
        return {"ok": False, "error": "no_person_detected"}

    lm = result.pose_landmarks[0]

    # ── 關節點座標（正規化 0-1）──
    # 11=左肩 12=右肩 23=左髖 24=右髖 25=左膝 26=右膝
    lsho = np.array([lm[11].x, lm[11].y])
    rsho = np.array([lm[12].x, lm[12].y])
    lhip = np.array([lm[23].x, lm[23].y])
    rhip = np.array([lm[24].x, lm[24].y])
    lkne = np.array([lm[25].x, lm[25].y])
    rkne = np.array([lm[26].x, lm[26].y])
    lank = np.array([lm[27].x, lm[27].y])
    rank = np.array([lm[28].x, lm[28].y])

    shoulder_dist = abs(lm[11].x - lm[12].x)
    # 動態 patch size（用於 fallback 單色採樣）
    dynamic_patch_size = max(10, min(60, int(shoulder_dist * rgb.shape[1] * 0.3)))

    # ── 上衣輪廓多邊形（6 頂點，順時針）──
    # 加入少量偏移讓輪廓內縮，避免手臂/背景混入
    collar_shrink = 0.015   # 領口內縮
    side_shrink   = 0.012   # 側邊內縮
    bottom_shrink = 0.010   # 下擺內縮

    upper_poly = np.array([
        [lsho[0] + collar_shrink,  lsho[1] + collar_shrink],   # 左肩
        [rsho[0] - collar_shrink,  rsho[1] + collar_shrink],   # 右肩
        [rhip[0] - side_shrink,    rhip[1] - bottom_shrink],   # 右髖
        [(lhip[0] + rhip[0]) / 2,  (lhip[1] + rhip[1]) / 2 - bottom_shrink],  # 正中下擺
        [lhip[0] + side_shrink,    lhip[1] - bottom_shrink],   # 左髖
    ], dtype=np.float32)

    # ── 下半身輪廓多邊形──
    # 使用 髖→膝 / 髖→踝 之間區段
    if lkne[1] > lhip[1] and rkne[1] > rhip[1]:
        # 正常偵測到膝蓋
        lower_poly = np.array([
            [lhip[0] + side_shrink,  lhip[1]],
            [rhip[0] - side_shrink,  rhip[1]],
            [rkne[0] - side_shrink,  rkne[1]],
            [lkne[0] + side_shrink,  lkne[1]],
        ], dtype=np.float32)
    else:
        # Fallback：髖部往下推算 0.2 高度
        h_norm = abs(lhip[1] - lsho[1])
        lower_poly = np.array([
            [lhip[0] + side_shrink,  lhip[1]],
            [rhip[0] - side_shrink,  rhip[1]],
            [rhip[0] - side_shrink,  rhip[1] + h_norm * 0.6],
            [lhip[0] + side_shrink,  lhip[1] + h_norm * 0.6],
        ], dtype=np.float32)

    # ── 格柵取樣 ──
    # 上衣：32 欄 × 40 列（水平條紋/垂直條紋都能清楚捕捉）
    cloth_grid = _sample_grid_with_mask(rgb, upper_poly, grid_cols=32, grid_rows=40)
    # 下半身：24 欄 × 30 列
    lower_grid = _sample_grid_with_mask(rgb, lower_poly, grid_cols=24, grid_rows=30)

    # ── 保留單色 fallback（取格柵 active 格的中位數）──
    def _grid_dominant(grid: Dict) -> Dict[str, Any]:
        active = [c for c in grid["cells"] if c["active"]]
        if not active:
            return {"hex": "#808080", "rgb": [128, 128, 128]}
        rs = [c["r"] for c in active]
        gs = [c["g"] for c in active]
        bs = [c["b"] for c in active]
        r, g, b = int(np.median(rs)), int(np.median(gs)), int(np.median(bs))
        return {"hex": _rgb_to_hex((r, g, b)), "rgb": [r, g, b]}

    upper_color = _grid_dominant(cloth_grid)
    lower_color = _grid_dominant(lower_grid)

    # ── 服裝款式判斷（長/短袖、長/短褲）──
    def _px_color(img: np.ndarray, nx: float, ny: float, half: int = 8) -> np.ndarray:
        h, w = img.shape[:2]
        px, py = int(nx * w), int(ny * h)
        patch = img[max(0, py-half):min(h, py+half), max(0, px-half):min(w, px+half)]
        if patch.size == 0:
            return np.array([128, 128, 128])
        return np.median(patch.reshape(-1, 3), axis=0)

    forearm_pt = (lm[13].x + lm[14].x + lm[15].x + lm[16].x) / 4.0, \
                 (lm[13].y + lm[14].y + lm[15].y + lm[16].y) / 4.0
    calf_pt    = (lm[25].x + lm[26].x + lm[27].x + lm[28].x) / 4.0, \
                 (lm[25].y + lm[26].y + lm[27].y + lm[28].y) / 4.0

    forearm_col = _px_color(rgb, *forearm_pt)
    calf_col    = _px_color(rgb, *calf_pt)
    upper_arr   = np.array(upper_color["rgb"], dtype=float)

    def _col_dist(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.linalg.norm(a.astype(float) - b.astype(float)))

    upper_type = "long_sleeve" if _col_dist(upper_arr, forearm_col) < 50.0 else "short_sleeve"
    lower_type = "long_pants"  if _col_dist(np.array(lower_color["rgb"], dtype=float), calf_col) < 50.0 else "shorts"

    # ── stencil（保留舊邏輯用於 VLM 服裝識別）──
    torso_cx = float((lsho[0] + rsho[0] + lhip[0] + rhip[0]) / 4.0)
    torso_cy = float((lsho[1] + rsho[1] + lhip[1] + rhip[1]) / 4.0)
    stencil_base64 = _extract_stencil(rgb, torso_cx, torso_cy, dynamic_patch_size)

    landmarks_list = [
        {"x": l.x, "y": l.y, "v": getattr(l, "visibility", 1.0)}
        for l in lm
    ]

    # ── Full-body polygon (for OpenAI body-sprite generation) ──
    # Top = above shoulders so collar/hood is included; bottom = below ankles;
    # left/right = widest of shoulders / wrists / ankles so arms aren't clipped.
    top_y    = float(min(lsho[1], rsho[1])) - 0.05
    bottom_y = float(max(lank[1], rank[1])) + 0.05
    lwri_x = lm[15].x if lm[15].visibility > 0.3 else lsho[0]
    rwri_x = lm[16].x if lm[16].visibility > 0.3 else rsho[0]
    left_x  = float(min(lsho[0], rsho[0], lwri_x, rwri_x, lank[0], rank[0])) - 0.03
    right_x = float(max(lsho[0], rsho[0], lwri_x, rwri_x, lank[0], rank[0])) + 0.03
    body_poly = np.array([
        [left_x,  top_y],
        [right_x, top_y],
        [right_x, bottom_y],
        [left_x,  bottom_y],
    ], dtype=np.float32)

    return {
        "ok": True,
        "upper": upper_color,
        "lower": lower_color,
        "upper_type": upper_type,
        "lower_type": lower_type,
        "cloth_grid": cloth_grid,
        "lower_grid": lower_grid,
        "stencil": stencil_base64,
        "landmarks": landmarks_list,
        "roi": {
            "upper": {"x": torso_cx, "y": torso_cy, "size": dynamic_patch_size / float(rgb.shape[1])},
            "lower": {"x": float((lhip[0] + rhip[0]) / 2), "y": float((lhip[1] + rhip[1]) / 2),
                      "size": dynamic_patch_size / float(rgb.shape[1])},
        },
        # Normalised polygons (xy in 0..1) — used by garment_gen.py for cropping
        "upper_poly": upper_poly.tolist(),
        "lower_poly": lower_poly.tolist(),
        "body_poly":  body_poly.tolist(),
    }


def extract_features(frame: np.ndarray) -> Dict[str, Any]:
    return get_clothing_features(frame)
