"""Show what the pipeline actually measures as a person's hair colour.

``face_module`` does not segment hair. It takes one fixed-offset patch above the
forehead landmark, averages it, and passes that mean to the generation prompt as
``- Hair colour: #XXXXXX``. When the generated character's hair comes out wrong
there is no way, from the output alone, to tell whether the measurement was
wrong or the model ignored a correct one. This script answers the first half.

The number to read is ``spread``: the per-channel standard deviation inside the
sampled patch. Hair is one material, so a patch that landed on hair is uniform
and its mean means something. A high spread means the patch straddled two
things -- hair and forehead, hair and background -- and its mean is a blend that
matches neither. That is a measurement fault, and no prompt or reference-image
change can repair it.

Sampling is observed by wrapping ``face_module._sample_color`` rather than
recomputing the landmarks here, so what gets reported is exactly what the
pipeline did, and it cannot drift from it later.

Usage::

    python scripts/check_hair_sampling.py photo.jpg
    python scripts/check_hair_sampling.py "photos/*.jpg" --out annotated/
"""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import face_module  # noqa: E402


# The primary hair patch is the only radius-20 sample in the pass; the fallback
# that fires when it reads too bright is the radius-12 call right after it.
HAIR_RADIUS = 20
FALLBACK_RADIUS = 12

# Above this per-channel spread the patch is not one material and its mean is a
# blend. Chosen to sit well clear of the shading variation within real hair.
BLEND_SPREAD = 25.0


