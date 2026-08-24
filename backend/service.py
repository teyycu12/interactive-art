"""角色資產生成服務（整合計畫階段 1）。

參與者拍照 → CV + VLM → 生成去背人偶圖 → 切成三張貼圖 → 回傳契約 4 的 JSON。
互動層（server/，Node.js）以 HTTP 呼叫本服務，透過 /api/generate 代理轉發。

與 app.py 的關係：
    app.py 是整合前的 2D 版本，仍保留為備援（見整合計畫「2D 版本不要刪」）。
    本服務不含 Socket.io、不含 swarm —— 座標與群聚由 Node 端的 M2 共治引擎
    負責。這裡只做「一張照片進、三張貼圖出」這一件事。

為什麼分成獨立行程：
    MediaPipe 在 macOS arm64 上若初始化失敗，是 C++ 層的 abort()，
    Python 的 try/except 完全攔不到。整合前那會連投影牆與所有已連線的
    客戶端一起帶走；現在最壞的情況只是這一次生成請求失敗，
    參與者退回捏臉流程照樣能進場。
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

from flask import Flask, jsonify, request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

# config 必須先 import：它負責載入 .env，而 vlm_module 與 garment_gen
# 都在 import 當下就讀環境變數。
from config import config  # noqa: E402  isort:skip

from avatar_pipeline import build_face_data, build_outfit_data, decode_frame
from circuit_breaker import CircuitBreaker
from cv_module import get_clothing_features
from face_module import get_face_features
from slicer import slice_character

# 缺金鑰或缺套件時以降級模式啟動，沿用 app.py 的既有作法。
# vlm_module 在缺 GEMINI_API_KEY 時是 import 當下就 raise（vlm_module.py:9），
# 不是呼叫時才失敗，因此一定要包在 try 裡 —— 否則整個服務起不來，
# 連「用預設外觀進場」這條降級路徑都一起沒了。
_DEGRADED: list[str] = []


def _degraded(name: str, err: Exception) -> None:
    _DEGRADED.append(name)
    print(f"[vision] ⚠️  {name} 降級：{err}", file=sys.stderr)


try:
    from vlm_module import analyze_face, analyze_outfit
except Exception as _e:  # 最常見：GEMINI_API_KEY 未設定
    _degraded("vlm_module（VLM 服裝／臉部分類）", _e)
    analyze_outfit = lambda *a, **k: {"ok": False, "error": "vlm_unavailable"}
    analyze_face = lambda *a, **k: {"ok": False, "error": "vlm_unavailable"}

try:
    from garment_gen import generate_full_character_png
except Exception as _e:  # 最常見：OPENAI_API_KEY 未設定
    _degraded("garment_gen（AI 角色圖像生成）", _e)
    generate_full_character_png = None

# 貼圖落地位置：Node 端以靜態檔案服務 public/，因此寫進 public/assets/gen/
# 之後立刻就能用 /assets/gen/<assetId>/<part>.png 取得（見契約 4）。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET_DIR = os.path.join(REPO_ROOT, "public", "assets", "gen")

# 生成全程都在外部 API 或 MediaPipe 上，執行緒池只是讓 CV 與 VLM 能重疊。
# 每個 /generate 會同時用掉 4 個 slot（VLM 兩支 + CV 兩支），因此池子必須
# 容得下數個並行請求 —— 只給 4 個的話，第二個人一按拍照就會排到 CV 逾時。
_executor = ThreadPoolExecutor(max_workers=16)

# 沿用既有的熔斷器：外部 API 連續失敗時直接快速失敗，
# 不讓每個參與者都在現場等滿 120 秒的 timeout。
_gemini_breaker = CircuitBreaker(name="gemini")
_imagegen_breaker = CircuitBreaker(name="image_gen")

# 生成失敗時的預設外觀。參與者仍然進得了場，只是「外觀不像本人」——
# 這是整合計畫 §3.5 明確要求的降級行為，不是無法參與。
DEFAULT_COLORS = {"skin": "#F4C08A", "hair": "#4A2C1A", "torso": "#8FA05E", "legs": "#B7A98A"}

app = Flask(__name__)


def _raise_on_failure(fn, *args, **kwargs):
    """熔斷器要求呼叫失敗時拋例外，但底層函式是以 {ok: False} 表達失敗。"""
    result = fn(*args, **kwargs)
    if isinstance(result, dict) and result.get("ok") is False:
        raise RuntimeError(result.get("error") or "call_failed")
    return result


def _sampled_colors(cv_result: Dict[str, Any], face_cv: Dict[str, Any]) -> Dict[str, str]:
    """生成失敗時，仍用 CV 量到的真實顏色當替身，比固定預設值貼近本人。"""
    colors = dict(DEFAULT_COLORS)
    for key, src in (("torso", "upper"), ("legs", "lower")):
        node = cv_result.get(src) if isinstance(cv_result, dict) else None
        if isinstance(node, dict) and isinstance(node.get("hex"), str):
            colors[key] = node["hex"]
    if isinstance(face_cv, dict):
        for key, src in (("skin", "skin_tone"), ("hair", "hair_color")):
            if isinstance(face_cv.get(src), str) and face_cv[src].startswith("#"):
                colors[key] = face_cv[src]
    return colors


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "opencv": cv2 is not None,
        "gemini_key": bool(config.GEMINI_API_KEY),
        "imagegen_key": bool(config.OPENAI_API_KEY),
        "asset_dir": ASSET_DIR,
        "degraded": _DEGRADED,
    })


@app.route("/generate", methods=["POST"])
def generate():
    """一張照片進、三張貼圖出。

    任何一步失敗都回 200 + {ok: false, fallbackColors}，而不是 5xx ——
    對現場而言「這個人用預設外觀進場」是正常流程的一支，不是伺服器錯誤。
    """
    try:
        return _generate()
    except Exception as e:
        # 沒有這層，任何未預期的例外（CV 逾時、MediaPipe 拋錯）都會變成
        # Flask 的 HTML 500，手機端解不出 JSON 就只能顯示「連不上」，
        # 而不是照契約退回捏臉。
        print(f"[vision] /generate 未預期失敗：{e!r}", file=sys.stderr)
        return jsonify({"ok": False, "error": "internal_error",
                        "fallbackColors": DEFAULT_COLORS})


def _generate():
    started = time.perf_counter()
    payload = request.get_json(silent=True) or {}
    img_str = payload.get("image")
    if not img_str:
        return jsonify({"ok": False, "error": "no_image", "fallbackColors": DEFAULT_COLORS})
    if cv2 is None:
        return jsonify({"ok": False, "error": "opencv_missing", "fallbackColors": DEFAULT_COLORS})

    # 先確認影像解得開，再送外部 API。
    # 反過來做的話，任何解不開的圖都會先排入兩個 VLM 呼叫，然後函式立刻回傳，
    # 留下兩個沒人收割的工作佔住 executor（只有四個 worker）——
    # 幾個壞掉的請求就足以讓正常的生成排隊到逾時，還要付外部 API 的錢。
    frame, decode_err = decode_frame(img_str)
    if frame is None:
        return jsonify({"ok": False, "error": f"decode_failed: {decode_err}",
                        "fallbackColors": DEFAULT_COLORS})

    # VLM 不需要等 CV，兩邊同時發車
    fut_outfit = _executor.submit(
        _gemini_breaker.call, _raise_on_failure, analyze_outfit, img_str,
        fallback={"ok": False, "error": "circuit_open"},
    )
    fut_face_vlm = _executor.submit(
        _gemini_breaker.call, _raise_on_failure, analyze_face, img_str,
        fallback={"ok": False, "error": "circuit_open"},
    )

    rgb_full = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    fut_cv = _executor.submit(get_clothing_features, frame, max_width=480)
    fut_face_cv = _executor.submit(get_face_features, frame, max_width=480)
    # CV 失敗不該讓整個請求失敗：body_poly 抓不到時下面會退回中央預設框，
    # 顏色抓不到時退回預設色，人仍然進得了場。
    try:
        cv_result = fut_cv.result(timeout=30) or {}
    except Exception as e:
        print(f"[vision] 服裝特徵擷取失敗：{e!r}", file=sys.stderr)
        cv_result = {}
    try:
        face_cv_result = fut_face_cv.result(timeout=30) or {}
    except Exception as e:
        print(f"[vision] 臉部特徵擷取失敗：{e!r}", file=sys.stderr)
        face_cv_result = {}

    body_poly: Optional[np.ndarray] = None
    if cv_result.get("ok") and len(cv_result.get("body_poly") or []) >= 3:
        try:
            body_poly = np.array(cv_result["body_poly"], dtype=np.float32)
        except Exception:
            body_poly = None
    if body_poly is None:
        # 人像特寫或半身照常常抓不到骨架。用中央預設框仍能生出可用的人偶，
        # 比直接讓參與者失敗好。
        body_poly = np.array(
            [[0.25, 0.10], [0.75, 0.10], [0.75, 0.90], [0.25, 0.90]], dtype=np.float32
        )

    try:
        vlm_outfit = fut_outfit.result(timeout=120)
    except Exception as e:
        print(f"[vision] VLM 服裝分析失敗：{e!r}", file=sys.stderr)
        vlm_outfit = {"ok": False}
    try:
        vlm_face = fut_face_vlm.result(timeout=120)
    except Exception as e:
        print(f"[vision] VLM 臉部分析失敗：{e!r}", file=sys.stderr)
        vlm_face = {"ok": False}
    outfit_data = build_outfit_data(vlm_outfit, cv_result)
    face_data = build_face_data(face_cv_result, vlm_face)
    fallback_colors = _sampled_colors(cv_result, face_cv_result)

    if generate_full_character_png is None:
        return jsonify({"ok": False, "error": "imagegen_unavailable",
                        "fallbackColors": fallback_colors})

    gen = _imagegen_breaker.call(
        _raise_on_failure, generate_full_character_png,
        rgb_full, body_poly, face_data, outfit_data,
        fallback={"ok": False, "error": "circuit_open"},
    )
    if not (isinstance(gen, dict) and gen.get("ok") and gen.get("body_png")):
        error = gen.get("error", "generation_failed") if isinstance(gen, dict) else "generation_failed"
        return jsonify({"ok": False, "error": error, "fallbackColors": fallback_colors})

    asset_id = uuid.uuid4().hex
    try:
        result = slice_character(gen["body_png"], ASSET_DIR, asset_id)
    except Exception as e:
        return jsonify({"ok": False, "error": f"slice_failed: {e}",
                        "fallbackColors": fallback_colors})

    result["elapsedMs"] = round((time.perf_counter() - started) * 1000.0, 1)
    return jsonify(result)


if __name__ == "__main__":
    os.makedirs(ASSET_DIR, exist_ok=True)
    # 刻意避開 5001：start.sh 會把 2D 備援版的 app.py 起在那個埠，
    # 同時跑兩者時會直接衝突。
    port = int(os.environ.get("VISION_PORT") or 5055)
    # 只綁 127.0.0.1：對外一律由 Node 端統一出口（同源，順帶避開 HTTPS
    # 混合內容），本服務不需要、也不應該直接暴露在場館網路上。
    print(f"[vision] 角色資產生成服務 http://127.0.0.1:{port}  貼圖輸出 → {ASSET_DIR}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
