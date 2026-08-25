import base64
import io
import unittest

from backend.avatar_pipeline import (
    normalize_base64_image, decode_frame, build_outfit_data,
    infer_sleeve_kind, build_face_data, HAIR_HEX, SKIN_HEX,
)

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def _jpeg_b64(size=(64, 48), color=(120, 90, 70), as_data_url=True):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}" if as_data_url else b64


class TestNormalizeBase64(unittest.TestCase):
    def test_strips_data_url_prefix(self):
        raw = base64.b64encode(b"hello world!").decode()
        self.assertEqual(normalize_base64_image(f"data:image/png;base64,{raw}"),
                         b"hello world!")

    def test_restores_plus_decoded_as_space(self):
        """傳輸過程常把 '+' 解成空格，必須還原，否則 base64 解碼會失敗。"""
        raw = base64.b64encode(bytes(range(256))).decode()
        self.assertIn("+", raw, "測試資料需含 '+' 才有意義")
        self.assertEqual(normalize_base64_image(raw.replace("+", " ")),
                         base64.b64decode(raw))

    def test_repairs_missing_padding(self):
        raw = base64.b64encode(b"abcde").decode()   # 產生 '=' padding
        self.assertEqual(normalize_base64_image(raw.rstrip("=")), b"abcde")

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            normalize_base64_image("")


@unittest.skipUnless(HAS_PIL, "Pillow required")
class TestDecodeFrame(unittest.TestCase):
    def test_decodes_data_url(self):
        frame, err = decode_frame(_jpeg_b64())
        self.assertIsNone(err)
        self.assertEqual(frame.shape[:2], (48, 64))   # (h, w)

    def test_decodes_bare_base64(self):
        frame, err = decode_frame(_jpeg_b64(as_data_url=False))
        self.assertIsNone(err)
        self.assertIsNotNone(frame)

    def test_garbage_returns_error_not_exception(self):
        frame, err = decode_frame("data:image/jpeg;base64,!!!not-base64!!!")
        self.assertIsNone(frame)
        self.assertIsNotNone(err)

    def test_valid_base64_but_not_an_image(self):
        """b64 解得開但不是影像：兩條解碼路徑都該失敗且不拋例外。

        原本 app.py 的後備路徑在此情境會因 img_bytes 未定義而 NameError，
        錯誤訊息也就永遠對不上真正的原因。
        """
        payload = base64.b64encode(b"this is definitely not an image").decode()
        frame, err = decode_frame(payload)
        self.assertIsNone(frame)
        self.assertIn("all_decoders_failed", err)


class TestBuildOutfitData(unittest.TestCase):
    def test_cv_hex_overrides_vlm_color(self):
        vlm = {"outfit": {"inner": "tshirt", "inner_color": "#000000"}}
        cv = {"upper": {"hex": "#FF0000"}, "lower": {"hex": "#0000FF"}}
        out = build_outfit_data(vlm, cv)
        self.assertEqual(out["inner_color"], "#FF0000")
        self.assertEqual(out["lower_color"], "#0000FF")
        self.assertEqual(out["inner"], "tshirt", "VLM 的語意欄位不該被覆寫")

    def test_does_not_mutate_input(self):
        vlm = {"outfit": {"inner_color": "#000000"}}
        build_outfit_data(vlm, {"upper": {"hex": "#FF0000"}})
        self.assertEqual(vlm["outfit"]["inner_color"], "#000000")

    def test_failed_vlm_payload_is_discarded(self):
        """ok 為 False 時，語意欄位一律丟棄，只留 CV 顏色。

        這是第二道防線。vlm_module 的失敗路徑已經不再捏造欄位，但只要有任何
        呼叫端在失敗回傳裡帶上 outfit，捏造的款式就會流進生圖 prompt，而且
        看起來像模型判斷錯誤，不像呼叫失敗 —— 現場沒有人會發現。
        """
        failed = {"ok": False, "error": "No API_KEY",
                  "outfit": {"inner": "tshirt", "lower": "jeans",
                             "sleeve_length": "short", "fit": "regular"}}
        cv = {"upper": {"hex": "#8FA05E"}, "lower": {"hex": "#B7A98A"}}
        out = build_outfit_data(failed, cv)
        self.assertEqual(out, {"inner_color": "#8FA05E", "lower_color": "#B7A98A"},
                         "失敗的 VLM 結果只該留下 CV 量到的顏色")

    def test_ok_absent_is_still_accepted(self):
        """沒有 ok 鍵時視為可用 —— 只拒絕明確標記失敗的結果。"""
        out = build_outfit_data({"outfit": {"inner": "hoodie"}}, None)
        self.assertEqual(out["inner"], "hoodie")

    def test_survives_none_and_malformed(self):
        self.assertEqual(build_outfit_data(None, None), {})
        self.assertEqual(build_outfit_data({"outfit": None}, {"upper": None}), {})
        self.assertEqual(build_outfit_data("not a dict", []), {})


class TestInferSleeveKind(unittest.TestCase):
    def test_outer_implies_long_sleeve(self):
        for outer in ("blazer", "cardigan", "denim_jacket"):
            self.assertEqual(infer_sleeve_kind({"outer": outer}, None), "long_sleeve")

    def test_button_up_inner_implies_long_sleeve(self):
        self.assertEqual(infer_sleeve_kind({"inner": "button_up"}, None), "long_sleeve")

    def test_case_insensitive(self):
        self.assertEqual(infer_sleeve_kind({"outer": "BLAZER"}, None), "long_sleeve")

    def test_falls_back_to_cv(self):
        self.assertEqual(
            infer_sleeve_kind({"outer": "none", "inner": "tshirt"},
                              {"upper_type": "long_sleeve"}), "long_sleeve")

    def test_default_when_nothing_known(self):
        self.assertEqual(infer_sleeve_kind({}, None), "short_sleeve")


class TestBuildFaceData(unittest.TestCase):
    def test_merges_both_sources(self):
        cv = {"ok": True, "face_shape": "oval", "eye_shape": "round",
              "eyebrow_style": "flat", "smile_score": 0.8, "lip_color": "#C33"}
        vlm = {"ok": True, "face": {"hair_color": "blonde", "skin_tone": "medium"}}
        f = build_face_data(cv, vlm)
        self.assertEqual(f["face_shape"], "oval")
        self.assertEqual(f["hair_color"], HAIR_HEX["blonde"])
        self.assertEqual(f["skin_tone"], SKIN_HEX["medium"])
        self.assertEqual(f["hair_color_name"], "blonde")

    def test_unknown_color_name_falls_back_to_default_hex(self):
        f = build_face_data(None, {"ok": True, "face": {"hair_color": "chartreuse"}})
        self.assertEqual(f["hair_color"], "#3B2314")
        self.assertEqual(f["hair_color_name"], "chartreuse")

    def test_cv_only(self):
        f = build_face_data({"ok": True, "face_shape": "square"}, None)
        self.assertEqual(f["face_shape"], "square")
        self.assertNotIn("hair_color", f)

    def test_both_failed_returns_empty(self):
        self.assertEqual(build_face_data({"ok": False}, {"ok": False}), {})
        self.assertEqual(build_face_data(None, None), {})

    def test_null_face_payload_does_not_crash(self):
        """VLM 回報 ok 但 face 為 null —— 上游確實會出現這種情況。"""
        self.assertIsInstance(build_face_data(None, {"ok": True, "face": None}), dict)


if __name__ == "__main__":
    unittest.main()
