import base64
import hashlib
import os
import random
import re
import socket as network_socket
import sys
import threading
import time
import uuid
from typing import Any, Dict, List, Optional
from concurrent.futures import ThreadPoolExecutor

try:
    from backend.config import config
except ImportError:
    from config import config

# Load .env before importing modules that read env vars (vlm_module, garment_gen)
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    load_dotenv()  # also try CWD
except ImportError:
    pass

import numpy as np

try:
    from flask import Flask, jsonify, request, send_from_directory
    from flask_socketio import SocketIO, emit, join_room, leave_room
except ModuleNotFoundError:
    Flask = None
    jsonify = None
    request = None
    send_from_directory = None
    SocketIO = None
    emit = None
    join_room = None
    leave_room = None


def _on_socket(event_name):
    """安全裝飾器：在 SocketIO 未安裝的環境下不報錯，安裝時正常註冊 handler。"""
    def decorator(fn):
        if socketio is not None:
            socketio.on(event_name)(fn)
        return fn
    return decorator


# --- 模組載入退化追蹤 ---
# 下方的 import 採「backend.X → X → stub」三段式，前兩段是為了支援從 repo root
# 或 backend/ 兩種啟動方式。但第三段的 stub 會讓功能靜默消失：例如
# swarm_logic 若載入失敗，update_swarm_state 會變成原樣返回，Boids 完全不動
# 卻沒有任何錯誤訊息。這裡確保每次退化都大聲說出來，並在啟動時彙總。
_DEGRADED: List[str] = []


def _degraded(feature: str, exc: BaseException) -> None:
    _DEGRADED.append(feature)
    print(f"[app] ⚠️  {feature} 載入失敗，已退化為 stub —— "
          f"{type(exc).__name__}: {exc}", file=sys.stderr)


try:
    import cv2  # type: ignore
except ModuleNotFoundError:
    cv2 = None

try:
    from backend.cv_module import get_clothing_features  # type: ignore
except Exception:
    try:
        from cv_module import get_clothing_features  # type: ignore
    except Exception as _e:
        _degraded("cv_module.get_clothing_features（服裝特徵提取）", _e)
        get_clothing_features = None

try:
    from backend.swarm_logic import update_swarm_state  # type: ignore
except Exception:
    try:
        from swarm_logic import update_swarm_state  # type: ignore
    except Exception as _e:
        # 最嚴重的一項：Boids 完全停擺（角色不動、不觸發 GREETING、無相遇 log）
        _degraded("swarm_logic.update_swarm_state（Boids 群聚演算法）", _e)
        update_swarm_state = lambda chars: chars  # type: ignore

try:
    from backend.event_logger import log_event, Timer  # type: ignore
except Exception:
    try:
        from event_logger import log_event, Timer  # type: ignore
    except Exception as _e:
        _degraded("event_logger（事件 log 落地，報告指標來源）", _e)
        log_event = lambda *a, **k: None  # type: ignore
        Timer = None

try:
    from backend.swarm_snapshot import save_snapshot, load_snapshot  # type: ignore
    from backend.photo_composer import compose_group_photo  # type: ignore
    from backend.bot_simulator import inject_bots, remove_bots  # type: ignore
    from backend.circuit_breaker import gemini_breaker  # type: ignore
except Exception:
    try:
        from swarm_snapshot import save_snapshot, load_snapshot  # type: ignore
        from photo_composer import compose_group_photo  # type: ignore
        from bot_simulator import inject_bots, remove_bots  # type: ignore
        from circuit_breaker import gemini_breaker  # type: ignore
    except Exception as _e:
        # 熔斷器變成 None 後，後續 .call() 會拋出難以理解的
        # 'NoneType' object has no attribute 'call'，所以更需要在這裡講清楚
        _degraded("swarm_snapshot / photo_composer / bot_simulator / circuit_breaker", _e)
        save_snapshot = lambda *a, **k: False  # type: ignore
        load_snapshot = lambda *a, **k: None  # type: ignore
        compose_group_photo = lambda *a, **k: {"ok": False}  # type: ignore
        inject_bots = lambda *a, **k: []  # type: ignore
        remove_bots = lambda *a, **k: 0  # type: ignore
        gemini_breaker = None

def _raise_on_vlm_failure(fn, *args, **kwargs):
    """把 {ok: False} 轉成例外，好讓熔斷器判定為失敗。

    circuit_breaker.call 只在 func 拋例外時 record_failure()，正常回傳一律
    record_success()。而 analyze_outfit / analyze_face 把所有例外都吞掉、改回
    {"ok": False, "error": ...} —— 於是熔斷器永遠不會累積失敗、永遠不會跳開，
    整段保護形同虛設：Gemini 全掛時每個參與者仍各自等滿一次逾時，而不是
    在第三次失敗後快速失敗。
    """
    result = fn(*args, **kwargs)
    if isinstance(result, dict) and result.get("ok") is False:
        raise RuntimeError(result.get("error") or "vlm_call_failed")
    return result


# vlm_module 與 face_module 必須分開 import：vlm_module 只要載入失敗（缺套件、
# SDK 版本不符）就整組停用，而 face_module 是純 MediaPipe、與 Gemini 無關。
# 兩者原本共用同一個 try 區塊，導致 vlm_module 一出事臉部偵測也一起被停用。
try:
    from backend.vlm_module import analyze_outfit, analyze_face
except Exception:
    try:
        from vlm_module import analyze_outfit, analyze_face
    except Exception as _e:
        _degraded("vlm_module（VLM 服裝分析）", _e)
        analyze_outfit = lambda *a, **k: {"ok": False}
        analyze_face = lambda *a, **k: {"ok": False}

# 金鑰未設定不會讓 import 失敗 —— vlm_module 在沒有 GEMINI_API_KEY 時只是跳過
# genai.configure()，要等到實際呼叫才會失敗。上面那個 except 因此不會觸發，
# 啟動訊息也就完全不會提到 VLM 是關的：每次生成都靜靜地少掉服裝款式與臉部
# 特徵，只剩 CV 顏色。現場看起來像模型變笨，不像少設一個環境變數。
if not os.environ.get("GEMINI_API_KEY"):
    _DEGRADED.append("vlm_module（GEMINI_API_KEY 未設定）")
    print("[app] ⚠️  GEMINI_API_KEY 未設定 —— 服裝款式與臉部特徵辨識將全數失敗，"
          "生成的角色只會有 CV 取到的顏色，不會像本人。", file=sys.stderr)

# 這三份色表原本在 app.py 與 avatar_pipeline 各有一份完全相同的副本。
# 以 avatar_pipeline 為單一來源，避免兩邊日後各自漂移。
try:
    from backend.avatar_pipeline import (  # type: ignore
        decode_frame,
        HAIR_HEX as _HAIR_HEX, SKIN_HEX as _SKIN_HEX, EYE_HEX as _EYE_HEX,
    )
except ImportError:
    from avatar_pipeline import (  # type: ignore
        decode_frame,
        HAIR_HEX as _HAIR_HEX, SKIN_HEX as _SKIN_HEX, EYE_HEX as _EYE_HEX,
    )

try:
    from backend.face_module import get_face_features
except Exception:
    try:
        from face_module import get_face_features
    except Exception as _e:
        _degraded("face_module（MediaPipe 臉部特徵）", _e)
        get_face_features = lambda *a, **k: {"ok": False}

try:
    from backend.garment_gen import generate_full_character_png  # type: ignore
except Exception:
    try:
        from garment_gen import generate_full_character_png  # type: ignore
    except Exception as _e:
        _degraded("garment_gen（AI 角色圖像生成）", _e)
        generate_full_character_png = None

try:
    from backend.avatar_quality import add_transparent_margin, correction_for_validation, guidance_for_validation, validate_avatar_png  # type: ignore
    from backend.capture_quality import mean_landmark_displacement  # type: ignore
    from backend.generation_history import backfill_style_fingerprints, finish_run, get_cast_drift, get_detail_benchmark, get_run, get_summary, input_directory, list_runs, mark_render_failure, output_directory, record_attempt, save_input_photo, save_rendered_output, save_review, save_visitor_measurement, start_run, update_run_experiment  # type: ignore
    from backend.blind_review import blind_payload, create_review_session, delete_review_sources, import_external_generation, list_review_sessions, resolve_blind_asset, results_csv, review_results, save_group_response, save_item_response, save_review_source, set_session_status  # type: ignore
    from backend.height_profiles import classify_height, get_height_profile  # type: ignore
    from backend.metrics_logger import log_metric  # type: ignore
    from backend.style_registry import get_event_style_id, get_style  # type: ignore
except Exception:
    from avatar_quality import add_transparent_margin, correction_for_validation, guidance_for_validation, validate_avatar_png  # type: ignore
    from capture_quality import mean_landmark_displacement  # type: ignore
    from generation_history import backfill_style_fingerprints, finish_run, get_cast_drift, get_detail_benchmark, get_run, get_summary, input_directory, list_runs, mark_render_failure, output_directory, record_attempt, save_input_photo, save_rendered_output, save_review, save_visitor_measurement, start_run, update_run_experiment  # type: ignore
    from blind_review import blind_payload, create_review_session, delete_review_sources, import_external_generation, list_review_sessions, resolve_blind_asset, results_csv, review_results, save_group_response, save_item_response, save_review_source, set_session_status  # type: ignore
    from height_profiles import classify_height, get_height_profile  # type: ignore
    from metrics_logger import log_metric  # type: ignore
    from style_registry import get_event_style_id, get_style  # type: ignore

