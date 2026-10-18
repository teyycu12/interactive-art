"""這一份程式與像素參考圖的指紋。

給 scripts/doctor.py 比對「每台電腦是不是同一套」用（2026-10-18 組員回報畫風
不一樣，查了模型、版本才排除）。生成服務啟動時記下一份放進 /health：
參考圖在服務啟動後第一次生成時就讀進記憶體，git pull 換了圖卻沒重開服務，
硬碟上是新圖、生成用的是舊圖 —— 兩份指紋一比就看得出來，肉眼看不出來。
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIXEL_REFERENCE_DIR = ROOT / "docs" / "style_reference" / "2026q3_pixel_curated"
_IMAGE_SUFFIXES = {".png", ".webp"}


def git_commit() -> str:
    """目前的 commit（短碼）。不是 git 工作區或沒裝 git 時回傳 "unknown"。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def reference_fingerprint(folder: Path = PIXEL_REFERENCE_DIR) -> str:
    """參考圖集與素體的指紋：資料夾第一層每張圖的檔名＋內容。缺資料夾回傳 "missing"。

    只看第一層：_original/ 是整理前的原稿，生成時不會送出去。"""
    if not folder.is_dir():
        return "missing"
    digest = hashlib.sha256()
    for path in sorted(folder.iterdir()):
        if path.is_file() and path.suffix.lower() in _IMAGE_SUFFIXES:
            digest.update(path.name.encode("utf-8"))
            digest.update(path.read_bytes())
    return digest.hexdigest()[:12]
