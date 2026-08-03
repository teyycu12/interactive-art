import unittest
import base64
import io

import cv2
import numpy as np
from PIL import Image

from backend.ai_texture_gen import (
    ATLAS_SIZE,
    apply_ai_textures,
    build_style_anchor,
    split_atlas_textures,
    validate_ai_atlas,
)


def _spec():
    return {
        "schema_version": 2,
        "material_version": 1,
        "style_id": "brick_v1",
        "skin_color": "#FFD0A8",
        "face": {"expression": "smile", "glasses": True, "beard": "none"},
        "hair": {"style": "short", "color": "#3B2314"},
        "outfit": {
            "upper_type": "tshirt",
            "lower_type": "pants",
            "outer_type": "none",
            "upper_color": "#2864B4",
            "lower_color": "#1E1E1E",
        },
        "textures": {"torso_front": "fallback", "legs_front": "fallback"},
        "quality": {"fallback_used": False},
    }


def _valid_atlas():
    atlas = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 3), dtype=np.uint8)
    # OpenCV is BGR.
    atlas[:512, :512] = (168, 208, 255)
    atlas[:512, 512:] = (180, 100, 40)
    atlas[512:, :] = (30, 30, 30)
    cv2.circle(atlas, (205, 230), 22, (20, 20, 20), 10)
    cv2.circle(atlas, (305, 230), 22, (20, 20, 20), 10)
    cv2.ellipse(atlas, (256, 330), (75, 32), 0, 0, 180, (20, 20, 20), 10)
    for y in range(90, 450, 50):
        cv2.line(atlas, (560, y), (970, y), (210, 150, 90), 8)
    cv2.rectangle(atlas, (0, 0), (ATLAS_SIZE - 1, ATLAS_SIZE - 1), (8, 8, 10), 20)
    cv2.rectangle(atlas, (494, 0), (530, ATLAS_SIZE), (8, 8, 10), -1)
    cv2.rectangle(atlas, (0, 494), (ATLAS_SIZE, 530), (8, 8, 10), -1)
    return atlas


class AiTextureTests(unittest.TestCase):
    def test_brick_v2_rejects_complete_garment_silhouette(self):
        atlas = _valid_atlas()
        torso = atlas[30:482, 542:994]
        torso[:] = (205, 205, 205)
        cv2.rectangle(torso, (105, 35), (350, 420), (35, 110, 45), -1)
        spec = _spec()
        spec["style_id"] = "brick_v2"
        result = validate_ai_atlas(atlas, spec)
        self.assertFalse(result["passed"])
        self.assertIn("torso_contains_garment_silhouette", result["errors"])
        self.assertEqual(result["brick_v2_print"]["validator"], "brick_v2_print_v1")

    def test_style_anchor_is_person_free_fixed_reference_sheet(self):
        data_url = build_style_anchor()
        image = Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1])))
        self.assertEqual(image.size, (ATLAS_SIZE, ATLAS_SIZE))

    def test_valid_atlas_splits_into_four_webp_textures(self):
        atlas = _valid_atlas()
        validation = validate_ai_atlas(atlas, _spec())
        textures = split_atlas_textures(atlas)
        self.assertTrue(validation["passed"], validation)
        self.assertGreater(validation["detail_score"], 0)
        self.assertIn("species_compliance", validation)
        self.assertIn("outfit_fidelity", validation)
        self.assertEqual(
            set(textures),
            {"face_decal", "torso_front", "left_leg_front", "right_leg_front"},
        )
        self.assertTrue(all(value.startswith("data:image/webp;base64,") for value in textures.values()))

    def test_blank_guide_is_rejected_as_missing_face_detail(self):
        atlas = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 3), dtype=np.uint8)
        atlas[:512, :512] = (168, 208, 255)
        atlas[:512, 512:] = (180, 100, 40)
        atlas[512:, :] = (30, 30, 30)
        validation = validate_ai_atlas(atlas, _spec())
        self.assertFalse(validation["passed"])
        self.assertIn("face_missing_detail", validation["errors"])

    def test_directional_baked_light_is_rejected(self):
        atlas = _valid_atlas()
        gradient = np.linspace(0.45, 1.15, 494, dtype=np.float32)[None, :, None]
        atlas[20:494, 20:494] = np.clip(
            atlas[20:494, 20:494].astype(np.float32) * gradient[:, :474], 0, 255
        ).astype(np.uint8)
        validation = validate_ai_atlas(atlas, _spec())
        self.assertFalse(validation["passed"])
        self.assertIn("panel_0_baked_lighting", validation["errors"])

    def test_apply_ai_textures_increments_material_version(self):
        result = {
            "ok": True,
            "model": "test-pro-image",
            "textures": split_atlas_textures(_valid_atlas()),
            "validation": {"detail_score": 0.9},
        }
        enriched = apply_ai_textures(_spec(), result)
        self.assertEqual(enriched["material_version"], 2)
        self.assertEqual(enriched["quality"]["ai_texture_status"], "enhanced")
        self.assertEqual(enriched["quality"]["ai_texture_model"], "test-pro-image")

    def test_incomplete_ai_textures_never_fall_back_to_cv_grid(self):
        with self.assertRaisesRegex(ValueError, "incomplete_ai_texture_atlas"):
            apply_ai_textures(_spec(), {
                "ok": True,
                "model": "broken-image-model",
                "textures": {"torso_front": "data:image/webp;base64,AAAA"},
                "validation": {"passed": True},
            })


if __name__ == "__main__":
    unittest.main()
