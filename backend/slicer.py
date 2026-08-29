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

# 正規化後的固定高度。
#
# 原為 512，理由是「解析度只需夠用」。但那個判斷假設了角色在畫面上不會太大 ——
# 實測（2026-08-29）在 2560x1664 的 Retina 螢幕上，靠近相機的角色需要約
# 533 個實際像素，而 2D 角色圖層用的是完整 devicePixelRatio（不像 3D 場景
# 被限制在 1.5），因此 512 會被放大。
#
# 更關鍵的是下游：shared/avatarSprite.js 的畫布原本只有 260px，
# 貼圖到那裡會再被壓一次。兩道都是瓶頸，**必須一起提高才有效果**。
#
# AI 生成的人像本身約有 975px 高，設 1024 幾乎不浪費。
# 代價是每人四張貼圖約 50KB → 150KB，10 人上限 1.5MB，區網可負擔。
NORMALIZED_HEIGHT = 1024

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

# 判定「手臂已展開」的寬度門檻，相對於全身最大寬度。
SHOULDER_WIDTH_RATIO = 0.9

# 偵測腰線時取樣的中央橫向比例。取窄一點才不會把手臂與手掌的顏色算進來。
WAIST_BAND = (0.42, 0.58)

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
        parts[part].save(os.path.join(out_dir, f"{part}.webp"), "WEBP", quality=92)
        textures[part] = f"{url_prefix}/{asset_id}/{part}.webp"

    # 未切割的整張圖，另外落地一份。兩個消費者，同一張檔案：
    #
    # 大螢幕：切了又照同一組比例疊回去，構圖與原圖完全相同 —— 切片在這條路上
    #   是純成本，一張圖變三個請求、三次載入失敗風險，而且三張各自被拉伸到
    #   固定寬度，整體寬高比會被畫布比例壓掉（實測角色平均 0.642，
    #   畫布 200x260 = 0.769，橫向被拉伸約 20%）。
    #
    # 大合照：在 Python 端以 Pillow 無頭合成，拿不到瀏覽器那套疊圖邏輯。
    #   若只留三張切片，Python 就得依 CUTS 比例把它們重疊回去 —— 那等於把
    #   shared/avatars.js 的疊法在第二個語言再實作一次，正是本專案一再警告的
    #   跨語言耦合（對不上時角色會脖子錯位，兩邊都不會報錯）。
    #
    # 三張切片保留給之後要貼到 3D 部件、做肢體動作的用途，屆時各部位需要
    # 獨立變形，那才是切片真正的目的（見本檔開頭）。
    #
    # 格式與切片一致用 WEBP：現場是無線網路，30 人的貼圖差距很有感。
    img.save(os.path.join(out_dir, "full.webp"), "WEBP", quality=92)
    textures["full"] = f"{url_prefix}/{asset_id}/full.webp"

    # 高解析預覽圖：只給手機端「確認角色」那一頁，不進名冊、不進場上。
    #
    # 那一頁把角色放在 74vh 的直式框裡，手機 dpr=3 時顯示高度接近 2000 實際
    # 像素 —— 貼圖只有 1024，會被放大近兩倍而糊掉。而「數位轉譯成什麼樣子」
    # 正是這件作品的核心體驗（見 controller 的 btn-accept 註解），
    # 那一眼不該是全流程畫質最差的一眼。
    #
    # 刻意不共用 full.webp：兩者用途相反。貼圖要小（場上同時要畫十個、
    # 要進 STAGE_ROSTER、要吃現場無線網路），預覽要清楚（只有一張、只看一次、
    # 而且是本人在端詳自己）。把貼圖放大到預覽需要的尺寸，等於為了一頁的
    # 顯示去膨脹整條管線的記憶體與頻寬。
    #
    # 存原圖而非再縮一次：normalize() 之前的 decoded 就是模型輸出的最大尺寸
    # （實測人像高約 980px，部分模型回 1062px），已經比任何顯示需求都大。
    preview = decode_png(png_b64)
    preview.save(os.path.join(out_dir, "preview.webp"), "WEBP", quality=95)

    return {
        "ok": True,
        "assetId": asset_id,
        "textures": textures,
        "fallbackColors": colors,
        # fullPng 是 textures["full"] 的別名，保留給大合照那條既有呼叫端。
        # 名稱沿用歷史（實際上是 webp）—— 改名要同時動 service.py 的 /compose、
        # server 的名冊組裝與兩邊測試，不值得在這次合併一起做。
        "fullPng": textures["full"],
        # 只有手機端的確認頁會用它。名冊與大螢幕一律走 textures。
        "previewPng": f"{url_prefix}/{asset_id}/preview.webp",
    }


