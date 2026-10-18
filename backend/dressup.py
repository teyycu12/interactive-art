"""素體換裝：不叫生圖 API，用預先畫好的部件在本機組出一個像素角色。

生圖 API 整個不能用的時候（額度用完、上游掛掉）的退路。拍照仍然可以進場：
本機辨識出的髮色、膚色、衣褲顏色套到素體上，參與者再自己換髮型、衣服、配件。
組出來的是一張與模型輸出同規格的三視圖（正面｜右側｜背面，1376×768，白底），
後面的切圖、走路、大合照全部照舊 —— 場上不會混進另一種角色。

部件從哪來（docs/style_reference/2026q3_pixel_curated/dressup/）：
  manifest.json   部件清單：分類、名稱、生成時的描述
  raw/<id>.png    生圖模型在素體上「只加這一樣、塗成綠色」的整張三視圖
  layers/         build_layers() 從 raw 切出來的圖層（執行時只讀這裡）

切法：raw 與素體幾乎逐格相同（實測位移約 4px、半格），對齊後跟素體比，
變了的格子就是這個部件帶來的。綠色的格子之後換成參與者選的顏色；
其餘變了的格子照原本的樣子分類 —— 裙子底下露出的腿是素體的膚色，
就記成「皮膚」，組的時候跟著參與者的膚色換。

加新造型：manifest 加一筆 → scripts/dressup_generate.py <id> → 看過 →
scripts/dressup_build.py。程式不必改。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
from PIL import Image

try:
    from backend.turnaround import find_figures  # type: ignore
except Exception:  # pragma: no cover - 直接以 backend/ 為工作目錄時
    from turnaround import find_figures  # type: ignore

DRESSUP_DIR = Path(__file__).resolve().parents[1] / "docs" / "style_reference" / "2026q3_pixel_curated" / "dressup"
MANIFEST_PATH = DRESSUP_DIR / "manifest.json"
RAW_DIR = DRESSUP_DIR / "raw"
LAYER_DIR = DRESSUP_DIR / "layers"

# 與生圖模型輸出的三視圖同尺寸：組好的圖直接走同一條後處理（turnaround.split_turnaround）
CANVAS = (1376, 768)

# 圖層裡每一格是什麼（layers/<id>_mask.png 的值）
L_NONE, L_PART, L_SKIN, L_HAIR, L_ERASE, L_FIXED = 0, 1, 2, 3, 4, 5

# 換色時每一格歸誰管（組圖時的分類圖）。配件從 ACC0 開始依序編號
C_FIXED, C_SKIN, C_HAIR, C_TOP, C_OUTER, C_BOTTOM, C_SHOES, C_BG = 0, 1, 2, 3, 4, 5, 6, 7
C_ACC0 = 10
CATEGORY_CODE = {"hair": C_HAIR, "top": C_TOP, "outer": C_OUTER, "bottom": C_BOTTOM, "shoes": C_SHOES}

# 綠色占位色：生成時要求部件只用這個色系畫（manifest 的 edit_prompt）
KEY_GREEN_MARGIN = 40           # 綠比紅、藍都多這麼多才算占位綠
KEY_GREEN_REF = (24, 180, 24)   # 占位綠的中間調：換色時對應到參與者選的顏色本身

# 素體各部位的中間調（量自 pose_turnaround.png 出現最多的顏色）。換色時這個亮度對應到選的顏色
BASE_REF = {
    C_SKIN: (212, 147, 107),
    C_HAIR: (66, 43, 35),
    C_TOP: (205, 206, 210),
    C_BOTTOM: (135, 135, 137),
    C_SHOES: (75, 76, 80),
}

# 亮部往白收多少。1 = 照原本的亮度比例收到白：深色（黑髮、黑裙）的亮部會變成一條條
# 灰白帶，看起來像褪色（2026-10-18 組合測試）。收一半以下才像原本那一階高光
HIGHLIGHT_LIFT = 0.4

DIFF_THRESHOLD = 60   # 與素體三通道差的總和超過這個才算「變了」（生成圖本身有 ±2 的雜訊）
WHITE = 236           # 三通道都比這亮就是背景

# 圖層繪製順序：後面的蓋前面的
DRAW_ORDER = ("bottom", "top", "outer", "shoes", "hair", "acc")

# 預設顏色：沒有給的那一項維持素體原本的樣子
DEFAULT_COLORS = {
    "skin": "#D4936B", "hair": "#42231B", "top": "#CDCED2", "outer": "#4A6FA5",
    "bottom": "#878789", "shoes": "#4B4C50",
}


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _hex(color: str) -> np.ndarray:
    c = color.lstrip("#")
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=float)


_manifest_cache: Dict[str, dict] = {}
_base_cache: Dict[str, np.ndarray] = {}


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    key = str(path)
    if key not in _manifest_cache:
        with open(path, encoding="utf-8") as f:
            _manifest_cache[key] = json.load(f)
    return _manifest_cache[key]


def base_canvas(manifest: Optional[dict] = None) -> np.ndarray:
    """素體縮到 CANVAS 大小（最近鄰，格子不糊）。回傳一份可以改的拷貝。"""
    manifest = manifest or load_manifest()
    key = manifest["base"]
    if key not in _base_cache:
        base = Image.open(DRESSUP_DIR / key).convert("RGB")
        _base_cache[key] = np.asarray(base.resize(CANVAS, Image.NEAREST))
    return _base_cache[key].copy()


def catalog() -> dict:
    """給手機換裝頁的選單：分類、部件名稱、預設顏色。不含生成用的 prompt。"""
    manifest = load_manifest()
    return {
        "categories": [{k: c[k] for k in ("id", "label", "base_label", "multi")} for c in manifest["categories"]],
        "parts": [{"id": p["id"], "category": p["category"], "label": p["label"],
                   **({"hides": p["hides"]} if p.get("hides") else {})}
                  for p in manifest["parts"] if (LAYER_DIR / f"{p['id']}_mask.png").exists()],
        "defaults": DEFAULT_COLORS,
    }


def front_box(pad: int = 48) -> tuple:
    """正面那個人在 CANVAS 上的範圍（加一點邊給帽沿、髮髻）。素體位置固定，算一次就好。"""
    if "front" not in _label_cache:
        x0, x1, y0, y1 = find_figures(Image.fromarray(base_canvas()))[0]
        _label_cache["front"] = np.array([max(0, x0 - pad), max(0, y0 - pad),
                                          min(CANVAS[0], x1 + pad), min(CANVAS[1], y1 + pad)])
    return tuple(int(v) for v in _label_cache["front"])


_COLOR_KEYS = ("skin", "hair", "top", "outer", "bottom", "shoes")


def clean_request(selection, colors) -> tuple:
    """手機送來的選擇與顏色只留認得的：部件 id 要在清單裡、顏色要是 #RRGGBB。"""
    import re

    known = {p["id"]: p["category"] for p in load_manifest()["parts"]}
    hex_re = re.compile(r"^#[0-9A-Fa-f]{6}$")
    sel = {}
    for cat_id in DRAW_ORDER:
        value = (selection or {}).get(cat_id) if isinstance(selection, dict) else None
        if cat_id == "acc":
            sel["acc"] = [v for v in (value or []) if isinstance(v, str) and known.get(v) == "acc"][:6]
        elif isinstance(value, str) and known.get(value) == cat_id:
            sel[cat_id] = value
    col = {}
    if isinstance(colors, dict):
        for k in _COLOR_KEYS:
            if isinstance(colors.get(k), str) and hex_re.match(colors[k]):
                col[k] = colors[k]
        acc = colors.get("acc")
        if isinstance(acc, dict):
            col["acc"] = {k: v for k, v in acc.items()
                          if k in sel.get("acc", []) and isinstance(v, str) and hex_re.match(v)}
    return sel, col


