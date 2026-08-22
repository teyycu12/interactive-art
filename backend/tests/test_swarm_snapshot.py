import os
import shutil
import tempfile
import time
import unittest
from backend.swarm_snapshot import save_snapshot, load_snapshot, clear_snapshot


class TestSwarmSnapshot(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.snapshot_path = os.path.join(self.test_dir, "test_snapshot.json")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_save_and_load_snapshot(self):
        mock_chars = {
            "char_1": {
                "id": "char_1",
                "x": 100.5,
                "y": 200.5,
                "upper": {"hex": "#FF0000"},
                "body_png": "data:image/png;base64,large_binary_data...",
            },
            "char_2": {
                "id": "char_2",
                "x": 300.0,
                "y": 400.0,
                "outfit": {"inner_color": "#00FF00"},
            },
        }

        ok = save_snapshot(mock_chars, self.snapshot_path)
        self.assertTrue(ok)
        self.assertTrue(os.path.exists(self.snapshot_path))

        restored = load_snapshot(self.snapshot_path)
        self.assertIsNotNone(restored)
        self.assertEqual(len(restored), 2)
        self.assertIn("char_1", restored)
        self.assertIn("char_2", restored)
        # body_png should be excluded
        self.assertNotIn("body_png", restored["char_1"])
        self.assertEqual(restored["char_1"]["upper"]["hex"], "#FF0000")

    def test_load_nonexistent_snapshot(self):
        self.assertIsNone(load_snapshot("/path/to/nonexistent/file.json"))

    def test_load_expired_snapshot(self):
        mock_chars = {"c1": {"id": "c1"}}
        save_snapshot(mock_chars, self.snapshot_path)

        # max_age_seconds = 0 should treat freshly saved snapshot as expired
        time.sleep(0.01)
        restored = load_snapshot(self.snapshot_path, max_age_seconds=0.001)
        self.assertIsNone(restored)

    def test_clear_snapshot(self):
        save_snapshot({"c1": {"id": "c1"}}, self.snapshot_path)
        self.assertTrue(os.path.exists(self.snapshot_path))
        clear_snapshot(self.snapshot_path)
        self.assertFalse(os.path.exists(self.snapshot_path))


if __name__ == "__main__":
    unittest.main()
