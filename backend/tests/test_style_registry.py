import os
import unittest
from pathlib import Path
from unittest.mock import patch

# Importing garment_gen registers every installed style.
import backend.garment_gen as garment_gen  # noqa: F401
import backend.style_registry as style_registry
from backend.style_registry import (
    GenerationStyle, get_event_style_id, get_style, has_style, list_all_styles,
    list_styles, register_style, resolve_style_id,
)

from PIL import Image as PILImage

REPO_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_ROOT = REPO_ROOT / "docs" / "style_reference"


class StyleRegistryTests(unittest.TestCase):
    def test_installed_styles_load(self):
        self.assertEqual(get_style("lego").style_id, "lego")
        self.assertEqual(get_style("pixar").style_id, "pixar")
        self.assertEqual(get_style("pixel").style_id, "pixel")
        self.assertEqual({s["id"] for s in list_styles()}, {"lego", "pixar", "pixel"},
                         "可選的風格清單變了 —— 手機端選單直接吃這一份")

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
            {"lego", "pixar", "pixel"},
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
        # 連尚未上線的風格一起檢查：它上線那天才發現和別人共用一組圖，
        # 就等於這個檢查沒發揮作用。
        sets = [get_style(s["id"]).reference_set for s in list_all_styles()]
        self.assertTrue(all(sets), "風格必須指名自己的參考圖集")
        self.assertEqual(len(sets), len(set(sets)), "兩個風格不得共用同一組參考圖")

    def test_reference_sets_exist_on_disk(self):
        """可選的風格必須真的有圖。尚未上線的風格不在此列 —— 它缺圖是已知的。"""
        for style in list_styles():
            with self.subTest(style=style["id"]):
                directory = REFERENCE_ROOT / style["referenceSet"]
                self.assertTrue(directory.is_dir(), f"{directory} 不存在")
                self.assertTrue(
                    list(directory.glob("full_body_*")),
                    f"{directory} 裡沒有 full_body_* —— sheet 會靜默退回不送",
                )

    def test_prompts_and_pose_references_are_not_shared(self):
        every = [get_style(s["id"]) for s in list_all_styles()]
        prompts = [style.full_prompt_template for style in every]
        self.assertEqual(len(prompts), len(set(prompts)))
        poses = [style.pose_builder for style in every]
        self.assertTrue(all(poses), "每個風格都要有自己的姿勢參考")
        self.assertEqual(len(poses), len(set(poses)))
        roles = [style.role_style_text for style in every]
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

class PendingStyleTests(unittest.TestCase):
    """尚未備妥參考圖的風格：線接著，但不可以被選。

    風格的程式碼可以先寫好，策展參考圖集要另外備。中間這段期間若讓它出現在
    手機端選單上，參與者會選到一個沒有 sheet 撐著的風格 —— 生成不會失敗，
    只是每個角色各自漂移，看起來像模型不穩。所以 ready=False 的風格必須
    「查得到、選不到」。

    這裡註冊一個臨時風格來測，而不是指名當下剛好還沒上線的那一個：像素風格
    2026-09-24 上線之後，原本綁在它身上的測試會一起消失，而這個機制本身還在。
    """

    PROBE_ID = "_pending_probe"

    def setUp(self):
        register_style(GenerationStyle(
            style_id=self.PROBE_ID,
            full_prompt_template="probe prompt",
            supported_modes=frozenset({"full_character"}),
            reference_set="_probe_set_not_on_disk",
            role_style_text="probe role",
            pose_builder=lambda: None,
            ready=False,
        ))

    def tearDown(self):
        style_registry._STYLES.pop(self.PROBE_ID, None)

    def test_pending_style_is_wired_but_not_selectable(self):
        self.assertEqual(get_style(self.PROBE_ID).style_id, self.PROBE_ID, "線要是接著的")
        self.assertFalse(get_style(self.PROBE_ID).ready)
        self.assertFalse(has_style(self.PROBE_ID), "API 邊界要擋掉")
        self.assertEqual(resolve_style_id(self.PROBE_ID), "lego")
        with patch.dict(os.environ, {"CHARACTER_STYLE": self.PROBE_ID}):
            self.assertEqual(get_event_style_id(), "lego",
                             "活動預設也不能指到還沒備妥的風格")

    def test_pending_style_is_absent_from_the_phone_menu(self):
        self.assertNotIn(self.PROBE_ID, {s["id"] for s in list_styles()})
        self.assertIn(self.PROBE_ID, {s["id"] for s in list_all_styles()})

    def test_health_reports_a_pending_style_instead_of_hiding_it(self):
        """/health 要分得出「圖還沒備」與「這個風格根本沒註冊成功」。"""
        with patch.dict(os.environ, {"STYLE_REFERENCE_MODE": "off"}):
            report = garment_gen.style_reference_report()
        self.assertTrue(report[self.PROBE_ID]["pending"])
        self.assertFalse(report["lego"]["pending"])


