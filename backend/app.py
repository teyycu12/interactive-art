import base64
import hashlib
import os
import random
import re
import socket as network_socket
import threading
import time
import uuid
from typing import Any, Dict, Optional
from concurrent.futures import ThreadPoolExecutor

# Load .env before importing modules that read env vars (vlm_module, garment_gen)
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    load_dotenv()  # also try CWD
except ImportError:
    pass

import numpy as np
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

try:
    import cv2  # type: ignore
except ModuleNotFoundError:
    cv2 = None

try:
    from backend.cv_module import get_clothing_features  # type: ignore
except Exception:
    from cv_module import get_clothing_features  # type: ignore

try:
    from backend.swarm_logic import update_swarm_state  # type: ignore
except Exception:
    from swarm_logic import update_swarm_state  # type: ignore

try:
    from backend.vlm_module import analyze_outfit, analyze_face
    from backend.face_module import get_face_features
except Exception:
    from vlm_module import analyze_outfit, analyze_face
    from face_module import get_face_features

try:
    from backend.garment_gen import (  # type: ignore
        generate_body_png,
        generate_full_character_png,
    )
except Exception:
    from garment_gen import (  # type: ignore
        generate_body_png,
        generate_full_character_png,
    )

try:
    from backend.avatar_quality import add_transparent_margin, correction_for_validation, guidance_for_validation, validate_avatar_png  # type: ignore
    from backend.ai_texture_gen import apply_ai_textures, generate_ai_character_textures  # type: ignore
    from backend.capture_quality import mean_landmark_displacement  # type: ignore
    from backend.character_spec import active_character_style_id, build_character_spec, validate_character_spec  # type: ignore
    from backend.brick_v2_spec import get_brick_v2_spec  # type: ignore
    from backend.generation_history import finish_run, get_detail_benchmark, get_run, get_summary, list_runs, mark_render_failure, output_directory, record_attempt, save_rendered_output, save_review, start_run, update_run_experiment  # type: ignore
    from backend.blind_review import blind_payload, create_review_session, delete_review_sources, get_review_session, import_external_generation, list_review_sessions, resolve_blind_asset, results_csv, review_results, save_group_response, save_item_response, save_review_source, set_session_status  # type: ignore
    from backend.height_profiles import classify_height, get_height_profile  # type: ignore
    from backend.metrics_logger import log_metric  # type: ignore
    from backend.style_registry import get_event_style_id, get_style  # type: ignore
    from backend.style_family import get_style_family_spec  # type: ignore
except Exception:
    from avatar_quality import add_transparent_margin, correction_for_validation, guidance_for_validation, validate_avatar_png  # type: ignore
    from ai_texture_gen import apply_ai_textures, generate_ai_character_textures  # type: ignore
    from capture_quality import mean_landmark_displacement  # type: ignore
    from character_spec import active_character_style_id, build_character_spec, validate_character_spec  # type: ignore
    from brick_v2_spec import get_brick_v2_spec  # type: ignore
    from generation_history import finish_run, get_detail_benchmark, get_run, get_summary, list_runs, mark_render_failure, output_directory, record_attempt, save_rendered_output, save_review, start_run, update_run_experiment  # type: ignore
    from blind_review import blind_payload, create_review_session, delete_review_sources, get_review_session, import_external_generation, list_review_sessions, resolve_blind_asset, results_csv, review_results, save_group_response, save_item_response, save_review_source, set_session_status  # type: ignore
    from height_profiles import classify_height, get_height_profile  # type: ignore
    from metrics_logger import log_metric  # type: ignore
    from style_registry import get_event_style_id, get_style  # type: ignore
    from style_family import get_style_family_spec  # type: ignore


app = Flask(__name__)
CAPTURE_PROTOCOL_VERSION = "height-recent-3-v1"
app.config["SECRET_KEY"] = "personaflow-dev-secret"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading", max_http_buffer_size=20 * 1024 * 1024)

