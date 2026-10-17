"""匯出／匯入生成過的角色（主辦端「角色生成紀錄」的匯出按鈕）。

兩種匯出：

圖檔（PNG）
    給人看、拿去做海報或簡報用。取 preview.webp —— 模型輸出的原始尺寸，
    比場上用的 full.webp（縮到 1024）清楚；舊資產沒有 preview 時退回 full。

角色檔（.persona.json）
    給程式跑的。一份 JSON 同時帶兩樣東西：

    - ``avatar``：與手機端 CLIENT_JOIN 送出的外觀設定完全同形
      （``source: 'CV'`` + ``textures`` + ``fallbackColors``），
      在同一台伺服器上可以直接拿去進場。
    - ``files``：四張貼圖與預覽圖的 base64。換一台電腦時，
      ``scripts/import_character.py`` 會把它們還原到 public/assets/gen/<id>/，
      角色就出現在開發用的人物匯入台上。

    貼圖不能只帶 URL：``shared/avatars.js`` 的 TEXTURE_URL_RE 只接受
    ``/assets/gen/<32 位十六進位>/<部位>.webp``，檔案不在那台機器的那個目錄裡，
    角色上場就是一片空白 —— 而驗證會通過，不會有任何錯誤。

fallbackColors 不另外發明算法：讀生成當下落地的 colors.json，沒有的話（改版前的
資產）用 ``slicer.sample_fallback_colors`` 從 full.webp 重新取樣並補寫一份。
在這裡另寫一套取色會變成跨語言／跨模組的耦合，顏色任務的判定讀的正是這組顏色
（見 scripts/asset_colors.py 開頭的說明）。
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import time
from typing import Any, Dict, Optional

from PIL import Image

from slicer import normalize, sample_fallback_colors, slice_parts

FORMAT = "pixelair-character"
# 改名前（PersonaFlow）匯出的角色檔仍可匯入
LEGACY_FORMATS = ("personaflow-character",)
FORMAT_VERSION = 1

# 與 shared/avatars.js 的 TEXTURE_URL_RE 同一組字元集：資產目錄名是 uuid4().hex
ASSET_ID_RE = re.compile(r"^[0-9a-f]{32}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
COLOR_KEYS = ("skin", "hair", "torso", "legs")

# 上場必要的四張貼圖（缺一張 validateAvatarConfig 就會拒絕）
TEXTURE_PARTS = ("head", "torso", "legs", "full")
# 匯出時一併帶走、但不是上場必要的檔案
OPTIONAL_FILES = ("preview.webp",)

# 單一檔案的上限。實測貼圖 30–120 KB、預覽圖約 200 KB；
# 匯入時擋掉離譜的檔案，避免有人拿一個 1 GB 的 JSON 塞爆磁碟。
MAX_FILE_BYTES = 5 * 1024 * 1024


class ExportError(Exception):
    """匯出／匯入失敗。``code`` 是給 API 回應用的穩定錯誤碼。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def asset_dir_for(asset_root: str, asset_id: str) -> str:
    """回傳資產目錄的絕對路徑。asset_id 不合格式或目錄不存在都拋 ExportError。"""
    if not isinstance(asset_id, str) or not ASSET_ID_RE.match(asset_id):
        raise ExportError("invalid_asset_id")
    path = os.path.join(asset_root, asset_id)
    if not os.path.isdir(path):
        raise ExportError("asset_not_found")
    return path


def valid_colors(raw: Any) -> Optional[Dict[str, str]]:
    """四個鍵齊全且都是 #RRGGBB 才算數，否則回 None。"""
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in COLOR_KEYS:
        value = raw.get(key)
        if not isinstance(value, str) or not HEX_RE.match(value):
            return None
        out[key] = value
    return out


def load_or_sample_colors(out_dir: str) -> Dict[str, str]:
    """讀 colors.json；沒有或壞掉時從 full.webp 重新取樣，並補寫回去。"""
    colors_path = os.path.join(out_dir, "colors.json")
    try:
        with open(colors_path, encoding="utf-8") as f:
            colors = valid_colors(json.load(f))
        if colors:
            return colors
    except (OSError, ValueError):
        pass

    full_path = os.path.join(out_dir, "full.webp")
    if not os.path.isfile(full_path):
        raise ExportError("asset_incomplete", "缺少 full.webp，無法取樣顏色")
    with Image.open(full_path) as raw:
        img = normalize(raw.convert("RGBA"))
    colors = sample_fallback_colors(slice_parts(img))
    try:
        with open(colors_path, "w", encoding="utf-8") as f:
            json.dump(colors, f, ensure_ascii=False)
    except OSError:
        pass  # 寫不進去只是下次要再取樣一次，不影響這次匯出
    return colors


