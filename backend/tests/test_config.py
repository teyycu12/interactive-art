import os
import unittest
from unittest import mock

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
        # 不斷言 PORT 的具體值：dataclass 預設值在 import 時求值，
        # 因此會反映真實環境。任何 export PORT 的機器都會讓斷言無故失敗。
        self.assertIsInstance(cfg.PORT, int)

    def test_port_default_without_env(self):
        """在乾淨環境下 PORT 預設為 5001（不受 host 環境變數影響）。"""
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_get_int("PORT", 5001), 5001)

    def test_startup_fields_exist(self):
        """socketio.run() 實際會用到的欄位必須存在。

        DEBUG 曾經缺漏，導致 `python app.py` 在綁定 port 前就 AttributeError，
        而當時沒有任何測試覆蓋 __main__，CI 完全看不到。
        """
        cfg = AppConfig()
        for field in ("HOST", "PORT", "DEBUG"):
            self.assertTrue(hasattr(cfg, field), f"AppConfig 缺少 {field}")
        self.assertIsInstance(cfg.DEBUG, bool)


if __name__ == "__main__":
    unittest.main()
