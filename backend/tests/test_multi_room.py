import unittest
from backend.swarm_logic import update_swarm_state


class TestMultiRoom(unittest.TestCase):
    def test_room_tagging_and_filtering(self):
        swarm = {
            "c1": {"id": "c1", "room": "hall_a", "x": 100, "y": 100},
            "c2": {"id": "c2", "room": "hall_a", "x": 120, "y": 100},
            "c3": {"id": "c3", "room": "hall_b", "x": 800, "y": 800},
        }

        hall_a_chars = [c for c in swarm.values() if c.get("room") == "hall_a"]
        hall_b_chars = [c for c in swarm.values() if c.get("room") == "hall_b"]

        self.assertEqual(len(hall_a_chars), 2)
        self.assertEqual(len(hall_b_chars), 1)

        # Ensure update_swarm_state updates coordinates without losing room metadata
        updated_a = update_swarm_state(hall_a_chars)
        self.assertEqual(len(updated_a), 2)
        self.assertEqual(updated_a[0]["room"], "hall_a")
        self.assertEqual(updated_a[1]["room"], "hall_a")


if __name__ == "__main__":
    unittest.main()
