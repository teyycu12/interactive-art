"""生成角色走路擺手的手臂模板（不花錢，純本機；要裝 Node）。

用法（專案根目錄）：
    python scripts/arm_template.py

生成的角色都照同一張姿勢參考圖（男生素體 pose_turnaround.png）畫，手臂大約在同一個
位置（實測手掌差 ±3 格，整個人 90 格高）。大螢幕從圖上找不到手的時候（長袖、斜背包
擋住縫、手搭在光腿上），拿這份模板對齊到角色身上再微調（shared/walkFrames.js 的
templateArms）。

模板取男生素體穿長袖外套的手臂範圍（layers/_arms.png 那一套，scripts/dressup_arms.py
做的）：側面是從肩膀到手掌的整條袖子 —— 生成角色找不到手多半是長袖。寫出
shared/armTemplate.js（進版控）。改了姿勢參考圖或 dressup_arms.py 之後重跑。
"""

from __future__ import annotations

import base64
import io
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
from turnaround import split_turnaround  # noqa: E402

LOOK = {"outer": "top_hoodie"}
VIEWS = ("front", "side", "back")


def main() -> int:
    base_id = dressup.default_base()
    sheet, holes = dressup.compose(LOOK, {}, base_id=base_id, with_holes=True)
    buf = io.BytesIO()
    sheet.save(buf, "PNG")
    lefts: list = []
    split_turnaround(base64.b64encode(buf.getvalue()).decode("ascii"), holes=holes, lefts=lefts)
    boxes = dressup.figure_boxes(sheet, holes, lefts)
    arms = dressup.arm_cells(LOOK, base_id, boxes)
    if not arms:
        print("素體沒有手臂標記圖：先跑 python scripts/dressup_arms.py")
        return 1
    rgb = np.asarray(sheet)
    bg = holes | dressup._outside(rgb)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        meta = {}
        for view in VIEWS:
            x0, y0, x1, y1 = boxes[view]
            crop = np.dstack([rgb[y0:y1 + 1, x0:x1 + 1],
                              np.where(bg[y0:y1 + 1, x0:x1 + 1], 0, 255).astype(np.uint8)])
            (work / f"{view}.bin").write_bytes(np.ascontiguousarray(crop).tobytes())
            meta[view] = [x1 - x0 + 1, y1 - y0 + 1]
        (work / "meta.json").write_text(json.dumps({"size": meta, "arms": arms}))
        out = ROOT / "shared" / "armTemplate.js"
        subprocess.run(["node", str(ROOT / "scripts" / "arm_template.mjs"), str(work), str(out)], check=True)
    print(f"寫好 {out.relative_to(ROOT)}。記得重新整理大螢幕。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
