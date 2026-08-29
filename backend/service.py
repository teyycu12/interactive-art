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

import faulthandler
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

from flask import Flask, jsonify, request, send_from_directory

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
    from garment_gen import generate_full_character_png, style_reference_report
except Exception as _e:  # 最常見：OPENAI_API_KEY 未設定
    _degraded("garment_gen（AI 角色圖像生成）", _e)
    generate_full_character_png = None
    style_reference_report = lambda: {}

# 品質關卡。validate_avatar_png 是唯一會觸發重生的檢查，而且它不只判定通過與否：
# correction_for_validation 把失敗原因變成下一次生成的修正指令，
# guidance_for_validation 變成給參與者的重拍理由。這是一個閉環，不是一個檢查。
try:
    from avatar_quality import (
        add_transparent_margin,
        correction_for_validation,
        guidance_for_validation,
        validate_avatar_png,
    )
except Exception as _e:
    _degraded("avatar_quality（生成結果驗證）", _e)
    add_transparent_margin = lambda png, **k: png
    correction_for_validation = lambda v: ""
    guidance_for_validation = lambda v: ""
    validate_avatar_png = lambda *a, **k: {"passed": True, "errors": [], "warnings": []}

# 拍攝閘門的時序判定。單張影格的好壞由 capture_quality 判斷，「可以按快門了」
# 則是跨影格的問題 —— 人要連續數幀不動，身高比例也要連續數幀穩定。
try:
    import capture_session
    from capture_quality import mean_landmark_displacement
    from height_profiles import classify_height
    _PREVIEW = True
except Exception as _e:
    _degraded("capture_session（拍攝站位引導）", _e)
    _PREVIEW = False

try:
    from style_registry import get_event_style_id, list_styles, resolve_style_id
except Exception as _e:
    _degraded("style_registry（生成風格註冊表）", _e)
    get_event_style_id = lambda: "lego"
    list_styles = lambda: []
    resolve_style_id = lambda requested: "lego"

# 生成帳本。現場燒掉多少 token、花多少錢、失敗率多少，全靠這個；
# 缺它不影響參與者，因此所有呼叫都經 _history_call 包起來、失敗只印一行。
try:
    from generation_history import (
        finish_run,
        get_run,
        get_summary,
        input_directory,
        list_runs,
        output_directory,
        record_attempt,
        save_input_photo,
        start_run,
    )
    _HISTORY = True
except Exception as _e:
    _degraded("generation_history（生成紀錄與成本）", _e)
    _HISTORY = False
    get_run = lambda *a, **k: None
    get_summary = lambda *a, **k: {}
    list_runs = lambda *a, **k: []
    input_directory = output_directory = lambda: os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "logs"
    )


def _history_call(function, *args, **kwargs):
    """帳本永遠不得讓生成失敗 —— 它是觀測，不是流程的一部分。"""
    if not _HISTORY:
        return None
    if os.environ.get("DEV_HISTORY_ENABLED", "1").strip().lower() in {"0", "false", "no"}:
        return None
    try:
        return function(*args, **kwargs)
    except Exception as exc:
        print(f"[generation_history] {function.__name__} failed: {exc}", file=sys.stderr)
        return None

try:
    from photo_composer import compose_group_photo
except Exception as _e:  # 最常見：Pillow 或 qrcode 未安裝
    _degraded("photo_composer（大合照合成）", _e)
    compose_group_photo = None

# 貼圖落地位置：Node 端以靜態檔案服務 public/，因此寫進 public/assets/gen/
# 之後立刻就能用 /assets/gen/<assetId>/<part>.png 取得（見契約 4）。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET_DIR = os.path.join(REPO_ROOT, "public", "assets", "gen")

# 生成全程都在外部 API 或 MediaPipe 上，執行緒池只是讓 CV 與 VLM 能重疊。
# 每個 /generate 會同時用掉 4 個 slot（VLM 兩支 + CV 兩支），因此池子必須
# 容得下數個並行請求 —— 只給 4 個的話，第二個人一按拍照就會排到 CV 逾時。
_executor = ThreadPoolExecutor(max_workers=16)

