import threading
import unittest
from backend.app import _merge_fallback_payload, _client_last_success, _client_last_success_lock


class TestClientIsolation(unittest.TestCase):
    def setUp(self):
        with _client_last_success_lock:
            _client_last_success.clear()

    def test_client_fallback_isolation(self):
        # Client A sends valid features
        payload_a = {
            "ok": True,
            "upper": {"hex": "#AA0000"},
            "lower": {"hex": "#00AA00"},
            "upper_type": "long_sleeve",
            "lower_type": "long_pants",
        }
        res_a1 = _merge_fallback_payload(payload_a, sid="client_a")
        self.assertTrue(res_a1["ok"])

        # Client B sends valid features
        payload_b = {
            "ok": True,
            "upper": {"hex": "#0000BB"},
            "lower": {"hex": "#BBBB00"},
            "upper_type": "short_sleeve",
            "lower_type": "shorts",
        }
        res_b1 = _merge_fallback_payload(payload_b, sid="client_b")
        self.assertTrue(res_b1["ok"])

        # Client A now experiences CV failure -> should receive A's fallback, NOT B's!
        res_a2 = _merge_fallback_payload({"ok": False, "error": "no_pose"}, sid="client_a")
        self.assertFalse(res_a2["ok"])
        self.assertTrue(res_a2["fallback"])
        self.assertEqual(res_a2["upper"]["hex"], "#AA0000")
        self.assertEqual(res_a2["upper_type"], "long_sleeve")

        # Client B now experiences CV failure -> should receive B's fallback, NOT A's!
        res_b2 = _merge_fallback_payload({"ok": False, "error": "no_pose"}, sid="client_b")
        self.assertFalse(res_b2["ok"])
        self.assertTrue(res_b2["fallback"])
        self.assertEqual(res_b2["upper"]["hex"], "#0000BB")
        self.assertEqual(res_b2["upper_type"], "short_sleeve")

    def test_concurrent_multithreaded_fallback_access(self):
        errors = []

        def worker(sid, hex_color):
            try:
                for _ in range(20):
                    _merge_fallback_payload({"ok": True, "upper": {"hex": hex_color}}, sid=sid)
                    fb = _merge_fallback_payload({"ok": False}, sid=sid)
                    if fb["upper"]["hex"] != hex_color:
                        errors.append(f"{sid} expected {hex_color} but got {fb['upper']['hex']}")
            except Exception as e:
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
