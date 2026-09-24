"""把「像素風」生成圖整成合規的像素風格參考圖。

生圖模型交出來的通常不是像素畫，而是**像素風插畫**：看起來有格子，實際上
格距浮動、邊緣帶反鋸齒、顏色上萬種。那種圖當風格 sheet 會出事，而且不會報錯 ——
sheet 在 prompt 裡被宣告為工藝的最高權威（``_ROLE_STYLE_PIXEL``），所以模型學到的
是「格子大小可以不一致、邊緣可以是軟的」，正好是這個風格唯一不能鬆的兩件事。

預設只做三件事，**刻意不動畫面內容**：

1. **只留主體**：保留最大的連通區塊，其餘（角落暈影、殘留浮水印、地面陰影）填白。
   ``scripts/check_reference_set.py`` 會把那些判為 stray mark 而整張 FAIL。
2. **裁到角色、背景壓成純白 #FFFFFF**。
3. **整數倍最近鄰放大 + 置中到直式畫框**：每一個原始像素變成 N×N 的方塊，
   不產生任何新顏色。

另外兩件事**預設關閉**，因為它們都會動到畫面，而代價比看起來大：

- ``--cells N`` 重新定格。只有當圖本來就畫在乾淨的整數格上才該用。
  生圖模型產的「像素風插畫」格距是浮動的（實測一格 7.9~8.1px、每張偏移不同），
  硬切成 N 列會讓每個輸出格混到隔壁格 —— 實測同高比對下邊緣密度從 0.056 掉到
  0.045，肉眼是「糊掉、變髒」，而檔案本身看起來仍然很「像素」，所以這個損失
  非常容易被當成正常。
- ``--colors N`` 量化。中位切割照面積分配色票，虹膜那種面積小卻關鍵的顏色會
  被併掉 —— 實測 64 色時綠眼睛變藍眼睛，256 色仍偏青。

也就是說：**這支腳本預設只是把圖洗乾淨，不是重畫它。**

原圖不會被更動 —— 輸出到另一個目錄，原圖請留著當 ``_original/``，
PROVENANCE.md 才有東西可以對照。

用法::

    python scripts/pixelize_reference.py docs/style_reference/2026q3_pixel_curated/_original \\
        --out docs/style_reference/2026q3_pixel_curated

    # 只看一張、放大檢查
    python scripts/pixelize_reference.py <dir> --out <dir> --only full_body_01 --preview 6
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image

try:
    import cv2
except ImportError:  # pragma: no cover - 與專案其他腳本一致，缺 cv2 直接說清楚
    print("需要 opencv-python：pip install -r requirements.txt", file=sys.stderr)
    raise

# 與 backend/garment_gen.PIXEL_INK、public/screen/scenes/pixelKit.js 的 INK 同一支。
INK = (0x30, 0x2A, 0x2D)

# 判定背景的門檻。244 與 check_reference_set.NEAR_WHITE 相同，
# 留了空間給重取樣毛邊，又不會把淺灰背景當成白的。
NEAR_WHITE = 244

SOURCE_SUFFIXES = {".png", ".webp", ".jpg", ".jpeg"}


def subject_mask(rgb: np.ndarray) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
    """最大連通區塊的遮罩與外框。

    角色在這個風格裡是一整塊連通的剪影（頭髮連著頭、手連著肩），所以第二塊
    一定不是角色的一部分 —— 它是角落暈影、浮水印或地面陰影。
    """
    fg = (~np.all(rgb >= NEAR_WHITE, axis=2)).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    if count <= 1:
        raise ValueError("整張圖都是背景，找不到角色")
    main = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x = int(stats[main, cv2.CC_STAT_LEFT])
    y = int(stats[main, cv2.CC_STAT_TOP])
    w = int(stats[main, cv2.CC_STAT_WIDTH])
    h = int(stats[main, cv2.CC_STAT_HEIGHT])
    return (labels == main), (x, y, w, h)


def clean_native(rgb: np.ndarray, mask: np.ndarray, colors: int) -> Image.Image:
    """不動幾何，只把顏色收乾淨、把背景壓成純白。

    這是預設模式，因為重新定格會毀掉畫質：策展圖的格距不是剛好的整數，
    也沒有對齊到任何一條格線（實測原圖一格約 7.9~8.1px、偏移每張不同）。
    把 713 列硬切成 90 列時，每一個輸出格都混到隔壁格的顏色 —— 眼睛的綠會
    糊成藍灰、鞋子的形狀會散掉。實測（2026-09-24）同高比對下邊緣密度從
    0.051 掉到 0.042，肉眼是「變模糊、變髒」，而檔案本身看起來仍然很「像素」，
    所以這個損失很容易被當成正常。

    ``colors=0`` 完全不量化，這是預設。量化雖然不動幾何，卻會動顏色：
    中位切割是照「佔多少面積」分配色票的，虹膜那種面積小卻關鍵的顏色會被
    併進隔壁色 —— 實測 64 色時綠眼睛變成藍眼睛，256 色仍偏青。策展圖的重點
    是「這個物種長什麼樣」，眼珠顏色被改掉比多幾千種壓縮雜色嚴重得多。
    """
    out = np.asarray(
        Image.fromarray(rgb).quantize(colors=colors, method=Image.MEDIANCUT,
                                      dither=Image.Dither.NONE).convert("RGB")
        if colors else Image.fromarray(rgb)
    ).copy()
    out[~mask] = 255
    return Image.fromarray(out)


def regrid(rgb: np.ndarray, mask: np.ndarray, cells: int, colors: int) -> Image.Image:
    """縮到 cells 格高、限制色數，並把輪廓外的一切壓成純白。

    先把遮罩一起縮，再用它切掉邊界上的混色：只縮圖的話，角色邊緣會與白色
    背景平均出一圈淺色毛邊，而那正是「硬邊」這條規格要擋的東西。
    """
    h, w = rgb.shape[:2]
    small_w = max(1, round(w * cells / h))

    rgb_small = np.asarray(
        Image.fromarray(rgb).resize((small_w, cells), Image.BOX), dtype=np.float32
    )
    mask_small = np.asarray(
        Image.fromarray((mask * 255).astype(np.uint8)).resize((small_w, cells), Image.BOX),
        dtype=np.float32,
    ) / 255.0
    solid = mask_small >= 0.5

    # 邊界格的顏色被背景稀釋過，先還原成「只由角色像素構成的平均色」，
    # 否則量化會把那一圈稀釋色當成真的顏色，吃掉寶貴的色票。
    with np.errstate(invalid="ignore", divide="ignore"):
        recovered = (rgb_small - 255.0 * (1.0 - mask_small)[..., None]) / np.maximum(
            mask_small[..., None], 1e-6
        )
    rgb_small = np.where(solid[..., None], np.clip(recovered, 0, 255), 255.0)

    sprite = Image.fromarray(rgb_small.astype(np.uint8))
    # dither=NONE 是硬性的：抖色產生的 1px 棋盤在投影機上會閃爍。
    sprite = sprite.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
    sprite = sprite.convert("RGB")

    out = np.asarray(sprite).copy()
    out[~solid] = 255
    return Image.fromarray(out)


def add_outline(sprite: Image.Image) -> Image.Image:
    """沿角色外緣補一格 INK 輪廓（往外長，不吃掉原本的邊緣格）。"""
    a = np.asarray(sprite).copy()
    solid = ~np.all(a >= NEAR_WHITE, axis=2)
    grown = cv2.dilate(solid.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1).astype(bool)
    ring = grown & ~solid
    a[ring] = INK
    return Image.fromarray(a)


def place(sprite: Image.Image, scale: int, frame: Tuple[int, int]) -> Image.Image:
    """整數倍最近鄰放大，置中貼到純白畫框上。"""
    big = sprite.resize((sprite.width * scale, sprite.height * scale), Image.NEAREST)
    canvas = Image.new("RGB", frame, (255, 255, 255))
    if big.width > frame[0] or big.height > frame[1]:
        raise ValueError(
            f"放大後 {big.width}x{big.height} 放不進畫框 {frame[0]}x{frame[1]}；"
            f"把 --scale 調小或 --frame 調大"
        )
    canvas.paste(big, ((frame[0] - big.width) // 2, (frame[1] - big.height) // 2))
    return canvas


def process(path: Path, cells: int, colors: int, outline: bool, scale: int,
            frame: Tuple[int, int], preview: Optional[int]) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert("RGB"))
    mask, (x, y, w, h) = subject_mask(rgb)
    crop = rgb[y:y + h, x:x + w]
    crop_mask = mask[y:y + h, x:x + w]
    sprite = (regrid(crop, crop_mask, cells, colors) if cells
              else clean_native(crop, crop_mask, colors))
    if outline:
        sprite = add_outline(sprite)
    if preview:
        return sprite.resize((sprite.width * preview, sprite.height * preview), Image.NEAREST)
    return place(sprite, scale, frame)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="來源目錄（含 full_body_*）")
    ap.add_argument("--out", type=Path, required=True, help="輸出目錄")
    ap.add_argument("--cells", type=int, default=0,
                    help="重新定格到幾格高。**預設 0 = 不重新定格**，只清乾淨並放大 —— "
                         "策展圖的格距不是整數也沒對齊，重新定格會把細節糊掉")
    ap.add_argument("--colors", type=int, default=0,
                    help="量化後的色數上限。**預設 0 = 不量化** —— 量化會把面積小的"
                         "關鍵顏色（虹膜）併掉；只有重新定格時才需要它")
    ap.add_argument("--scale", type=int, default=2, help="最近鄰放大倍率（預設 2）")
    ap.add_argument("--frame", default="1023x1533", help="輸出畫框，預設 1023x1533")
    ap.add_argument("--outline", action="store_true", help="沿外緣補一格 #302A2D 輪廓")
    ap.add_argument("--only", default="", help="只處理檔名含這段字的圖")
    ap.add_argument("--preview", type=int, default=0, help="不貼畫框，直接輸出放大 N 倍的小圖供檢視")
    args = ap.parse_args()

    if args.cells and args.scale % 3:
        print(f"[warn] --scale {args.scale} 不是 3 的倍數；拼 sheet 時會 1/3 縮放，格線會糊", file=sys.stderr)
    fw, fh = (int(v) for v in args.frame.lower().split("x"))

    paths = sorted(p for p in args.src.glob("full_body_*")
                   if p.suffix.lower() in SOURCE_SUFFIXES and args.only in p.name)
    if not paths:
        print(f"{args.src} 裡沒有符合的 full_body_*", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    for path in paths:
        image = process(path, args.cells, args.colors, args.outline, args.scale, (fw, fh), args.preview or None)
        target = args.out / (path.stem + ".png")
        image.save(target)
        print(f"{path.name:40s} -> {target}  {image.width}x{image.height}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
