import base64
import random
import threading
import time
from typing import Any, Dict, Optional
from concurrent.futures import ThreadPoolExecutor

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


app = Flask(__name__)
app.config["SECRET_KEY"] = "personaflow-dev-secret"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

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

# Thread pool for parallel VLM calls (replaces eventlet)
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
    # Push current swarm state immediately so projection.html doesn't have to
    # wait for the next _swarm_background tick (which only fires when non-empty).
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if chars:
        emit("update_positions", {"characters": chars})


@socketio.on("get_swarm")
def handle_get_swarm(_payload=None):
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    emit("update_positions", {"characters": chars})


@socketio.on("disconnect")
def handle_disconnect():
    # 暫不移除，避免分頁切換導致角色消失
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

    def _background():
        try:
            # 解碼影像 (同步，快速)
            img_b64 = img_str.split(",")[1] if img_str.startswith("data:image") else img_str
            img_bytes = base64.b64decode(img_b64)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            cv_result      = {}
            face_cv_result = {}
            if frame is not None:
                cv_result      = get_clothing_features(frame, max_width=480)
                face_cv_result = get_face_features(frame, max_width=480)

            # --- 服裝資料 (CV 優先) ---
            outfit_data = {
                "inner": "tshirt",
                "lower": "jeans",
                "outer": "none",
                "inner_color": cv_result.get("upper", {}).get("hex", "#808080"),
                "lower_color": cv_result.get("lower", {}).get("hex", "#336699"),
                "outer_color": None,
                "has_pattern": False,
            }

            # 嘗試 VLM（5 秒 timeout，失敗就用 CV 結果）
            try:
                future_outfit = _executor.submit(analyze_outfit, img_str)
                vlm_result = future_outfit.result(timeout=5)
                if vlm_result.get("ok"):
                    vlm_outfit = vlm_result.get("outfit", {})
                    outfit_data["inner"] = vlm_outfit.get("inner", outfit_data["inner"])
                    outfit_data["lower"] = vlm_outfit.get("lower", outfit_data["lower"])
                    outfit_data["outer"] = vlm_outfit.get("outer", outfit_data["outer"])
                    outfit_data["has_pattern"] = vlm_outfit.get("has_pattern", False)
                    print(f"[VLM] Outfit analysis OK: {vlm_outfit}")
                else:
                    print(f"[VLM] Outfit fallback (error): {vlm_result.get('error')}")
            except Exception as e:
                print(f"[VLM] Outfit timeout/error, using CV only: {e}")

            # --- 臉部資料 ---
            face_data: dict = {}

            # MediaPipe 幾何資訊
            if face_cv_result.get("ok"):
                face_data.update({
                    "face_shape":    face_cv_result["face_shape"],
                    "eye_shape":     face_cv_result["eye_shape"],
                    "eyebrow_style": face_cv_result["eyebrow_style"],
                    "smile_score":   face_cv_result["smile_score"],
                    "lip_color":     face_cv_result.get("lip_color"),
                })

            # 嘗試 VLM face（5 秒 timeout）
            try:
                future_face = _executor.submit(analyze_face, img_str)
                vlm_face_result = future_face.result(timeout=5)
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
                    print(f"[VLM] Face analysis OK")
            except Exception as e:
                print(f"[VLM] Face timeout/error, using CV only: {e}")

            print(f"[generate_avatar] inner_color={outfit_data['inner_color']}, lower_color={outfit_data['lower_color']}")
            socketio.emit("avatar_generated", {
                "ok":        True,
                "outfit":    outfit_data,
                "stencil":   cv_result.get("stencil"),
                "cloth_grid": cv_result.get("cloth_grid"),
                "lower_grid": cv_result.get("lower_grid"),
                "arm_color": cv_result.get("arm_color"),
                "face":      face_data or None,
            }, to=sid)
        except Exception as e:
            print(f"[generate_avatar] error: {e}")
            socketio.emit("avatar_generated", {"ok": False, "error": str(e)}, to=sid)

    socketio.start_background_task(_background)


@socketio.on("join_swarm")
def handle_join_swarm(payload):
    char_id = payload.get("id") or request.sid
    with _swarm_lock:
        print(f"[Swarm] Character joined: {char_id}")
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
            "arm":   payload.get("arm",   existing.get("arm")),
            "upper_type": payload.get("upper_type", existing.get("upper_type", "short_sleeve")),
            "lower_type": payload.get("lower_type", existing.get("lower_type", "shorts")),
            "accessories": payload.get("accessories", existing.get("accessories", [])),
            "accessory":   payload.get("accessory",   existing.get("accessory", "none")),
            "cloth_grid":  payload.get("cloth_grid",  existing.get("cloth_grid")),
            "lower_grid":  payload.get("lower_grid",  existing.get("lower_grid")),
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
            for k in ("upper", "lower", "arm", "upper_type", "lower_type", "accessories", "accessory", "face", "outfit", "cloth_grid", "lower_grid"):
                if k in payload:
                    _swarm_chars[char_id][k] = payload[k]


def _swarm_background():
    """Background thread: updates boid positions and broadcasts to all clients."""
    print("[Swarm] Background task started!")
    while True:
        time.sleep(0.1)
        try:
            with _swarm_lock:
                chars = list(_swarm_chars.values())
            if not chars:
                continue
            updated = update_swarm_state(chars)
            with _swarm_lock:
                for c in updated:
                    cid = c.get("id")
                    if cid and cid in _swarm_chars:
                        _swarm_chars[cid].update(c)
            # JSON-safe payload only includes fields projection.html needs
            safe_payload = []
            for c in updated:
                safe_payload.append({
                    "id": c.get("id"),
                    "x": float(c.get("x", 0)),
                    "y": float(c.get("y", 0)),
                    "vx": float(c.get("vx", 0)),
                    "vy": float(c.get("vy", 0)),
                    "state": str(c.get("state", "ROAMING")),
                    "outfit": c.get("outfit", {}),
                    "upper": c.get("upper", {}),
                    "lower": c.get("lower", {}),
                    "cloth_grid": c.get("cloth_grid"),
                    "lower_grid": c.get("lower_grid"),
                    "face": c.get("face"),
                    "accessory": c.get("accessory"),
                    "accessories": c.get("accessories", []),
                })
            socketio.emit("update_positions", {"characters": safe_payload})
        except Exception as e:
            print(f"[Swarm Error] {e}")


# Start background thread (native threading — no eventlet deadlock)
_swarm_thread = threading.Thread(target=_swarm_background, daemon=True)
_swarm_thread.start()


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5001, debug=False, allow_unsafe_werkzeug=True)
