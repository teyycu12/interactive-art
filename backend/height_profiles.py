"""Calibrated visual height classes for a fixed PersonaFlow capture station."""

from __future__ import annotations

import os
from typing import Any, Dict


HEIGHT_PROFILES: Dict[str, Dict[str, float]] = {
    "short": {"display_scale": 0.90, "torso_scale_y": 0.96, "leg_scale_y": 0.90},
    "medium": {"display_scale": 1.00, "torso_scale_y": 1.00, "leg_scale_y": 1.00},
    "tall": {"display_scale": 1.10, "torso_scale_y": 1.02, "leg_scale_y": 1.12},
}


def get_height_thresholds() -> tuple[float, float]:
    # The capture guide was enlarged so a medium-height visitor occupies about
    # 90% of the image.  height_ratio is measured against that 90% calibrated
    # span, therefore a centred medium visitor is close to 1.0 (not 0.8).
    short_max = float(os.environ.get("HEIGHT_SHORT_MAX_RATIO", "0.95"))
    tall_min = float(os.environ.get("HEIGHT_TALL_MIN_RATIO", "1.05"))
    if not 0.0 < short_max < tall_min:
        return 0.95, 1.05
    return short_max, tall_min


def classify_height(height_ratio: float) -> str:
    short_max, tall_min = get_height_thresholds()
    if height_ratio < short_max:
        return "short"
    if height_ratio > tall_min:
        return "tall"
    return "medium"


def get_height_profile(height_class: str) -> Dict[str, Any]:
    key = height_class if height_class in HEIGHT_PROFILES else "medium"
    return {"id": key, **HEIGHT_PROFILES[key]}