CAPTURE_PROTOCOL_VERSION = "height-recent-3-v1"

if _DEGRADED:
    print(f"[app] ⚠️  共 {len(_DEGRADED)} 個模組以降級模式啟動，"
          f"相關功能將無法運作：{', '.join(_DEGRADED)}", file=sys.stderr)


if Flask is not None:
    app = Flask(__name__)
    # SECRET_KEY 原本是寫死並提交進版控的字串。展場雖是封閉 LAN，但金鑰進了
    # 公開 repo 就等於沒有金鑰，且未來若要加活動身分驗證會直接建立在其上。
    app.config["SECRET_KEY"] = config.SECRET_KEY
    # CORS 預設維持 "*"：展場靠 LAN 讓賓客手機連進來，來源 IP 事前無法列舉。
    # 需要收斂時用 CORS_ALLOWED_ORIGINS 逗號分隔指定。
    _cors = (config.CORS_ALLOWED_ORIGINS if isinstance(config.CORS_ALLOWED_ORIGINS, str)
             else list(config.CORS_ALLOWED_ORIGINS))
    socketio = SocketIO(app, cors_allowed_origins=_cors,
                        async_mode="threading",
                        max_http_buffer_size=20 * 1024 * 1024)
else:
    app = None
    socketio = None


def _route(path, **kwargs):
    def decorator(fn):
        if app is not None:
            app.route(path, **kwargs)(fn)
        return fn
    return decorator


# 顏色名稱 → hex 的對照表已移至 avatar_pipeline（連同使用它們的 build_face_data）

# --- per-socket M1 preview state ---
# 這份 per-connection 狀態同時是「上次成功特徵」的來源（見 _merge_fallback_payload），
# 因此必須以 sid 分隔：否則某位訪客偵測失敗時，會拿另一位訪客的服裝顏色去頂替。
_preview_sessions: Dict[str, Dict[str, Any]] = {}
_preview_in_flight: set[str] = set()
_preview_lock = threading.Lock()

_PHOTOS_DIR = os.path.join(os.path.dirname(__file__), "photos")
os.makedirs(_PHOTOS_DIR, exist_ok=True)

# --- swarm state ---
# 啟動時自動還原快照（若有），否則預設 system_bot
_restored_chars = load_snapshot()
if _restored_chars:
    # 補上 last_seen：TTL 掃描以 c.get("last_seen", now) 判斷，缺這個欄位的
    # 角色會被永遠視為「剛剛才出現」而不會過期。舊快照或早期版本寫入的角色
    # 都沒有這個欄位，不補的話會在場上不死不滅。此處讓它們從啟動時重新計時。
    _now = time.time()
    for _c in _restored_chars.values():
        _c.setdefault("last_seen", _now)
    _swarm_chars: Dict[str, Any] = _restored_chars
else:
    _swarm_chars: Dict[str, Any] = {
        "system_bot": {
            "id": "system_bot", "room": "default", "x": 500, "y": 500, "vx": 1, "vy": 1,
            "upper": {"hex": "#FFFFFF"}, "lower": {"hex": "#444444"},
            "outfit": {"inner_color": "#FF0000", "lower_color": "#0000FF"},
            "height_class": "medium", "height_profile": get_height_profile("medium"),
            "character_mode": "full_character",
            "height_measurement_valid": True,
            "style_id": "lego",
            "last_seen": time.time(),
        }
    }

# 支援 AUTO_BOTS 設定在啟動時自動注入指定數量之虛擬角色
if config.AUTO_BOTS > 0:
    inject_bots(_swarm_chars, count=config.AUTO_BOTS)

_swarm_lock = threading.Lock()

# --- swarm 容量上限 ---
MAX_SWARM_SIZE = config.MAX_SWARM_SIZE
MAX_BOTS_PER_INJECT = config.MAX_BOTS_PER_INJECT


# 三個獨立的執行緒池，而非共用一池：共用時生成流程的 VLM 任務會佔滿整池，
# 讓即時預覽的 CV 任務在佇列裡空等並燒掉自己的 timeout —— 失敗原因看起來
# 與 CV 有關，實際上是資源飢餓。分池讓兩者互不影響。

# Keep real-time CV from starving formal AI generation.
_cv_executor = ThreadPoolExecutor(max_workers=1)
_vlm_executor = ThreadPoolExecutor(max_workers=4)
_generation_executor = ThreadPoolExecutor(max_workers=2)

# Live installations need a tolerant gate: three steady preview frames are
# sufficient during the three-second countdown, and natural body sway should not
# reset the visitor to zero.
_CAPTURE_STABLE_FRAMES = max(2, int(os.getenv("CAPTURE_STABLE_FRAMES", "3")))
_CAPTURE_MOTION_MAX = max(0.01, float(os.getenv("CAPTURE_MOTION_MAX", "0.035")))
_HEIGHT_STABLE_FRAMES = max(2, int(os.getenv("HEIGHT_STABLE_FRAMES", "3")))
_HEIGHT_RATIO_SPAN_MAX = max(0.02, float(os.getenv("HEIGHT_RATIO_SPAN_MAX", "0.08")))

_INPUT_GENERATION_ERRORS = {"no_body_poly"}
_CONNECTION_GENERATION_ERRORS = {
    "APIConnectionError", "APITimeoutError", "generation_timeout", "refine_timeout",
}
_RATE_LIMIT_GENERATION_ERRORS = {"RateLimitError"}
# Kept apart from the rate-limit and config sets because the remedy differs: the
# request never reached the model, and waiting or retrying cannot clear it.
_CREDIT_GENERATION_ERRORS = {"insufficient_credits"}
_CONFIG_GENERATION_ERRORS = {
    "AuthenticationError", "PermissionDeniedError", "openai_unavailable",
}

# Only OpenRouter models that support chat-completions image output work here
# (see .env.example). The client picks from this same list, so an unlisted
# value is treated as unset rather than forwarded to the provider unchecked.
_ALLOWED_FULL_CHARACTER_MODELS = {
    "google/gemini-3-pro-image-preview",
    "google/gemini-2.5-flash-image-preview",
    "google/gemini-3.1-flash-image",
}


def _generation_failure_details(result: Dict[str, Any], validation: Dict[str, Any]) -> Dict[str, str]:
    """Distinguish input/validator failures from image-service failures."""
    if result.get("ok"):
        return {
            "status": "needs_retake",
            "kind": "validation",
            "error": "generation_validation_failed",
            "guidance": guidance_for_validation(validation),
        }

    error = str(result.get("error") or "generation_service_failed")
    if error in _INPUT_GENERATION_ERRORS:
        return {
            "status": "needs_retake",
            "kind": "input",
            "error": error,
            "guidance": "無法從照片擷取完整人物範圍，請確認頭頂、雙腿與雙腳都在畫面內後重新拍攝。",
        }
    if error in _CREDIT_GENERATION_ERRORS:
        return {
            "status": "service_error",
            "kind": "billing",
            "error": error,
            "guidance": "生圖服務餘額不足，請求在送出前就被擋下。這不是照片問題，"
                        "重試也不會成功；請先為 OpenRouter 帳戶加值後再生成。",
        }
    if error in _CONNECTION_GENERATION_ERRORS:
        guidance = "生圖服務連線失敗；照片已通過拍攝分析，不需要更換照片，請稍後用同一張照片重試。"
    elif error in _RATE_LIMIT_GENERATION_ERRORS:
        guidance = "生圖服務目前流量受限；照片沒有問題，請稍後用同一張照片重試。"
    elif error in _CONFIG_GENERATION_ERRORS:
        guidance = "生圖服務授權或設定異常；這不是照片問題，請檢查後端 API 設定後再試。"
    else:
        guidance = "生圖服務沒有回傳圖片；這不是角色完整性檢查失敗，請稍後用同一張照片重試。"
    return {
        "status": "service_error",
        "kind": "service",
        "error": error,
        "guidance": guidance,
    }


def _merge_fallback_payload(sid: str, features: Dict[str, Any]) -> Dict[str, Any]:
    with _preview_lock:
        session = _preview_sessions.setdefault(sid, {"stable_count": 0})
    if features.get("ok") is True:
        with _preview_lock:
            session["last_success"] = features
            session["last_success_ts"] = time.time()
        return features
    last = session.get("last_success") or {}
    return {
        "ok": False,
        "error": features.get("error"),
        "upper": last.get("upper"),
        "lower": last.get("lower"),
        "arm_color": last.get("arm_color"),
        "upper_type": last.get("upper_type", "short_sleeve"),
        "lower_type": last.get("lower_type", "shorts"),
        "landmarks": last.get("landmarks"),
        "roi": last.get("roi"),
        "mask_stats": features.get("mask_stats", {}),
        "capture_ready": False,
        "stability_count": 0,
        "guidance_reason": "person_not_detected",
        "fallback": bool(last),
        "last_success_ts": session.get("last_success_ts"),
        "ts": time.time(),
    }


