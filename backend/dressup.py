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

臉（表情、眉毛、眼珠顏色）不走生圖：五官只有幾格大，模型改不準，也不是「加一樣東西」。
改用 manifest 的 face 段落裡手畫的格子圖（stamp），蓋在素體五官的固定位置上。

素體不只一個（manifest 的 bases：男生、女生）。每個素體各有一套 raw 與 layers
（第一個素體在 raw/、layers/，其他在 raw/<id>/、layers/<id>/），部件清單共用。
臉是共用的：新素體的五官從第一個素體逐格搬過去（make_base），表情、眉毛不必重畫。
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

# 圖層裡每一格是什麼（layers/<id>_mask.png 的值）。L_TOP：部件拿掉了原本蓋著上衣的東西
# （女生素體的長髮換成短髮，肩上露出 T 恤），露出來的上衣要跟著選的上衣顏色換
L_NONE, L_PART, L_SKIN, L_HAIR, L_ERASE, L_FIXED, L_TOP = 0, 1, 2, 3, 4, 5, 6

# 換色時每一格歸誰管（組圖時的分類圖）。配件從 ACC0 開始依序編號
C_FIXED, C_SKIN, C_HAIR, C_TOP, C_OUTER, C_BOTTOM, C_SHOES, C_BG, C_EYES, C_BROWS = 0, 1, 2, 3, 4, 5, 6, 7, 8, 9
C_ACC0 = 10
CATEGORY_CODE = {"hair": C_HAIR, "top": C_TOP, "outer": C_OUTER, "bottom": C_BOTTOM, "shoes": C_SHOES}
# 臉的分類：部件是格子圖（manifest 的 stamp），不是圖層
FACE_CATEGORIES = ("expression", "brows", "eyes")
# 格子圖裡的類別名稱 → 換色分類
INK_CLASS = {"skin": C_SKIN, "fixed": C_FIXED, "eyes": C_EYES, "brows": C_BROWS}

# 綠色占位色：生成時要求部件只用這個色系畫（manifest 的 edit_prompt）
# 綠比紅、藍都多這麼多才算占位綠。原本 40：部件邊緣反鋸齒的那一圈深綠（約 (30,62,30)）
# 差不到 40，被當成固定色留下來，換成紅裙子邊上還有一圈綠（2026-10-20 女生素體實測）
KEY_GREEN_MARGIN = 25
KEY_GREEN_REF = (24, 180, 24)   # 占位綠的中間調：換色時對應到參與者選的顏色本身

# 素體各部位的中間調（量自 pose_turnaround.png 出現最多的顏色）。換色時這個亮度對應到選的顏色
BASE_REF = {
    C_SKIN: (212, 147, 107),
    C_HAIR: (66, 43, 35),
    C_TOP: (205, 206, 210),
    C_BOTTOM: (135, 135, 137),
    C_SHOES: (75, 76, 80),
    C_EYES: (48, 24, 16),
    C_BROWS: (73, 46, 35),
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
    "bottom": "#878789", "shoes": "#4B4C50", "eyes": "#301810", "brows": "#492E23",
}


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _hex(color: str) -> np.ndarray:
    c = color.lstrip("#")
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=float)


_manifest_cache: Dict[str, dict] = {}
_base_cache: Dict[str, np.ndarray] = {}
_layer_cache: Dict[tuple, tuple] = {}
_label_cache: Dict[tuple, np.ndarray] = {}


def load_manifest(path: Path = MANIFEST_PATH) -> dict:
    key = str(path)
    if key not in _manifest_cache:
        with open(path, encoding="utf-8") as f:
            _manifest_cache[key] = json.load(f)
    return _manifest_cache[key]


def bases(manifest: Optional[dict] = None) -> List[dict]:
    """素體清單（manifest 的 bases），第一個是預設。"""
    return (manifest or load_manifest())["bases"]


def default_base(manifest: Optional[dict] = None) -> str:
    return bases(manifest)[0]["id"]


