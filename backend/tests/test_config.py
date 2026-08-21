import os
import unittest
from backend.config import AppConfig, _get_int, _get_bool


class TestConfig(unittest.TestCase):
    def test_get_int_valid(self):
        os.environ["TEST_PORT"] = "8080"
        self.assertEqual(_get_int("TEST_PORT", 5001), 8080)
        os.environ.pop("TEST_PORT", None)

    def test_get_int_invalid_raises_value_error(self):
        os.environ["TEST_PORT_INVALID"] = "not_a_number"
        with self.assertRaises(ValueError) as ctx:
            _get_int("TEST_PORT_INVALID", 5001)
        self.assertIn("必須是整數", str(ctx.exception))
        os.environ.pop("TEST_PORT_INVALID", None)

    def test_get_bool(self):
        os.environ["TEST_FLAG_1"] = "false"
        self.assertFalse(_get_bool("TEST_FLAG_1", True))
        os.environ["TEST_FLAG_2"] = "1"
        self.assertTrue(_get_bool("TEST_FLAG_2", False))
        os.environ.pop("TEST_FLAG_1", None)
        os.environ.pop("TEST_FLAG_2", None)

    def test_app_config_defaults(self):
        cfg = AppConfig()
        self.assertGreaterEqual(cfg.GEN_MAX_CONCURRENT, 1)
        self.assertGreaterEqual(cfg.MAX_SWARM_SIZE, 10)
        self.assertEqual(cfg.PORT, 5001)


if __name__ == "__main__":
    unittest.main()
