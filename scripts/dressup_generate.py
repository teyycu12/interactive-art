"""生成素體換裝的部件原圖（會呼叫生圖 API、花錢：每張約 US$0.07）。

用法（專案根目錄）：
    python scripts/dressup_generate.py hair_afro acc_earrings     # 只生成指定的
    python scripts/dressup_generate.py --missing                    # 清單裡還沒有原圖的全部
    python scripts/dressup_generate.py --base female --missing      # 在女生素體上畫
    python scripts/dressup_generate.py --new-base female -n 2       # 生成新素體的候選圖（見 dressup_make_base.py）

讀 docs/style_reference/2026q3_pixel_curated/dressup/manifest.json：每個部件的
prompt 套進 edit_prompt，叫模型在素體上「只加這一樣、塗成綠色」，存成 raw/<id>.png
（第一個以外的素體存在 raw/<素體>/<id>.png）。
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


def _call(base_img: Image.Image, prompt: str) -> dict:
    model = gg._resolve_model(gg._config.FULL_CHARACTER_MODEL, gg._config.OUTFIT_GEN_MODEL)
    return gg._call_image_chat_multi(
        [gg._pil_to_data_url(base_img)], prompt, model=model,
        generation_params={"extra_body": {"image_config": {"aspect_ratio": "16:9"}}}, with_metadata=True,
    )


def generate(part: dict, manifest: dict, base_id: str) -> str:
    base = Image.fromarray(dressup.base_canvas(manifest, base_id))
    prompt = manifest["edit_prompt"].format(part=part["prompt"])
    # 素體自己的補充說明（女生素體原本就有中長髮：新髮型要整個換掉，不是疊上去）
    note = next(b for b in manifest["bases"] if b["id"] == base_id).get("edit_note")
    if note:
        prompt += " " + note
    res = _call(base, prompt)
    b64 = res.get("image_b64")
    usage = res.get("api_usage") or {}
    if not b64:
        return f"{part['id']}：失敗（{res.get('error')}）"
    out = dressup.raw_dir(base_id)
    out.mkdir(parents=True, exist_ok=True)
    Image.open(io.BytesIO(base64.b64decode(b64))).save(out / f"{part['id']}.png")
    return f"{part['id']}：完成　US${usage.get('cost_usd')}"


def new_base(base_id: str, index: int, manifest: dict) -> str:
    """新素體的候選圖：拿第一個素體照 bases[].prompt 改，存 raw/<素體>/_base_<n>.png。"""
    spec = next(b for b in manifest["bases"] if b["id"] == base_id)
    res = _call(Image.fromarray(dressup.base_canvas(manifest)), spec["prompt"])
    b64 = res.get("image_b64")
    if not b64:
        return f"候選 {index}：失敗（{res.get('error')}）"
    out = dressup.RAW_DIR / base_id
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"_base_{index}.png"
    Image.open(io.BytesIO(base64.b64decode(b64))).save(path)
    return f"候選 {index}：{path.relative_to(ROOT)}　US${(res.get('api_usage') or {}).get('cost_usd')}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", help="要生成的部件 id（manifest.json 的 parts[].id）")
    parser.add_argument("--missing", action="store_true", help="生成清單裡還沒有原圖的全部部件")
    parser.add_argument("--base", help="在哪個素體上畫（manifest 的 bases；預設第一個）")
    parser.add_argument("--new-base", help="改成生成這個新素體的候選圖")
    parser.add_argument("-n", type=int, default=2, help="--new-base 要幾張候選")
    args = parser.parse_args()

    manifest = dressup.load_manifest()
    known_bases = [b["id"] for b in manifest["bases"]]
    if args.new_base:
        if args.new_base not in known_bases[1:]:
            print(f"manifest.json 的 bases 裡沒有 {args.new_base}（第一個素體是原本就有的，不能重生）")
            return 1
        print(f"生成 {args.n} 張候選，約 US${args.n * 0.07:.2f}")
        with ThreadPoolExecutor(4) as pool:
            for line in pool.map(lambda i: new_base(args.new_base, i, manifest), range(1, args.n + 1)):
                print("  " + line)
        print(f"挑一張之後跑 python scripts/dressup_make_base.py {args.new_base} <候選圖>")
        return 0
    base_id = args.base or known_bases[0]
    if base_id not in known_bases:
        print(f"manifest.json 的 bases 裡沒有 {base_id}")
        return 1
    # 臉的部件是手畫格子圖，不生成
    parts = {p["id"]: p for p in manifest["parts"] if p["category"] not in dressup.FACE_CATEGORIES}
    ids = list(args.ids)
    if args.missing:
        ids += [pid for pid in parts if not (dressup.raw_dir(base_id) / f"{pid}.png").exists()]
    unknown = [i for i in ids if i not in parts]
    if unknown:
        print(f"manifest.json 裡沒有：{', '.join(unknown)}")
        return 1
    if not ids:
        print("沒有要生成的部件。給 id，或加 --missing")
        return 0
    print(f"在 {base_id} 素體上生成 {len(ids)} 張，約 US${len(ids) * 0.07:.2f}")
    with ThreadPoolExecutor(4) as pool:
        for line in pool.map(lambda pid: generate(parts[pid], manifest, base_id), ids):
            print("  " + line)
    flag = "" if base_id == known_bases[0] else f" --base {base_id}"
    print(f"看過 {dressup.raw_dir(base_id).relative_to(ROOT)} 裡的圖之後，跑 python scripts/dressup_build.py{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
