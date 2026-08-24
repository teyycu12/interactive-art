"""大合照的座標排版與資產路徑解析測試。

整合版與 2D 備援版走同一支 compose_group_photo，但排版來源不同：
備援版沒有場上座標，走原本的階梯式重排；整合版帶座標，必須依實際位置
畫 —— 這件作品要記錄的是集體共創的當下樣貌，重排隊形會把訊息抹掉。
兩條路徑都要保住，因此以「有沒有帶座標」自動分流。
"""

import io
import os

import numpy as np
import pytest
from PIL import Image as I

from backend.photo_composer import (
    _has_positions,
    _layout_by_position,
    compose_group_photo,
)


def char(x=None, y=None, **kw):
    c = {"outfit": {"inner_color": "#3366CC", "lower_color": "#222222"},
         "face": {"skin_tone": "#F4C08A", "hair_color": "#4A2C1A"}}
    if x is not None:
        c["x"] = x
    if y is not None:
        c["y"] = y
    c.update(kw)
    return c


class TestPositionDetection:
    """分流判斷：帶座標走實際位置，不帶走階梯式。"""

    def test_no_positions_for_fallback_roster(self):
        assert _has_positions([char(), char()]) is False

    def test_detects_positions(self):
        assert _has_positions([char(100, 200)]) is True

    def test_partial_positions_still_counts(self):
        """只要有一個帶座標就走座標排版，缺的用場域中心補。"""
        assert _has_positions([char(), char(100, 200)]) is True

    def test_ignores_non_numeric(self):
        assert _has_positions([{"x": "100", "y": "200"}]) is False


class TestLayoutByPosition:
    def _canvas(self):
        return I.new("RGBA", (1920, 1080), (0, 0, 0, 255))

    def _drawn_columns(self, canvas):
        """回傳有畫到東西的 x 範圍（找非背景像素）。"""
        arr = np.asarray(canvas)[:, :, :3]
        cols = np.nonzero(arr.any(axis=(0, 2)))[0]
        return cols

    def test_left_and_right_land_on_different_sides(self):
        """場域左側的角色要畫在畫布左半，右側畫在右半。"""
        canvas = self._canvas()
        _layout_by_position(canvas, [char(100, 540)], 1920, 1080, 810)
        left = self._drawn_columns(canvas)

        canvas2 = self._canvas()
        _layout_by_position(canvas2, [char(1820, 540)], 1920, 1080, 810)
        right = self._drawn_columns(canvas2)

        assert left.mean() < 960 < right.mean()

    def test_near_character_is_drawn_larger(self):
        """y 越大代表越靠近觀眾，角色要畫得越大（景深）。"""
        far = self._canvas()
        _layout_by_position(far, [char(960, 50)], 1920, 1080, 810)
        near = self._canvas()
        _layout_by_position(near, [char(960, 1030)], 1920, 1080, 810)

        far_px = (np.asarray(far)[:, :, :3].any(axis=2)).sum()
        near_px = (np.asarray(near)[:, :, :3].any(axis=2)).sum()
        assert near_px > far_px

    def test_edge_characters_stay_inside_canvas(self):
        """貼著場域邊界的角色不能被裁掉 —— 邊距就是為此存在。"""
        canvas = self._canvas()
        _layout_by_position(canvas, [char(0, 0), char(1920, 1080)], 1920, 1080, 810)
        cols = self._drawn_columns(canvas)
        assert cols.min() > 0
        assert cols.max() < 1919

    def test_nearest_character_is_not_clipped_by_floor(self):
        """回歸點：baseline 曾被當成身體中心，最前排的腿會掉到地平線下被裁掉。"""
        canvas = self._canvas()
        _layout_by_position(canvas, [char(960, 1080)], 1920, 1080, 810)
        arr = np.asarray(canvas)[:, :, :3]
        rows = np.nonzero(arr.any(axis=(1, 2)))[0]
        assert rows.max() < 1079, "角色不可被畫布下緣裁掉"

    def test_farthest_character_does_not_hit_the_title_bar(self):
        """最遠的角色頭頂不可頂進頂部橫幅（高 90px）。"""
        canvas = self._canvas()
        _layout_by_position(canvas, [char(960, 0)], 1920, 1080, 810)
        arr = np.asarray(canvas)[:, :, :3]
        rows = np.nonzero(arr.any(axis=(1, 2)))[0]
        assert rows.min() > 90

    def test_empty_list_does_not_raise(self):
        _layout_by_position(self._canvas(), [], 1920, 1080, 810)


class TestComposeWithPositions:
    def test_position_roster_composes(self):
        res = compose_group_photo(
            [char(300, 200), char(1500, 900)], photo_url_base="http://x/p")
        assert res["ok"] is True
        assert res["character_count"] == 2
        assert res["photo_b64"].startswith("data:image/png;base64,")

    def test_fallback_roster_still_composes(self):
        """2D 備援版不帶座標，階梯式排版不能因為這次改動壞掉。"""
        res = compose_group_photo([char(), char()], photo_url_base="http://x/p")
        assert res["ok"] is True
        assert res["character_count"] == 2

    def test_mixed_cv_and_builder_guests(self):
        """生成失敗退回捏臉的賓客沒有 body_path，必須仍能同框。"""
        res = compose_group_photo(
            [char(300, 200, body_path=None), char(1500, 900)],
            photo_url_base="http://x/p")
        assert res["ok"] is True
        assert res["character_count"] == 2
