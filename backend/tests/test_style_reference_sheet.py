"""The style reference sheet, and the prompt that has to stay in step with it.

The failure this file exists to prevent is desynchronisation, not a bad sheet.
Before the style sheet was added the prompt named the pose reference as "the
final image"; a fourth attachment would have quietly pointed that sentence at
the style sheet and told the model to copy the reference characters' geometry.
Nothing would have raised, and the only symptom would have been drift in the
generated sprites. So the tests below pin the *relationship* between the images
sent and the roles named, across every combination of optional attachments.
"""

import os
import unittest
from unittest import mock

from PIL import Image as PILImage

from backend.garment_gen import (
    _STYLE_SHEET_FIREWALL,
    _build_style_reference_sheet,
    _compose_inputs,
    _style_reference_sheet,
    _style_sheet_cache,
)


def _dummy(width: int = 64, height: int = 96) -> PILImage.Image:
    return PILImage.new("RGB", (width, height), (200, 180, 160))


def _image_lines(text: str) -> list:
    return [line for line in text.splitlines() if line.startswith("Image ")]


class ComposeInputsTests(unittest.TestCase):
    def test_every_attachment_is_named_exactly_once_in_order(self):
        for detail in (None, _dummy()):
            for style in (None, _dummy()):
                with self.subTest(detail=detail is not None, style=style is not None):
                    urls, text = _compose_inputs("data:image/png;base64,AAAA", detail, style)
                    lines = _image_lines(text)
                    self.assertEqual(
                        len(urls), len(lines),
                        "the prompt names a different number of images than are attached",
                    )
                    for index, line in enumerate(lines, 1):
                        self.assertTrue(line.startswith(f"Image {index}:"))

    def test_pose_reference_is_never_described_as_the_final_image(self):
        # The exact regression: with a style sheet attached the pose reference is
        # image 3 of 4, so any positional wording would point at the wrong one.
        _, text = _compose_inputs("data:image/png;base64,AAAA", _dummy(), _dummy())
        pose_line = next(line for line in _image_lines(text) if "pose reference" in line)
        self.assertTrue(pose_line.startswith("Image 3:"))
        self.assertNotIn("final image", text)

    def test_firewall_is_present_exactly_when_the_style_sheet_is(self):
        _, with_sheet = _compose_inputs("data:image/png;base64,AAAA", None, _dummy())
        _, without_sheet = _compose_inputs("data:image/png;base64,AAAA", None, None)
        self.assertIn(_STYLE_SHEET_FIREWALL, with_sheet)
        self.assertNotIn(_STYLE_SHEET_FIREWALL, without_sheet)

    def test_firewall_names_the_attributes_that_must_not_be_copied(self):
        # These are the copy vectors the curated set was designed around; if one
        # is dropped from the wording the sheet stops being style-only.
        for attribute in ("colour", "pattern", "garment", "hairstyle", "skin tone", "face"):
            with self.subTest(attribute=attribute):
                self.assertIn(attribute, _STYLE_SHEET_FIREWALL.lower())


class SheetBuildTests(unittest.TestCase):
    def setUp(self):
        _style_sheet_cache.clear()

    def tearDown(self):
        _style_sheet_cache.clear()

    def test_missing_set_degrades_instead_of_raising(self):
        self.assertIsNone(_build_style_reference_sheet("no_such_set_id"))

    def test_curated_set_packs_into_a_three_column_grid(self):
        sheet = _build_style_reference_sheet("2026q3_owner_curated")
        if sheet is None:
            self.skipTest("the curated set is not present in this checkout")
        self.assertEqual(sheet.width, 1024)
        # Three 341 px columns of 2:3 cells, so five figures need two rows.
        self.assertEqual(sheet.height, int(1024 // 3 * 1.5) * 2)

    def test_sheet_keeps_the_near_white_ground_the_references_were_shot_on(self):
        sheet = _build_style_reference_sheet("2026q3_owner_curated")
        if sheet is None:
            self.skipTest("the curated set is not present in this checkout")
        self.assertEqual(sheet.getpixel((2, 2)), (254, 254, 253))

    def test_mode_off_rolls_back_to_the_three_image_send(self):
        with mock.patch.dict(os.environ, {"STYLE_REFERENCE_MODE": "off"}):
            self.assertIsNone(_style_reference_sheet())

    def test_unknown_set_id_does_not_break_generation(self):
        with mock.patch.dict(os.environ, {"STYLE_REFERENCE_MODE": "sheet",
                                          "STYLE_REFERENCE_SET": "no_such_set_id"}):
            self.assertIsNone(_style_reference_sheet())


if __name__ == "__main__":
    unittest.main()