# VLM colour name → hex (used instead of CV colour sampling)
_HAIR_HEX = {
    "black":       "#1C1008",
    "dark_brown":  "#3B2314",
    "brown":       "#6B3A2A",
    "light_brown": "#A0602A",
    "blonde":      "#D4A843",
    "red":         "#A0391A",
    "gray":        "#888888",
    "white":       "#E8E0D8",
}
_SKIN_HEX = {
    "fair":   "#FFE5D0",
    "light":  "#FFD0A8",
    "medium": "#D4956A",
    "tan":    "#C08040",
    "brown":  "#8D5524",
    "dark":   "#4A2912",
}
_EYE_HEX = {
    "dark_brown": "#3B1C12",
    "brown":      "#7A4A28",
    "hazel":      "#8B6914",
    "green":      "#4A7A50",
    "blue":       "#4472A8",
    "gray":       "#6B7A8D",
}

# --- per-socket M1 preview state ---
_preview_sessions: Dict[str, Dict[str, Any]] = {}
_preview_in_flight: set[str] = set()
_preview_lock = threading.Lock()

# --- swarm state ---
_swarm_chars: Dict[str, Any] = {
    "system_bot": {
        "id": "system_bot", "x": 500, "y": 500, "vx": 1, "vy": 1,
        "upper": {"hex": "#FFFFFF"}, "lower": {"hex": "#444444"},
        "outfit": {"inner_color": "#FF0000", "lower_color": "#0000FF"},
        "height_class": "medium", "height_profile": get_height_profile("medium"),
        "style_id": "brick_v1",
        "character_spec": {
            "schema_version": 2, "style_spec_version": 2,
            "character_id": "system_bot", "style_id": "brick_v1",
            "height_profile": "medium", "skin_color": "#FFD0A8",
            "body_shape": {
                "height_scale": 1.0, "shoulder_width": 1.0, "torso_width": 1.0,
                "torso_depth": 1.0, "limb_thickness": 1.0, "confidence": 1.0,
                "measurement": "system_default",
            },
            "hair": {"style": "short", "color": "#3B2314"},
            "face": {"expression": "smile", "glasses": False, "beard": "none"},
            "outfit": {
                "upper_type": "tshirt", "lower_type": "pants", "outer_type": "none",
                "upper_color": "#FFFFFF", "lower_color": "#444444", "arm_color": "#FFFFFF",
            },
            "textures": {},
            "quality": {"capture_score": 1.0, "texture_confidence": 0.0, "fallback_used": True},
        },
    }
}
_swarm_lock = threading.Lock()

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
_CONFIG_GENERATION_ERRORS = {
    "AuthenticationError", "PermissionDeniedError", "openai_unavailable",
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


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "PersonaFlow backend",
        "capture_protocol": CAPTURE_PROTOCOL_VERSION,
        "character_style": active_character_style_id(),
    })


@app.route("/api/styles/brick_v1", methods=["GET"])
def brick_style_family_contract():
    return jsonify(get_style_family_spec())


@app.route("/api/styles/brick_v2", methods=["GET"])
def brick_v2_contract():
    return jsonify(get_brick_v2_spec())


