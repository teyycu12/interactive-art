"""Species-drift measurement for generated character sprites.

``style_fingerprint`` can measure the style of one flat panel, and
``fingerprint_spread`` can turn a set of those into the cross-character drift
number that defines species consistency.  Nothing connected the two to an
actual generated character, so the pipeline had no answer to "how inconsistent
is this cast".  This module is that connection.

A ``full_character`` sprite is one transparent PNG of a whole figure, not four
flat UV panels, so it has to be cut into comparable regions first.  The cuts
come from the vertical landmarks in ``style_base`` -- the same proportions the
reference render was measured with -- so a region measured here and the
matching region of the reference mean the same thing.

Two details matter for the numbers to be comparable at all:

* Regions are cropped *inside* the silhouette, never across it.  The outline of
  a character is the strongest edge in the image, and letting it into a crop
  swamps ``edge_density`` and ``local_contrast`` with a number that says
  nothing about the art style.
* Transparent pixels are composited onto the reference background rather than
  left as whatever sits in the RGB channels, which for a cut-out PNG is
  usually black and would wreck every luminance-derived feature.

Contract: the sprite must already be a structurally complete figure, which is
``avatar_quality.validate_avatar_png``'s job, not this module's.  Bands are
proportions of the silhouette's own bounding box, so a figure missing its legs
has a shorter box and the leg band lands on the torso -- a plausible number
measured from the wrong body part.  Probe only what validation admitted.
"""

from __future__ import annotations

import base64
import binascii
import io
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union

import cv2
import numpy as np
from PIL import Image

try:
    from backend.style_base import get_style_base  # type: ignore
except Exception:
    from style_base import get_style_base  # type: ignore

try:
    from backend.style_fingerprint import fingerprint_spread, panel_fingerprint  # type: ignore
except Exception:
    from style_fingerprint import fingerprint_spread, panel_fingerprint  # type: ignore


PROBE_VERSION = "style_probe_v1"

# Vertical bands, as (start_landmark, end_landmark) in ``style_base.landmarks_y``.
# The face band starts below ``head_top`` because the crown is hair, not face.
REGION_BANDS: Dict[str, Tuple[str, str]] = {
    "face": ("head_top", "collar"),
    "garment_torso": ("collar", "waist"),
    "denim_leg": ("waist", "shoe_top"),
    "shoe": ("shoe_top", "sole"),
}

# The face band is the whole head; the print sits in its lower two thirds, so
# the top of the band is dropped to keep hair out of a "face style" reading.
FACE_BAND_TOP_TRIM = 0.35

# A column counts as part of the body only if the silhouette covers most of the
# band there. This is what separates the two legs from the gap between them.
MIN_COLUMN_COVERAGE = 0.75

# How much of the found run to keep. Shrinking away from both edges keeps the
# silhouette outline out of the crop.
RUN_INSET = 0.12

MIN_REGION_PX = 12

_SPREAD_REGION_DEFAULT = "garment_torso"

# ``directional_gradient`` fits a smooth second-order surface, and a hard
# two-tone garment (white shirt above black dungarees) fits one about as well as
# a light field does -- see ``test_style_normalizer`` :: a_hard_two_tone_split.
# The old pipeline tolerated that because ``brick_v2_atlas`` rejected two-tone
# panels separately as garment-silhouette hints; that check went away with the
# texture path, so on clothed regions the number now mixes baked shading with
# ordinary outfit colour-blocking and cannot be read as shading drift alone.
# Skin is one material over the whole region, so the face keeps a clean reading.
SHADING_CONFOUND = {
    "face": None,
    "garment_torso": "gradient also picks up two-tone garments; not shading alone",
    "denim_leg": "gradient also picks up two-tone garments; not shading alone",
    "shoe": "gradient also picks up sole/upper colour splits; not shading alone",
}


def _decode(image: Union[str, bytes, np.ndarray, None]) -> Optional[np.ndarray]:
    """Return an RGBA array from a data URL, bare base64, PNG bytes or array."""
    if image is None:
        return None
    if isinstance(image, np.ndarray):
        if image.ndim != 3 or image.shape[2] not in (3, 4):
            return None
        if image.shape[2] == 3:
            return cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
        return image
    if isinstance(image, str):
        payload = image.split(",", 1)[1] if image.startswith("data:image") else image
        try:
            raw = base64.b64decode(payload, validate=False)
        except (binascii.Error, ValueError):
            return None
    else:
        raw = image
    try:
        pil = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return None
    rgba = np.array(pil)
    return cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)


def _subject_mask(bgra: np.ndarray) -> np.ndarray:
    """Foreground mask, from alpha when present and from contrast when not."""
    alpha = bgra[:, :, 3]
    if int(alpha.min()) < 250:
        return alpha > 12
    # A fully opaque sprite still has the reference's near-white background, so
    # fall back to "anything clearly darker or more saturated than the corners".
    bgr = bgra[:, :, :3]
    corners = np.concatenate([
        bgr[:2, :2].reshape(-1, 3), bgr[:2, -2:].reshape(-1, 3),
        bgr[-2:, :2].reshape(-1, 3), bgr[-2:, -2:].reshape(-1, 3),
    ])
    background = np.median(corners, axis=0)
    return np.linalg.norm(bgr.astype(np.float32) - background, axis=2) > 28.0


