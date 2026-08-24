"""拍攝閘門的時序判定：單張影格的量測 → 跨影格的可拍攝狀態。

``capture_quality`` 判斷的是「這一張影格本身好不好」（人在不在、腳有沒有入鏡、
構圖對不對）。但「可以按快門了」是跨影格的問題：人必須連續數幀不動，身高比例
也必須連續數幀落在同一個範圍內，否則量到的會是走動中的瞬間值。

這個模組只放那段時序邏輯，且刻意不 import flask、socketio 或 mediapipe ——
它接受已經算好的 ``features``（來自 ``cv_module.get_clothing_features``）與
上一幀的位移量，回傳補上時序欄位的同一份 dict。

為什麼獨立成模組：這套判準原本只存在於 ``app.py`` 的 Socket.io 預覽處理器裡，
與 request.sid 焊死。整合版的控制器走的是 HTTP，若在 ``service.py`` 重寫一次，
兩邊的門檻與判準會各自演化 —— 而那種漂移不會有任何錯誤訊息，只會表現為
「兩個入口拍出來的角色品質不一樣」。

⚠ ``app.py`` 目前仍是自己那份實作，尚未改用本模組。``tests/test_capture_session.py``
   有一條測試直接比對兩邊的門檻值，任一邊改了而另一邊沒跟上就會失敗。
"""

from __future__ import annotations

import os
import secrets
import statistics
import threading
import time
from typing import Any, Dict, List, Optional

# 門檻與 app.py 完全一致（同樣的環境變數、同樣的預設值與下限夾制）。
STABLE_FRAMES = max(2, int(os.getenv("CAPTURE_STABLE_FRAMES", "3")))
MOTION_MAX = max(0.01, float(os.getenv("CAPTURE_MOTION_MAX", "0.035")))
HEIGHT_STABLE_FRAMES = max(2, int(os.getenv("HEIGHT_STABLE_FRAMES", "3")))
HEIGHT_RATIO_SPAN_MAX = max(0.02, float(os.getenv("HEIGHT_RATIO_SPAN_MAX", "0.08")))

# 身高樣本與目前中位數差距超過這個值就視為換人或遮罩跳動，整個視窗重來。
HEIGHT_OUTLIER_JUMP = 0.12


def new_session() -> Dict[str, Any]:
    return {"stable_count": 0, "touched_at": time.time()}


