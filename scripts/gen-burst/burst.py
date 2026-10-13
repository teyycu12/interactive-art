#!/usr/bin/env python3
"""Fire N simultaneous /generate requests at the generation service and report each result."""
import base64, io, json, sys, threading, time, urllib.request
port, n = int(sys.argv[1]), int(sys.argv[2])
photo_path = sys.argv[3]
stagger = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
img = "data:image/png;base64," + base64.b64encode(open(photo_path, "rb").read()).decode()
res = [None] * n
def go(i):
    time.sleep(i * stagger)
    t = time.time()
    body = json.dumps({"image": img}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/generate", body, {"Content-Type": "application/json"})
    try:
        out = json.loads(urllib.request.urlopen(req, timeout=300).read())
        res[i] = (round(time.time() - t, 1), out.get("ok"), out.get("error"))
    except Exception as e:
        res[i] = (round(time.time() - t, 1), False, repr(e)[:80])
ths = [threading.Thread(target=go, args=(i,)) for i in range(n)]
[t.start() for t in ths]; [t.join() for t in ths]
for i, r in enumerate(res): print(f"  user{i+1}: {r[0]:>6}s  ok={r[1]}  error={r[2]}")
print(f"  => {sum(1 for r in res if r[1])}/{n} succeeded")
