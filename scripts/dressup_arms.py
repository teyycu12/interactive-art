"""換裝角色走路擺手用的手臂標記圖（不花錢，純本機；要裝 Node）。

用法（專案根目錄）：
    python scripts/dressup_arms.py

寫出 layers/<素體>/_arms.png（素體的 T 恤短袖），以及 ARM_PARTS 裡每個部件的
layers/<素體>/<部件>_arms.png（長袖外套：袖子比手臂寬，要整條袖子一起擺）。
另外輸出 _arms_preview.png（不進版控）：紅、藍是正面背面的左右手，紫是側面的手。

做法：素體（加那個部件）組成三視圖，每一面交給大螢幕同一套走路分析找手臂
（scripts/dressup_arms_label.mjs），再把格子畫回整張圖。第一個素體以外的素體：
  - 頭髮的格子不算手（女生的長髮垂在肩膀前面，會被當成手臂的上半截）；
  - 手臂從第一個素體的手臂上緣開始（扣掉頭髮後，臉頰、耳朵還會留在範圍裡）；
  - 側面找不到手（長袖外套蓋住長髮）就借第一個素體的 —— 素體都對齊在同一個位置。
找完一定要看 _arms_preview.png：這張圖之後每個換裝角色都照它擺手。
改了素體、部件，或 shared/walkFrames.js 找手的規則之後重跑，然後重開生成服務。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import console_encoding  # noqa: E402,F401
import dressup  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from turnaround import find_figures  # noqa: E402

# 會改變手臂範圍的部件與它的選法
ARM_PARTS = {"top_hoodie": {"outer": "top_hoodie"}}
CODE = {name: code for code, name in dressup.ARM_NAMES.items()}
VIEWS = ("front", "side", "back")
PAD = 8


def _crops(work: Path, looks: dict) -> dict:
    """每個組合組成三視圖，三面各切成全高、背景透明的 RGBA 原始檔"""
    meta, sheets = [], {}
    for key, (base_id, sel) in looks.items():
        img, holes = dressup.compose(sel, {}, base_id=base_id, with_holes=True)
        rgb = np.asarray(img)
        bg = holes | dressup._outside(rgb)
        figs = find_figures(img)
        if len(figs) != 3:
            raise RuntimeError(f"{key}：三視圖切出 {len(figs)} 個人")
        item = {"id": key, "lefts": []}
        for view, (x0, x1, _, _) in zip(VIEWS, figs):
            left, right = max(0, x0 - PAD), min(rgb.shape[1], x1 + PAD)
            crop = np.dstack([rgb[:, left:right], np.where(bg[:, left:right], 0, 255).astype(np.uint8)])
            (work / f"{key}_{view}.bin").write_bytes(np.ascontiguousarray(crop).tobytes())
            item[view] = [right - left, rgb.shape[0]]
            item["lefts"].append(left)
        meta.append(item)
        sheets[key] = (img, ~bg, figs)
    (work / "meta.json").write_text(json.dumps(meta))
    return {m["id"]: m for m in meta}, sheets


def _paint(meta: dict, labels: dict, shape) -> np.ndarray:
    """格子的標記畫回整張圖"""
    out = np.zeros(shape, np.uint8)
    for view, left in zip(VIEWS, meta["lefts"]):
        g = labels[view]
        for arm in g["arms"]:
            for r, c in arm["cells"]:
                y0, y1 = round(g["y0"] + r * g["cell"]), round(g["y0"] + (r + 1) * g["cell"])
                x0, x1 = round(left + g["x0"] + c * g["cell"]), round(left + g["x0"] + (c + 1) * g["cell"])
                out[y0:y1, x0:x1] = CODE[arm["name"]]
    return out


def main() -> int:
    bases = [b["id"] for b in dressup.bases()]
    looks = {}
    for base_id in bases:
        looks[f"{base_id}__base"] = (base_id, {})
        for pid, sel in ARM_PARTS.items():
            looks[f"{base_id}__{pid}"] = (base_id, sel)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        meta, sheets = _crops(work, looks)
        subprocess.run(["node", str(ROOT / "scripts" / "dressup_arms_label.mjs"), str(work)], check=True)
        labels = json.loads((work / "labels.json").read_text())

    first = bases[0]
    maps, previews = {}, []
    for key, (base_id, _) in looks.items():
        img, fg, figs = sheets[key]
        m = _paint(meta[key], labels[key], fg.shape)
        if base_id != first:
            ref = maps[key.replace(f"{base_id}__", f"{first}__", 1)]
            if not (m == CODE["arm"]).any():
                m[ref == CODE["arm"]] = CODE["arm"]
            m[dressup._base_label_map(base_id) == dressup.C_HAIR] = 0
            rows = np.arange(m.shape[0])[:, None]
            for x0, x1, _, _ in figs:
                for code in (CODE["armL"], CODE["armR"]):
                    ys = np.nonzero((ref[:, x0:x1 + 1] == code).any(axis=1))[0]
                    if len(ys):
                        seg = m[:, x0:x1 + 1]
                        seg[(seg == code) & (rows < ys[0])] = 0
        m[~fg] = 0
        maps[key] = m
        part = key.split("__", 1)[1]
        name = "_arms.png" if part == "base" else f"{part}_arms.png"
        Image.fromarray(m).save(dressup.layer_dir(base_id) / name)
        found = {n: int((m == c).sum()) for n, c in CODE.items()}
        print(f"[{base_id}] {name}：{found}")
        vis = np.asarray(img).astype(float)
        for code, col in ((1, (255, 0, 0)), (2, (0, 120, 255)), (3, (255, 0, 255))):
            vis[m == code] = vis[m == code] * 0.4 + np.array(col) * 0.6
        previews.append(Image.fromarray(vis.astype(np.uint8)))
    sheet = Image.new("RGB", (previews[0].width, previews[0].height * len(previews)))
    for i, p in enumerate(previews):
        sheet.paste(p, (0, i * p.height))
    out = dressup.DRESSUP_DIR / "_arms_preview.png"
    sheet.save(out)
    print(f"預覽：{out.relative_to(ROOT)}（看過再用）。記得重開生成服務。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