def _load_bgr(path: Path) -> Optional[np.ndarray]:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is not None:
        return image
    try:  # iPhone HEIC, which cv2 cannot open
        import pillow_heif  # type: ignore
        from PIL import Image as PILImage

        pillow_heif.register_heif_opener()
        rgb = np.asarray(PILImage.open(path).convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _measure(bgr: np.ndarray, max_width: int = 480) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Run the real feature pass, recording every patch it sampled."""
    calls: List[Dict[str, Any]] = []
    original = face_module._sample_color

    def recording(rgb, cx, cy, radius):
        result = original(rgb, cx, cy, radius)
        height, width = rgb.shape[:2]
        px, py = int(cx * width), int(cy * height)
        x1, x2 = max(0, px - radius), min(width, px + radius)
        y1, y2 = max(0, py - radius), min(height, py + radius)
        patch = rgb[y1:y2, x1:x2].reshape(-1, 3) if x2 > x1 and y2 > y1 else np.zeros((1, 3))
        calls.append({
            "cx": cx, "cy": cy, "radius": radius, "rgb": result,
            "spread": float(patch.astype(np.float32).std(axis=0).max()),
        })
        return result

    face_module._sample_color = recording  # type: ignore[assignment]
    try:
        features = face_module.get_face_features(bgr, max_width=max_width)
    finally:
        face_module._sample_color = original  # type: ignore[assignment]
    return features, calls


def _hair_calls(calls: List[Dict[str, Any]]) -> Tuple[Optional[Dict], Optional[Dict]]:
    """The primary hair patch, and the fallback patch if it fired."""
    for index, call in enumerate(calls):
        if call["radius"] != HAIR_RADIUS:
            continue
        following = calls[index + 1] if index + 1 < len(calls) else None
        fallback = following if following and following["radius"] == FALLBACK_RADIUS else None
        return call, fallback
    return None, None


def _annotate(bgr: np.ndarray, calls: List[Dict[str, Any]], hair: Dict[str, Any],
              fallback: Optional[Dict[str, Any]], hair_hex: str) -> np.ndarray:
    height, width = bgr.shape[:2]
    canvas = bgr.copy()

    def box(call, colour, label):
        scale = width / 480.0 if width > 480 else 1.0
        radius = int(call["radius"] * scale)
        px, py = int(call["cx"] * width), int(call["cy"] * height)
        cv2.rectangle(canvas, (px - radius, py - radius), (px + radius, py + radius), colour, 2)
        cv2.putText(canvas, label, (px - radius, max(14, py - radius - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)

    for call in calls:
        if call is not hair and call is not fallback:
            box(call, (140, 140, 140), "")
    box(hair, (0, 200, 255), "HAIR")
    if fallback is not None:
        box(fallback, (255, 120, 0), "FALLBACK")

    # A strip showing the patch the mean came from, next to the mean itself.
    used = fallback if fallback is not None else hair
    scale = width / 480.0 if width > 480 else 1.0
    radius = max(2, int(used["radius"] * scale))
    px, py = int(used["cx"] * width), int(used["cy"] * height)
    patch = canvas[max(0, py - radius):py + radius, max(0, px - radius):px + radius]
    strip = np.full((160, width, 3), 30, dtype=np.uint8)
    if patch.size:
        shown = cv2.resize(patch, (140, 140), interpolation=cv2.INTER_NEAREST)
        strip[10:150, 10:150] = shown
    red, green, blue = (int(c) for c in used["rgb"])
    strip[10:150, 170:310] = (blue, green, red)
    cv2.putText(strip, "sampled patch", (10, 158), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1)
    cv2.putText(strip, f"mean {hair_hex}", (170, 158), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1)
    cv2.putText(strip, f"spread {used['spread']:.1f}", (330, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (80, 80, 255) if used["spread"] > BLEND_SPREAD else (120, 220, 120), 2)
    return np.vstack([canvas, strip])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("images", nargs="+", help="image paths or globs")
    parser.add_argument("--out", type=Path, default=None,
                        help="write annotated copies here (skipped if omitted)")
    parser.add_argument("--max-width", type=int, default=480,
                        help="what the pipeline downscales to before detecting (default 480, "
                             "matching app.py). Raise it to test whether a full-body shot's "
                             "face is simply too small at the production setting.")
    args = parser.parse_args()

    paths: List[Path] = []
    for pattern in args.images:
        matched = [Path(p) for p in glob.glob(pattern)]
        paths.extend(matched or [Path(pattern)])
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    print(f"{'file':<34}{'hair':>9}{'spread':>9}{'fallback':>10}{'skin':>9}  verdict")
    suspect = 0
    measured = 0
    for path in paths:
        bgr = _load_bgr(path)
        if bgr is None:
            print(f"{path.name:<34}{'unreadable':>9}")
            continue

        features, calls = _measure(bgr, max_width=args.max_width)
        if not features.get("ok"):
            print(f"{path.name:<34}{'-':>9}{'-':>9}{'-':>10}{'-':>9}  {features.get('error')}")
            continue

        hair, fallback = _hair_calls(calls)
        if hair is None:
            print(f"{path.name:<34}  no hair sample recorded")
            continue

        measured += 1
        used = fallback if fallback is not None else hair
        blended = used["spread"] > BLEND_SPREAD
        suspect += bool(blended)
        verdict = "BLENDED - mean is not a real colour" if blended else "patch is uniform"
        print(f"{path.name:<34}{features['hair_color']:>9}{used['spread']:>9.1f}"
              f"{('yes' if fallback else 'no'):>10}{features['skin_tone']:>9}  {verdict}")

        if args.out:
            annotated = _annotate(bgr, calls, hair, fallback, features["hair_color"])
            cv2.imwrite(str(args.out / f"{path.stem}_hair.png"), annotated)

    # Counted against photos that were actually measured. Reporting "0 of 2
    # blended" when both failed detection would read as a clean bill of health
    # for the one case that matters most.
    print(f"\n{measured} of {len(paths)} photo(s) yielded a measurement; "
          f"{suspect} of those sampled a patch that is not one material.")
    if measured < len(paths):
        print("A photo with no measurement means face_cv_result['ok'] is False, so")
        print("app.py never sets hair_color or skin_tone at all and the prompt falls")
        print("back to 'infer from the photo' -- the model then invents the colour.")
    print("Compare each hair hex against the real hair in the photo. If the hex is")
    print("already wrong here, the fault is in face_module's sampling and no prompt")
    print("or reference-image change can repair it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
