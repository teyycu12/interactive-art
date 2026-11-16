"""
預設角色（備援）的產生工具。

為什麼有這個：手機端的「自己換裝」要靠 Python 生成服務組角色，它一掛，新來的人全部
卡在門口（REVIEW-2026-11-15 E3）。這裡把 6 個快速套組預先組好、存成靜態檔放進版控，
生成服務沒回應時手機改成「從這幾個裡選一個先進場」。角色畫法跟換裝完全一樣
（同一條管線、同一種像素風），所以場上仍然只有一種畫法。

這些角色不是照任何人的臉畫的（沒有照片輸入），放進公開的 repo 沒有隱私問題。

用法（需要先啟動生成服務，換裝是本機組圖、不呼叫任何付費 API）：
    VISION_PORT=5055 python backend/service.py &
    python scripts/make_starters.py              # 預設連 127.0.0.1:5055
    python scripts/make_starters.py --port 5058

輸出：public/assets/starters/<id>/{head,torso,legs,full,side,back}.webp + manifest.json
伺服器開機時把這些複製到 public/assets/gen/<id>/（貼圖網址只認那個路徑，見
shared/avatars.js 的 TEXTURE_URL_RE），做法同固定 NPC。

套組內容要跟 public/controller/app.js 的 DU_PRESETS 一致（那邊是手機上的快速套組）。
"""

import argparse
import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "starters"
GEN = ROOT / "public" / "assets" / "gen"

PRESETS = [
    {"base": "female", "label": "女生 A", "selection": {"hair": "hair_long", "bottom": "bottom_skirt", "brows": "brows_thin"},
     "colors": {"bottom": "#2F4C7A", "top": "#F4F1EA"}},
    {"base": "female", "label": "女生 B", "selection": {"hair": "hair_ponytail", "bottom": "bottom_dress", "brows": "brows_soft"},
     "colors": {"bottom": "#E9A9B8"}},
    {"base": "female", "label": "女生 C", "selection": {"hair": "hair_bun", "top": "top_shirt", "bottom": "bottom_shorts", "brows": "brows_thin"},
     "colors": {"top": "#84A98C", "bottom": "#2B2B30"}},
    {"base": "female", "label": "女生 D", "selection": {"hair": "hair_wavy", "outer": "top_hoodie", "bottom": "bottom_skirt", "brows": "brows_soft"},
     "colors": {"outer": "#E9C46A", "bottom": "#6D6875"}},
    {"base": "male", "label": "男生 A", "selection": {"hair": "hair_short_curly", "outer": "top_hoodie", "brows": "brows_thick"},
     "colors": {"outer": "#4A6FA5", "bottom": "#2B2B30"}},
    {"base": "male", "label": "男生 B", "selection": {"hair": "hair_middle_part", "top": "top_shirt", "shoes": "shoes_boots", "brows": "brows_sharp"},
     "colors": {"top": "#F4F1EA", "bottom": "#8B5A2B"}},
]


def call(port, path, payload=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5055)
    args = ap.parse_args()

    catalog = call(args.port, "/dressup/catalog")
    if not catalog.get("ok"):
        sys.exit("讀不到換裝目錄，生成服務有開嗎？")
    categories = catalog["categories"]
    part_by_id = {p["id"]: p for p in catalog["parts"]}

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    manifest = []
    for preset in PRESETS:
        # 跟手機端 applyDuPreset 一樣：先回到素體，再套這一組的部件與顏色，沒畫好的部件略過
        selection = {c["id"]: ([] if c.get("multi") else None) for c in categories}
        for cat, pid in preset["selection"].items():
            part = part_by_id.get(pid)
            if part and part["category"] == cat and (not part.get("bases") or preset["base"] in part["bases"]):
                selection[cat] = pid
        colors = {**catalog["defaults"], **preset["colors"], "acc": {}}
        body = call(args.port, "/dressup", {"base": preset["base"], "selection": selection, "colors": colors})
        if not body.get("ok"):
            sys.exit(f"{preset['label']} 組圖失敗：{body.get('error')}")
        asset_id = body["textures"]["head"].split("/")[3]
        src = GEN / asset_id
        dest = OUT / asset_id
        dest.mkdir()
        # 整個資料夾都帶：貼圖之外還有 arms.json（大螢幕從側面貼圖的網址推得到它）與 colors.json
        for f in src.iterdir():
            if f.name != "preview.webp":
                shutil.copyfile(f, dest / f.name)
        manifest.append({
            "id": asset_id,
            "label": preset["label"],
            "base": preset["base"],
            "fallbackColors": body["fallbackColors"],
            "outfitColors": body.get("outfitColors", []),
        })
        print(f"{preset['label']} → {asset_id}")
        # 生成服務組出來的那份在 gen/ 裡，留著沒用（開機時會從 starters 複製回去）
        shutil.rmtree(src, ignore_errors=True)

    (OUT / "manifest.json").write_text(json.dumps({"starters": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"完成：{len(manifest)} 個，放在 {OUT}")


if __name__ == "__main__":
    main()
