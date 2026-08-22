"""cv_module 的純函式測試。

此模組 507 行、先前零測試。這裡涵蓋不需要 MediaPipe 模型檔的部分：
色彩轉換、縮放、以及格柵取樣的輸出契約與退化行為。
get_clothing_features 需要真實人像與 Pose 模型，屬 e2e 範疇，不在此。
"""
import unittest

import numpy as np

from backend.cv_module import _rgb_to_hex, _resize_if_needed, _sample_grid_with_mask


class TestRgbToHex(unittest.TestCase):
    def test_known_values(self):
        self.assertEqual(_rgb_to_hex((255, 0, 0)), "#FF0000")
        self.assertEqual(_rgb_to_hex((0, 0, 0)), "#000000")
        self.assertEqual(_rgb_to_hex((255, 255, 255)), "#FFFFFF")

    def test_pads_single_digit_components(self):
        """個位數必須補零，否則會產生長度錯誤的 hex（前端解析會壞掉）。"""
        self.assertEqual(_rgb_to_hex((1, 2, 3)), "#010203")

    def test_always_uppercase_and_seven_chars(self):
        for rgb in [(10, 20, 30), (200, 100, 50), (0, 128, 255)]:
            h = _rgb_to_hex(rgb)
            self.assertEqual(len(h), 7)
            self.assertEqual(h, h.upper())

    def test_accepts_numpy_integers(self):
        """K-Means 回傳的是 numpy 整數，不是 Python int。"""
        self.assertEqual(_rgb_to_hex(tuple(np.array([255, 128, 0], dtype=np.uint8))),
                         "#FF8000")


class TestResizeIfNeeded(unittest.TestCase):
    def test_no_resize_when_within_limit(self):
        img = np.zeros((100, 200, 3), dtype=np.uint8)
        out, scale = _resize_if_needed(img, max_width=480)
        self.assertEqual(scale, 1.0)
        self.assertIs(out, img, "未超過上限時不該複製影像")

    def test_downscales_and_reports_scale(self):
        img = np.zeros((600, 1200, 3), dtype=np.uint8)
        out, scale = _resize_if_needed(img, max_width=480)
        self.assertEqual(out.shape[1], 480)
        self.assertAlmostEqual(scale, 0.4, places=5)

    def test_preserves_aspect_ratio(self):
        img = np.zeros((300, 900, 3), dtype=np.uint8)
        out, _ = _resize_if_needed(img, max_width=300)
        self.assertAlmostEqual(out.shape[1] / out.shape[0], 3.0, places=1)

    def test_extreme_aspect_ratio_keeps_at_least_one_row(self):
        """極扁的影像縮放後高度不可變成 0，否則後續處理會直接崩潰。"""
        img = np.zeros((3, 4000, 3), dtype=np.uint8)
        out, _ = _resize_if_needed(img, max_width=100)
        self.assertGreaterEqual(out.shape[0], 1)

    def test_exact_boundary_is_not_resized(self):
        img = np.zeros((100, 480, 3), dtype=np.uint8)
        _, scale = _resize_if_needed(img, max_width=480)
        self.assertEqual(scale, 1.0)


class TestSampleGridWithMask(unittest.TestCase):
    """格柵取樣的輸出契約 —— 前端直接依這個結構渲染。"""

    def _solid(self, color=(200, 50, 50), size=(200, 200)):
        img = np.zeros((size[0], size[1], 3), dtype=np.uint8)
        img[:, :] = color
        return img

    def _full_poly(self):
        return np.array([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
                        dtype=np.float32)

    def test_output_shape_matches_requested_grid(self):
        out = _sample_grid_with_mask(self._solid(), self._full_poly(), 8, 10)
        self.assertEqual(out["cols"], 8)
        self.assertEqual(out["rows"], 10)
        self.assertEqual(len(out["cells"]), 80, "cells 數量必須等於 cols*rows")

    def test_every_cell_has_required_keys(self):
        out = _sample_grid_with_mask(self._solid(), self._full_poly(), 4, 4)
        for cell in out["cells"]:
            for k in ("r", "g", "b", "active"):
                self.assertIn(k, cell)
            for k in ("r", "g", "b"):
                self.assertTrue(0 <= cell[k] <= 255, f"{k}={cell[k]} 超出範圍")

    def test_degenerate_polygon_returns_inactive_grid(self):
        """輪廓退化（面積為 0）時要回傳完整但 inactive 的格柵，而非崩潰。"""
        degenerate = np.array([[0.5, 0.5]] * 4, dtype=np.float32)
        out = _sample_grid_with_mask(self._solid(), degenerate, 6, 6)
        self.assertEqual(len(out["cells"]), 36)
        self.assertTrue(all(not c["active"] for c in out["cells"]))

    def test_solid_colour_is_approximately_recovered(self):
        """整片同色時，取樣結果應接近該顏色（K-Means 會收斂到單一調色盤色）。"""
        out = _sample_grid_with_mask(self._solid((200, 50, 50)), self._full_poly(), 6, 6)
        active = [c for c in out["cells"] if c["active"]]
        self.assertTrue(active, "整片同色卻沒有任何 active 格")
        avg = [sum(c[k] for c in active) / len(active) for k in ("r", "g", "b")]
        # 影像為 BGR，取樣輸出為 RGB，此處只驗證「有一個明顯主導的通道」
        self.assertGreater(max(avg), 100, f"取樣顏色過暗: {avg}")

    def test_grid_of_one_cell(self):
        out = _sample_grid_with_mask(self._solid(), self._full_poly(), 1, 1)
        self.assertEqual(len(out["cells"]), 1)


if __name__ == "__main__":
    unittest.main()
