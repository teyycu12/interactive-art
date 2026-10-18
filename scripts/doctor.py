"""開機前的自我檢查：這台電腦跟主機是不是同一套。

用法（專案根目錄）：npm run doctor    或    python scripts/doctor.py

印出一份清單，最後一行是「指紋」—— 各台電腦把那一行貼在一起，一樣就是同一套。
金鑰只檢查有沒有、格式對不對，絕不印出內容。

為什麼要有：組員回報「畫風跟主機不一樣」，查了一輪才排除模型與版本
（2026-10-18）。會讓生成結果不同、但畫面上看不出原因的設定都列在這裡，
其中最難抓的是「git pull 了但沒重開服務」：硬碟上是新版，跑的是舊版。
"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import sys
import urllib.request
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import console_encoding  # noqa: E402,F401  Windows 主控台印得出中文
import build_info  # noqa: E402

# 主機（生成一直很穩的那台）的設定。這裡改了，每台都要跟著改
EXPECTED_MODEL = "google/gemini-3.1-flash-image"
EXPECTED_STYLES = ["pixel"]
EXPECTED_NODE_MAJOR = 20
EXPECTED_PYTHON = (3, 11)
# 留空就是用程式預設值；設了任何值都可能換掉參考圖或風格
MUST_BE_UNSET = (
    "CHARACTER_STYLE", "ENABLED_STYLES", "STYLE_REFERENCE_SET", "STYLE_REFERENCE_MODE",
    "OPENAI_BASE_URL", "FULL_MODE_VLM_ENABLED", "BACKUP_IMAGE_MODEL",
)
PACKAGES = ("mediapipe", "openai", "pillow", "numpy", "opencv-python", "flask")

failures = 0
warnings = 0


def ok(text):
    print(f"  [OK] {text}")


def warn(text):
    global warnings
    warnings += 1
    print(f"  [!!] {text}")


def fail(text):
    global failures
    failures += 1
    print(f"  [XX] {text}")


def run(*cmd, strip=True):
    try:
        out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=15)
        return out.stdout.strip() if strip else out.stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def env_keys(path: Path) -> dict:
    """一個 .env 檔裡設了哪些鍵（值只拿來判斷有沒有填，不印）。"""
    keys = {}
    if not path.is_file():
        return keys
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        keys[key.strip()] = value.split("#", 1)[0].strip().strip("'\"")
    return keys


def fetch_json(url: str):
    context = ssl._create_unverified_context()  # 自簽憑證：只是本機自我檢查
    try:
        with urllib.request.urlopen(url, timeout=3, context=context) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


print("\n== 程式版本")
commit = build_info.git_commit()
branch = run("git", "rev-parse", "--abbrev-ref", "HEAD")
print(f"  分支 {branch}　commit {commit}")
if branch != "main":
    warn(f"不在 main 上（{branch}）。主機跑的是 main 的話，請 git checkout main")
changed = [line[3:] for line in run("git", "status", "--porcelain", strip=False).splitlines()
           if line and not line.startswith("??")]
if changed:
    warn(f"有 {len(changed)} 個檔案改過還沒 commit：{', '.join(changed[:5])}"
         + (" …" if len(changed) > 5 else ""))
else:
    ok("沒有本機改動")
if run("git", "fetch", "-q", "origin", "main") == "" and branch == "main":
    behind = run("git", "rev-list", "--count", "HEAD..origin/main")
    if behind and behind != "0":
        fail(f"main 落後遠端 {behind} 筆，請 git pull，然後兩個服務都重開")
    elif behind == "0":
        ok("main 是最新的")

print("\n== 執行環境")
node = run("node", "-v")
if node.startswith(f"v{EXPECTED_NODE_MAJOR}."):
    ok(f"Node {node}")
else:
    warn(f"Node {node or '找不到'}（主機是 {EXPECTED_NODE_MAJOR} 版）")
py = sys.version_info
if (py.major, py.minor) == EXPECTED_PYTHON:
    ok(f"Python {py.major}.{py.minor}.{py.micro}")
else:
    warn(f"Python {py.major}.{py.minor}.{py.micro}（主機是 {EXPECTED_PYTHON[0]}.{EXPECTED_PYTHON[1]}）")
versions = []
for name in PACKAGES:
    try:
        versions.append(f"{name} {metadata.version(name)}")
    except metadata.PackageNotFoundError:
        fail(f"缺套件 {name}：pip install -r requirements.txt")
print("  套件：" + "、".join(versions))

print("\n== .env 設定")
root_env, backend_env = env_keys(ROOT / ".env"), env_keys(ROOT / "backend" / ".env")
if root_env:
    # 生成服務先讀根目錄的 .env，同名的設定以它為準（backend/config.py）
    fail("專案根目錄有 .env，它會蓋過 backend/.env。請刪掉或改名，只留 backend/.env")
if not backend_env:
    fail("沒有 backend/.env（或是空的）")

from config import config  # noqa: E402  與生成服務同一套讀法，讀到的就是服務會用的值

key = os.environ.get("OPENAI_API_KEY", "").strip()
if not key:
    fail("OPENAI_API_KEY 沒有填")
elif not key.startswith("sk-or-"):
    fail("OPENAI_API_KEY 不是 OpenRouter 的金鑰（應該是 sk-or- 開頭）")
else:
    ok("OPENAI_API_KEY 是 OpenRouter 的金鑰")
if os.environ.get("GEMINI_API_KEY", "").strip():
    ok("GEMINI_API_KEY 有填")
else:
    warn("GEMINI_API_KEY 沒有填")
if config.FULL_CHARACTER_MODEL == EXPECTED_MODEL:
    ok(f"生圖模型 {config.FULL_CHARACTER_MODEL}")
else:
    fail(f"生圖模型是 {config.FULL_CHARACTER_MODEL}，主機是 {EXPECTED_MODEL}")
extra = [k for k in MUST_BE_UNSET if os.environ.get(k, "").strip()]
if extra:
    fail(f"這些設定主機沒有設，請從 .env 拿掉：{', '.join(extra)}")
else:
    ok("沒有多設會換掉風格或參考圖的設定")

print("\n== 參考圖")
reference = build_info.reference_fingerprint()
if reference == "missing":
    fail(f"找不到 {build_info.PIXEL_REFERENCE_DIR.relative_to(ROOT)}")
else:
    ok(f"像素參考圖與素體 指紋 {reference}")

print("\n== 正在跑的服務")
health = fetch_json("http://127.0.0.1:5055/health")
if health is None:
    warn("生成服務（:5055）沒有在跑，或連不上 —— 啟動後再跑一次這個檢查")
else:
    build = health.get("build") or {}
    if not build:
        fail("生成服務是舊版（/health 沒有版本資訊）：請重開生成服務")
    else:
        if build.get("commit") != commit:
            fail(f"生成服務跑的是 {build.get('commit')}，硬碟上是 {commit}：請重開生成服務")
        elif build.get("reference") != reference:
            fail("生成服務用的參考圖跟硬碟上的不一樣：請重開生成服務")
        else:
            ok("生成服務跑的就是硬碟上這一版")
    if health.get("styles") is not None:
        styles = [s.get("id") for s in health.get("styles", [])]
        (ok if styles == EXPECTED_STYLES else fail)(f"開放的風格 {styles}（主機 {EXPECTED_STYLES}）")
    for item in health.get("degraded") or []:
        warn(f"生成服務回報：{item}")

version = fetch_json("https://localhost:3000/api/version") or fetch_json("http://localhost:3000/api/version")
if version is None:
    warn("互動層（:3000）沒有在跑、連不上，或是舊版 —— 啟動後再跑一次；仍然如此請重開互動層")
elif version.get("commit") != commit:
    fail(f"互動層跑的是 {version.get('commit')}，硬碟上是 {commit}：請重開互動層")
else:
    ok("互動層跑的就是硬碟上這一版")

print("\n== 結果")
print(f"  指紋　commit={commit}　參考圖={reference}　模型={config.FULL_CHARACTER_MODEL}")
print("  （每台電腦的這一行要跟主機一模一樣）")
if failures:
    print(f"  有 {failures} 項要修（[XX]），{warnings} 項提醒（[!!]）")
elif warnings:
    print(f"  沒有要修的，{warnings} 項提醒（[!!]）")
else:
    print("  全部通過")
sys.exit(1 if failures else 0)
