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
import json
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


# 衣服取色時，離膚色這麼近（RGB 歐氏距離）的像素當作皮膚、不算衣服。
# 放寬到 70：手腳通常比臉亮一階（打光），48 會把露出的小腿當成衣服
SKIN_TOLERANCE = 70
# 排除皮膚後剩下的像素少於這個比例，就當作那一塊本來就是皮膚（短褲露腿、無袖）
MIN_CLOTH_SHARE = 0.08

# ── 身上的衣服顏色清單（outfitColors，2026-11-04）──
# torso / legs 各一個代表色，對穿外套、戴圍巾的人不夠：牛仔外套＋米色大圍巾＋灰上衣，
# 不管取哪一個都漏掉其他的，「身上有藍色的人」就找不到他（試玩回饋）。
# 賓果與顏色任務問的是「身上有沒有這個顏色」，所以另外記一份清單：上身與下身各自
# 佔衣服面積 OUTFIT_MIN_SHARE 以上的顏色，最多 OUTFIT_MAX 個。判定看清單（shared/colorFamily.js）。
OUTFIT_TORSO_AREA = (0.15, 0.45, 0.85, 1.0)   # 下巴以下、兩手之間
OUTFIT_LEGS_AREA = (0.20, 0.10, 0.80, 0.70)   # 腰到小腿
# 中間這幾欄沒有手臂：只排除幾乎等於膚色的（接近膚色的衣服留得住）；兩側照舊排得寬
OUTFIT_CORE_X = (0.30, 0.70)
OUTFIT_MIN_SHARE = 0.22
OUTFIT_PER_PART = 2
OUTFIT_MAX = 4
# 兩個顏色離這麼近就當同一個（陰影、亮面不另算一色）
OUTFIT_MERGE = 40


def _outfit_pixels(img: PILImage.Image, region: Tuple[float, float, float, float], skin: str) -> np.ndarray:
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = region
    c0, r0 = round(x0 * w), round(y0 * h)
    sub = arr[r0:round(y1 * h), c0:round(x1 * w)]
    xs = (np.arange(sub.shape[1]) + c0) / w
    core = ((xs >= OUTFIT_CORE_X[0]) & (xs < OUTFIT_CORE_X[1]))[None, :]
    rgb = sub[..., :3].astype(int)
    dist = np.linalg.norm(rgb - np.array(_hex_rgb(skin)), axis=2)
    keep = (sub[..., 3] >= OPAQUE_ALPHA) & np.where(core, dist > SAFE_SKIN_TOLERANCE, dist > SKIN_TOLERANCE)
    return rgb[keep]


# 有彩色：HSV 飽和度與亮度都超過這個值。以下是黑白灰，全部算同一群
OUTFIT_CHROMA_S = 0.18
OUTFIT_CHROMA_V = 0.15
# 同一件衣服的亮面與陰影色相差不多，明度差很多：以色相分群，視窗寬 ±OUTFIT_HUE_SPAN 度
OUTFIT_HUE_SPAN = 25


def _main_colors(rgb: np.ndarray, k: int) -> List[str]:
    """一群像素裡面積夠大的幾個顏色，大的在前。

    以**色相**分群，不以 RGB 距離：像素風的衣服是好幾階明暗畫出來的，牛仔外套的亮面、
    陰影、縫線 RGB 差了 50 以上，按距離分會拆成五小塊、每塊都不到門檻 —— 合起來其實是
    整件衣服裡面積最大的（試玩：只判出圍巾的米色，漏掉藍色外套）。黑白灰另成一群。
    """
    if not len(rgb):
        return []
    f = rgb.astype(float) / 255.0
    mx, mn = f.max(axis=1), f.min(axis=1)
    d = mx - mn
    sat = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    safe = np.maximum(d, 1e-6)
    r, g, b = f[:, 0], f[:, 1], f[:, 2]
    hue = np.where(mx == r, ((g - b) / safe) % 6, np.where(mx == g, (b - r) / safe + 2, (r - g) / safe + 4)) * 60
    chroma = (sat >= OUTFIT_CHROMA_S) & (mx >= OUTFIT_CHROMA_V)
    total = len(rgb)
    left = np.ones(total, dtype=bool)
    out: List[str] = []
    while len(out) < k:
        groups = []
        mono = left & ~chroma
        if mono.any():
            groups.append(mono)
        ch = left & chroma
        if ch.any():
            hist, _ = np.histogram(hue[ch], bins=36, range=(0, 360))
            peak = (np.argmax(hist) + 0.5) * 10
            diff = np.abs((hue - peak + 180) % 360 - 180)
            groups.append(ch & (diff <= OUTFIT_HUE_SPAN))
        if not groups:
            break
        best = max(groups, key=lambda m: m.sum())
        if best.sum() < total * OUTFIT_MIN_SHARE:
            break
        if best is groups[0] and mono.any():
            out.append(_dominant_hex(rgb[best]))   # 黑白灰：取最多的那一個（白襯衫配黑褲不要混成灰）
        else:
            # 有彩色：取中位數。「最多的那一階」常常是陰影（牛仔外套最暗那階 #2B3B4B 已經看不出是藍）
            r, g, b = (int(np.median(rgb[best][:, i])) for i in range(3))
            out.append(f"#{r:02X}{g:02X}{b:02X}")
        left &= ~best
    return out


