"""為既有的角色貼圖補上 fallbackColors，供開發用的人物匯入台使用。

── 為什麼需要這個步驟 ──
生成當下 slicer 會回傳 fallbackColors，但那份資料只存在於那一次的 HTTP 回應裡
（契約 4），落地的只有 head/torso/legs/full 四張 webp。因此把過去生成的角色重新
放回場上時，顏色就缺了一塊 —— 而 `shared/colorFamily.js` 的色族判定讀的正是
fallbackColors.torso 與 .legs，也就是顏色任務（COLOR_HUNT）的判定依據。

── 為什麼不在前端取樣 ──
瀏覽器拿得到 full.webp，用 canvas 取色看似更省事，但那等於把
`backend/slicer.py` 的 sample_fallback_colors 在第二個語言再實作一次。取樣區域
或中位數算法只要有一點差，顏色任務就會叫大家去找「紅色衣服的人」，而那個人在
畫面上是藍的 —— 兩邊都不會報錯。這與切片比例的跨語言耦合是同一個坑
（見 CLAUDE.md 開頭三條）。

因此改為離線跑一次，把結果寫成 colors.json 放在貼圖旁邊，由 Node 端直接讀取。
好處是匯入台不需要生成服務在跑（開發時常常只起 Node）。

用法：
    python scripts/asset_colors.py              # 補齊還沒有 colors.json 的
    python scripts/asset_colors.py --force      # 全部重新取樣
"""

from __future__ import annotations

import json
import os
import re
import sys

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)

import console_encoding  # noqa: E402,F401  匯入即修正 Windows 主控台編碼
from PIL import Image  # noqa: E402

from slicer import normalize, sample_fallback_colors, slice_parts  # noqa: E402

REPO_ROOT = os.path.dirname(BACKEND)
ASSET_DIR = os.path.join(REPO_ROOT, "public", "assets", "gen")

# 與 shared/avatars.js 的 TEXTURE_URL_RE 同一組字元集：資產目錄名是 uuid4().hex
ASSET_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def sample_one(asset_dir: str) -> dict[str, str]:
    """對單一資產目錄取樣。以 full.webp 為輸入，與生成當下的來源影像一致。"""
    with Image.open(os.path.join(asset_dir, "full.webp")) as raw:
        img = normalize(raw.convert("RGBA"))
    return sample_fallback_colors(slice_parts(img))


def main() -> int:
    force = "--force" in sys.argv
    if not os.path.isdir(ASSET_DIR):
        print(f"找不到貼圖目錄：{ASSET_DIR}")
        return 1

    done = skipped = failed = 0
    for name in sorted(os.listdir(ASSET_DIR)):
        asset_dir = os.path.join(ASSET_DIR, name)
        if not os.path.isdir(asset_dir) or not ASSET_ID_RE.match(name):
            continue
        if not os.path.isfile(os.path.join(asset_dir, "full.webp")):
            continue
        out_path = os.path.join(asset_dir, "colors.json")
        if os.path.exists(out_path) and not force:
            skipped += 1
            continue
        try:
            colors = sample_one(asset_dir)
        except Exception as e:  # 單一張壞掉不該讓整批停下來
            print(f"  ✗ {name}：{e!r}")
            failed += 1
            continue
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(colors, f, ensure_ascii=False)
        print(f"  ✓ {name}  {colors['torso']} / {colors['legs']}")
        done += 1

    print(f"\n取樣 {done} 個，跳過 {skipped} 個（已有 colors.json），失敗 {failed} 個")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
