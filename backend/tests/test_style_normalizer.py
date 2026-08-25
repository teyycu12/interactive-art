import unittest

import cv2
import numpy as np

from backend.style_base import texture_gradient_budget
from backend.style_normalizer import (
    directional_gradient,
    flatten_panel,
    flatten_panels,
)


SIZE = 452  # the crop size validate_ai_atlas works with


def _base_panel(color=(90, 120, 70)):
    return np.full((SIZE, SIZE, 3), color, dtype=np.uint8)


def _with_print(panel):
    """Seams, stitching and a numeral: the detail flattening must preserve."""
    panel = panel.copy()
    cv2.line(panel, (SIZE // 2, 0), (SIZE // 2, SIZE), (240, 240, 240), 5)
    for y in range(40, SIZE - 40, 46):
        cv2.line(panel, (40, y), (SIZE - 40, y), (220, 225, 230), 3)
    cv2.putText(panel, "9", (SIZE // 3, SIZE // 2), cv2.FONT_HERSHEY_SIMPLEX,
                4.5, (250, 250, 250), 14)
    return panel


def _with_directional_light(panel, low=0.55, high=1.35, axis="x"):
    ramp = np.linspace(low, high, SIZE, dtype=np.float32)
    ramp = ramp[None, :, None] if axis == "x" else ramp[:, None, None]
    return np.clip(panel.astype(np.float32) * ramp, 0, 255).astype(np.uint8)


def _with_weathering(panel, seed=11):
    """Patchy denim-style fade: no consistent light direction."""
    rng = np.random.default_rng(seed)
    field = rng.random((10, 10), dtype=np.float32)
    field = cv2.resize(field, (SIZE, SIZE), interpolation=cv2.INTER_CUBIC)
    field = 0.80 + 0.40 * (field - field.min()) / max(1e-6, float(np.ptp(field)))
    return np.clip(panel.astype(np.float32) * field[:, :, None], 0, 255).astype(np.uint8)


def _edge_density(panel):
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    return float(np.mean(cv2.Canny(gray, 60, 150) > 0))


class StyleNormalizerTests(unittest.TestCase):
    def test_clean_panel_is_left_untouched(self):
        panel = _with_print(_base_panel())
        flat, metrics = flatten_panel(panel)
        self.assertTrue(metrics["within_budget"])
        self.assertEqual(metrics["correction_strength"], 0.0)
        # Idempotence matters: validate and split both run this, so a clean
        # panel must survive byte-for-byte.
        self.assertTrue(np.array_equal(flat, panel))

    def test_horizontal_key_light_is_removed(self):
        panel = _with_directional_light(_with_print(_base_panel()), axis="x")
        self.assertGreater(directional_gradient(panel), texture_gradient_budget())
        flat, metrics = flatten_panel(panel)
        self.assertTrue(metrics["within_budget"], metrics)
        self.assertLessEqual(metrics["gradient_after"], texture_gradient_budget())
        self.assertGreater(metrics["correction_strength"], 0.0)

    def test_vertical_key_light_is_removed(self):
        panel = _with_directional_light(_with_print(_base_panel()), axis="y")
        flat, metrics = flatten_panel(panel)
        self.assertTrue(metrics["within_budget"], metrics)
        self.assertLess(metrics["gradient_after"], metrics["gradient_before"])

    def test_flattening_preserves_print_detail(self):
        panel = _with_directional_light(_with_print(_base_panel()), axis="x")
        before = _edge_density(panel)
        flat, _ = flatten_panel(panel)
        after = _edge_density(flat)
        # Seams, stitching and the numeral must survive de-lighting.
        self.assertGreater(after, before * 0.75)

    def test_material_weathering_survives(self):
        panel = _with_weathering(_with_print(_base_panel((120, 130, 135))))
        flat, metrics = flatten_panel(panel)
        # Denim fade carries garment fidelity; it has no single light
        # direction, so it must not be treated as baked lighting.
        residual_before = float(np.std(cv2.cvtColor(panel, cv2.COLOR_BGR2LAB)[:, :, 0]))
        residual_after = float(np.std(cv2.cvtColor(flat, cv2.COLOR_BGR2LAB)[:, :, 0]))
        self.assertGreater(residual_after, residual_before * 0.80)

    def test_weathering_plus_key_light_keeps_weathering_and_loses_the_light(self):
        weathered = _with_weathering(_with_print(_base_panel((120, 130, 135))))
        lit = _with_directional_light(weathered, axis="x")
        flat, metrics = flatten_panel(lit)
        self.assertLess(metrics["gradient_after"], metrics["gradient_before"])
        local = cv2.cvtColor(flat, cv2.COLOR_BGR2LAB)[:, :, 0].astype(np.float32)
        blurred = cv2.GaussianBlur(local, (0, 0), sigmaX=3.0)
        self.assertGreater(float(np.std(local - blurred)), 1.0)

    def test_correction_is_the_smallest_that_reaches_budget(self):
        mild = _with_directional_light(_base_panel(), low=0.85, high=1.15)
        harsh = _with_directional_light(_base_panel(), low=0.40, high=1.60)
        _, mild_metrics = flatten_panel(mild)
        _, harsh_metrics = flatten_panel(harsh)
        self.assertLess(mild_metrics["correction_strength"], harsh_metrics["correction_strength"])

    def test_flattening_is_idempotent(self):
        panel = _with_directional_light(_with_print(_base_panel()), axis="x")
        once, _ = flatten_panel(panel)
        twice, metrics = flatten_panel(once)
        self.assertEqual(metrics["correction_strength"], 0.0)
        self.assertTrue(np.array_equal(once, twice))

    def test_a_panel_that_cannot_reach_budget_is_reported_not_silently_passed(self):
        # Fitting on blurred luminance makes the flatten strong enough to
        # remove almost any panel-scale imbalance, so this branch is exercised
        # with a budget the panel genuinely cannot meet.
        panel = _with_directional_light(_with_print(_base_panel()), axis="x")
        _, metrics = flatten_panel(panel, budget=0.0001)
        self.assertFalse(metrics["within_budget"])
        self.assertEqual(metrics["correction_strength"], 1.0)
        self.assertLess(metrics["gradient_after"], metrics["gradient_before"])

    def test_a_hard_two_tone_split_is_still_flattened(self):
        # A step is not a light field, but a second-order surface fits it well
        # enough to null the gradient. That is intended for this pipeline: a
        # two-tone panel is a garment silhouette hint, which brick_v2_atlas
        # rejects separately.
        panel = _base_panel((40, 40, 40))
        panel[:, SIZE // 2:] = (235, 235, 235)
        _, metrics = flatten_panel(panel)
        self.assertGreater(metrics["gradient_before"], texture_gradient_budget())
        self.assertTrue(metrics["within_budget"])

    def test_flatten_panels_summarises_each_panel(self):
        panels = {
            "face": _with_print(_base_panel()),
            "torso_front": _with_directional_light(_base_panel(), axis="x"),
            "left_leg_front": _base_panel((70, 70, 80)),
            "right_leg_front": _base_panel((70, 70, 80)),
        }
        flattened, report = flatten_panels(panels)
        self.assertEqual(set(flattened), set(panels))
        self.assertEqual(report["normalizer"], "style_flatten_v1")
        self.assertIn("torso_front", report["corrected"])
        self.assertNotIn("face", report["corrected"])
        self.assertEqual(report["unfixable"], [])


if __name__ == "__main__":
    unittest.main()
