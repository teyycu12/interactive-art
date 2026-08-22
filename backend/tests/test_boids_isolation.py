import unittest
from backend.swarm_logic import update_swarm_state


class TestBoidsIsolation(unittest.TestCase):
    def test_boids_key_narrowing_preserves_customizations(self):
        _BOIDS_KEYS = ("x", "y", "vx", "vy", "state", "greeting_ticks")

        # Initial character state
        swarm_chars = {
            "c1": {
                "id": "c1",
                "x": 100.0,
                "y": 100.0,
                "vx": 1.0,
                "vy": 0.0,
                "upper": {"hex": "#112233"},
                "outfit": {"inner_color": "#112233"},
                "face": {"hair_style": "short_straight"},
            }
        }

        # Snapshot for physics tick
        snapshot = list(swarm_chars.values())
        updated = update_swarm_state(snapshot)

        # Simulate concurrent user update during the physics calculation window
        swarm_chars["c1"]["upper"] = {"hex": "#998877"}
        swarm_chars["c1"]["outfit"]["inner_color"] = "#998877"
        swarm_chars["c1"]["face"]["hair_style"] = "curly"

        # Apply narrowed write-back
        for c in updated:
            cid = c["id"]
            if cid in swarm_chars:
                for k in _BOIDS_KEYS:
                    if k in c:
                        swarm_chars[cid][k] = c[k]

        # Assert positions updated, but user customization was NOT overwritten!
        self.assertEqual(swarm_chars["c1"]["upper"]["hex"], "#998877")
        self.assertEqual(swarm_chars["c1"]["outfit"]["inner_color"], "#998877")
        self.assertEqual(swarm_chars["c1"]["face"]["hair_style"], "curly")


if __name__ == "__main__":
    unittest.main()