# 生圖呼叫的並行上限。
#
# 上面那個執行緒池管的是 CV 與 VLM 的重疊，**生圖那一次呼叫不經過它** ——
# 在加上這道閘門之前，十個人同時按拍照就是十個生圖請求同時打向 Gemini。
# 那正是最糟的情況：外部 API 一開始回 429，熔斷器只要連續三次失敗就會跳閘
# 20 秒（見 circuit_breaker.py），於是**全場一起失敗**，而不是排隊慢一點。
#
# 這裡沿用 2D 備援版早就有的 GEN_MAX_CONCURRENT（backend/app.py），
# 整合版先前漏掉了這道閘門。超出上限的請求會在這裡等，不會被拒絕 ——
# 對參與者而言是「慢一點」，遠好過「大家一起看到生成失敗」。
_gen_semaphore = threading.Semaphore(config.GEN_MAX_CONCURRENT)

# MediaPipe 在 C++ 層 abort() 時（Check failed: 1 == ChannelSize()），
# Python 不會拋例外、也不會印出任何 Python 行號 —— 只有一串 C++ 位址，
# 完全指不到是哪一行程式碼觸發的。faulthandler 會在收到致命訊號時
# 補印當下每個執行緒的 Python 堆疊，把「崩在 MediaPipe 裡」縮小到
# 「崩在 cv_module.py 第幾行」。純診斷用，沒有執行期成本。
faulthandler.enable()

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


def _vlm_result(future, label: str) -> Dict[str, Any]:
    """取一支 VLM 呼叫的結果；關閉或失敗都回同一種形狀。

    `future is None` 代表 FULL_MODE_VLM_ENABLED 是關的，不是出錯 —— 兩者都
    回傳沒有語意欄位的 dict，因為 build_outfit_data / build_face_data 對
    「沒有資料」本來就有正確的退路（改用 CV 量到的顏色）。刻意不回傳寫死的
    預設值：那會讓穿西裝的人被當成 T 恤配牛仔褲，且不會有任何一處報錯。
    """
    if future is None:
        return {"ok": False, "error": "vlm_disabled"}
    try:
        return future.result(timeout=120)
    except Exception as e:
        print(f"[vision] VLM {label}分析失敗：{e!r}", file=sys.stderr)
        return {"ok": False}


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
    # 風格參考圖集因授權不可散布而未進版控 —— clone 下來的環境預設就是缺的。
    # 缺它不會讓生成失敗，只是靜靜地少掉「所有角色是同一個物種」的依據，
    # 現場看起來像模型不穩、不像少了檔案。因此列進 degraded，
    # 讓佈署的人在開場前就看得到，而不是靠一行埋在啟動 log 裡的字。
    # 逐風格回報。只報活動預設風格的那一組，會讓另一個風格的參考圖整組
    # 缺席而健康檢查全綠 —— 而那個風格在選單上仍然選得到。
    style_refs = style_reference_report()
    degraded = list(_DEGRADED)
    for style_id, style_ref in style_refs.items():
        if not style_ref.get("available"):
            degraded.append(
                f"style_reference（'{style_id}' 的風格參考圖集 "
                f"'{style_ref.get('set_id')}'：{style_ref.get('reason')}，"
                f"該風格角色間的物種一致性會下降）"
            )
        elif style_ref.get("overridden"):
            # 有圖可用，所以上面那條不會觸發 —— 但用的是別的風格的圖。
            degraded.append(
                f"style_reference（'{style_id}' 被 STYLE_REFERENCE_SET 覆寫成 "
                f"'{style_ref.get('set_id')}'，該風格的 prompt 會與自己的參考圖矛盾）"
            )
    return jsonify({
        "ok": True,
        "opencv": cv2 is not None,
        "gemini_key": bool(config.GEMINI_API_KEY),
        "imagegen_key": bool(config.OPENAI_API_KEY),
        "asset_dir": ASSET_DIR,
        "styles": list_styles(),
        "default_style": get_event_style_id(),
        # 關閉是預設值也是刻意的取捨，但「關著」與「開著卻一直失敗」在現場
        # 完全長得一樣（兩者都是 prompt 少掉語意欄位），所以要報出來。
        "vlm_enabled": config.FULL_MODE_VLM_ENABLED,
        "vlm_model": config.VLM_MODEL,
        "style_reference": style_refs,
        "degraded": degraded,
    })


_sessions = capture_session.SessionStore() if _PREVIEW else None


