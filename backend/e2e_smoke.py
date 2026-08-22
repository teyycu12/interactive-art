#!/usr/bin/env python3
"""
端到端煙霧測試：對「真的跑起來的後端」走完整 socket 流程。

與 tests/ 的差別：單元測試用 Flask 的 test_client，不會真的開 server、
不會跑背景執行緒、也不會載入 MediaPipe。有一整類問題只有在真實行程裡才會
出現 —— 例如 mediapipe 1.0.1 在 macOS 上以 absl CHECK 直接 abort() 整個
行程（C++ 層的 abort，Python 的 try/except 完全攔不到），單元測試永遠測不到，
但展場當天第一個人拍照就會讓整個後端連同投影牆一起死掉。

用法：
    # 先另開一個終端機啟動後端
    venv/bin/python backend/app.py

    # 再跑這支
    venv/bin/python backend/e2e_smoke.py

沒有設 GEMINI_API_KEY / OPENAI_API_KEY 時，generate_avatar 會走熔斷降級路徑
—— 那正是場館斷網時的行為，本測試會驗證降級後仍可渲染（garment_source=grid）。
"""
import argparse
import base64
import io
import sys
import time

try:
    import socketio
except ImportError:
    print("需要 python-socketio：pip install -r requirements.txt")
    sys.exit(2)

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def main(url: str, room: str) -> int:
    sio = socketio.Client(reconnection=False)
    got = {"positions": [], "joined": None, "avatar": None,
           "photo": None, "progress": []}

    sio.on("update_positions", lambda d: got["positions"].append(time.time()))
    sio.on("swarm_joined", lambda d: got.update(joined=d))
    sio.on("avatar_generated", lambda d: got.update(avatar=d))
    sio.on("avatar_progress", lambda d: got["progress"].append(d))
    sio.on("photo_ready", lambda d: got.update(photo=d))

    print("\n=== 1. 連線 ===")
    sio.connect(url, transports=["websocket"])
    check("websocket 連線", sio.connected)

    print("\n=== 2. join_swarm ===")
    sio.emit("join_swarm", {"id": "e2e_user", "x": 500, "y": 400,
                            "upper": {"hex": "#E63946"},
                            "lower": {"hex": "#1D3557"}, "room": room})
    time.sleep(1.0)
    check("收到 swarm_joined", got["joined"] is not None,
          f"room={got['joined'].get('room') if got['joined'] else '—'}")

    print("\n=== 3. 背景迴圈廣播（驗證觀看端有被加入 room）===")
    got["positions"].clear()
    sio.emit("get_swarm", {"room": room})
    time.sleep(3.0)
    rate = len(got["positions"]) / 3.0
    check("持續收到 update_positions", len(got["positions"]) >= 15,
          f"3 秒 {len(got['positions'])} 次 (~{rate:.1f}Hz)")
    check("頻率接近 10Hz", 7 <= rate <= 13, f"{rate:.1f}Hz")

    print("\n=== 4. inject_bots 上限與無效值保護 ===")
    sio.emit("inject_bots", {"count": 5, "room": room})
    time.sleep(0.8)
    sio.emit("inject_bots", {"count": -3, "room": room})
    sio.emit("inject_bots", {"count": 999999, "room": room})
    time.sleep(1.5)
    check("極端 count 未使伺服器崩潰", sio.connected)

    print("\n=== 5. generate_avatar（無金鑰時走熔斷降級，等同場館斷網）===")
    try:
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (640, 480), (120, 90, 70)).save(buf, format="JPEG")
        img = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        img = None
        print("  (skip：Pillow 不可用)")

    if img:
        t0 = time.time()
        sio.emit("generate_avatar", {"image": img, "mode": "body_sprite"})
        for _ in range(80):
            if got["avatar"] is not None:
                break
            time.sleep(0.5)
        a = got["avatar"]
        check("generate_avatar 有回應（未卡死、行程未死）",
              a is not None, f"{time.time() - t0:.1f}s")
        if a:
            # 契約：ok = 前端能否渲染；garment_source = 走了哪條路；
            # 誠實的 AI 成敗記在 event log，與這裡的 ok 不同義。
            check("降級後仍可渲染", a.get("ok") is True, f"ok={a.get('ok')}")
            check("garment_source 標為 grid",
                  a.get("garment_source") == "grid", f"{a.get('garment_source')}")
            check("有 avatar_progress", len(got["progress"]) > 0,
                  f"{len(got['progress'])} 則")

    print("\n=== 6. trigger_photo → photo_ready ===")
    sio.emit("trigger_photo", {"room": room})
    for _ in range(60):
        if got["photo"] is not None:
            break
        time.sleep(0.5)
    p = got["photo"]
    check("收到 photo_ready", p is not None)
    if p:
        check("合照生成成功", p.get("ok") is True, f"id={p.get('photo_id')}")
        check("有 QR code", bool(p.get("qr_b64")))
        print(f"       {p.get('photo_url')}  角色數={p.get('character_count')}")

    sio.disconnect()

    passed = sum(1 for _, ok, _ in results if ok)
    print("\n" + "=" * 60)
    print(f"結果：{passed}/{len(results)} 通過")
    for name, ok, d in results:
        if not ok:
            print(f"  FAILED: {name} — {d}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5001")
    ap.add_argument("--room", default="default")
    a = ap.parse_args()
    try:
        sys.exit(main(a.url, a.room))
    except Exception as e:
        print(f"\n[e2e] 無法完成：{type(e).__name__}: {e}")
        print("後端有啟動嗎？ venv/bin/python backend/app.py")
        sys.exit(2)
