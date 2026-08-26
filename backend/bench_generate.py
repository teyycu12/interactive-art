#!/usr/bin/env python3
"""
M2/M3 生成延遲基準線工具：用一張（或一批）預存照片自動連續觸發 generate_avatar
N 次，量測「拍照完成 → avatar_generated 回傳」的端到端延遲，取得技術架構文件
第 6 節要求的「實測前先跑幾次取得基準線」。

這條基準線的用途：WP-A 把單一同步生成流程拆成「模板先上場 + AI 精修」分軌後，
要能拿出「分軌前 vs 分軌後」的延遲對比，證明體驗真的變快——沒有這條基準線，
分軌做完只是「感覺變快」，無法量化。

做法：
1. 連上後端，送出 generate_avatar（帶預存照片）
2. 等 avatar_generated 回來，記錄端到端延遲與 ok 旗標
3. 重複 N 次，最後印出 p50/p90/max 與失敗率
   （後端本身也會把每次的 cv_ms/vlm_ms 寫進事件 log，之後用 analyze_log.py 看更細）

用法：
    # 先啟動後端： .venv/bin/python backend/app.py
    .venv/bin/python backend/bench_generate.py --image path/to/photo.jpg
    .venv/bin/python backend/bench_generate.py --image photo.jpg --runs 10 --mode body_sprite
    .venv/bin/python backend/bench_generate.py --image photo.jpg --mode full_character

注意：每次都會真的呼叫 Gemini，會消耗 API 額度。runs 別設太大。
"""

# 必須在任何 print 之前 —— 見該模組的說明。
try:
    from backend import console_encoding  # noqa: F401
except ImportError:
    import console_encoding  # noqa: F401

import argparse
import base64
import mimetypes
import os
import statistics
import sys
import threading
import time

try:
    import socketio
except ImportError:
    print("需要 python-socketio：  pip install \"python-socketio[client]\"")
    sys.exit(1)


def _load_image_as_data_uri(path: str) -> str:
    if not os.path.exists(path):
        print(f"❌ 找不到照片：{path}")
        sys.exit(1)
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return s[k]


def _connect(sio, url):
    try:
        sio.connect(url, transports=["websocket"], wait_timeout=10)
    except Exception:
        sio.connect(url, wait_timeout=10)


def main():
    ap = argparse.ArgumentParser(description="PersonaFlow 生成延遲基準線")
    ap.add_argument("--url", default="http://127.0.0.1:5001")
    ap.add_argument("--image", required=True, help="預存照片路徑（jpg/png/heic）")
    ap.add_argument("--runs", type=int, default=5, help="連續觸發次數（預設 5，別設太大以免燒額度）")
    ap.add_argument("--mode", default="body_sprite",
                    choices=["body_sprite", "full_character", "full_character_refined"])
    ap.add_argument("--timeout", type=float, default=180.0, help="單次生成逾時秒數")
    args = ap.parse_args()

    data_uri = _load_image_as_data_uri(args.image)
    print(f"[bench] 後端: {args.url}")
    print(f"[bench] 照片: {args.image}（{len(data_uri)} bytes base64）")
    print(f"[bench] 模式: {args.mode}，次數: {args.runs}\n")

    sio = socketio.Client(reconnection=False)
    done = threading.Event()
    result_holder = {}

    @sio.on("avatar_generated")
    def _on_generated(data):
        result_holder["ok"] = bool(data.get("ok"))
        result_holder["error"] = data.get("error")
        done.set()

    try:
        _connect(sio, args.url)
    except Exception as e:
        print(f"❌ 無法連上後端：{e}\n   請先啟動： .venv/bin/python backend/app.py")
        sys.exit(1)

    latencies = []
    failures = 0

    for i in range(args.runs):
        done.clear()
        result_holder.clear()
        t0 = time.perf_counter()
        sio.emit("generate_avatar", {"image": data_uri, "mode": args.mode})

        if not done.wait(timeout=args.timeout):
            print(f"  run {i+1}/{args.runs}: ⏱️ 逾時（> {args.timeout}s）")
            failures += 1
            continue

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        ok = result_holder.get("ok", False)
        if ok:
            latencies.append(elapsed_ms)
            print(f"  run {i+1}/{args.runs}: ✅ {elapsed_ms/1000:.2f}s")
        else:
            failures += 1
            print(f"  run {i+1}/{args.runs}: ❌ 失敗 ({result_holder.get('error')})，{elapsed_ms/1000:.2f}s")

    sio.disconnect()

    print("\n========== 生成延遲基準線 ==========")
    print(f"  模式                : {args.mode}")
    print(f"  總次數 / 成功 / 失敗 : {args.runs} / {len(latencies)} / {failures}")
    if latencies:
        print(f"  延遲 p50            : {_pct(latencies,50)/1000:.2f} s   (第 6 節目標中位數 < 5s)")
        print(f"  延遲 p90            : {_pct(latencies,90)/1000:.2f} s")
        print(f"  延遲 max            : {max(latencies)/1000:.2f} s")
        print(f"  延遲 mean           : {statistics.mean(latencies)/1000:.2f} s")
    fail_rate = failures / args.runs * 100.0 if args.runs else 0.0
    print(f"  失敗率              : {fail_rate:.1f}%   (第 6 節目標 < 15%)")
    print("====================================")
    print("提示：後端已把每次的 cv_ms / vlm_ms 子流程延遲寫進事件 log，")
    print("      跑 `.venv/bin/python backend/analyze_log.py` 可看子流程分解。\n")


if __name__ == "__main__":
    main()
