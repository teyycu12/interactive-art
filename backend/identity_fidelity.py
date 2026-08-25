"""How much of each individual survives the push for a single species.

``style_probe`` answers "are these characters the same species". On its own that
number is dangerous, because the cheapest way to drive it to zero is to draw the
same person every time. This module measures the opposite quantity -- how much
the characters differ in *content* -- so the two can be read together. A style
spread that falls while content spread falls with it is not success; it is the
individuality being flattened. The project has two consistency goals that pull
against each other, and only one of them is allowed to win: characters made from
different people must read as one species, *and* height, build, clothing and
appearance must still be distinguishable within that species. Consistency that
achieves the first by erasing the second is a failure, not a success.

Orthogonality is the whole point of the feature choice. ``panel_fingerprint``
reads *spatial* statistics -- stroke width, edge density, how the light falls,
how much of the area carries marks -- which describe how a thing was drawn.
Here we read *colour identity* -- which hue, how colourful, how light, how many
colours -- which describes what was drawn. Redrawing the same jacket in another
art style moves the first set and not the second; giving a different visitor a
red jacket instead of a blue one moves the second and not the first.

One caveat, stated rather than hidden: ``fingerprint_spread`` counts
``saturation_median`` as a style feature, and it is not cleanly one. Two
garments of different hue but equal vividness leave it unchanged, while a vivid
cast next to a muted cast moves it -- that is a property of who was
photographed, not of how they were drawn. So a rise in style
``saturation_median`` spread across a cast may be preserved individuality
reading as style drift. Compare it against ``chroma_median`` here before
treating it as a regression.

Hue is circular, and this is the trap the module exists to avoid stepping in.
The ordinary mean and standard deviation are wrong across the 0/360 wrap: two
reds at 359 degrees and 1 degree are two degrees apart, but arithmetic makes
them 358 apart and reports a cast of red-clad visitors as maximally diverse.
Every hue statistic here is computed on the unit circle instead.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional, Tuple, Union

import cv2
import numpy as np

try:
    from backend.style_probe import REGION_BANDS, region_crops  # type: ignore
except Exception:
    from style_probe import REGION_BANDS, region_crops  # type: ignore


SIGNATURE_VERSION = "identity_fidelity_v1"

# Hue is meaningless where there is no colour, and a near-grey pixel's hue is
# whatever the noise says. Chroma weighting lets grey regions contribute their
# lightness and their chroma without voting on which hue the region "is".
MIN_CHROMA_FOR_HUE = 8.0

# Colour counting quantises first, or every anti-aliased edge invents colours.
# 32 levels per channel keeps a navy and a royal blue apart while merging the
# gradient ramp the glossy render puts across a single flat garment.
COLOUR_QUANTISATION = 32
COLOUR_SHARE_FLOOR = 0.05

# Features read as "what was drawn". ``hue_deg`` is handled separately
# everywhere because it lives on a circle; the rest are ordinary scalars.
LINEAR_FEATURES = ("chroma_median", "lightness_median", "colour_count")

MIN_REGION_PX = 12


def _chroma_and_hue(bgr: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-pixel lightness, chroma and hue in degrees, from LAB."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    lightness = lab[:, :, 0]
    # OpenCV stores a* and b* biased by 128 in 8-bit LAB.
    a = lab[:, :, 1] - 128.0
    b = lab[:, :, 2] - 128.0
    chroma = np.sqrt(a * a + b * b)
    hue = np.degrees(np.arctan2(b, a)) % 360.0
    return lightness, chroma, hue


def _circular_mean_deg(degrees: np.ndarray, weights: Optional[np.ndarray] = None) -> Optional[float]:
    """Mean direction on the unit circle, or None when there is no direction.

    A perfectly balanced pair of opposite hues has no meaningful mean, and
    returning one anyway would be an invented number: the resultant length
    collapses to zero and the reported angle is whatever the rounding produced.
    """
    degrees = np.asarray(degrees, dtype=np.float64)
    if degrees.size == 0:
        return None
    radians = np.radians(degrees)
    weights = np.ones_like(radians) if weights is None else np.asarray(weights, dtype=np.float64)
    total = float(np.sum(weights))
    if total <= 0:
        return None
    x = float(np.sum(weights * np.cos(radians)) / total)
    y = float(np.sum(weights * np.sin(radians)) / total)
    if np.hypot(x, y) < 1e-6:
        return None
    return float(np.degrees(np.arctan2(y, x)) % 360.0)


def _circular_spread(degrees: Iterable[float]) -> Optional[float]:
    """Circular variance in [0, 1]: 0 is one shared hue, 1 is fully scattered.

    Deliberately bounded, unlike the relative spread used for linear features.
    An unbounded ratio would be unreadable here because hue has no meaningful
    zero to divide by -- "spread relative to a mean hue of 200 degrees" is not
    a quantity.
    """
    values = np.asarray([value for value in degrees if value is not None], dtype=np.float64)
    if values.size < 2:
        return None
    radians = np.radians(values)
    resultant = np.hypot(float(np.mean(np.cos(radians))), float(np.mean(np.sin(radians))))
    return round(float(1.0 - resultant), 4)


def _colour_count(bgr: np.ndarray) -> int:
    """Distinct quantised colours holding at least ``COLOUR_SHARE_FLOOR`` of the area.

    This reads as "how patterned", not "how many colours a human would name":
    a striped shirt scores above a plain one, which is the individual trait
    worth protecting.
    """
    step = 256 // COLOUR_QUANTISATION
    quantised = (bgr.astype(np.int32) // step).reshape(-1, 3)
    packed = (quantised[:, 0] * COLOUR_QUANTISATION ** 2
              + quantised[:, 1] * COLOUR_QUANTISATION
              + quantised[:, 2])
    _, counts = np.unique(packed, return_counts=True)
    share = counts.astype(np.float64) / float(packed.size)
    return int(np.count_nonzero(share >= COLOUR_SHARE_FLOOR))


def region_content(bgr: Optional[np.ndarray]) -> Dict[str, Any]:
    """Colour identity of one region crop."""
    if bgr is None or bgr.size == 0 or min(bgr.shape[:2]) < MIN_REGION_PX:
        return {"valid": False, "error": "region_not_measurable"}

    lightness, chroma, hue = _chroma_and_hue(bgr)
    coloured = chroma >= MIN_CHROMA_FOR_HUE
    hue_deg = _circular_mean_deg(hue[coloured], chroma[coloured]) if coloured.any() else None

    return {
        "signature_version": SIGNATURE_VERSION,
        "valid": True,
        # None means "this region has no hue", e.g. a white shirt. That is a
        # fact about the garment, not a measurement failure, and it is excluded
        # from hue spread rather than counted as agreeing with everything.
        "hue_deg": round(hue_deg, 1) if hue_deg is not None else None,
        "chroma_median": round(float(np.median(chroma)), 2),
        "lightness_median": round(float(np.median(lightness)), 1),
        "colour_count": _colour_count(bgr),
    }


def sprite_content_signature(image: Union[str, bytes, np.ndarray, None]) -> Dict[str, Any]:
    """Colour identity of every body region of one generated character.

    Reads the crops ``style_probe`` cuts, so a content number and a style number
    for the same region always describe the same pixels.
    """
    cut = region_crops(image)
    if not cut.get("valid"):
        return {"signature_version": SIGNATURE_VERSION, "valid": False,
                "error": cut.get("error") or "no_measurable_region", "regions": {}}

    regions = {name: region_content(crop) for name, crop in (cut.get("crops") or {}).items()}
    return {
        "signature_version": SIGNATURE_VERSION,
        "valid": any(region.get("valid") for region in regions.values()),
        "subject_px": cut.get("subject_px"),
        "regions": regions,
    }


def individual_spread(signatures: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """How far a cast differs from each other in content.

    Mirror of ``fingerprint_spread``, with the reading direction inverted, and
    that inversion is the reason this exists: for style, small is the goal;
    here, small means the cast has been flattened into one person.
    """
    valid = [item for item in signatures or [] if item and item.get("valid")]
    if len(valid) < 2:
        return {"characters": len(valid), "measurable": False, "features": {}}

    features: Dict[str, Any] = {}
    for name in LINEAR_FEATURES:
        values = [float(item[name]) for item in valid if item.get(name) is not None]
        if len(values) < 2:
            continue
        mean = float(np.mean(values))
        features[name] = {
            "mean": round(mean, 4),
            "std": round(float(np.std(values)), 4),
            "min": round(float(np.min(values)), 4),
            "max": round(float(np.max(values)), 4),
            "relative_spread": round(float(np.std(values)) / abs(mean), 4) if abs(mean) > 1e-6 else None,
        }

    hues = [item["hue_deg"] for item in valid if item.get("hue_deg") is not None]
    spread = _circular_spread(hues)
    if spread is not None:
        features["hue_deg"] = {
            "circular_spread": spread,
            "mean_deg": _circular_mean_deg(np.asarray(hues, dtype=np.float64)),
            "sample_count": len(hues),
            # Named apart from relative_spread so the two are never averaged by
            # accident: this one is bounded in [0, 1] and the others are not.
            "scale": "circular_variance_0_to_1",
        }

    return {"characters": len(valid), "measurable": bool(features), "features": features,
            "signature_version": SIGNATURE_VERSION}


def content_spread_by_region(signatures: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """``individual_spread`` for every region, from one pass over the cast."""
    sprites = [item for item in signatures or [] if item and item.get("valid")]
    return {
        region: individual_spread([(sprite.get("regions") or {}).get(region) for sprite in sprites])
        for region in REGION_BANDS
    }
