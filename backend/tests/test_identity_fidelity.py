"""Content spread must move opposite to style spread, and hue must be circular.

Two failure modes are worth more than the rest of this module combined.

The first is a spread number that cannot tell "everyone got the same clothes"
from "everyone kept their own", because that is the exact question the metric
was added to answer, and both cases produce a tidy-looking figure.

The second is hue arithmetic across the 0/360 wrap. A cast of red-clad visitors
sits at 359 and 1 degrees, two degrees apart; the naive standard deviation
calls it 179 and reports maximum diversity. That number is not obviously wrong
when you read it, which is what makes it dangerous, so it is pinned here.
"""

import io
import unittest

import numpy as np
from PIL import Image, ImageDraw

from backend.identity_fidelity import (
    _circular_mean_deg,
    _circular_spread,
    content_spread_by_region,
    individual_spread,
    region_content,
    sprite_content_signature,
)


def _sprite(torso=(40, 100, 180), legs=(30, 30, 30), skin=(200, 160, 130), stripes=False):
    """A figure whose parts are connected, so the silhouette is one component."""
    image = Image.new("RGBA", (300, 700), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((110, 20, 190, 215), fill=skin + (255,))
    draw.rectangle((80, 210, 220, 425), fill=torso + (255,))
    if stripes:
        for y in range(220, 425, 24):
            draw.rectangle((80, y, 220, y + 10), fill=(250, 250, 250, 255))
    draw.rectangle((90, 420, 210, 645), fill=legs + (255,))
    draw.rectangle((85, 640, 215, 685), fill=(20, 20, 20, 255))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _flat(bgr, size=64):
    return np.full((size, size, 3), bgr, dtype=np.uint8)


class CircularHueTests(unittest.TestCase):
    def test_hues_either_side_of_the_wrap_are_near_not_far(self):
        circular = _circular_spread([359.0, 1.0])
        self.assertLess(circular, 0.01)
        # The number the naive calculation would have produced, for contrast.
        self.assertGreater(float(np.std([359.0, 1.0])), 100.0)

    def test_opposite_hues_report_no_mean_direction_rather_than_a_made_up_one(self):
        self.assertIsNone(_circular_mean_deg(np.array([0.0, 180.0])))
        self.assertEqual(_circular_spread([0.0, 180.0]), 1.0)

    def test_spread_grows_as_the_cast_uses_more_of_the_colour_wheel(self):
        tight = _circular_spread([10.0, 14.0, 12.0])
        wide = _circular_spread([10.0, 130.0, 250.0])
        self.assertLess(tight, wide)


class RegionContentTests(unittest.TestCase):
    def test_a_greyscale_region_reports_no_hue_instead_of_a_noise_hue(self):
        content = region_content(_flat((128, 128, 128)))
        self.assertTrue(content["valid"])
        self.assertIsNone(content["hue_deg"])
        self.assertLess(content["chroma_median"], 5.0)

    def test_a_patterned_region_counts_more_colours_than_a_plain_one(self):
        plain = region_content(_flat((40, 100, 180)))
        patterned = np.full((64, 64, 3), (40, 100, 180), dtype=np.uint8)
        patterned[::4] = (250, 250, 250)
        self.assertGreater(region_content(patterned)["colour_count"], plain["colour_count"])

    def test_hue_ignores_the_grey_pixels_that_have_no_opinion(self):
        # Half strongly blue, half neutral grey. Chroma weighting must let the
        # blue decide the hue rather than averaging toward the grey's noise.
        mixed = np.full((64, 64, 3), (128, 128, 128), dtype=np.uint8)
        mixed[:, :32] = (200, 60, 40)
        blue_only = region_content(_flat((200, 60, 40)))["hue_deg"]
        self.assertAlmostEqual(region_content(mixed)["hue_deg"], blue_only, delta=8.0)


class IndividualSpreadTests(unittest.TestCase):
    def test_a_flattened_cast_scores_below_a_varied_one(self):
        # This is the metric's whole purpose: both casts are valid figures, and
        # only the content spread separates "everyone kept their clothes" from
        # "everyone got the reference's clothes".
        same = [sprite_content_signature(_sprite()) for _ in range(4)]
        varied = [
            sprite_content_signature(_sprite(torso=colour))
            for colour in ((40, 100, 180), (180, 60, 50), (60, 160, 70), (200, 190, 40))
        ]
        flattened = content_spread_by_region(same)["garment_torso"]["features"]
        preserved = content_spread_by_region(varied)["garment_torso"]["features"]
        self.assertLess(flattened["hue_deg"]["circular_spread"],
                        preserved["hue_deg"]["circular_spread"])

    def test_a_repainted_cast_is_not_called_varied_by_lightness_alone(self):
        # Redrawing one garment lighter must not read as four different people.
        shades = [sprite_content_signature(_sprite(torso=(c, c, c))) for c in (60, 90, 120, 150)]
        features = content_spread_by_region(shades)["garment_torso"]["features"]
        self.assertNotIn("hue_deg", features, "greyscale garments must contribute no hue")
        self.assertGreater(features["lightness_median"]["relative_spread"], 0)

    def test_one_character_is_not_measurable(self):
        result = individual_spread([sprite_content_signature(_sprite())])
        self.assertFalse(result["measurable"])
        self.assertEqual(result["characters"], 1)

    def test_an_unreadable_sprite_is_excluded_rather_than_counted_as_agreeing(self):
        signature = sprite_content_signature(b"not a png")
        self.assertFalse(signature["valid"])
        self.assertFalse(individual_spread([signature, signature])["measurable"])

    def test_bounded_hue_spread_is_labelled_apart_from_unbounded_ratios(self):
        # The two live in one features dict and must never be averaged together.
        varied = [sprite_content_signature(_sprite(torso=colour))
                  for colour in ((40, 100, 180), (180, 60, 50), (60, 160, 70))]
        features = content_spread_by_region(varied)["garment_torso"]["features"]
        self.assertEqual(features["hue_deg"]["scale"], "circular_variance_0_to_1")
        self.assertNotIn("relative_spread", features["hue_deg"])
        self.assertNotIn("circular_spread", features["chroma_median"])


class RegionAgreementTests(unittest.TestCase):
    def test_content_and_style_are_measured_on_the_same_regions(self):
        # A drift between the two cuts would make the trade-off comparison
        # meaningless while still looking like a valid pair of numbers.
        from backend.style_probe import REGION_BANDS, sprite_fingerprint
        png = _sprite()
        content = sprite_content_signature(png)
        style = sprite_fingerprint(png)
        self.assertEqual(set(content["regions"]), set(REGION_BANDS))
        self.assertEqual(set(content["regions"]), set(style["regions"]))
        self.assertEqual(content["subject_px"], style["subject_px"])


if __name__ == "__main__":
    unittest.main()
