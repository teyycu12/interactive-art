"""Pure helpers for capture-zone guidance and temporal stability.

The capture gate intentionally uses broad body zones instead of requiring every
MediaPipe foot landmark to have high confidence. Heel/toe visibility frequently
dips even when both feet are clearly in frame, which used to make capture almost
impossible on a live webcam.
"""

from __future__ import annotations

import math
import os
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from backend.height_profiles import classify_height, get_height_thresholds  # type: ignore
except Exception:
    from height_profiles import classify_height, get_height_thresholds  # type: ignore


# Kept for height calibration. The frontend now draws a human-shaped guide rather
# than this rectangle, but the installation's calibrated vertical span is stable.
GUIDE = {"left": 0.15, "right": 0.85, "top": 0.05, "bottom": 0.95}

# Stable joints are enough for temporal motion checks. Heel/toe points are noisy
# and should not reset an otherwise steady visitor.
STABILITY_LANDMARKS = (11, 12, 23, 24, 25, 26, 27, 28)
REQUIRED_LANDMARKS = STABILITY_LANDMARKS  # backwards-compatible public name
CORE_LANDMARKS = (11, 12, 23, 24, 25, 26)
FOOT_GROUPS: Tuple[Tuple[int, ...], ...] = ((27, 29, 31), (28, 30, 32))


def _value(lm: Any, name: str, default: float = 0.0) -> float:
    if isinstance(lm, dict):
        return float(lm.get(name, default))
    return float(getattr(lm, name, default))


def _visibility(lm: Any) -> float:
    return _value(lm, "visibility", _value(lm, "v", 1.0))


def _mean_xy(lm: List[Any], indices: Iterable[int]) -> Tuple[float, float]:
    points = [lm[index] for index in indices]
    return (
        sum(_value(point, "x") for point in points) / len(points),
        sum(_value(point, "y") for point in points) / len(points),
    )


def mean_landmark_displacement(
    current: Iterable[Any], previous: Optional[Iterable[Any]], indices: Iterable[int] = STABILITY_LANDMARKS
) -> Optional[float]:
    if previous is None:
        return None
    curr, prev = list(current), list(previous)
    if len(curr) != len(prev):
        return None
    distances: List[float] = []
    for idx in indices:
        if idx >= len(curr):
            continue
        dx = _value(curr[idx], "x") - _value(prev[idx], "x")
        dy = _value(curr[idx], "y") - _value(prev[idx], "y")
        distances.append(math.hypot(dx, dy))
    return sum(distances) / len(distances) if distances else None


def _result(reason: str, score: float, **details: Any) -> Dict[str, Any]:
    return {
        "raw_ready": False,
        "score": round(max(0.0, min(1.0, score)), 3),
        "guidance_reason": reason,
        **details,
    }


