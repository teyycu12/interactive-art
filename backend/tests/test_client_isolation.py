import threading
import unittest

from backend.app import _merge_fallback_payload, _preview_sessions, _preview_lock


class TestClientIsolation(unittest.TestCase):
    """CV 偵測失敗時的 fallback 必須是「該連線自己」上一次的成功結果。

    合併 main 時，兩條線各自獨立修好了同一個跨使用者污染的 bug：main 用
    ClientLastSuccess dataclass，pivot 用 per-sid 的 _preview_sessions。留下的是
    後者（拍攝閘門的 stable_count / pending_payload 也掛在同一份 session 上），
    因此本測試改為對準它 —— 守護的性質不變，只是換了綁定的實作。
    簽名也隨之改為 _merge_fallback_payload(sid, features)。
    """

    def setUp(self):
        with _preview_lock:
            _preview_sessions.clear()

    def test_client_fallback_isolation(self):
        payload_a = {
            "ok": True,
            "upper": {"hex": "#AA0000"},
            "lower": {"hex": "#00AA00"},
            "upper_type": "long_sleeve",
            "lower_type": "long_pants",
        }
        self.assertTrue(_merge_fallback_payload("client_a", payload_a)["ok"])

        payload_b = {
            "ok": True,
            "upper": {"hex": "#0000BB"},
            "lower": {"hex": "#BBBB00"},
            "upper_type": "short_sleeve",
            "lower_type": "shorts",
        }
        self.assertTrue(_merge_fallback_payload("client_b", payload_b)["ok"])

        # A 偵測失敗 → 拿到的必須是 A 自己的上一次結果，不是 B 的
        res_a2 = _merge_fallback_payload("client_a", {"ok": False, "error": "no_pose"})
        self.assertFalse(res_a2["ok"])
        self.assertTrue(res_a2["fallback"])
        self.assertEqual(res_a2["upper"]["hex"], "#AA0000")
        self.assertEqual(res_a2["upper_type"], "long_sleeve")

        # B 偵測失敗 → 同理
        res_b2 = _merge_fallback_payload("client_b", {"ok": False, "error": "no_pose"})
        self.assertFalse(res_b2["ok"])
        self.assertTrue(res_b2["fallback"])
        self.assertEqual(res_b2["upper"]["hex"], "#0000BB")
        self.assertEqual(res_b2["upper_type"], "short_sleeve")

    def test_no_prior_success_reports_no_fallback(self):
        res = _merge_fallback_payload("fresh_client", {"ok": False, "error": "no_pose"})
        self.assertFalse(res["ok"])
        self.assertFalse(res["fallback"])
        self.assertIsNone(res["upper"])

    def test_concurrent_multithreaded_fallback_access(self):
        errors = []

        def worker(sid, hex_color):
            try:
                for _ in range(20):
                    _merge_fallback_payload(sid, {"ok": True, "upper": {"hex": hex_color}})
                    fb = _merge_fallback_payload(sid, {"ok": False})
                    if fb["upper"]["hex"] != hex_color:
                        errors.append(f"{sid} expected {hex_color} but got {fb['upper']['hex']}")
            except Exception as e:  # noqa: BLE001 - 測試要看到任何例外
                errors.append(str(e))

        threads = [
            threading.Thread(target=worker, args=(f"user_{i}", f"#{i:02X}0000"))
            for i in range(10)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0, f"Thread errors: {errors}")


if __name__ == "__main__":
    unittest.main()
