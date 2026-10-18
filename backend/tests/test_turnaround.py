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
from backend.turnaround import (
    BACK_FACE_MAX, BASE_BODY_CHIN, SQUASH_RANGE, back_shows_face, chin_fraction, face_fraction, face_right,
    find_figures, fit_base_body, fix_backward_feet, skin_tone, split_turnaround,
)

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


SKIN = (236, 186, 150)
BLOND = (205, 160, 80)    # 淺金髮：紅多藍少，「看起來像膚色」


def _profile(facing: str, hair=(30, 25, 25)) -> str:
    """去背後的側面（RGBA）：頭（後腦勺頭髮＋臉）、身體、腿。facing：臉朝哪邊。"""
    arr = np.zeros((900, 400, 4), dtype=np.uint8)
    arr[20:380, 100:300] = (*hair, 255)              # 頭（含髮），約 40%
    face = slice(180, 290) if facing == "right" else slice(110, 220)
    arr[120:370, face] = (*SKIN, 255)                # 臉在朝向的那一側
    arr[380:880, 150:250] = (*GRAY, 255)
    return _rgba_to_b64(arr)


def _front(hair=(30, 25, 25)) -> str:
    arr = np.zeros((900, 400, 4), dtype=np.uint8)
    arr[20:380, 100:300] = (*hair, 255)
    arr[150:370, 130:270] = (*SKIN, 255)
    arr[380:880, 120:280] = (*GRAY, 255)
    return _rgba_to_b64(arr)


class FaceRightTests(unittest.TestCase):
    """實測（2026-10-15）：模型把側面整個畫成朝左，大螢幕往右走時倒著走。"""

    def test_left_facing_profile_is_mirrored_and_keeps_transparency(self):
        out, mirrored = face_right(_profile("left"), skin_tone(_front()))
        self.assertTrue(mirrored)
        arr = np.asarray(PILImage.open(io.BytesIO(base64.b64decode(out))))
        self.assertEqual(arr.shape[2], 4, "去背後的圖要留著透明度")
        self.assertEqual(arr[5, 5, 3], 0, "背景要是透明的，不能變成黑底")
        self.assertEqual(tuple(arr[200, 250, :3]), SKIN, "鏡像後臉在右邊")

    def test_right_facing_profile_is_left_alone(self):
        src = _profile("right")
        self.assertEqual(face_right(src, skin_tone(_front())), (src, False))

    def test_blond_hair_is_not_taken_for_the_face(self):
        # 不用正面的膚色時，淺金髮整顆頭都「像膚色」，分不出臉在哪邊
        out, mirrored = face_right(_profile("left", BLOND), skin_tone(_front(BLOND)))
        self.assertTrue(mirrored)

    def test_front_skin_tone_is_the_face_not_the_hair(self):
        tone = skin_tone(_front(BLOND))
        self.assertTrue(all(abs(a - b) <= 8 for a, b in zip(tone, SKIN)), tone)


def _back(ears=True) -> str:
    """去背後的背面：整顆頭是頭髮，只露出兩邊耳朵一點點。"""
    arr = np.zeros((900, 400, 4), dtype=np.uint8)
    arr[20:380, 100:300] = (30, 25, 25, 255)
    if ears:
        arr[200:240, 92:100] = (*SKIN, 255)
        arr[200:240, 300:308] = (*SKIN, 255)
    arr[380:880, 120:280] = (*GRAY, 255)
    return _rgba_to_b64(arr)


class BackShowsFaceTests(unittest.TestCase):
    """實測（2026-10-18，備援模型）：第三個人畫成朝左的側臉，不是後腦勺。"""

    def test_back_of_the_head_is_a_back(self):
        self.assertFalse(back_shows_face(_back(), skin_tone(_front())))

    def test_a_profile_in_the_back_slot_is_caught(self):
        self.assertTrue(back_shows_face(_profile("left"), skin_tone(_front())))

    def test_threshold_sits_between_ears_and_a_face(self):
        skin = skin_tone(_front())
        self.assertLess(face_fraction(_back(), skin), BACK_FACE_MAX)
        self.assertGreater(face_fraction(_profile("left"), skin), BACK_FACE_MAX)

    def test_blond_back_of_the_head_is_not_a_face(self):
        """淺金髮「看起來像膚色」：要用正面量到的膚色比，不然金髮的背面全被丟掉。"""
        arr = np.asarray(_decode(_back())).copy()
        arr[20:380, 100:300] = (*BLOND, 255)
        self.assertFalse(back_shows_face(_rgba_to_b64(arr), skin_tone(_front(BLOND))))


