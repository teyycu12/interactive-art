import base64
import os
import random
import threading
import time
from typing import Any, Dict, List, Optional
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
from flask_socketio import SocketIO, emit, join_room, leave_room

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
    from backend.event_logger import log_event, Timer  # type: ignore
except Exception:
    from event_logger import log_event, Timer  # type: ignore

try:
    from backend.swarm_snapshot import save_snapshot, load_snapshot  # type: ignore
    from backend.photo_composer import compose_group_photo  # type: ignore
    from backend.bot_simulator import inject_bots, remove_bots  # type: ignore
    from backend.circuit_breaker import gemini_breaker, image_gen_breaker  # type: ignore
except Exception:
    from swarm_snapshot import save_snapshot, load_snapshot  # type: ignore
    from photo_composer import compose_group_photo  # type: ignore
    from bot_simulator import inject_bots, remove_bots  # type: ignore
    from circuit_breaker import gemini_breaker, image_gen_breaker  # type: ignore

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

_PHOTOS_DIR = os.path.join(os.path.dirname(__file__), "photos")
os.makedirs(_PHOTOS_DIR, exist_ok=True)

# 啟動時自動還原快照（若有），否則預設 system_bot
_restored_chars = load_snapshot()
if _restored_chars:
    _swarm_chars: Dict[str, Any] = _restored_chars
else:
    _swarm_chars: Dict[str, Any] = {
        "system_bot": {
            "id": "system_bot", "room": "default", "x": 500, "y": 500, "vx": 1, "vy": 1,
            "upper": {"hex": "#FFFFFF"}, "lower": {"hex": "#444444"},
            "outfit": {"inner_color": "#FF0000", "lower_color": "#0000FF"}
        }
    }

# 支援 AUTO_BOTS 環境變數在啟動時自動注入指定數量之虛擬角色
_auto_bots_count = int(os.environ.get("AUTO_BOTS", "0"))
if _auto_bots_count > 0:
    inject_bots(_swarm_chars, count=_auto_bots_count)

_swarm_lock = threading.Lock()

# --- swarm 容量上限（inject_bots 為公開控制事件，需防止資源耗盡）---
# swarm 每 0.1s tick 做 O(n^2) 計算並廣播整包資料，總量必須設硬上限。
MAX_SWARM_SIZE = int(os.environ.get("MAX_SWARM_SIZE", "300"))
MAX_BOTS_PER_INJECT = int(os.environ.get("MAX_BOTS_PER_INJECT", "100"))

# Thread pool for parallel VLM calls
_executor = ThreadPoolExecutor(max_workers=4)

# --- 熔斷器橋接 ---
# vlm_module / gemini_gen 的函式會吞掉例外並回傳 {"ok": False, ...}，
# 熔斷器只認得例外，因此包一層把「回傳失敗」轉成例外，讓失敗被計數。
class _ExternalCallFailed(Exception):
    """外部 API 回傳失敗結果（非例外）時用來觸發熔斷器計數。"""
    pass


def _raise_on_failure(func, *args, **kwargs):
    result = func(*args, **kwargs)
    if isinstance(result, dict) and result.get("ok") is False:
        raise _ExternalCallFailed(result.get("error", "external call returned ok=False"))
    return result


# --- generate_avatar 併發控制（第 8 節風險：多人同時拍照單點瓶頸）---
# 同時最多跑 GEN_MAX_CONCURRENT 個生成流程，超過的排隊等待，
# 避免多人瞬間拍照擠爆 ThreadPoolExecutor / Gemini 佇列造成全部卡死。
# 排隊中的請求會收到 avatar_progress 告知前面還有幾個。
_GEN_MAX_CONCURRENT = int(os.environ.get("GEN_MAX_CONCURRENT", "2"))
_gen_semaphore = threading.Semaphore(_GEN_MAX_CONCURRENT)
_gen_waiting = 0                      # 目前排隊中（尚未取得 slot）的請求數
_gen_waiting_lock = threading.Lock()


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


@app.route("/photos/<path:filename>", methods=["GET"])
def serve_photo(filename):
    return send_from_directory(_PHOTOS_DIR, filename)



@socketio.on("connect")
def handle_connect():
    emit("server_message", {"message": "Connected to PersonaFlow backend."})
    log_event("connect", pid=request.sid)
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    if chars:
        emit("update_positions", {"characters": chars})


