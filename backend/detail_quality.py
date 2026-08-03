"""Objective image-detail measurements for PersonaFlow A/B review.

These metrics do not decide whether a character resembles its source photo.
They measure whether the delivered render retains crisp lines, local texture
and colour variation at a normalized display size.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict

import cv2
import numpy as np
from PIL import Image


ANALYZER_VERSION = 1
NORMALIZED_SIZE = 768


def _normalized_foreground(path: Path) -> tuple[np.ndarray, np.ndarray]:
    rgba = np.asarray(Image.open(path).convert("RGBA"))
    alpha = rgba[:, :, 3]
    mask = alpha > 20
    if np.count_nonzero(mask) < 200:
        # Opaque JPEG-like outputs use visible non-white/non-black content.
        rgb = rgba[:, :, :3]
        distance_white = np.linalg.norm(rgb.astype(np.float32) - 255.0, axis=2)
        distance_black = np.linalg.norm(rgb.astype(np.float32), axis=2)
        mask = (distance_white > 20) & (distance_black > 20)
    ys, xs = np.where(mask)
    if not len(xs):
        raise ValueError("no_foreground")
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    rgb_crop = rgba[y0:y1, x0:x1, :3]
    mask_crop = mask[y0:y1, x0:x1].astype(np.uint8) * 255

    height, width = rgb_crop.shape[:2]
    scale = min(NORMALIZED_SIZE / max(1, width), NORMALIZED_SIZE / max(1, height))
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    rgb_scaled = cv2.resize(rgb_crop, target, interpolation=cv2.INTER_LANCZOS4)
    mask_scaled = cv2.resize(mask_crop, target, interpolation=cv2.INTER_NEAREST)

    canvas = np.full((NORMALIZED_SIZE, NORMALIZED_SIZE, 3), 127, dtype=np.uint8)
    canvas_mask = np.zeros((NORMALIZED_SIZE, NORMALIZED_SIZE), dtype=np.uint8)
    left = (NORMALIZED_SIZE - target[0]) // 2
    top = (NORMALIZED_SIZE - target[1]) // 2
    canvas[top:top + target[1], left:left + target[0]] = rgb_scaled
    canvas_mask[top:top + target[1], left:left + target[0]] = mask_scaled
    return canvas, canvas_mask


def analyze_detail(path: Path) -> Dict[str, Any]:
    rgb, mask = _normalized_foreground(Path(path))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # Ignore silhouette outlines so a thick character border cannot masquerade
    # as garment/face detail.
    interior = cv2.erode(mask, np.ones((9, 9), np.uint8), iterations=1) > 0
    if np.count_nonzero(interior) < 500:
        interior = mask > 0

    edges = cv2.Canny(gray, 55, 135) > 0
    edge_density = float(np.count_nonzero(edges & interior)) / float(np.count_nonzero(interior))

    laplacian = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    sharpness = float(np.mean(np.square(laplacian[interior])))

    low_frequency = cv2.GaussianBlur(gray, (0, 0), 2.2)
    high_frequency = gray.astype(np.float32) - low_frequency.astype(np.float32)
    micro_contrast = float(np.std(high_frequency[interior]))

    values = gray[interior]
    histogram = np.bincount(values, minlength=256).astype(np.float64)
    probability = histogram[histogram > 0] / histogram.sum()
    entropy = float(-np.sum(probability * np.log2(probability)))

    # Calibrated saturation points are intentionally interpretable and capped.
    # Score 1.0 means the image reaches all detail targets; it is not an
    # aesthetic or identity-similarity score.
    edge_component = min(1.0, edge_density / 0.115)
    sharp_component = min(1.0, math.log1p(sharpness) / math.log1p(5200.0))
    contrast_component = min(1.0, micro_contrast / 18.0)
    entropy_component = min(1.0, entropy / 7.2)
    detail_score = (
        edge_component * 0.36
        + sharp_component * 0.28
        + contrast_component * 0.20
        + entropy_component * 0.16
    )
    return {
        "analyzer_version": ANALYZER_VERSION,
        "detail_score": round(detail_score, 3),
        "edge_density": round(edge_density, 4),
        "sharpness": round(sharpness, 2),
        "micro_contrast": round(micro_contrast, 2),
        "entropy": round(entropy, 3),
        "normalized_size": NORMALIZED_SIZE,
    }