def clean_base(value, manifest: Optional[dict] = None) -> str:
    """手機送來的素體 id：認得就用，不認得（或沒給）用預設 —— 舊版手機不會送這個欄位。"""
    ids = [b["id"] for b in bases(manifest)]
    return value if isinstance(value, str) and value in ids else ids[0]


def _base(base_id: str, manifest: Optional[dict] = None) -> dict:
    return next(b for b in bases(manifest) if b["id"] == base_id)


def raw_dir(base_id: Optional[str] = None) -> Path:
    """部件原圖放哪：第一個素體在 raw/（素體換裝一開始只有它），其他在 raw/<素體>/。"""
    base_id = base_id or default_base()
    return RAW_DIR if base_id == default_base() else RAW_DIR / base_id


def layer_dir(base_id: Optional[str] = None) -> Path:
    base_id = base_id or default_base()
    return LAYER_DIR if base_id == default_base() else LAYER_DIR / base_id


def base_canvas(manifest: Optional[dict] = None, base_id: Optional[str] = None) -> np.ndarray:
    """素體縮到 CANVAS 大小（最近鄰，格子不糊）。回傳一份可以改的拷貝。"""
    manifest = manifest or load_manifest()
    key = _base(base_id or default_base(manifest), manifest)["image"]
    if key not in _base_cache:
        base = Image.open(DRESSUP_DIR / key).convert("RGB")
        _base_cache[key] = np.asarray(base.resize(CANVAS, Image.NEAREST))
    return _base_cache[key].copy()


def catalog() -> dict:
    """給手機換裝頁的選單：素體、分類、部件名稱、預設顏色。不含生成用的 prompt。

    部件帶 bases：在哪些素體上畫好了（某個素體還沒生成的部件，手機上就不列）。
    素體帶 base_labels：「什麼都不選」時那一格叫什麼（男生是短髮、女生是中長髮）。
    """
    manifest = load_manifest()
    base_ids = [b["id"] for b in bases(manifest)]
    parts = []
    for p in manifest["parts"]:
        on = [b for b in base_ids if _usable(p, b)]
        if on:
            parts.append({"id": p["id"], "category": p["category"], "label": p["label"], "bases": on,
                          **({"hides": p["hides"]} if p.get("hides") else {})})
    return {
        "bases": [{"id": b["id"], "label": b["label"], "base_labels": b.get("base_labels", {})}
                  for b in bases(manifest)],
        "categories": [{**{k: c[k] for k in ("id", "label", "base_label", "multi")},
                        "palette": c.get("palette", "cloth")} for c in manifest["categories"]],
        "parts": parts,
        "defaults": DEFAULT_COLORS,
    }


def _usable(part: dict, base_id: Optional[str] = None) -> bool:
    """臉的部件是格子圖，有寫就能用；衣服髮型要在這個素體上切過圖層才能用。"""
    if part["category"] in FACE_CATEGORIES:
        return bool(part.get("stamp"))
    return (layer_dir(base_id) / f"{part['id']}_mask.png").exists()


def front_box(pad: int = 48, base_id: Optional[str] = None) -> tuple:
    """正面那個人在 CANVAS 上的範圍（加一點邊給帽沿、髮髻）。素體位置固定，算一次就好。"""
    key = ("front", base_id or default_base())
    if key not in _label_cache:
        x0, x1, y0, y1 = find_figures(Image.fromarray(base_canvas(base_id=key[1])))[0]
        _label_cache[key] = np.array([max(0, x0 - pad), max(0, y0 - pad),
                                      min(CANVAS[0], x1 + pad), min(CANVAS[1], y1 + pad)])
    return tuple(int(v) for v in _label_cache[key])


_COLOR_KEYS = ("skin", "hair", "top", "outer", "bottom", "shoes", "eyes", "brows")


