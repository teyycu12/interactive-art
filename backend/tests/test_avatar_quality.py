import base64
import io
import unittest

from PIL import Image, ImageDraw

from backend.avatar_quality import (
    correction_for_validation,
    guidance_for_validation,
    validate_avatar_png,
)


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

    def test_background_left_behind_fails(self):
        """模型畫了方格紙背景：格線把白底切成封閉小格，去背灌不進去。

        留下來的是「人偶＋整片方格紙」一個連通塊，連通性、雙腿、出框全都通過，
        只有前景佔比露餡。實測那張是 0.81，舊的 0.85 上限擋不住。
        """
        def grid_sheet(d):
            d.rectangle((10, 10, 189, 189), fill=(255, 255, 255, 255))
            for v in range(10, 190, 12):
                d.line((v, 10, v, 189), fill=(150, 150, 150, 255))
                d.line((10, v, 189, v), fill=(150, 150, 150, 255))
            _normal(d, color=(120, 30, 30, 255))

        result = validate_avatar_png(_png(grid_sheet))
        self.assertIn("background_left", result["errors"], result)
        self.assertNotIn("foreground_ratio", result["errors"], "這張要證明的是舊上限擋不住")
        self.assertIn("grid lines", correction_for_validation(result))
        self.assertIn("再送出", guidance_for_validation(result))

    def test_too_wide_only_when_the_style_asks(self):
        """旁邊多畫了半個人、而且連在一起：連通性看到的是一塊，只有寬度露餡。

        門檻跟著風格走（樂高的爪手讓正常人偶就有 0.6），不給就不檢查。
        """
        def two_figures(d):
            _normal(d, color=(40, 40, 40, 255))
            d.rectangle((150, 30, 190, 185), fill=(40, 40, 40, 255))   # 貼在旁邊的第二個人

        png = _png(two_figures)
        self.assertNotIn("too_wide", validate_avatar_png(png)["errors"])
        result = validate_avatar_png(png, max_aspect=0.56)
        self.assertIn("too_wide", result["errors"], result)
        correction = correction_for_validation(result)
        self.assertIn("never add an extra person", correction)
        # 像素風格的 prompt 要三視圖：叫它「只畫一個」會跟原 prompt 打架
        self.assertNotIn("EXACTLY ONE", correction)
        self.assertNotIn("no side or back view", correction)
        self.assertIn("再送出", guidance_for_validation(result))

    def test_stray_fragment_does_not_make_a_normal_figure_too_wide(self):
        def slim_with_speck(d):
            d.ellipse((80, 10, 120, 50), fill="black")
            d.rectangle((75, 50, 125, 120), fill="black")
            d.rectangle((78, 118, 97, 185), fill="black")
            d.rectangle((103, 118, 122, 185), fill="black")
            d.rectangle((180, 100, 184, 104), fill="black")   # 遠處一小塊雜點
        result = validate_avatar_png(_png(slim_with_speck), max_aspect=0.56)
        self.assertNotIn("too_wide", result["errors"], result)

    def test_normal_figure_is_not_too_wide(self):
        def slim(d):
            d.ellipse((80, 10, 120, 50), fill="black")
            d.rectangle((75, 50, 125, 120), fill="black")
            d.rectangle((78, 118, 97, 185), fill="black")
            d.rectangle((103, 118, 122, 185), fill="black")
        self.assertNotIn("too_wide", validate_avatar_png(_png(slim), max_aspect=0.56)["errors"])

    def test_invalid_base64_fails_without_exception(self):
        self.assertEqual(validate_avatar_png("not-a-png")["errors"], ["decode_failed"])


if __name__ == "__main__":
    unittest.main()