def _figure_rows(shape, figures) -> np.ndarray:
    """每一格在所屬那個人身上的高度位置（0 頭頂、1 腳底）；不在任何人身上是 -1。"""
    h, w = shape[:2]
    pos = np.full((h, w), -1.0)
    ys = np.arange(h)[:, None]
    for x0, x1, y0, y1 in figures:
        span = max(1, y1 - y0)
        pos[:, x0:x1 + 1] = np.broadcast_to((ys - y0) / span, (h, x1 - x0 + 1))
    return pos


def base_labels(rgb: np.ndarray) -> np.ndarray:
    """素體每一格屬於哪個部位（C_*）。靠顏色家族加上在身上的高度分。"""
    a = rgb.astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = _luma(a)
    t = _figure_rows(rgb.shape, find_figures(Image.fromarray(rgb)))
    neutral = (a.max(axis=2) - a.min(axis=2)) <= 14
    labels = np.full(rgb.shape[:2], C_FIXED, dtype=np.uint8)
    skin = (r > g) & (g > b) & (r - b >= 60) & (lum >= 100)
    hair = _scalp_connected((r > g) & (g >= b) & (r - b >= 6) & (r - b < 60) & (lum < 100) & (t >= 0) & (t < 0.62), t)
    labels[skin] = C_SKIN
    labels[hair] = C_HAIR
    labels[neutral & (lum >= 150) & (t >= 0.3) & (t < 0.80)] = C_TOP
    labels[neutral & (lum >= 95) & (lum < 150) & (t >= 0.6) & (t < 0.93)] = C_BOTTOM
    labels[neutral & (lum < 115) & (t >= 0.9)] = C_SHOES
    # 背景最後蓋：白底在身旁的那幾列也是「亮的中性色」，不能被當成上衣
    labels[a.min(axis=2) > WHITE] = C_BG
    return labels


