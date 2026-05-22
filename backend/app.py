import base64
import os
import random
import threading
import time
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
from flask import Flask, jsonify, request
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
        generate_refine_character_png,
        _remove_white_background as _gg_remove_white_background,
    )
except Exception:
    from garment_gen import (  # type: ignore
        generate_body_png,
        generate_full_character_png,
        generate_refine_character_png,
        _remove_white_background as _gg_remove_white_background,
    )


app = Flask(__name__)
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

# --- single-user clothing feature state ---
_last_success_upper: Optional[Dict[str, Any]] = None
_last_success_lower: Optional[Dict[str, Any]] = None
_last_success_upper_type: str = "short_sleeve"
_last_success_lower_type: str = "shorts"
_last_success_landmarks: Optional[list] = None
_last_success_roi: Optional[Dict[str, Any]] = None
_last_success_cloth_grid: Optional[Dict[str, Any]] = None
_last_success_lower_grid: Optional[Dict[str, Any]] = None
_last_success_arm_color:  Optional[Dict[str, Any]] = None
_last_success_ts: Optional[float] = None

# --- swarm state ---
_swarm_chars: Dict[str, Any] = {
    "system_bot": {
        "id": "system_bot", "x": 500, "y": 500, "vx": 1, "vy": 1,
        "upper": {"hex": "#FFFFFF"}, "lower": {"hex": "#444444"},
        "outfit": {"inner_color": "#FF0000", "lower_color": "#0000FF"}
    }
}
_swarm_lock = threading.Lock()

# Thread pool for parallel VLM calls
_executor = ThreadPoolExecutor(max_workers=4)


def _merge_fallback_payload(features: Dict[str, Any]) -> Dict[str, Any]:
    global _last_success_upper, _last_success_lower, _last_success_upper_type, \
        _last_success_lower_type, _last_success_landmarks, _last_success_roi, \
        _last_success_cloth_grid, _last_success_lower_grid, _last_success_arm_color, \
        _last_success_ts

    if features.get("ok") is True:
        _last_success_upper = features.get("upper")
        _last_success_lower = features.get("lower")
        _last_success_upper_type = features.get("upper_type", "short_sleeve")
        _last_success_lower_type = features.get("lower_type", "shorts")
        _last_success_landmarks = features.get("landmarks")
        _last_success_roi = features.get("roi")
        _last_success_cloth_grid = features.get("cloth_grid")
        _last_success_lower_grid = features.get("lower_grid")
        _last_success_arm_color  = features.get("arm_color")
        _last_success_ts = time.time()
        return features

    return {
        "ok": False,
        "error": features.get("error"),
        "upper": _last_success_upper,
        "lower": _last_success_lower,
        "arm_color": _last_success_arm_color,
        "upper_type": _last_success_upper_type,
        "lower_type": _last_success_lower_type,
        "landmarks": _last_success_landmarks,
        "roi": _last_success_roi,
        "cloth_grid": _last_success_cloth_grid,
        "lower_grid": _last_success_lower_grid,
        "mask_stats": features.get("mask_stats", {}),
        "fallback": _last_success_upper is not None,
        "last_success_ts": _last_success_ts,
        "ts": time.time(),
    }


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok", "service": "PersonaFlow backend"})


@socketio.on("connect")
def handle_connect():
    emit("server_message", {"message": "Connected to PersonaFlow backend."})
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if chars:
        emit("update_positions", {"characters": chars})


@socketio.on("disconnect")
def handle_disconnect():
    pass


@socketio.on("client_event")
def handle_client_event(payload):
    socketio.emit("server_message", {"message": "Event received", "payload": payload})


