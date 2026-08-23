"""Stray blobs beside the figure must be erased, without eating real parts.

The model sometimes paints the source photo's ground shadow next to the feet.
It is grey, so ``_remove_white_background``'s flood fill cannot travel through
it, and it is small, so ``validate_avatar_png`` waves it through -- that gate
fires at ``main_component_ratio < 0.75``, sized for a severed limb, and a blob
under 1% leaves the ratio near 0.99. The blob then reaches the frontend and,
worse than being visible, widens the opaque bounding box the tight crop uses and
shifts the whole figure off centre.

The threshold is the whole design here, so most of these tests are about what
must NOT be deleted. A shoe rendered a few pixels clear of the leg is small too,
and erasing one would manufacture the exact fault ``missing_bottom_left`` exists
to report.
"""

import base64
import io
import unittest

import numpy as np
from PIL import Image as PILImage

from backend.garment_gen import _drop_detached_islands, _remove_white_background


FIGURE = (np.s_[60:320], np.s_[170:230])   # 260 x 60 = 15600 px
SHADOW = (np.s_[300:308], np.s_[240:248])  # 64 px, 0.41% of the figure
SHOE = (np.s_[308:318], np.s_[132:158])    # 260 px, 1.67% of the figure
LIMB = (np.s_[100:300], np.s_[60:110])     # 10000 px, 64% of the figure


def _canvas(*extras) -> np.ndarray:
    arr = np.full((400, 400, 4), 255, dtype=np.uint8)
    arr[FIGURE[0], FIGURE[1]] = (120, 90, 60, 255)
    for rows, cols in extras:
        arr[rows, cols] = (170, 170, 170, 255)
    arr[np.all(arr[:, :, :3] >= 237, axis=-1), 3] = 0   # emulate the white cut
    return arr


def _alpha_at(arr: np.ndarray, region) -> int:
    return int(arr[region[0], region[1], 3].max())


def _as_b64(arr: np.ndarray) -> str:
    buf = io.BytesIO()
    PILImage.fromarray(arr, mode="RGBA").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _opaque_box(png_b64: str):
    raw = base64.b64decode(png_b64)
    alpha = np.array(PILImage.open(io.BytesIO(raw)).convert("RGBA"))[:, :, 3]
    ys, xs = np.where(alpha > 5)
    return int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)


class ErasesStrayShadowTests(unittest.TestCase):
    def test_a_painted_ground_shadow_is_erased(self):
        cleaned = _drop_detached_islands(_canvas(SHADOW))
        self.assertEqual(_alpha_at(cleaned, SHADOW), 0)

    def test_the_figure_itself_is_never_touched(self):
        cleaned = _drop_detached_islands(_canvas(SHADOW))
        self.assertEqual(_alpha_at(cleaned, FIGURE), 255)

    def test_a_single_component_image_is_returned_unchanged(self):
        arr = _canvas()
        self.assertTrue(np.array_equal(_drop_detached_islands(arr.copy()), arr))


class KeepsRealPartsTests(unittest.TestCase):
    def test_a_detached_shoe_survives(self):
        # 1.67% of the figure. Deleting it would leave a footless character and
        # trip missing_bottom_left downstream -- a fault we caused ourselves.
        cleaned = _drop_detached_islands(_canvas(SHOE))
        self.assertEqual(_alpha_at(cleaned, SHOE), 255)

    def test_a_severed_limb_survives_so_the_validator_can_report_it(self):
        # Silently deleting it would hide the fault from fragmented_foreground
        # and ship a one-legged character as if it had passed.
        cleaned = _drop_detached_islands(_canvas(LIMB))
        self.assertEqual(_alpha_at(cleaned, LIMB), 255)

    def test_a_shadow_next_to_a_shoe_goes_while_the_shoe_stays(self):
        cleaned = _drop_detached_islands(_canvas(SHADOW, SHOE))
        self.assertEqual(_alpha_at(cleaned, SHADOW), 0)
        self.assertEqual(_alpha_at(cleaned, SHOE), 255)


class CropInteractionTests(unittest.TestCase):
    def test_the_shadow_no_longer_widens_the_tight_crop(self):
        # The reason this runs before the crop rather than after it.
        with_shadow = _remove_white_background(_as_b64(_canvas(SHADOW)))
        without = _remove_white_background(_as_b64(_canvas()))
        self.assertEqual(_opaque_box(with_shadow), _opaque_box(without))


if __name__ == "__main__":
    unittest.main()
