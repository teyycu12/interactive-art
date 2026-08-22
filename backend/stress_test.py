#!/usr/bin/env python3
"""
M3 承載量壓測：模擬 N（預設 30）個角色同時在場，量測後端 Boids tick 廣播
在滿載下的實際頻率與延遲，驗證技術架構文件第 6 節「併發承載量 ≥ 30」指標。

做法：
1. 每個模擬角色開一條 socket.io 連線，emit join_swarm 加入群聚場
2. 全部加入後，訂閱 update_positions 廣播一段時間，統計：
   - 實際廣播頻率（目標 ≈ 10 Hz，即 tick 0.1s）
   - 每次廣播的角色數（應等於 N + 既有的 system_bot）
   - 廣播間隔的抖動（p50 / p95），反映滿載時 tick 是否被拖慢
3. 結束時 emit leave_swarm 清場，確保不留殘影

用法：
    # 先在另一個終端機啟動後端： .venv/bin/python backend/app.py
    .venv/bin/python backend/stress_test.py                # 30 角色、觀測 10 秒
    .venv/bin/python backend/stress_test.py --chars 50 --duration 15
    .venv/bin/python backend/stress_test.py --url http://127.0.0.1:5001

注意：此腳本只壓「通訊 / 狀態廣播」層（M3/M4 tick），不觸發 generate_avatar
（那條鏈依賴 Gemini，屬 M2 量測，另用真實拍照或獨立腳本測）。
"""

import argparse
import random
import statistics
import sys
import threading
import time

try:
    import socketio  # python-socketio client
except ImportError:
    print("需要 python-socketio：  pip install \"python-socketio[client]\"")
    sys.exit(1)


def _connect(sio, url: str):
    """優先用 websocket transport（符合 CLAUDE.md 強制 websocket 慣例），
    若 websocket-client 未裝則自動退回預設 polling，避免壓測整個跑不起來。"""
    try:
        sio.connect(url, transports=["websocket"], wait_timeout=10)
    except Exception:
        sio.connect(url, wait_timeout=10)


def _rand_hex() -> str:
    return "#{:02X}{:02X}{:02X}".format(
        random.randint(30, 230), random.randint(30, 230), random.randint(30, 230)
    )


def _make_char_payload(idx: int) -> dict:
    """產生一個看起來像真實角色的 join_swarm payload（不含影像）。"""
    return {
        "id": f"stress_{idx:03d}",
        "x": random.uniform(100, 1820),
        "y": random.uniform(100, 980),
        "upper": {"hex": _rand_hex()},
        "lower": {"hex": _rand_hex()},
        "upper_type": random.choice(["short_sleeve", "long_sleeve"]),
        "lower_type": random.choice(["shorts", "long_pants"]),
        "accessory": random.choice(["none", "glasses", "hat"]),
        "character_mode": "body_sprite",
    }


class StressClient:
    """單一模擬角色連線。"""

    def __init__(self, url: str, idx: int):
        self.idx = idx
        self.url = url
        self.sio = socketio.Client(reconnection=False)
        self.joined = threading.Event()
        self.char_payload = _make_char_payload(idx)
        self.char_id = self.char_payload["id"]

        @self.sio.on("swarm_joined")
        def _on_joined(data):
            if data.get("id") == self.char_id:
                self.joined.set()

    def connect_and_join(self):
        _connect(self.sio, self.url)
        self.sio.emit("join_swarm", self.char_payload)

    def leave_and_disconnect(self):
        try:
            self.sio.emit("leave_swarm", {"id": self.char_id})
            time.sleep(0.05)
        except Exception:
            pass
        try:
            self.sio.disconnect()
        except Exception:
            pass