@socketio.on("disconnect")
def handle_disconnect():
    # 斷線時只移除「這條連線自己就是角色本人」的情況：char_id == sid。
    # 互動端拍完照關分頁時，其角色 id 通常就是當時的 sid；投影牆連線斷開
    # 不該把別人加入的角色一起清掉，故只 pop sid 對應者（見技術架構文件 5.2）。
    sid = request.sid
    removed = False
    with _swarm_lock:
        if sid in _swarm_chars:
            _swarm_chars.pop(sid, None)
            removed = True
    log_event("disconnect", pid=sid, removed_char=removed)


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

    # 拍照→送出到後端收到請求的牆鐘時間起點（生成延遲量測起點，見第 6 節）
    _req_start = time.perf_counter()

    def _background():
        # 各子流程里程碑毫秒數，最後一起寫進 avatar_generated 事件的 log
        _timings: Dict[str, Any] = {}

        def _elapsed_ms() -> float:
            return round((time.perf_counter() - _req_start) * 1000.0, 1)

        def _progress(stage, pct, detail=""):
            socketio.emit("avatar_progress", {"stage": stage, "pct": pct, "detail": detail}, to=sid)

        global _gen_waiting

        # --- 併發閘門：多人同時拍照時排隊，避免單點瓶頸卡死（第 8 節風險）---
        acquired = _gen_semaphore.acquire(blocking=False)
        if not acquired:
            # 有人正在生成，本請求進入排隊；先告知前端排隊位置
            with _gen_waiting_lock:
                _gen_waiting += 1
                ahead = _gen_waiting
            _progress("queued", 2, f"生成中人數已滿，排隊中（前面還有 {ahead} 人）...")
            log_event("generate_queued", pid=sid, ahead=ahead, mode=mode)
            _queue_wait_start = time.perf_counter()
            _gen_semaphore.acquire(blocking=True)  # 阻塞等到有 slot
            with _gen_waiting_lock:
                _gen_waiting -= 1
            _timings["queue_wait_ms"] = round((time.perf_counter() - _queue_wait_start) * 1000.0, 1)

        try:
            print(f"[generate_avatar] Received request: mode={mode}, img_len={len(img_str) if img_str else 0}")
            _progress("analyzing", 5, "正在分析服裝與面部特徵...")

            # Submit VLM analyses to ThreadPoolExecutor (parallel)
            _vlm_start = time.perf_counter()
            # 經由熔斷器呼叫：外部 API 連續失敗時快速失敗並回傳 fallback，
            # 避免 executor 執行緒持續被無效等待卡住。
            fut_outfit   = _executor.submit(
                gemini_breaker.call, _raise_on_failure, analyze_outfit, img_str,
                fallback={"ok": False, "error": "circuit_open"},
            )
            fut_face_vlm = _executor.submit(
                gemini_breaker.call, _raise_on_failure, analyze_face, img_str,
                fallback={"ok": False, "error": "circuit_open"},
            )

            # Ultra-robust base64 image decoding
            frame = None
            try:
                # Extract clean base64 data
                img_b64 = img_str.split(",")[1] if img_str.startswith("data:image") else img_str
                # Very important: replace spaces with pluses (transports often decode + to space)
                img_b64 = img_b64.replace(" ", "+")
                
                # Enforce correct base64 padding
                missing_padding = len(img_b64) % 4
                if missing_padding:
                    img_b64 += "=" * (4 - missing_padding)

                img_bytes = base64.b64decode(img_b64)
                
                # Register HEIF/HEIC support (iPhone photos) before opening
                try:
                    from pillow_heif import register_heif_opener
                    register_heif_opener()
                except ImportError:
                    pass
                
                import io
                from PIL import Image
                pil_img = Image.open(io.BytesIO(img_bytes))
                if pil_img.mode != "RGB":
                    pil_img = pil_img.convert("RGB")
                
                # Convert PIL (RGB) to OpenCV (BGR)
                frame = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
                print(f"[generate_avatar] Robust Pillow decode successful: shape={frame.shape}")
            except Exception as e:
                print(f"[generate_avatar] Robust decode failed: {e}")
                # Dump diagnostic info
                try:
                    with open("backend/diagnostic_img_str.txt", "w") as df:
                        df.write(f"img_str_len={len(img_str) if img_str else 0}\n")
                        df.write(f"img_str_start={img_str[:2000] if img_str else 'None'}\n")
                        df.write(f"img_str_end={img_str[-2000:] if img_str else 'None'}\n")
                    print("[generate_avatar] Dumped diagnostic info to backend/diagnostic_img_str.txt")
                except Exception as de_err:
                    print(f"[generate_avatar] Failed to write diagnostic file: {de_err}")
                
                # Fallback to direct OpenCV decoding if PIL fails
                try:
                    np_arr = np.frombuffer(img_bytes, np.uint8)
                    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                except Exception as e2:
                    print(f"[generate_avatar] OpenCV fallback decode also failed: {e2}")

            if frame is None:
                print("[generate_avatar] ERROR: All decoding methods failed to parse the frame!")
            else:
                print(f"[generate_avatar] Frame decoded successfully: shape={frame.shape}")

            cv_result      = {}
            face_cv_result = {}
            rgb_full       = None
            body_poly      = None
            fut_garment    = None

            if frame is not None:
                rgb_full = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                # Parallelize CV calls — clothing + face run simultaneously
                _cv_start = time.perf_counter()
                fut_cv      = _executor.submit(get_clothing_features, frame, max_width=480)
                fut_face_cv = _executor.submit(get_face_features, frame, max_width=480)

                cv_result      = fut_cv.result(timeout=30)
                face_cv_result = fut_face_cv.result(timeout=30)
                # CV 子流程延遲（第 6 節指標：目標 < 1s）
                _timings["cv_ms"] = round((time.perf_counter() - _cv_start) * 1000.0, 1)

                if cv_result and isinstance(cv_result, dict) and cv_result.get("ok") and "body_poly" in cv_result and len(cv_result["body_poly"]) >= 3:
                    try:
                        body_poly = np.array(cv_result["body_poly"], dtype=np.float32)
                    except Exception as ge:
                        print(f"[generate_avatar] poly prep failed: {ge}")

                # If MediaPipe skeleton detection missed body_poly (e.g. portrait photos, close-up uploads),
                # construct a high-quality default central crop area so VLM/Image-Gen still functions perfectly!
                if body_poly is None or len(body_poly) < 3:
                    print("[generate_avatar] MediaPipe skeleton detection missed body_poly. Using default central crop.")
                    body_poly = np.array([
                        [0.25, 0.10],  # Top-left
                        [0.75, 0.10],  # Top-right
                        [0.75, 0.90],  # Bottom-right
                        [0.25, 0.90]   # Bottom-left
                    ], dtype=np.float32)

            _progress("analyzing", 20, "特徵分析完成，等待 VLM 結果...")

            # body_sprite mode: spawn generation in PARALLEL with VLM (no VLM context needed).
            if mode == "body_sprite" and rgb_full is not None and body_poly is not None:
                fut_garment = _executor.submit(
                    image_gen_breaker.call,
                    _raise_on_failure, generate_body_png,
                    rgb_full, body_poly,
                    fallback={"ok": False, "error": "circuit_open"},
                )

            # Wait for VLM results
            vlm_result      = fut_outfit.result(timeout=120)
            vlm_face_result = fut_face_vlm.result(timeout=120)
            # VLM 子流程延遲（兩支 Gemini 並行，第 6 節指標：中位數 < 5s）
            _timings["vlm_ms"] = round((time.perf_counter() - _vlm_start) * 1000.0, 1)
            # VLM 成敗旗標，供失敗率統計（第 6 節：目標 < 15%）
            _timings["vlm_outfit_ok"] = bool(vlm_result.get("ok", True)) if isinstance(vlm_result, dict) else False
            _timings["vlm_face_ok"]   = bool(vlm_face_result.get("ok", True)) if isinstance(vlm_face_result, dict) else False

            _progress("analyzing", 30, "VLM 分析完成")

            # --- clothing data ---
            outfit_data = vlm_result.get("outfit", {})
            if cv_result and isinstance(cv_result, dict) and "upper" in cv_result and "hex" in cv_result["upper"]:
                outfit_data["inner_color"] = cv_result["upper"]["hex"]
            if cv_result and isinstance(cv_result, dict) and "lower" in cv_result and "hex" in cv_result["lower"]:
                outfit_data["lower_color"] = cv_result["lower"]["hex"]

            # Derive sleeve length from VLM outfit semantics — more reliable
            _LONG_SLEEVE_OUTERS = {"blazer", "cardigan", "denim_jacket"}
            _LONG_SLEEVE_INNERS = {"button_up"}
            vlm_outer = (outfit_data.get("outer") or "none").lower()
            vlm_inner = (outfit_data.get("inner") or "tshirt").lower()
            if vlm_outer in _LONG_SLEEVE_OUTERS or vlm_inner in _LONG_SLEEVE_INNERS:
                sleeve_kind = "long_sleeve"
            else:
                sleeve_kind = cv_result.get("upper_type", "short_sleeve") if (cv_result and isinstance(cv_result, dict)) else "short_sleeve"

            # --- facial data ---
            face_data: dict = {}

            if face_cv_result and isinstance(face_cv_result, dict) and face_cv_result.get("ok"):
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
                    "hair_color_name": vf.get("hair_color", "dark_brown"),
                    "skin_tone":   _SKIN_HEX.get(vf.get("skin_tone",   "light"),      "#FFD0A8"),
                    "skin_tone_name": vf.get("skin_tone", "light"),
                    "eye_color":   _EYE_HEX.get( vf.get("eye_color",   "brown"),      "#7A4A28"),
                    "eye_color_name": vf.get("eye_color", "brown"),
                    "has_beard":   vf.get("has_beard", False),
                    "beard_style": vf.get("beard_style", "none"),
                })

            # --- Garment / character generation ---
            if mode == "full_character":
                _progress("generating", 35, "正在生成 LEGO 全人物...")
                if rgb_full is not None and body_poly is not None:
                    fut_gen = _executor.submit(
                        image_gen_breaker.call,
                        _raise_on_failure, generate_full_character_png,
                        rgb_full, body_poly, face_data, outfit_data,
                        fallback={"ok": False, "error": "circuit_open"},
                    )
                    garment_result = fut_gen.result(timeout=120)
                else:
                    garment_result = {"ok": False, "error": "no_body_poly"}
                _progress("generating", 85, "圖片生成完成")
            elif mode == "full_character_refined":
                _progress("generating", 35, "正在生成 LEGO 全人物（第一階段）...")
                if rgb_full is not None and body_poly is not None:
                    fut_base = _executor.submit(
                        image_gen_breaker.call,
                        _raise_on_failure, generate_full_character_png,
                        rgb_full, body_poly, face_data, outfit_data, False,
                        fallback={"ok": False, "error": "circuit_open"},
                    )
                    base_result = fut_base.result(timeout=120)
                    if base_result.get("ok") and base_result.get("body_png"):
                        _progress("refining", 60, "正在精修細節（第二階段）...")
                        fut_ref = _executor.submit(
                            image_gen_breaker.call,
                            _raise_on_failure, generate_refine_character_png,
                            base_result["body_png"], rgb_full, body_poly,
                            face_data, outfit_data,
                            fallback={"ok": False, "error": "circuit_open"},
                        )
                        refined = fut_ref.result(timeout=120)
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
                _progress("generating", 85, "圖片生成完成")
            else:
                _progress("generating", 35, "正在生成上下身...")
                garment_result = fut_garment.result(timeout=120) if fut_garment is not None else {"ok": False}
                _progress("generating", 85, "圖片生成完成")

            _progress("finalizing", 95, "正在完成...")

            is_full_mode = mode in ("full_character", "full_character_refined")
            success = garment_result.get("ok", False) if is_full_mode else True
            err_msg = garment_result.get("error") if not success else None

            # 生成延遲落地（第 6 節指標：拍照完成→avatar_generated 回傳，目標中位數 < 5s）
            log_event("avatar_generated", pid=sid, latency_ms=_elapsed_ms(),
                      mode=mode, ok=success, error=err_msg,
                      garment_source=("openai" if garment_result.get("ok") else "grid"),
                      **_timings)

            socketio.emit("avatar_generated", {
                "ok":    success,
                "error": err_msg,
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
            # 失敗也要落地，才能算出誠實的失敗率（第 6 節指標）
            log_event("avatar_generated", pid=sid, latency_ms=_elapsed_ms(),
                      mode=mode, ok=False, error=str(e), **_timings)
            socketio.emit("avatar_generated", {"ok": False, "error": str(e)}, to=sid)
        finally:
            # 無論成敗都要釋放 slot，讓排隊中的下一位進來
            _gen_semaphore.release()


    threading.Thread(target=_background, daemon=True).start()


@socketio.on("join_swarm")
def handle_join_swarm(payload):
    char_id = payload.get("id") or request.sid
    room = payload.get("room", "default")
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
            "arm_color": payload.get("arm_color", existing.get("arm_color")),
            "face": payload.get("face", existing.get("face")),
            "outfit": payload.get("outfit", existing.get("outfit")),
            "body_png": payload.get("body_png", existing.get("body_png")),
            "body_bbox": payload.get("body_bbox", existing.get("body_bbox")),
            "character_mode": payload.get("character_mode", existing.get("character_mode", "body_sprite")),
        }
        total = len(_swarm_chars)
    join_room(room)
    emit("swarm_joined", {"id": char_id, "room": room})
    log_event("join_swarm", pid=char_id, room=room,
              x=float(payload.get("x", 960)), y=float(payload.get("y", 540)),
              character_mode=payload.get("character_mode", "body_sprite"),
              swarm_size=total)


@socketio.on("leave_swarm")
def handle_leave_swarm(payload):
    char_id = payload.get("id") or request.sid
    with _swarm_lock:
        removed = _swarm_chars.pop(char_id, None) is not None
        total = len(_swarm_chars)
    log_event("leave_swarm", pid=char_id, removed=removed, swarm_size=total)


@socketio.on("update_character")
def handle_update_character(payload):
    char_id = payload.get("id")
    if not char_id:
        return
    changed = []
    with _swarm_lock:
        if char_id in _swarm_chars:
            for k in ("upper", "lower", "upper_type", "lower_type", "accessories", "accessory", "arm_color", "face", "outfit", "body_png", "body_bbox", "character_mode", "room"):
                if k in payload:
                    _swarm_chars[char_id][k] = payload[k]
                    changed.append(k)
    if changed:
        log_event("update_character", pid=char_id, fields=",".join(changed))


@socketio.on("get_swarm")
def handle_get_swarm(payload=None):
    payload = payload or {}
    room = payload.get("room")
    with _swarm_lock:
        if room:
            chars = [c for c in _swarm_chars.values() if c.get("room", "default") == room]
        else:
            chars = list(_swarm_chars.values())
    emit("update_positions", {"characters": chars})
    log_event("get_swarm", pid=request.sid, room=room, swarm_size=len(chars))


@socketio.on("trigger_photo")
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

    host = request.host if request else "127.0.0.1:5001"
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
    socketio.emit("photo_ready", {
        "ok": res.get("ok", False),
        "photo_id": res.get("photo_id"),
        "photo_url": res.get("photo_url"),
        "photo_b64": res.get("photo_b64"),
        "qr_b64": res.get("qr_b64"),
        "character_count": len(chars),
        "room": room,
    })


@socketio.on("inject_bots")
def handle_inject_bots(payload=None):
    payload = payload or {}
    # 這是任何已連線客戶端都能觸發的控制端事件，且 swarm 計算為 O(n^2)，
    # 因此必須驗證 count 並限制總量，避免單一請求讓背景迴圈卡死服務。
    try:
        count = int(payload.get("count", 10))
    except (TypeError, ValueError):
        emit("inject_bots_rejected", {"reason": "invalid_count"})
        return
    if count <= 0:
        emit("inject_bots_rejected", {"reason": "invalid_count"})
        return

    count = min(count, MAX_BOTS_PER_INJECT)
    room = payload.get("room", "default")
    with _swarm_lock:
        available = MAX_SWARM_SIZE - len(_swarm_chars)
        count = min(count, max(0, available))
        if count == 0:
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
    socketio.emit("update_positions", {"characters": chars})


@socketio.on("remove_bots")
def handle_remove_bots(_payload=None):
    with _swarm_lock:
        removed = remove_bots(_swarm_chars)
        total = len(_swarm_chars)
    log_event("remove_bots", removed=removed, total=total)
    with _swarm_lock:
        chars = list(_swarm_chars.values())
    socketio.emit("update_positions", {"characters": chars})


@socketio.on("save_snapshot")
def handle_save_snapshot(_payload=None):
    with _swarm_lock:
        ok = save_snapshot(_swarm_chars)
    emit("snapshot_saved", {"ok": ok})


# 上一個 tick 處於 GREETING 狀態的角色集合，用來只 log「新發生」的相遇，
# 避免每 0.1s tick 對持續靠近中的角色重複寫 log 灌爆檔案。
_prev_greeting: set = set()
_last_summary_ts: float = 0.0
_last_snapshot_ts: float = 0.0


def _swarm_background():
    global _prev_greeting, _last_summary_ts, _last_snapshot_ts
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
            socketio.emit("update_positions",
                          {"characters": room_updated}, room=room_name)
            updated.extend(room_updated)

        with _swarm_lock:
            for c in updated:
                cid = c["id"]
                if cid in _swarm_chars:
                    _swarm_chars[cid].update(c)

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


threading.Thread(target=_swarm_background, daemon=True).start()



if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5001, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
