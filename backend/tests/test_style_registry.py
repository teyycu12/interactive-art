import os
import unittest
from pathlib import Path
from unittest.mock import patch

# Importing garment_gen registers every installed style.
import backend.garment_gen as garment_gen  # noqa: F401
from backend.style_registry import (
    get_event_style_id, get_style, has_style, list_styles, resolve_style_id,
)

REFERENCE_ROOT = Path(__file__).resolve().parents[2] / "docs" / "style_reference"


class StyleRegistryTests(unittest.TestCase):
    def test_installed_styles_load(self):
        self.assertEqual(get_style("lego").style_id, "lego")
        self.assertEqual(get_style("pixar").style_id, "pixar")
        self.assertEqual({s["id"] for s in list_styles()}, {"lego", "pixar"})

    def test_unknown_style_falls_back_on_the_generation_path(self):
        """生成路徑刻意寬容：現場不該因為一個字串錯掉就生不出角色。"""
        self.assertEqual(get_style("future-style").style_id, "lego")
        with patch.dict(os.environ, {"CHARACTER_STYLE": "future-style"}):
            self.assertEqual(get_event_style_id(), "lego")

    def test_api_boundary_can_tell_unknown_from_known(self):
        """但邊界要分得出來，否則手機端送錯風格會拿到樂高卻以為選到別的。"""
        self.assertTrue(has_style("pixar"))
        self.assertFalse(has_style("future-style"))
        self.assertFalse(has_style(None))
        self.assertFalse(has_style(123))

    def test_resolve_prefers_the_request_then_the_event_default(self):
        self.assertEqual(resolve_style_id("pixar"), "pixar")
        self.assertEqual(resolve_style_id("PIXAR  "), "pixar", "大小寫與空白不該讓選擇失效")
        self.assertEqual(resolve_style_id(None), "lego")
        self.assertEqual(resolve_style_id("future-style"), "lego")
        with patch.dict(os.environ, {"CHARACTER_STYLE": "pixar"}):
            self.assertEqual(resolve_style_id(None), "pixar")


class SingleRegistryInstanceTests(unittest.TestCase):
    """註冊表只能有一份。

    專案裡兩種匯入路徑並存：garment_gen 走 `backend.style_registry`，
    service.py 走 `style_registry`（它以 `python backend/service.py` 啟動，
    sys.path[0] 就是 backend/）。兩條路徑都成立時 Python 會建立兩個獨立的
    模組物件，各自帶一份空的 _STYLES —— 註冊寫進一份、查詢讀另一份。

    後果全程無聲：沒有例外、沒有 log、_DEGRADED 也是空的，只是每一個請求
    都回傳預設風格。實際發生過，症狀是「選了皮克斯卻生出樂高」。
    """

    def test_both_import_paths_are_the_same_module(self):
        import backend.style_registry as via_package
        import style_registry as via_bare
        self.assertIs(via_package, via_bare)

    def test_both_import_paths_share_the_registered_styles(self):
        import style_registry as via_bare
        self.assertEqual(
            {s["id"] for s in via_bare.list_styles()},
            {"lego", "pixar"},
            "bare import 看不到已註冊的風格 —— 註冊表被拆成兩份了",
        )
        self.assertEqual(via_bare.resolve_style_id("pixar"), "pixar")


class StyleAssetsTests(unittest.TestCase):
    """每個風格的四樣東西必須各自成套。

    prompt、negative、姿勢參考、風格 sheet 若有任何一項被兩個風格共用，
    模型會收到互相矛盾的指示 —— 而 sheet 在 prompt 裡被宣告為工藝的最高
    權威，所以這種矛盾不會報錯，只會讓模型自己選一邊。
    """

    def test_every_style_names_its_own_reference_set(self):
        sets = [get_style(s["id"]).reference_set for s in list_styles()]
        self.assertTrue(all(sets), "風格必須指名自己的參考圖集")
        self.assertEqual(len(sets), len(set(sets)), "兩個風格不得共用同一組參考圖")

    def test_reference_sets_exist_on_disk(self):
        for style in list_styles():
            with self.subTest(style=style["id"]):
                directory = REFERENCE_ROOT / style["referenceSet"]
                self.assertTrue(directory.is_dir(), f"{directory} 不存在")
                self.assertTrue(
                    list(directory.glob("full_body_*")),
                    f"{directory} 裡沒有 full_body_* —— sheet 會靜默退回不送",
                )

    def test_prompts_and_pose_references_are_not_shared(self):
        prompts = [get_style(s["id"]).full_prompt_template for s in list_styles()]
        self.assertEqual(len(prompts), len(set(prompts)))
        poses = [get_style(s["id"]).pose_builder for s in list_styles()]
        self.assertTrue(all(poses), "每個風格都要有自己的姿勢參考")
        self.assertEqual(len(poses), len(set(poses)))
        roles = [get_style(s["id"]).role_style_text for s in list_styles()]
        self.assertTrue(all(roles))
        self.assertEqual(len(roles), len(set(roles)))

    def test_pixar_prompt_does_not_carry_lego_vocabulary(self):
        """皮克斯的 prompt 若殘留樂高語彙，會把玩具材質帶回來。

        只檢查正面指示那一段：negative 裡的 "NOT a LEGO minifigure" 是刻意的
        否定，把整份 prompt 一起搜會把它誤判成殘留。
        """
        prompt = get_style("pixar").full_prompt_template
        head, _, negative = prompt.partition("Strictly NO text")
        self.assertTrue(negative, "negative 段落的起頭改了，這個測試要跟著改")

        head = head.lower()
        for word in ("minifigure", "moulded plastic", "claw hand", "lego"):
            self.assertNotIn(word, head, f"皮克斯的正面指示不該出現 {word!r}")
        self.assertIn("no outlines", negative.lower())
        self.assertIn("lego minifigure", negative.lower(), "要明確否掉玩具讀法")


if __name__ == "__main__":
    unittest.main()
