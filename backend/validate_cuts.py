"""切片比例驗證工具（整合計畫階段 2 / 計畫書 §3.3 的 R1 驗收項）。

回答一個問題：**固定比例的裁切框，在實際生成結果上夠不夠穩定？**

用法
----
    # 已經有生成好的人偶圖（去背 PNG）
    python backend/validate_cuts.py --sprites samples/ --sheet report.png

    # 只有原始照片，先透過生成服務跑一輪再驗（需服務已啟動且金鑰已設定）
    python backend/validate_cuts.py --photos photos/ --out samples/

判準
----
量測每張圖的肩線與胯線落在全身高度的哪個比例，看兩件事：

  1. **離散程度**（標準差）—— 各張之間是否一致。不一致代表固定框會時對時錯。
  2. **系統性偏移**（平均值 vs 設定值）—— 即使每張都一致，若整體平均與
     slicer.CUTS 的邊界差很多，那是固定框「穩定地切錯位置」，
     這種情況不需要偵測步驟，把 CUTS 調到量到的平均即可。

只看標準差會漏掉第 2 種情況，所以兩個都報。
"""

from __future__ import annotations

# 必須在任何 print 之前 —— 見該模組的說明。
try:
    from backend import console_encoding  # noqa: F401
except ImportError:
    import console_encoding  # noqa: F401


import argparse
import base64
import glob
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image as PILImage, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from slicer import CUTS, NORMALIZED_HEIGHT, analyze_cuts, normalize  # noqa: E402

# 標準差判準。頭部區間佔全身 30%，肩線偏移 4% 等於錯開頭部區間的 13%，
# 那個程度肉眼就看得出脖子錯位；2% 以內則落在可接受範圍。
STD_GOOD = 0.02
STD_BORDERLINE = 0.04

# 平均值與設定邊界的容許差距。超過就建議直接改 CUTS，而不是加偵測。
MEAN_DRIFT_TOLERANCE = 0.03


def load_sprites(directory: str) -> List[Tuple[str, PILImage.Image]]:
    """載入資料夾裡所有 PNG（生成結果應為帶 alpha 的去背圖）。"""
    out: List[Tuple[str, PILImage.Image]] = []
    for path in sorted(glob.glob(os.path.join(directory, "*.png"))):
        try:
            img = PILImage.open(path).convert("RGBA")
        except Exception as e:
            print(f"  ⚠️  跳過 {os.path.basename(path)}：{e}")
            continue
        if np.asarray(img)[:, :, 3].max() == 0:
            print(f"  ⚠️  跳過 {os.path.basename(path)}：整張全透明")
            continue
        out.append((os.path.basename(path), img))
    return out


