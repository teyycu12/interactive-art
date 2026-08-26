"""Rule-based generated-sprite validation with no additional AI calls."""

from __future__ import annotations

import base64
import io
from typing import Any, Dict, Optional

import cv2
import numpy as np
from PIL import Image


def add_transparent_margin(png_b64: Optional[str], margin_ratio: float = 0.04) -> Optional[str]:
    """Add deterministic transparent space around a generated sprite.

    Image models often leave one or two antialiased pixels on the canvas edge.
    That is a layout issue we can repair locally and should not trigger another
    paid generation request.
    """
    if not png_b64:
        return png_b64
    try:
        raw = base64.b64decode(png_b64)
        image = Image.open(io.BytesIO(raw)).convert("RGBA")
        margin = max(2, int(max(image.size) * max(0.0, margin_ratio)))
        canvas = Image.new("RGBA", (image.width + margin * 2, image.height + margin * 2), (0, 0, 0, 0))
        canvas.paste(image, (margin, margin), image)
        output = io.BytesIO()
        canvas.save(output, "PNG")
        return base64.b64encode(output.getvalue()).decode("ascii")
    except Exception:
        return png_b64


def _lab_delta(a: np.ndarray, rgb: Optional[list]) -> Optional[float]:
    if rgb is None or len(rgb) != 3 or a.size == 0:
        return None
    med = np.median(a.reshape(-1, 3), axis=0).astype(np.uint8)
    pair = np.uint8([[med.tolist(), [int(v) for v in rgb]]])
    lab = cv2.cvtColor(pair, cv2.COLOR_RGB2LAB)[0].astype(float)
    return float(np.linalg.norm(lab[0] - lab[1]))


def validate_avatar_png(
    png_b64: Optional[str],
    *,
    upper_rgb: Optional[list] = None,
    lower_rgb: Optional[list] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {"passed": False, "errors": [], "warnings": []}
    if not png_b64:
        result["errors"].append("missing_image")
        return result
    try:
        raw = base64.b64decode(png_b64)
        arr = np.array(Image.open(io.BytesIO(raw)).convert("RGBA"))
    except Exception:
        result["errors"].append("decode_failed")
        return result

    h, w = arr.shape[:2]
    alpha = arr[:, :, 3]
    fg = alpha > 5
    fg_count = int(fg.sum())
    if fg_count == 0:
        result["errors"].append("empty_foreground")
        return result

    foreground_ratio = fg_count / float(h * w)
    result["foreground_ratio"] = round(foreground_ratio, 4)
    if not 0.05 <= foreground_ratio <= 0.85:
        result["errors"].append("foreground_ratio")

    border = np.concatenate((fg[:2, :].ravel(), fg[-2:, :].ravel(), fg[:, :2].ravel(), fg[:, -2:].ravel()))
    if border.any():
        result["errors"].append("touches_border")

    labels_n, labels, stats, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), 8)
    if labels_n > 1:
        main_area = int(stats[1:, cv2.CC_STAT_AREA].max())
        main_ratio = main_area / float(fg_count)
    else:
        main_ratio = 0.0
    result["main_component_ratio"] = round(main_ratio, 4)
    if main_ratio < 0.75:
        result["errors"].append("fragmented_foreground")

    lower = fg[int(h * 0.75) :, :]
    left_ratio = float(lower[:, : w // 2].sum()) / fg_count
    right_ratio = float(lower[:, w // 2 :].sum()) / fg_count
    result["bottom_left_ratio"] = round(left_ratio, 4)
    result["bottom_right_ratio"] = round(right_ratio, 4)
    if left_ratio < 0.01:
        result["errors"].append("missing_bottom_left")
    if right_ratio < 0.01:
        result["errors"].append("missing_bottom_right")

    rgb_arr = arr[:, :, :3]
    top_mask = fg[int(h * 0.30) : int(h * 0.60)]
    top_rgb = rgb_arr[int(h * 0.30) : int(h * 0.60)][top_mask]
    low_mask = fg[int(h * 0.60) : int(h * 0.90)]
    low_rgb = rgb_arr[int(h * 0.60) : int(h * 0.90)][low_mask]
    upper_delta = _lab_delta(top_rgb, upper_rgb)
    lower_delta = _lab_delta(low_rgb, lower_rgb)
    result["color_delta"] = {
        "upper": round(upper_delta, 2) if upper_delta is not None else None,
        "lower": round(lower_delta, 2) if lower_delta is not None else None,
    }
    if upper_delta is not None and upper_delta > 55:
        result["warnings"].append("upper_color_drift")
    if lower_delta is not None and lower_delta > 55:
        result["warnings"].append("lower_color_drift")

    result["errors"] = list(dict.fromkeys(result["errors"]))
    result["passed"] = not result["errors"]
    return result


def correction_for_validation(validation: Dict[str, Any]) -> str:
    errors = set(validation.get("errors") or [])
    instructions = ["Regenerate the same character while preserving the detected appearance."]
    if {"missing_bottom_left", "missing_bottom_right"} & errors:
        instructions.append("Both separate legs and both distinct shoes must be fully visible at the bottom.")
    if "touches_border" in errors or "foreground_ratio" in errors:
        instructions.append("Center the entire character with generous pure-white margin on every side.")
    if "fragmented_foreground" in errors:
        # 措辭刻意不提任何風格：這段會被接到當次生成的 prompt 後面，
        # 而那份 prompt 可能是樂高，也可能是皮克斯。
        instructions.append("Keep every limb physically attached to one coherent figure; no floating pieces.")
    return " ".join(instructions)


def guidance_for_validation(validation: Dict[str, Any]) -> str:
    """Return a concise user-facing retake reason for hard failures."""
    errors = set(validation.get("errors") or [])
    if not errors:
        return ""
    if {"missing_bottom_left", "missing_bottom_right"} & errors:
        return "生成角色缺少一側腿部或鞋子；請上傳雙腿、雙腳完整且沒有遮擋的全身照片。"
    if "fragmented_foreground" in errors:
        return "生成角色的肢體出現分離；請上傳人物輪廓清楚、手腳未被遮擋的照片。"
    if "empty_foreground" in errors or "missing_image" in errors:
        return "生圖服務沒有產生可用角色，請重新上傳照片再試一次。"
    if "decode_failed" in errors:
        return "生成圖片格式異常，請重新送出一次。"
    if "foreground_ratio" in errors:
        return "生成角色的構圖比例異常；請使用人物完整、背景較單純的全身照片。"
    if "touches_border" in errors:
        return "生成角色仍被裁到畫面邊緣；請使用四周留有空間的全身照片。"
    return "生成結果未通過角色完整性檢查，請換一張完整全身照片再試。"