def assess_capture_quality(
    landmarks: Iterable[Any],
    *,
    person_bbox: Optional[Dict[str, float]] = None,
    core_visibility_min: float = 0.35,
    foot_visibility_min: float = 0.20,
) -> Dict[str, Any]:
    """Assess whether a detected body broadly matches the human capture guide.

    This is deliberately tolerant of body proportions and visitor height. It
    checks visible core joints, one reliable point per foot, anatomical ordering,
    central torso placement, and true image-edge clipping. It does *not* require
    all ankle/heel/toe landmarks to exceed one strict threshold.
    """

    lm = list(landmarks)
    if len(lm) < 33:
        return _result("pose_incomplete", 0.0)

    core_visibilities = [_visibility(lm[index]) for index in CORE_LANDMARKS]
    core_min = min(core_visibilities)
    if core_min < core_visibility_min:
        joint_names = {
            11: "left_shoulder", 12: "right_shoulder",
            23: "left_hip", 24: "right_hip",
            25: "left_knee", 26: "right_knee",
        }
        low_joints = [joint_names[index] for index in CORE_LANDMARKS if _visibility(lm[index]) < core_visibility_min]
        return _result(
            "pose_incomplete",
            core_min / core_visibility_min * 0.55,
            min_visibility=round(core_min, 3),
            low_visibility_joints=low_joints,
            capture_checks={"pose": False, "feet": False, "framing": False, "height": False},
        )

    foot_visibilities = [max(_visibility(lm[index]) for index in group) for group in FOOT_GROUPS]
    if min(foot_visibilities) < foot_visibility_min:
        missing_sides = [side for side, value in zip(("left", "right"), foot_visibilities) if value < foot_visibility_min]
        return _result(
            "show_feet",
            0.58,
            min_visibility=round(core_min, 3),
            foot_visibility=[round(value, 3) for value in foot_visibilities],
            missing_foot_sides=missing_sides,
            capture_checks={"pose": True, "feet": False, "framing": False, "height": False},
        )

    shoulders = _mean_xy(lm, (11, 12))
    hips = _mean_xy(lm, (23, 24))
    knees = _mean_xy(lm, (25, 26))
    ankles = _mean_xy(lm, (27, 28))
    torso_x = (shoulders[0] + hips[0]) / 2.0

    # Reject actual image clipping, not contact with the old orange guide. A few
    # percent of edge tolerance prevents segmentation speckles causing failures.
    reliable_points = [lm[index] for index in STABILITY_LANDMARKS]
    point_xs = [_value(point, "x") for point in reliable_points]
    point_ys = [_value(point, "y") for point in reliable_points]
    # Segmentation often includes floor shadows at the image edge. Treat it only
    # as supporting evidence and block capture when pose landmarks are also near
    # that edge.
    clipped_edges: List[str] = []
    if min(point_xs) < 0.015:
        clipped_edges.append("left")
    if max(point_xs) > 0.985:
        clipped_edges.append("right")
    if max(point_ys) > 0.985:
        clipped_edges.append("bottom")
    if person_bbox and person_bbox["y1"] <= 0.003 and _value(lm[0], "y") < 0.02:
        clipped_edges.append("top")
    if clipped_edges:
        return _result(
            "body_clipped",
            0.62,
            min_visibility=round(core_min, 3),
            foot_visibility=[round(value, 3) for value in foot_visibilities],
            clipped_edges=clipped_edges,
            capture_checks={"pose": True, "feet": True, "framing": False, "height": False},
        )

    # The on-screen markers are references, not a pose template. Do not require
    # joints to match fixed x/y zones or force the torso into the exact centre.
    # Only reject a person who is so small that clothing features are unusable.
    body_span = ankles[1] - shoulders[1]

    if body_span < 0.24:
        return _result(
            "move_closer",
            0.68,
            min_visibility=round(core_min, 3),
            foot_visibility=[round(value, 3) for value in foot_visibilities],
            capture_checks={"pose": True, "feet": True, "framing": False, "height": False},
        )

    # Guard only against a clearly invalid landmark ordering. Normal variations
    # in stance, height, arm position and knee position remain acceptable.
    if not (shoulders[1] + 0.03 < hips[1] and hips[1] + 0.05 < ankles[1]):
        return _result(
            "pose_incomplete",
            0.72,
            min_visibility=round(core_min, 3),
            foot_visibility=[round(value, 3) for value in foot_visibilities],
            torso_center_x=round(torso_x, 3),
            pose_issue="invalid_vertical_order",
            capture_checks={"pose": False, "feet": True, "framing": True, "height": False},
        )

    left_foot_y = max(_value(lm[index], "y") for index in FOOT_GROUPS[0])
    right_foot_y = max(_value(lm[index], "y") for index in FOOT_GROUPS[1])
    height_info = height_metadata(person_bbox, foot_y=(left_foot_y + right_foot_y) / 2.0)
    if not height_info["height_measurement_valid"]:
        return _result(
            "align_height_baseline",
            0.82,
            min_visibility=round(core_min, 3),
            foot_visibility=[round(value, 3) for value in foot_visibilities],
            foot_baseline=height_info.get("foot_baseline"),
            foot_baseline_offset=height_info.get("foot_baseline_offset"),
            capture_checks={"pose": True, "feet": True, "framing": True, "height": False},
        )

    # Segmentation is supporting evidence only. It may miss shoes or hair, so its
    # bounding box is no longer required to fit an artificial inner rectangle.
    return {
        "raw_ready": True,
        "score": 1.0,
        "guidance_reason": "hold_still",
        "min_visibility": round(core_min, 3),
        "foot_visibility": [round(value, 3) for value in foot_visibilities],
        "torso_center_x": round(torso_x, 3),
        "guide_match": None,
        "capture_checks": {"pose": True, "feet": True, "framing": True, "height": True},
    }


