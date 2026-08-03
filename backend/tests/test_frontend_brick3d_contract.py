import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class FrontendBrick3DContractTests(unittest.TestCase):
    def test_public_modes_keep_brick_and_full_character_only(self):
        html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        self.assertIn('value="brick_ai_texture" checked', html)
        self.assertIn('value="full_character"', html)
        self.assertNotIn('value="body_sprite"', html)

    def test_formal_result_uses_three_character_spec_preview(self):
        sketch = (ROOT / "frontend" / "sketch.js").read_text(encoding="utf-8")
        preview = (ROOT / "frontend" / "brick3d-preview.js").read_text(encoding="utf-8")
        self.assertIn("_renderBrickCharacterPreview(payload)", sketch)
        self.assertIn("payload.character_spec", sketch)
        self.assertIn("spec.textures?.face_decal", preview)
        self.assertIn("spec.textures?.torso_front", preview)
        self.assertIn("spec.textures?.left_leg_front", preview)
        self.assertIn("spec.textures?.right_leg_front", preview)
        self.assertIn("incomplete_ai_texture_atlas", preview)
        self.assertIn("ai_texture_load_failed", preview)

    def test_p5_cloth_grid_renderer_is_removed(self):
        sketch = (ROOT / "frontend" / "sketch.js").read_text(encoding="utf-8")
        theme = (ROOT / "frontend" / "themes" / "lego.js").read_text(encoding="utf-8")
        self.assertNotIn("clothGrid", sketch)
        self.assertNotIn("lowerGrid", sketch)
        self.assertNotIn("_drawClothGrid", sketch)
        self.assertNotIn("clothGrid", theme)
        self.assertNotIn("lowerGrid", theme)
        self.assertNotIn("_drawClothGrid", theme)

    def test_brick_swarm_payload_preserves_character_mode(self):
        sketch = (ROOT / "frontend" / "sketch.js").read_text(encoding="utf-8")
        self.assertIn("myAvatarData?.character_mode === 'brick_ai_texture'", sketch)
        self.assertIn("? 'brick_ai_texture'", sketch)
        self.assertIn("? null", sketch)


if __name__ == "__main__":
    unittest.main()