@app.route("/preview", methods=["POST"])
def preview():
    """站位引導：一張預覽影格進、可拍攝狀態出。

    只跑 CV，不呼叫任何付費 API —— 這條路每秒會被打數次，成本必須是零。

    回傳刻意與 app.py 的 clothing_features 同形狀，讓兩個入口共用同一套引導
    文案與判準；差別只在傳輸方式（那邊 Socket.io、這邊 HTTP）。

    不回傳 landmarks：那是可辨識的人體座標，而且每幀來回會把現場的行動網路
    吃掉。位移量在伺服器端算完就丟，只送出結果。
    """
    if not _PREVIEW:
        return jsonify({"ok": False, "error": "preview_unavailable"})
    session_id = None
    try:
        payload = request.get_json(silent=True) or {}
        img_str = payload.get("image")
        if not img_str:
            return jsonify({"ok": False, "error": "no_image"})

        session_id = payload.get("sessionId")
        if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{32}", session_id):
            session_id = _sessions.new_id()
        live = _sessions.get(session_id)

        frame, decode_err = decode_frame(img_str)
        if frame is None:
            return jsonify({"ok": False, "error": f"decode_failed: {decode_err}",
                            "sessionId": session_id})

        features = get_clothing_features(
            frame, max_width=360, previous_landmarks=live.get("landmarks")
        )
        if not features.get("ok"):
            _sessions.put(session_id, live)
            return jsonify({"ok": False, "error": features.get("error", "no_person"),
                            "guidance_reason": features.get("guidance_reason", "person_not_detected"),
                            "sessionId": session_id})

        current = features.get("landmarks") or []
        displacement = mean_landmark_displacement(current, live.get("landmarks"))
        capture_session.update(live, features, displacement, classify_height=classify_height)
        live["landmarks"] = current
        _sessions.put(session_id, live)

        # landmarks、cloth_grid、stencil 等大欄位一律不外送：引導只需要判定結果。
        for heavy in ("landmarks", "cloth_grid", "lower_grid", "stencil", "roi",
                      "body_poly", "upper_poly", "lower_poly", "regions"):
            features.pop(heavy, None)
        features["sessionId"] = session_id
        return jsonify(features)
    except Exception as e:
        print(f"[vision] /preview 未預期失敗：{e!r}", file=sys.stderr)
        # 錯誤路徑同樣要帶回 id。其餘每個 return 都帶了，唯獨這裡漏掉 ——
        # 於是感知層整條掛掉時（CI 上缺 libGLESv2 讓 MediaPipe 建圖失敗就是一例），
        # 客戶端每一幀都拿不到 id，每幀開一個新 session，穩定度計數永遠累積不起來；
        # 而表面症狀是 KeyError: 'sessionId'，看起來像 session 邏輯壞了，
        # 完全指不到真正的原因。
        return jsonify({"ok": False, "error": "internal_error",
                        "sessionId": session_id or _sessions.new_id()})

@app.route("/compose", methods=["POST"])
def compose():
    """大合照：互動層送來在場名冊與座標，回傳合成好的 PNG。

    互動層（Node）已經把角色定住並全部面向鏡頭，此處只負責繪製。
    排版採「角色在場上的實際座標」而非階梯式重排 —— 這件作品的主題
    是集體共創的當下樣貌，把人重新排成整齊隊形會把那個訊息抹掉。

    與 /generate 一致：任何失敗都回 200 + {ok: false}，讓主辦端顯示
    「合照失敗」而不是看到一個解不出 JSON 的 5xx。
    """
    if compose_group_photo is None:
        return jsonify({"ok": False, "error": "composer_unavailable"})
    try:
        payload = request.get_json(silent=True) or {}
        chars = payload.get("characters")
        if not isinstance(chars, list):
            return jsonify({"ok": False, "error": "characters 必須是陣列"})

        # 貼圖以檔案路徑傳遞（契約 4），此處轉成本機絕對路徑再讀進來 ——
        # 生成服務只綁 127.0.0.1，不該為了讀自己剛寫下的檔案而繞一趟 HTTP。
        for c in chars:
            if isinstance(c, dict):
                c["body_path"] = _asset_path(c.get("fullPng"))

        res = compose_group_photo(
            chars,
            photo_url_base=payload.get("photoUrlBase") or "",
            title=payload.get("title") or "PersonaFlow 集體記憶",
            backdrop=payload.get("backdrop"),
        )
        if not (isinstance(res, dict) and res.get("ok")):
            return jsonify({"ok": False, "error": "compose_failed"})
        # photo_bytes 是 bytes，不能進 JSON；photo_b64 已含同樣內容
        res.pop("photo_bytes", None)
        return jsonify(res)
    except Exception as e:
        print(f"[vision] /compose 未預期失敗：{e!r}", file=sys.stderr)
        return jsonify({"ok": False, "error": "internal_error"})


