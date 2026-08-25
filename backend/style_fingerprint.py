"""Measurable style DNA for a UV panel, and its distance from the base standard.

Every previous check in this pipeline asked "is this one panel acceptable on its
own".  None of them asked "do these characters look like the same species", so
two panels could both pass and still read as different art styles side by side.

This module answers both questions with the same numbers:

* :func:`panel_fingerprint` measures the style of one panel.
* :func:`compare_to_base` scores it against the reference measurements in
  ``style_base.py``.
* :func:`fingerprint_spread` measures how far a *set* of characters has drifted
  from each other, which is the actual definition of species consistency.

Every panel is measured at :data:`CANONICAL_SIZE` so that a 452 px validator
crop, a 512 px UV panel and the reference render all produce comparable
numbers.  Without that, mask-based features drift by more than 70% across
resolutions and no band means anything.

Transfer confidence.  The base standard was measured on a render, not on a flat
UV panel, so not every feature carries over cleanly:

``direct``    the feature survives rescaling and means the same thing on a
              render and on a panel, so it can carry a hard threshold.
              ``directional_gradient`` varies by 5% and ``stroke_width_rel`` by
              3% across a 128 px to 512 px rescale of the reference face.
``indirect``  the number is comparable between candidates measured the same
              way, but not against the reference as a threshold -- the render
              carries silhouette and occlusion edges a flat panel does not.
              These features gate nothing on their own; their value is the
              spread across characters.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List

import cv2
import numpy as np

try:
    from backend.style_base import get_style_base  # type: ignore
except Exception:
    from style_base import get_style_base  # type: ignore

try:
    from backend.style_normalizer import directional_gradient  # type: ignore
except Exception:
    from style_normalizer import directional_gradient  # type: ignore


FINGERPRINT_VERSION = "style_fingerprint_v1"

# Mask-derived features are resolution sensitive, so every panel is measured at
# one working size.  256 sits between the 452 px validator crop and the 91 px
# reference face, keeping both rescales mild.
CANONICAL_SIZE = 256

# Which panel maps onto which measured region of the reference.
REGION_FOR_PANEL = {
    "face": "face",
    "torso_front": "garment_torso",
    "left_leg_front": "denim_leg",
    "right_leg_front": "denim_leg",
    "shoe_front": "shoe",
}

FEATURE_TRANSFER = {
    "directional_gradient": "direct",
    "stroke_width_rel": "direct",
    "mark_share": "indirect",
    "local_contrast": "indirect",
    "edge_density": "indirect",
    "saturation_median": "indirect",
}


def _canonical(panel: np.ndarray) -> np.ndarray:
    if panel.shape[0] == CANONICAL_SIZE and panel.shape[1] == CANONICAL_SIZE:
        return panel
    shrinking = min(panel.shape[:2]) >= CANONICAL_SIZE
    return cv2.resize(
        panel, (CANONICAL_SIZE, CANONICAL_SIZE),
        interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR,
    )


def _mark_mask(light: np.ndarray) -> np.ndarray:
    """Printed marks of either polarity: dark ink and bright text alike.

    The reference point is the panel's own median luminance rather than a local
    blur.  A local blur tracks large features instead of the base material and
    reported 70% of a face panel as "mark"; the median keeps this at the
    visible ink share on a pale face panel and a near-black jersey panel alike.
    """
    median = float(np.median(light))
    deviation = np.abs(light - median)
    threshold = max(20.0, 3.0 * float(np.median(deviation)))
    mask = (deviation > threshold).astype(np.uint8)
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))


def panel_fingerprint(panel: np.ndarray) -> Dict[str, Any]:
    """Measure the style language of one UV panel."""
    if panel is None or panel.size == 0:
        return {"fingerprint_version": FINGERPRINT_VERSION, "valid": False}

    source_px = [int(panel.shape[1]), int(panel.shape[0])]
    # The gradient is scale stable, so it is read from the panel as delivered;
    # every mask-derived feature is read at the canonical size instead.
    gradient = directional_gradient(panel)
    panel = _canonical(panel)
    height, width = panel.shape[:2]
    lab = cv2.cvtColor(panel, cv2.COLOR_BGR2LAB)
    light = lab[:, :, 0].astype(np.float32)
    saturation = cv2.cvtColor(panel, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32)
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)

    marks = _mark_mask(light)
    core = cv2.erode(marks, np.ones((3, 3), np.uint8)) > 0
    if core.any():
        widths = cv2.distanceTransform(marks, cv2.DIST_L2, 5)[core]
        stroke_px = float(np.median(widths) * 2.0)
    else:
        stroke_px = 0.0

    detail = light - cv2.GaussianBlur(light, (0, 0), sigmaX=3.0)

    return {
        "fingerprint_version": FINGERPRINT_VERSION,
        "valid": True,
        "panel_px": source_px,
        "measured_at_px": CANONICAL_SIZE,
        "directional_gradient": round(gradient, 4),
        "stroke_width_px": round(stroke_px, 2),
        "stroke_width_rel": round(stroke_px / max(1, width), 4),
        "mark_share": round(float(marks.mean()), 4),
        "edge_density": round(float(np.mean(cv2.Canny(gray, 60, 150) > 0)), 4),
        "local_contrast": round(float(np.std(detail)), 2),
        "saturation_median": round(float(np.median(saturation)), 1),
        "L_median": round(float(np.median(light)), 1),
    }


def _band(target: float, tolerance: float) -> Dict[str, float]:
    return {"target": round(target, 4), "low": round(max(0.0, target * (1 - tolerance)), 4),
            "high": round(target * (1 + tolerance), 4)}


# Per-feature tolerance around the reference value. Stroke weight is the
# feature that separates toy print from illustration line work, so it carries
# the tightest band that still allows a genuinely different garment; the rest
# vary far more with outfit and are held loosely.
#
# 0.45 was picked against the measured response curve: it rejects hairline
# sketch work (a 16 px stroke on a 512 panel, the old style_family maximum,
# measures 0.023) and over-thick blobs, while accepting everything from roughly
# 20 to 45 px on a 512 panel.
#
# A panel carrying almost no print has no stroke language to judge at all.
# Plain trousers and plain shirts are faithful outputs, so an empty panel must
# not read as a style violation.
MIN_MARK_SHARE_FOR_STROKE = 0.01

_TOLERANCE = {
    "stroke_width_rel": 0.45,
    "mark_share": 1.00,
    "edge_density": 1.20,
    "local_contrast": 1.20,
    "saturation_median": 1.00,
}


def base_expectations(region: str) -> Dict[str, Any]:
    """The reference band for one region, with transfer confidence attached."""
    base = get_style_base()
    targets = base["fingerprint_targets"].get(region, {})
    expectations: Dict[str, Any] = {
        "region": region,
        "directional_gradient": {
            "target": 0.0,
            "low": 0.0,
            "high": base["shading_budget"]["texture_directional_gradient_max"],
            "transfer": "direct",
        },
    }
    for name, tolerance in _TOLERANCE.items():
        if name not in targets:
            continue
        expectations[name] = {
            **_band(float(targets[name]), tolerance),
            "transfer": FEATURE_TRANSFER.get(name, "indirect"),
        }
    return expectations


def compare_to_base(fingerprint: Dict[str, Any], panel_name: str) -> Dict[str, Any]:
    """Score one fingerprint against the base standard.

    ``violations`` only ever contains ``direct`` features.  An ``indirect``
    feature that lands outside its band is reported as an observation, because
    the reference number came from a render and cannot carry a hard threshold.
    """
    region = REGION_FOR_PANEL.get(panel_name, panel_name)
    expectations = base_expectations(region)
    features: Dict[str, Any] = {}
    violations: List[str] = []
    observations: List[str] = []

    if not fingerprint.get("valid"):
        return {"region": region, "passed": False, "violations": [f"{panel_name}_unmeasurable"],
                "observations": [], "features": {}, "distance": 1.0}

    unprinted = float(fingerprint.get("mark_share", 0.0)) < MIN_MARK_SHARE_FOR_STROKE
    for name, band in expectations.items():
        if name == "region" or name not in fingerprint:
            continue
        if name == "stroke_width_rel" and unprinted:
            features[name] = {"value": float(fingerprint[name]), "skipped": "no_print_to_measure",
                              "transfer": band["transfer"]}
            continue
        value = float(fingerprint[name])
        low = float(band.get("low", 0.0))
        high = float(band["high"])
        inside = low <= value <= high
        span = max(1e-6, high - low)
        excess = 0.0 if inside else (low - value if value < low else value - high) / span
        features[name] = {
            "value": value,
            "low": round(low, 4),
            "high": round(high, 4),
            "inside": inside,
            "transfer": band["transfer"],
        }
        if inside:
            continue
        if band["transfer"] == "direct":
            violations.append(f"{panel_name}_{name}_out_of_band")
        else:
            observations.append(f"{panel_name}_{name}_out_of_band")
        features[name]["excess"] = round(excess, 3)

    distance = float(np.mean([item.get("excess", 0.0) for item in features.values()])) if features else 0.0
    return {
        "region": region,
        "passed": not violations,
        "violations": sorted(violations),
        "observations": sorted(observations),
        "features": features,
        "distance": round(distance, 4),
    }


def fingerprint_spread(fingerprints: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """How far a set of characters has drifted from each other.

    This is the species-consistency number the pipeline never had: two panels
    can each sit inside the base band and still be visibly different styles, and
    only the spread across characters shows that.
    """
    valid = [item for item in fingerprints if item.get("valid")]
    if len(valid) < 2:
        return {"characters": len(valid), "measurable": False, "features": {}}

    features: Dict[str, Any] = {}
    for name in ("directional_gradient", "stroke_width_rel", "mark_share",
                 "local_contrast", "edge_density", "saturation_median"):
        values = [float(item[name]) for item in valid if name in item]
        if len(values) < 2:
            continue
        mean = float(np.mean(values))
        features[name] = {
            "mean": round(mean, 4),
            "std": round(float(np.std(values)), 4),
            "min": round(float(np.min(values)), 4),
            "max": round(float(np.max(values)), 4),
            # Relative spread is what reads as "different art styles"; an
            # absolute std means nothing across features of different scale.
            "relative_spread": round(float(np.std(values)) / abs(mean), 4) if abs(mean) > 1e-6 else None,
            "transfer": FEATURE_TRANSFER.get(name, "indirect"),
        }
    return {"characters": len(valid), "measurable": True, "features": features,
            "fingerprint_version": FINGERPRINT_VERSION}