def sample_outfit_colors(parts: Dict[str, PILImage.Image], skin: str) -> List[str]:
    """身上的衣服顏色清單（見 OUTFIT_TORSO_AREA 的說明）。取不到就是空的，判定退回 torso / legs。"""
    out: List[str] = []
    for part, area in (("torso", OUTFIT_TORSO_AREA), ("legs", OUTFIT_LEGS_AREA)):
        px = _outfit_pixels(parts[part], area, skin)
        if len(px) < 30:
            continue
        for c in _main_colors(px, OUTFIT_PER_PART):
            if all(np.linalg.norm(np.array(_hex_rgb(c)) - np.array(_hex_rgb(o))) > OUTFIT_MERGE for o in out):
                out.append(c)
    return out[:OUTFIT_MAX]


# 「一定是衣服」的區塊（各自切片內的比例 x0, y0, x1, y1），先在這裡取色（2026-11-04）。
#
# 只靠顏色排除皮膚，會把接近膚色的衣服一起排掉：SKIN_TOLERANCE 放寬到 70 是為了排掉
# 比臉亮一階的手腳，但淺膚色配白上衣（距離 65）、一般膚色配橘上衣（66）也落在 70 以內 ——
# 整件衣服被當成皮膚，剩下陰影與輪廓線，白上衣判成橘、橘上衣判成紅。
# 改成先看位置：上身切片的中間偏下一條是胸口到腰（手臂在兩側、下巴與脖子在上半），
# 下身切片的上中段是腰到大腿（上衣下擺在最上面、短褲與裙子露出的腿在下面）。
# 這兩塊裡幾乎沒有皮膚，只排除跟膚色幾乎一樣的（SAFE_SKIN_TOLERANCE），接近膚色的衣服就留得住。
# 取不到（角色比例特別、那一塊是空的或全是皮膚）才退回原本整塊排除膚色的取法。
TORSO_SAFE = (0.40, 0.58, 0.60, 0.95)
LEGS_SAFE = (0.30, 0.25, 0.70, 0.55)
SAFE_SKIN_TOLERANCE = 25
# 安全區塊裡排除皮膚後至少要剩這麼多，不然就是那一塊其實是皮膚（無袖、超短褲）
SAFE_MIN_CLOTH_SHARE = 0.35


def _hex_rgb(hex_str: str) -> Tuple[int, int, int]:
    n = int(hex_str[1:], 16)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255


