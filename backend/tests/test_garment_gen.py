"""garment_gen 的純函式測試。

此模組 659 行、先前零測試。這裡不追求覆蓋率數字，只鎖定「真的會藏 bug」
的地方：外部 API 回應解析（形狀多變、可能畸形）與 prompt 組建（分支多）。
需要網路或 API 金鑰的路徑不在此測試範圍。
"""
import unittest
from types import SimpleNamespace

from backend.garment_gen import _extract_image_b64, _attr_lines


def _msg(**kw):
    """建立一個像 OpenAI SDK message 物件的替身。"""
    kw.setdefault("images", None)
    kw.setdefault("content", None)
    return SimpleNamespace(**kw)


class TestExtractImageB64(unittest.TestCase):
    """回應解析：模型回傳的形狀不只一種，畸形回應也不能讓流程崩掉。"""

    def test_shape1_images_with_dict_image_url(self):
        m = _msg(images=[{"type": "image_url",
                          "image_url": {"url": "data:image/png;base64,AAAB"}}])
        self.assertEqual(_extract_image_b64(m), "AAAB")

    def test_shape1_images_with_string_image_url(self):
        m = _msg(images=[{"image_url": "data:image/png;base64,CCCD"}])
        self.assertEqual(_extract_image_b64(m), "CCCD")

    def test_shape1_images_with_object_attrs(self):
        item = SimpleNamespace(image_url=SimpleNamespace(url="data:image/png;base64,EEEF"))
        self.assertEqual(_extract_image_b64(_msg(images=[item])), "EEEF")

    def test_shape2_content_list(self):
        m = _msg(content=[{"type": "text", "text": "here you go"},
                          {"type": "image_url",
                           "image_url": {"url": "data:image/png;base64,GGGH"}}])
        self.assertEqual(_extract_image_b64(m), "GGGH")

    def test_returns_first_valid_image(self):
        m = _msg(images=[{"image_url": {"url": "not-a-data-url"}},
                         {"image_url": {"url": "data:image/png;base64,SECOND"}}])
        self.assertEqual(_extract_image_b64(m), "SECOND")

    def test_text_only_response_returns_none(self):
        """模型有時只回文字（例如拒絕生成），必須回 None 而不是拋例外。"""
        self.assertIsNone(_extract_image_b64(_msg(content="I cannot generate that.")))

    def test_empty_and_malformed_shapes_return_none(self):
        for m in (_msg(),
                  _msg(images=[]),
                  _msg(images=[{}]),
                  _msg(images=[{"image_url": None}]),
                  _msg(images=[{"image_url": {}}]),
                  _msg(content=[]),
                  _msg(content=[{"type": "image_url"}]),
                  _msg(content=[{"type": "image_url", "image_url": None}])):
            self.assertIsNone(_extract_image_b64(m), f"畸形回應未安全處理: {m}")

    def test_non_data_url_is_rejected(self):
        """遠端 URL 不是我們要的 base64，不可誤判為成功。"""
        m = _msg(images=[{"image_url": {"url": "https://example.com/x.png"}}])
        self.assertIsNone(_extract_image_b64(m))


class TestAttrLines(unittest.TestCase):
    """prompt 組建：分支多，且錯誤會直接影響生成品質。"""

    def test_empty_inputs_give_explicit_fallback(self):
        out = _attr_lines(None, None)
        self.assertIn("no extra attributes", out)
        self.assertEqual(out, _attr_lines({}, {}))

    def test_includes_provided_face_and_outfit(self):
        out = _attr_lines({"skin_tone": "#FFD0A8", "hair_color": "#3B2314"},
                          {"inner": "tshirt", "inner_color": "#FF0000"})
        self.assertIn("Skin tone", out)
        self.assertIn("#FFD0A8", out)
        self.assertIn("Top garment: tshirt", out)

    def test_smile_threshold(self):
        self.assertIn("smiling", _attr_lines({"smile_score": 0.9}, {}))
        self.assertIn("neutral", _attr_lines({"smile_score": 0.1}, {}))

    def test_smile_score_zero_is_still_reported(self):
        """0.0 是有效分數，不可被當成「沒有資料」而略過。"""
        self.assertIn("neutral expression", _attr_lines({"smile_score": 0.0}, {}))

    def test_outer_none_is_omitted(self):
        """outer 為 'none' 代表沒有外套，不該寫進 prompt 誤導模型。"""
        self.assertNotIn("Outer garment", _attr_lines({}, {"outer": "none"}))
        self.assertIn("Outer garment: blazer", _attr_lines({}, {"outer": "blazer"}))

    def test_outer_colour_appended_when_present(self):
        out = _attr_lines({}, {"outer": "blazer", "outer_color": "#123456"})
        self.assertIn("blazer (#123456)", out)

    def test_beard_only_when_has_beard(self):
        self.assertNotIn("Facial hair", _attr_lines({"has_beard": False}, {}))
        self.assertIn("Facial hair: goatee",
                      _attr_lines({"has_beard": True, "beard_style": "goatee"}, {}))

    def test_output_is_newline_separated_bullets(self):
        out = _attr_lines({"skin_tone": "#FFF", "hair_color": "#000"}, {})
        self.assertEqual(len(out.split("\n")), 2)
        self.assertTrue(all(l.startswith("- ") for l in out.split("\n")))


if __name__ == "__main__":
    unittest.main()