# --- generate_avatar 併發控制 ---
_GEN_MAX_CONCURRENT = config.GEN_MAX_CONCURRENT
_gen_semaphore = threading.Semaphore(_GEN_MAX_CONCURRENT)
_gen_waiting = 0                      # 目前排隊中（尚未取得 slot）的請求數
_gen_waiting_lock = threading.Lock()




@_route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "PersonaFlow backend",
        "capture_protocol": CAPTURE_PROTOCOL_VERSION,
    })


@app.route("/api/branch", methods=["GET"])
def api_branch():
    """Return the current git branch so the frontend can display it."""
    import subprocess
    try:
        branch = subprocess.check_output(
            ["git", "branch", "--show-current"],
            cwd=os.path.dirname(__file__),
            text=True,
            timeout=3,
        ).strip()
    except Exception:
        branch = "unknown"
    return jsonify({"branch": branch})


def _with_output_url(item: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(item)
    result["output_url"] = (
        f"/api/dev/outputs/{result['output_path']}" if result.get("output_path") else None
    )
    result["input_url"] = (
        f"/api/dev/inputs/{result['input_path']}" if result.get("input_path") else None
    )
    return result


@app.after_request
def _allow_local_dev_dashboard(response):
    if request.path.startswith("/api/dev/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


@app.route("/api/dev/generations", methods=["GET"])
def dev_generation_list():
    limit = request.args.get("limit", 100, type=int)
    mode = request.args.get("mode") or None
    experiment_id = request.args.get("experiment_id") or None
    variant_id = request.args.get("variant_id") or None
    return jsonify({"items": [
        _with_output_url(item) for item in list_runs(
            limit=limit, mode=mode, experiment_id=experiment_id, variant_id=variant_id,
        )
    ]})


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


@app.route("/api/dev/generations/<request_id>/review", methods=["POST"])
def dev_generation_review(request_id):
    payload = request.get_json(silent=True) or {}
    try:
        review = save_review(
            request_id,
            verdict=payload.get("verdict", "pending"),
            completeness_score=payload.get("completeness_score"),
            clothing_match_score=payload.get("clothing_match_score"),
            face_match_score=payload.get("face_match_score"),
            overall_score=payload.get("overall_score"),
            notes=payload.get("notes", ""),
        )
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except (TypeError, ValueError) as exc:
        return jsonify({"error": "invalid_review", "detail": str(exc)}), 400
    return jsonify({"ok": True, "review": review})


@app.route("/api/dev/generations/<request_id>/experiment", methods=["POST"])
def dev_generation_experiment(request_id):
    payload = request.get_json(silent=True) or {}
    try:
        item = update_run_experiment(
            request_id,
            experiment_id=payload.get("experiment_id"),
            comparison_id=payload.get("comparison_id"),
            variant_id=payload.get("variant_id"),
        )
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True, "item": _with_output_url(item)})


@app.route("/api/dev/external-generations", methods=["POST"])
def dev_external_generation():
    try:
        item = import_external_generation(request.get_json(silent=True) or {})
    except (TypeError, ValueError) as exc:
        return jsonify({"error": "invalid_external_generation", "detail": str(exc)}), 400
    return jsonify({"ok": True, "item": _with_output_url(item)}), 201


