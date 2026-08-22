import json
import os
import shutil
import tempfile
import unittest
from backend.event_logger import log_event, Timer, _sanitize, set_log_dir


class TestEventLogger(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        set_log_dir(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_sanitize_removes_large_payloads(self):
        raw = {
            "image": "data:image/jpeg;base64,1234567890",
            "body_png": "base64...",
            "cloth_grid": {"cells": [1, 2, 3]},
            "pid": "test_sid",
            "ok": True,
        }
        sanitized = _sanitize(raw)
        self.assertNotIn("image", sanitized)
        self.assertNotIn("body_png", sanitized)
        self.assertNotIn("cloth_grid", sanitized)
        self.assertEqual(sanitized["pid"], "test_sid")
        self.assertEqual(sanitized["ok"], True)

    def test_log_event_writes_valid_jsonl(self):
        log_event("test_event", pid="client_123", latency_ms=45.2, extra_info="ok")
        
        files = os.listdir(self.test_dir)
        self.assertEqual(len(files), 1)
        
        filepath = os.path.join(self.test_dir, files[0])
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        self.assertEqual(record["event"], "test_event")
        self.assertEqual(record["pid"], "client_123")
        self.assertEqual(record["latency_ms"], 45.2)
        self.assertIn("ts", record)

    def test_timer_context_manager(self):
        with Timer("timer_test", pid="timer_client") as t:
            pass
        
        files = os.listdir(self.test_dir)
        self.assertEqual(len(files), 1)
        filepath = os.path.join(self.test_dir, files[0])
        with open(filepath, "r", encoding="utf-8") as f:
            record = json.loads(f.readline())
        
        self.assertEqual(record["event"], "timer_test")
        self.assertIn("latency_ms", record)
        self.assertGreaterEqual(record["latency_ms"], 0.0)


if __name__ == "__main__":
    unittest.main()
