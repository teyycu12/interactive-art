"""角色貼圖切片測試（整合計畫階段 2）。

沒有真實生成樣本時，用合成的人偶圖驗證幾何邏輯：每個部位塗成已知的
純色，切完之後就能斷言「頭那塊是不是頭的顏色」。真實樣本到位後，
另有 scripts/validate_cuts.py 量測固定裁切框在實際生成結果上的穩定度。
"""

import base64
import io
import os
import re

import numpy as np
import pytest
from PIL import Image as PILImage

from backend.slicer import (
    CUTS,
    NORMALIZED_HEIGHT,
    PARTS,
    alpha_bbox,
    analyze_cuts,
    decode_png,
    normalize,
    sample_fallback_colors,
    slice_character,
    slice_parts,
)

HAIR = (74, 44, 26, 255)
SKIN = (244, 192, 138, 255)
TORSO = (143, 160, 94, 255)
LEGS = (183, 169, 138, 255)


def make_figure(width=200, height=400, pad=40, arm_span=60):
    """合成一個帶透明邊界的積木人偶：頭髮／臉／軀幹（含手臂）／雙腿。

    pad 是四周的透明留白，用來驗證 normalize 有確實裁到 alpha 邊界。
    """
    img = PILImage.new("RGBA", (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    arr = np.array(img)
    x0, y0 = pad, pad
    cx = x0 + width // 2

    def fill(y_from, y_to, half_w, color):
        arr[y0 + y_from:y0 + y_to, cx - half_w:cx + half_w] = color

    h_head = round(height * 0.30)
    h_torso = round(height * 0.34)
    # 頭：上緣頭髮，其餘是臉
    fill(0, round(h_head * 0.35), 50, HAIR)
    fill(round(h_head * 0.35), h_head, 50, SKIN)
    # 軀幹：較寬，模擬展開的手臂
    fill(h_head, h_head + h_torso, 50 + arm_span, TORSO)
    # 雙腿：兩條，中央留鏤空
    leg_top = h_head + h_torso
    arr[y0 + leg_top:y0 + height, cx - 45:cx - 8] = LEGS
    arr[y0 + leg_top:y0 + height, cx + 8:cx + 45] = LEGS
    return PILImage.fromarray(arr, "RGBA")


def to_b64(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def figure():
    return make_figure()


class TestNormalize:
    def test_alpha_bbox_finds_tight_bounds(self, figure):
        x0, y0, x1, y1 = alpha_bbox(figure)
        assert (x0, y0) == (40 + 100 - 110, 40)  # 手臂最寬處決定左界
        assert y1 - y0 == 400

    def test_alpha_bbox_none_when_fully_transparent(self):
        blank = PILImage.new("RGBA", (10, 10), (0, 0, 0, 0))
        assert alpha_bbox(blank) is None

    def test_normalize_strips_padding_and_fixes_height(self, figure):
        norm = normalize(figure)
        assert norm.size[1] == NORMALIZED_HEIGHT
        # 裁到邊界後，最上緣一列必須已經有不透明像素
        assert (np.asarray(norm)[0, :, 3] > 0).any()

    def test_normalize_is_scale_invariant(self):
        """同一構圖放大兩倍，正規化後應得到同樣的部位顏色分佈。"""
        small = sample_fallback_colors(slice_parts(normalize(make_figure(200, 400))))
        large = sample_fallback_colors(slice_parts(normalize(make_figure(400, 800))))
        assert small == large

    def test_normalize_rejects_blank(self):
        with pytest.raises(ValueError):
            normalize(PILImage.new("RGBA", (10, 10), (0, 0, 0, 0)))


class TestSlice:
    def test_parts_cover_whole_height_without_gaps(self, figure):
        parts = slice_parts(normalize(figure))
        assert sum(p.size[1] for p in parts.values()) == NORMALIZED_HEIGHT

    def test_each_part_lands_on_expected_colors(self, figure):
        colors = sample_fallback_colors(slice_parts(normalize(figure)))
        assert colors["hair"] == "#4A2C1A"
        assert colors["skin"] == "#F4C08A"
        assert colors["torso"] == "#8FA05E"
        assert colors["legs"] == "#B7A98A"

    def test_cuts_are_ordered_and_contiguous(self):
        bounds = [CUTS[p] for p in PARTS]
        assert bounds[0][0] == 0.0 and bounds[-1][1] == 1.0
        for (_, prev_end), (next_start, _) in zip(bounds, bounds[1:]):
            assert prev_end == next_start, "裁切區間之間不可有縫隙或重疊"

    def test_median_ignores_soft_alpha_halo(self):
        """去背在輪廓邊界留下的半透明柔化環不可混進取樣色。

        _remove_white_background 會把輪廓外緣 2px 的 alpha 減半。那一圈的
        顏色是背景與人偶的混色，若被算進中位數，取樣色會整體偏向背景。
        這裡沿著人偶自己的輪廓塗，不擴張 alpha 外框 —— 真實的柔化環就是
        這個形狀；塗成整條橫帶會把 bbox 往外推，測到的就不是同一件事了。
        """
        arr = np.array(make_figure())
        solid = arr[:, :, 3] > 0
        # 輪廓環 = 實心區域減去往內縮一圈後的實心區域
        inner = (
            solid
            & np.roll(solid, 1, 0) & np.roll(solid, -1, 0)
            & np.roll(solid, 1, 1) & np.roll(solid, -1, 1)
        )
        arr[solid & ~inner] = (0, 255, 0, 120)
        colors = sample_fallback_colors(slice_parts(normalize(PILImage.fromarray(arr, "RGBA"))))
        assert colors["hair"] == "#4A2C1A"
        assert colors["torso"] == "#8FA05E"


class TestSliceCharacter:
    def test_writes_three_files_and_returns_contract(self, figure, tmp_path):
        asset_id = "a" * 32
        out = slice_character(to_b64(figure), str(tmp_path), asset_id)
        assert out["ok"] is True
        assert out["assetId"] == asset_id
        for part in PARTS:
            assert os.path.exists(tmp_path / asset_id / f"{part}.png")
            assert out["textures"][part] == f"/assets/gen/{asset_id}/{part}.png"
        assert set(out["fallbackColors"]) == {"skin", "hair", "torso", "legs"}

    def test_accepts_data_uri_prefix(self, figure, tmp_path):
        b64 = "data:image/png;base64," + to_b64(figure)
        out = slice_character(b64, str(tmp_path), "b" * 32)
        assert out["ok"] is True

    def test_written_files_are_valid_pngs_with_alpha(self, figure, tmp_path):
        asset_id = "c" * 32
        slice_character(to_b64(figure), str(tmp_path), asset_id)
        img = PILImage.open(tmp_path / asset_id / "head.png")
        assert img.mode == "RGBA"


class TestFullPngForGroupPhoto:
    """大合照在 Python 端合成，需要未切片的全身圖。

    只留三張切片的話，Python 就得依 CUTS 比例把它們疊回去 —— 等於把
    shared/avatars.js 的疊法在第二個語言再實作一次，正是本專案一再
    警告的跨語言耦合（對不上時角色會脖子錯位，兩邊都不會報錯）。
    """

    def test_full_png_is_written(self, tmp_path):
        res = slice_character(to_b64(make_figure()), str(tmp_path), "aid")
        assert (tmp_path / "aid" / "full.png").is_file()

    def test_full_png_url_is_returned(self, tmp_path):
        res = slice_character(to_b64(make_figure()), str(tmp_path), "aid")
        assert res["fullPng"] == "/assets/gen/aid/full.png"

    def test_full_png_is_not_a_slice(self, tmp_path):
        """全身圖必須比任一切片高，否則就是存錯了東西。"""
        slice_character(to_b64(make_figure()), str(tmp_path), "aid")
        d = tmp_path / "aid"
        full_h = PILImage.open(d / "full.png").height
        for part in PARTS:
            assert full_h > PILImage.open(d / f"{part}.png").height

    def test_full_png_keeps_transparency(self, tmp_path):
        """去背結果不能在存檔時被壓成不透明，否則合照會有白方塊。"""
        slice_character(to_b64(make_figure()), str(tmp_path), "aid")
        img = PILImage.open(tmp_path / "aid" / "full.png")
        assert img.mode == "RGBA"


class TestCrossLanguageContract:
    """Python 產出的 URL 必須通得過 shared/avatars.js 的驗證。

    這條測試存在的理由：兩邊的格式約定寫在不同語言的不同檔案裡，
    只要有一邊改了形狀，另一邊會在執行期才靜默拒絕角色入場。
    """

    def test_output_urls_match_js_validator_regex(self, figure, tmp_path):
        js = open(
            os.path.join(os.path.dirname(__file__), "..", "..", "shared", "avatars.js"),
            encoding="utf-8",
        ).read()
        m = re.search(r"const TEXTURE_URL_RE = /(.+?)/;", js)
        assert m, "shared/avatars.js 裡找不到 TEXTURE_URL_RE，介面可能已改名"
        pattern = re.compile(m.group(1).replace("\\/", "/"))

        out = slice_character(to_b64(figure), str(tmp_path), "d" * 32)
        for part in PARTS:
            assert pattern.match(out["textures"][part]), f"{part} 的 URL 通不過 JS 驗證"

    def test_cut_ratios_match_shared_avatars_js(self):
        """slicer.CUTS 與 shared/avatars.js 的 CV_CUTS 必須逐項相同。

        一邊切、一邊疊，比例對不上時角色會脖子錯位或腿被壓扁，
        而且兩邊都不會報錯 —— 只能靠這條測試擋下來。
        """
        js = open(
            os.path.join(os.path.dirname(__file__), "..", "..", "shared", "avatars.js"),
            encoding="utf-8",
        ).read()
        block = re.search(r"export const CV_CUTS = \{(.+?)\};", js, re.S)
        assert block, "shared/avatars.js 裡找不到 CV_CUTS，介面可能已改名"

        js_cuts = {
            m.group(1): (float(m.group(2)), float(m.group(3)))
            for m in re.finditer(
                r"(\w+):\s*\[([0-9.]+),\s*([0-9.]+)\]", block.group(1)
            )
        }
        assert js_cuts == {k: (v[0], v[1]) for k, v in CUTS.items()}

    def test_part_order_matches_shared_avatars_js(self):
        js = open(
            os.path.join(os.path.dirname(__file__), "..", "..", "shared", "avatars.js"),
            encoding="utf-8",
        ).read()
        m = re.search(r"export const CV_PARTS = \[(.+?)\];", js)
        assert m, "shared/avatars.js 裡找不到 CV_PARTS"
        assert re.findall(r"'(\w+)'", m.group(1)) == PARTS

    def test_output_colors_match_js_hex_regex(self, figure, tmp_path):
        out = slice_character(to_b64(figure), str(tmp_path), "e" * 32)
        for key, hex_value in out["fallbackColors"].items():
            assert re.match(r"^#[0-9a-fA-F]{6}$", hex_value), f"{key} 不是合法的 #RRGGBB"


def make_minifig(shoulder=0.30, waist=0.64, w=400, h=520):
    """已知肩線與腰線比例的積木人偶，背景透明。

    比 make_figure() 更貼近真實生成結果：手臂在肩線下方外展、上衣與褲子
    是兩種顏色、腰部沒有任何寬度變化 —— 最後這點正是初版偵測失手的地方。
    """
    a = np.zeros((h, w, 4), dtype=np.uint8)
    cx = w // 2

    def box(y0, y1, x0, x1, c):
        a[y0:y1, x0:x1] = (*c, 255)

    sh, wa = int(shoulder * h), int(waist * h)
    box(int(0.04 * h), int(0.08 * h), cx - 14, cx + 14, (230, 180, 130))
    box(int(0.08 * h), sh, cx - 58, cx + 58, (230, 180, 130))
    box(sh, wa, cx - 72, cx + 72, (40, 110, 180))
    box(sh + 6, wa - 20, cx - 118, cx - 72, (40, 110, 180))
    box(sh + 6, wa - 20, cx + 72, cx + 118, (40, 110, 180))
    box(wa, h - 8, cx - 66, cx - 6, (35, 35, 35))
    box(wa, h - 8, cx + 6, cx + 66, (35, 35, 35))
    return PILImage.fromarray(a, "RGBA")


class TestAnalyzeCuts:
    """初版兩條線都用寬度差分，在真實生成圖上量出肩線 0.184 / 腰線 0.816
    （實際約 0.30 / 0.64），會據此給出「需要偵測步驟」的錯誤結論。
    腰線在積木人偶上沒有幾何特徵 —— 軀幹與腿一樣寬 —— 它是顏色變化。
    """

    @pytest.mark.parametrize("shoulder,waist", [(0.30, 0.64), (0.26, 0.60), (0.34, 0.70)])
    def test_recovers_known_ratios(self, shoulder, waist):
        stats = analyze_cuts([make_minifig(shoulder, waist)])
        assert abs(stats["shoulder"]["mean"] - shoulder) < 0.04
        assert abs(stats["hip"]["mean"] - waist) < 0.04

    def test_waist_needs_colour_not_width(self):
        """軀幹與腿同寬時仍必須找得到腰線。"""
        stats = analyze_cuts([make_minifig()])
        assert stats["samples"] == 1
        assert 0.5 < stats["hip"]["mean"] < 0.8

    def test_reports_stable_ratios_for_identical_figures(self):
        stats = analyze_cuts([make_minifig() for _ in range(5)])
        assert stats["samples"] == 5
        assert stats["shoulder"]["std"] == 0.0, "同構圖的樣本標準差應為零"
        assert stats["hip"]["std"] == 0.0

    def test_detects_varying_ratios_as_spread(self):
        """構圖浮動時標準差必須反映出來，否則驗證工具會漏判。"""
        figs = [make_minifig(0.26, 0.58), make_minifig(0.30, 0.64), make_minifig(0.34, 0.70)]
        stats = analyze_cuts(figs)
        assert stats["shoulder"]["std"] > 0.02
        assert stats["hip"]["std"] > 0.02

    def test_handles_empty_input(self):
        assert analyze_cuts([])["samples"] == 0

    def test_ignores_fully_transparent_sample(self):
        blank = PILImage.new("RGBA", (50, 50), (0, 0, 0, 0))
        assert analyze_cuts([make_minifig(), blank])["samples"] >= 1
