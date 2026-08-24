"""vlm_module 的回應解析測試。

這裡先塞一個假金鑰再 import —— 測試不會發出任何網路請求，只驗證解析邏輯與
失敗回傳的形狀。真正呼叫 Gemini 的路徑不在單元測試範圍。
"""
import json
import os
import unittest

# 不能用 setdefault：.env 裡若有一行 GEMINI_API_KEY=（值為空），這個 key
# 就「存在」，setdefault 不會覆寫，vlm_module 仍會因空字串而在 import 時 raise。
# 以 or 判斷真值才同時涵蓋「未設定」與「設了但為空」兩種情況。
os.environ["GEMINI_API_KEY"] = (
    os.environ.get("GEMINI_API_KEY") or "test-key-not-used-for-network"
)

from backend import vlm_module  # noqa: E402
from backend.vlm_module import strip_json_fence  # noqa: E402


class TestStripJsonFence(unittest.TestCase):
    """模型即使被要求不要加 fence，實務上仍常常會加。"""

    PAYLOAD = '{"outer": "blazer", "inner": "button_up"}'

    def test_plain_json_unchanged(self):
        self.assertEqual(strip_json_fence(self.PAYLOAD), self.PAYLOAD)

    def test_json_labelled_fence(self):
        self.assertEqual(
            strip_json_fence(f"```json\n{self.PAYLOAD}\n```"), self.PAYLOAD)

    def test_uppercase_label(self):
        self.assertEqual(
            strip_json_fence(f"```JSON\n{self.PAYLOAD}\n```"), self.PAYLOAD)

    def test_bare_fence_without_label(self):
        self.assertEqual(
            strip_json_fence(f"```\n{self.PAYLOAD}\n```"), self.PAYLOAD)

    def test_surrounding_prose_is_discarded(self):
        text = f"Sure! Here is the result:\n```json\n{self.PAYLOAD}\n```\nHope this helps."
        self.assertEqual(strip_json_fence(text), self.PAYLOAD)

    def test_leading_and_trailing_whitespace(self):
        self.assertEqual(strip_json_fence(f"  \n {self.PAYLOAD} \n "), self.PAYLOAD)

    def test_result_is_parseable(self):
        for variant in (self.PAYLOAD,
                        f"```json\n{self.PAYLOAD}\n```",
                        f"```\n{self.PAYLOAD}\n```",
                        f"text before\n```json\n{self.PAYLOAD}\n```"):
            self.assertEqual(json.loads(strip_json_fence(variant))["outer"], "blazer")

    def test_empty_input(self):
        self.assertEqual(strip_json_fence(""), "")
        self.assertEqual(strip_json_fence("   "), "")

    def test_json_starting_with_stripped_characters(self):
        """回歸測試：舊版用 lstrip("json")，那是移除「字元集合」而非前綴。

        像 {"nose": ...} 這種以 j/s/o/n 開頭的內容若沒有大括號保護，
        字元集合的寫法就會咬掉真正的資料。這裡確保是前綴移除語意。
        """
        payload = '{"nose_shape": "round"}'
        self.assertEqual(strip_json_fence(f"```json\n{payload}\n```"), payload)
        self.assertEqual(json.loads(strip_json_fence(payload))["nose_shape"], "round")

    def test_no_closing_fence_falls_back_to_content(self):
        """模型偶爾會漏掉結尾 fence，不該因此回傳空字串。"""
        out = strip_json_fence(f"```json\n{self.PAYLOAD}")
        self.assertIn("blazer", out)


if __name__ == "__main__":
    unittest.main()


class TestFailureCarriesNoFabricatedFields(unittest.TestCase):
    """VLM 失敗時不得附帶捏造的語意欄位。

    早期版本在失敗路徑回傳一組寫死的預設值（tshirt / jeans / short_straight
    ...）。build_outfit_data 當時只讀 outfit 鍵、不看 ok，於是 VLM 一失敗，
    穿西裝、洋裝、外套的人全都被生成為短袖 T 恤配牛仔褲 —— 而且沒有任何一處
    會報錯，現場只會覺得模型變笨了。
    """

    def _force_failure(self, fn):
        # 傳入解不開的 base64，讓函式走到 except 區塊，不會發出網路請求。
        return fn("data:image/jpeg;base64,!!!not-base64!!!")

    def test_outfit_failure_has_no_outfit_key(self):
        result = self._force_failure(vlm_module.analyze_outfit)
        self.assertFalse(result["ok"])
        self.assertNotIn("outfit", result,
                         "失敗回傳不得附帶服裝欄位，否則會被當成真的辨識結果")
        self.assertIn("error", result)

    def test_face_failure_has_no_face_key(self):
        result = self._force_failure(vlm_module.analyze_face)
        self.assertFalse(result["ok"])
        self.assertNotIn("face", result,
                         "失敗回傳不得附帶臉部欄位，否則捏造的髮型膚色會進 prompt")
        self.assertIn("error", result)
