import glob
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2

from backend.capture_quality import (
    SHARPNESS_MIN, assess_capture_quality, face_sharpness, height_metadata,
    mean_landmark_displacement, sharpness_verdict,
)
from backend.height_profiles import classify_height, get_height_profile


def _landmarks(visibility=1.0):
    points = [{"x": 0.5, "y": 0.5, "visibility": visibility} for _ in range(33)]
    for left, right, y, spread in (
        (11, 12, 0.25, 0.12),
        (23, 24, 0.50, 0.08),
        (25, 26, 0.70, 0.07),
        (27, 28, 0.90, 0.06),
        (29, 30, 0.91, 0.06),
        (31, 32, 0.92, 0.07),
    ):
        points[left].update({"x": 0.5 - spread, "y": y})
        points[right].update({"x": 0.5 + spread, "y": y})
    return points


class CaptureQualityTests(unittest.TestCase):
    def test_complete_person_inside_guide_is_raw_ready(self):
        result = assess_capture_quality(
            _landmarks(),
            person_bbox={"x1": 0.25, "y1": 0.10, "x2": 0.75, "y2": 0.96},
        )
        self.assertTrue(result["raw_ready"])
        self.assertEqual(result["guidance_reason"], "hold_still")

    def test_one_low_toe_does_not_block_visible_foot(self):
        low = _landmarks()
        low[31]["visibility"] = 0.05
        result = assess_capture_quality(low, person_bbox={"x1": 0.2, "y1": 0.08, "x2": 0.8, "y2": 0.96})
        self.assertTrue(result["raw_ready"])

    def test_missing_foot_group_and_true_clipping_are_rejected(self):
        missing = _landmarks()
        for index in (28, 30, 32):
            missing[index]["visibility"] = 0.1
        self.assertEqual(assess_capture_quality(missing)["guidance_reason"], "show_feet")

        outside = _landmarks()
        outside[28]["y"] = 0.99
        self.assertEqual(assess_capture_quality(outside)["guidance_reason"], "body_clipped")

    def test_segmentation_can_extend_beyond_old_inner_rectangle(self):
        result = assess_capture_quality(
            _landmarks(),
            person_bbox={"x1": 0.08, "y1": 0.02, "x2": 0.92, "y2": 0.96},
        )
        self.assertTrue(result["raw_ready"])

    def test_off_center_torso_does_not_have_to_match_reference_markers(self):
        off_center = _landmarks()
        for index in (11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32):
            off_center[index]["x"] -= 0.25
        self.assertTrue(assess_capture_quality(
            off_center, person_bbox={"x1": 0.02, "y1": 0.08, "x2": 0.55, "y2": 0.96}
        )["raw_ready"])

    def test_person_no_longer_has_to_match_fixed_vertical_guide_zones(self):
        shorter_in_frame = _landmarks()
        for index in (11, 12):
            shorter_in_frame[index]["y"] = 0.38
        for index in (23, 24):
            shorter_in_frame[index]["y"] = 0.55
        for index in (25, 26):
            shorter_in_frame[index]["y"] = 0.66
        for index in (27, 28, 29, 30, 31, 32):
            shorter_in_frame[index]["y"] = 0.92
        self.assertTrue(assess_capture_quality(
            shorter_in_frame, person_bbox={"x1": 0.25, "y1": 0.18, "x2": 0.75, "y2": 0.96}
        )["raw_ready"])

    def test_height_baseline_is_required_before_capture(self):
        away_from_baseline = _landmarks()
        for index in (27, 28, 29, 30, 31, 32):
            away_from_baseline[index]["y"] = 0.82
        result = assess_capture_quality(away_from_baseline)
        self.assertFalse(result["raw_ready"])
        self.assertEqual(result["guidance_reason"], "align_height_baseline")

    def test_small_live_foot_jitter_is_accepted_for_height_station(self):
        info = height_metadata(
            {"x1": 0.2, "x2": 0.8, "y1": 0.10, "y2": 0.94},
            foot_y=0.95,
        )
        self.assertTrue(info["height_station_valid"])
        self.assertTrue(info["height_measurement_valid"])
        self.assertLessEqual(info["foot_baseline_offset"], info["height_station_tolerance"])

    def test_landmark_displacement_is_session_input_driven(self):
        first = _landmarks()
        second = _landmarks()
        for idx in (11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32):
            second[idx]["x"] += 0.01
        self.assertAlmostEqual(mean_landmark_displacement(second, first), 0.01, places=6)
        self.assertIsNone(mean_landmark_displacement(first, None))

    def test_height_boundaries_and_profiles(self):
        with patch.dict(os.environ, {"HEIGHT_SHORT_MAX_RATIO": "0.72", "HEIGHT_TALL_MIN_RATIO": "0.84"}):
            self.assertEqual(classify_height(0.7199), "short")
            self.assertEqual(classify_height(0.72), "medium")
            self.assertEqual(classify_height(0.84), "medium")
            self.assertEqual(classify_height(0.8401), "tall")
            self.assertIsNone(height_metadata({"x1": 0.2, "x2": 0.8, "y1": 0.14, "y2": 0.86})["height_class"])
            valid = height_metadata(
                {"x1": 0.2, "x2": 0.8, "y1": 0.24, "y2": 0.96},
                foot_y=0.955,
            )
            self.assertTrue(valid["height_measurement_valid"])
            self.assertEqual(valid["height_class"], "medium")
            invalid = height_metadata(
                {"x1": 0.2, "x2": 0.8, "y1": 0.14, "y2": 0.86},
                foot_y=0.80,
            )
            self.assertFalse(invalid["height_measurement_valid"])
            self.assertIsNone(invalid["height_class"])
        self.assertEqual(get_height_profile("short")["display_scale"], 0.90)
        self.assertEqual(get_height_profile("unknown")["id"], "medium")