def _composite(bgra: np.ndarray) -> np.ndarray:
    """Flatten onto the reference background so alpha never reaches a feature."""
    background_hex = str(((get_style_base().get("reference") or {}).get("background_hex")) or "#FEFEFD")
    text = background_hex.lstrip("#")
    try:
        r, g, b = (int(text[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        r, g, b = 254, 254, 253
    alpha = (bgra[:, :, 3:4].astype(np.float32) / 255.0)
    canvas = np.full(bgra[:, :, :3].shape, (b, g, r), dtype=np.float32)
    blended = bgra[:, :, :3].astype(np.float32) * alpha + canvas * (1.0 - alpha)
    return blended.astype(np.uint8)


def _widest_dense_run(mask_band: np.ndarray) -> Optional[Tuple[int, int]]:
    """Widest column range the silhouette fills, as a half-open [start, end)."""
    if mask_band.size == 0:
        return None
    dense = mask_band.mean(axis=0) >= MIN_COLUMN_COVERAGE
    best: Optional[Tuple[int, int]] = None
    start: Optional[int] = None
    for index, filled in enumerate(dense):
        if filled and start is None:
            start = index
        elif not filled and start is not None:
            if best is None or index - start > best[1] - best[0]:
                best = (start, index)
            start = None
    if start is not None and (best is None or len(dense) - start > best[1] - best[0]):
        best = (start, len(dense))
    return best


def _region_crop(bgr: np.ndarray, mask: np.ndarray, y0: int, y1: int) -> Optional[np.ndarray]:
    if y1 - y0 < MIN_REGION_PX:
        return None
    run = _widest_dense_run(mask[y0:y1])
    if run is None:
        return None
    x0, x1 = run
    inset = int((x1 - x0) * RUN_INSET)
    x0, x1 = x0 + inset, x1 - inset
    if x1 - x0 < MIN_REGION_PX:
        return None
    crop = bgr[y0:y1, x0:x1]
    return crop if crop.size else None


def sprite_fingerprint(image: Union[str, bytes, np.ndarray, None]) -> Dict[str, Any]:
    """Measure the style of each body region of one generated character.

    Returns ``valid: False`` rather than raising: a probe that cannot read an
    image must not take down a generation, and an unmeasurable sprite is
    excluded from drift rather than counted as agreeing with everything.
    """
    bgra = _decode(image)
    if bgra is None or bgra.shape[0] < MIN_REGION_PX or bgra.shape[1] < MIN_REGION_PX:
        return {"probe_version": PROBE_VERSION, "valid": False, "error": "undecodable_sprite", "regions": {}}

    mask = _subject_mask(bgra)
    rows = np.flatnonzero(mask.any(axis=1))
    columns = np.flatnonzero(mask.any(axis=0))
    if rows.size == 0 or columns.size == 0:
        return {"probe_version": PROBE_VERSION, "valid": False, "error": "empty_subject", "regions": {}}

    top, bottom = int(rows[0]), int(rows[-1]) + 1
    left, right = int(columns[0]), int(columns[-1]) + 1
    height = bottom - top
    if height < MIN_REGION_PX:
        return {"probe_version": PROBE_VERSION, "valid": False, "error": "subject_too_small", "regions": {}}

    bgr = _composite(bgra)[top:bottom, left:right]
    subject_mask = mask[top:bottom, left:right]
    landmarks = get_style_base()["landmarks_y"]

    regions: Dict[str, Any] = {}
    for name, (start_key, end_key) in REGION_BANDS.items():
        start = float(landmarks[start_key]["value"])
        end = float(landmarks[end_key]["value"])
        if name == "face":
            start += (end - start) * FACE_BAND_TOP_TRIM
        y0 = int(round(start * height))
        y1 = int(round(end * height))
        crop = _region_crop(bgr, subject_mask, y0, y1)
        if crop is None:
            regions[name] = {"valid": False, "error": "region_not_measurable"}
            continue
        regions[name] = panel_fingerprint(crop)

    return {
        "probe_version": PROBE_VERSION,
        "valid": any(region.get("valid") for region in regions.values()),
        "subject_px": [right - left, height],
        "regions": regions,
    }


def cast_drift(
    sprite_fingerprints: Iterable[Dict[str, Any]],
    region: str = _SPREAD_REGION_DEFAULT,
) -> Dict[str, Any]:
    """How far a cast of characters has drifted from each other in one region.

    Thin wrapper on :func:`style_fingerprint.fingerprint_spread` -- the spread
    maths lives there and is not duplicated here.
    """
    panels: List[Dict[str, Any]] = []
    for sprite in sprite_fingerprints or []:
        if not sprite or not sprite.get("valid"):
            continue
        panel = (sprite.get("regions") or {}).get(region)
        if panel and panel.get("valid"):
            panels.append(panel)
    spread = fingerprint_spread(panels)
    result: Dict[str, Any] = {"region": region, "probe_version": PROBE_VERSION, **spread}
    confound = SHADING_CONFOUND.get(region)
    if confound:
        result["directional_gradient_confound"] = confound
    return result


def cast_drift_by_region(sprite_fingerprints: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """``cast_drift`` for every region, from one pass over the cast."""
    sprites = [sprite for sprite in (sprite_fingerprints or []) if sprite and sprite.get("valid")]
    return {name: cast_drift(sprites, name) for name in REGION_BANDS}
