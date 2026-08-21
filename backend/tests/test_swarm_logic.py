import unittest
from backend.swarm_logic import update_swarm_state, GREETING_DIST


class TestSwarmLogic(unittest.TestCase):
    def test_empty_characters(self):
        self.assertEqual(update_swarm_state([]), [])
        self.assertIsNone(update_swarm_state(None))

    def test_single_character_roaming(self):
        chars = [{"id": "c1", "x": 500, "y": 500, "vx": 0.5, "vy": 0.5}]
        res = update_swarm_state(chars, width=1920, height=1080)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["id"], "c1")
        self.assertEqual(res[0]["state"], "ROAMING")
        self.assertGreater(res[0]["x"], 500)
        self.assertGreater(res[0]["y"], 500)

    def test_greeting_when_close(self):
        # Two characters positioned close to each other (< GREETING_DIST = 80)
        chars = [
            {"id": "c1", "x": 500, "y": 500, "vx": 0.0, "vy": 0.0},
            {"id": "c2", "x": 530, "y": 500, "vx": 0.0, "vy": 0.0},
        ]
        res = update_swarm_state(chars)
        self.assertEqual(res[0]["state"], "GREETING")
        self.assertEqual(res[1]["state"], "GREETING")
        self.assertGreater(res[0]["greeting_ticks"], 0)

    def test_greeting_persistence(self):
        # Once separated, greeting state should hold for a few ticks
        chars = [
            {"id": "c1", "x": 500, "y": 500, "vx": 0.0, "vy": 0.0, "greeting_ticks": 5},
            {"id": "c2", "x": 800, "y": 800, "vx": 0.0, "vy": 0.0, "greeting_ticks": 0},
        ]
        res = update_swarm_state(chars)
        self.assertEqual(res[0]["state"], "GREETING")
        self.assertEqual(res[0]["greeting_ticks"], 4)
        self.assertEqual(res[1]["state"], "ROAMING")

    def test_boundary_clamping(self):
        # A character heading past the right boundary
        chars = [{"id": "c1", "x": 1919, "y": 500, "vx": 2.0, "vy": 0.0}]
        res = update_swarm_state(chars, width=1920, height=1080)
        self.assertLessEqual(res[0]["x"], 1920.0)
        self.assertGreaterEqual(res[0]["x"], 0.0)


if __name__ == "__main__":
    unittest.main()