def avatar_config(asset_id: str, colors: Dict[str, str], url_prefix: str = "/assets/gen") -> Dict[str, Any]:
    """與手機端 CLIENT_JOIN 的外觀設定同形（見 shared/avatars.js validateCVAvatar）。"""
    return {
        "source": "CV",
        "textures": {part: f"{url_prefix}/{asset_id}/{part}.webp" for part in TEXTURE_PARTS},
        "fallbackColors": colors,
    }


def build_bundle(asset_root: str, asset_id: str, run: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """組出角色檔。``run`` 是生成紀錄那一筆（可為 None），只取幾個說明用的欄位。"""
    out_dir = asset_dir_for(asset_root, asset_id)
    files: Dict[str, str] = {}
    for name in [f"{p}.webp" for p in TEXTURE_PARTS] + list(OPTIONAL_FILES):
        path = os.path.join(out_dir, name)
        if not os.path.isfile(path):
            if name in OPTIONAL_FILES:
                continue
            raise ExportError("asset_incomplete", f"缺少 {name}")
        with open(path, "rb") as f:
            files[name] = base64.b64encode(f.read()).decode("ascii")

    run = run or {}
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "assetId": asset_id,
        "exportedAt": time.time(),
        "generation": {
            "createdAt": run.get("created_at"),
            "model": run.get("model"),
            "styleId": run.get("style_id"),
            "mode": run.get("mode"),
        },
        "avatar": avatar_config(asset_id, load_or_sample_colors(out_dir)),
        "files": files,
    }


def image_png(asset_root: str, asset_id: str) -> bytes:
    """角色圖檔（PNG，保留透明背景）。預覽圖優先，沒有就用場上的 full.webp。"""
    out_dir = asset_dir_for(asset_root, asset_id)
    for name in ("preview.webp", "full.webp"):
        path = os.path.join(out_dir, name)
        if os.path.isfile(path):
            with Image.open(path) as img:
                buf = io.BytesIO()
                img.convert("RGBA").save(buf, "PNG", optimize=True)
                return buf.getvalue()
    raise ExportError("asset_incomplete", "找不到角色圖")


def restore_bundle(bundle: Any, asset_root: str, *, overwrite: bool = False) -> str:
    """把角色檔還原到 asset_root/<assetId>/。回傳 assetId。

    檔名一律以白名單比對（不是拿 JSON 裡的名字去組路徑），
    內容一律先以 Pillow 解開確認真的是圖 —— 角色檔可能來自別台電腦，
    不能讓它決定寫到哪裡、寫進什麼。
    """
    if not isinstance(bundle, dict) or bundle.get("format") not in (FORMAT, *LEGACY_FORMATS):
        raise ExportError("not_a_character_file", "這不是 PixelAir 的角色檔")
    if bundle.get("version") != FORMAT_VERSION:
        raise ExportError("unsupported_version", f"不支援的角色檔版本：{bundle.get('version')}")

    asset_id = bundle.get("assetId")
    if not isinstance(asset_id, str) or not ASSET_ID_RE.match(asset_id):
        raise ExportError("invalid_asset_id")

    files = bundle.get("files")
    if not isinstance(files, dict):
        raise ExportError("asset_incomplete", "角色檔沒有附帶貼圖")
    allowed = [f"{p}.webp" for p in TEXTURE_PARTS] + list(OPTIONAL_FILES)
    decoded: Dict[str, bytes] = {}
    for name in allowed:
        raw = files.get(name)
        if raw is None:
            if name in OPTIONAL_FILES:
                continue
            raise ExportError("asset_incomplete", f"角色檔缺少 {name}")
        if not isinstance(raw, str) or len(raw) > MAX_FILE_BYTES * 4 // 3 + 4:
            raise ExportError("file_too_large", f"{name} 太大")
        try:
            data = base64.b64decode(raw, validate=True)
            with Image.open(io.BytesIO(data)) as img:
                if img.format != "WEBP":
                    raise ExportError("bad_image", f"{name} 不是 WEBP 圖檔")
                img.verify()
        except ExportError:
            raise
        except Exception as e:  # base64 或圖檔損壞
            raise ExportError("bad_image", f"{name} 無法解開：{e}") from e
        decoded[name] = data

    out_dir = os.path.join(asset_root, asset_id)
    if os.path.isdir(out_dir) and not overwrite:
        raise ExportError("asset_exists", f"這個角色已經存在：{out_dir}")
    os.makedirs(out_dir, exist_ok=True)
    for name, data in decoded.items():
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(data)

    # 顏色以角色檔帶的為準（那是原機器取樣的結果）；不合格就在這台重新取樣
    colors = valid_colors((bundle.get("avatar") or {}).get("fallbackColors"))
    if colors:
        with open(os.path.join(out_dir, "colors.json"), "w", encoding="utf-8") as f:
            json.dump(colors, f, ensure_ascii=False)
    else:
        load_or_sample_colors(out_dir)
    return asset_id
