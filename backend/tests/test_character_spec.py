import base64
import unittest
from unittest import mock

from backend.character_spec import build_character_spec, grid_to_webp_data_url, validate_character_spec


def _grid(cols=4, rows=4, active=True):
    return {
        "cols": cols,
        "rows": rows,
        "cells": [
            {"r": 30 + (i % cols) * 20, "g": 90, "b": 160, "active": active}
            for i in range(cols * rows)
        ],
    }


class CharacterSpecTests(unittest.TestCase):
    def test_brick_v2_is_opt_in_and_uses_narrow_species_ranges(self):
        cv_result = {
            "upper": {"hex": "#336699"},
            "lower": {"hex": "#202830"},
            "cloth_grid": _grid(),
            "lower_grid": _grid(),
            "height_class": "tall",
            "capture_quality": {"score": 0.91},
        }
        with mock.patch.dict("os.environ", {"BRICK_CHARACTER_STYLE": "brick_v2"}):
            spec = build_character_spec(request_id="v2-person", cv_result=cv_result)
        self.assertEqual(spec["style_id"], "brick_v2")
        self.assertEqual(spec["style_spec_version"], 3)
        self.assertEqual(spec["hair"]["strategy"], "modular_parametric_3d")
        self.assertEqual(spec["garment_geometry"]["rule"], "deterministic_parts_only")
        self.assertLessEqual(spec["body_shape"]["height_scale"], 1.10)
        self.assertGreaterEqual(spec["body_shape"]["shoulder_width"], 0.92)
        self.assertTrue(validate_character_spec(spec)["passed"])

    def test_texture_is_deterministic_webp(self):
        first, confidence, fallback = grid_to_webp_data_url(_grid(), "#225599", size=64)
        second, _, _ = grid_to_webp_data_url(_grid(), "#225599", size=64)
        self.assertEqual(first, second)
        self.assertGreater(confidence, 0.5)
        self.assertFalse(fallback)
        raw = base64.b64decode(first.split(",", 1)[1])
        self.assertEqual(raw[:4], b"RIFF")
        self.assertEqual(raw[8:12], b"WEBP")

    def test_inactive_grid_uses_solid_fallback(self):
        _, confidence, fallback = grid_to_webp_data_url(_grid(active=False), "#112233", size=32)
        self.assertTrue(fallback)
        self.assertLess(confidence, 0.5)

    def test_builds_versioned_brick_spec(self):
        cv_result = {
            "upper": {"hex": "#336699"},
            "lower": {"hex": "#202830"},
            "arm_color": {"hex": "#336699"},
            "cloth_grid": _grid(),
            "lower_grid": _grid(),
            "height_class": "tall",
            "capture_quality": {"score": 0.91},
        }
        spec = build_character_spec(
            request_id="person-1",
            cv_result=cv_result,
            face_data={
                "hair_style": "long_wavy",
                "hair_color": "#4A2B1A",
                "skin_tone": "#D4956A",
                "smile_score": 0.8,
                "has_beard": True,
                "beard_style": "short",
            },
            outfit_data={"inner": "tshirt", "lower": "jeans", "outer": "none"},
            accessories=["glasses"],
        )
        self.assertEqual(spec["style_id"], "brick_v1")
        self.assertEqual(spec["schema_version"], 2)
        self.assertEqual(spec["style_spec_version"], 2)
        self.assertIn("torso_width", spec["body_shape"])
        self.assertEqual(spec["height_profile"], "tall")
        self.assertEqual(spec["hair"]["style"], "long")
        self.assertTrue(spec["face"]["glasses"])
        self.assertEqual(validate_character_spec(spec)["passed"], True)


if __name__ == "__main__":
    unittest.main()
