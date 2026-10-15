"""把三視圖原圖整理成像素風格參考圖集的統一規格。

生成時模型要畫「正面｜右側（朝右）｜背面」三個人一排，參考圖集是它照著學的
範本 —— 所以參考圖必須**與輸出同一個排法**。到手的原圖排法各張不同（有的背面
在最左、有的側面朝左），背景也不全是純白（灰底、角落暈影）。這支腳本只做排版
與清背景，**不動人物本身的像素**：

1. 背景：連到圖邊、亮而且幾乎沒有顏色的像素 → 純白。被人物圍住的白（白鞋、
   白袖口）連不到圖邊，不會被洗掉。零碎的小污點（浮水印殘渣）也洗掉。
2. 用整欄都是背景的空白欄切出三個人，依 layout.json 標成哪一面；朝左的側面
   左右鏡像成朝右。
3. 依「正面｜右側｜背面」重排到 1536×864（16:9，與生成輸出同比例）的白底上，
   三個人腳底對齊同一條線、間距相同，整組置中。

**不縮放**：四張原圖是同一個比例尺（腳底同高、身體同大，總高只差在頭髮），
各自縮放成同高反而會讓個頭不一 —— 個頭一致正是這組圖要教的事。
也不重新定格、不量化：這種來源的格距是浮動的，硬切成整數格會把每格混到隔壁格，
量化會併掉虹膜那種小面積的關鍵色（見 INTAKE.md）。

用法::

    python scripts/prepare_turnaround_reference.py \\
        docs/style_reference/2026q3_pixel_curated/_original \\
        --out docs/style_reference/2026q3_pixel_curated

layout.json（放在原圖目錄）::

    {"full_body_01.png": ["back", "front", "side-left"], ...,
     "base_body.png": {"views": ["front", "side-right", "back"],
                       "out": "pose_turnaround.png", "height": 636}}

值是清單的，輸出 turnaround_01.png … 依原圖檔名排序編號（參考圖集）。值是物件的
照 ``out`` 命名（素體）；``height`` 把正面縮放（最近鄰）到這個高度 —— 素體是另外
生成的，畫面裡的大小與參考圖不同，要對齊到參考圖的比例尺。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

FRAME = (1536, 864)
# 腳底離畫框下緣（px）；三個人之間的間距（px，約 10 格 —— 切圖程式靠白色空欄找人，
# 生成的 prompt 也要求至少 8 格）
BOTTOM_MARGIN = 72
GAP = 88
# 背景：亮度至少這麼高、三通道差不超過這麼多，而且連到圖邊
BG_MIN_LUMA = 195
BG_MAX_CHROMA = 20
# 比這個面積比例小的前景碎塊是污點，洗成背景
SPECK_FRAC = 0.002

VIEWS = ("front", "side-right", "side-left", "back")


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """連到圖邊的淺灰／白色區域（含角落暈影與灰底）。"""
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    chroma = rgb.max(axis=2).astype(int) - rgb.min(axis=2).astype(int)
    light = ((lum >= BG_MIN_LUMA) & (chroma <= BG_MAX_CHROMA)).astype(np.uint8)
    count, labels = cv2.connectedComponents(light, connectivity=4)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    edge = edge[edge > 0]
    return np.isin(labels, edge)


def figures(rgb: np.ndarray) -> Tuple[np.ndarray, List[Tuple[int, int]]]:
    """前景遮罩與每個人的欄範圍（由左到右）。"""
    fg = ~background_mask(rgb)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), connectivity=8)
    floor = SPECK_FRAC * fg.size
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] < floor:
            fg[labels == i] = False
    cols = fg.any(axis=0)
    runs, start = [], None
    for x, on in enumerate(list(cols) + [False]):
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append((start, x - 1))
            start = None
    return fg, runs


def prepare(path: Path, layout: List[str], height: Optional[int] = None) -> Image.Image:
    rgb = np.array(Image.open(path).convert("RGB"))
    fg, runs = figures(rgb)
    if len(runs) != 3:
        raise ValueError(f"{path.name}: 找到 {len(runs)} 個人（欄範圍 {runs}），應該是 3 個")
    clean = rgb.copy()
    clean[~fg] = 255

    pieces: Dict[str, np.ndarray] = {}
    bottoms: Dict[str, int] = {}
    for (x0, x1), view in zip(runs, layout):
        if view not in VIEWS:
            raise ValueError(f"{path.name}: 不認得的面 {view!r}")
        crop = clean[:, x0:x1 + 1]
        mask = fg[:, x0:x1 + 1]
        if view == "side-left":
            crop, mask = crop[:, ::-1], mask[:, ::-1]
        key = "side" if view.startswith("side") else view
        if key in pieces:
            raise ValueError(f"{path.name}: {key} 出現兩次")
        ys = np.where(mask.any(axis=1))[0]
        pieces[key] = crop[ys[0]:ys[-1] + 1]
        bottoms[key] = ys[-1]

    order = [pieces[k] for k in ("front", "side", "back")]
    if height:
        scale = height / order[0].shape[0]
        order = [
            np.array(Image.fromarray(p).resize(
                (round(p.shape[1] * scale), round(p.shape[0] * scale)), Image.NEAREST))
            for p in order
        ]
    total = sum(p.shape[1] for p in order) + GAP * 2
    W, H = FRAME
    if total > W or max(p.shape[0] for p in order) > H - BOTTOM_MARGIN:
        raise ValueError(f"{path.name}: 排不進 {W}x{H}")
    canvas = np.full((H, W, 3), 255, dtype=np.uint8)
    x = (W - total) // 2
    base = H - BOTTOM_MARGIN
    for piece in order:
        h, w = piece.shape[:2]
        canvas[base - h:base, x:x + w] = piece
        x += w + GAP
    return Image.fromarray(canvas)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("src", type=Path, help="原圖目錄（含 layout.json）")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    layout = json.loads((args.src / "layout.json").read_text(encoding="utf-8"))
    names = sorted(k for k in layout if not k.startswith("_"))
    args.out.mkdir(parents=True, exist_ok=True)
    index = 0
    for name in names:
        spec = layout[name]
        if isinstance(spec, dict):
            image = prepare(args.src / name, spec["views"], spec.get("height"))
            target = args.out / spec["out"]
        else:
            index += 1
            image = prepare(args.src / name, spec)
            target = args.out / f"turnaround_{index:02d}.png"
        image.save(target)
        print(f"{name} -> {target.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
