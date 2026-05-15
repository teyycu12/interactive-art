import base64
import os
import random
import threading
import time
from typing import Any, Dict, Optional

# Load .env before importing modules that read env vars (vlm_module, garment_gen)
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    load_dotenv()  # also try CWD
except ImportError:
    pass

import eventlet
import eventlet.tpool

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
    from backend.garment_gen import generate_body_png, generate_full_character_png  # type: ignore
except Exception:
    from garment_gen import generate_body_png, generate_full_character_png  # type: ignore


app = Flask(__name__)
app.config["SECRET_KEY"] = "personaflow-dev-secret"
socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=20 * 1024 * 1024)

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
_last_success_ts: Optional[float] = None

# --- swarm state ---
_swarm_chars: Dict[str, Any] = {}
_swarm_lock = threading.Lock()


def _merge_fallback_payload(features: Dict[str, Any]) -> Dict[str, Any]:
    global _last_success_upper, _last_success_lower, _last_success_upper_type, \
        _last_success_lower_type, _last_success_landmarks, _last_success_roi, \
        _last_success_cloth_grid, _last_success_lower_grid, _last_success_ts

    if features.get("ok") is True:
        _last_success_upper = features.get("upper")
        _last_success_lower = features.get("lower")
        _last_success_upper_type = features.get("upper_type", "short_sleeve")
        _last_success_lower_type = features.get("lower_type", "shorts")
        _last_success_landmarks = features.get("landmarks")
        _last_success_roi = features.get("roi")
        _last_success_cloth_grid = features.get("cloth_grid")
        _last_success_lower_grid = features.get("lower_grid")
        _last_success_ts = time.time()
        return features

    return {
        "ok": False,
        "error": features.get("error"),
        "upper": _last_success_upper,
        "lower": _last_success_lower,
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


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    with _swarm_lock:
        _swarm_chars.pop(sid, None)


@socketio.on("client_event")
def handle_client_event(payload):
    socketio.emit("server_message", {"message": "Event received", "payload": payload})


@socketio.on("process_frame")
def handle_process_frame(payload):
    if cv2 is None:
        emit("clothing_features", _merge_fallback_payload({"ok": False, "error": "opencv_missing"}))
        return

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
            emit("clothing_features", result)
        else:
            emit("clothing_features", _merge_fallback_payload({"ok": False, "error": "frame_decode_failed"}))
    except Exception as e:
        emit("clothing_features", _merge_fallback_payload({"ok": False, "error": "cv_exception", "message": str(e)}))


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
    if mode not in {"body_sprite", "full_character"}:
        mode = "body_sprite"

    def _background():
        try:
            # 並行執行兩個 VLM call（outfit + face），各自在 tpool 執行緒中運行
            t_outfit   = eventlet.spawn(eventlet.tpool.execute, analyze_outfit, img_str)
            t_face_vlm = eventlet.spawn(eventlet.tpool.execute, analyze_face,   img_str)

            # 解碼影像 (同步，快速)
            img_b64 = img_str.split(",")[1] if img_str.startswith("data:image") else img_str
            img_bytes = base64.b64decode(img_b64)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            cv_result      = {}
            face_cv_result = {}
            rgb_full       = None
            body_poly      = None
            t_garment      = None
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
            # full_character mode: must wait for VLM to inject face+outfit attrs into prompt.
            if mode == "body_sprite" and rgb_full is not None and body_poly is not None:
                t_garment = eventlet.spawn(
                    eventlet.tpool.execute,
                    generate_body_png,
                    rgb_full, body_poly,
                )

            # 等待 VLM 結果
            vlm_result      = t_outfit.wait()
            vlm_face_result = t_face_vlm.wait()

            # --- 服裝資料 ---
            outfit_data = vlm_result.get("outfit", {})
            if "upper" in cv_result and "hex" in cv_result["upper"]:
                outfit_data["inner_color"] = cv_result["upper"]["hex"]
            if "lower" in cv_result and "hex" in cv_result["lower"]:
                outfit_data["lower_color"] = cv_result["lower"]["hex"]

            # Derive sleeve length from VLM outfit semantics — more reliable
            # than cv_module's forearm-vs-shirt pixel-distance heuristic.
            _LONG_SLEEVE_OUTERS = {"blazer", "cardigan", "denim_jacket"}
            _LONG_SLEEVE_INNERS = {"button_up"}
            vlm_outer = (outfit_data.get("outer") or "none").lower()
            vlm_inner = (outfit_data.get("inner") or "tshirt").lower()
            if vlm_outer in _LONG_SLEEVE_OUTERS or vlm_inner in _LONG_SLEEVE_INNERS:
                sleeve_kind = "long_sleeve"
            else:
                # Fall back to cv heuristic if VLM gave us only a t-shirt label
                sleeve_kind = cv_result.get("upper_type", "short_sleeve")

            # --- 臉部資料 ---
            face_data: dict = {}

            # MediaPipe 只取幾何資訊（眼形、臉形、眉形）— 顏色改由 VLM 提供
            if face_cv_result.get("ok"):
                face_data.update({
                    "face_shape":    face_cv_result["face_shape"],
                    "eye_shape":     face_cv_result["eye_shape"],
                    "eyebrow_style": face_cv_result["eyebrow_style"],
                    "smile_score":   face_cv_result["smile_score"],
                    "lip_color":     face_cv_result.get("lip_color"),
                })

            # VLM 提供髮型 + 顏色（轉換為固定 hex）
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
                    garment_result = eventlet.tpool.execute(
                        generate_full_character_png,
                        rgb_full, body_poly, face_data, outfit_data,
                    )
                else:
                    garment_result = {"ok": False, "error": "no_body_poly"}
            else:
                garment_result = t_garment.wait() if t_garment is not None else {"ok": False}

            socketio.emit("avatar_generated", {
                "ok":    True,
                "outfit": outfit_data,
                "stencil": cv_result.get("stencil"),
                "cloth_grid": cv_result.get("cloth_grid"),
                "lower_grid": cv_result.get("lower_grid"),
                "face":  face_data or None,
                # Sleeve length flag — lets frontend render bare arm in skin colour for short sleeves
                "upper_type": sleeve_kind,
                "lower_type": cv_result.get("lower_type", "shorts"),
                # AI-generated sprite — same field for both modes; character_mode tells the
                # frontend which renderer to use (sprite-as-body vs sprite-as-whole-figure).
                "body_png":  garment_result.get("body_png"),
                "body_bbox": garment_result.get("body_bbox"),
                "garment_source": "openai" if garment_result.get("ok") else "grid",
                "character_mode": mode,
            }, to=sid)
        except Exception as e:
            print(f"[generate_avatar] error: {e}")
            socketio.emit("avatar_generated", {"ok": False, "error": str(e)}, to=sid)

    socketio.start_background_task(_background)


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
            "accessory": payload.get("accessory", existing.get("accessory", "none")),
            "face": payload.get("face", existing.get("face")),
            "outfit": payload.get("outfit", existing.get("outfit")),
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
            for k in ("upper", "lower", "upper_type", "lower_type", "accessory", "face", "outfit"):
                if k in payload:
                    _swarm_chars[char_id][k] = payload[k]


def _swarm_background():
    while True:
        socketio.sleep(0.1)
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


socketio.start_background_task(_swarm_background)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
