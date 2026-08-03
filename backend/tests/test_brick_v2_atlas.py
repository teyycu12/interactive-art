import unittest

import cv2
import numpy as np

from backend.brick_v2_atlas import validate_brick_v2_print_panels


def _face():
    image = np.full((512, 512, 3), (170, 210, 250), np.uint8)
    cv2.circle(image, (205, 220), 22, (20, 20, 20), 8)
    cv2.circle(image, (305, 220), 22, (20, 20, 20), 8)
    cv2.ellipse(image, (256, 330), (70, 30), 0, 0, 180, (20, 20, 20), 8)
    return image


def _valid_material(color):
    image = np.full((512, 512, 3), color, np.uint8)
    for y in range(70, 470, 80):
        cv2.line(image, (0, y), (511, y), (35, 35, 35), 5)
    return image


class BrickV2AtlasTests(unittest.TestCase):
    def test_edge_to_edge_print_material_passes(self):
        result = validate_brick_v2_print_panels({
            "face": _face(),
            "torso_front": _valid_material((60, 110, 50)),
            "left_leg_front": _valid_material((100, 100, 105)),
            "right_leg_front": _valid_material((100, 100, 105)),
        })
        self.assertTrue(result["passed"], result["errors"])

    def test_complete_garment_on_square_background_is_rejected(self):
        torso = np.full((512, 512, 3), (160, 155, 160), np.uint8)
        garment = np.array([[135, 20], [377, 20], [420, 465], [92, 465]], np.int32)
        cv2.fillPoly(torso, [garment], (190, 185, 190))
        cv2.polylines(torso, [garment], True, (5, 5, 5), 10)
        result = validate_brick_v2_print_panels({
            "face": _face(),
            "torso_front": torso,
            "left_leg_front": _valid_material((100, 100, 105)),
            "right_leg_front": _valid_material((100, 100, 105)),
        })
        self.assertFalse(result["passed"])
        self.assertIn("torso_contains_garment_silhouette", result["errors"])

    def test_smooth_colour_bands_are_rejected_as_baked_shading(self):
        leg = np.zeros((512, 512, 3), np.uint8)
        leg[:, :256] = (120, 110, 90)
        leg[:, 256:] = (145, 110, 75)
        result = validate_brick_v2_print_panels({
            "face": _face(),
            "torso_front": _valid_material((60, 110, 50)),
            "left_leg_front": leg,
            "right_leg_front": leg,
        })
        self.assertFalse(result["passed"])
        self.assertIn("left_leg_front_baked_low_frequency_shading", result["errors"])


if __name__ == "__main__":
    unittest.main()
