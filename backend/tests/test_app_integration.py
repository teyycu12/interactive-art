import unittest

try:
    from backend.app import app, socketio, _swarm_chars, _swarm_lock
    from backend.swarm_snapshot import save_snapshot, load_snapshot, clear_snapshot
    from backend.bot_simulator import inject_bots, remove_bots
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False


@unittest.skipUnless(HAS_FLASK, "Flask is not installed in current environment")
class TestAppIntegration(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.client = self.app.test_client()

    def test_health_endpoint(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data.get("status"), "ok")

    def test_bot_injection_and_removal(self):
        with _swarm_lock:
            initial_count = len(_swarm_chars)
            bot_ids = inject_bots(_swarm_chars, count=3)
            self.assertEqual(len(_swarm_chars), initial_count + 3)
            for bid in bot_ids:
                self.assertIn(bid, _swarm_chars)

            removed = remove_bots(_swarm_chars)
            self.assertEqual(removed, 3)
            self.assertEqual(len(_swarm_chars), initial_count)

    def test_snapshot_persistence_integration(self):
        test_path = "backend/data/test_integration_snapshot.json"
        with _swarm_lock:
            save_snapshot(_swarm_chars, test_path)
            restored = load_snapshot(test_path)
            self.assertIsNotNone(restored)
            self.assertEqual(len(restored), len(_swarm_chars))
        clear_snapshot(test_path)


if __name__ == "__main__":
    unittest.main()