@socketio.on("process_frame")
def handle_process_frame(payload):
    if cv2 is None:
        emit("clothing_features", _merge_fallback_payload({"ok": False, "error": "opencv_missing"}))
        return

    sid = request.sid

    def _process_in_background():
        try:
            img_str = payload.get("image")
            if not img_str:
                return

            if img_str.startswith("data:image"):
                img_str = img_str.split(",")[1]

            img_bytes = base64.b64decode(img_str)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            if frame is not None:
                features = get_clothing_features(frame, max_width=360)
                result = _merge_fallback_payload(features)
                if "ts" not in result:
                    result["ts"] = time.time()
                socketio.emit("clothing_features", result, to=sid)
            else:
                socketio.emit("clothing_features", _merge_fallback_payload({"ok": False, "error": "frame_decode_failed"}), to=sid)
        except Exception as e:
            socketio.emit("clothing_features", _merge_fallback_payload({"ok": False, "error": "cv_exception", "message": str(e)}), to=sid)

    _executor.submit(_process_in_background)


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

    # Generation mode: "body_sprite" (existing, fast, just upper+lower)
    #                  "full_character" (new, slow, head→feet single image).
    # Frontend sends mode in payload; .env GENERATION_MODE is the default.
    mode = (payload.get("mode") or os.environ.get("GENERATION_MODE", "body_sprite")).strip()
    if mode not in {"body_sprite", "full_character", "full_character_refined"}:
        mode = "body_sprite"

    def _background():
        try:
            # Submit VLM analyses to ThreadPoolExecutor
            fut_outfit   = _executor.submit(analyze_outfit, img_str)
            fut_face_vlm = _executor.submit(analyze_face, img_str)

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
            if frame is not None:
                cv_result      = get_clothing_features(frame, max_width=480)
                face_cv_result = get_face_features(frame, max_width=480)

                if cv_result.get("ok") and "body_poly" in cv_result:
                    try:
                        rgb_full  = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        body_poly = np.array(cv_result["body_poly"], dtype=np.float32)
                    except Exception as ge:
                        print(f"[generate_avatar] poly prep failed: {ge}")

            # body_sprite mode: spawn generation in PARALLEL with VLM (no VLM context needed).
            if mode == "body_sprite" and rgb_full is not None and body_poly is not None:
                fut_garment = _executor.submit(
                    generate_body_png,
                    rgb_full, body_poly,
                )

            # Wait for VLM results with timeout (45s)
            vlm_result      = fut_outfit.result(timeout=45)
            vlm_face_result = fut_face_vlm.result(timeout=45)

            # --- clothing data ---
            outfit_data = vlm_result.get("outfit", {})
            if "upper" in cv_result and "hex" in cv_result["upper"]:
                outfit_data["inner_color"] = cv_result["upper"]["hex"]
            if "lower" in cv_result and "hex" in cv_result["lower"]:
                outfit_data["lower_color"] = cv_result["lower"]["hex"]

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

            # --- Garment / character generation ---
            if mode == "full_character":
                if rgb_full is not None and body_poly is not None:
                    fut_gen = _executor.submit(
                        generate_full_character_png,
                        rgb_full, body_poly, face_data, outfit_data,
                    )
                    garment_result = fut_gen.result(timeout=45)
                else:
                    garment_result = {"ok": False, "error": "no_body_poly"}
            elif mode == "full_character_refined":
                if rgb_full is not None and body_poly is not None:
                    fut_base = _executor.submit(
                        generate_full_character_png,
                        rgb_full, body_poly, face_data, outfit_data, False,
                    )
                    base_result = fut_base.result(timeout=45)
                    if base_result.get("ok") and base_result.get("body_png"):
                        fut_ref = _executor.submit(
                            generate_refine_character_png,
                            base_result["body_png"], rgb_full, body_poly,
                            face_data, outfit_data,
                        )
                        refined = fut_ref.result(timeout=45)
                        if refined.get("ok"):
                            refined.setdefault("body_bbox", base_result.get("body_bbox"))
                            garment_result = refined
                        else:
                            print("[generate_avatar] refine failed, falling back to base")
                            base_cleaned = _gg_remove_white_background(base_result["body_png"])
                            garment_result = {
                                "ok": True,
                                "body_png": base_cleaned,
                                "body_bbox": base_result.get("body_bbox"),
                            }
                    else:
                        garment_result = base_result
                else:
                    garment_result = {"ok": False, "error": "no_body_poly"}
            else:
                garment_result = fut_garment.result(timeout=45) if fut_garment is not None else {"ok": False}

            socketio.emit("avatar_generated", {
                "ok":    True,
                "outfit": outfit_data,
                "stencil": cv_result.get("stencil"),
                "cloth_grid": cv_result.get("cloth_grid"),
                "lower_grid": cv_result.get("lower_grid"),
                "face":  face_data or None,
                "upper_type": sleeve_kind,
                "lower_type": cv_result.get("lower_type", "shorts"),
                "body_png":  garment_result.get("body_png"),
                "body_bbox": garment_result.get("body_bbox"),
                "garment_source": "openai" if garment_result.get("ok") else "grid",
                "character_mode": mode,
            }, to=sid)
        except Exception as e:
            print(f"[generate_avatar] error: {e}")
            socketio.emit("avatar_generated", {"ok": False, "error": str(e)}, to=sid)

    threading.Thread(target=_background, daemon=True).start()


@socketio.on("join_swarm")
def handle_join_swarm(payload):
    char_id = payload.get("id") or request.sid
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
            "arm_color": payload.get("arm_color", existing.get("arm_color")),
            "face": payload.get("face", existing.get("face")),
            "outfit": payload.get("outfit", existing.get("outfit")),
            "body_png": payload.get("body_png", existing.get("body_png")),
            "body_bbox": payload.get("body_bbox", existing.get("body_bbox")),
            "character_mode": payload.get("character_mode", existing.get("character_mode", "body_sprite")),
        }
    emit("swarm_joined", {"id": char_id})


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
            for k in ("upper", "lower", "upper_type", "lower_type", "accessories", "accessory", "arm_color", "face", "outfit", "body_png", "body_bbox", "character_mode"):
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
        socketio.emit("update_positions", {"characters": updated})


threading.Thread(target=_swarm_background, daemon=True).start()


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5001, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
