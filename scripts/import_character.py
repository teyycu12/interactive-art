"""把主辦端匯出的角色檔（.persona.json）還原成可以上場的角色。

角色檔由主辦端「系統 → 角色生成紀錄 → 角色檔」下載，內含四張貼圖、預覽圖與外觀設定
（格式見 backend/character_export.py）。還原後貼圖落在 public/assets/gen/<assetId>/，
開發用的人物匯入台（/dev/）就會列出這個角色，可以直接放上場。

用法：
    python scripts/import_character.py character-9eb2a99a.persona.json
    python scripts/import_character.py *.persona.json --force   # 已存在也覆蓋

⚠ 匯入的角色是開發／展示用。現場請勿把別人的角色放上場佔用人數上限
  （與 scripts/bots.mjs 同一個理由）。
"""

from __future__ import annotations

import json
import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
sys.path.insert(0, BACKEND)

import console_encoding  # noqa: E402,F401  匯入即修正 Windows 主控台編碼

from character_export import ExportError, avatar_config, load_or_sample_colors, restore_bundle  # noqa: E402

REPO_ROOT = os.path.dirname(BACKEND)
ASSET_DIR = os.path.join(REPO_ROOT, "public", "assets", "gen")


def main(argv: list[str]) -> int:
    force = "--force" in argv
    paths = [a for a in argv if a != "--force"]
    if not paths:
        print(__doc__)
        return 1

    failed = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                bundle = json.load(f)
            asset_id = restore_bundle(bundle, ASSET_DIR, overwrite=force)
        except (OSError, ValueError) as e:
            print(f"✗ {path}：讀不到檔案或不是合法的 JSON（{e}）")
            failed += 1
            continue
        except ExportError as e:
            hint = "（加 --force 覆蓋）" if e.code == "asset_exists" else ""
            print(f"✗ {path}：{e}{hint}")
            failed += 1
            continue
        colors = load_or_sample_colors(os.path.join(ASSET_DIR, asset_id))
        print(f"✓ {path} → public/assets/gen/{asset_id}/")
        print(f"  外觀設定：{json.dumps(avatar_config(asset_id, colors), ensure_ascii=False)}")

    if failed == 0:
        print("\n完成。開 /dev/ 的人物匯入台就能把角色放上場。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