def _asset_path(url):
    """把 /assets/gen/<id>/full.webp 轉成本機絕對路徑。

    只接受落在 ASSET_DIR 底下的結果：這個值來自互動層轉發的名冊，
    不做邊界檢查等於讓上游的任意字串決定要讀哪個檔案。
    """
    if not isinstance(url, str) or not url:
        return None
    prefix = "/assets/gen/"
    if not url.startswith(prefix):
        return None
    path = os.path.normpath(os.path.join(ASSET_DIR, url[len(prefix):]))
    if not path.startswith(os.path.realpath(ASSET_DIR) + os.sep) and not path.startswith(ASSET_DIR + os.sep):
        return None
    return path if os.path.isfile(path) else None
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
    # 一個 id 同時當帳本的 request_id 與貼圖目錄名，之後要從大螢幕上的某個
    # 角色回頭查它花了多少 token、重試過幾次，不必再對照兩張表。
    request_id = uuid.uuid4().hex
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

    # VLM 預設關閉（FULL_MODE_VLM_ENABLED）。生圖模型本來就收到原始照片，
    # 這兩次呼叫是重複的視覺分析 —— 而 Gemini 免費方案是「每個模型每天 20 次
    # 請求」，一位參與者就吃掉 2 次，等於一天只夠 10 個人，之後全數降級。
    #
    # 開著的時候 VLM 不需要等 CV，兩邊同時發車。
    if config.FULL_MODE_VLM_ENABLED:
        fut_outfit = _executor.submit(
            _gemini_breaker.call, _raise_on_failure, analyze_outfit, img_str,
            fallback={"ok": False, "error": "circuit_open"},
        )
        fut_face_vlm = _executor.submit(
            _gemini_breaker.call, _raise_on_failure, analyze_face, img_str,
            fallback={"ok": False, "error": "circuit_open"},
        )
    else:
        fut_outfit = fut_face_vlm = None

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

    cv_ms = int((time.perf_counter() - started) * 1000.0)
    # get_clothing_features 早就把這些算出來了，只是原本全部丟掉。
    # regions 會被送進生成 prompt，其餘進帳本 —— 事後要解釋「為什麼這張很糟」
    # 靠的就是這幾個欄位。
    regions = cv_result.get("regions") if isinstance(cv_result, dict) else None
    height_class = cv_result.get("height_class") if isinstance(cv_result, dict) else None
    height_ratio = cv_result.get("height_ratio") if isinstance(cv_result, dict) else None
    height_valid = cv_result.get("height_measurement_valid") if isinstance(cv_result, dict) else None

    # 預覽期間跨影格量到的身高比單張快門的估計可信得多 —— 那是連續數幀落在
    # 同一範圍才成立的值。拿不到就退回這張影格自己的量測。
    session_id = payload.get("sessionId")
    if _PREVIEW and isinstance(session_id, str) and re.fullmatch(r"[0-9a-f]{32}", session_id):
        live = _sessions.get(session_id)
        if live.get("trusted_height_class"):
            height_class = live["trusted_height_class"]
            height_ratio = live.get("trusted_height_ratio", height_ratio)
            height_valid = True
        _sessions.drop(session_id)   # 拍完就結束，不留著佔記憶體

    # 參與者在拍照頁選的風格優先；沒選、或送來一個沒註冊的字串，就退回活動
    # 層級的 CHARACTER_STYLE。這裡刻意不因為風格字串有問題而讓請求失敗 ——
    # 現場的原則是掃描失敗一律降級，不擋人進場。
    style_id = resolve_style_id(payload.get("styleId"))
    _history_call(start_run, request_id, mode="full_character", style_id=style_id,
                  source_type="camera")
    _history_call(save_input_photo, request_id, img_str)

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

    vlm_outfit = _vlm_result(fut_outfit, "服裝")
    vlm_face = _vlm_result(fut_face_vlm, "臉部")
    outfit_data = build_outfit_data(vlm_outfit, cv_result)
    face_data = build_face_data(face_cv_result, vlm_face)
    fallback_colors = _sampled_colors(cv_result, face_cv_result)

    vlm_ms = int((time.perf_counter() - started) * 1000.0) - cv_ms

    def _fail(error: str, *, stage: str, guidance: str = "",
              validation: Optional[Dict[str, Any]] = None, retries: int = 0,
              generation_ms: Optional[int] = None):
        _history_call(
            finish_run, request_id, status="failed", stage=stage,
            height_class=height_class, duration_ms=int((time.perf_counter() - started) * 1000.0),
            cv_ms=cv_ms, vlm_ms=vlm_ms, generation_ms=generation_ms, retry_count=retries,
            validation=validation, error_code=error, guidance=guidance or None,
            height_ratio=height_ratio, height_measurement_valid=height_valid,
        )
        body = {"ok": False, "error": error, "fallbackColors": fallback_colors}
        # 帶上重拍理由，讓手機端能說明「為什麼」而不是只丟一句生成失敗。
        # 沒有它，參與者唯一能做的就是再拍一張一模一樣的照片。
        if guidance:
            body["guidance"] = guidance
        return jsonify(body)

    if generate_full_character_png is None:
        return _fail("imagegen_unavailable", stage="generation")

    generation_start = time.perf_counter()

    def _attempt(correction: Optional[str]) -> Dict[str, Any]:
        # max_retries=0：熔斷器預設會自動重試一次，而這是整套系統唯一會花錢的
        # 呼叫 —— 失敗時多付一次錢，而且那次重試不帶任何修正指令，成功率與
        # 第一次相同。要不要重生由下方的驗證結果決定，不由熔斷器決定。
        #
        # with 而非 acquire/release：生圖會拋例外（熔斷器開啟、API 逾時），
        # 手動釋放漏掉任何一條路徑，名額就會永久少一個，最後整個服務卡死 ——
        # 而那個症狀是「現場愈跑愈慢，重啟就好」，最難查的一種。
        with _gen_semaphore:
            out = _imagegen_breaker.call(
                _raise_on_failure, generate_full_character_png,
                rgb_full, body_poly, face_data, outfit_data, True, regions, style_id, correction,
                max_retries=0,
                fallback={"ok": False, "error": "circuit_open"},
            )
        if isinstance(out, dict) and out.get("body_png"):
            out = dict(out)
            out["body_png"] = add_transparent_margin(out["body_png"])
        return out if isinstance(out, dict) else {"ok": False, "error": "generation_failed"}

    def _validate(out: Dict[str, Any]) -> Dict[str, Any]:
        if not out.get("ok"):
            return {"passed": False, "errors": [out.get("error", "generation_failed")], "warnings": []}
        return validate_avatar_png(
            out.get("body_png"),
            upper_rgb=(cv_result.get("upper") or {}).get("rgb"),
            lower_rgb=(cv_result.get("lower") or {}).get("rgb"),
        )

    try:
        # VISION_ 前綴：這條政策只屬於整合版。2D 備援版讀的是
        # GENERATION_MAX_RETRIES，且它的測試把「失敗時只花一次生圖錢」
        # 當成成本政策在守，兩者不該互相牽動。
        max_retries = max(0, min(1, int(
            os.environ.get("VISION_GENERATION_MAX_RETRIES")
            or os.environ.get("GENERATION_MAX_RETRIES", "0")
        )))
    except ValueError:
        max_retries = 0

    retries = 0
    gen = _attempt(None)
    validation = _validate(gen)
    _history_call(record_attempt, request_id, phase="full_character",
                  attempt_index=0, result=gen, validation=validation)

    if max_retries and gen.get("ok") and not validation.get("passed"):
        # 重生時帶上修正指令 —— 缺腿就要求雙腿雙腳完整，出框就要求置中留白。
        # 不帶指令的重試等於再擲一次同樣的骰子。
        retries = 1
        gen = _attempt(correction_for_validation(validation))
        validation = _validate(gen)
        _history_call(record_attempt, request_id, phase="full_character",
                      attempt_index=1, result=gen, validation=validation)

    generation_ms = int((time.perf_counter() - generation_start) * 1000.0)

    if not (gen.get("ok") and gen.get("body_png")):
        return _fail(gen.get("error", "generation_failed"), stage="generation",
                     validation=validation, retries=retries, generation_ms=generation_ms)

    if not validation.get("passed"):
        return _fail("validation_failed", stage="validation",
                     guidance=guidance_for_validation(validation),
                     validation=validation, retries=retries, generation_ms=generation_ms)

    try:
        result = slice_character(gen["body_png"], ASSET_DIR, request_id)
    except Exception as e:
        return _fail(f"slice_failed: {e}", stage="slice",
                     validation=validation, retries=retries, generation_ms=generation_ms)

    result["elapsedMs"] = round((time.perf_counter() - started) * 1000.0, 1)
    # 回報實際採用的風格，而不是讓手機端假設它送出去的那個一定成立 ——
    # resolve_style_id 會靜默退回預設，沒有這個欄位就看不出退回發生過。
    result["styleId"] = style_id
    _history_call(
        finish_run, request_id, status="ok", stage="base",
        height_class=height_class, duration_ms=int((time.perf_counter() - started) * 1000.0),
        cv_ms=cv_ms, vlm_ms=vlm_ms, generation_ms=generation_ms, retry_count=retries,
        validation=validation, output_png=gen["body_png"],
        height_ratio=height_ratio, height_measurement_valid=height_valid,
    )
    return jsonify(result)


