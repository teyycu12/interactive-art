import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class FrontendBrickV2ContractTests(unittest.TestCase):
    def test_model_has_required_species_parts_and_no_floating_decal_plane(self):
        model = (ROOT / "frontend" / "brick-v2-model.js").read_text(encoding="utf-8")
        self.assertIn("roundedTaperedExtrudeGeometry", model)
        self.assertIn("separateFrontSurface", model)
        self.assertIn("addCHand", model)
        self.assertIn("roundedExtrudeGeometry", model)
        self.assertIn("hair_mount", model)
        self.assertIn("curvedFaceGeometry", model)
        self.assertIn("addModularHair", model)
        self.assertIn("hairShellGeometry", model)
        self.assertIn("CapsuleGeometry", model)
        self.assertIn("garment.sleeve_profile", model)
        self.assertIn("skirt_shell", model)
        self.assertIn("coat_tail", model)
        self.assertNotIn("PlaneGeometry", model)

    def test_main_page_loads_v2_model_before_preview(self):
        html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        model_index = html.index("brick-v2-model.js")
        preview_index = html.index("brick3d-preview.js")
        self.assertLess(model_index, preview_index)

    def test_preview_can_dispatch_to_brick_v2_builder(self):
        preview = (ROOT / "frontend" / "brick3d-preview.js").read_text(encoding="utf-8")
        self.assertIn("window.PersonaFlowBrickV2?.buildCharacter", preview)
        self.assertIn("['brick_v1', 'brick_v2']", preview)

    def test_synthetic_fixture_requires_no_person_or_ai_call(self):
        fixture = (ROOT / "frontend" / "brick-v2-fixture.html").read_text(encoding="utf-8")
        self.assertIn("synthetic_fixture: true", fixture)
        self.assertIn("style_id: 'brick_v2'", fixture)
        self.assertNotIn("generate_avatar", fixture)
        self.assertNotIn("socket.emit", fixture)

    def test_projection_reuses_v2_model_and_animation_rig(self):
        projection = (ROOT / "frontend" / "projection3d.html").read_text(encoding="utf-8")
        self.assertIn("await import('./brick-v2-model.js", projection)
        self.assertIn("window.PersonaFlowBrickV2.buildCharacter", projection)
        self.assertIn("class BrickV2Character", projection)
        self.assertIn("root.userData.limbs", projection)
        self.assertIn("['brick_v1', 'brick_v2'].includes(spec.style_id)", projection)

        model = (ROOT / "frontend" / "brick-v2-model.js").read_text(encoding="utf-8")
        self.assertIn("root.userData.limbs = limbs", model)


if __name__ == "__main__":
    unittest.main()
