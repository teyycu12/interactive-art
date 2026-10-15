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


BACKGROUND_LEFT_RATIO = 0.70


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
    max_aspect: Optional[float] = None,
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
    # 去背只灌得進「連到畫面邊界的白」。模型若畫了方格紙、地板或任何非白底，
    # 白色就被切成一格格封閉區塊，整片背景連同人偶被當成同一塊前景留下來，
    # 角色會頂著一張方格紙上大螢幕。實測抓到過（2026-10-14，像素風格）：
    # 那張的佔比 0.81，剛好擦過上面 0.85 的上限，其餘檢查全數通過。
    # 三種風格 17 張正常輸出最高 0.57，門檻放在兩者中間。
    if foreground_ratio > BACKGROUND_LEFT_RATIO:
        result["errors"].append("background_left")

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

    # 只量最大的那一塊：旁邊一小塊雜點不該讓正常的人偶被判太寬（那是
    # fragmented_foreground 的事）。多畫的那個人是跟本體連在一起的，
    # 所以照樣算在最大那塊裡。
    if max_aspect is not None and labels_n > 1:
        main = int(np.argmax(stats[1:, cv2.CC_STAT_AREA])) + 1
        aspect = stats[main, cv2.CC_STAT_WIDTH] / float(stats[main, cv2.CC_STAT_HEIGHT])
        result["aspect"] = round(float(aspect), 4)
        if aspect > max_aspect:
            result["errors"].append("too_wide")
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
    if "background_left" in errors:
        instructions.append(
            "The background must be one flat solid pure white (#FFFFFF) and nothing else: "
            "no grid lines, no graph paper, no checkerboard, no floor, no shadow, no scenery."
        )
    if "too_wide" in errors:
        # 多半是多畫了一個人，或兩個視圖黏在一起。
        #
        # 措辭刻意不說「只畫一個人」：目前只有像素風格設了 max_aspect，而它的
        # prompt 要的正是「正、側、背三個人一排」，量的是切出來的正面那一格。
        # 叫它「只畫一個、旁邊不要有側面背面」等於跟原 prompt 打架 —— 模型要嘛交出
        # 設計稿式的格線框線（_PIXEL_NEGATIVE 註解裡那張），要嘛丟掉側面背面，
        # 付費重生多半再失敗一次。改講「每個人各自分開」，單人與多視圖風格都成立。
        instructions.append(
            "Every figure is one single person standing alone, separated from any other "
            "figure by clear pure-white space: figures must never touch, overlap or merge, "
            "and never add an extra person. Keep both arms close to the body."
        )
    if "fragmented_foreground" in errors:
        # 措辭刻意不提任何風格：這段會被接到當次生成的 prompt 後面，
        # 而那份 prompt 可能是樂高，也可能是皮克斯。
        #
        # 這個錯誤有兩種成因，修正指令必須同時涵蓋：
        #   1. 角色本身破碎（浮空的手腳）
        #   2. **模型交出了多視圖角色設定表** —— 正面大圖＋側面＋背面各自
        #      是一個獨立連通區塊，最大那個因此佔不到 75%。實測抓到過
        #      （2026-08-29）：圖其實畫得很好，只是畫了四個。
        # 少了第二句，重試會再交出一張一模一樣的四視圖。
        instructions.append(
            "Keep every limb physically attached to one coherent figure; no floating pieces. "
            "Draw EXACTLY ONE figure: no turnaround sheet, no side or back view panels, "
            "no duplicate copies of the character anywhere in the image."
        )
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
    if "too_wide" in errors:
        return "生成時多畫了東西，請直接再送出一次。"
    if "background_left" in errors:
        # 這是模型畫錯，不是照片的問題 —— 不要叫參與者換一張照片。
        return "生成的角色背景沒有去乾淨，請直接再送出一次。"
    if "decode_failed" in errors:
        return "生成圖片格式異常，請重新送出一次。"
    if "foreground_ratio" in errors:
        return "生成角色的構圖比例異常；請使用人物完整、背景較單純的全身照片。"
    if "touches_border" in errors:
        return "生成角色仍被裁到畫面邊緣；請使用四周留有空間的全身照片。"
    return "生成結果未通過角色完整性檢查，請換一張完整全身照片再試。"