# ── 主辦端歷史紀錄（原始照片、生成結果、token、花費、使用模型） ──────────
#
# 資料本身早就在寫（generation_history 由上面的 _history_call 每次生成都
# 記一筆），這裡只是把既有的帳本開放讀取。端點形狀刻意與 app.py（2D 備援版）
# 的 /api/dev/* 一致，讓兩套系統共用同一份 generation_history 邏輯與前端寫法，
# 不必為整合版另外發明一套查詢介面。
#
# 這個服務只綁 127.0.0.1，本檔其餘端點也都沒有存取控制 —— 對外的存取控制
# 由 server/index.js 的代理層負責（比對主辦端通行密鑰），不是這裡的責任。
def _with_output_url(item: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(item)
    result["output_url"] = (
        f"/api/dev/outputs/{result['output_path']}" if result.get("output_path") else None
    )
    result["input_url"] = (
        f"/api/dev/inputs/{result['input_path']}" if result.get("input_path") else None
    )
    return result


@app.route("/api/dev/generations", methods=["GET"])
def dev_generation_list():
    limit = request.args.get("limit", 100, type=int)
    return jsonify({"items": [_with_output_url(item) for item in list_runs(limit=limit)]})


@app.route("/api/dev/generations/<request_id>", methods=["GET"])
def dev_generation_detail(request_id):
    item = get_run(request_id)
    if item is None:
        return jsonify({"error": "not_found"}), 404
    for attempt in item.get("attempts") or []:
        attempt["output_url"] = (
            f"/api/dev/outputs/{attempt['output_path']}" if attempt.get("output_path") else None
        )
    return jsonify(_with_output_url(item))


@app.route("/api/dev/summary", methods=["GET"])
def dev_generation_summary():
    return jsonify(get_summary())


@app.route("/api/dev/outputs/<path:filename>", methods=["GET"])
def dev_generation_output(filename):
    return send_from_directory(str(output_directory()), filename)


@app.route("/api/dev/inputs/<path:filename>", methods=["GET"])
def dev_generation_input(filename):
    return send_from_directory(str(input_directory()), filename)


if __name__ == "__main__":
    os.makedirs(ASSET_DIR, exist_ok=True)
    # 刻意避開 5001：start.sh 會把 2D 備援版的 app.py 起在那個埠，
    # 同時跑兩者時會直接衝突。
    port = int(os.environ.get("VISION_PORT") or 5055)
    # 只綁 127.0.0.1：對外一律由 Node 端統一出口（同源，順帶避開 HTTPS
    # 混合內容），本服務不需要、也不應該直接暴露在場館網路上。
    print(f"[vision] 角色資產生成服務 http://127.0.0.1:{port}  貼圖輸出 → {ASSET_DIR}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
