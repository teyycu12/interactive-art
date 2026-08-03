import unittest

from backend.brick_v2_spec import clamp_brick_v2_variation, get_brick_v2_spec


class BrickV2SpecTests(unittest.TestCase):
    def test_species_requires_real_uv_and_no_floating_decals(self):
        spec = get_brick_v2_spec()
        self.assertEqual(spec["style_id"], "brick_v2")
        self.assertFalse(spec["uv"]["floating_decals_allowed"])
        self.assertEqual(spec["silhouette"]["hand"]["type"], "c_claw")
        self.assertEqual(spec["uv"]["face"]["layout"], "conformal_curved_front_surface")
        self.assertEqual(spec["hair_system"]["selected_strategy"], "modular_parametric_3d")
        self.assertTrue(spec["admission"]["reject_on_render_failure"])
        self.assertFalse(spec["admission"]["fallback_character_allowed"])

    def test_body_variation_is_narrower_than_old_species(self):
        self.assertEqual(clamp_brick_v2_variation("torso_width", 2.0), 1.10)
        self.assertEqual(clamp_brick_v2_variation("limb_thickness", 0.1), 0.94)

    def test_connected_target_silhouette_has_correct_torso_direction(self):
        silhouette = get_brick_v2_spec()["silhouette"]
        self.assertGreater(silhouette["torso"]["top_width"], silhouette["torso"]["bottom_width"])
        self.assertLessEqual(silhouette["head"]["height"], 1.15)
        self.assertGreater(silhouette["connectors"]["shoulder_overlap"], 0)
        self.assertLessEqual(silhouette["connectors"]["visible_body_gap_max"], 0.02)

    def test_hair_strategy_can_change_without_schema_change(self):
        hair = get_brick_v2_spec()["hair_system"]
        self.assertIn("modular_parametric_3d", hair["allowed_strategies"])
        self.assertIn("ai_layered_hair_cards", hair["allowed_strategies"])
        self.assertIn("per_person_image_to_3d", hair["allowed_strategies"])


if __name__ == "__main__":
    unittest.main()
