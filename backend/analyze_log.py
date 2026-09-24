#!/usr/bin/env python3
"""
從 event_logger 落地的 JSON lines log 算出技術架構文件第 6 節效能指標。

不依賴 pandas（避免多裝一個套件就跑不出來），純標準庫即可。
輸出：生成延遲分佈（p50/p90/max）、CV / VLM 子流程延遲、Gemini 失敗率、
在場承載量觀測、相遇次數，作為期末報告「一組誠實的技術數據」的來源。

用法：
    .venv/bin/python backend/analyze_log.py                     # 分析今天的 log
    .venv/bin/python backend/analyze_log.py backend/logs/events-20260714.jsonl
    .venv/bin/python backend/analyze_log.py --glob             # 合併分析 logs/ 下所有檔
"""

# 必須在任何 print 之前 —— 見該模組的說明。
try:
    from backend import console_encoding  # noqa: F401
except ImportError:
    import console_encoding  # noqa: F401

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone, timedelta

_TZ = timezone(timedelta(hours=8))
_LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")


def _load(paths):
    events = []
    for p in paths:
        if not os.path.exists(p):
            print(f"⚠️ 找不到 log 檔：{p}")
            continue
        with open(p, encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    print(f"⚠️ {p}:{line_no} 非合法 JSON，跳過")
    return events


def _pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return s[k]


def _fmt(v, unit="ms"):
    return f"{v:.0f} {unit}" if v is not None else "—（無資料）"


def analyze(events):
    gen = [e for e in events if e.get("event") == "avatar_generated"]
    gen_ok = [e for e in gen if e.get("ok")]
    gen_fail = [e for e in gen if not e.get("ok")]

    total_ms   = [e["latency_ms"] for e in gen if "latency_ms" in e]
    cv_ms      = [e["cv_ms"]  for e in gen if "cv_ms"  in e]
    vlm_ms     = [e["vlm_ms"] for e in gen if "vlm_ms" in e]

    # VLM 失敗率：以 avatar_generated 整體 ok，以及子旗標 vlm_*_ok 兩種角度看
    vlm_flag_fail = sum(
        1 for e in gen
        if e.get("vlm_outfit_ok") is False or e.get("vlm_face_ok") is False
    )

    summaries = [e for e in events if e.get("event") == "swarm_summary"]
    peak_swarm = max((e.get("swarm_size", 0) for e in summaries), default=0)
    joins = [e for e in events if e.get("event") == "join_swarm"]
    peak_join = max((e.get("swarm_size", 0) for e in joins), default=0)
    encounters = [e for e in events if e.get("event") == "character_encounter"]

    print("\n================ PersonaFlow M3 效能量測報告 ================")
    print(f"  事件總數                    : {len(events)}")
    if events:
        print(f"  時間範圍                    : {events[0].get('ts','?')}  →  {events[-1].get('ts','?')}")

    print("\n  ── 生成延遲（第 6 節：目標中位數 < 5s）──")
    print(f"    樣本數                    : {len(total_ms)}")
    print(f"    p50 / p90 / max           : {_fmt(_pct(total_ms,50))} / {_fmt(_pct(total_ms,90))} / {_fmt(max(total_ms) if total_ms else None)}")

    print("\n  ── CV 子流程延遲（目標 < 1s）──")
    print(f"    p50 / p90                 : {_fmt(_pct(cv_ms,50))} / {_fmt(_pct(cv_ms,90))}")

    print("\n  ── VLM 子流程延遲（兩支 Gemini 並行，目標中位數 < 5s）──")
    print(f"    p50 / p90                 : {_fmt(_pct(vlm_ms,50))} / {_fmt(_pct(vlm_ms,90))}")

    print("\n  ── 生成失敗率（目標 < 15%）──")
    n_gen = len(gen)
    if n_gen:
        fail_rate = len(gen_fail) / n_gen * 100.0
        vlm_fail_rate = vlm_flag_fail / n_gen * 100.0
        print(f"    avatar_generated 失敗     : {len(gen_fail)}/{n_gen}  = {fail_rate:.1f}%")
        print(f"    含 VLM 子步驟失敗旗標     : {vlm_flag_fail}/{n_gen}  = {vlm_fail_rate:.1f}%")
    else:
        print("    —（尚無 avatar_generated 事件，先實際拍照或跑生成幾次）")

    print("\n  ── 承載量觀測（目標 ≥ 30 同時在場）──")
    print(f"    join_swarm 記錄到的最高在場人數 : {peak_join}")
    print(f"    swarm_summary 觀測到的最高在場   : {peak_swarm}")
    print(f"    相遇事件 character_encounter 次數 : {len(encounters)}")
    print("============================================================\n")


def main():
    ap = argparse.ArgumentParser(description="PersonaFlow 事件 log 分析")
    ap.add_argument("paths", nargs="*", help="log 檔路徑（省略則用今日檔）")
    ap.add_argument("--glob", action="store_true", help="合併分析 logs/ 下所有 events-*.jsonl")
    args = ap.parse_args()

    if args.glob:
        paths = sorted(glob.glob(os.path.join(_LOG_DIR, "events-*.jsonl")))
        if not paths:
            print(f"⚠️ {_LOG_DIR} 下沒有 events-*.jsonl，請先跑後端產生 log。")
            sys.exit(1)
    elif args.paths:
        paths = args.paths
    else:
        today = datetime.now(_TZ).strftime("%Y%m%d")
        paths = [os.path.join(_LOG_DIR, f"events-{today}.jsonl")]

    events = _load(paths)
    if not events:
        print("⚠️ 沒有讀到任何事件。先啟動服務並產生互動（或跑 npm run bots）。")
        sys.exit(1)
    analyze(events)


if __name__ == "__main__":
    main()