def clean_request(selection, colors, base_id: Optional[str] = None) -> tuple:
    """手機送來的選擇與顏色只留認得的：部件 id 要在清單裡（而且這個素體上畫好了）、顏色要是 #RRGGBB。"""
    import re

    known = {p["id"]: p["category"] for p in load_manifest()["parts"] if _usable(p, base_id)}
    hex_re = re.compile(r"^#[0-9A-Fa-f]{6}$")
    sel = {}
    for cat_id in DRAW_ORDER + FACE_CATEGORIES:
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


def base_labels(rgb: np.ndarray, face: Optional[dict] = None) -> np.ndarray:
    """素體每一格屬於哪個部位（C_*）。靠顏色家族加上在身上的高度分。

    face：manifest 的 face 段落。給了的話，眉毛、眼珠另外標出來（可以換色）；
    它們的位置在格子圖的 slot 裡寫死了，不必猜。
    """
    a = rgb.astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = _luma(a)
    t = _figure_rows(rgb.shape, find_figures(Image.fromarray(rgb)))
    neutral = (a.max(axis=2) - a.min(axis=2)) <= 14
    labels = np.full(rgb.shape[:2], C_FIXED, dtype=np.uint8)
    skin = (r > g) & (g > b) & (r - b >= 60) & (lum >= 100)
    hairy = (r > g) & (g >= b) & (r - b >= 6) & (r - b < 60) & (lum < 100) & (t >= 0) & (t < 0.62)
    hair = _scalp_connected(hairy, t)
    if face:
        # 披肩的長髮在正面被耳朵整個切開，耳朵以下那段連不到頭頂（女生素體）。五官的位置
        # 已知：夠大、又不碰到五官的同色塊也算頭髮。眉毛、眼珠都在五官的 slot 裡，不會被算進來
        hair |= _loose_hair(hairy & ~hair, face)
    labels[skin] = C_SKIN
    labels[hair] = C_HAIR
    labels[neutral & (lum >= 150) & (t >= 0.3) & (t < 0.80)] = C_TOP
    labels[neutral & (lum >= 95) & (lum < 150) & (t >= 0.6) & (t < 0.93)] = C_BOTTOM
    labels[neutral & (lum < 115) & (t >= 0.9)] = C_SHOES
    # T 恤兩側那條較深的灰邊跟長褲同一個亮度，上面的規則把它算成褲子：換紅褲子時 T 恤兩側也變紅。
    # 在 T 恤下擺以上（同一欄最低的上衣格子）的「褲子」都改回上衣
    top = labels == C_TOP
    hem = np.where(top.any(axis=0), top.shape[0] - 1 - np.argmax(top[::-1], axis=0), -1)
    rows = np.arange(labels.shape[0])[:, None]
    labels[(labels == C_BOTTOM) & (rows <= hem[None, :])] = C_TOP
    # 背景最後蓋：白底在身旁的那幾列也是「亮的中性色」，不能被當成上衣
    labels[a.min(axis=2) > WHITE] = C_BG
    if face:
        # 眉毛、眼珠：棕色系、比皮膚暗。睫毛那條近乎全黑（紅藍差不到 20），不算眼珠
        browny = (r - b >= 20) & (lum >= 24) & (lum < 120) & ~skin
        for slots in face["slots"].values():
            for slot in slots.values():
                code = {"brows": C_BROWS, "eyes": C_EYES}.get(slot.get("feature"))
                if code is None:
                    continue
                x0, y0, x1, y1 = slot["clear"]
                box = np.zeros(labels.shape, dtype=bool)
                box[y0:y1, x0:x1] = True
                found = box & browny
                if code == C_EYES:
                    # 眼角那一格陰影跟眼珠亮部同色：只認最大的那一塊，不然換藍眼時眼角也發藍
                    found = _largest(found)
                labels[found] = code
    return labels


def _largest(mask: np.ndarray) -> np.ndarray:
    import cv2

    count, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=4)
    if count <= 1:
        return mask
    return lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))


LOOSE_HAIR_MIN = 300   # 像素。比這小的深棕色塊是陰影、雜點，不是一段頭髮


