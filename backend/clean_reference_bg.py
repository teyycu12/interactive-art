"""把風格參考圖的背景壓成純白，讓模型不再有影子可以模仿。

為什麼要做：參考圖是 prompt-time 條件輸入，模型會忠實模仿它看到的一切，
包含背景漸層與腳下的地面投影。prompt 明文禁止影子（_PIXAR_NEGATIVE），
但圖像訊號贏過文字，結果是生成圖帶著影子出來，再讓
_remove_white_background 的純白 flood-fill 沿著亮度等高線切出鋸齒邊。

**FLOODFILL_FIXED_RANGE 是必要的，不是優化。** OpenCV 預設把 loDiff/upDiff
拿去比對「相鄰像素」，於是白色短褲一旦在臀部輪廓與白背景相接，fill 就會
走進褲子、再沿著它平滑的明暗一路爬滿整件衣服 —— 每一步的相鄰差都沒超過
容差。實測 full_body_05 有 6636 個暗於 200 的人物像素被判成背景，而且
**調低容差救不了**（tol=2 仍漏 6558）。改成與「種子顏色」比對後，六張圖的
暗部滲漏全部歸零，`clean()` 裡的 leaked 斷言就是守住這件事的。

**刻意不處理鞋底周圍那一圈淺影。** 試過兩種啟發式，都在實測中弄壞人物：
「非背景寬度遠超雙腿即為影子」把 full_body_01/05 的臀部與雙手整片抹白
（人體最寬處本來就會觸發）；「最低彩度像素以下即為影子」則因白鞋彩度低，
把 full_body_01 的白球鞋整雙刪掉。那圈殘影與鞋子的接觸陰影在像素上無從
分辨，硬切的代價遠大於留著 —— 它面積小、亮度高（灰階 240 以上），
下游 _remove_white_background 的容差本來就吃得掉。
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# 與種子（純白角落）的最大距離。沿用 garment_gen._remove_white_background
# 的預設值，以免兩處各有一套語意。
TOLERANCE = 18
# 滲漏斷言：背景遮罩不該碰到任何暗於此值的像素，那必然是人物。
LEAK_GREY = 200


def _background_mask(rgb: np.ndarray) -> np.ndarray:
    h, w, _ = rgb.shape
    mask = np.zeros((h + 2, w + 2), np.uint8)
    work = rgb.copy()
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        cv2.floodFill(
            work, mask, seed, (0, 0, 0),
            loDiff=(TOLERANCE,) * 3, upDiff=(TOLERANCE,) * 3,
            flags=4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8),
        )
    return mask[1:-1, 1:-1] > 0


def clean(path: Path) -> dict:
    img = Image.open(path)
    had_alpha = img.mode == "RGBA"
    rgb = np.array(img.convert("RGB"))
    before = rgb.astype(int).mean(axis=2)

    bg = _background_mask(rgb)
    leaked = int((bg & (before < LEAK_GREY)).sum())
    if leaked:
        raise SystemExit(f"{path.name}: 背景遮罩滲入人物 {leaked} 像素，中止")

    out = rgb.copy()
    out[bg] = 255
    result = Image.fromarray(out, mode="RGB")
    if had_alpha:
        result = result.convert("RGBA")
    result.save(path, format="PNG")

    after = np.array(result.convert("RGB")).astype(int).mean(axis=2)
    return {
        "bg_pct": bg.mean() * 100,
        "dirty_before": int((bg & (before < 250)).sum()),
        "dirty_after": int((bg & (after < 250)).sum()),
        "changed": int((np.abs(before - after) > 4).sum()),
    }


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        p = Path(arg)
        r = clean(p)
        print(f"{p.name:34s} bg={r['bg_pct']:5.1f}%  "
              f"背景髒像素 {r['dirty_before']:6d} → {r['dirty_after']:d}  改動 {r['changed']}px")
