"""三視圖：切割、先切再去背、存檔，以及 prompt／姿勢參考／輸出比例成套。

像素風一次生成「正面｜右側｜背面」並排的一張圖，後端切成三張。幾個不這樣做
會出事、但不會報錯的地方：

- 先去背再切：去背會丟掉不連在主體上的孤島，另外兩個人被整個刪掉。
- 用固定三等分切：模型不保證等寬等距，會切到手或把鄰居的手肘帶進來。
- 姿勢參考仍是單一站姿：prompt 要三個、參考圖畫一個，模型自己挑一邊。
"""

import base64
import io
import unittest
from unittest import mock

import numpy as np
import pytest
from PIL import Image as PILImage

from backend import garment_gen
from backend.turnaround import find_figures, fix_backward_feet, split_turnaround

import service

GRAY = (90, 90, 100)


def _sheet(figures, width=1600, height=900, arm_gap=False):
    """白底上畫幾個「人」（矩形），figures 是 [(x0, x1), ...]。"""
    arr = np.full((height, width, 3), 255, dtype=np.uint8)
    for x0, x1 in figures:
        arr[100:860, x0:x1] = GRAY
        if arm_gap:
            # 手臂與身體之間 6px 的白縫：仍是同一個人
            arr[300:600, x0 + 20:x0 + 26] = 255
    buf = io.BytesIO()
    PILImage.fromarray(arr, "RGB").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _decode(b64):
    return PILImage.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")


def _gray_columns(img):
    arr = np.asarray(img.convert("RGB"))
    return int((arr.min(axis=2) < 235).any(axis=0).sum())


