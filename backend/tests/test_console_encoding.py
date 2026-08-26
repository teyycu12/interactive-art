"""主控台編碼：舊代碼頁的終端機不得讓服務起不來。

這裡刻意用子行程而非 monkeypatch sys.stdout —— console_encoding 的修正
發生在 import 階段，模組一旦進了 sys.modules 就不會再跑一次，
在同一個行程裡測等於測不到真正的情境（全新行程的第一次 import）。
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]

# cp950（繁中 Windows）編不出 emoji；cp1252（英文 Windows）連中文都編不出來。
# 兩者都是實際會遇到的預設值，不是刻意刁難的極端案例。
LEGACY_CODEPAGES = ["cp950", "cp1252"]


def _import_in_child(module: str, encoding: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = encoding
    # SECRET_KEY 沒設才會觸發 config.py 在 module 層的那行警告 —— 那正是
    # 現場最可能的狀態（.env 裡沒有這一項），也正是當初炸掉的觸發條件。
    env.pop("SECRET_KEY", None)
    return subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        cwd=str(BACKEND), env=env, capture_output=True,
    )


@pytest.mark.parametrize("encoding", LEGACY_CODEPAGES)
def test_config_imports_on_a_legacy_codepage_console(encoding):
    """config.py 在 import 階段就會 print，例外會炸穿整條 import。

    症狀是 UnicodeEncodeError 而非「SECRET_KEY 沒設」，所以看錯誤訊息
    完全找不到真正的原因；而且服務是連 Flask 都還沒起來就結束。
    """
    r = _import_in_child("config", encoding)
    assert r.returncode == 0, (
        f"{encoding} 主控台下 import config 失敗：\n"
        + r.stderr.decode("utf-8", "replace"))


def test_cli_tool_survives_printing_emoji_on_a_legacy_console(tmp_path):
    """不經過 config 的 CLI 工具各自接了同一個修正，別讓它們漏掉。

    這裡刻意執行到真的會印 emoji 的那一行，而不是只 import ——
    這些工具的 emoji 都在函式裡，光是 import 不會觸發，
    只測 import 的話沒有修正也會過，等於什麼都沒防到。
    """
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "cp950"
    r = subprocess.run(
        [sys.executable, "validate_cuts.py", "--sprites", str(tmp_path)],
        cwd=str(BACKEND), env=env, capture_output=True,
    )
    combined = (r.stdout + r.stderr).decode("utf-8", "replace")
    assert "UnicodeEncodeError" not in combined, combined


def test_import_is_harmless_when_stdout_cannot_reconfigure():
    """pytest 的擷取物件、被重導向的管線都沒有 reconfigure ——
    那些情境本來就不會有編碼問題，但也不能因此拋例外。"""
    code = (
        "import io, sys\n"
        "class Dumb(io.StringIO):\n"
        "    reconfigure = None\n"
        "sys.stdout = Dumb()\n"
        "sys.stderr = Dumb()\n"
        "import console_encoding\n"
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=str(BACKEND),
                       capture_output=True)
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
