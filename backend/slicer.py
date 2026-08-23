"""角色貼圖切片：把生成的去背人偶全身圖切成 head / torso / legs 三張。

整合計畫階段 2。輸入是 `garment_gen` 產出的去背 PNG（正面直立、全身），
輸出是契約 4 規定的三張貼圖與四個取樣色。

為什麼要先正規化再切：
    生圖的構圖雖然穩定，仍會有幾個 pixel 的浮動。直接對原圖套固定比例
    裁切框，構圖只要偏一點就會切歪（頭頂被削掉、腿被切進軀幹）。
    先裁到 alpha 邊界再縮放到固定高度，等於把每張圖對齊到同一個座標系，
    之後的固定比例才會穩定命中同樣的部位。

⚠ 下方的 CUTS 比例是依積木人偶的標準身形訂的初始值，尚未以實際生成結果
    驗證過。整合計畫階段 2 要求拿約 20 張樣本跑 `analyze_cuts()`，
    確認各部位是否穩定落在同一比例位置；若浮動明顯，才需要加入偵測步驟。
"""

from __future__ import annotations

import base64
import io
import os
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image as PILImage

# 正規化後的固定高度。貼圖最終會貼到 3D 模型上，解析度只需夠用；
# 過大只是讓名冊載入變慢與 draw call 的貼圖記憶體上升。
NORMALIZED_HEIGHT = 512

# 各部位在正規化後的垂直比例區間（含頭髮 / 含手臂 / 含腳）。
CUTS: Dict[str, Tuple[float, float]] = {
    "head": (0.00, 0.30),
    "torso": (0.30, 0.64),
    "legs": (0.64, 1.00),
}

PARTS: List[str] = ["head", "torso", "legs"]

# 量測寬度剖面時的移動平均視窗（列）。太小壓不掉抗鋸齒雜訊，
# 太大會把肩線這種真實的階變也一起抹平。
SMOOTH_WINDOW = 9

# 判定為「不透明」的 alpha 門檻。garment_gen 的去背會在邊界留 2px 半透明
# 柔化環，取樣顏色時要把那一圈排除，否則會把背景色混進取樣結果。
OPAQUE_ALPHA = 200


def _smooth(values: np.ndarray, window: int) -> np.ndarray:
    """對一維剖面做移動平均，邊緣以端點值延伸避免縮短長度。"""
    if window < 2 or len(values) < window:
        return values
    pad = window // 2
    padded = np.pad(values, pad, mode="edge")
    kernel = np.ones(window) / window
    return np.convolve(padded, kernel, mode="valid")[: len(values)]


def decode_png(png_b64: str) -> PILImage.Image:
    """把 base64 PNG 解成 RGBA 影像。接受帶或不帶 data URI 前綴。"""
    if "," in png_b64[:64]:
        png_b64 = png_b64.split(",", 1)[1]
    raw = base64.b64decode(png_b64)
    return PILImage.open(io.BytesIO(raw)).convert("RGBA")


def alpha_bbox(img: PILImage.Image) -> Optional[Tuple[int, int, int, int]]:
    """回傳不透明像素的緊緻外框 (x0, y0, x1, y1)；全透明時回傳 None。"""
    alpha = np.asarray(img)[:, :, 3]
    ys, xs = np.nonzero(alpha > 0)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def normalize(img: PILImage.Image, height: int = NORMALIZED_HEIGHT) -> PILImage.Image:
    """裁到 alpha 邊界並等比縮放到固定高度。

    這一步是整條管線可靠度的來源，見模組開頭說明。
    """
    box = alpha_bbox(img)
    if box is None:
        raise ValueError("影像完全透明，沒有可切的人偶")
    cropped = img.crop(box)
    w, h = cropped.size
    scale = height / h
    return cropped.resize((max(1, round(w * scale)), height), PILImage.LANCZOS)


def slice_parts(img: PILImage.Image) -> Dict[str, PILImage.Image]:
    """依 CUTS 的比例把正規化後的影像切成三塊。"""
    w, h = img.size
    out: Dict[str, PILImage.Image] = {}
    for part, (top, bottom) in CUTS.items():
        y0 = round(top * h)
        y1 = round(bottom * h)
        out[part] = img.crop((0, y0, w, y1))
    return out


