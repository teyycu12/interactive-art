#!/usr/bin/env python3
"""Fake OpenRouter chat-completions endpoint that returns an image after a delay.

--latency      seconds per call
--max-inflight provider-side concurrency cap; extra calls get HTTP 429 at once (0 = no cap)
--fail-every   every Nth call returns HTTP 502 (0 = never)
"""
import argparse, base64, json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=5099)
ap.add_argument("--latency", type=float, default=13.0)
ap.add_argument("--max-inflight", type=int, default=0)
ap.add_argument("--fail-every", type=int, default=0)
ap.add_argument("--png", required=True)
a = ap.parse_args()
IMG = "data:image/png;base64," + base64.b64encode(open(a.png, "rb").read()).decode()
lock = threading.Lock(); inflight = [0]; count = [0]; peak = [0]

class H(BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with lock:
            count[0] += 1; n = count[0]
            if a.max_inflight and inflight[0] >= a.max_inflight:
                print(f"[fake] #{n} 429 (inflight={inflight[0]})", flush=True)
                return self._send(429, {"error": {"message": "Rate limit exceeded", "code": 429}})
            inflight[0] += 1; peak[0] = max(peak[0], inflight[0])
        try:
            time.sleep(a.latency)
            if a.fail_every and n % a.fail_every == 0:
                print(f"[fake] #{n} 502", flush=True)
                return self._send(502, {"error": {"message": "Provider returned error", "code": 502}})
            print(f"[fake] #{n} ok (peak inflight={peak[0]})", flush=True)
            self._send(200, {"id": f"gen-fake-{n}", "object": "chat.completion", "created": int(time.time()),
                "model": "fake/image", "choices": [{"index": 0, "finish_reason": "stop", "message": {
                "role": "assistant", "content": "", "images": [{"type": "image_url", "image_url": {"url": IMG}}]}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}})
        finally:
            with lock: inflight[0] -= 1

ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