class PixelStyleTests(unittest.TestCase):
    """像素風格特有的耦合。

    這個風格和其他兩個最大的不同是：它有一個**數字**（格子多高）必須同時
    成立於 prompt、姿勢參考圖與策展圖規格。三邊對不上時模型會同時收到兩種
    格距，輸出的格子大小就會每張都不一樣 —— 而三邊都不會報錯。
    """

    def test_grid_height_is_the_same_number_in_prompt_pose_and_intake(self):
        grid = garment_gen.PIXEL_ART_GRID_HEIGHT
        self.assertIn(f"about {grid} cells", get_style("pixel").full_prompt_template)
        intake = (REFERENCE_ROOT / "2026q3_pixel_curated" / "INTAKE.md").read_text(encoding="utf-8")
        self.assertIn(str(grid), intake, "INTAKE.md 要求的格數和 prompt 不一致")

    def test_pose_reference_is_drawn_on_the_grid(self):
        """姿勢參考圖自己必須是像素畫。

        它若畫成平滑的，就會一邊叫模型「每個邊緣都貼齊格線」，一邊附上一張
        反鋸齒的圖當範本。和皮克斯那張姿勢圖不能有黑輪廓是同一類錯誤。
        """
        grid = garment_gen.PIXEL_ART_GRID_HEIGHT
        pose = garment_gen._canonical_pixel_pose(size=grid * 8)
        shrunk = pose.resize((grid, grid), PILImage.NEAREST)
        self.assertEqual(
            shrunk.resize(pose.size, PILImage.NEAREST).tobytes(),
            pose.tobytes(),
            "姿勢參考圖有不貼齊格線的像素 —— 它被平滑縮放過了",
        )
        self.assertLessEqual(len(pose.getcolors(maxcolors=256) or []), 8,
                             "姿勢參考圖的顏色階數應該很少（沒有漸層）")

    def test_ink_matches_the_big_screen_pixel_scenes(self):
        """角色的輪廓色與大螢幕像素場景的墨色是同一支。

        不同調時角色會像貼在背景上的一張圖，而兩邊分別看都很正常。
        """
        kit = (REPO_ROOT / "public" / "screen" / "scenes" / "pixelKit.js").read_text(encoding="utf-8")
        self.assertIn(garment_gen.PIXEL_INK.lower(), kit.lower())
        self.assertIn(garment_gen.PIXEL_INK, get_style("pixel").full_prompt_template)

    def test_pixel_prompt_does_not_carry_the_other_species_vocabulary(self):
        """正面指示裡殘留樂高／皮克斯語彙，會把塑膠或柔光一起帶回來。

        只檢查正面指示那一段：negative 裡的 "NOT a LEGO minifigure" 是刻意的
        否定，把整份 prompt 一起搜會把它誤判成殘留。
        """
        prompt = get_style("pixel").full_prompt_template
        head, _, negative = prompt.partition("Strictly NO text")
        self.assertTrue(negative, "negative 段落的起頭改了，這個測試要跟著改")

        head = head.lower()
        for word in ("minifigure", "moulded plastic", "claw hand", "lego",
                     "subsurface", "specular", "softbox"):
            self.assertNotIn(word, head, f"像素的正面指示不該出現 {word!r}")

        negative = negative.lower()
        # 反鋸齒不只是美感問題：去背與 slicer 的 alpha 邊界都假設邊緣是硬的。
        self.assertIn("no anti-aliasing", negative)
        self.assertIn("dithering", negative)
        self.assertIn("lego minifigure", negative, "要明確否掉玩具讀法")

    def test_reference_images_keep_the_sheet_friendly_frame(self):
        """六張參考圖的畫框必須是 1023x1533 PNG。

        `_build_style_reference_sheet()` 會把每張縮進 341x511（整張的 1/3）。
        1023x1533 剛好整除，格線才不會在拼 sheet 那一步被 LANCZOS 糊掉。
        生圖工具的原始輸出是 1344x768 橫式，直接放進來的話角色只會占到格子
        高度的三分之一 —— 而這兩種失誤都不會報錯，只會讓 sheet 教錯東西。
        整理工具是 scripts/pixelize_reference.py。
        """
        directory = REFERENCE_ROOT / get_style("pixel").reference_set
        images = sorted(directory.glob("full_body_*"))
        self.assertEqual(len(images), 6, "六張全身圖是這個風格的定義，不能少")
        for path in images:
            with self.subTest(image=path.name):
                self.assertEqual(path.suffix, ".png",
                                 "失真壓縮會直接汙染 edge_density 與 local_contrast")
                with PILImage.open(path) as image:
                    self.assertEqual(image.size, (1023, 1533))


if __name__ == "__main__":
    unittest.main()
