import unittest
from unittest.mock import patch
from backend.photo_composer import compose_group_photo, _draw_lego_character, _hex_to_rgb, Image


class TestPhotoComposer(unittest.TestCase):
    def test_hex_to_rgb(self):
        self.assertEqual(_hex_to_rgb("#FF0000"), (255, 0, 0))
        self.assertEqual(_hex_to_rgb("#00FF00"), (0, 255, 0))
        self.assertEqual(_hex_to_rgb("#0000FF"), (0, 0, 255))
        self.assertEqual(_hex_to_rgb("invalid"), (200, 200, 200))
        self.assertEqual(_hex_to_rgb(None), (200, 200, 200))

    def test_pil_missing_fallback(self):
        # 測試當 Pillow 缺失時的優雅降級回傳
        with patch("backend.photo_composer.Image", None):
            res = compose_group_photo([])
            self.assertFalse(res["ok"])
            self.assertEqual(res["error"], "Pillow (PIL) is not installed")
            self.assertIsNone(_draw_lego_character({"id": "c1"}))

    @unittest.skipIf(Image is None, "Pillow is not installed in current environment")
    def test_draw_single_character(self):
        mock_char = {
            "id": "c1",
            "upper": {"hex": "#336699"},
            "lower": {"hex": "#222222"},
            "face": {"skin_tone": "#FFE0BD", "hair_color": "#4A3728"},
        }
        img = _draw_lego_character(mock_char, target_height=200)
        self.assertIsNotNone(img)
        self.assertEqual(img.height, 200)
        self.assertGreater(img.width, 100)

    @unittest.skipIf(Image is None, "Pillow is not installed in current environment")
    def test_compose_empty_swarm(self):
        res = compose_group_photo([])
        self.assertTrue(res["ok"])
        self.assertEqual(res["character_count"], 0)
        self.assertIn("photo_b64", res)
        self.assertIn("qr_b64", res)
        self.assertGreater(len(res["photo_bytes"]), 1000)

    @unittest.skipIf(Image is None, "Pillow is not installed in current environment")
    def test_compose_multiple_characters(self):
        mock_chars = [
            {
                "id": f"char_{i}",
                "upper": {"hex": f"#{i*20:02X}3366"},
                "lower": {"hex": "#333333"},
                "face": {"skin_tone": "#FFD0A8"},
            }
            for i in range(12)
        ]
        res = compose_group_photo(mock_chars, width=1280, height=720)
        self.assertTrue(res["ok"])
        self.assertEqual(res["character_count"], 12)
        self.assertTrue(res["photo_b64"].startswith("data:image/png;base64,"))
        self.assertTrue(res["qr_b64"].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