class BroadcastObserver:
    """獨立一條連線，只負責觀測 update_positions 廣播並統計頻率 / 抖動。"""

    def __init__(self):
        self.sio = socketio.Client(reconnection=False)
        self.recv_times: list = []
        self.char_counts: list = []
        self._lock = threading.Lock()

        @self.sio.on("update_positions")
        def _on_positions(data):
            now = time.perf_counter()
            chars = data.get("characters", [])
            with self._lock:
                self.recv_times.append(now)
                self.char_counts.append(len(chars))

    def connect(self, url: str, room: str = "default"):
        _connect(self.sio, url)
        # 必須 emit get_swarm：背景迴圈的 update_positions 是 room-scoped 的
        # （app.py 的 _swarm_background），純觀測連線若不加入 room，就只會收到
        # handle_connect 當下那一次廣播，之後完全收不到 —— 壓測會因此永遠回報
        # 「廣播樣本不足」而測不出任何數據。get_swarm 會把此連線加入該 room。
        self.sio.emit("get_swarm", {"room": room})

    def stop(self):
        try:
            self.sio.disconnect()
        except Exception:
            pass

    def report(self, expected_chars: int) -> dict:
        with self._lock:
            times = list(self.recv_times)
            counts = list(self.char_counts)

        if len(times) < 2:
            return {"error": "廣播樣本不足（收到 < 2 次 update_positions）", "samples": len(times)}

        intervals_ms = [(times[i] - times[i - 1]) * 1000.0 for i in range(1, len(times))]
        intervals_ms.sort()
        span_s = times[-1] - times[0]
        hz = (len(times) - 1) / span_s if span_s > 0 else 0.0

        def _pct(sorted_vals, p):
            if not sorted_vals:
                return 0.0
            k = min(len(sorted_vals) - 1, int(round((p / 100.0) * (len(sorted_vals) - 1))))
            return sorted_vals[k]

        return {
            "samples": len(times),
            "broadcast_hz": round(hz, 2),
            "interval_p50_ms": round(statistics.median(intervals_ms), 1),
            "interval_p95_ms": round(_pct(intervals_ms, 95), 1),
            "interval_max_ms": round(intervals_ms[-1], 1),
            "chars_min": min(counts),
            "chars_max": max(counts),
            "chars_expected_at_least": expected_chars,
        }


def main():
    ap = argparse.ArgumentParser(description="PersonaFlow M3 承載量壓測")
    ap.add_argument("--url", default="http://127.0.0.1:5001", help="後端位址")
    ap.add_argument("--chars", type=int, default=30, help="同時在場角色數（預設 30）")
    ap.add_argument("--duration", type=float, default=10.0, help="觀測秒數（預設 10）")
    args = ap.parse_args()

    print(f"[stress] 目標後端: {args.url}")
    print(f"[stress] 模擬角色數: {args.chars}，觀測時間: {args.duration}s")

    # 1. 觀測者先連上
    observer = BroadcastObserver()
    try:
        observer.connect(args.url)
    except Exception as e:
        print(f"[stress] ❌ 無法連上後端（觀測者）：{e}")
        print("[stress]    請先啟動後端： .venv/bin/python backend/app.py")
        sys.exit(1)

    # 2. 陸續拉起 N 個角色連線並加入
    clients = []
    t_join_start = time.perf_counter()
    for i in range(args.chars):
        c = StressClient(args.url, i)
        try:
            c.connect_and_join()
            clients.append(c)
        except Exception as e:
            print(f"[stress] ⚠️ 角色 {i} 連線失敗：{e}")
        time.sleep(0.02)  # 稍微錯開，模擬真實陸續入場，也避免瞬間握手風暴

    # 等待全部收到 swarm_joined 確認
    joined_ok = 0
    for c in clients:
        if c.joined.wait(timeout=5):
            joined_ok += 1
    t_join_ms = (time.perf_counter() - t_join_start) * 1000.0
    print(f"[stress] ✅ {joined_ok}/{args.chars} 角色成功加入（耗時 {t_join_ms:.0f} ms）")

    # 3. 清掉入場期間的暖機廣播樣本，只統計「滿載穩定期」
    time.sleep(0.5)
    with observer._lock:
        observer.recv_times.clear()
        observer.char_counts.clear()

    print(f"[stress] 觀測滿載廣播 {args.duration}s ...")
    time.sleep(args.duration)

    # 4. 出報告
    rep = observer.report(expected_chars=joined_ok)
    print("\n========== M3 承載量壓測報告 ==========")
    print(f"  在場角色（實際加入）      : {joined_ok}")
    if "error" in rep:
        print(f"  ⚠️ {rep['error']}")
    else:
        print(f"  廣播頻率 broadcast_hz      : {rep['broadcast_hz']} Hz   (目標 ≈ 10 Hz)")
        print(f"  廣播間隔 p50 / p95 / max   : {rep['interval_p50_ms']} / {rep['interval_p95_ms']} / {rep['interval_max_ms']} ms")
        print(f"  每次廣播角色數 min / max   : {rep['chars_min']} / {rep['chars_max']}   (含 system_bot)")
        print(f"  廣播樣本數                 : {rep['samples']}")
        verdict = "✅ 通過" if rep["broadcast_hz"] >= 8.0 and joined_ok >= args.chars else "⚠️ 需檢視"
        print(f"  承載量 ≥ {args.chars} 判定       : {verdict}")
    print("=======================================\n")

    # 5. 清場
    print("[stress] 清場中（leave_swarm + disconnect）...")
    for c in clients:
        c.leave_and_disconnect()
    observer.stop()
    print("[stress] 完成。")


if __name__ == "__main__":
    main()
