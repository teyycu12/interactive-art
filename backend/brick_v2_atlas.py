"""Strict local checks for brick_v2 print-only material atlases."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import cv2
import numpy as np


def _edge_density(panel: np.ndarray) -> float:
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    return float(np.mean(cv2.Canny(gray, 60, 150) > 0))


def _isolated_border_background(panel: np.ndarray) -> Tuple[bool, Dict[str, float]]:
    """Detect a garment silhouette drawn over a separate square background.

    A true edge-to-edge albedo normally carries its dominant base material from
    the border into the central UV area.  A complete dress/shirt illustration
    instead has one colour cluster around the border and almost none of that
    cluster in the centre.
    """
    height, width = panel.shape[:2]
    pixels = panel.reshape(-1, 3).astype(np.float32)
    cv2.setRNGSeed(20260803)
    _, labels, _ = cv2.kmeans(
        pixels,
        5,
        None,
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5),
        5,
        cv2.KMEANS_PP_CENTERS,
    )
    labels = labels.reshape(height, width)
    border_width = max(12, int(min(height, width) * 0.07))
    border = np.concatenate((
        labels[:border_width].reshape(-1),
        labels[-border_width:].reshape(-1),
        labels[:, :border_width].reshape(-1),
        labels[:, -border_width:].reshape(-1),
    ))
    counts = np.bincount(border, minlength=5)
    dominant = int(np.argmax(counts))
    border_fraction = float(np.mean(border == dominant))
    centre = labels[height // 4: 3 * height // 4, width // 4: 3 * width // 4]
    centre_fraction = float(np.mean(centre == dominant))
    isolation = border_fraction * max(0.0, 1.0 - centre_fraction)
    failed = border_fraction >= 0.58 and centre_fraction <= 0.10 and isolation >= 0.52
    return failed, {
        "border_dominant_fraction": round(border_fraction, 4),
        "centre_same_fraction": round(centre_fraction, 4),
        "background_isolation": round(isolation, 4),
    }

def _low_frequency_band_shift(panel: np.ndarray) -> Tuple[bool, Dict[str, float]]:
    """Reject smooth left/right colour bands that behave like baked lighting."""
    _, width = panel.shape[:2]
    quartiles = [panel[:, index * width // 4: (index + 1) * width // 4] for index in range(4)]
    medians = [np.median(item.reshape(-1, 3), axis=0) for item in quartiles]
    lab = cv2.cvtColor(np.uint8([medians]), cv2.COLOR_BGR2LAB)[0].astype(np.float32)
    shifts = [float(np.linalg.norm(lab[index] - lab[index + 1])) for index in range(3)]
    edge_density = _edge_density(panel)
    maximum = max(shifts)
    # Strong low-frequency bands with almost no real printed edges are usually
    # generated shading, not a stripe/pocket/zipper pattern from the garment.
    failed = maximum >= 14.0 and edge_density <= 0.018
    return failed, {
        "max_quartile_lab_shift": round(maximum, 3),
        "edge_density": round(edge_density, 4),
    }


def validate_brick_v2_print_panels(panels: Dict[str, np.ndarray]) -> Dict[str, Any]:
    required = ("face", "torso_front", "left_leg_front", "right_leg_front")
    errors: List[str] = []
    metrics: Dict[str, Any] = {}
    for key in required:
        panel = panels.get(key)
        if not isinstance(panel, np.ndarray) or panel.size == 0:
            errors.append(f"{key}_missing")

    torso = panels.get("torso_front")
    if isinstance(torso, np.ndarray) and torso.size:
        failed, result = _isolated_border_background(torso)
        metrics["torso_background"] = result
        if failed:
            errors.extend(("torso_contains_garment_silhouette", "torso_background_contamination"))

    for key in ("torso_front", "left_leg_front", "right_leg_front"):
        panel = panels.get(key)
        if not isinstance(panel, np.ndarray) or not panel.size:
            continue
        failed, result = _low_frequency_band_shift(panel)
        metrics[f"{key}_band_shift"] = result
        if failed:
            errors.append(f"{key}_baked_low_frequency_shading")

    return {
        "passed": not errors,
        "errors": sorted(set(errors)),
        "warnings": [],
        "metrics": metrics,
        "validator": "brick_v2_print_v1",
    }