@app.route("/api/dev/review-sources", methods=["POST"])
def dev_review_source():
    payload = request.get_json(silent=True) or {}
    try:
        item = save_review_source(
            payload.get("experiment_id"), payload.get("comparison_id"), payload.get("image")
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": "invalid_review_source", "detail": str(exc)}), 400
    return jsonify({"ok": True, "item": item}), 201


@app.route("/api/dev/review-sources/<experiment_id>", methods=["DELETE"])
def dev_delete_review_sources(experiment_id):
    try:
        deleted = delete_review_sources(experiment_id)
    except ValueError as exc:
        return jsonify({"error": "invalid_experiment", "detail": str(exc)}), 400
    return jsonify({"ok": True, "deleted": deleted})


@app.route("/api/dev/review-sessions", methods=["GET", "POST"])
def dev_review_sessions():
    if request.method == "GET":
        return jsonify({"items": list_review_sessions()})
    payload = request.get_json(silent=True) or {}
    try:
        session = create_review_session(
            name=payload.get("name") or payload.get("experiment_id"),
            experiment_id=payload.get("experiment_id"),
            request_ids=payload.get("request_ids"),
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": "invalid_review_session", "detail": str(exc)}), 400
    return jsonify({"ok": True, "session": session}), 201


@app.route("/api/dev/review-sessions/<session_id>/<action>", methods=["POST"])
def dev_review_session_status(session_id, action):
    status = {"lock": "locked", "complete": "completed"}.get(action)
    if not status:
        return jsonify({"error": "unknown_action"}), 404
    try:
        session = set_session_status(session_id, status)
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except ValueError as exc:
        return jsonify({"error": "invalid_transition", "detail": str(exc)}), 409
    return jsonify({"ok": True, "session": session})


@app.route("/api/dev/review-sessions/<session_id>/blind", methods=["GET"])
def dev_blind_review_payload(session_id):
    try:
        return jsonify(blind_payload(session_id, request.args.get("reviewer_code") or ""))
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except ValueError as exc:
        return jsonify({"error": "blind_review_unavailable", "detail": str(exc)}), 409


@app.route("/api/dev/review-sessions/<session_id>/items/<anonymous_code>", methods=["POST"])
def dev_blind_item_response(session_id, anonymous_code):
    payload = request.get_json(silent=True) or {}
    try:
        save_item_response(
            session_id, anonymous_code, payload.get("reviewer_code"), payload,
        )
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except (TypeError, ValueError) as exc:
        return jsonify({"error": "invalid_response", "detail": str(exc)}), 400
    except Exception as exc:
        if "UNIQUE constraint" in str(exc):
            return jsonify({"error": "already_submitted"}), 409
        raise
    return jsonify({"ok": True}), 201


@app.route("/api/dev/review-sessions/<session_id>/groups/<group_code>", methods=["POST"])
def dev_blind_group_response(session_id, group_code):
    payload = request.get_json(silent=True) or {}
    try:
        save_group_response(
            session_id, group_code, payload.get("reviewer_code"), payload,
        )
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except (TypeError, ValueError) as exc:
        return jsonify({"error": "invalid_response", "detail": str(exc)}), 400
    except Exception as exc:
        if "UNIQUE constraint" in str(exc):
            return jsonify({"error": "already_submitted"}), 409
        raise
    return jsonify({"ok": True}), 201


@app.route("/api/dev/review-sessions/<session_id>/results", methods=["GET"])
def dev_blind_results(session_id):
    try:
        return jsonify(review_results(session_id))
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except ValueError as exc:
        return jsonify({"error": "results_still_blind", "detail": str(exc)}), 409


@app.route("/api/dev/review-sessions/<session_id>/export.csv", methods=["GET"])
def dev_blind_export(session_id):
    try:
        csv_text = results_csv(session_id)
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    except ValueError as exc:
        return jsonify({"error": "results_still_blind", "detail": str(exc)}), 409
    return app.response_class(csv_text, mimetype="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{session_id}.csv"'
    })


@app.route("/api/dev/blind-assets/<session_id>/<anonymous_code>/<kind>", methods=["GET"])
def dev_blind_asset(session_id, anonymous_code, kind):
    if kind not in {"source", "output"}:
        return jsonify({"error": "not_found"}), 404
    try:
        directory, filename = resolve_blind_asset(session_id, anonymous_code, kind)
    except KeyError:
        return jsonify({"error": "not_found"}), 404
    return send_from_directory(str(directory), filename)


@app.route("/api/dev/summary", methods=["GET"])
def dev_generation_summary():
    return jsonify(get_summary())


@app.route("/api/dev/detail-benchmark", methods=["GET"])
def dev_detail_benchmark():
    return jsonify(get_detail_benchmark())


@app.route("/api/dev/cast-drift", methods=["GET"])
def dev_cast_drift():
    """Cross-character style drift: how far this cast is from one species."""
    try:
        limit = int(request.args.get("limit", 50))
    except (TypeError, ValueError):
        limit = 50
    return jsonify(get_cast_drift(
        experiment_id=(request.args.get("experiment_id") or None),
        mode=(request.args.get("mode") or "full_character"),
        limit=limit,
    ))


@app.route("/api/dev/cast-drift/backfill", methods=["POST"])
def dev_cast_drift_backfill():
    """Measure stored attempts that predate the fingerprint column."""
    return jsonify({"updated": backfill_style_fingerprints()})


@app.route("/api/dev/outputs/<path:filename>", methods=["GET"])
def dev_generation_output(filename):
    return send_from_directory(str(output_directory()), filename)


@app.route("/api/dev/inputs/<path:filename>", methods=["GET"])
def dev_generation_input(filename):
    return send_from_directory(str(input_directory()), filename)


@socketio.on("save_rendered_avatar")
def handle_save_rendered_avatar(payload):
    """Persist the final browser-rendered character used by the developer history."""
    request_id = str((payload or {}).get("request_id") or "").strip()
    png_b64 = str((payload or {}).get("body_png") or "")
    if png_b64.startswith("data:image/") and "," in png_b64:
        png_b64 = png_b64.split(",", 1)[1]
    if not request_id or not png_b64 or len(png_b64) > 12 * 1024 * 1024:
        emit("rendered_avatar_saved", {"ok": False, "request_id": request_id, "error": "invalid_payload"})
        return
    try:
        raw = base64.b64decode(png_b64, validate=True)
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("not_png")
        output_path = save_rendered_output(request_id, png_b64)
        emit("rendered_avatar_saved", {
            "ok": bool(output_path), "request_id": request_id,
            "output_url": f"/api/dev/outputs/{output_path}" if output_path else None,
        })
    except KeyError:
        emit("rendered_avatar_saved", {"ok": False, "request_id": request_id, "error": "request_not_found"})
    except Exception:
        emit("rendered_avatar_saved", {"ok": False, "request_id": request_id, "error": "invalid_png"})


@socketio.on("render_avatar_failed")
def handle_render_avatar_failed(payload):
    """Reject a formal result when the browser cannot produce its Three.js render."""
    request_id = str((payload or {}).get("request_id") or "").strip()
    raw_error = str((payload or {}).get("error") or "frontend_3d_render_failed").strip().lower()
    error_code = re.sub(r"[^a-z0-9_\-]", "_", raw_error)[:96] or "frontend_3d_render_failed"
    if not request_id:
        emit("render_failure_saved", {"ok": False, "error": "invalid_payload"})
        return
    try:
        mark_render_failure(
            request_id,
            error_code=error_code,
            guidance="Three.js 正式角色渲染失敗；未建立替代角色。",
        )
        emit("render_failure_saved", {"ok": True, "request_id": request_id})
    except KeyError:
        emit("render_failure_saved", {"ok": False, "request_id": request_id, "error": "request_not_found"})


def _history_call(function, *args, **kwargs):
    if os.environ.get("DEV_HISTORY_ENABLED", "1").strip().lower() in {"0", "false", "no"}:
        return None
    try:
        return function(*args, **kwargs)
    except Exception as exc:
        print(f"[generation_history] {function.__name__} failed: {exc}")
        return None


@_route("/photos/<path:filename>", methods=["GET"])
def serve_photo(filename):
    return send_from_directory(_PHOTOS_DIR, filename)



@_on_socket("connect")
def handle_connect():
    emit("server_message", {"message": "Connected to PersonaFlow backend."})
    log_event("connect", pid=request.sid)
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if chars:
        emit("update_positions", {"characters": chars})


@_on_socket("disconnect")
def handle_disconnect():
    # 角色 id 已與連線 id 脫鉤（char_<uuid>），因此斷線不再移除任何角色 ——
    # 賓客關掉分頁不代表離開現場，作品不該因此少一個人。舊版角色 id 沿用 sid，
    # 這裡保留相容處理：改為續命而非刪除，交由 TTL 掃描回收。
    sid = request.sid
    with _swarm_lock:
        if sid in _swarm_chars:
            _swarm_chars[sid]["last_seen"] = time.time()
    # 預覽階段的 per-connection 狀態則必須清掉：它是這條連線專屬的拍攝閘門進度，
    # 留著會讓同一個 sid 被重用時繼承上一位訪客的穩定度計數。
    with _preview_lock:
        _preview_sessions.pop(sid, None)
        _preview_in_flight.discard(sid)
    log_event("disconnect", pid=sid, removed_char=False)


@_on_socket("client_event")
def handle_client_event(payload):
    socketio.emit("server_message", {"message": "Event received", "payload": payload})


@_on_socket("process_frame")
def handle_process_frame(payload):
    sid = request.sid
    if cv2 is None:
        emit("clothing_features", _merge_fallback_payload(sid, {"ok": False, "error": "opencv_missing"}))
        return

    with _preview_lock:
        if sid in _preview_in_flight:
            # Keep only the newest waiting frame for this connection.
            _preview_sessions.setdefault(sid, {"stable_count": 0})["pending_payload"] = payload
            return
        _preview_in_flight.add(sid)
        _preview_sessions.setdefault(sid, {"stable_count": 0})

    def _process_in_background(frame_payload):
        try:
            img_str = frame_payload.get("image")
            if not img_str:
                return

            with _preview_lock:
                previous = _preview_sessions.setdefault(sid, {"stable_count": 0}).get("landmarks")
            frame_id = frame_payload.get("frame_id")

            frame, _decode_err = decode_frame(img_str)
            if frame is None:
                print(f"[preview] 影像解碼失敗: {_decode_err}")

            if frame is not None:
                features = get_clothing_features(frame, max_width=360, previous_landmarks=previous)
                if features.get("ok"):
                    current = features.get("landmarks") or []
                    displacement = mean_landmark_displacement(current, previous)
                    raw_ready = bool(features.get("capture_ready_raw"))
                    with _preview_lock:
                        live = _preview_sessions.setdefault(sid, {"stable_count": 0})
                        window = list(live.get("displacements") or [])
                        if raw_ready:
                            # Count the first valid frame as zero movement, then
                            # evaluate a short rolling mean thereafter.
                            window.append(0.0 if displacement is None else displacement)
                            window = window[-_CAPTURE_STABLE_FRAMES:]
                        else:
                            window = []
                        average = sum(window) / len(window) if window else None
                        stable_count = len(window) if average is not None and average <= _CAPTURE_MOTION_MAX else 0
                        live["displacements"] = window if stable_count else []
                        live["stable_count"] = stable_count
                        live["landmarks"] = current
                        raw_height_ratio = features.get("height_ratio")
                        height_measurement_ready = False
                        if features.get("height_measurement_valid") and isinstance(raw_height_ratio, (int, float)):
                            height_window = list(live.get("height_ratios") or [])
                            if height_window and abs(float(raw_height_ratio) - float(np.median(height_window))) > 0.12:
                                height_window = []
                            height_window.append(float(raw_height_ratio))
                            # Only recent samples determine readiness. Keeping a
                            # 15-frame history meant one old mask jump could
                            # prevent the indicator from ever turning on.
                            height_window = height_window[-_HEIGHT_STABLE_FRAMES:]
                            live["height_ratios"] = height_window
                            smoothed_height_ratio = float(np.median(height_window))
                            features["height_ratio_raw"] = round(float(raw_height_ratio), 4)
                            features["height_ratio"] = round(smoothed_height_ratio, 4)
                            features["height_class"] = classify_height(smoothed_height_ratio)
                            features["height_sample_count"] = len(height_window)
                            features["height_confidence"] = round(
                                min(1.0, len(height_window) / _HEIGHT_STABLE_FRAMES), 3
                            )
                            height_span = max(height_window) - min(height_window)
                            features["height_sample_span"] = round(height_span, 4)
                            height_measurement_ready = (
                                len(height_window) >= _HEIGHT_STABLE_FRAMES
                                and height_span <= _HEIGHT_RATIO_SPAN_MAX
                            )
                        else:
                            live["height_ratios"] = []
                            features["height_sample_count"] = 0
                            features["height_confidence"] = 0.0
                            features["height_sample_span"] = None
                        features["height_measurement_ready"] = height_measurement_ready
                        features["height_samples_required"] = _HEIGHT_STABLE_FRAMES
                        features["height_span_limit"] = _HEIGHT_RATIO_SPAN_MAX
                        if height_measurement_ready:
                            live["trusted_height_ratio"] = features["height_ratio"]
                            live["trusted_height_class"] = features["height_class"]
                            live["trusted_height_at"] = time.time()
                        else:
                            live.pop("trusted_height_ratio", None)
                            live.pop("trusted_height_class", None)
                            live.pop("trusted_height_at", None)
                        quality = features.get("capture_quality")
                        if isinstance(quality, dict):
                            checks = quality.setdefault("capture_checks", {})
                            checks["height_station"] = bool(features.get("height_station_valid"))
                            checks["height_measurement"] = height_measurement_ready
                    features["stability_count"] = stable_count
                    features["stability_required"] = _CAPTURE_STABLE_FRAMES
                    features["landmark_displacement"] = round(displacement, 5) if displacement is not None else None
                    features["stability_average"] = round(average, 5) if average is not None else None
                    features["capture_ready"] = (
                        raw_ready
                        and stable_count >= _CAPTURE_STABLE_FRAMES
                        and height_measurement_ready
                    )
                    if features["capture_ready"]:
                        features["guidance_reason"] = "ready"
                    elif raw_ready:
                        features["guidance_reason"] = "hold_still"
                if frame_id is not None:
                    features["frame_id"] = frame_id
                result = _merge_fallback_payload(sid, features)
                if "ts" not in result:
                    result["ts"] = time.time()
                socketio.emit("clothing_features", result, to=sid)
            else:
                socketio.emit("clothing_features", _merge_fallback_payload(sid, {"ok": False, "error": "frame_decode_failed"}), to=sid)
        except Exception as e:
            socketio.emit("clothing_features", _merge_fallback_payload(sid, {"ok": False, "error": "cv_exception", "message": str(e)}), to=sid)
        finally:
            with _preview_lock:
                live = _preview_sessions.get(sid)
                pending = live.pop("pending_payload", None) if live is not None else None
                if pending is None:
                    _preview_in_flight.discard(sid)
            if pending is not None:
                _cv_executor.submit(_process_in_background, pending)

    _cv_executor.submit(_process_in_background, payload)


@_on_socket("generate_avatar")
def handle_generate_avatar(payload):
    if cv2 is None:
        emit("avatar_generated", {"ok": False, "error": "opencv_missing"})
        return

    img_str = payload.get("image")
    if not img_str:
        emit("avatar_generated", {"ok": False, "error": "no_image"})
        return

    sid = request.sid
    request_id = str(payload.get("request_id") or uuid.uuid4().hex)
    style_id = get_event_style_id()
    source_type = str(payload.get("source_type") or "camera").strip().lower()
    if source_type not in {"upload", "camera"}:
        source_type = "camera"
    requested_model = str(payload.get("model") or "").strip()
    model_override = requested_model if requested_model in _ALLOWED_FULL_CHARACTER_MODELS else None
    try:
        fingerprint_b64 = img_str.split(",", 1)[1] if img_str.startswith("data:image") else img_str
        comparison_id = hashlib.sha256(base64.b64decode(fingerprint_b64)).hexdigest()[:20]
    except Exception:
        comparison_id = None
    experiment_id = str(payload.get("experiment_id") or "").strip()[:96] or None
    requested_comparison = str(payload.get("comparison_id") or "").strip()[:96] or None
    if requested_comparison:
        comparison_id = requested_comparison
    variant_id = str(payload.get("variant_id") or "").strip()[:96] or (
        "baseline" if experiment_id else None
    )

    # Camera captures must use the temporally stable height measurement that
    # lit the live capture indicators. A fresh single-frame CV pass may produce
    # a slightly different mask and must not silently replace that result.
    trusted_height = None
    if source_type == "camera":
        with _preview_lock:
            live = _preview_sessions.get(sid) or {}
            measured_at = live.get("trusted_height_at")
            if (
                isinstance(measured_at, (int, float))
                and time.time() - float(measured_at) <= 8.0
                and live.get("trusted_height_class") in {"short", "medium", "tall"}
                and isinstance(live.get("trusted_height_ratio"), (int, float))
            ):
                trusted_height = {
                    "height_ratio": float(live["trusted_height_ratio"]),
                    "height_class": live["trusted_height_class"],
                }

    # full_character is the only live path: one AI image covers the whole
    # figure. body_sprite and brick_ai_texture are retired -- old history stays
    # readable, but new requests must not spend API budget on them.
    mode = (payload.get("mode") or config.GENERATION_MODE).strip()
    if mode in {"body_sprite", "brick_ai_texture"}:
        emit("avatar_generated", {
            "ok": False,
            "is_final": True,
            "request_id": request_id,
            "character_mode": mode,
            "error": "mode_retired",
            "guidance": "此生成模式已退役，請重新整理頁面後使用完整角色生成模式。",
        })
        return
    if mode not in get_style(style_id).supported_modes:
        mode = "full_character"
    _history_call(
        start_run, request_id, mode=mode, style_id=style_id,
        source_type=source_type, experiment_id=experiment_id,
        comparison_id=comparison_id, variant_id=variant_id,
    )
    _history_call(save_input_photo, request_id, img_str)

    def _background():
        total_start = time.perf_counter()
        # 各子流程里程碑毫秒數，最後一起寫進 avatar_generated 事件 log。
        # analyze_log.py / report_html.py 的效能報告就是讀這些欄位。
        _timings: Dict[str, Any] = {}
        global _gen_waiting
        acquired_slot = False
        retry_count = 0
        fallback_used = False
        final_status = "failed"
        final_stage = "error"
        final_validation: Dict[str, Any] = {"passed": False, "errors": [], "warnings": []}
        final_error = None
        final_guidance = None
        final_output = None
        try:
            def _progress(stage: str, percent: int, message: str):
                socketio.emit("generation_progress", {
                    "request_id": request_id,
                    "mode": mode,
                    "stage": stage,
                    "percent": max(0, min(100, int(percent))),
                    "message": message,
                }, to=sid)

            def _await_generation(future, *, timeout=50, error="generation_timeout"):
                try:
                    return future.result(timeout=timeout)
                except Exception as exc:
                    return {"ok": False, "error": error, "detail": type(exc).__name__}

            # --- 併發閘門：多人同時拍照時排隊，避免單點瓶頸卡死 ---
            if not _gen_semaphore.acquire(blocking=False):
                with _gen_waiting_lock:
                    _gen_waiting += 1
                    ahead = _gen_waiting
                try:
                    _progress("queued", 2, f"生成中人數已滿，排隊中（前面還有 {ahead} 人）")
                    log_event("generate_queued", pid=sid, ahead=ahead, mode=mode)
                except Exception as pe:
                    print(f"[generate_avatar] queue progress error: {pe}")
                _queue_wait_start = time.perf_counter()
                _gen_semaphore.acquire(blocking=True)
                with _gen_waiting_lock:
                    _gen_waiting = max(0, _gen_waiting - 1)
                _timings["queue_wait_ms"] = round((time.perf_counter() - _queue_wait_start) * 1000.0, 1)
            acquired_slot = True

            _progress("received", 5, "照片已接收，準備分析人物特徵")
            vlm_start = time.perf_counter()
            _progress("analyzing", 12, "正在分析人體輪廓、服裝區域與色彩")
            # The full-character image model already receives the source photo,
            # so the two extra VLM endpoints duplicate visual analysis. They stay
            # off unless explicitly re-enabled.
            # 解析規則統一走 config，與整合版共用一份真值判斷。
            use_vlm = config.FULL_MODE_VLM_ENABLED
            # 經熔斷器呼叫：Gemini 連續失敗時快速失敗並回傳 fallback，避免
            # executor 執行緒被無效等待佔住。只用在這兩支便宜的分析 API 上 ——
            # 付費生圖那條刻意不接：CircuitBreaker.call 預設會自動重試一次
            # （等於多付一次錢），且它的 circuit_open 會蓋掉底下依錯誤類型
            # 給前端的重拍指引。生圖自有 _await_generation 的逾時與重試。
            def _vlm(fn, kind):
                if gemini_breaker is None:
                    return _vlm_executor.submit(fn, img_str)
                # 經 _raise_on_vlm_failure 轉手，熔斷器才看得見失敗。
                return _vlm_executor.submit(
                    gemini_breaker.call, _raise_on_vlm_failure, fn, img_str, max_retries=0,
                    fallback={"ok": False, "error": "circuit_open", kind: {}},
                )

            fut_outfit = _vlm(analyze_outfit, "outfit") if use_vlm else None
            fut_face_vlm = _vlm(analyze_face, "face") if use_vlm else None

            # Decode image（Pillow→OpenCV 兩段式，含 iPhone HEIC 與 base64
            # padding/'+' 修正；見 avatar_pipeline.decode_frame）
            frame, _decode_err = decode_frame(img_str)
            if frame is None:
                print(f"[generate_avatar] 影像解碼失敗: {_decode_err}")

            cv_result      = {}
            face_cv_result = {}
            rgb_full       = None
            body_poly      = None
            cv_start = time.perf_counter()
            if frame is not None:
                cv_result      = get_clothing_features(frame, max_width=480)
                face_cv_result = get_face_features(frame, max_width=480)

                if cv_result.get("ok") and "body_poly" in cv_result:
                    try:
                        rgb_full  = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        body_poly = np.array(cv_result["body_poly"], dtype=np.float32)
                    except Exception as ge:
                        print(f"[generate_avatar] poly prep failed: {ge}")
            _progress("cv_ready", 24, "人體與服裝區域分析完成")

            if source_type == "camera" and (
                not cv_result.get("height_measurement_valid") or trusted_height is None
            ):
                cv_ms = int((time.perf_counter() - cv_start) * 1000)
                guidance = "請站在固定地面腳印上，讓雙腳貼近畫面底部身高基準線後重新拍照。"
                socketio.emit("avatar_generated", {
                    "ok": False,
                    "error": "height_station_not_aligned",
                    "guidance": guidance,
                    "request_id": request_id,
                    "stage": "height_validation",
                    "is_final": True,
                    "height_class": None,
                    "height_ratio": cv_result.get("height_ratio"),
                    "height_measurement_valid": False,
                    "style_id": style_id,
                }, to=sid)
                _history_call(
                    finish_run, request_id, status="needs_retake", stage="height_validation",
                    height_class=None, height_ratio=cv_result.get("height_ratio"),
                    height_measurement_valid=False,
                    duration_ms=int((time.perf_counter() - total_start) * 1000),
                    cv_ms=cv_ms, vlm_ms=None, generation_ms=None, retry_count=0,
                    validation={"passed": False, "errors": ["height_station_not_aligned"], "warnings": []},
                    error_code="height_station_not_aligned", guidance=guidance,
                )
                return

            if source_type == "camera" and trusted_height is not None:
                cv_result["height_ratio"] = trusted_height["height_ratio"]
                cv_result["height_class"] = trusted_height["height_class"]
                cv_result["height_measurement_valid"] = True
                cv_result["height_method"] = "fixed_station_temporal_segmentation"

            cv_ms = int((time.perf_counter() - cv_start) * 1000)

            # Wait for VLM results with timeout (45s)
            vlm_result = {"ok": False, "error": "disabled_for_full_mode", "outfit": {"outer": "none", "inner": "tshirt", "lower": "jeans", "has_pattern": False}}
            vlm_face_result = {"ok": False, "error": "disabled_for_full_mode", "face": {}}
            vlm_timeout = 45
            vlm_deadline = time.monotonic() + vlm_timeout
            if fut_outfit is not None:
                try:
                    vlm_result = fut_outfit.result(timeout=max(0.01, vlm_deadline - time.monotonic()))
                except Exception as exc:
                    vlm_result = {"ok": False, "error": type(exc).__name__, "outfit": {"outer": "none", "inner": "tshirt", "lower": "jeans", "has_pattern": False}}
            if fut_face_vlm is not None:
                try:
                    vlm_face_result = fut_face_vlm.result(timeout=max(0.01, vlm_deadline - time.monotonic()))
                except Exception as exc:
                    vlm_face_result = {"ok": False, "error": type(exc).__name__, "face": {}}
            vlm_ms = int((time.perf_counter() - vlm_start) * 1000)
            _progress("features_ready", 30, "生成所需特徵已整理完成")

            # --- clothing data ---
            outfit_data = vlm_result.get("outfit", {})
            if "upper" in cv_result and "hex" in cv_result["upper"]:
                outfit_data["inner_color"] = cv_result["upper"]["hex"]
            if "lower" in cv_result and "hex" in cv_result["lower"]:
                outfit_data["lower_color"] = cv_result["lower"]["hex"]
            # CV is the authoritative source for clothing colours. When an
            # outer layer exists, the shoulder/arm sample is the best local
            # colour candidate; VLM remains responsible only for semantics.
            if (outfit_data.get("outer") or "none") != "none" and cv_result.get("arm_color"):
                outfit_data["outer_color"] = cv_result["arm_color"].get("hex")

            # Derive sleeve length from VLM outfit semantics — more reliable
            _LONG_SLEEVE_OUTERS = {"blazer", "cardigan", "denim_jacket"}
            _LONG_SLEEVE_INNERS = {"button_up"}
            vlm_outer = (outfit_data.get("outer") or "none").lower()
            vlm_inner = (outfit_data.get("inner") or "tshirt").lower()
            if vlm_outer in _LONG_SLEEVE_OUTERS or vlm_inner in _LONG_SLEEVE_INNERS:
                sleeve_kind = "long_sleeve"
            else:
                sleeve_kind = cv_result.get("upper_type", "short_sleeve")

            # --- facial data ---
            face_data: dict = {}

            # VLM classifies (hair style, beard); CV measures (colour). Garment
            # colour already works this way, and routing skin and hair through
            # the VLM's 6- and 8-entry palettes quantised away exactly the
            # individual difference the character is supposed to preserve.
            if vlm_face_result.get("ok") and "face" in vlm_face_result:
                vf = vlm_face_result["face"]
                face_data.update({
                    "hair_style":  vf.get("hair_style", "short_straight"),
                    "hair_color":  _HAIR_HEX.get(vf.get("hair_color",  "dark_brown"), "#3B2314"),
                    "skin_tone":   _SKIN_HEX.get(vf.get("skin_tone",   "light"),      "#FFD0A8"),
                    "eye_color":   _EYE_HEX.get( vf.get("eye_color",   "brown"),      "#7A4A28"),
                    "has_beard":   vf.get("has_beard", False),
                    "beard_style": vf.get("beard_style", "none"),
                })

            if face_cv_result.get("ok"):
                face_data.update({
                    "face_shape":    face_cv_result["face_shape"],
                    "eye_shape":     face_cv_result["eye_shape"],
                    "eyebrow_style": face_cv_result["eyebrow_style"],
                    "smile_score":   face_cv_result["smile_score"],
                    "lip_color":     face_cv_result.get("lip_color"),
                })
                for key in ("skin_tone", "hair_color", "eye_color"):
                    measured = face_cv_result.get(key)
                    if measured:
                        face_data[key] = measured
                        face_data.setdefault("color_source", {})[key] = "cv_measured"

            # What CV actually read off this visitor, kept so a generated
            # sprite can be compared against the person later. Without it
            # reference_bleed has only one hypothesis and cannot run at all.
            #
            # face_measured is the more important half. A failed face read is
            # currently silent: skin tone, hair colour and expression simply
            # stop appearing in the prompt and the model picks its own, which
            # is indistinguishable from a model ignoring instructions it was
            # given. Recording the flag turns that into a countable rate.
            face_measured = bool(face_cv_result.get("ok"))
            visitor_measurement = {
                "upper": (cv_result.get("upper") or {}).get("hex"),
                "lower": (cv_result.get("lower") or {}).get("hex"),
                "skin_tone": face_data.get("skin_tone"),
                "hair_color": face_data.get("hair_color"),
                "face_measured": face_measured,
                "face_error": None if face_measured else (face_cv_result.get("error") or "unknown"),
                "color_source": face_data.get("color_source") or {},
            }
            _history_call(save_visitor_measurement, request_id, visitor_measurement)
            if not face_measured:
                print(f"[app] face not measured ({visitor_measurement['face_error']}); "
                      f"skin tone, hair colour and expression are unmeasured for {request_id}")

            height_class = cv_result.get("height_class")
            height_profile = get_height_profile(height_class) if height_class else None
            upper_rgb = (cv_result.get("upper") or {}).get("rgb")
            lower_rgb = (cv_result.get("lower") or {}).get("rgb")
            regions = cv_result.get("regions") or {}

            def _payload_for(
                garment_result, *, stage: str, is_final: bool,
                selected_mode: str, validation: Dict[str, Any], retries: int,
                fallback: bool = False, ok: bool = True,
                error: Optional[str] = None, guidance: Optional[str] = None,
                error_kind: Optional[str] = None,
            ):
                return {
                "ok": ok,
                "error": error,
                "guidance": guidance,
                "error_kind": error_kind,
                "request_id": request_id,
                "stage": stage,
                "is_final": is_final,
                "outfit": outfit_data,
                "stencil": cv_result.get("stencil"),
                "arm_color": cv_result.get("arm_color"),
                "face":  face_data or None,
                # Surfaced so a wrong skin tone can be told from an unmeasured
                # one. Without it both arrive looking like a rendering fault.
                "face_measured": face_measured,
                "face_measure_error": visitor_measurement["face_error"],
                "upper_type": sleeve_kind,
                "lower_type": cv_result.get("lower_type", "shorts"),
                "body_png":  garment_result.get("body_png"),
                "body_bbox": garment_result.get("body_bbox"),
                "garment_source": "openai" if garment_result.get("ok") else "unavailable",
                "character_mode": selected_mode,
                "validation": validation,
                "retry_count": retries,
                "fallback_used": fallback,
                "height_ratio": cv_result.get("height_ratio"),
                "height_class": height_class,
                "height_profile": height_profile,
                "height_measurement_valid": cv_result.get("height_measurement_valid", False),
                "height_method": cv_result.get("height_method"),
                "style_id": style_id,
                "capture_quality": cv_result.get("capture_quality"),
                }

            def _validate(result: Dict[str, Any]) -> Dict[str, Any]:
                if not result.get("ok"):
                    return {"passed": False, "errors": [result.get("error", "generation_failed")], "warnings": []}
                return validate_avatar_png(result.get("body_png"), upper_rgb=upper_rgb, lower_rgb=lower_rgb)

            def _prepare_generated(result: Dict[str, Any]) -> Dict[str, Any]:
                prepared = dict(result)
                if prepared.get("body_png"):
                    prepared["body_png"] = add_transparent_margin(prepared["body_png"])
                return prepared

            def _record_generation_attempt(phase: str, attempt: int, result: Dict[str, Any], validation: Dict[str, Any]):
                _history_call(
                    record_attempt, request_id, phase=phase,
                    attempt_index=attempt, result=result, validation=validation,
                )

            try:
                max_retries = max(0, min(1, int(os.environ.get("GENERATION_MAX_RETRIES", "0"))))
            except ValueError:
                max_retries = 0

            generation_start = time.perf_counter()
            base_generation_ms = None
            if mode == "full_character":
                _progress("generating", 40, "正在生成完整角色，這通常是最久的階段")
                if rgb_full is not None and body_poly is not None:
                    garment_result = _await_generation(_generation_executor.submit(
                        generate_full_character_png, rgb_full, body_poly, face_data, outfit_data,
                        True, regions, style_id, model_override=model_override,
                    ))
                else:
                    garment_result = {"ok": False, "error": "no_body_poly"}
                garment_result = _prepare_generated(garment_result)
                if garment_result.get("ok"):
                    _progress("validating", 84, "角色已生成，正在檢查雙腿、雙腳與透明背景")
                validation = _validate(garment_result)
                _record_generation_attempt("full_character", 0, garment_result, validation)
                if max_retries and garment_result.get("ok") and not validation.get("passed") and rgb_full is not None and body_poly is not None:
                    retry_count = 1
                    garment_result = _await_generation(_generation_executor.submit(
                        generate_full_character_png, rgb_full, body_poly, face_data, outfit_data,
                        True, regions, style_id, correction_for_validation(validation),
                        model_override=model_override,
                    ))
                    garment_result = _prepare_generated(garment_result)
                    validation = _validate(garment_result)
                    _record_generation_attempt("full_character", 1, garment_result, validation)
                base_generation_ms = int((time.perf_counter() - generation_start) * 1000)
                final_validation = validation
                final_stage = "base"
                final_output = garment_result.get("body_png")
                if not validation.get("passed"):
                    failure = _generation_failure_details(garment_result, validation)
                    final_status = failure["status"]
                    final_error = failure["error"]
                    final_guidance = failure["guidance"]
                    socketio.emit("avatar_generated", _payload_for(
                        garment_result, stage="base", is_final=True, selected_mode="full_character",
                        validation=validation, retries=retry_count, ok=False,
                        error=final_error, guidance=final_guidance, error_kind=failure["kind"],
                    ), to=sid)
                    _progress(
                        "service_failed" if failure["kind"] == "service" else "failed",
                        100, final_guidance,
                    )
                else:
                    _progress("complete", 100, "完整角色生成完成")
                    final_status = "success"
                    socketio.emit("avatar_generated", _payload_for(
                        garment_result, stage="base", is_final=True, selected_mode="full_character",
                        validation=validation, retries=retry_count,
                    ), to=sid)

            generation_ms = int((time.perf_counter() - generation_start) * 1000)
            _timings.update(cv_ms=cv_ms, vlm_ms=vlm_ms, generation_ms=generation_ms)
            # 生成延遲與真實成敗落地，供 analyze_log 統計誠實的失敗率
            log_event("avatar_generated", pid=sid,
                      latency_ms=round((time.perf_counter() - total_start) * 1000.0, 1),
                      mode=mode, ok=(final_status == "success"), error=final_error,
                      retry_count=retry_count, **_timings)
            log_metric({
                "ts": time.time(), "request_id": request_id, "mode": mode,
                "style_id": style_id, "height_class": height_class, "stage": "final",
                "duration_ms": int((time.perf_counter() - total_start) * 1000),
                "cv_ms": cv_ms, "vlm_ms": vlm_ms, "generation_ms": generation_ms,
                "base_generation_ms": base_generation_ms,
                "quality_score": (cv_result.get("capture_quality") or {}).get("score"),
                "ai_detail_score": final_validation.get("detail_score"),
                "validation_errors": final_validation.get("errors", []),
                "validation_warnings": final_validation.get("warnings", []),
                "retry_count": retry_count, "fallback_used": fallback_used, "status": final_status,
            })
            _history_call(
                finish_run, request_id, status=final_status, stage=final_stage,
                height_class=height_class,
                duration_ms=int((time.perf_counter() - total_start) * 1000),
                cv_ms=cv_ms, vlm_ms=vlm_ms, generation_ms=generation_ms,
                retry_count=retry_count, validation=final_validation,
                error_code=final_error, guidance=final_guidance,
                output_png=final_output,
                height_ratio=cv_result.get("height_ratio"),
                height_measurement_valid=cv_result.get("height_measurement_valid"),
            )
        except Exception as e:
            print(f"[generate_avatar] error: {e}")
            try:
                _progress("failed", 100, "生成流程發生錯誤")
            except Exception:
                pass
            socketio.emit("avatar_generated", {
                "ok": False, "error": str(e), "request_id": request_id,
                "stage": "error", "is_final": True, "style_id": style_id,
            }, to=sid)
            log_metric({
                "ts": time.time(), "request_id": request_id, "mode": mode,
                "style_id": style_id, "stage": "error",
                "duration_ms": int((time.perf_counter() - total_start) * 1000),
                "retry_count": retry_count, "fallback_used": fallback_used, "status": type(e).__name__,
            })
            _history_call(
                finish_run, request_id, status="error", stage="error",
                height_class=None,
                duration_ms=int((time.perf_counter() - total_start) * 1000),
                cv_ms=None, vlm_ms=None, generation_ms=None,
                retry_count=retry_count, validation=final_validation,
                error_code=type(e).__name__, guidance=str(e), output_png=final_output,
            )
            # 失敗也要落地，否則報告算出來的失敗率會是假的
            log_event("avatar_generated", pid=sid,
                      latency_ms=round((time.perf_counter() - total_start) * 1000.0, 1),
                      mode=mode, ok=False, error=str(e), **_timings)
        finally:
            if acquired_slot:
                _gen_semaphore.release()

    threading.Thread(target=_background, daemon=True).start()


@_on_socket("join_swarm")
def handle_join_swarm(payload):
    # 角色 id 必須與連線 id 脫鉤：沿用 sid 會讓角色在賓客關掉分頁時一起消失
    # （sid 每次連線都不同）。前端會把 swarm_joined 回傳的 id 存進 sessionStorage，
    # 重新連線時帶回來認領同一個角色，避免產生分身。
    char_id = payload.get("id") or f"char_{uuid.uuid4().hex[:12]}"
    room = payload.get("room", "default")
    # 投影牆的角色比例由固定站位量測的身高等級決定，量不到就不讓它進場 ——
    # 否則角色會以預設比例混進去，而現場無從得知那是量測失敗還是真實體型。
    height_class = payload.get("height_class")
    if not payload.get("height_measurement_valid") or height_class not in {"short", "medium", "tall"}:
        if emit is not None:
            emit("swarm_join_failed", {
                "id": char_id,
                "error": "valid_height_measurement_required",
                "guidance": "請先完成固定站位身高量測，再匯入投影牆。",
            })
        return
    height_profile = get_height_profile(height_class)
    with _swarm_lock:
        existing = _swarm_chars.get(char_id, {})
        _swarm_chars[char_id] = {
            **existing,
            "id": char_id,
            "room": room,
            "x": float(payload.get("x", 960)),
            "y": float(payload.get("y", 540)),
            "vx": existing.get("vx", random.uniform(-1.0, 1.0)),
            "vy": existing.get("vy", random.uniform(-1.0, 1.0)),
            "upper": payload.get("upper", existing.get("upper")),
            "lower": payload.get("lower", existing.get("lower")),
            "upper_type": payload.get("upper_type", existing.get("upper_type", "short_sleeve")),
            "lower_type": payload.get("lower_type", existing.get("lower_type", "shorts")),
            "accessories": payload.get("accessories", existing.get("accessories", [])),
            "accessory": payload.get("accessory", existing.get("accessory", "none")),
            "arm_color": payload.get("arm_color", payload.get("arm", existing.get("arm_color"))),
            "face": payload.get("face", existing.get("face")),
            "outfit": payload.get("outfit", existing.get("outfit")),
            "body_png": payload.get("body_png", existing.get("body_png")),
            "body_bbox": payload.get("body_bbox", existing.get("body_bbox")),
            "character_mode": payload.get("character_mode", existing.get("character_mode", "full_character")),
            "height_class": height_class,
            "height_profile": height_profile,
            "height_measurement_valid": True,
            "style_id": payload.get("style_id", existing.get("style_id", "lego")),
            "last_seen": time.time(),
        }
        snapshot = [c for c in _swarm_chars.values()
                    if c.get("room", "default") == room]
        total = len(_swarm_chars)
    if join_room is not None:
        join_room(room)
    if emit is not None:
        emit("swarm_joined", {"id": char_id, "room": room})
    log_event("join_swarm", pid=char_id, room=room,
              x=float(payload.get("x", 960)), y=float(payload.get("y", 540)),
              character_mode=payload.get("character_mode", "full_character"),
              swarm_size=total)
    # Send large immutable assets once when a character joins. Regular Boids
    # ticks omit body_png to avoid rebroadcasting megabytes ten times per second.
    if socketio is not None:
        socketio.emit("update_positions", {"characters": snapshot}, room=room)


@_on_socket("leave_swarm")
def handle_leave_swarm(payload):
    char_id = payload.get("id") or (request.sid if request else None)
    with _swarm_lock:
        removed = _swarm_chars.pop(char_id, None) is not None
        total = len(_swarm_chars)
    log_event("leave_swarm", pid=char_id, removed=removed, swarm_size=total)


@_on_socket("update_character")
def handle_update_character(payload):
    char_id = payload.get("id")
    if not char_id:
        return
    changed = []
    with _swarm_lock:
        if char_id in _swarm_chars:
            for k in ("upper", "lower", "upper_type", "lower_type", "accessories",
                      "accessory", "arm_color", "face", "outfit", "body_png",
                      "body_bbox", "character_mode", "height_class", "height_profile",
                      "height_measurement_valid", "style_id", "room"):
                if k in payload:
                    _swarm_chars[char_id][k] = payload[k]
                    changed.append(k)
    if changed:
        log_event("update_character", pid=char_id, fields=",".join(changed))


@_on_socket("get_swarm")
def handle_get_swarm(payload=None):
    payload = payload or {}
    room = payload.get("room")
    with _swarm_lock:
        if room:
            chars = [c for c in _swarm_chars.values() if c.get("room", "default") == room]
        else:
            chars = list(_swarm_chars.values())
    if emit is not None:
        emit("update_positions", {"characters": chars})

    # 純觀看端（投影牆）只 emit get_swarm、不會 join_swarm，因此原本不在任何
    # room 裡 —— 而 _swarm_background 的週期廣播是 room-scoped 的，導致它在
    # 開頭兩次之後再也收不到更新（前端 watchdog 會因此永久誤報斷線）。
    # 這裡把連線加入它要觀看的 room；不帶 room 時視為 default。
    # 只影響「之後」收得到什麼，不改變本次回傳內容，故上面的語意保持不變。
    if join_room is not None:
        join_room(room or "default")

    log_event("get_swarm", pid=(request.sid if request else None), room=room, swarm_size=len(chars))


@_on_socket("trigger_photo")
def handle_trigger_photo(payload=None):
    """
    大合照合成觸發事件 (M6 核心)。
    收集在場角色、進行智慧排版合成高解析度圖片與 QR Code，並廣播 photo_ready。
    """
    payload = payload or {}
    room = payload.get("room", "default")
    with _swarm_lock:
        chars = [c for c in _swarm_chars.values() if c.get("room", "default") == room]
        if not chars and room == "default":
            chars = list(_swarm_chars.values())

    host = request.host if request else f"127.0.0.1:{config.PORT}"
    photo_url_base = f"http://{host}/photos"
    res = compose_group_photo(chars, photo_url_base=photo_url_base)

    if res.get("ok") and "photo_bytes" in res:
        photo_filename = f"{res['photo_id']}.png"
        photo_filepath = os.path.join(_PHOTOS_DIR, photo_filename)
        try:
            with open(photo_filepath, "wb") as pf:
                pf.write(res["photo_bytes"])
        except Exception as pe:
            print(f"[trigger_photo] Failed to save photo file: {pe}")

    log_event("group_photo_composed", photo_id=res.get("photo_id"), count=len(chars), room=room)
    if socketio is not None:
        socketio.emit("photo_ready", {
            "ok": res.get("ok", False),
            "photo_id": res.get("photo_id"),
            "photo_url": res.get("photo_url"),
            "photo_b64": res.get("photo_b64"),
            "qr_b64": res.get("qr_b64"),
            "character_count": len(chars),
            "room": room,
        })


@_on_socket("inject_bots")
def handle_inject_bots(payload=None):
    payload = payload or {}
    # 這是任何已連線客戶端都能觸發的控制端事件，且 swarm 計算為 O(n^2)，
    # 因此必須驗證 count 並限制總量，避免單一請求讓背景迴圈卡死服務。
    try:
        count = int(payload.get("count", 10))
    except (TypeError, ValueError):
        if emit is not None:
            emit("inject_bots_rejected", {"reason": "invalid_count"})
        return
    if count <= 0:
        if emit is not None:
            emit("inject_bots_rejected", {"reason": "invalid_count"})
        return

    count = min(count, MAX_BOTS_PER_INJECT)
    room = payload.get("room", "default")
    with _swarm_lock:
        available = MAX_SWARM_SIZE - len(_swarm_chars)
        count = min(count, max(0, available))
        if count == 0:
            if emit is not None:
                emit("inject_bots_rejected", {
                    "reason": "swarm_full",
                    "max_swarm_size": MAX_SWARM_SIZE,
                })
            return
        bot_ids = inject_bots(_swarm_chars, count=count)
        for bid in bot_ids:
            if bid in _swarm_chars:
                _swarm_chars[bid]["room"] = room
        total = len(_swarm_chars)
    log_event("inject_bots", count=count, total=total, room=room)
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if socketio is not None:
        socketio.emit("update_positions", {"characters": chars})


@_on_socket("remove_bots")
def handle_remove_bots(_payload=None):
    with _swarm_lock:
        removed = remove_bots(_swarm_chars)
        total = len(_swarm_chars)
    log_event("remove_bots", removed=removed, total=total)
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if socketio is not None:
        socketio.emit("update_positions", {"characters": chars})


@_on_socket("save_snapshot")
def handle_save_snapshot(_payload=None):
    with _swarm_lock:
        ok = save_snapshot(_swarm_chars)
    if emit is not None:
        emit("snapshot_saved", {"ok": ok})


# 上一個 tick 處於 GREETING 狀態的角色集合，用來只 log「新發生」的相遇，
# 避免每 0.1s tick 對持續靠近中的角色重複寫 log 灌爆檔案。
_prev_greeting: set = set()
_last_summary_ts: float = 0.0
_last_snapshot_ts: float = 0.0
_last_ttl_sweep_ts: float = 0.0


def _swarm_background():
    global _prev_greeting, _last_summary_ts, _last_snapshot_ts, _last_ttl_sweep_ts
    while True:
        time.sleep(0.1)
        with _swarm_lock:
            chars = list(_swarm_chars.values())
        if not chars:
            continue

        # 依 room 分組計算：不同展區的角色不應互相避讓、對齊或觸發 GREETING，
        # 位置事件也只送給對應 room 的投影端。
        by_room: Dict[str, List[Dict[str, Any]]] = {}
        for c in chars:
            by_room.setdefault(c.get("room", "default"), []).append(c)

        updated: List[Dict[str, Any]] = []
        for room_name, room_chars in by_room.items():
            room_updated = update_swarm_state(room_chars)
            if socketio is not None:
                # Large immutable assets are sent once, when a character joins.
                # Regular Boids ticks omit body_png so the wall does not
                # re-receive megabytes ten times per second.
                lightweight = [
                    {k: v for k, v in character.items() if k != "body_png"}
                    for character in room_updated
                ]
                socketio.emit("update_positions",
                              {"characters": lightweight}, room=room_name)
            updated.extend(room_updated)

        _BOIDS_KEYS = ("x", "y", "vx", "vy", "state", "greeting_ticks")
        with _swarm_lock:
            for c in updated:
                cid = c["id"]
                if cid in _swarm_chars:
                    for k in _BOIDS_KEYS:
                        if k in c:
                            _swarm_chars[cid][k] = c[k]

        # --- 相遇事件：只記錄本 tick 新進入 GREETING 的角色 ---
        now_greeting = {c["id"] for c in updated if c.get("state") == "GREETING"}
        newly = now_greeting - _prev_greeting
        for cid in newly:
            log_event("character_encounter", pid=cid, swarm_size=len(updated))
        _prev_greeting = now_greeting

        # --- 移動彙總與定時快照（每 5s 彙總、每 30s 快照持久化）---
        now = time.time()
        if now - _last_summary_ts >= 5.0:
            _last_summary_ts = now
            log_event("swarm_summary", swarm_size=len(updated),
                      greeting_count=len(now_greeting))

        if now - _last_snapshot_ts >= 30.0:
            _last_snapshot_ts = now
            with _swarm_lock:
                save_snapshot(_swarm_chars)

        # --- TTL 清場 ---
        # 角色不再隨連線消失（見 handle_disconnect），因此需要另一個回收機制，
        # 否則長時間運行或跨場次會無限累積直到撞上 MAX_SWARM_SIZE。
        if config.CHARACTER_TTL_SEC > 0 and now - _last_ttl_sweep_ts >= 60.0:
            _last_ttl_sweep_ts = now
            cutoff = now - config.CHARACTER_TTL_SEC
            with _swarm_lock:
                stale = [cid for cid, c in _swarm_chars.items()
                         if c.get("last_seen", now) < cutoff]
                for cid in stale:
                    _swarm_chars.pop(cid, None)
            if stale:
                log_event("character_ttl_expired", count=len(stale))


if socketio is not None:
    threading.Thread(target=_swarm_background, daemon=True).start()


if __name__ == "__main__":
    if socketio is None or app is None:
        print("[PersonaFlow] Flask or Flask-SocketIO is missing. Please run: pip install -r requirements.txt")
        raise SystemExit(1)
    # Werkzeug on Windows can leave several development processes sharing the
    # same port. Refuse a second launch so browsers cannot randomly reconnect to
    # an older copy of the capture logic.
    probe = network_socket.socket(network_socket.AF_INET, network_socket.SOCK_STREAM)
    probe.settimeout(0.4)
    try:
        port_is_busy = probe.connect_ex(("127.0.0.1", config.PORT)) == 0
    finally:
        probe.close()
    if port_is_busy:
        raise SystemExit(
            f"Port {config.PORT} already has a PersonaFlow backend. "
            "Stop it before starting another instance."
        )
    socketio.run(app, host=config.HOST, port=config.PORT, debug=config.DEBUG,
                 use_reloader=False, allow_unsafe_werkzeug=True)