def _detect_waist(img: PILImage.Image, start: float) -> Optional[float]:
    """以顏色不連續找出上衣與褲子的交界，回傳佔全身高度的比例。

    只取中央窄帶：手臂與手掌的顏色與軀幹不同，納入會把訊號洗掉。
    搜尋範圍限制在肩線之下、腳踝之上，避免把「頭→衣領」或「褲子→鞋子」
    的交界誤判成腰線。
    """
    arr = np.asarray(img).astype(float)
    h, w = arr.shape[:2]
    x0, x1 = round(WAIST_BAND[0] * w), round(WAIST_BAND[1] * w)
    band = arr[:, x0:x1, :]

    opaque = band[:, :, 3] >= OPAQUE_ALPHA
    rows = []
    for y in range(h):
        sel = band[y][opaque[y]]
        rows.append(sel[:, :3].mean(axis=0) if len(sel) else np.array([np.nan] * 3))
    prof = np.array(rows)

    lo = max(1, int((start + 0.05) * h))
    hi = int(0.95 * h)
    if hi - lo < 3:
        return None

    diff = np.abs(np.diff(prof, axis=0)).sum(axis=1)[lo:hi]
    diff = np.nan_to_num(diff)
    if not np.isfinite(diff).any() or diff.max() == 0:
        return None
    return float(lo + int(np.argmax(diff)) + 1) / h


def analyze_cuts(images: List[PILImage.Image]) -> Dict[str, Any]:
    """量測一批樣本的部位比例是否穩定（整合計畫階段 2 的驗收工具）。

    對每張圖找出「肩線」與「胯線」的比例位置，回報平均與標準差。
    判準：標準差若在數個百分點以內，固定裁切框就夠用；
    明顯浮動才需要在管線裡加入偵測步驟。

    偵測方式分成兩種訊號，因為這兩條線的性質根本不同：

      肩線：手臂展開會讓寬度突增，這是幾何訊號。取「首次達到最大寬度九成」
            的那一列，比取寬度差分的極值穩健 —— 差分極值容易命中頭頂那圈
            比脖子寬的輪廓，而不是真正的肩線。

      腰線：**積木人偶的腰沒有幾何特徵**，軀幹與腿一樣寬，寬度剖面在腰部
            完全平坦。它是顏色變化（上衣→褲子）。因此改以中央窄帶的
            逐列顏色差異取極值。

    實測教訓：初版兩條線都用寬度差分，在真實生成圖上量出肩線 0.184、
    腰線 0.816（實際約 0.30 / 0.64），會據此得出「需要偵測步驟」的錯誤結論。
    """
    shoulders: List[float] = []
    hips: List[float] = []
    for img in images:
        # 單一張壞掉的樣本不該讓整批量測中斷 —— 驗證時常常是二十張裡有一兩張
        # 生成失敗或整張全透明，那時應該略過它並繼續，而不是整批作廢。
        try:
            norm = normalize(img)
        except ValueError:
            continue
        alpha = np.asarray(norm)[:, :, 3]
        widths = (alpha > 0).sum(axis=1).astype(float)
        h = len(widths)
        if h < 8 or widths.max() == 0:
            continue
        # 生成圖的邊緣有抗鋸齒與雜訊，逐列寬度會抖動；直接取 diff 的極值
        # 容易命中單列雜訊而不是真正的肩線。先做移動平均把剖面壓平。
        widths = _smooth(widths, SMOOTH_WINDOW)

        # 肩線：首次達到最大寬度九成的那一列（手臂展開處）
        wide = np.nonzero(widths >= widths.max() * SHOULDER_WIDTH_RATIO)[0]
        if len(wide) == 0:
            continue
        shoulders.append(float(wide[0]) / h)

        # 腰線：中央窄帶的顏色不連續處
        waist = _detect_waist(norm, start=wide[0] / h)
        if waist is None:
            continue
        hips.append(waist)

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