def _dominant_hex(rgb: np.ndarray) -> str:
    """一群像素裡最主要的顏色：量化成 16 階找出最多的那一格，再取那一格附近（含跨格的
    相鄰色）所有像素的中位數。只取格子的平均會被量化邊界切歪 —— #F4C08A 的綠色剛好在
    192 這條邊界上，縮放後一半像素掉到隔壁格。"""
    keys = (rgb // 16) @ np.array([256, 16, 1])
    values, counts = np.unique(keys, return_counts=True)
    center = rgb[keys == values[np.argmax(counts)]].mean(axis=0)
    near = rgb[np.linalg.norm(rgb - center, axis=1) <= 28]
    r, g, b = (int(np.median(near[:, i])) for i in range(3))
    return f"#{r:02X}{g:02X}{b:02X}"


def _clothing_color(img: PILImage.Image, region: Tuple[float, float, float, float], skin: str) -> str:
    """衣服的代表色：排除膚色後，取出現最多的顏色。

    不能直接取中位數：生成的角色是大頭 Q 版（約 2.2 頭身），CUTS 的「上身」那一塊
    有將近一半是下巴與脖子 —— 中位數會落在膚色上，白襯衫被判成「橘黃」，賓果與
    顏色任務因此出錯（2026-10-19 試玩）。CUTS 是跨語言耦合、改了會動到渲染，
    所以修在取色這一步：先排除皮膚，再取「最多的那個顏色」（_dominant_hex），
    不被釦子、陰影、口袋線拉偏。
    """
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = region
    arr = arr[round(y0 * h):round(y1 * h), round(x0 * w):round(x1 * w)]
    flat = arr.reshape(-1, 4)
    opaque = flat[flat[:, 3] >= OPAQUE_ALPHA][:, :3].astype(int)
    if len(opaque) == 0:
        return _median_color(img, region)
    skin_rgb = np.array(_hex_rgb(skin))
    cloth = opaque[np.linalg.norm(opaque - skin_rgb, axis=1) > SKIN_TOLERANCE]
    if len(cloth) < len(opaque) * MIN_CLOTH_SHARE:
        return _median_color(img, region)
    return _dominant_hex(cloth)


# 代表色的取樣範圍（各自切片內的比例 x0, y0, x1, y1）。比 OUTFIT_*_AREA 窄：
# 切片比例是固定的（CUTS），身材比例卻每個人不同 —— 上身那一塊的下緣常切到褲頭與裙子、
# 兩側切到黑色長髮，下身那一塊的上緣常切到外套下擺。淺色上衣配黑褲的人，整塊算會變成
# 黑色最多（試算 120 個拍照角色時的回歸），所以只看中間、下緣停在褲頭之前。
# 下身不用這個取法：穿短褲的人，比臉亮一階的小腿在中間只排除「幾乎等於膚色」的那一套下
# 會被當成衣服（試算時短褲的人下身變成紅、橘），而下身原本的取法本來就很少錯
REP_TORSO_AREA = (0.25, 0.50, 0.75, 0.85)
# 範圍裡排除皮膚後，衣服至少要佔不透明像素的這個比例，才用「面積最大的那一群」
# 當代表色；不到就是那一塊大多是皮膚（無袖、短褲），退回下面的取法
AREA_MIN_CLOTH_SHARE = 0.35


def _area_clothing_color(img: PILImage.Image, region: Tuple[float, float, float, float], skin: str) -> Optional[str]:
    """上衣的代表色：上身中間排除皮膚後，面積最大的那一群顏色（2026-11-11）。

    原本先看胸口正中間一條（TORSO_SAFE），但那一條正好是內搭露出來的地方 ——
    學士服的白領、西裝裡的襯衫、敞開外套裡的上衣。最近 24 個拍照角色有 10 件黑袍
    被判成白色、西裝判成淺藍。人看衣服顏色看的是整件最大片的那個顏色，所以改成
    整塊一起算（範圍見 REP_TORSO_AREA），以色相分群（同一件的亮面與陰影合起來，
    見 _main_colors）。
    皮膚的排除跟 outfitColors 同一套（中間排得窄、兩側排得寬），淺膚色配白上衣仍留得住。
    """
    px = _outfit_pixels(img, region, skin)
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = region
    opaque = int((arr[round(y0 * h):round(y1 * h), round(x0 * w):round(x1 * w), 3] >= OPAQUE_ALPHA).sum())
    if len(px) < 30 or len(px) < opaque * AREA_MIN_CLOTH_SHARE:
        return None
    found = _main_colors(px, 1)
    return found[0] if found else None


def _safe_clothing_color(img: PILImage.Image, region: Tuple[float, float, float, float], skin: str) -> Optional[str]:
    """在「一定是衣服」的區塊取色（見 TORSO_SAFE 的說明）；那一塊不像衣服時回 None。"""
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = region
    arr = arr[round(y0 * h):round(y1 * h), round(x0 * w):round(x1 * w)]
    flat = arr.reshape(-1, 4)
    opaque = flat[flat[:, 3] >= OPAQUE_ALPHA][:, :3].astype(int)
    if len(opaque) < 30:
        return None
    cloth = opaque[np.linalg.norm(opaque - np.array(_hex_rgb(skin)), axis=1) > SAFE_SKIN_TOLERANCE]
    if len(cloth) < len(opaque) * SAFE_MIN_CLOTH_SHARE:
        return None
    return _dominant_hex(cloth)


def _skin_color(head: PILImage.Image, torso: PILImage.Image) -> str:
    """膚色：頭部與上身裡「像皮膚的顏色」出現最多的那個。

    原本取頭部中段的中位數，但大頭 Q 版的那一塊常常是瀏海、眼睛或鏡框 ——
    實測取到 #464241、#141517 這種深色，衣服取色時就排除不到皮膚（2026-10-19）。
    像皮膚的定義很寬（暖色相、不太暗不太亮；像素風的膚色很飽和，#F4C08A 的飽和度就有 0.83，
    只排除純橘這種極飽和的），再取眾數。先只看頭部 —— 上身那塊若是橘色上衣，會被當成皮膚；
    頭部找不到才加上身。都沒有（例如綠皮膚的怪物裝）才退回原本的中位數。
    """
    def skinlike(img):
        a = np.asarray(img).reshape(-1, 4)
        rgb = a[a[:, 3] >= OPAQUE_ALPHA][:, :3].astype(int)
        if not len(rgb):
            return rgb
        mx, mn = rgb.max(axis=1), rgb.min(axis=1)
        light = (mx + mn) / 510.0
        d = (mx - mn) / 255.0
        sat = np.where(d == 0, 0, d / np.maximum(1e-6, 1 - np.abs(2 * light - 1)))
        r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
        # 皮膚：紅 > 綠 > 藍（暖色、色相約 0–50°）
        return rgb[(r > g) & (g >= b) & (sat > 0.15) & (sat < 0.95) & (light > 0.3) & (light < 0.9)]

    cand = skinlike(head)
    if len(cand) < 20:
        cand = np.concatenate([cand, skinlike(torso)])
    if len(cand) >= 20:
        return _dominant_hex(cand)
    return _median_color(head, (0.30, 0.45, 0.70, 0.85))


def sample_fallback_colors(parts: Dict[str, PILImage.Image]) -> Dict[str, str]:
    """由正面取樣四個代表色，供背面 / 側面填補、貼圖載入前的替身，以及顏色判定
    （賓果「衣服有紅色的人」、顏色任務，shared/colorFamily.js）使用。

    取樣區域刻意避開邊緣：
      hair 取頭部最上緣的橫帶，skin 取頭部中段（臉），
      torso 取上身中間排除皮膚後面積最大的那一群（_area_clothing_color）；
      legs（以及 torso 那一塊大多是皮膚時）取「一定是衣服」的區塊（TORSO_SAFE / LEGS_SAFE），
      再不行才是各自的中央區塊、排除膚色後取最多的顏色（見 _clothing_color）。
    """
    skin = _skin_color(parts["head"], parts["torso"])
    return {
        "hair": _median_color(parts["head"], (0.25, 0.00, 0.75, 0.25)),
        "skin": skin,
        "torso": _area_clothing_color(parts["torso"], REP_TORSO_AREA, skin)
        or _safe_clothing_color(parts["torso"], TORSO_SAFE, skin)
        or _clothing_color(parts["torso"], (0.30, 0.10, 0.70, 0.95), skin),
        "legs": _safe_clothing_color(parts["legs"], LEGS_SAFE, skin)
        or _clothing_color(parts["legs"], (0.25, 0.10, 0.75, 0.70), skin),
    }


# 三視圖切出來的另外兩面（backend/turnaround.py）
VIEW_PARTS = ("side", "back")


def save_view(
    png_b64: str,
    asset_dir: str,
    asset_id: str,
    part: str,
    url_prefix: str = "/assets/gen",
) -> str:
    """把側面或背面存成 <asset_id>/<part>.webp，回傳 URL。

    與正面的 full.webp 走同一個 normalize()：三張都縮到同一個高度，
    大螢幕以同一套「等比縮放、底部對齊」畫進同尺寸的畫布 —— 換面時
    角色不會忽大忽小、腳底不會跳。不切片：切片只為正面存在。
    """
    if part not in VIEW_PARTS:
        raise ValueError(f"unknown view part: {part}")
    img = normalize(decode_png(png_b64))
    out_dir = os.path.join(asset_dir, asset_id)
    os.makedirs(out_dir, exist_ok=True)
    img.save(os.path.join(out_dir, f"{part}.webp"), "WEBP", quality=92)
    return f"{url_prefix}/{asset_id}/{part}.webp"


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
    outfit = sample_outfit_colors(parts, colors["skin"])

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

    # 顏色落地一份：這組顏色原本只存在於這一次的 HTTP 回應裡，事後要把角色
    # 匯出或放回場上（人物匯入台、character_export）就得從貼圖重新取樣。
    # 格式與 scripts/asset_colors.py 寫的 colors.json 相同。
    try:
        with open(os.path.join(out_dir, "colors.json"), "w", encoding="utf-8") as f:
            json.dump({**colors, "outfit": outfit}, f, ensure_ascii=False)
    except OSError:
        pass  # 只是少一份快取，匯出時會重新取樣；不該讓已經生成好的角色失敗

    return {
        "ok": True,
        "assetId": asset_id,
        "textures": textures,
        "fallbackColors": colors,
        # 身上的衣服顏色清單：賓果與顏色任務的判定依據（shared/colorFamily.js）
        "outfitColors": outfit,
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
