"""生成素體換裝的部件原圖（會呼叫生圖 API、花錢：每張約 US$0.07）。

用法（專案根目錄）：
    python scripts/dressup_generate.py hair_afro acc_earrings     # 只生成指定的
    python scripts/dressup_generate.py --missing                    # 清單裡還沒有原圖的全部

讀 docs/style_reference/2026q3_pixel_curated/dressup/manifest.json：每個部件的
prompt 套進 edit_prompt，叫模型在素體上「只加這一樣、塗成綠色」，存成 raw/<id>.png。
生完先打開看過（三個人位置沒動、部件全是綠的、其他地方沒被改），
不滿意就改 prompt 重跑；滿意了再跑 scripts/dressup_build.py。
"""

from __future__ import annotations

import argparse
import base64
import io
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import console_encoding  # noqa: E402,F401
import dressup  # noqa: E402
import garment_gen as gg  # noqa: E402
from PIL import Image  # noqa: E402


def generate(part: dict, manifest: dict) -> str:
    base = Image.open(dressup.DRESSUP_DIR / manifest["base"]).convert("RGB")
    model = gg._resolve_model(gg._config.FULL_CHARACTER_MODEL, gg._config.OUTFIT_GEN_MODEL)
    res = gg._call_image_chat_multi(
        [gg._pil_to_data_url(base)], manifest["edit_prompt"].format(part=part["prompt"]), model=model,
        generation_params={"extra_body": {"image_config": {"aspect_ratio": "16:9"}}}, with_metadata=True,
    )
    b64 = res.get("image_b64")
    usage = res.get("api_usage") or {}
    if not b64:
        return f"{part['id']}：失敗（{res.get('error')}）"
    dressup.RAW_DIR.mkdir(parents=True, exist_ok=True)
    Image.open(io.BytesIO(base64.b64decode(b64))).save(dressup.RAW_DIR / f"{part['id']}.png")
    return f"{part['id']}：完成　US${usage.get('cost_usd')}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", help="要生成的部件 id（manifest.json 的 parts[].id）")
    parser.add_argument("--missing", action="store_true", help="生成清單裡還沒有原圖的全部部件")
    args = parser.parse_args()

    manifest = dressup.load_manifest()
    parts = {p["id"]: p for p in manifest["parts"]}
    ids = list(args.ids)
    if args.missing:
        ids += [pid for pid in parts if not (dressup.RAW_DIR / f"{pid}.png").exists()]
    unknown = [i for i in ids if i not in parts]
    if unknown:
        print(f"manifest.json 裡沒有：{', '.join(unknown)}")
        return 1
    if not ids:
        print("沒有要生成的部件。給 id，或加 --missing")
        return 0
    print(f"生成 {len(ids)} 張，約 US${len(ids) * 0.07:.2f}")
    with ThreadPoolExecutor(4) as pool:
        for line in pool.map(lambda pid: generate(parts[pid], manifest), ids):
            print("  " + line)
    print("看過 raw/ 裡的圖之後，跑 python scripts/dressup_build.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
