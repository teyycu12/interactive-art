import os
import unittest

from backend.style_base import (
    REFERENCE_IMAGE,
    face_stroke_width_px,
    get_style_base,
    material_roughness,
    texture_gradient_budget,
)


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class StyleBaseTests(unittest.TestCase):
    def test_reference_image_is_committed(self):
        # The standard is only reproducible while the image it was measured
        # from stays in the repository.
        self.assertTrue(os.path.isfile(os.path.join(REPO_ROOT, REFERENCE_IMAGE)))

    def test_texture_shading_budget_is_far_below_the_render_gradient(self):
        base = get_style_base()
        budget = texture_gradient_budget()
        rendered = base["shading_budget"]["render_gradient_tb_measured"]
        # The renderer already supplies the vertical falloff, so a texture must
        # not be allowed to contribute a comparable amount on top of it.
        self.assertLess(budget, min(rendered.values()))
        self.assertLessEqual(budget, 0.06)

    def test_key_light_is_frontal_not_lateral(self):
        lateral = get_style_base()["shading_budget"]["render_gradient_lr_measured"]
        vertical = get_style_base()["shading_budget"]["render_gradient_tb_measured"]
        for part, value in lateral.items():
            self.assertLess(value, 0.05, part)
            self.assertLess(value, vertical[part], part)

    def test_materials_span_a_real_roughness_range(self):
        materials = get_style_base()["materials"]
        values = [item["roughness"]["value"] for item in materials.values()]
        # A single global roughness cannot reproduce the reference; the spread
        # between the glossiest and the mattest material must stay meaningful.
        self.assertGreaterEqual(max(values) - min(values), 0.30)
        self.assertEqual(material_roughness("denim"), 0.52)
        self.assertEqual(material_roughness("garment_print"), 0.22)

    def test_unknown_material_falls_back_to_skin(self):
        self.assertEqual(material_roughness("unheard_of"), material_roughness("skin"))

    def test_gloss_ranks_are_unique_and_follow_roughness(self):
        materials = get_style_base()["materials"]
        ranks = [item["gloss_rank"] for item in materials.values()]
        self.assertEqual(sorted(ranks), list(range(1, len(materials) + 1)))
        by_rank = sorted(materials.values(), key=lambda item: item["gloss_rank"])
        roughness = [item["roughness"]["value"] for item in by_rank]
        self.assertEqual(roughness, sorted(roughness))

    def test_face_stroke_width_is_heavier_than_the_old_line_width_rule(self):
        # style_family.py caps face line width at 18px on a 512 panel; the
        # reference print is heavier than that cap.
        self.assertEqual(face_stroke_width_px(512), 26)
        self.assertGreater(face_stroke_width_px(512), 18)

    def test_stroke_width_scales_with_panel_resolution(self):
        # Rounding at each resolution means "close to double", not exactly it.
        self.assertAlmostEqual(face_stroke_width_px(1024), 2 * face_stroke_width_px(512), delta=1)

    def test_fingerprint_targets_cover_every_measured_region(self):
        targets = get_style_base()["fingerprint_targets"]
        self.assertEqual(targets["measured_with"], "style_fingerprint_v1")
        for region in ("face", "garment_torso", "denim_leg", "shoe"):
            self.assertIn("stroke_width_rel", targets[region], region)
        # The texture budget, not the render's own shading, gates a panel.
        for region in ("face", "garment_torso", "denim_leg", "shoe"):
            self.assertNotIn("directional_gradient", targets[region], region)

    def test_weathering_and_directional_light_are_disjoint(self):
        taxonomy = get_style_base()["shading_taxonomy"]
        allowed = set(taxonomy["allowed_in_texture"])
        forbidden = set(taxonomy["forbidden_in_texture"])
        self.assertFalse(allowed & forbidden)
        # Denim fade is the detail that carries garment fidelity; it must stay
        # legal even though it reads as luminance variation.
        self.assertIn("denim_fade", allowed)
        self.assertIn("directional_key_light", forbidden)
        self.assertIn("garment_silhouette", forbidden)

    def test_occluded_measurements_are_marked_and_not_treated_as_authoritative(self):
        base = get_style_base()
        self.assertEqual(base["widths"]["head"]["confidence"], "occluded")
        self.assertEqual(base["landmarks_y"]["head_top"]["confidence"], "occluded")
        self.assertEqual(base["derived_ratios"]["head_aspect_w_over_h"]["confidence"], "occluded")

    def test_leg_pair_matches_torso_width(self):
        widths = get_style_base()["widths"]
        pair = 2 * widths["leg_single"]["value"] + widths["leg_gap"]["value"]
        self.assertAlmostEqual(pair, widths["torso_no_arms"]["value"], delta=0.02)

    def test_landmarks_are_monotonic_top_to_bottom(self):
        landmarks = get_style_base()["landmarks_y"]
        order = ["hair_top", "head_top", "collar", "waist", "inseam",
                 "leg_split_visible", "shoe_top", "sole"]
        values = [landmarks[name]["value"] for name in order]
        self.assertEqual(values, sorted(values))
        self.assertLessEqual(values[-1], 1.0)


if __name__ == "__main__":
    unittest.main()