def _scalp_connected(mask: np.ndarray, t: np.ndarray) -> np.ndarray:
    """只留連到頭頂的那幾塊：眉毛、眼珠也是深棕色，但它們不該跟著髮色換。"""
    import cv2

    count, lab = cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)
    top = np.unique(lab[mask & (t < 0.12)])
    return np.isin(lab, top[top > 0])


def _align(raw: np.ndarray, base: np.ndarray) -> np.ndarray:
    """把 raw 平移對齊素體。只有整數平移：兩張的格子大小一樣，只差幾個像素的位移。"""
    import cv2

    g0 = _luma(base.astype(float)).astype(np.float32)
    g1 = _luma(raw.astype(float)).astype(np.float32)
    (dx, dy), _ = cv2.phaseCorrelate(g0, g1)
    dx, dy = int(round(dx)), int(round(dy))
    out = np.full_like(raw, 255)
    h, w = raw.shape[:2]
    src = raw[max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)]
    out[max(0, -dy):max(0, -dy) + src.shape[0], max(0, -dx):max(0, -dx) + src.shape[1]] = src
    return out


def extract_layer(raw: np.ndarray, base: np.ndarray, base_lab: np.ndarray, region: Sequence[float]):
    """從一張 raw 切出圖層：回傳 (rgb, mask)。mask 是 L_* 分類。"""
    import cv2

    aligned = _align(raw, base)
    a = aligned.astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    green = (g > r + KEY_GREEN_MARGIN) & (g > b + KEY_GREEN_MARGIN)
    diff = np.abs(a - base.astype(int)).sum(axis=2) > DIFF_THRESHOLD
    # 邊緣的一兩像素差是對齊誤差，不是部件：開運算去掉細線
    diff = cv2.morphologyEx(diff.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    t = _figure_rows(base.shape, find_figures(Image.fromarray(base)))
    in_region = (t >= region[0] - 0.02) & (t <= region[1] + 0.02)
    # 部件可能伸出素體的範圍（帽沿、馬尾）：在綠色附近的變化都算
    near_green = cv2.dilate(green.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    keep = green | (diff & (in_region | near_green))

    mask = np.zeros(base.shape[:2], dtype=np.uint8)
    lum = _luma(a)
    white = a.min(axis=2) > WHITE
    skin = (r > g) & (g > b) & (r - b >= 60) & (lum >= 100)
    hair = (r > g) & (g >= b) & (r - b >= 6) & (r - b < 60) & (lum < 100)
    mask[keep] = L_FIXED
    mask[keep & hair] = L_HAIR
    mask[keep & skin] = L_SKIN
    mask[keep & white] = L_ERASE
    mask[green] = L_PART
    # 素體原本就是背景、raw 也是背景：沒有東西要擦
    mask[(mask == L_ERASE) & (base_lab == C_BG)] = L_NONE
    return aligned, mask


def build_layers(ids: Optional[List[str]] = None) -> List[str]:
    """把 raw/ 切成 layers/。回傳處理了哪些部件。"""
    manifest = load_manifest()
    regions = {c["id"]: c["region"] for c in manifest["categories"]}
    base = base_canvas(manifest)
    base_lab = base_labels(base)
    LAYER_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(base_lab).save(LAYER_DIR / "_base_labels.png")
    done = []
    for part in manifest["parts"]:
        if ids and part["id"] not in ids:
            continue
        raw_path = RAW_DIR / f"{part['id']}.png"
        if not raw_path.exists():
            continue
        raw = np.asarray(Image.open(raw_path).convert("RGB").resize(CANVAS, Image.NEAREST))
        rgb, mask = extract_layer(raw, base, base_lab, regions[part["category"]])
        # 沒用到的格子顏色清成 0：透明處留著原圖的顏色，PNG 壓不小（一張 800KB → 不到 100KB）
        rgb = np.where((mask > 0)[..., None], rgb, 0).astype(np.uint8)
        rgba = np.dstack([rgb, np.where(mask > 0, 255, 0).astype(np.uint8)])
        Image.fromarray(rgba, "RGBA").save(LAYER_DIR / f"{part['id']}.png")
        Image.fromarray(mask).save(LAYER_DIR / f"{part['id']}_mask.png")
        done.append(part["id"])
    return done


_layer_cache: Dict[str, tuple] = {}
_label_cache: Dict[str, np.ndarray] = {}


def _base_label_map() -> np.ndarray:
    if "base" not in _label_cache:
        _label_cache["base"] = np.asarray(Image.open(LAYER_DIR / "_base_labels.png"))
    return _label_cache["base"]


def _layer(part_id: str):
    if part_id not in _layer_cache:
        rgba = np.asarray(Image.open(LAYER_DIR / f"{part_id}.png").convert("RGBA"))
        mask = np.asarray(Image.open(LAYER_DIR / f"{part_id}_mask.png"))
        _layer_cache[part_id] = (rgba[..., :3], mask)
    return _layer_cache[part_id]


def _recolor(rgb: np.ndarray, sel: np.ndarray, ref: Sequence[int], target: np.ndarray) -> None:
    """sel 那些格子換成 target：亮度與 ref（原本的中間調）的比例保留下來，暗處更暗、亮處往白收。"""
    if not sel.any():
        return
    lum = _luma(rgb[sel].astype(float))
    ref_l = max(1.0, float(_luma(np.array(ref, dtype=float))))
    k = (lum / ref_l)[:, None]
    lighter = np.clip((k - 1) / max(0.01, 255 / ref_l - 1), 0, 1)
    out = np.where(k <= 1, target * k, target + (255 - target) * lighter * HIGHLIGHT_LIFT)
    rgb[sel] = np.clip(out, 0, 255).astype(np.uint8)


def compose(selection: Optional[dict] = None, colors: Optional[dict] = None,
            box: Optional[Sequence[int]] = None) -> Image.Image:
    """組出一張三視圖（白底 RGB，CANVAS 大小）。

    selection：{"hair": id|None, "top": id|None, "outer": id|None, "bottom": id|None,
                "shoes": id|None, "acc": [id, ...]}；None 或沒給 = 素體原本的那一件
    colors：{"skin", "hair", "top", "outer", "bottom", "shoes": "#RRGGBB", "acc": {id: "#RRGGBB"}}
    box：只組這一塊 (x0, y0, x1, y1)（換裝頁的即時預覽只要正面，快三倍）
    """
    manifest = load_manifest()
    parts = {p["id"]: p for p in manifest["parts"]}
    selection = dict(selection or {})
    colors = {**DEFAULT_COLORS, **{k: v for k, v in (colors or {}).items() if v}}
    x0, y0, x1, y1 = box or (0, 0, CANVAS[0], CANVAS[1])
    crop = (slice(y0, y1), slice(x0, x1))
    rgb = base_canvas(manifest)[crop].copy()
    cat = _base_label_map()[crop].copy()
    # 每一格換色時的參考中間調來源：0 = 素體配色，1 = 占位綠
    from_green = np.zeros(cat.shape, dtype=bool)

    hidden = set()
    for cat_id in DRAW_ORDER:
        pid = selection.get(cat_id)
        if isinstance(pid, str) and pid in parts:
            hidden.update(parts[pid].get("hides", []))

    acc_ids = [p for p in (selection.get("acc") or []) if p in parts]
    for cat_id in DRAW_ORDER:
        if cat_id in hidden:
            continue
        ids = acc_ids if cat_id == "acc" else [selection.get(cat_id)]
        for pid in ids:
            if not (isinstance(pid, str) and pid in parts):
                continue
            layer_rgb, mask = _layer(pid)
            layer_rgb, mask = layer_rgb[crop], mask[crop]
            code = C_ACC0 + acc_ids.index(pid) if cat_id == "acc" else CATEGORY_CODE[cat_id]
            paint = (mask != L_NONE) & (mask != L_ERASE)
            rgb[paint] = layer_rgb[paint]
            from_green[paint] = False
            cat[mask == L_PART] = code
            from_green[mask == L_PART] = True
            cat[mask == L_SKIN] = C_SKIN
            cat[mask == L_HAIR] = C_HAIR
            cat[mask == L_FIXED] = C_FIXED
            erase = mask == L_ERASE
            rgb[erase] = 255
            cat[erase] = C_BG

    if "top" in hidden:
        # 無袖洋裝之類蓋掉上衣的：素體 T 恤沒被蓋到的地方（袖口）是手臂，換成皮膚
        top_left = cat == C_TOP
        _recolor(rgb, top_left, BASE_REF[C_TOP], _hex(colors["skin"]))
        cat[top_left] = C_FIXED

    targets = {C_SKIN: colors["skin"], C_HAIR: colors["hair"], C_TOP: colors["top"], C_OUTER: colors["outer"],
               C_BOTTOM: colors["bottom"], C_SHOES: colors["shoes"]}
    acc_colors = colors.get("acc") or {}
    for i, pid in enumerate(acc_ids):
        targets[C_ACC0 + i] = acc_colors.get(pid) or "#3A3A40"
    for code, color in targets.items():
        target = _hex(color)
        sel = cat == code
        _recolor(rgb, sel & from_green, KEY_GREEN_REF, target)
        if code in BASE_REF:
            _recolor(rgb, sel & ~from_green, BASE_REF[code], target)
    return Image.fromarray(rgb)
