"""生成服務的並發壓測：同時送 N 個真實的 /generate，看上游撐不撐得住。

**這支會花真錢。** 每一個請求都是一次付費生圖（平均約 $0.14，驗證失敗自動
重生時再加一次）。所以預設只印出計畫與估價，要加 ``--go`` 才會真的送出。

要回答的問題只有一個：把 ``GEN_MAX_CONCURRENT`` 調到 N 時，OpenRouter／Google
會不會開始拒絕。拒絕長得不像錯誤 —— 熔斷器連續三次失敗就跳閘 20 秒，
接下來的人全部秒回 ``circuit_open``，現場看起來是「全場一起失敗」。
所以這裡要看的不只是成功率，還有：

- 有沒有 429（上游限流）或 402（OpenRouter 的進行中花費預算用完，
  餘額越低越容易撞到 —— 見 docs/notes/FIELD-OPS.md）
- 耗時有沒有隨並發變長（上游在排隊，只是沒拒絕）

壓測產生的紀錄會標上 ``experiment_id=loadtest-<時間>``，與現場紀錄分得開。
標記是依時間範圍做的，所以**不要在活動進行中跑**，否則會把參與者的紀錄
一起標走。

前提：生成服務已啟動，且 ``.env`` 的 ``GEN_MAX_CONCURRENT`` 已設成要測的值
（服務端的信號量會把超過上限的請求擋在本機排隊，那樣測不到上游）。

Usage::

    python scripts/gen_load_test.py -n 8              # 只印計畫與估價
    python scripts/gen_load_test.py -n 8 --go         # 真的送出
    python scripts/gen_load_test.py -n 8 --go --style pixel

照片取自 backend/logs/inputs/（過去真實生成的輸入），不足 N 張時循環使用。
"""

from __future__ import annotations

import argparse
import base64
import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INPUT_DIR = ROOT / "backend" / "logs" / "inputs"
COST_PER_ATTEMPT = 0.143   # generation_attempts 的實測平均（2026-10-14，19 筆）


def _photos(n: int) -> list[Path]:
    files = sorted(INPUT_DIR.glob("*.webp"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        sys.exit(f"{INPUT_DIR} 裡沒有照片可用")
    return [files[i % len(files)] for i in range(n)]


def _health(base: str) -> dict:
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=5) as r:
            return json.load(r)
    except Exception as e:
        sys.exit(f"生成服務連不上（{base}）：{e}")


def _one(base: str, photo: Path, style: str | None, barrier: threading.Barrier, out: dict) -> None:
    data_url = "data:image/webp;base64," + base64.b64encode(photo.read_bytes()).decode()
    payload = {"image": data_url}
    if style:
        payload["styleId"] = style
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{base}/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    barrier.wait()   # 全部同時出發，才是「同時按拍照」
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            res = json.load(r)
        out["ok"] = bool(res.get("ok"))
        out["error"] = res.get("error")
        out["detail"] = res.get("validation") or res.get("guidance")
    except urllib.error.HTTPError as e:
        out["ok"], out["error"] = False, f"http_{e.code}"
    except Exception as e:
        out["ok"], out["error"] = False, f"{type(e).__name__}: {e}"
    out["sec"] = time.perf_counter() - t0


def _tag_runs(started: float, ended: float, experiment_id: str) -> int:
    sys.path.insert(0, str(ROOT / "backend"))
    from generation_history import list_runs, update_run_experiment  # type: ignore

    tagged = 0
    for run in list_runs(limit=500):
        if started - 1 <= float(run.get("created_at") or 0) <= ended:
            update_run_experiment(run["request_id"], experiment_id=experiment_id,
                                  comparison_id=None, variant_id=None)
            tagged += 1
    return tagged


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("-n", type=int, required=True, help="同時送出的請求數")
    ap.add_argument("--style", help="風格 id（lego / pixar / pixel），不給就用服務預設")
    ap.add_argument("--base", default="http://127.0.0.1:5055")
    ap.add_argument("--go", action="store_true", help="真的送出（會花錢）")
    args = ap.parse_args()

    health = _health(args.base)
    photos = _photos(args.n)
    low, high = args.n * COST_PER_ATTEMPT, args.n * COST_PER_ATTEMPT * 2
    print(f"並發 {args.n}　風格 {args.style or '(預設)'}　照片 {len(set(photos))} 張")
    print(f"預估花費 ${low:.2f}（全數一次通過）～ ${high:.2f}（全數重生一次）")
    if health.get("degraded"):
        print(f"注意：生成服務回報 degraded：{health['degraded']}")
    if not args.go:
        print("\n沒有加 --go，只印計畫。確認 .env 的 GEN_MAX_CONCURRENT ≥ N 且已重啟服務後再送。")
        return

    results = [{} for _ in photos]
    barrier = threading.Barrier(len(photos))
    threads = [threading.Thread(target=_one, args=(args.base, p, args.style, barrier, r))
               for p, r in zip(photos, results)]
    started = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ended = time.time()

    print()
    for i, (p, r) in enumerate(zip(photos, results)):
        mark = "OK  " if r.get("ok") else "FAIL"
        print(f"{i:>2} {mark} {r.get('sec', 0):6.1f}s  {p.name[:8]}  {r.get('error') or ''}")

    secs = [r["sec"] for r in results if r.get("ok")]
    errors: dict[str, int] = {}
    for r in results:
        if not r.get("ok"):
            errors[str(r.get("error"))] = errors.get(str(r.get("error")), 0) + 1
    print(f"\n成功 {len(secs)}/{len(results)}", end="")
    if secs:
        print(f"　耗時 中位 {statistics.median(secs):.1f}s　最慢 {max(secs):.1f}s"
              "（單發約 25–33s；明顯變長代表上游在排隊）", end="")
    print()
    if errors:
        print("失敗原因：", ", ".join(f"{k} ×{v}" for k, v in errors.items()))
        if any("circuit_open" in k for k in errors):
            print("→ 出現 circuit_open：上游連續失敗讓熔斷器跳閘了，這個並發數太高。"
                  "原始原因看生成服務的 log（429 / 402）。")

    experiment_id = time.strftime("loadtest-%Y%m%d-%H%M%S")
    tagged = _tag_runs(started, ended, experiment_id)
    print(f"\n已把 {tagged} 筆紀錄標為 experiment_id={experiment_id}")


if __name__ == "__main__":
    main()
