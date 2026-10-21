"""把素體換裝的部件原圖切成圖層（不花錢，純本機）。

用法（專案根目錄）：
    python scripts/dressup_build.py                      # 第一個素體（男生）全部重切
    python scripts/dressup_build.py hair_afro            # 只切指定的
    python scripts/dressup_build.py --base female        # 女生素體
    python scripts/dressup_build.py --all-bases          # 每個素體都重切

讀 raw/（其他素體 raw/<素體>/）的原圖，寫 layers/（layers/<素體>/）的 <id>.png 與 <id>_mask.png，
另外輸出 _overview.png（其他素體 _overview_<素體>.png）：每個部件換一個顏色穿在素體上，一張看完。
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


def overview(ids, base_id):
    manifest = dressup.load_manifest()
    parts = [p for p in manifest["parts"] if p["id"] in ids]
    tiles = []
    for p in parts:
        cat = p["category"]
        sel = {"acc": [p["id"]]} if cat == "acc" else {cat: p["id"]}
        colors = {"acc": {p["id"]: DEMO["acc"]}} if cat == "acc" else {cat: DEMO[cat]}
        img = dressup.compose(sel, colors, base_id=base_id).crop((180, 110, 1200, 720)).resize((510, 305), Image.NEAREST)
        ImageDraw.Draw(img).text((6, 4), f"{p['id']}　{p['label']}", fill=(200, 0, 0))
        tiles.append(img)
    cols = 3
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 516, max(1, rows) * 311), "white")
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 516, (i // cols) * 311))
    suffix = "" if base_id == dressup.default_base() else f"_{base_id}"
    out = dressup.DRESSUP_DIR / f"_overview{suffix}.png"
    sheet.save(out)
    return out


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*")
    parser.add_argument("--base", help="哪個素體（manifest 的 bases；預設第一個）")
    parser.add_argument("--all-bases", action="store_true")
    args = parser.parse_args()
    known = [b["id"] for b in dressup.bases()]
    targets = known if args.all_bases else [args.base or known[0]]
    for base_id in targets:
        if base_id not in known:
            print(f"manifest.json 的 bases 裡沒有 {base_id}")
            return 1
        done = dressup.build_layers(args.ids or None, base_id)
        if not done:
            print(f"[{base_id}] 沒有切到任何部件（素體分區已更新）：{dressup.raw_dir(base_id).relative_to(ROOT)} 裡還沒有原圖")
            continue
        print(f"[{base_id}] 切好 {len(done)} 個部件：{', '.join(done)}")
        print(f"[{base_id}] 總覽圖：{overview(done, base_id).relative_to(ROOT)}")
    print("記得重開生成服務。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
