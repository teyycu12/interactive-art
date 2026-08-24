import unittest
from backend.bot_simulator import generate_random_bot, inject_bots, remove_bots


class TestBotSimulator(unittest.TestCase):
    def test_generate_random_bot(self):
        bot = generate_random_bot(1, width=1920, height=1080)
        self.assertTrue(bot["id"].startswith("bot_"))
        self.assertTrue(bot["is_bot"])
        self.assertGreaterEqual(bot["x"], 0)
        self.assertLessEqual(bot["x"], 1920)
        self.assertIn("upper", bot)
        self.assertIn("lower", bot)
        self.assertIn("face", bot)
        self.assertIn("outfit", bot)

    def test_inject_and_remove_bots(self):
        swarm = {
            "real_user_1": {"id": "real_user_1", "x": 100, "y": 100},
            "real_user_2": {"id": "real_user_2", "x": 200, "y": 200},
        }

        bot_ids = inject_bots(swarm, count=5)
        self.assertEqual(len(bot_ids), 5)
        self.assertEqual(len(swarm), 7)
        for bid in bot_ids:
            self.assertIn(bid, swarm)

        # Ensure real users are preserved when removing bots
        removed_count = remove_bots(swarm)
        self.assertEqual(removed_count, 5)
        self.assertEqual(len(swarm), 2)
        self.assertIn("real_user_1", swarm)
        self.assertIn("real_user_2", swarm)


if __name__ == "__main__":
    unittest.main()
