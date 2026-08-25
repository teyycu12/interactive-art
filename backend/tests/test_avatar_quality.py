import base64
import io
import unittest

from PIL import Image, ImageDraw

from backend.avatar_quality import validate_avatar_png


def _png(draw_fn=None):
    image = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    if draw_fn:
        draw_fn(ImageDraw.Draw(image))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _normal(draw, color=(255, 255, 255, 255)):
    draw.rectangle((50, 20, 150, 125), fill=color)
    draw.rectangle((60, 120, 92, 185), fill=color)
    draw.rectangle((108, 120, 140, 185), fill=color)


class AvatarValidatorTests(unittest.TestCase):
    def test_normal_transparent_character_and_white_clothes_pass(self):
        result = validate_avatar_png(_png(_normal), upper_rgb=[255, 255, 255], lower_rgb=[255, 255, 255])
        self.assertTrue(result["passed"], result)

    def test_blank_and_touching_border_fail(self):
        self.assertIn("empty_foreground", validate_avatar_png(_png())["errors"])
        touching = validate_avatar_png(_png(lambda d: d.rectangle((0, 20, 150, 185), fill="black")))
        self.assertIn("touches_border", touching["errors"])

    def test_missing_left_or_right_lower_side_fails(self):
        def left_only(d):
            d.rectangle((50, 20, 150, 130), fill="black")
            d.rectangle((60, 125, 92, 185), fill="black")

        def right_only(d):
            d.rectangle((50, 20, 150, 130), fill="black")
            d.rectangle((108, 125, 140, 185), fill="black")

        self.assertIn("missing_bottom_right", validate_avatar_png(_png(left_only))["errors"])
        self.assertIn("missing_bottom_left", validate_avatar_png(_png(right_only))["errors"])

    def test_fragmented_foreground_fails(self):
        def draw(d):
            d.rectangle((30, 30, 100, 185), fill="black")
            d.rectangle((125, 70, 175, 185), fill="black")

        result = validate_avatar_png(_png(draw))
        self.assertIn("fragmented_foreground", result["errors"])

    def test_invalid_base64_fails_without_exception(self):
        self.assertEqual(validate_avatar_png("not-a-png")["errors"], ["decode_failed"])


if __name__ == "__main__":
    unittest.main()