if __name__ == "__main__":
    unittest.main()


class TestFaceSharpness(unittest.TestCase):
    """清晰度量測。門檻的意義完全取決於正規化，兩者要一起驗。"""

    @staticmethod
    def _photo():
        paths = sorted(glob.glob(str(Path(__file__).resolve().parents[1] / "photos" / "*.png")))
        if not paths:
            raise unittest.SkipTest("沒有樣本照片可用")
        return cv2.imread(paths[0])

    REGION = {"x1": 0.30, "y1": 0.05, "x2": 0.70, "y2": 0.30}

    def test_sharp_photo_scores_far_above_the_threshold(self):
        score = face_sharpness(self._photo(), self.REGION)
        self.assertIsNotNone(score)
        self.assertGreater(score, SHARPNESS_MIN * 3)

    def test_heavy_blur_falls_below_the_threshold(self):
        blurred = cv2.GaussianBlur(self._photo(), (9, 9), 0)
        score = face_sharpness(blurred, self.REGION)
        self.assertIsNotNone(score)
        self.assertLess(score, SHARPNESS_MIN)

    def test_score_is_normalised_against_crop_size(self):
        """不正規化的話，同一張臉在不同解析度下差一個數量級，門檻換支手機就失效。"""
        photo = self._photo()
        big = face_sharpness(photo, self.REGION)
        small = face_sharpness(cv2.resize(photo, (photo.shape[1] // 3, photo.shape[0] // 3)), self.REGION)
        self.assertIsNotNone(big)
        self.assertIsNotNone(small)
        self.assertTrue(0.5 < small / big < 2.0, f"{small} vs {big}")

    def test_unmeasurable_input_returns_none_rather_than_failing(self):
        self.assertIsNone(face_sharpness(None, self.REGION))
        self.assertIsNone(face_sharpness(self._photo(), None))

    def test_verdict_treats_unmeasured_as_passing(self):
        """量不到就擋人，等於把降級路徑變成死路。"""
        self.assertTrue(sharpness_verdict(None)["sharpness_ok"])
        self.assertFalse(sharpness_verdict(SHARPNESS_MIN - 1)["sharpness_ok"])
        self.assertTrue(sharpness_verdict(SHARPNESS_MIN + 1)["sharpness_ok"])
