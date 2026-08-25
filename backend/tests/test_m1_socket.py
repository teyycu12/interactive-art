import base64
import io
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image

import backend.app as app_module


def _frame_data_url():
    image = Image.new("RGB", (32, 32), "gray")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _features():
    return {
        "ok": True,
        "landmarks": [{"x": 0.5, "y": 0.5, "v": 1.0} for _ in range(33)],
        "capture_ready_raw": True,
        "capture_quality": {"score": 1.0, "capture_checks": {}},
        "height_ratio": 1.0,
        "height_class": "medium",
        "height_station_valid": True,
        "height_measurement_valid": True,
        "guidance_reason": "hold_still",
    }


def _wait_clothing(client, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for packet in client.get_received():
            if packet["name"] == "clothing_features":
                args = packet.get("args") or []
                return args[0] if isinstance(args, list) else args
        time.sleep(0.01)
    return None


class M1SocketTests(unittest.TestCase):
    def test_stability_state_is_isolated_per_socket(self):
        first = app_module.socketio.test_client(app_module.app)
        second = app_module.socketio.test_client(app_module.app)
        try:
            with patch.object(app_module, "get_clothing_features", return_value=_features()):
                last = None
                for frame_id in range(1, 6):
                    first.emit("process_frame", {"image": _frame_data_url(), "frame_id": frame_id})
                    last = _wait_clothing(first)
                second.emit("process_frame", {"image": _frame_data_url(), "frame_id": 1})
                other = _wait_clothing(second)
            self.assertTrue(last["capture_ready"])
            self.assertEqual(last["stability_count"], app_module._CAPTURE_STABLE_FRAMES)
            self.assertTrue(last["height_measurement_ready"])
            self.assertEqual(last["height_sample_count"], app_module._HEIGHT_STABLE_FRAMES)
            self.assertEqual(last["height_samples_required"], app_module._HEIGHT_STABLE_FRAMES)
            self.assertFalse(other["capture_ready"])
            self.assertEqual(other["stability_count"], 1)
        finally:
            first.disconnect()
            second.disconnect()

    def test_only_latest_waiting_frame_is_kept(self):
        client = app_module.socketio.test_client(app_module.app)
        started = threading.Event()
        release = threading.Event()
        calls = 0

        def slow_features(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                release.wait(2.0)
            return _features()

        try:
            with patch.object(app_module, "get_clothing_features", side_effect=slow_features):
                client.emit("process_frame", {"image": _frame_data_url(), "frame_id": 1})
                self.assertTrue(started.wait(1.0))
                client.emit("process_frame", {"image": _frame_data_url(), "frame_id": 2})
                client.emit("process_frame", {"image": _frame_data_url(), "frame_id": 3})
                release.set()
                seen = []
                deadline = time.time() + 3.0
                while time.time() < deadline and len(seen) < 2:
                    for packet in client.get_received():
                        if packet["name"] != "clothing_features":
                            continue
                        args = packet.get("args") or []
                        event = args[0] if isinstance(args, list) else args
                        seen.append(event["frame_id"])
                    time.sleep(0.01)
            self.assertEqual(seen, [1, 3])
            self.assertEqual(calls, 2)
        finally:
            release.set()
            client.disconnect()


if __name__ == "__main__":
    unittest.main()
