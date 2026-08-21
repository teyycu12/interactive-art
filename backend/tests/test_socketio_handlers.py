import unittest
from backend.app import app, socketio, _swarm_chars, _swarm_lock


@unittest.skipIf(socketio is None or app is None, "Flask/SocketIO not installed in current environment")
class TestSocketIOHandlers(unittest.TestCase):
    def setUp(self):
        self.client = socketio.test_client(app)
        self.assertTrue(self.client.is_connected())

    def tearDown(self):
        if self.client.is_connected():
            self.client.disconnect()

    def test_connect_and_server_message(self):
        received = self.client.get_received()
        events = [msg["name"] for msg in received]
        self.assertIn("server_message", events)

    def test_join_swarm_and_swarm_joined(self):
        payload = {
            "id": "test_user_01",
            "x": 100.0,
            "y": 200.0,
            "upper": {"hex": "#FF0000"},
            "lower": {"hex": "#0000FF"},
            "room": "main_hall",
        }
        self.client.emit("join_swarm", payload)
        received = self.client.get_received()
        joined_events = [msg for msg in received if msg["name"] == "swarm_joined"]
        self.assertEqual(len(joined_events), 1)
        self.assertEqual(joined_events[0]["args"][0]["id"], "test_user_01")
        self.assertEqual(joined_events[0]["args"][0]["room"], "main_hall")

        with _swarm_lock:
            self.assertIn("test_user_01", _swarm_chars)
            self.assertEqual(_swarm_chars["test_user_01"]["upper"]["hex"], "#FF0000")

    def test_get_swarm(self):
        self.client.emit("get_swarm", {"room": "default"})
        received = self.client.get_received()
        pos_events = [msg for msg in received if msg["name"] == "update_positions"]
        self.assertGreaterEqual(len(pos_events), 1)
        chars = pos_events[0]["args"][0]["characters"]
        self.assertIsInstance(chars, list)

    def test_update_character(self):
        with _swarm_lock:
            _swarm_chars["update_user"] = {"id": "update_user", "upper": {"hex": "#111111"}}

        self.client.emit("update_character", {"id": "update_user", "upper": {"hex": "#999999"}})
        with _swarm_lock:
            self.assertEqual(_swarm_chars["update_user"]["upper"]["hex"], "#999999")

    def test_leave_swarm(self):
        with _swarm_lock:
            _swarm_chars["leaving_user"] = {"id": "leaving_user"}

        self.client.emit("leave_swarm", {"id": "leaving_user"})
        with _swarm_lock:
            self.assertNotIn("leaving_user", _swarm_chars)

    def test_inject_and_remove_bots_events(self):
        self.client.emit("inject_bots", {"count": 4, "room": "default"})
        with _swarm_lock:
            bots = [c for c in _swarm_chars.values() if c.get("is_bot") or c["id"].startswith("bot_")]
            self.assertEqual(len(bots), 4)

        self.client.emit("remove_bots", {})
        with _swarm_lock:
            bots = [c for c in _swarm_chars.values() if c.get("is_bot") or c["id"].startswith("bot_")]
            self.assertEqual(len(bots), 0)


if __name__ == "__main__":
    unittest.main()