def generate_from_photos(photo_dir: str, out_dir: str, service_url: str) -> int:
    """把原始照片送進生成服務，把回傳的人偶圖存下來供後續驗證。

    這裡刻意打 /generate 而非直接呼叫 garment_gen：驗證的對象應該是
    「現場真正會跑的那條路徑」，包含服務層的前處理在內。
    """
    os.makedirs(out_dir, exist_ok=True)
    patterns = ("*.jpg", "*.jpeg", "*.png", "*.heic", "*.HEIC")
    photos = sorted(p for pat in patterns for p in glob.glob(os.path.join(photo_dir, pat)))
    if not photos:
        print(f"❌ {photo_dir} 裡沒有找到照片")
        return 0

    saved = 0
    for i, path in enumerate(photos, 1):
        name = os.path.basename(path)
        with open(path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        body = json.dumps({"image": f"data:image/jpeg;base64,{b64}"}).encode()
        req = urllib.request.Request(
            service_url, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                result = json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  [{i}/{len(photos)}] {name} → 服務呼叫失敗：{e}")
            continue

        if not result.get("ok"):
            print(f"  [{i}/{len(photos)}] {name} → 生成失敗：{result.get('error')}")
            continue

        # 服務回傳的是切好的三張。驗證需要的是「切之前的整張」，
        # 因此把三張依 CUTS 疊回去還原成全身圖。
        asset_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "public", "assets", "gen",
            result["assetId"],
        )
        try:
            merged = _merge_parts(asset_dir)
        except Exception as e:
            print(f"  [{i}/{len(photos)}] {name} → 合併失敗：{e}")
            continue
        merged.save(os.path.join(out_dir, f"{i:03d}_{os.path.splitext(name)[0]}.png"))
        saved += 1
        print(f"  [{i}/{len(photos)}] {name} → OK")

    return saved


def _merge_parts(asset_dir: str) -> PILImage.Image:
    """把 head / torso / legs 依 CUTS 的比例疊回一張全身圖。"""
    parts = {p: PILImage.open(os.path.join(asset_dir, f"{p}.png")).convert("RGBA") for p in CUTS}
    width = max(im.width for im in parts.values())
    canvas = PILImage.new("RGBA", (width, NORMALIZED_HEIGHT), (0, 0, 0, 0))
    for part, (top, bottom) in CUTS.items():
        y0 = round(top * NORMALIZED_HEIGHT)
        y1 = round(bottom * NORMALIZED_HEIGHT)
        canvas.paste(parts[part].resize((width, y1 - y0)), (0, y0))
    return canvas


def build_contact_sheet(samples: List[Tuple[str, PILImage.Image]],
                        stats: Dict[str, Any], path: str, cols: int = 5) -> None:
    """輸出對照圖：紅線是設定的固定裁切框，綠線是各張實際量到的位置。

    數字看不出來的東西，疊在圖上一眼就分得出 —— 例如「標準差不大但整體
    偏低」會表現成所有綠線都整齊地落在紅線下方。
    """
    if not samples:
        return
    thumb_h = 240
    thumb_w = 140
    pad = 10
    rows = (len(samples) + cols - 1) // cols
    sheet = PILImage.new(
        "RGB", (cols * (thumb_w + pad) + pad, rows * (thumb_h + pad + 14) + pad), (250, 248, 245)
    )
    draw = ImageDraw.Draw(sheet)

    for idx, (name, img) in enumerate(samples):
        try:
            norm = normalize(img, thumb_h)
        except ValueError:
            continue
        norm.thumbnail((thumb_w, thumb_h))
        x = pad + (idx % cols) * (thumb_w + pad)
        y = pad + (idx // cols) * (thumb_h + pad + 14)
        cell = PILImage.new("RGB", (thumb_w, thumb_h), (255, 255, 255))
        cell.paste(norm, ((thumb_w - norm.width) // 2, 0), norm)
        sheet.paste(cell, (x, y))

        # 設定的固定邊界（紅）
        for _, bottom in list(CUTS.values())[:-1]:
            yy = y + round(bottom * thumb_h)
            draw.line([(x, yy), (x + thumb_w, yy)], fill=(220, 60, 50), width=1)
        # 實際量到的肩線與胯線（綠）
        for key, series in (("shoulders", stats["shoulders"]), ("hips", stats["hips"])):
            if idx < len(series):
                yy = y + round(series[idx] * thumb_h)
                draw.line([(x, yy), (x + thumb_w, yy)], fill=(40, 160, 90), width=1)

        draw.text((x, y + thumb_h + 2), name[:22], fill=(90, 85, 80))

    sheet.save(path)
    print(f"\n對照圖已輸出：{path}（紅=設定的裁切框，綠=實際量到的位置）")


def verdict(stats: Dict[str, Any]) -> int:
    """依量測結果給出結論。回傳 0 表示固定裁切框可用。"""
    print("\n" + "=" * 58)
    print(f"樣本數：{stats['samples']}")
    if stats["samples"] < 2:
        print("❌ 樣本太少，無法判斷離散程度（計畫書建議約 20 張）")
        return 1

    configured = {"shoulder": CUTS["head"][1], "hip": CUTS["torso"][1]}
    worst = 0

    for key, label in (("shoulder", "肩線（頭↔軀幹）"), ("hip", "胯線（軀幹↔腿）")):
        s = stats[key]
        drift = s["mean"] - configured[key]
        print(f"\n{label}")
        print(f"  設定值 {configured[key]:.3f}　實測平均 {s['mean']:.3f}"
              f"（偏移 {drift:+.3f}）")
        print(f"  標準差 {s['std']:.4f}　範圍 {s['min']:.3f} ~ {s['max']:.3f}")

        if s["std"] <= STD_GOOD:
            print("  ✅ 離散度低，各張之間一致")
        elif s["std"] <= STD_BORDERLINE:
            print("  ⚠️  離散度偏高，建議看對照圖確認")
            worst = max(worst, 1)
        else:
            print("  ❌ 離散度過高，固定裁切框會時對時錯 → 需要加入偵測步驟")
            worst = max(worst, 2)

        if abs(drift) > MEAN_DRIFT_TOLERANCE:
            print(f"  ❌ 系統性偏移：建議把 slicer.CUTS 的這個邊界改成 {s['mean']:.2f}")
            worst = max(worst, 2)

    print("\n" + "=" * 58)
    if worst == 0:
        print("結論：固定裁切框足夠，不需要加入偵測步驟。")
    elif worst == 1:
        print("結論：大致可用，但請看對照圖確認邊界沒有切到關鍵部位。")
    else:
        print("結論：固定裁切框不夠穩定，需要調整 CUTS 或加入偵測步驟。")
    return worst


def main() -> int:
    ap = argparse.ArgumentParser(description="驗證固定裁切比例在實際生成結果上的穩定度")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sprites", help="已生成的人偶圖資料夾（去背 PNG）")
    src.add_argument("--photos", help="原始照片資料夾，先送進生成服務再驗")
    ap.add_argument("--out", default="samples", help="--photos 模式下生成結果的存放位置")
    ap.add_argument("--service", default="http://127.0.0.1:5055/generate", help="生成服務網址")
    ap.add_argument("--sheet", help="輸出對照圖的路徑（PNG）")
    args = ap.parse_args()

    sprite_dir = args.sprites
    if args.photos:
        print(f"正在透過生成服務處理 {args.photos} …")
        n = generate_from_photos(args.photos, args.out, args.service)
        print(f"\n成功生成 {n} 張 → {args.out}")
        if n == 0:
            return 1
        sprite_dir = args.out

    print(f"\n讀取樣本：{sprite_dir}")
    samples = load_sprites(sprite_dir)
    if not samples:
        print("❌ 沒有可用的樣本")
        return 1
    print(f"  載入 {len(samples)} 張")

    stats = analyze_cuts([img for _, img in samples])
    code = verdict(stats)
    if args.sheet:
        build_contact_sheet(samples, stats, args.sheet)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
