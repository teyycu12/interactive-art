"""把素體換裝的部件原圖切成圖層（不花錢，純本機）。

用法（專案根目錄）：
    python scripts/dressup_build.py              # 全部重切
    python scripts/dressup_build.py hair_afro    # 只切指定的

讀 dressup/raw/<id>.png，寫 dressup/layers/<id>.png 與 <id>_mask.png，
另外輸出 dressup/_overview.png：每個部件換一個顏色穿在素體上，一張看完。
新增或重切之後要重開生成服務（圖層在第一次換裝時讀進記憶體）。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import console_encoding  # noqa: E402,F401
import dressup  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

# 總覽圖上每個分類用的示範顏色：跟素體原本的灰色差得夠多，才看得出換色有沒有作用
DEMO = {"hair": "#5B3A29", "top": "#4A6FA5", "outer": "#6E7F5A", "bottom": "#C94F5C", "shoes": "#8B5A2B", "acc": "#E9C46A"}


def overview(ids):
    manifest = dressup.load_manifest()
    parts = [p for p in manifest["parts"] if p["id"] in ids]
    tiles = []
    for p in parts:
        cat = p["category"]
        sel = {"acc": [p["id"]]} if cat == "acc" else {cat: p["id"]}
        colors = {"acc": {p["id"]: DEMO["acc"]}} if cat == "acc" else {cat: DEMO[cat]}
        img = dressup.compose(sel, colors).crop((180, 110, 1200, 720)).resize((510, 305), Image.NEAREST)
        ImageDraw.Draw(img).text((6, 4), f"{p['id']}　{p['label']}", fill=(200, 0, 0))
        tiles.append(img)
    cols = 3
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 516, max(1, rows) * 311), "white")
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 516, (i // cols) * 311))
    out = dressup.DRESSUP_DIR / "_overview.png"
    sheet.save(out)
    return out


def main() -> int:
    ids = sys.argv[1:] or None
    done = dressup.build_layers(ids)
    if not done:
        print("沒有切到任何部件：確認 raw/ 裡有對應的 <id>.png")
        return 1
    print(f"切好 {len(done)} 個部件：{', '.join(done)}")
    print(f"總覽圖：{overview(done).relative_to(ROOT)}")
    print("記得重開生成服務。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