class SplitTests(unittest.TestCase):
    def test_three_figures_become_front_side_back(self):
        views, n = split_turnaround(_sheet([(150, 400), (700, 880), (1150, 1400)]))
        self.assertEqual(n, 3)
        self.assertEqual(set(views), {"front", "side", "back"})
        # 每一張只有自己那一個人（不帶到鄰居），而且都是完整圖高
        for name, width in (("front", 250), ("side", 180), ("back", 250)):
            img = _decode(views[name])
            self.assertEqual(img.height, 900, "三張要同高，normalize 之後比例尺才相同")
            self.assertEqual(_gray_columns(img), width, name)

    def test_gap_inside_one_figure_is_not_a_split(self):
        views, n = split_turnaround(_sheet([(150, 400), (700, 880), (1150, 1400)], arm_gap=True))
        self.assertEqual(n, 3)

    def test_uneven_spacing_is_followed_not_thirds(self):
        """模型不保證等距；固定三等分會切到人。"""
        views, n = split_turnaround(_sheet([(60, 300), (420, 600), (1300, 1550)]))
        self.assertEqual(n, 3)
        self.assertEqual(_gray_columns(_decode(views["side"])), 180)

    def test_single_figure_is_front_only(self):
        views, n = split_turnaround(_sheet([(600, 900)]))
        self.assertEqual(n, 1)
        self.assertEqual(set(views), {"front"})

    def test_wrong_count_keeps_leftmost_as_front_not_the_whole_sheet(self):
        """畫了兩個或四個人時，不能把整張圖當成一個角色。"""
        views, n = split_turnaround(_sheet([(100, 300), (500, 700), (900, 1100), (1300, 1500)]))
        self.assertEqual(n, 4)
        self.assertEqual(set(views), {"front"})
        self.assertEqual(_gray_columns(_decode(views["front"])), 200)

    def test_specks_are_not_figures(self):
        arr = np.full((900, 1600, 3), 255, dtype=np.uint8)
        arr[100:860, 600:900] = GRAY
        arr[50:53, 1400:1403] = 0  # 雜點
        buf = io.BytesIO()
        PILImage.fromarray(arr, "RGB").save(buf, "PNG")
        self.assertEqual(len(find_figures(PILImage.open(buf))), 1)

    def test_design_sheet_grid_and_frame_are_cleaned(self):
        """實測（2026-10-14）：模型鋪滿格線、加黑框，腳還踩進下方黑框裡。
        不清掉的話每一欄都「有東西」，整張設定稿被當成一個人上場。"""
        h, w = 900, 1600
        arr = np.full((h, w, 3), 255, dtype=np.uint8)
        arr[:, ::44] = 142            # 2px 灰色格線
        arr[:, 1::44] = 142
        arr[::44, :] = 142
        arr[1::44, :] = 142
        arr[:90] = 0                  # 上下黑框
        arr[810:] = 0
        arr[:, :50] = 0               # 左右黑框
        arr[:, 1550:] = 0
        # 人不貼著格線：貼著的那條線和描邊分不開，也無害
        for x0, x1 in ((200, 450), (700, 870), (1150, 1400)):
            arr[120:830, x0:x1] = GRAY    # 腳踩進下方黑框 20px
        buf = io.BytesIO()
        PILImage.fromarray(arr, "RGB").save(buf, "PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()

        views, n = split_turnaround(b64)
        self.assertEqual(n, 3)
        for name, width in (("front", 250), ("side", 170), ("back", 250)):
            img = _decode(views[name])
            self.assertEqual(_gray_columns(img), width, f"{name} 還帶著格線或黑框")
            # 踩進黑框的腳保留下來
            self.assertTrue((np.asarray(img.convert("RGB"))[820, :, 0] == GRAY[0]).any(), name)

    def test_blank_image_returns_none(self):
        views, n = split_turnaround(_sheet([]))
        self.assertIsNone(views)
        self.assertEqual(n, 0)


class EnclosedGapTests(unittest.TestCase):
    """手臂與身體之間被圍住的白縫：去背的 flood fill 走不到，要另外挖成透明。

    白上衣、眼睛的反光、白袖口也是被圍住的白，不能一起挖掉。"""

    def setUp(self):
        arr = np.full((900, 1600, 3), 255, dtype=np.uint8)
        for x0, x1 in ((150, 400), (700, 880), (1150, 1400)):
            arr[100:860, x0:x1] = GRAY
        for dx in (0, 550, 1000):   # 正面、側面、背面同一個位置都畫
            arr[380:560, 180 + dx:186 + dx] = 255   # 手與身體之間的縫：窄、直、在側邊
        arr[380:500, 230:330] = 255     # 白上衣：一大片
        arr[200:208, 300:306] = 255     # 眼睛的反光：在頭的高度
        # 白袖口：橫的。窄到、高到其他條件都放行，只靠「高比寬長」擋下
        arr[600:614, 168:188] = 255
        buf = io.BytesIO()
        PILImage.fromarray(arr, "RGB").save(buf, "PNG")
        self.views, self.n = split_turnaround(base64.b64encode(buf.getvalue()).decode())
        # 切下來的每一張從人的左緣往左多留 PAD 像素
        self.left = {"front": 150 - 8, "side": 700 - 8, "back": 1150 - 8}

    def alpha(self, view, x, y):
        img = _decode(self.views[view])
        return np.asarray(img)[y, x - self.left[view], 3]

    def test_arm_gap_becomes_transparent(self):
        self.assertEqual(self.n, 3)
        self.assertEqual(self.alpha("front", 183, 470), 0)
        self.assertEqual(self.alpha("back", 1183, 470), 0)

    def test_white_garment_eye_and_cuff_stay(self):
        self.assertEqual(self.alpha("front", 280, 440), 255, "白上衣被挖掉了")
        self.assertEqual(self.alpha("front", 303, 204), 255, "眼睛的反光被挖掉了")
        self.assertEqual(self.alpha("front", 178, 607), 255, "白袖口被挖掉了")

    def test_side_view_is_left_alone(self):
        """側面的手貼在身體前面，沒有這種縫；同樣形狀的白在側面是衣服的一部分。"""
        self.assertEqual(self.alpha("side", 733, 470), 255)


def _side_figure(toe: str, two_legs: bool = False) -> str:
    """去背後的側面人形（RGBA）：身體、一條（或兩條）小腿、一隻靴子。"""
    arr = np.zeros((900, 400, 4), dtype=np.uint8)
    arr[50:600, 140:260] = (*GRAY, 255)              # 上半身
    if two_legs:
        arr[600:830, 150:185] = (*GRAY, 255)
        arr[600:830, 215:250] = (*GRAY, 255)
        arr[830:880, 130:185] = (60, 40, 30, 255)
        arr[830:880, 215:280] = (60, 40, 30, 255)
        return _rgba_to_b64(arr)
    arr[600:830, 180:220] = (*GRAY, 255)             # 小腿（兩腿疊成一條）
    arr[830:880, 180:220] = (60, 40, 30, 255)        # 靴筒
    if toe == "left":
        arr[850:880, 120:180] = (60, 40, 30, 255)    # 鞋尖往後（左）伸 —— 畫反了
    else:
        arr[850:880, 220:280] = (60, 40, 30, 255)
    return _rgba_to_b64(arr)


def _rgba_to_b64(arr):
    buf = io.BytesIO()
    PILImage.fromarray(arr, "RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _foot_reach(b64):
    """腳掌那幾列往左、往右各伸出小腿中線（x=200）多遠。"""
    a = np.asarray(_decode(b64))[:, :, 3] > 128
    xs = np.nonzero(a[855:880].any(axis=0))[0]
    return 200 - xs[0], xs[-1] - 200


class BackwardFeetTests(unittest.TestCase):
    """實測：模型把側面的靴子畫反（人朝右、鞋尖朝左）。只翻腳踝以下。"""

    def test_backward_boot_is_flipped(self):
        out, flipped = fix_backward_feet(_side_figure("left"))
        self.assertTrue(flipped)
        back, front = _foot_reach(out)
        self.assertGreater(front, back, "翻完鞋尖要朝右")
        # 上半身不動
        self.assertTrue((np.asarray(_decode(out))[300, 140:260, 3] == 255).all())

    def test_forward_boot_is_left_alone(self):
        src = _side_figure("right")
        out, flipped = fix_backward_feet(src)
        self.assertFalse(flipped)
        self.assertEqual(out, src)

    def test_two_legs_apart_are_not_judged(self):
        """兩腿分開站時兩隻腳前後錯開，分不出哪隻反了。"""
        src = _side_figure("left", two_legs=True)
        self.assertEqual(fix_backward_feet(src), (src, False))


class GenerateSplitsBeforeBackgroundRemovalTests(unittest.TestCase):
    """整條 generate_full_character_png：三個人都要活過去背。"""

    def _run(self, sheet_b64, style_id="pixel"):
        fake = {"image_b64": sheet_b64, "api_usage": {}}
        rgb = np.full((480, 320, 3), 128, dtype=np.uint8)
        poly = np.array([[0.3, 0.1], [0.7, 0.1], [0.7, 0.9], [0.3, 0.9]])
        with mock.patch.object(garment_gen, "_get_client", return_value=object()), \
             mock.patch.object(garment_gen, "_call_image_chat_multi", return_value=fake):
            return garment_gen.generate_full_character_png(rgb, poly, style_id=style_id)

    def test_pixel_returns_three_views(self):
        out = self._run(_sheet([(150, 400), (700, 880), (1150, 1400)]))
        self.assertTrue(out["ok"])
        self.assertEqual(out["turnaround_figures"], 3)
        self.assertTrue(out["turnaround_sheet_png"], "整張原圖要留給後端紀錄")
        for key in ("body_png", "side_png", "back_png"):
            img = _decode(out[key])
            alpha = np.asarray(img)[:, :, 3]
            self.assertGreater((alpha > 0).sum(), 1000, f"{key} 被去背刪光了")

    def test_other_styles_do_not_split(self):
        out = self._run(_sheet([(150, 400), (700, 880), (1150, 1400)]), style_id="lego")
        self.assertNotIn("side_png", out)
        self.assertNotIn("turnaround_figures", out)


class PixelTurnaroundAgreementTests(unittest.TestCase):
    """prompt、姿勢參考、輸出比例三件事必須說同一件事。"""

    def setUp(self):
        self.style = garment_gen.get_style("pixel")

    def test_style_is_flagged_turnaround(self):
        self.assertTrue(self.style.turnaround)

    def test_pose_reference_itself_splits_into_three(self):
        """姿勢參考圖若被我們自己的切割器切不出三個人，模型更不會畫出三個。"""
        pose = self.style.pose_builder()
        self.assertEqual(len(find_figures(pose)), 3)

    def test_pose_reference_is_wide_like_the_output(self):
        pose = self.style.pose_builder()
        ratio = pose.width / pose.height
        self.assertAlmostEqual(ratio, 16 / 9, delta=0.05)
        cfg = self.style.generation_params["full_character"]["extra_body"]["image_config"]
        self.assertEqual(cfg["aspect_ratio"], "16:9")

    def test_prompt_asks_for_three_views_and_profile_to_the_right(self):
        prompt = self.style.full_prompt_template
        for phrase in ("THREE figures", "FRONT view", "RIGHT-SIDE PROFILE", "BACK view", "same baseline"):
            self.assertIn(phrase, prompt)
        self.assertNotIn("Center the figure", prompt, "單一置中的舊指令會和三視圖互相矛盾")
        # 負面提示詞曾留著「只能一個人、不准側面」，模型於是畫成鋪格線加黑框的設計稿
        for phrase in ("EXACTLY ONE single figure", "NO side view", "NO multiple views",
                       "facing the viewer", "cell grid aligned"):
            self.assertNotIn(phrase, prompt)
        for phrase in ("NO grid lines", "NO frame", "never drawn"):
            self.assertIn(phrase, prompt)

    def test_role_text_says_the_sheet_is_not_the_layout(self):
        self.assertIn("NOT the layout to copy", self.style.role_style_text)

    def test_other_styles_stay_single_view(self):
        for sid in ("lego", "pixar"):
            self.assertFalse(garment_gen.get_style(sid).turnaround, sid)


def _rgba_b64(width, height):
    arr = np.zeros((height, width, 4), dtype=np.uint8)
    arr[20:height - 20, 30:width - 30] = (90, 90, 100, 255)
    buf = io.BytesIO()
    PILImage.fromarray(arr, "RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "ASSET_DIR", str(tmp_path))
    monkeypatch.setattr(service, "analyze_outfit", lambda *a, **k: {"ok": False, "error": "stubbed"})
    monkeypatch.setattr(service, "analyze_face", lambda *a, **k: {"ok": False, "error": "stubbed"})
    service.app.config["TESTING"] = True
    return service.app.test_client()


def _photo_b64():
    buf = io.BytesIO()
    PILImage.new("RGB", (320, 480), (180, 140, 120)).save(buf, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _figure_b64():
    arr = np.zeros((400, 200, 4), dtype=np.uint8)
    arr[: 400 // 3, 60:140] = (74, 44, 26, 255)
    arr[400 // 3: 800 // 3, 40:160] = (143, 160, 94, 255)
    arr[800 // 3:, 60:140] = (183, 169, 138, 255)
    buf = io.BytesIO()
    PILImage.fromarray(arr, "RGBA").save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


class TestGenerateSavesViews:
    def test_side_and_back_are_saved_and_listed(self, client, monkeypatch, tmp_path):
        monkeypatch.setattr(service, "generate_full_character_png", lambda *a, **k: {
            "ok": True, "body_png": _figure_b64(),
            "side_png": _rgba_b64(120, 380), "back_png": _rgba_b64(200, 400),
            "turnaround_figures": 3,
        })
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is True
        aid = body["assetId"]
        for part in ("side", "back"):
            assert body["textures"][part] == f"/assets/gen/{aid}/{part}.webp"
            saved = PILImage.open(tmp_path / aid / f"{part}.webp")
            # 與 full.webp 同一個 normalize：高度相同，換面時角色不會忽大忽小
            assert saved.height == PILImage.open(tmp_path / aid / "full.webp").height
        assert body["turnaroundFigures"] == 3

    def test_missing_views_still_succeed(self, client, monkeypatch):
        monkeypatch.setattr(service, "generate_full_character_png",
                            lambda *a, **k: {"ok": True, "body_png": _figure_b64(), "turnaround_figures": 1})
        body = client.post("/generate", json={"image": _photo_b64()}).get_json()
        assert body["ok"] is True
        assert "side" not in body["textures"] and "back" not in body["textures"]