def _with_output_url(item: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(item)
    result["output_url"] = (
        f"/api/dev/outputs/{result['output_path']}" if result.get("output_path") else None
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


@app.route("/api/dev/outputs/<path:filename>", methods=["GET"])
def dev_generation_output(filename):
    return send_from_directory(str(output_directory()), filename)


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


@socketio.on("connect")
def handle_connect():
    emit("server_message", {"message": "Connected to PersonaFlow backend."})
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if chars:
        emit("update_positions", {"characters": chars})


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    with _preview_lock:
        _preview_sessions.pop(sid, None)
        _preview_in_flight.discard(sid)


@socketio.on("client_event")
def handle_client_event(payload):
    socketio.emit("server_message", {"message": "Event received", "payload": payload})


@socketio.on("process_frame")
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

            if img_str.startswith("data:image"):
                img_str = img_str.split(",")[1]

            img_bytes = base64.b64decode(img_str)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

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


@socketio.on("generate_avatar")
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

    # Public generation supports the fixed-species AI material path and keeps
    # full-character generation as a research comparator. body_sprite is
    # retired: old history remains readable, but new requests must not spend
    # API budget on the visibly stitched legacy result.
    mode = (payload.get("mode") or os.environ.get("GENERATION_MODE", "brick_ai_texture")).strip()
    if mode == "body_sprite":
        emit("avatar_generated", {
            "ok": False,
            "is_final": True,
            "request_id": request_id,
            "character_mode": "body_sprite",
            "error": "mode_retired",
            "guidance": "AI 組合角色模式已退役，請重新整理頁面並使用 AI 材質 3D 角色。",
        })
        return
    brick_modes = {"brick_ai_texture"}
    if mode not in {*brick_modes, "full_character"}:
        mode = "brick_ai_texture"
    if mode not in brick_modes and mode not in get_style(style_id).supported_modes:
        mode = "brick_ai_texture"
    _history_call(
        start_run, request_id, mode=mode, style_id=style_id,
        source_type=source_type, experiment_id=experiment_id,
        comparison_id=comparison_id, variant_id=variant_id,
    )

    def _background():
        total_start = time.perf_counter()
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

            _progress("received", 5, "照片已接收，準備分析人物特徵")
            vlm_start = time.perf_counter()
            _progress("analyzing", 12, "正在分析人體輪廓、服裝區域與色彩")
            # Full-character image models already receive the source photo.
            # Calling two extra VLM endpoints duplicated visual analysis and
            # made full-image modes perform redundant visual analysis.
            # Keep VLM only for texture/body modes unless explicitly re-enabled.
            use_vlm = mode in {"brick_ai_texture", "body_sprite"} or os.environ.get("FULL_MODE_VLM_ENABLED", "0").strip().lower() in {"1", "true", "yes"}
            fut_outfit = _vlm_executor.submit(analyze_outfit, img_str) if use_vlm else None
            fut_face_vlm = _vlm_executor.submit(analyze_face, img_str) if use_vlm else None

            # Decode image
            img_b64 = img_str.split(",")[1] if img_str.startswith("data:image") else img_str
            img_bytes = base64.b64decode(img_b64)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            cv_result      = {}
            face_cv_result = {}
            rgb_full       = None
            body_poly      = None
            fut_garment    = None
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

            # body_sprite mode: spawn generation in PARALLEL with VLM (no VLM context needed).
            if mode == "body_sprite" and rgb_full is not None and body_poly is not None:
                fut_garment = _generation_executor.submit(
                    generate_body_png,
                    rgb_full, body_poly,
                    style_id=style_id,
                )
            cv_ms = int((time.perf_counter() - cv_start) * 1000)

            # Wait for VLM results with timeout (45s)
            vlm_result = {"ok": False, "error": "disabled_for_full_mode", "outfit": {"outer": "none", "inner": "tshirt", "lower": "jeans", "has_pattern": False}}
            vlm_face_result = {"ok": False, "error": "disabled_for_full_mode", "face": {}}
            vlm_timeout = 6 if mode in brick_modes else 45
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

            if face_cv_result.get("ok"):
                face_data.update({
                    "face_shape":    face_cv_result["face_shape"],
                    "eye_shape":     face_cv_result["eye_shape"],
                    "eyebrow_style": face_cv_result["eyebrow_style"],
                    "smile_score":   face_cv_result["smile_score"],
                    "lip_color":     face_cv_result.get("lip_color"),
                })

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
            if mode in brick_modes:
                _progress("building_character", 68, "正在建立一致的 3D 積木角色材質")
                character_spec = build_character_spec(
                    request_id=request_id,
                    cv_result=cv_result,
                    face_data=face_data,
                    outfit_data=outfit_data,
                    accessories=payload.get("accessories") or [],
                )
                validation = validate_character_spec(character_spec)
                fallback_used = bool((character_spec.get("quality") or {}).get("fallback_used"))
                is_ai_mode = mode == "brick_ai_texture"
                if is_ai_mode:
                    character_spec = {
                        **character_spec,
                        "quality": {
                            **(character_spec.get("quality") or {}),
                            "ai_texture_status": "pending",
                        },
                    }
                avatar_payload = _payload_for(
                    {"ok": validation.get("passed", False)},
                    stage="character_spec_base",
                    is_final=not is_ai_mode,
                    selected_mode=mode,
                    validation=validation,
                    retries=0,
                    fallback=fallback_used,
                    ok=validation.get("passed", False),
                    error=None if validation.get("passed") else "character_spec_invalid",
                )
                avatar_payload.update({
                    "character_spec": character_spec,
                    "body_png": None,
                    "garment_source": "ai_texture_pending" if is_ai_mode else "deterministic_texture",
                    "style_id": character_spec.get("style_id", "brick_v1"),
                })
                socketio.emit("avatar_generated", avatar_payload, to=sid)
                _progress(
                    "base_ready" if is_ai_mode else "complete",
                    70 if is_ai_mode else 100,
                    "3D 基礎角色已建立，準備 AI 材質" if is_ai_mode else "3D 積木角色已建立",
                )
                generation_ms = int((time.perf_counter() - generation_start) * 1000)
                final_status = "success" if validation.get("passed") else "failed"
                final_stage = "character_spec"
                final_validation = validation
                final_error = None if validation.get("passed") else "character_spec_invalid"
                if is_ai_mode:
                    _progress("generating_texture", 74, "AI 正在繪製臉部與服裝高細節材質")
                    ai_result = _await_generation(
                        _generation_executor.submit(
                            generate_ai_character_textures, img_str, character_spec
                        ),
                        timeout=55,
                        error="ai_texture_timeout",
                    )
                    ai_validation = ai_result.get("validation") or {
                        "passed": False,
                        "errors": [ai_result.get("error") or "ai_texture_failed"],
                        "warnings": [],
                    }
                    _record_generation_attempt("brick_texture", 0, ai_result, ai_validation)
                    _progress("validating_texture", 94, "正在檢查材質版位、顏色與細節")
                    if ai_result.get("ok") and ai_validation.get("passed"):
                        final_spec = apply_ai_textures(character_spec, ai_result)
                        final_status = "success"
                        final_error = None
                        final_source = "ai_texture"
                        final_fallback = False
                    else:
                        final_spec = {
                            **character_spec,
                            "quality": {
                                **(character_spec.get("quality") or {}),
                                "ai_texture_status": "failed",
                                "ai_texture_error": ai_result.get("error") or "ai_texture_validation_failed",
                            },
                        }
                        final_status = "failed"
                        final_error = ai_result.get("error") or "ai_texture_validation_failed"
                        final_source = "ai_texture_failed"
                        final_fallback = False
                    final_payload = _payload_for(
                        {"ok": final_status == "success"},
                        stage="ai_texture",
                        is_final=True,
                        selected_mode=mode,
                        validation=ai_validation,
                        retries=0,
                        fallback=final_fallback,
                        ok=final_status == "success",
                        error=None if final_status == "success" else final_error,
                        guidance=None if final_status == "success" else "AI 材質未通過物種或細節檢查，請重新拍攝或稍後重試。",
                    )
                    final_payload.update({
                        "character_spec": final_spec if final_status == "success" else None,
                        "body_png": None,
                        "garment_source": final_source,
                        "style_id": final_spec.get("style_id", "brick_v1"),
                        "ai_texture_status": (final_spec.get("quality") or {}).get("ai_texture_status"),
                    })
                    socketio.emit("avatar_generated", final_payload, to=sid)
                    _progress(
                        "complete" if final_status == "success" else "failed", 100,
                        "AI 高細節材質已完成" if final_status == "success" else "AI 材質未通過檢查",
                    )
                    fallback_used = final_fallback
                    final_stage = "ai_texture"
                    final_validation = ai_validation

            elif mode == "body_sprite":
                _progress("generating", 42, "正在生成軀幹與雙腿圖像")
                garment_result = _await_generation(fut_garment) if fut_garment is not None else {"ok": False, "error": "no_body_poly"}
                garment_result = _prepare_generated(garment_result)
                _progress("validating", 84, "正在檢查角色輪廓與下半身完整性")
                validation = _validate(garment_result)
                _record_generation_attempt("body", 0, garment_result, validation)
                if max_retries and garment_result.get("ok") and not validation.get("passed") and rgb_full is not None and body_poly is not None:
                    retry_count = 1
                    correction = correction_for_validation(validation)
                    garment_result = _await_generation(_generation_executor.submit(
                        generate_body_png, rgb_full, body_poly, style_id=style_id, correction=correction
                    ))
                    garment_result = _prepare_generated(garment_result)
                    validation = _validate(garment_result)
                    _record_generation_attempt("body", 1, garment_result, validation)
                if not validation.get("passed"):
                    fallback_used = True
                    garment_result = {"ok": False, "error": "grid_fallback"}
                socketio.emit("avatar_generated", _payload_for(
                    garment_result, stage="base", is_final=True, selected_mode="body_sprite",
                    validation=validation, retries=retry_count, fallback=fallback_used,
                ), to=sid)
                _progress("complete", 100, "模式一角色處理完成")
                base_generation_ms = int((time.perf_counter() - generation_start) * 1000)
                final_status = "fallback" if fallback_used else "success"
                final_stage = "base"
                final_validation = validation
                final_error = "grid_fallback" if fallback_used else None
                final_output = garment_result.get("body_png")

            elif mode == "full_character":
                _progress("generating", 40, "正在生成完整角色，這通常是最久的階段")
                if rgb_full is not None and body_poly is not None:
                    garment_result = _await_generation(_generation_executor.submit(
                        generate_full_character_png, rgb_full, body_poly, face_data, outfit_data,
                        True, regions, style_id,
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

    threading.Thread(target=_background, daemon=True).start()


@socketio.on("join_swarm")
def handle_join_swarm(payload):
    char_id = payload.get("id") or request.sid
    height_class = payload.get("height_class")
    if not payload.get("height_measurement_valid") or height_class not in {"short", "medium", "tall"}:
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
            "character_spec": payload.get("character_spec", existing.get("character_spec")),
            "character_mode": payload.get("character_mode", existing.get("character_mode", "body_sprite")),
            "height_class": height_class,
            "height_profile": height_profile,
            "height_measurement_valid": True,
            "style_id": payload.get("style_id", existing.get("style_id", "brick_v1")),
        }
        snapshot = list(_swarm_chars.values())
    emit("swarm_joined", {"id": char_id})
    # Send large immutable assets once when a character joins. Regular Boids
    # ticks omit body_png to avoid rebroadcasting megabytes ten times per second.
    socketio.emit("update_positions", {"characters": snapshot})


@socketio.on("get_swarm")
def handle_get_swarm(_payload=None):
    with _swarm_lock:
        snapshot = list(_swarm_chars.values())
    emit("update_positions", {"characters": snapshot})


@socketio.on("leave_swarm")
def handle_leave_swarm(payload):
    char_id = payload.get("id") or request.sid
    with _swarm_lock:
        _swarm_chars.pop(char_id, None)


@socketio.on("update_character")
def handle_update_character(payload):
    char_id = payload.get("id")
    if not char_id:
        return
    with _swarm_lock:
        if char_id in _swarm_chars:
            for k in ("upper", "lower", "upper_type", "lower_type", "accessories", "accessory", "arm_color", "face", "outfit", "body_png", "body_bbox", "character_spec", "character_mode", "height_class", "height_profile", "height_measurement_valid", "style_id"):
                if k in payload:
                    _swarm_chars[char_id][k] = payload[k]


def _swarm_background():
    while True:
        time.sleep(0.1)
        with _swarm_lock:
            chars = list(_swarm_chars.values())
        if not chars:
            continue
        updated = update_swarm_state(chars)
        with _swarm_lock:
            for c in updated:
                cid = c["id"]
                if cid in _swarm_chars:
                    _swarm_chars[cid].update(c)
        lightweight = [
            {key: value for key, value in character.items() if key not in {"body_png", "character_spec"}}
            for character in updated
        ]
        socketio.emit("update_positions", {"characters": lightweight})


threading.Thread(target=_swarm_background, daemon=True).start()


if __name__ == "__main__":
    # Werkzeug on Windows can leave several development processes sharing the
    # same port. Refuse a second launch so browsers cannot randomly reconnect to
    # an older copy of the capture logic.
    probe = network_socket.socket(network_socket.AF_INET, network_socket.SOCK_STREAM)
    probe.settimeout(0.4)
    try:
        port_is_busy = probe.connect_ex(("127.0.0.1", 5001)) == 0
    finally:
        probe.close()
    if port_is_busy:
        raise SystemExit("Port 5001 already has a PersonaFlow backend. Stop it before starting another instance.")
    socketio.run(app, host="0.0.0.0", port=5001, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