BEIGE = (214, 212, 181)   # 米色上衣：紅多藍少，也「看起來像膚色」


def _person(chin, height=900, width=400, shirt=GRAY, brows=False, alpha=True):
    """一個站著的人：頭髮、臉（下巴在 chin，以身高為單位）、上衣、褲子。

    alpha=False 時畫在白底上（給整張三視圖用）。"""
    arr = np.zeros((height, width, 4), dtype=np.uint8)
    if not alpha:
        arr[...] = (255, 255, 255, 255)
    top, bottom = 20, height - 20
    h = bottom - top
    chin_y = top + int(chin * h)
    arr[top:chin_y, 100:300] = (30, 25, 25, 255)                         # 頭髮
    arr[top + int(h * 0.1):chin_y, 130:270] = (*SKIN, 255)              # 臉
    if brows:
        # 眉毛、眼睛橫過臉（1 格多高），只剩眉心一條膚色連著：那幾列的臉窄得
        # 像脖子，下巴不能停在這裡
        y = top + int(h * 0.1) + int((chin_y - top) * 0.3)
        arr[y:y + 14, 130:190] = (30, 25, 25, 255)
        arr[y:y + 14, 210:270] = (30, 25, 25, 255)
    arr[chin_y:top + int(h * 0.7), 120:280] = (*shirt, 255)              # 上衣
    arr[top + int(h * 0.7):bottom, 140:260] = (*GRAY, 255)              # 褲子
    return arr


def _chin_of(b64):
    return chin_fraction(b64)


def _height(b64):
    rows = np.nonzero((np.asarray(_decode(b64))[:, :, 3] > 0).any(axis=1))[0]
    return rows[-1] - rows[0] + 1