def height_metadata(person_bbox: Optional[Dict[str, float]], foot_y: Optional[float] = None) -> Dict[str, Any]:
    """Return fixed-station visual height metadata.

    A monocular camera cannot separate real height from camera distance. The
    measurement is therefore trusted only when the visitor's feet are near the
    calibrated screen baseline, which must correspond to a physical floor mark.
    """

    if not person_bbox:
        return {
            "height_ratio": None,
            "height_class": None,
            "height_station_valid": False,
            "height_head_valid": False,
            "height_measurement_valid": False,
            "height_method": "fixed_station_segmentation",
        }
    guide_height = GUIDE["bottom"] - GUIDE["top"]
    baseline = float(os.environ.get("CAPTURE_FOOT_BASELINE", "0.970"))
    tolerance = max(0.02, float(os.environ.get("CAPTURE_FOOT_BASELINE_TOLERANCE", "0.10")))
    # Shoe segmentation and foot landmarks fail in different ways. Choose the
    # candidate closest to the calibrated floor line instead of permanently
    # trusting one source. This stays tolerant when the mask trims the shoes,
    # while still requiring the visitor to stand near the physical floor mark.
    foot_candidates = [("segmentation", float(person_bbox["y2"]))]
    if foot_y is not None:
        foot_candidates.append(("pose", float(foot_y)))
    foot_source, measured_foot_y = min(foot_candidates, key=lambda item: abs(item[1] - baseline))
    baseline_offset = abs(measured_foot_y - baseline) if measured_foot_y is not None else None
    station_valid = baseline_offset is not None and baseline_offset <= tolerance
    # A clipped head makes the pixel height unusable even if the feet happen to
    # align with the floor marker. Keep a small margin for mask noise.
    head_clearance = float(person_bbox["y1"])
    head_valid = 0.006 < head_clearance < 0.45
    measurement_valid = station_valid and head_valid
    # Once feet are accepted at the fixed floor marker, calculate height from
    # that calibrated baseline rather than the noisy observed mask bottom.
    ratio = max(0.0, baseline - head_clearance) / guide_height
    short_max, tall_min = get_height_thresholds()
    return {
        "height_ratio": round(ratio, 4),
        "height_class": classify_height(ratio) if measurement_valid else None,
        "height_station_valid": station_valid,
        "height_head_valid": head_valid,
        "height_measurement_valid": measurement_valid,
        "height_method": "fixed_station_segmentation",
        "height_thresholds": {"short_max": short_max, "tall_min": tall_min},
        "height_head_y": round(head_clearance, 4),
        "height_foot_source": foot_source,
        "height_station_tolerance": round(tolerance, 4),
        "foot_baseline": round(baseline, 4),
        "measured_foot_y": round(measured_foot_y, 4) if measured_foot_y is not None else None,
        "foot_baseline_offset": round(baseline_offset, 4) if baseline_offset is not None else None,
    }


# ── 清晰度 ────────────────────────────────────────────────────────────────
#
# 拍攝檢查原本只驗「姿勢與框位」，完全沒有驗清晰度：一張手震的照片會通過
# 每一項檢查，然後生出一個模糊的角色 —— 參與者等了 25 秒、也付了一次生圖
# 費用，才看到結果不能用。在拍攝當下擋下來，比任何 prompt 調整都有效。
#
# 量測放在臉部而不是整張圖：背景雜亂會把整張圖的變異數推高，把手震蓋過去，
# 而臉正是模糊最傷的地方（見 GENERATION.md「進模型的臉只有 85 像素」）。

# Laplacian 變異數會隨取樣尺寸大幅變動（同一張臉在 288px 與 60px 下相差
# 一個數量級），所以先正規化到固定邊長再算，否則門檻換一支手機就失效。
SHARPNESS_NORM_PX = 192
# 實測值：清晰約 700，輕微模糊（高斯 k=3）約 225，嚴重模糊（k=9）低於 30。
# 門檻取 60 —— 明顯低於任何可用的照片，只擋真正糊掉的那些。
SHARPNESS_MIN = 60.0


def face_sharpness(bgr: Any, face_region: Optional[Dict[str, float]]) -> Optional[float]:
    """臉部區域的 Laplacian 變異數，正規化到固定尺寸。

    回傳 None 代表「量不到」（沒有臉框、裁切為空、OpenCV 不可用），
    呼叫端必須把它當成「未量測」而不是「不合格」—— 量不到就擋人，
    等於把降級路徑變成死路。
    """
    if bgr is None or not face_region:
        return None
    try:
        import cv2 as _cv2
        import numpy as _np

        height, width = bgr.shape[:2]
        x1 = max(0, min(width - 1, int(float(face_region.get("x1", 0.0)) * width)))
        y1 = max(0, min(height - 1, int(float(face_region.get("y1", 0.0)) * height)))
        x2 = max(x1 + 1, min(width, int(float(face_region.get("x2", 1.0)) * width)))
        y2 = max(y1 + 1, min(height, int(float(face_region.get("y2", 1.0)) * height)))
        crop = bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        norm = _cv2.resize(crop, (SHARPNESS_NORM_PX, SHARPNESS_NORM_PX), interpolation=_cv2.INTER_AREA)
        grey = _cv2.cvtColor(norm, _cv2.COLOR_BGR2GRAY) if norm.ndim == 3 else norm
        return float(_np.asarray(_cv2.Laplacian(grey, _cv2.CV_64F)).var())
    except Exception:
        return None


def sharpness_verdict(score: Optional[float], minimum: float = SHARPNESS_MIN) -> Dict[str, Any]:
    """把清晰度分數翻成可以直接併進 capture_quality 的欄位。"""
    if score is None:
        return {"sharpness": None, "sharpness_ok": True}
    return {
        "sharpness": round(score, 1),
        "sharpness_ok": score >= minimum,
        "sharpness_min": minimum,
    }
