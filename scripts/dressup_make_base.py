"""把生成的新素體候選圖做成可以換裝的素體（不花錢，純本機）。

用法（專案根目錄）：
    python scripts/dressup_generate.py --new-base female -n 2      # 先生成候選（要錢）
    python scripts/dressup_make_base.py female docs/.../raw/female/_base_1.png

做的事（backend/dressup.make_base）：縮放到跟第一個素體一樣高、對齊，再把五官
（眉毛、眼睛、嘴）從第一個素體逐格搬過來 —— 表情、眉毛、眼珠顏色才疊得準。
寫出 manifest 指定的素體圖（bases[].image），候選圖另存 raw/<素體>/_base.png 留底。
之後在這個素體上生成部件：python scripts/dressup_generate.py --base female --missing
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import console_encoding  # noqa: E402,F401
import dressup  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    base_id, candidate = sys.argv[1], Path(sys.argv[2])
    spec = next((b for b in dressup.bases()[1:] if b["id"] == base_id), None)
    if spec is None:
        print(f"manifest.json 的 bases 裡沒有 {base_id}（第一個素體是原本就有的，不能重做）")
        return 1
    raw = np.asarray(Image.open(candidate).convert("RGB"))
    out = dressup.make_base(raw)
    Image.fromarray(out).save(dressup.DRESSUP_DIR / spec["image"])
    keep = dressup.RAW_DIR / base_id / "_base.png"
    keep.parent.mkdir(parents=True, exist_ok=True)
    if candidate.resolve() != keep.resolve():
        shutil.copyfile(candidate, keep)

    ref = dressup.base_canvas()
    worst = 0.0
    for slots in dressup.load_manifest()["face"]["slots"].values():
        for slot in slots.values():
            x0, y0, x1, y1 = slot["clear"]
            d = np.abs(out[y0:y1, x0:x1].astype(int) - ref[y0:y1, x0:x1].astype(int)).sum(axis=2)
            worst = max(worst, float((d > 60).mean()))
    print(f"寫好 {(dressup.DRESSUP_DIR / spec['image']).relative_to(ROOT)}；五官跟第一個素體差 {worst:.1%}（0% 才疊得準）")
    print(f"接著：python scripts/dressup_build.py --base {base_id}（先切出素體分區），再生成部件")
    return 0 if worst < 0.01 else 1


if __name__ == "__main__":
    sys.exit(main())
