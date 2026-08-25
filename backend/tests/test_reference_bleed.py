"""The bleed check must refuse to answer when the answer cannot be known.

A colour test between two hypotheses -- "it copied the visitor" and "it copied
the reference" -- is only meaningful when the two predict different pixels. A
visitor dressed like a reference character makes them predict the same thing,
and any verdict returned there is an artefact of rounding.

Most of these tests are therefore about silence rather than detection. The
detection half is easy and would pass with a broken ambiguity guard; the guard
is what stops the metric from producing a stream of confident, meaningless
verdicts once the reference set covers the colour space, which is exactly what
a well-curated set does.

The palette is injected rather than read from disk. The real reference images
are gitignored, so a test that needed them would go quiet in a fresh clone --
and a bleed detector that silently stops running is worse than none.
"""

import io
import unittest
from unittest import mock

import numpy as np
from PIL import Image, ImageDraw

from backend import reference_bleed
from backend.reference_bleed import (
    AMBIGUITY_FLOOR,
    _hex_to_lab,
    color_allegiance,
    reference_palette,
)


def _sprite(torso=(40, 100, 180), legs=(30, 30, 30), skin=(200, 160, 130)):
    image = Image.new("RGBA", (300, 700), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((110, 20, 190, 215), fill=skin + (255,))
    draw.rectangle((80, 210, 220, 425), fill=torso + (255,))
    draw.rectangle((90, 420, 210, 645), fill=legs + (255,))
    draw.rectangle((85, 640, 215, 685), fill=(20, 20, 20, 255))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _visitor(upper="#2864B4", lower="#1E1E1E", skin="#C8A082"):
    return {"upper": {"hex": upper}, "lower": {"hex": lower}, "skin_tone": skin}


def _palette(**regions):
    return {region: [_hex_to_lab(value) for value in values] for region, values in regions.items()}


class AllegianceTests(unittest.TestCase):
    def setUp(self):
        self._patch = mock.patch.dict(reference_bleed._palette_cache, clear=True)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()

    def _run(self, sprite, visitor, palette):
        with mock.patch.object(reference_bleed, "reference_palette", return_value=palette):
            return color_allegiance(sprite, visitor)

    def test_a_garment_matching_the_visitor_sides_with_the_visitor(self):
        result = self._run(
            _sprite(torso=(40, 100, 180)), _visitor(upper="#2864B4"),
            _palette(garment_torso=["#B43C28"]),   # reference wears red, visitor blue
        )
        self.assertEqual(result["regions"]["garment_torso"]["verdict"], "visitor")
        self.assertEqual(result["warnings"], [])

    def test_a_garment_matching_the_reference_is_reported_as_a_warning(self):
        # The visitor wore blue; the figure came back in the reference's red.
        result = self._run(
            _sprite(torso=(40, 60, 180)), _visitor(upper="#28B464"),
            _palette(garment_torso=["#B43C28"]),
        )
        self.assertEqual(result["regions"]["garment_torso"]["verdict"], "reference")
        self.assertTrue(any("garment_torso" in warning for warning in result["warnings"]))

    def test_a_visitor_dressed_like_the_reference_withholds_the_verdict(self):
        # Both hypotheses predict the same pixels, so neither can be confirmed.
        result = self._run(
            _sprite(torso=(40, 100, 180)), _visitor(upper="#2864B4"),
            _palette(garment_torso=["#2A66B6"]),
        )
        entry = result["regions"]["garment_torso"]
        self.assertEqual(entry["verdict"], "indistinguishable")
        self.assertLess(entry["hypothesis_separation"], AMBIGUITY_FLOOR)
        self.assertEqual(result["warnings"], [])
        self.assertGreaterEqual(result["withheld"], 1)

    def test_withheld_is_reported_so_no_warnings_is_not_read_as_no_bleed(self):
        result = self._run(
            _sprite(), _visitor(upper="#2864B4", lower="#1E1E1E", skin="#C8A082"),
            _palette(garment_torso=["#2A66B6"], denim_leg=["#1F1F1F"], face=["#C7A183"]),
        )
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["withheld"], 3, "every region was undecidable here")

    def test_skin_tone_is_checked_because_a_shared_complexion_hides_in_plain_sight(self):
        result = self._run(
            _sprite(skin=(120, 90, 70)), _visitor(skin="#E8C4A0"),
            _palette(face=["#465A78"]),
        )
        self.assertIn("face", result["regions"])
        self.assertIn(result["regions"]["face"]["verdict"], {"visitor", "reference", "unclear"})

    def test_a_region_with_nothing_measured_says_so_rather_than_guessing(self):
        result = self._run(
            _sprite(), {"upper": {"hex": "#2864B4"}},
            _palette(garment_torso=["#B43C28"], denim_leg=["#B43C28"]),
        )
        self.assertEqual(result["regions"]["denim_leg"]["verdict"], "not_measurable")
        self.assertIn("no CV colour", result["regions"]["denim_leg"]["reason"])

    def test_findings_are_warnings_and_never_an_error_field(self):
        result = self._run(
            _sprite(torso=(40, 60, 180)), _visitor(upper="#28B464"),
            _palette(garment_torso=["#B43C28"]),
        )
        self.assertNotIn("errors", result)
        self.assertIsInstance(result["warnings"], list)


class DegradationTests(unittest.TestCase):
    def test_a_missing_reference_set_degrades_instead_of_raising(self):
        with mock.patch.dict(reference_bleed._palette_cache, clear=True):
            self.assertIsNone(reference_palette("no_such_set_id"))
            with mock.patch.object(reference_bleed, "reference_palette", return_value=None):
                result = color_allegiance(_sprite(), _visitor())
        self.assertFalse(result["measurable"])
        self.assertEqual(result["error"], "no_reference_palette")

    def test_an_unreadable_sprite_degrades_instead_of_raising(self):
        with mock.patch.object(
            reference_bleed, "reference_palette",
            return_value=_palette(garment_torso=["#B43C28"]),
        ):
            result = color_allegiance(b"not a png", _visitor())
        self.assertFalse(result["measurable"])
        self.assertEqual(result["warnings"], [])


class ColourConversionTests(unittest.TestCase):
    def test_hex_parsing_rejects_junk_rather_than_returning_black(self):
        # Silently returning a colour for a bad hex would put a real distance
        # on a value that was never measured.
        for value in (None, "", "#12345", "not-a-colour", "#GGGGGG"):
            with self.subTest(value=value):
                self.assertIsNone(_hex_to_lab(value))

    def test_the_same_colour_reaches_lab_identically_from_hex_and_from_pixels(self):
        # The visitor colour arrives as hex and the sprite colour as pixels; if
        # the two paths disagreed, every distance would carry a fixed bias.
        from backend.reference_bleed import _lab_median
        from_hex = _hex_to_lab("#2864B4")
        from_pixels = _lab_median(np.full((16, 16, 3), (180, 100, 40), dtype=np.uint8))
        for left, right in zip(from_hex, from_pixels):
            self.assertAlmostEqual(left, right, delta=1.5)


if __name__ == "__main__":
    unittest.main()