class BaseBodyFitTests(unittest.TestCase):
    """模型常照真人照片的比例畫（下巴在 28% 的 4 頭身），每個人個頭不一
    （2026-10-16 現場回報）。不重生：下巴以下壓回素體的頭身比。"""

    def test_constant_matches_the_base_body(self):
        """BASE_BODY_CHIN 量自素體；換素體沒改數字的話，每個角色都被壓到舊比例。"""
        sheet = PILImage.open(garment_gen.PIXEL_BASE_BODY).convert("RGB")
        x0, x1, _, _ = find_figures(sheet)[0]
        rgb = np.asarray(sheet)
        alpha = np.where(rgb.min(axis=2) > 240, 0, 255).astype(np.uint8)
        front = np.dstack([rgb, alpha])[:, x0:x1]
        self.assertAlmostEqual(chin_fraction(_rgba_to_b64(np.ascontiguousarray(front))), BASE_BODY_CHIN, delta=0.01)

    def test_chin_is_measured(self):
        self.assertAlmostEqual(_chin_of(_rgba_to_b64(_person(0.3))), 0.3, delta=0.01)

    def test_brows_across_the_face_do_not_stop_at_the_eyes(self):
        self.assertAlmostEqual(_chin_of(_rgba_to_b64(_person(0.3, brows=True))), 0.3, delta=0.01)

    def test_skin_is_sampled_on_the_face_of_a_tall_figure(self):
        """4 頭身的角色，原本的取樣段（20%~42%）落在米色上衣上，下巴整個找錯。"""
        tone = skin_tone(_rgba_to_b64(_person(0.25, shirt=BEIGE)))
        self.assertTrue(all(abs(a - b) <= 8 for a, b in zip(tone, SKIN)), tone)

    def test_tall_figure_is_squashed_to_the_base_body(self):
        views = {name: _rgba_to_b64(_person(0.28)) for name in ("front", "side", "back")}
        out, scale = fit_base_body(views)
        self.assertIsNotNone(scale)
        self.assertLess(scale, 1)
        self.assertAlmostEqual(_chin_of(out["front"]), BASE_BODY_CHIN, delta=0.01)
        # 頭一格都不動，只動下巴以下
        head = np.asarray(_decode(views["front"]))[:255]
        self.assertTrue((np.asarray(_decode(out["front"]))[:255] == head).all())
        # 三面同一個倍率：換面時個頭不能忽大忽小
        self.assertEqual({_height(out[name]) for name in out}, {_height(out["front"])})

    def test_on_model_figure_is_left_alone(self):
        views = {"front": _rgba_to_b64(_person(BASE_BODY_CHIN))}
        self.assertEqual(fit_base_body(views), (views, None))

    def test_extreme_figure_is_only_partly_squashed(self):
        """下巴 0.2 硬壓到 0.42 會壓成一團，倍率有下限。"""
        _, scale = fit_base_body({"front": _rgba_to_b64(_person(0.2))})
        self.assertEqual(scale, SQUASH_RANGE[0])

    def test_figure_without_a_face_is_left_alone(self):
        arr = _person(0.3)
        arr[(arr[:, :, :3] == SKIN).all(axis=2)] = (*GRAY, 255)
        views = {"front": _rgba_to_b64(arr)}
        self.assertEqual(fit_base_body(views), (views, None))


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

    def test_pixel_is_fitted_to_the_base_body(self):
        """接在管線裡：模型照真人比例畫的 4 頭身，出來是素體的頭身比。"""
        person = _person(0.28, alpha=False)[:, :, :3]
        gap = np.full((900, 100, 3), 255, dtype=np.uint8)
        sheet = np.concatenate([gap, person, gap, person, gap, person, gap], axis=1)
        out = self._run(_rgba_to_b64(np.dstack([sheet, np.full(sheet.shape[:2], 255, np.uint8)])))
        self.assertTrue(out["ok"])
        self.assertLess(out["base_body_scale"], 1)
        self.assertAlmostEqual(chin_fraction(out["body_png"]), BASE_BODY_CHIN, delta=0.01)
        self.assertEqual(_height(out["side_png"]), _height(out["body_png"]))

    def test_back_view_with_a_face_is_dropped(self):
        """背面畫成另一個側臉：不要它，大螢幕往上走時退回正面。"""
        person = _person(0.42, alpha=False)[:, :, :3]
        gap = np.full((900, 100, 3), 255, dtype=np.uint8)
        sheet = np.concatenate([gap, person, gap, person, gap, person, gap], axis=1)
        out = self._run(_rgba_to_b64(np.dstack([sheet, np.full(sheet.shape[:2], 255, np.uint8)])))
        self.assertTrue(out["ok"])
        self.assertNotIn("back_png", out)
        self.assertTrue(out["back_dropped"])
        self.assertIn("side_png", out)

    def test_real_back_view_is_kept(self):
        person = _person(0.42, alpha=False)[:, :, :3]
        back = person.copy()
        back[(back == SKIN).all(axis=2)] = (30, 25, 25)   # 後腦勺：臉的位置是頭髮
        gap = np.full((900, 100, 3), 255, dtype=np.uint8)
        sheet = np.concatenate([gap, person, gap, person, gap, back, gap], axis=1)
        out = self._run(_rgba_to_b64(np.dstack([sheet, np.full(sheet.shape[:2], 255, np.uint8)])))
        self.assertIn("back_png", out)
        self.assertNotIn("back_dropped", out)

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

    def test_prompt_spells_out_each_accessory_in_every_view(self):
        # 背帶、背包在三面之間時有時無：要逐面講出配件長什麼樣，不是只說「一致」
        prompt = self.style.full_prompt_template
        self.assertIn("ACCESSORIES stay on in EVERY view", prompt)
        for phrase in ("strap across the back in the back view", "pack behind the back in the profile"):
            self.assertIn(phrase, prompt)

    def test_photo_does_not_set_body_proportions(self):
        # 照片會把真人的頭身比一起帶進來，同一批角色個頭不一
        self.assertIn("NOT their real-life body proportions", garment_gen._ROLE_PERSON)
        # 「pose reference」是姿勢圖那一行專屬的名字，照片那一行不能出現
        self.assertNotIn("pose reference", garment_gen._ROLE_PERSON)

    def test_role_text_says_the_sheet_is_the_layout(self):
        # 參考圖改成三視圖之後，排法就是要抄的；舊說法（「sheet 不是構圖」）
        # 留著會叫模型別學側面與背面怎麼畫
        self.assertIn("EXACTLY the layout to draw", self.style.role_style_text)
        self.assertNotIn("NOT the layout to copy", self.style.role_style_text)

    def test_pose_role_says_dress_the_base_body(self):
        # 素體不是灰色方塊：要叫模型照抄身材、換掉衣服髮型膚色
        role = self.style.role_pose_text
        self.assertIn("BASE BODY", role)
        self.assertIn("copy its height", role)
        self.assertIn("none of those belong to the output", role)

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
