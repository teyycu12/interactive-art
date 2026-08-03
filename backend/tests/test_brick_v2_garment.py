import unittest

from backend.brick_v2_garment import derive_garment_geometry


class BrickV2GarmentTests(unittest.TestCase):
    def test_tshirt_and_jeans_use_short_sleeves_and_trousers(self):
        profile = derive_garment_geometry({"inner": "tshirt", "outer": "none", "lower": "jeans"})
        self.assertEqual(profile["sleeve_profile"], "short")
        self.assertEqual(profile["lower_shell"], "trousers")
        self.assertEqual(profile["legwear"], "covered")
        self.assertEqual(profile["attachments"], [])

    def test_hoodie_and_skirt_select_fixed_geometry_attachments(self):
        profile = derive_garment_geometry({"inner": "tshirt", "outer": "hoodie", "lower": "pleated_skirt"})
        self.assertEqual(profile["outer_shell"], "hoodie")
        self.assertEqual(profile["sleeve_profile"], "long")
        self.assertIn("hood", profile["attachments"])
        self.assertIn("skirt_shell", profile["attachments"])
        self.assertEqual(profile["legwear"], "bare")

    def test_skirt_with_tights_keeps_tights_but_not_trouser_geometry(self):
        profile = derive_garment_geometry({"inner": "sweater", "lower": "pleated_skirt with tights"})
        self.assertEqual(profile["lower_shell"], "skirt")
        self.assertEqual(profile["legwear"], "tights")

    def test_coat_and_relaxed_fit_never_request_generated_geometry(self):
        profile = derive_garment_geometry({"outer": "long_coat", "lower": "pants", "fit": "oversized"})
        self.assertEqual(profile["outer_shell"], "long_coat")
        self.assertEqual(profile["fit"], "relaxed")
        self.assertEqual(profile["rule"], "deterministic_parts_only")


if __name__ == "__main__":
    unittest.main()
