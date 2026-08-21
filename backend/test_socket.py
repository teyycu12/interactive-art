#!/usr/bin/env python3
"""Quick smoke test: connect to backend, check if update_positions is being emitted."""
import time
import sys

try:
    import socketio
except ImportError:
    socketio = None


def run_smoke_test(url='http://127.0.0.1:5001'):
    if socketio is None:
        print("[TEST] python-socketio not installed. Run: pip install python-socketio[client]")
        return False

    sio = socketio.Client()
    received = []

    @sio.on('connect')
    def on_connect():
        print("[TEST] ✅ Connected to backend!")

    @sio.on('server_message')
    def on_server_msg(data):
        print(f"[TEST] server_message: {data}")

    @sio.on('update_positions')
    def on_positions(data):
        chars = data.get('characters', [])
        print(f"[TEST] ✅ Received update_positions with {len(chars)} characters!")
        for c in chars:
            print(f"       - id={c.get('id')}, x={c.get('x'):.1f}, y={c.get('y'):.1f}, outfit={c.get('outfit')}")
        received.append(data)

    @sio.on('connect_error')
    def on_error(data):
        print(f"[TEST] ❌ Connection error: {data}")

    try:
        print(f"[TEST] Connecting to {url} ...")
        sio.connect(url)
        print("[TEST] Waiting 3 seconds for update_positions events...")
        time.sleep(3)

        if received:
            print(f"\n[TEST] ✅ SUCCESS! Received {len(received)} position updates.")
            success = True
        else:
            print(f"\n[TEST] ❌ FAIL: No update_positions received in 3 seconds.")
            print("[TEST] The background task might not be emitting properly.")
            success = False

        sio.disconnect()
        return success
    except Exception as e:
        print(f"[TEST] ❌ Error: {e}")
        return False


if __name__ == "__main__":
    ok = run_smoke_test()
    sys.exit(0 if ok else 1)
