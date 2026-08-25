"""Gate a Stage 4 style-reference set before it is ever sent to the model.

A reference sheet is the strongest signal in the send, so a bad image in the set
is worse than no set at all: whatever the images share becomes what the model
believes the style *is*.  Two failure classes matter, and they need different
treatment:

``hard``  the image is unusable as a measurement surface -- too small, JPEG block
          artifacts, a stray glyph or a second object sitting in the background.
          These are errors.  They contaminate ``edge_density`` and
          ``local_contrast``, the two features Stage 4 actually reads.
``soft``  the set is legal but poorly spread -- five images that measure almost
          identically teach the model an over-narrow style.  Reported as a
          warning with the numbers attached, never as a failure, because there is
          no calibrated threshold for "spread enough" yet.

Measurement reuses :mod:`backend.style_fingerprint` rather than rolling its own,
so the numbers printed here are the same numbers the generated sprite is later
judged against.  A separate implementation would produce a second set of values
that look comparable and are not.

Full-body images are measured on the subject crop, not the whole frame, because
the white background would otherwise dominate every feature.  That makes the
values ``indirect`` in the fingerprint module's sense: comparable across the set,
not against the base standard.  The spread is the point, not the absolute value.

Usage::

    python scripts/check_reference_set.py docs/style_reference/2026q3_owner_curated
    python scripts/check_reference_set.py <dir> --json out.json

Exit code is non-zero only for hard failures.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.style_fingerprint import (  # noqa: E402
    fingerprint_spread,
    panel_fingerprint,
)


# Short side floor from the Stage 4 spec.  It is enforced on material close-ups
# only, where the whole frame is the measured surface and stroke width -- the one
# feature carrying a tight band -- has to survive.
MIN_SHORT_SIDE = 1024

# A full-body frame is mostly empty background, so its own dimensions say little.
# What matters is how tall the figure lands in the sheet: the sheet builder packs
# roughly 480 px cells, and the fingerprint normalises to 256 px, so a figure
# comfortably above both keeps every measurement clean no matter how wide or
# short the frame around it happens to be.
MIN_SUBJECT_HEIGHT = 640

# The reference render's measured background is #FEFEFD.  244 leaves room for
# render dithering and mild resampling without admitting a grey backdrop.
NEAR_WHITE = 244

# A stray component this size on a 1024x1024 frame is roughly a 15x15 blob --
# large enough to be a letter or a watermark, small enough to skip resampling
# fringes that survive the opening.
STRAY_MIN_AREA_FRAC = 0.0002

# A material close-up is specified as full-bleed with no outline and no
# background.  Past this much near-white it is carrying a silhouette instead.
MATERIAL_MAX_WHITE_FRAC = 0.10

LOSSY_SUFFIXES = {".jpg", ".jpeg"}
ACCEPTED_SUFFIXES = {".png", ".webp"}

FULL_BODY_PREFIX = "full_body_"
MATERIAL_PREFIX = "material_"


def _load(path: Path) -> Optional[np.ndarray]:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        return None
    return image


def _background_mask(bgr: np.ndarray) -> np.ndarray:
    """Near-white pixels reachable from the frame border.

    Thresholding on whiteness alone would eat a cream t-shirt or a white inner
    shirt and split the figure into unconnected pieces -- the same failure
    ``garment_gen._get_shield_mask`` exists to prevent on the output side.  Only
    white that the border can reach is background; white enclosed by the
    silhouette belongs to the garment.
    """
    near_white = np.all(bgr >= NEAR_WHITE, axis=2).astype(np.uint8)
    filled = near_white.copy()
    height, width = near_white.shape
    scratch = np.zeros((height + 2, width + 2), np.uint8)
    # Seed from every border pixel that is already white; cv2 floodFill needs a
    # concrete seed, so walk the border rather than guessing a corner.
    for y, x in list(zip([0] * width, range(width))) + list(zip([height - 1] * width, range(width))) \
            + list(zip(range(height), [0] * height)) + list(zip(range(height), [width - 1] * height)):
        if filled[y, x] == 1:
            cv2.floodFill(filled, scratch, (x, y), 2)
    return (filled == 2).astype(np.uint8)


def _subject_and_strays(bgr: np.ndarray) -> Tuple[Optional[np.ndarray], List[Dict[str, Any]], np.ndarray]:
    """Split the frame into the figure, anything detached from it, and the ground.

    In this style the figure is one connected silhouette -- hair meets the head,
    the head meets the neck, arms meet the shoulders, legs meet the hips.  So a
    second component is never part of the character.  Severity splits on where it
    sits: a mark out in the margin is unambiguously a glyph, watermark, prop or
    second figure and fails; a small piece touching the figure's own bounding box
    is more likely a moulded detail that the white threshold clipped, so it only
    warns and asks for an eye.
    """
    background = _background_mask(bgr)
    foreground = cv2.morphologyEx(1 - background, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(foreground, connectivity=8)
    if count <= 1:
        return None, [], background

    areas = stats[1:, cv2.CC_STAT_AREA]
    order = list(np.argsort(areas)[::-1])
    subject_label = order[0] + 1
    subject_mask = labels == subject_label
    sx = int(stats[subject_label, cv2.CC_STAT_LEFT])
    sy = int(stats[subject_label, cv2.CC_STAT_TOP])
    sw = int(stats[subject_label, cv2.CC_STAT_WIDTH])
    sh = int(stats[subject_label, cv2.CC_STAT_HEIGHT])

    min_area = STRAY_MIN_AREA_FRAC * bgr.shape[0] * bgr.shape[1]
    margin = int(0.02 * max(bgr.shape[:2]))
    strays: List[Dict[str, Any]] = []
    for index in order[1:]:
        label = index + 1
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        w = int(stats[label, cv2.CC_STAT_WIDTH])
        h = int(stats[label, cv2.CC_STAT_HEIGHT])
        touching = (x < sx + sw + margin and x + w > sx - margin
                    and y < sy + sh + margin and y + h > sy - margin)
        strays.append({"area_px": area, "bbox": [x, y, w, h], "touching_subject": touching})
    return subject_mask, strays, background


def _background_stats(bgr: np.ndarray, background: np.ndarray) -> Dict[str, Any]:
    ground = bgr[background == 1]
    if ground.size == 0:
        return {"measurable": False}
    gray = ground.mean(axis=1)
    return {
        "measurable": True,
        "share_of_frame": round(float((background == 1).mean()), 4),
        "mean": round(float(gray.mean()), 1),
        "std": round(float(gray.std()), 2),
        "darkest": int(gray.min()),
    }


def _check_format(path: Path) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    suffix = path.suffix.lower()
    if suffix in LOSSY_SUFFIXES:
        errors.append(
            "re-compressed JPEG: block artifacts land directly on edge_density "
            "and local_contrast. Re-export as PNG from the original."
        )
    elif suffix not in ACCEPTED_SUFFIXES:
        errors.append(f"unsupported format {suffix or '(none)'}; expected PNG or high-quality WebP")
    if suffix == ".webp":
        warnings.append("WebP accepted, but confirm it was written at quality >= 95")
    return errors, warnings


def _interior_patch(bgr: np.ndarray, subject: np.ndarray) -> Optional[np.ndarray]:
    """The largest square lying entirely inside the figure.

    Measuring on the bounding-box crop instead was wrong: a standing figure
    leaves 40-50% of its own box as white background -- the gaps beside the
    arms, between the legs, around the head -- so every feature tracked how much
    of the box the figure filled rather than how the figure was drawn.  A
    crimson dress reference measured ``saturation_median`` 1 out of 255 that way.

    The distance transform's peak is the deepest interior point, which on a
    standing figure lands on the torso -- the region ``style_base`` already
    calls ``garment_torso``.  Half-side is the inscribed radius over sqrt(2),
    since the largest inscribed square is smaller than the inscribed circle.
    """
    distance = cv2.distanceTransform(subject.astype(np.uint8), cv2.DIST_L2, 5)
    cy, cx = np.unravel_index(int(np.argmax(distance)), distance.shape)
    half = int(float(distance[cy, cx]) / np.sqrt(2.0))
    if half < 16:
        return None
    return bgr[cy - half:cy + half, cx - half:cx + half]


def _check_full_body(bgr: np.ndarray) -> Dict[str, Any]:
    subject, strays, background_mask = _subject_and_strays(bgr)
    errors: List[str] = []
    warnings: List[str] = []

    if subject is None:
        return {"errors": ["frame is blank -- no figure found"], "warnings": [],
                "background": {"measurable": False}, "fingerprint": None}

    for stray in strays:
        x, y, w, h = stray["bbox"]
        where = f"at x={x} y={y} {w}x{h} ({stray['area_px']} px)"
        if stray["touching_subject"]:
            warnings.append(
                f"detached piece beside the figure {where} -- probably a moulded detail the "
                "white threshold clipped, but confirm it is not a prop or a glyph"
            )
        else:
            errors.append(
                f"stray mark out in the margin {where} -- text, watermark, prop, "
                "ground line or a second character"
            )

    background = _background_stats(bgr, background_mask)
    if background.get("measurable"):
        if background["std"] > 2.0:
            warnings.append(
                f"background is not uniform (std {background['std']}); a gradient or "
                "vignette behind the figure biases the shading measurement"
            )
        if background["darkest"] < NEAR_WHITE - 6:
            warnings.append(
                f"darkest background pixel is {background['darkest']} -- check for a soft "
                "contact shadow, which the stray test cannot see when it touches the feet"
            )

    ys, xs = np.where(subject)
    subject_h = int(ys.max() - ys.min() + 1)
    subject_w = int(xs.max() - xs.min() + 1)
    if subject_h < MIN_SUBJECT_HEIGHT:
        errors.append(
            f"figure is only {subject_h} px tall, below the {MIN_SUBJECT_HEIGHT} px floor; "
            "detail will not survive the downscale into the reference sheet"
        )

    patch = _interior_patch(bgr, subject)
    if patch is None:
        warnings.append("no solid interior region large enough to measure the style on")
        return {"errors": errors, "warnings": warnings, "background": background,
                "subject_px": [subject_w, subject_h], "fingerprint": None}

    return {
        "errors": errors,
        "warnings": warnings,
        "background": background,
        "subject_px": [subject_w, subject_h],
        "measured_patch_px": int(patch.shape[0]),
        "fingerprint": panel_fingerprint(patch),
    }


def _check_material(bgr: np.ndarray) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []

    non_white = np.any(bgr < NEAR_WHITE, axis=2).astype(np.uint8)
    white_frac = float((non_white == 0).mean())
    if white_frac > MATERIAL_MAX_WHITE_FRAC:
        errors.append(
            f"{white_frac:.0%} of the panel is near-white -- a material close-up must be "
            "full-bleed with no outline and no background"
        )

    return {
        "errors": errors,
        "warnings": warnings,
        "white_frac": round(white_frac, 4),
        "fingerprint": panel_fingerprint(bgr),
    }


def _check_provenance(directory: Path, filenames: List[str]) -> Tuple[List[str], List[str]]:
    """Validate a PROVENANCE.md if the set keeps one; say nothing if it does not.

    Tracking provenance is a decision about where the set will be shown, not a
    property of the images, so its absence is not a defect this script can judge.
    A set that stays internal needs no record.  A set headed for public display
    needs one, and then the rows have to actually be filled in -- which is what
    the warnings below check.
    """
    path = directory / "PROVENANCE.md"
    if not path.exists():
        return ([], [])

    text = path.read_text(encoding="utf-8", errors="replace")
    warnings: List[str] = []
    documented: Dict[str, List[str]] = {}
    for line in text.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or not cells[0]:
            continue
        documented[cells[0]] = cells

    for name in filenames:
        cells = documented.get(name)
        if cells is None:
            warnings.append(f"{name} has no PROVENANCE.md row")
        elif not cells[1] or not cells[2]:
            warnings.append(f"{name} has an empty Source or Licence cell in PROVENANCE.md")
    return ([], warnings)


def _print_spread(label: str, fingerprints: List[Dict[str, Any]]) -> None:
    spread = fingerprint_spread(fingerprints)
    if not spread.get("measurable"):
        print(f"\n{label}: need at least 2 measurable images to report spread")
        return

    print(f"\n{label} -- spread across {spread['characters']} images")
    print(f"  {'feature':<22}{'mean':>10}{'min':>10}{'max':>10}{'rel spread':>13}")
    for name, item in spread["features"].items():
        relative = item.get("relative_spread")
        shown = f"{relative:.3f}" if relative is not None else "n/a"
        print(f"  {name:<22}{item['mean']:>10.4f}{item['min']:>10.4f}{item['max']:>10.4f}{shown:>13}")
    print("  a near-zero relative spread means the images are teaching one narrow look;")
    print("  a very large one means they are not the same style to begin with.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directory", type=Path, help="a docs/style_reference/<set_id> directory")
    parser.add_argument("--json", type=Path, default=None, help="also write the full report here")
    args = parser.parse_args()

    directory: Path = args.directory
    if not directory.is_dir():
        print(f"not a directory: {directory}")
        return 2

    images = sorted(
        path for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() in ACCEPTED_SUFFIXES | LOSSY_SUFFIXES
    )
    if not images:
        print(f"no images in {directory}")
        return 2

    report: Dict[str, Any] = {"set": str(directory), "images": {}}
    full_body: List[Dict[str, Any]] = []
    material: List[Dict[str, Any]] = []
    total_errors = 0

    for path in images:
        errors, warnings = _check_format(path)
        bgr = _load(path)
        result: Dict[str, Any] = {}

        if bgr is None:
            errors.append("unreadable image")
        else:
            height, width = bgr.shape[:2]
            result["size_px"] = [int(width), int(height)]

            name = path.name.lower()
            if name.startswith(MATERIAL_PREFIX):
                if min(width, height) < MIN_SHORT_SIDE:
                    errors.append(
                        f"short side {min(width, height)} px is below the {MIN_SHORT_SIDE} px "
                        "floor; the whole frame is the measured surface here"
                    )
                kind, checked = "material", _check_material(bgr)
            elif name.startswith(FULL_BODY_PREFIX):
                kind, checked = "full_body", _check_full_body(bgr)
            else:
                kind, checked = "unknown", {"errors": [], "warnings": [
                    f"filename has neither the {FULL_BODY_PREFIX!r} nor {MATERIAL_PREFIX!r} prefix, "
                    "so no class-specific check ran"
                ], "fingerprint": None}

            result["class"] = kind
            errors += checked.pop("errors", [])
            warnings += checked.pop("warnings", [])
            result.update(checked)

            fingerprint = result.get("fingerprint")
            if fingerprint and fingerprint.get("valid"):
                (full_body if kind == "full_body" else material if kind == "material" else []).append(fingerprint)

        result["errors"] = errors
        result["warnings"] = warnings
        report["images"][path.name] = result
        total_errors += len(errors)

        status = "FAIL" if errors else ("WARN" if warnings else "PASS")
        print(f"[{status}] {path.name}")
        for message in errors:
            print(f"    ERROR  {message}")
        for message in warnings:
            print(f"    warn   {message}")

    prov_errors, prov_warnings = _check_provenance(directory, [path.name for path in images])
    report["provenance"] = {"errors": prov_errors, "warnings": prov_warnings}
    total_errors += len(prov_errors)
    if prov_errors or prov_warnings:
        print("\n[PROVENANCE]")
        for message in prov_errors:
            print(f"    ERROR  {message}")
        for message in prov_warnings:
            print(f"    warn   {message}")

    if full_body:
        _print_spread("A class (full body, measured on the largest interior patch)", full_body)
        report["full_body_spread"] = fingerprint_spread(full_body)
    if material:
        _print_spread("B class (material close-ups)", material)
        report["material_spread"] = fingerprint_spread(material)

    print(f"\n{len(images)} images, {total_errors} hard failures")
    print("Glyphs printed ON the figure are not caught here -- they stay connected to the")
    print("subject. Those need an eye now, and reference_bleed.text_glyph_guard later.")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"report written to {args.json}")

    return 1 if total_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
