"""Did the model copy the visitor, or copy the style reference?

Sending real reference characters as Image 4 buys style convergence and creates
a new failure at the same time: the model can satisfy "look like this" by
painting the reference character's clothes onto the visitor. The output still
looks like a clean, on-style figure -- that is what makes it dangerous -- and
the only symptom is that the cast slowly stops resembling the people who stood
in front of the camera.

``color_allegiance`` asks the one question that separates the two cases
cheaply: is this garment's colour nearer the colour CV measured on the visitor,
or nearer a colour that appears in the reference set? Colour is the strongest
and cheapest copy vector to test, and it is the one the firewall wording in
``garment_gen`` names first.

The measurement is deliberately not always willing to answer. When the visitor
happens to be dressed close to a reference character, no colour test can tell
copying from faithfulness, and returning a verdict anyway would be a confident
number derived from an undecidable case. That situation reports
``indistinguishable`` and is excluded rather than counted as a pass.

That has an uncomfortable consequence worth stating plainly: the better the
reference set covers the colour space, the weaker this test gets, because the
nearest reference is always near. A curated set built for variety -- which is
what style transfer wants -- is the same set that leaves this check least able
to speak, and skin tone is where the squeeze is tightest, since every reference
character and every visitor has some. So a run with few findings is not
evidence of no bleed until ``withheld`` is read alongside it. That count is
returned for exactly this reason.

Everything here is a warning. There is no calibrated threshold yet -- that
needs real-person runs -- and wiring an uncalibrated bleed check as a blocking
error would drive the pass rate to zero for reasons nobody could diagnose.

Colour distance is CIE76 in LAB. It is the crude one, but the quantity being
compared is "which of two candidates is nearer", not an absolute difference,
and both candidates go through the same transform. Region colour is a
per-channel median, matching ``cv_module._grid_dominant``, so the generated
colour and the visitor colour are measured the same way rather than compared
across two different definitions of "the colour of this garment".
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import cv2
import numpy as np

try:
    from backend.style_probe import region_crops  # type: ignore
except Exception:
    from style_probe import region_crops  # type: ignore


BLEED_VERSION = "reference_bleed_v1"

_REFERENCE_ROOT = Path(__file__).resolve().parents[1] / "docs" / "style_reference"
_REFERENCE_SUFFIXES = {".png", ".webp"}

# Which measured visitor colour each region should agree with. The caller
# passes clothing and face measurements merged into one dict, because they come
# from two CV modules but describe one person. The shoe is absent because
# nothing measures it, so there is no second hypothesis to weigh.
#
# The face entry is not decoration. Skin tone is the individual trait most
# likely to be quietly replaced by the reference set's, and unlike a garment
# there is no visitor-side variety to hide behind: every reference character
# and every visitor has skin, so a drift toward one tone looks like nothing at
# all until the whole cast shares a complexion.
REGION_TO_VISITOR_KEY = {
    "face": "skin_tone",
    "garment_torso": "upper",
    "denim_leg": "lower",
}

# CIE76 units. Both are first-round guesses, not calibrated thresholds.
#
# AMBIGUITY_FLOOR is how far apart the visitor's colour and the nearest
# reference colour must be before the test is allowed to answer at all. Below
# it the two hypotheses predict the same pixels.
AMBIGUITY_FLOOR = 12.0
# DECISION_MARGIN keeps a near-tie from being reported as a finding.
DECISION_MARGIN = 5.0

_palette_cache: Dict[str, Optional[Dict[str, List[Tuple[float, float, float]]]]] = {}


def _lab_median(bgr: Optional[np.ndarray]) -> Optional[Tuple[float, float, float]]:
    """Per-channel LAB median of a crop, matching how CV measures the visitor."""
    if bgr is None or bgr.size == 0:
        return None
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32).reshape(-1, 3)
    median = np.median(lab, axis=0)
    return (float(median[0]), float(median[1]) - 128.0, float(median[2]) - 128.0)


def _hex_to_lab(value: Optional[str]) -> Optional[Tuple[float, float, float]]:
    text = str(value or "").strip().lstrip("#")
    if len(text) != 6:
        return None
    try:
        r, g, b = (int(text[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None
    patch = np.array([[[b, g, r]]], dtype=np.uint8)
    lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)[0, 0]
    return (float(lab[0]), float(lab[1]) - 128.0, float(lab[2]) - 128.0)


def _delta_e(first: Tuple[float, float, float], second: Tuple[float, float, float]) -> float:
    return float(np.linalg.norm(np.asarray(first) - np.asarray(second)))


def _visitor_lab(visitor: Optional[Dict[str, Any]], key: str) -> Optional[Tuple[float, float, float]]:
    """Pull one measured garment colour out of a ``get_clothing_features`` result."""
    entry = (visitor or {}).get(key)
    if isinstance(entry, dict):
        return _hex_to_lab(entry.get("hex"))
    return _hex_to_lab(entry if isinstance(entry, str) else None)


def reference_palette(set_id: Optional[str] = None) -> Optional[Dict[str, List[Tuple[float, float, float]]]]:
    """Region colours of every character in a reference set, or None if absent.

    The reference images are opaque figures on near-white, which is exactly the
    case ``style_probe._subject_mask`` falls back to contrast for, so the same
    cut used on generated sprites can be used on them. That matters more than
    it looks: comparing a generated torso against a reference *whole image*
    would compare a garment to a figure-plus-background average.
    """
    set_id = set_id or os.environ.get("STYLE_REFERENCE_SET", "").strip() or "2026q3_owner_curated"
    if set_id in _palette_cache:
        return _palette_cache[set_id]

    directory = _REFERENCE_ROOT / set_id
    palette: Dict[str, List[Tuple[float, float, float]]] = {}
    if directory.is_dir():
        for path in sorted(directory.glob("full_body_*")):
            if path.suffix.lower() not in _REFERENCE_SUFFIXES:
                continue
            try:
                cut = region_crops(path.read_bytes())
            except Exception:
                continue
            if not cut.get("valid"):
                continue
            for region, crop in (cut.get("crops") or {}).items():
                colour = _lab_median(crop)
                if colour is not None:
                    palette.setdefault(region, []).append(colour)

    _palette_cache[set_id] = palette or None
    return _palette_cache[set_id]


def color_allegiance(
    image: Union[str, bytes, np.ndarray, None],
    visitor: Optional[Dict[str, Any]] = None,
    *,
    set_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Whether each generated garment sides with the visitor or the reference set.

    Verdicts per region:

    ``visitor``            the generated colour is nearer what CV measured.
    ``reference``          it is nearer a reference character. A warning.
    ``unclear``            within ``DECISION_MARGIN`` of both; no finding.
    ``indistinguishable``  the visitor and the nearest reference are themselves
                           closer than ``AMBIGUITY_FLOOR``, so no colour test
                           can separate the hypotheses. Excluded, not passed.
    """
    palette = reference_palette(set_id)
    if not palette:
        return {"bleed_version": BLEED_VERSION, "measurable": False,
                "error": "no_reference_palette", "regions": {}, "warnings": []}

    cut = region_crops(image)
    if not cut.get("valid"):
        return {"bleed_version": BLEED_VERSION, "measurable": False,
                "error": cut.get("error") or "no_measurable_region",
                "regions": {}, "warnings": []}

    crops = cut.get("crops") or {}
    regions: Dict[str, Any] = {}
    warnings: List[str] = []

    for region, visitor_key in REGION_TO_VISITOR_KEY.items():
        generated = _lab_median(crops.get(region))
        measured = _visitor_lab(visitor, visitor_key)
        references = palette.get(region) or []
        if generated is None or measured is None or not references:
            regions[region] = {
                "verdict": "not_measurable",
                "reason": ("no generated crop" if generated is None else
                           "no CV colour for this region" if measured is None else
                           "reference set has no colour for this region"),
            }
            continue

        distances = [_delta_e(generated, reference) for reference in references]
        nearest_index = int(np.argmin(distances))
        to_reference = float(distances[nearest_index])
        to_visitor = _delta_e(generated, measured)
        separation = _delta_e(measured, references[nearest_index])

        if separation < AMBIGUITY_FLOOR:
            verdict = "indistinguishable"
        elif to_visitor + DECISION_MARGIN < to_reference:
            verdict = "visitor"
        elif to_reference + DECISION_MARGIN < to_visitor:
            verdict = "reference"
        else:
            verdict = "unclear"

        regions[region] = {
            "verdict": verdict,
            "delta_to_visitor": round(to_visitor, 2),
            "delta_to_nearest_reference": round(to_reference, 2),
            # How far apart the two hypotheses were to begin with. A small value
            # is why a verdict may be withheld, so it is reported either way.
            "hypothesis_separation": round(separation, 2),
        }
        if verdict == "reference":
            warnings.append(
                f"{region}: colour sides with the reference set "
                f"(dE {to_reference:.1f} vs {to_visitor:.1f} to the measured visitor)"
            )

    verdicts = [entry.get("verdict") for entry in regions.values()]
    return {
        "bleed_version": BLEED_VERSION,
        "measurable": any(verdict in {"visitor", "reference", "unclear"} for verdict in verdicts),
        "regions": regions,
        # How many regions the test refused to judge. Read this before reading
        # an empty warnings list as a clean result -- see the module docstring.
        "withheld": sum(1 for verdict in verdicts
                        if verdict in {"indistinguishable", "not_measurable"}),
        # Warnings only, by design. See the module docstring.
        "warnings": warnings,
    }
