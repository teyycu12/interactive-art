import os
import unittest
from unittest import mock

from backend.config import AppConfig, _get_int, _get_bool, _get_str


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


class TestEmptyEnvFallsBackToDefault(unittest.TestCase):
    """「變數存在但值為空」必須等同於未設定。

    .env 裡留一行 KEY= 是很自然的寫法 —— 從 .env.example 補設定進去時
    產生的就是這個形狀。但 os.environ.get(key, default) 在這種情況下會回傳
    空字串而非預設值。實際造成過兩次故障：模型名稱變成空字串導致生成全部
    失敗，以及 VISION_PORT= 讓 int('') 在啟動時就把生成服務打掛。
    """

    def test_get_str_treats_blank_as_unset(self):
        for blank in ("", "   ", "\t"):
            with mock.patch.dict(os.environ, {"TEST_STR": blank}):
                self.assertEqual(_get_str("TEST_STR", "fallback"), "fallback")

    def test_get_str_strips_and_returns_value(self):
        with mock.patch.dict(os.environ, {"TEST_STR": "  value  "}):
            self.assertEqual(_get_str("TEST_STR", "fallback"), "value")

    def test_get_str_missing_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_get_str("TEST_STR", "fallback"), "fallback")

    def test_model_names_survive_blank_env(self):
        """三個設定值都不可為空 —— 空字串會讓 API 回 404。

        直接測 `_get_str` 而不是建一個 AppConfig：`AppConfig` 的欄位是
        **dataclass 的 field default**，在 class 定義（也就是 import config）
        的當下就求值完畢並凍結。`mock.patch.dict` 之後再 `AppConfig()`
        拿到的仍是 import 當時的值，連 `clear=True` 都改不了它 ——
        於是這支測試實際釘的是「跑測試那台機器的 .env」而不是程式預設值。

        它曾因此在本機 .env 留著已退役的 `GENERATION_MODE=body_sprite` 時失敗，
        而 CI 上沒有 .env、剛好落在預設值，所以一直是綠的。
        """
        for key, default in (
            ("OUTFIT_GEN_MODEL", "google/gemini-3.1-flash-image-preview"),
            ("FULL_CHARACTER_MODEL", "google/gemini-3-pro-image-preview"),
            # full_character 是唯一還在線上的模式：body_sprite 與 brick_ai_texture
            # 已退役，app.py 會在付費呼叫前直接拒絕。預設值落在被拒絕的模式上，
            # 等於沒設這個環境變數的人一啟動就全部生成失敗。
            ("GENERATION_MODE", "full_character"),
        ):
            for blank in ("", "   "):
                with self.subTest(key=key, blank=repr(blank)):
                    with mock.patch.dict(os.environ, {key: blank}):
                        self.assertEqual(_get_str(key, default), default)

    def test_generation_mode_default_is_a_live_mode(self):
        """程式預設的生成模式不可以是已退役的那兩個。

        與上一支測試互補：那支釘「空字串不得覆寫預設值」，這支釘「預設值本身
        是活的」。分開是因為 AppConfig 的欄位凍結在 import 當下，這裡只能讀
        原始碼裡寫死的那個字面值。
        """
        import inspect

        from backend import config as config_module

        src = inspect.getsource(config_module)
        self.assertIn('_get_str("GENERATION_MODE", "full_character")', src)

    def test_refine_model_blank_becomes_none(self):
        """未指定精修模型時應為 None，讓解析鏈往下退回主模型。"""
        with mock.patch.dict(os.environ, {"REFINE_CHARACTER_MODEL": ""}):
            self.assertIsNone(AppConfig().REFINE_CHARACTER_MODEL)

    def test_int_and_bool_already_handle_blank(self):
        with mock.patch.dict(os.environ, {"TEST_N": "", "TEST_B": ""}):
            self.assertEqual(_get_int("TEST_N", 7), 7)
            self.assertIs(_get_bool("TEST_B", True), True)


if __name__ == "__main__":
    unittest.main()