def update(live: Dict[str, Any], features: Dict[str, Any],
           displacement: Optional[float],
           classify_height=None) -> Dict[str, Any]:
    """把時序欄位補進 ``features``，並更新 ``live`` 這一份 session 狀態。

    ``classify_height`` 由呼叫端提供（``height_profiles.classify_height``），
    這個模組不直接相依它，測試才能單獨驗證時序邏輯。
    """
    raw_ready = bool(features.get("capture_ready_raw"))

    # 穩定度：只有在單幀本身合格時才累積，一旦不合格整個視窗清空 ——
    # 否則人走出去再走回來，會沿用走出去之前的計數直接判定可拍攝。
    window: List[float] = list(live.get("displacements") or [])
    if raw_ready:
        # 第一幀沒有前一幀可比，計為零位移而非捨棄，否則永遠少一格。
        window.append(0.0 if displacement is None else displacement)
        window = window[-STABLE_FRAMES:]
    else:
        window = []
    average = sum(window) / len(window) if window else None
    stable_count = len(window) if average is not None and average <= MOTION_MAX else 0
    live["displacements"] = window if stable_count else []
    live["stable_count"] = stable_count

    # 身高：連續數幀落在同一範圍才算量到。
    raw_height_ratio = features.get("height_ratio")
    height_ready = False
    if features.get("height_measurement_valid") and isinstance(raw_height_ratio, (int, float)):
        height_window: List[float] = list(live.get("height_ratios") or [])
        if height_window and abs(float(raw_height_ratio) - statistics.median(height_window)) > HEIGHT_OUTLIER_JUMP:
            height_window = []
        height_window.append(float(raw_height_ratio))
        # 只看最近幾筆：留著長歷史會讓一次舊的遮罩跳動永遠壓住指示燈。
        height_window = height_window[-HEIGHT_STABLE_FRAMES:]
        live["height_ratios"] = height_window

        smoothed = float(statistics.median(height_window))
        span = max(height_window) - min(height_window)
        features["height_ratio_raw"] = round(float(raw_height_ratio), 4)
        features["height_ratio"] = round(smoothed, 4)
        if classify_height is not None:
            features["height_class"] = classify_height(smoothed)
        features["height_sample_count"] = len(height_window)
        features["height_confidence"] = round(min(1.0, len(height_window) / HEIGHT_STABLE_FRAMES), 3)
        features["height_sample_span"] = round(span, 4)
        height_ready = len(height_window) >= HEIGHT_STABLE_FRAMES and span <= HEIGHT_RATIO_SPAN_MAX
    else:
        live["height_ratios"] = []
        features["height_sample_count"] = 0
        features["height_confidence"] = 0.0
        features["height_sample_span"] = None

    features["height_measurement_ready"] = height_ready
    features["height_samples_required"] = HEIGHT_STABLE_FRAMES
    features["height_span_limit"] = HEIGHT_RATIO_SPAN_MAX

    if height_ready:
        live["trusted_height_ratio"] = features.get("height_ratio")
        live["trusted_height_class"] = features.get("height_class")
        live["trusted_height_at"] = time.time()
    else:
        for key in ("trusted_height_ratio", "trusted_height_class", "trusted_height_at"):
            live.pop(key, None)

    quality = features.get("capture_quality")
    if isinstance(quality, dict):
        checks = quality.setdefault("capture_checks", {})
        checks["height_station"] = bool(features.get("height_station_valid"))
        checks["height_measurement"] = height_ready

    features["stability_count"] = stable_count
    features["stability_required"] = STABLE_FRAMES
    features["landmark_displacement"] = round(displacement, 5) if displacement is not None else None
    features["stability_average"] = round(average, 5) if average is not None else None
    features["capture_ready"] = raw_ready and stable_count >= STABLE_FRAMES and height_ready
    if features["capture_ready"]:
        features["guidance_reason"] = "ready"
    elif raw_ready:
        features["guidance_reason"] = "hold_still"
    return features


class SessionStore:
    """以 session id 索引的預覽狀態，附 TTL 清掃。

    id 由伺服器配發而非客戶端自取：客戶端能決定 id 的話，任何人都能猜到
    別人的 id 並污染他的拍攝狀態（app.py 那邊用的是伺服器指派的 socket sid，
    這裡走 HTTP 沒有天然的 sid，因此自行配發）。
    """

    def __init__(self, ttl_sec: float = 90.0, max_sessions: int = 256) -> None:
        self._ttl = ttl_sec
        self._max = max_sessions
        self._data: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def new_id(self) -> str:
        return secrets.token_hex(16)

    def get(self, session_id: Optional[str]) -> Dict[str, Any]:
        now = time.time()
        with self._lock:
            self._sweep(now)
            live = self._data.get(session_id or "")
            if live is None:
                return new_session()
            live["touched_at"] = now
            return live

    def put(self, session_id: str, live: Dict[str, Any]) -> None:
        with self._lock:
            live["touched_at"] = time.time()
            self._data[session_id] = live
            self._sweep(live["touched_at"])

    def drop(self, session_id: Optional[str]) -> None:
        if not session_id:
            return
        with self._lock:
            self._data.pop(session_id, None)

    def _sweep(self, now: float) -> None:
        """呼叫端已持鎖。過期優先，仍超量則丟最舊的。"""
        for key in [k for k, v in self._data.items() if now - v.get("touched_at", 0) > self._ttl]:
            self._data.pop(key, None)
        if len(self._data) > self._max:
            for key, _ in sorted(self._data.items(), key=lambda kv: kv[1].get("touched_at", 0))[
                : len(self._data) - self._max
            ]:
                self._data.pop(key, None)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)