def _loose_hair(mask: np.ndarray, face: dict) -> np.ndarray:
    import cv2

    features = np.zeros(mask.shape, dtype=bool)
    for slots in face["slots"].values():
        for slot in slots.values():
            x0, y0, x1, y1 = slot["clear"]
            features[y0:y1, x0:x1] = True
    count, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=4)
    keep = [i for i in range(1, count)
            if stats[i, cv2.CC_STAT_AREA] >= LOOSE_HAIR_MIN and not features[lab == i].any()]
    return np.isin(lab, keep)


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
    # 部件畫完還是 T 恤的格子（亮的中性灰）：跟著選的上衣顏色換，不能照原樣留成灰色。
    #   - 素體原本是頭髮：女生素體的長髮披在肩上，換短髮後露出 T 恤（頭髮的邊那一圈也算，
    #     模型重畫時那一圈常變成 T 恤，漏掉的話背上留一條白線）
    #   - 素體原本就是 T 恤、只是模型重畫時亮暗變了（頭髮下的陰影、敞開外套裡的 T 恤）
    # 其他地方的淺灰（眼鏡反光、帽子亮面）是部件自己的顏色，不算
    hair_zone = cv2.dilate((base_lab == C_HAIR).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    tee = (((a.max(axis=2) - a.min(axis=2)) <= 14) & (lum >= 150) & ~white & (t >= 0.3) & (t < 0.8)
           & (hair_zone | (base_lab == C_TOP)))
    mask[keep] = L_FIXED
    mask[keep & hair] = L_HAIR
    mask[keep & tee] = L_TOP
    mask[keep & skin] = L_SKIN
    mask[keep & white] = L_ERASE
    mask[green] = L_PART
    # 素體原本就是背景、raw 也是背景：沒有東西要擦
    mask[(mask == L_ERASE) & (base_lab == C_BG)] = L_NONE
    return aligned, mask


def build_layers(ids: Optional[List[str]] = None, base_id: Optional[str] = None) -> List[str]:
    """把這個素體的 raw 切成 layers。回傳處理了哪些部件。"""
    manifest = load_manifest()
    base_id = base_id or default_base(manifest)
    regions = {c["id"]: c["region"] for c in manifest["categories"] if "region" in c}
    base = base_canvas(manifest, base_id)
    base_lab = base_labels(base, manifest.get("face"))
    out_dir = layer_dir(base_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(base_lab).save(out_dir / "_base_labels.png")
    _label_cache.pop(("labels", base_id), None)
    done = []
    for part in manifest["parts"]:
        if (ids and part["id"] not in ids) or part["category"] not in regions:
            continue
        raw_path = raw_dir(base_id) / f"{part['id']}.png"
        if not raw_path.exists():
            continue
        raw = np.asarray(Image.open(raw_path).convert("RGB").resize(CANVAS, Image.NEAREST))
        rgb, mask = extract_layer(raw, base, base_lab, regions[part["category"]])
        # 沒用到的格子顏色清成 0：透明處留著原圖的顏色，PNG 壓不小（一張 800KB → 不到 100KB）
        rgb = np.where((mask > 0)[..., None], rgb, 0).astype(np.uint8)
        rgba = np.dstack([rgb, np.where(mask > 0, 255, 0).astype(np.uint8)])
        Image.fromarray(rgba, "RGBA").save(out_dir / f"{part['id']}.png")
        Image.fromarray(mask).save(out_dir / f"{part['id']}_mask.png")
        _layer_cache.pop((part["id"], base_id), None)
        done.append(part["id"])
    return done


# 新素體從第一個素體搬五官時，往外多搬幾格：模型畫的眼睛常偏個幾像素，
# 只搬 slot 範圍的話，slot 邊上會留下新素體自己那雙眼睛的一角
FACE_COPY_PAD = 6


def _outside(rgb: np.ndarray) -> np.ndarray:
    """連到畫面邊緣的白色 = 背景。眼白也是白的，但被臉包住，不算背景。"""
    import cv2

    white = (rgb.min(axis=2) > WHITE).astype(np.uint8)
    _, lab = cv2.connectedComponents(white, connectivity=4)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    return np.isin(lab, border[border > 0])


def make_base(raw: np.ndarray, manifest: Optional[dict] = None) -> np.ndarray:
    """生圖模型畫的新素體 → 能跟第一個素體共用臉的素體（CANVAS 大小）。

    1. 縮放到跟第一個素體一樣高（模型常畫大或小 1%，五官就差幾像素）
    2. 平移對齊
    3. 五官（眉毛、眼睛、嘴）從第一個素體逐格搬過來：模型會照自己的意思重畫一次臉，
       差幾像素表情、眉毛的格子圖就疊不準。只搬兩邊都是臉的格子，頭髮、背景不動
    """
    manifest = manifest or load_manifest()
    ref = base_canvas(manifest)
    face = manifest["face"]
    w, h = CANVAS
    img = Image.fromarray(raw).resize(CANVAS, Image.NEAREST)
    ref_fig = find_figures(Image.fromarray(ref))[0]
    new_fig = find_figures(img)[0]
    scale = (ref_fig[3] - ref_fig[2]) / max(1, new_fig[3] - new_fig[2])
    scaled = img.resize((round(w * scale), round(h * scale)), Image.NEAREST)
    canvas = Image.new("RGB", CANVAS, "white")
    canvas.paste(scaled, (round((w - scaled.width) / 2), round((h - scaled.height) / 2)))
    out = _align(np.asarray(canvas), ref).copy()

    ref_lab, out_lab = base_labels(ref, face), base_labels(out, face)
    keep = (ref_lab != C_HAIR) & (out_lab != C_HAIR) & ~_outside(ref) & ~_outside(out)
    for slots in face["slots"].values():
        for slot in slots.values():
            x0, y0, x1, y1 = slot["clear"]
            box = (slice(max(0, y0 - FACE_COPY_PAD), y1 + FACE_COPY_PAD),
                   slice(max(0, x0 - FACE_COPY_PAD), x1 + FACE_COPY_PAD))
            m = keep[box]
            out[box][m] = ref[box][m]
    return out


def _base_label_map(base_id: Optional[str] = None) -> np.ndarray:
    key = ("labels", base_id or default_base())
    if key not in _label_cache:
        _label_cache[key] = np.asarray(Image.open(layer_dir(key[1]) / "_base_labels.png"))
    return _label_cache[key]


def _layer(part_id: str, base_id: Optional[str] = None):
    key = (part_id, base_id or default_base())
    if key not in _layer_cache:
        folder = layer_dir(key[1])
        rgba = np.asarray(Image.open(folder / f"{part_id}.png").convert("RGBA"))
        mask = np.asarray(Image.open(folder / f"{part_id}_mask.png"))
        _layer_cache[key] = (rgba[..., :3], mask)
    return _layer_cache[key]


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


def _stamp_cells(part: dict, face: dict):
    """一個臉部部件要畫哪些格子：逐一給出 (slot, [(x, y, 墨色代號), ...])。"""
    cell = face["cell"]
    for view_id, slots in face["slots"].items():
        drawn = part["stamp"].get(view_id) or {}
        for slot_id, slot in slots.items():
            # 正面左右各一的五官：寫 "brow" 兩邊都畫（右邊左右翻），寫 "brow_r" 只畫那一邊
            rows = drawn.get(slot_id)
            if rows is None and slot.get("pair") in drawn:
                rows = drawn[slot["pair"]]
                if slot.get("mirror"):
                    rows = [r[::-1] for r in rows]
            if rows is None:
                continue
            ax, ay = slot["at"]
            yield slot, [(ax + i * cell, ay + j * cell, ch)
                         for j, row in enumerate(rows) for i, ch in enumerate(row) if ch != "."]


def _apply_face(rgb: np.ndarray, cat: np.ndarray, part: dict, face: dict, origin: Sequence[int]) -> None:
    """蓋一個臉部部件：先把那個五官原本的樣子抹成皮膚，再一格一格畫上去。"""
    cell = face["cell"]
    ox, oy = origin
    h, w = cat.shape

    def box(x0, y0, x1, y1):
        x0, x1 = max(0, x0 - ox), min(w, x1 - ox)
        y0, y1 = max(0, y0 - oy), min(h, y1 - oy)
        return (slice(y0, y1), slice(x0, x1)) if x0 < x1 and y0 < y1 else None

    for slot, cells in _stamp_cells(part, face):
        clear = box(*slot["clear"])
        if clear:
            rgb[clear] = BASE_REF[C_SKIN]
            cat[clear] = C_SKIN
        for x, y, ch in cells:
            ink = face["ink"][ch]
            b = box(x, y, x + cell, y + cell)
            if b:
                rgb[b] = ink["rgb"]
                cat[b] = INK_CLASS[ink["class"]]


def compose(selection: Optional[dict] = None, colors: Optional[dict] = None,
            box: Optional[Sequence[int]] = None, base_id: Optional[str] = None) -> Image.Image:
    """組出一張三視圖（白底 RGB，CANVAS 大小）。

    selection：{"hair": id|None, "top": id|None, "outer": id|None, "bottom": id|None,
                "shoes": id|None, "expression": id|None, "brows": id|None, "acc": [id, ...]}；
               None 或沒給 = 素體原本的那一件
    colors：{"skin", "hair", "top", "outer", "bottom", "shoes", "eyes", "brows": "#RRGGBB",
             "acc": {id: "#RRGGBB"}}
    box：只組這一塊 (x0, y0, x1, y1)（換裝頁的即時預覽只要正面，快三倍）
    base_id：哪個素體（manifest 的 bases；沒給是第一個）
    """
    manifest = load_manifest()
    base_id = base_id or default_base(manifest)
    parts = {p["id"]: p for p in manifest["parts"]}
    selection = dict(selection or {})
    colors = {**DEFAULT_COLORS, **{k: v for k, v in (colors or {}).items() if v}}
    x0, y0, x1, y1 = box or (0, 0, CANVAS[0], CANVAS[1])
    crop = (slice(y0, y1), slice(x0, x1))
    rgb = base_canvas(manifest, base_id)[crop].copy()
    cat = _base_label_map(base_id)[crop].copy()
    # 每一格換色時的參考中間調來源：0 = 素體配色，1 = 占位綠
    from_green = np.zeros(cat.shape, dtype=bool)

    # 臉先畫：瀏海、帽子、眼鏡之後蓋在上面。眉毛先、表情後（表情可能連眼睛一起換）
    face = manifest.get("face")
    for cat_id in ("brows", "expression"):
        pid = selection.get(cat_id)
        if face and isinstance(pid, str) and parts.get(pid, {}).get("category") == cat_id:
            _apply_face(rgb, cat, parts[pid], face, (x0, y0))

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
            if not _usable(parts[pid], base_id):
                continue
            layer_rgb, mask = _layer(pid, base_id)
            layer_rgb, mask = layer_rgb[crop], mask[crop]
            code = C_ACC0 + acc_ids.index(pid) if cat_id == "acc" else CATEGORY_CODE[cat_id]
            paint = (mask != L_NONE) & (mask != L_ERASE)
            rgb[paint] = layer_rgb[paint]
            from_green[paint] = False
            cat[mask == L_PART] = code
            from_green[mask == L_PART] = True
            cat[mask == L_SKIN] = C_SKIN
            cat[mask == L_HAIR] = C_HAIR
            cat[mask == L_TOP] = C_TOP
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
               C_BOTTOM: colors["bottom"], C_SHOES: colors["shoes"], C_EYES: colors["eyes"],
               C_BROWS: colors["brows"]}
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