def _median_color(img: PILImage.Image, region: Optional[Tuple[float, float, float, float]] = None) -> str:
    """取區域內不透明像素的中位數顏色。

    用中位數而非平均：平均會把互補色調成灰泥色（例如紅衣加藍褲得到濁紫），
    中位數則會落在實際存在的主色附近。
    """
    arr = np.asarray(img)
    if region is not None:
        h, w = arr.shape[:2]
        x0, y0, x1, y1 = region
        arr = arr[round(y0 * h):round(y1 * h), round(x0 * w):round(x1 * w)]
    flat = arr.reshape(-1, 4)
    opaque = flat[flat[:, 3] >= OPAQUE_ALPHA]
    if len(opaque) == 0:
        opaque = flat[flat[:, 3] > 0]
    if len(opaque) == 0:
        return "#808080"
    r, g, b = (int(np.median(opaque[:, i])) for i in range(3))
    return f"#{r:02X}{g:02X}{b:02X}"


def sample_fallback_colors(parts: Dict[str, PILImage.Image]) -> Dict[str, str]:
    """由正面取樣四個代表色，供背面 / 側面填補與貼圖載入前的替身使用。

    取樣區域刻意避開邊緣：
      hair 取頭部最上緣的橫帶，skin 取頭部中段（臉），
      torso 與 legs 取各自的中央區塊，避開手臂與雙腿之間的鏤空。
    """
    return {
        "hair": _median_color(parts["head"], (0.25, 0.00, 0.75, 0.25)),
        "skin": _median_color(parts["head"], (0.30, 0.45, 0.70, 0.85)),
        "torso": _median_color(parts["torso"], (0.30, 0.20, 0.70, 0.80)),
        "legs": _median_color(parts["legs"], (0.25, 0.10, 0.75, 0.70)),
    }


def slice_character(
    png_b64: str,
    asset_dir: str,
    asset_id: str,
    url_prefix: str = "/assets/gen",
) -> Dict[str, Any]:
    """完整流程：解碼 → 正規化 → 切片 → 落地 → 回傳契約 4 的 JSON。

    貼圖以檔案 URL 傳遞而非 base64：30 人的貼圖若內嵌進 STAGE_ROSTER，
    名冊訊息會膨脹到現場無線網路難以負荷（契約 4）。
    """
    img = normalize(decode_png(png_b64))
    parts = slice_parts(img)
    colors = sample_fallback_colors(parts)

    out_dir = os.path.join(asset_dir, asset_id)
    os.makedirs(out_dir, exist_ok=True)
    textures: Dict[str, str] = {}
    for part in PARTS:
        parts[part].save(os.path.join(out_dir, f"{part}.png"), "PNG", optimize=True)
        textures[part] = f"{url_prefix}/{asset_id}/{part}.png"

    return {"ok": True, "assetId": asset_id, "textures": textures, "fallbackColors": colors}


def analyze_cuts(images: List[PILImage.Image]) -> Dict[str, Any]:
    """量測一批樣本的部位比例是否穩定（整合計畫階段 2 的驗收工具）。

    對每張圖找出「肩線」與「胯線」的比例位置，回報平均與標準差。
    判準：標準差若在數個百分點以內，固定裁切框就夠用；
    明顯浮動才需要在管線裡加入偵測步驟。

    偵測方式：正規化後逐列統計不透明像素寬度。積木人偶的寬度剖面有兩個
    明顯特徵 —— 肩線處寬度突增（手臂展開），胯線處出現中央鏤空使寬度回落。
    """
    shoulders: List[float] = []
    hips: List[float] = []
    for img in images:
        norm = normalize(img)
        alpha = np.asarray(norm)[:, :, 3]
        widths = (alpha > 0).sum(axis=1).astype(float)
        h = len(widths)
        if h < 8 or widths.max() == 0:
            continue
        # 生成圖的邊緣有抗鋸齒與雜訊，逐列寬度會抖動；直接取 diff 的極值
        # 容易命中單列雜訊而不是真正的肩線。先做移動平均把剖面壓平。
        widths = _smooth(widths, SMOOTH_WINDOW)
        # 肩線：上半部寬度增幅最大的一列
        upper = widths[: h // 2]
        shoulders.append(float(np.argmax(np.diff(upper)) + 1) / h)
        # 胯線：下半部寬度減幅最大的一列（雙腿分岔造成的中央鏤空）
        lower = widths[h // 2:]
        hips.append(float(np.argmin(np.diff(lower)) + 1 + h // 2) / h)

    def stat(v: List[float]) -> Dict[str, float]:
        if not v:
            return {"mean": 0.0, "std": 0.0, "min": 0.0, "max": 0.0}
        a = np.array(v)
        return {
            "mean": round(float(a.mean()), 4),
            "std": round(float(a.std()), 4),
            "min": round(float(a.min()), 4),
            "max": round(float(a.max()), 4),
        }

    return {
        "samples": len(shoulders),
        "shoulder": stat(shoulders),
        "hip": stat(hips),
        # 逐張的原始量測值，供 validate_cuts.py 列出離群的樣本
        "shoulders": [round(v, 4) for v in shoulders],
        "hips": [round(v, 4) for v in hips],
    }
