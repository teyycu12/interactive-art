import unittest

import cv2
import numpy as np

from backend.style_base import get_style_base
from backend.style_fingerprint import (
    base_expectations,
    compare_to_base,
    fingerprint_spread,
    panel_fingerprint,
)


SIZE = 452


def _face_panel(stroke_px, base=(168, 208, 255)):
    """A face print at a chosen line weight."""
    panel = np.full((SIZE, SIZE, 3), base, dtype=np.uint8)
    ink = (22, 22, 24)
    cv2.line(panel, (140, 150), (200, 150), ink, stroke_px)
    cv2.line(panel, (252, 150), (312, 150), ink, stroke_px)
    cv2.circle(panel, (170, 205), stroke_px, ink, -1)
    cv2.circle(panel, (282, 205), stroke_px, ink, -1)
    cv2.ellipse(panel, (226, 280), (66, 30), 0, 0, 180, ink, stroke_px)
    return panel


class StyleFingerprintTests(unittest.TestCase):
    def test_stroke_width_tracks_the_drawn_line_weight(self):
        thin = panel_fingerprint(_face_panel(6))
        thick = panel_fingerprint(_face_panel(30))
        self.assertGreater(thick["stroke_width_px"], thin["stroke_width_px"] * 1.8)
        self.assertGreater(thick["stroke_width_rel"], thin["stroke_width_rel"])

    def test_thin_lines_fail_the_face_band_and_reference_weight_passes(self):
        target = get_style_base()["fingerprint_targets"]["face"]["stroke_width_rel"]
        # The old style_family rule allowed 4-18px on a 512 panel; scaled to
        # this crop that sits well below the measured reference weight.
        thin = compare_to_base(panel_fingerprint(_face_panel(4)), "face")
        self.assertIn("face_stroke_width_rel_out_of_band", thin["violations"])
        reference_px = int(round(target * SIZE))
        good = compare_to_base(panel_fingerprint(_face_panel(reference_px)), "face")
        self.assertNotIn("face_stroke_width_rel_out_of_band", good["violations"])

    def test_measurement_is_stable_across_panel_resolutions(self):
        panel = _face_panel(22)
        native = panel_fingerprint(panel)
        for size in (256, 512):
            resized = panel_fingerprint(cv2.resize(panel, (size, size), interpolation=cv2.INTER_LANCZOS4))
            # Bands are meaningless if the same artwork measures differently at
            # 452 and 512; the canonical working size keeps this within 20%.
            self.assertAlmostEqual(
                resized["stroke_width_rel"], native["stroke_width_rel"],
                delta=0.20 * native["stroke_width_rel"],
            )

    def test_only_direct_features_become_violations(self):
        result = compare_to_base(panel_fingerprint(_face_panel(6)), "face")
        for name in result["violations"]:
            feature = name.replace("face_", "").replace("_out_of_band", "")
            self.assertEqual(result["features"][feature]["transfer"], "direct")

    def test_edge_density_is_an_observation_not_a_violation(self):
        # A busy panel blows past the reference edge density, but that target
        # came from a render carrying silhouette edges a flat panel has not, so
        # it must never fail a panel on its own.
        rng = np.random.default_rng(3)
        panel = rng.integers(0, 255, (SIZE, SIZE, 3), dtype=np.uint8)
        result = compare_to_base(panel_fingerprint(panel), "torso_front")
        self.assertIn("torso_front_edge_density_out_of_band", result["observations"])
        self.assertNotIn("torso_front_edge_density_out_of_band", result["violations"])

    def test_baked_lighting_is_a_direct_violation(self):
        panel = np.full((SIZE, SIZE, 3), (90, 120, 70), dtype=np.uint8)
        ramp = np.linspace(0.45, 1.45, SIZE, dtype=np.float32)[None, :, None]
        lit = np.clip(panel.astype(np.float32) * ramp, 0, 255).astype(np.uint8)
        result = compare_to_base(panel_fingerprint(lit), "torso_front")
        self.assertIn("torso_front_directional_gradient_out_of_band", result["violations"])
        self.assertFalse(result["passed"])

    def test_reference_regions_all_have_a_band(self):
        for region in ("face", "garment_torso", "denim_leg", "shoe"):
            expectations = base_expectations(region)
            self.assertIn("stroke_width_rel", expectations, region)
            self.assertIn("directional_gradient", expectations, region)

    def test_leg_panels_share_the_denim_region(self):
        self.assertEqual(base_expectations("denim_leg")["region"], "denim_leg")
        left = compare_to_base(panel_fingerprint(_face_panel(20)), "left_leg_front")
        right = compare_to_base(panel_fingerprint(_face_panel(20)), "right_leg_front")
        self.assertEqual(left["region"], "denim_leg")
        self.assertEqual(right["region"], "denim_leg")

    def test_unmeasurable_panel_fails_closed(self):
        result = compare_to_base(panel_fingerprint(np.zeros((0, 0, 3), np.uint8)), "face")
        self.assertFalse(result["passed"])
        self.assertIn("face_unmeasurable", result["violations"])

    def test_spread_separates_a_consistent_cast_from_a_drifting_one(self):
        consistent = [panel_fingerprint(_face_panel(width)) for width in (26, 27, 28, 27)]
        drifting = [panel_fingerprint(_face_panel(width)) for width in (5, 14, 28, 44)]
        tight = fingerprint_spread(consistent)
        loose = fingerprint_spread(drifting)
        self.assertTrue(tight["measurable"])
        self.assertLess(
            tight["features"]["stroke_width_rel"]["relative_spread"],
            loose["features"]["stroke_width_rel"]["relative_spread"],
        )

    def test_spread_needs_at_least_two_characters(self):
        single = fingerprint_spread([panel_fingerprint(_face_panel(20))])
        self.assertFalse(single["measurable"])
        self.assertEqual(single["characters"], 1)

    def test_fingerprint_is_deterministic(self):
        panel = _face_panel(22)
        self.assertEqual(panel_fingerprint(panel), panel_fingerprint(panel.copy()))


if __name__ == "__main__":
    unittest.main()
