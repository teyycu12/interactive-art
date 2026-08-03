#!/usr/bin/env python3
"""
把事件 log 產生成一份自包含的 HTML 效能量測報告，供期末簡報（技術架構文件
第 6 節「期末簡報的技術骨幹」）使用。純標準庫、無外部相依，圖表用內嵌 Canvas
JS 繪製，產出單一 .html 檔可直接開或投影。

誠實原則：某指標若 log 裡沒有資料（例如壓測不觸發 generate_avatar，就沒有
生成延遲），報告會明確標示「待實測」而非留白或假裝有數字。

用法：
    .venv/bin/python backend/report_html.py                        # 今天的 log → report.html
    .venv/bin/python backend/report_html.py --glob -o docs/m3/perf_report.html
    .venv/bin/python backend/report_html.py backend/logs/events-20260714.jsonl
"""

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
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    return events


def _pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return s[k]


def _compute(events):
    gen = [e for e in events if e.get("event") == "avatar_generated"]
    gen_fail = [e for e in gen if not e.get("ok")]
    total_ms = [e["latency_ms"] for e in gen if "latency_ms" in e]
    cv_ms = [e["cv_ms"] for e in gen if "cv_ms" in e]
    vlm_ms = [e["vlm_ms"] for e in gen if "vlm_ms" in e]

    summaries = [e for e in events if e.get("event") == "swarm_summary"]
    joins = [e for e in events if e.get("event") == "join_swarm"]
    peak_swarm = max([e.get("swarm_size", 0) for e in summaries]
                     + [e.get("swarm_size", 0) for e in joins], default=0)
    encounters = [e for e in events if e.get("event") == "character_encounter"]

    # 事件種類計數
    counts = {}
    for e in events:
        counts[e["event"]] = counts.get(e["event"], 0) + 1

    # swarm_summary 時序（承載量 vs 時間），取相對秒數
    series = []
    if summaries:
        t0 = summaries[0].get("ts")
        for s in summaries:
            series.append({
                "size": s.get("swarm_size", 0),
                "greeting": s.get("greeting_count", 0),
                "ts": s.get("ts"),
            })

    fail_rate = (len(gen_fail) / len(gen) * 100.0) if gen else None

    return {
        "n_events": len(events),
        "ts_start": events[0].get("ts") if events else None,
        "ts_end": events[-1].get("ts") if events else None,
        "gen_n": len(gen),
        "gen_p50": _pct(total_ms, 50), "gen_p90": _pct(total_ms, 90),
        "gen_max": max(total_ms) if total_ms else None,
        "cv_p50": _pct(cv_ms, 50), "cv_p90": _pct(cv_ms, 90),
        "vlm_p50": _pct(vlm_ms, 50), "vlm_p90": _pct(vlm_ms, 90),
        "fail_rate": fail_rate,
        "peak_swarm": peak_swarm,
        "encounters": len(encounters),
        "counts": counts,
        "series": series,
    }


def _fmt_ms(v):
    if v is None:
        return None
    return f"{v/1000:.2f}s" if v >= 1000 else f"{v:.0f}ms"


def _metric_card(label, target, actual, verdict, detail=""):
    """verdict: 'pass' | 'warn' | 'miss' | 'nodata'"""
    if actual is None:
        actual = "待實測"
        verdict = "nodata"
    vlabel = {"pass": "達標", "warn": "需檢視", "miss": "未達", "nodata": "待實測"}[verdict]
    return {
        "label": label, "target": target, "actual": actual,
        "verdict": verdict, "vlabel": vlabel, "detail": detail,
    }


def _build_html(m):
    range_txt = "—"
    if m["ts_start"]:
        range_txt = f'{m["ts_start"]}　→　{m["ts_end"]}'

    cards = [
        _metric_card("生成延遲 p50", "&lt; 5s", _fmt_ms(m["gen_p50"]),
                     "pass" if (m["gen_p50"] and m["gen_p50"] < 5000) else "warn",
                     f'p90 {_fmt_ms(m["gen_p90"]) or "—"}　max {_fmt_ms(m["gen_max"]) or "—"}'),
        _metric_card("CV 子流程 p50", "&lt; 1s", _fmt_ms(m["cv_p50"]),
                     "pass" if (m["cv_p50"] and m["cv_p50"] < 1000) else "warn",
                     f'p90 {_fmt_ms(m["cv_p90"]) or "—"}'),
        _metric_card("VLM 子流程 p50", "&lt; 5s", _fmt_ms(m["vlm_p50"]),
                     "pass" if (m["vlm_p50"] and m["vlm_p50"] < 5000) else "warn",
                     f'p90 {_fmt_ms(m["vlm_p90"]) or "—"}　兩支 Gemini 並行'),
        _metric_card("生成失敗率", "&lt; 15%",
                     (f'{m["fail_rate"]:.1f}%' if m["fail_rate"] is not None else None),
                     "pass" if (m["fail_rate"] is not None and m["fail_rate"] < 15) else "warn",
                     f'樣本 {m["gen_n"]} 次'),
        _metric_card("併發承載量", "≥ 30",
                     (str(m["peak_swarm"]) if m["peak_swarm"] else None),
                     "pass" if m["peak_swarm"] >= 30 else ("warn" if m["peak_swarm"] else "nodata"),
                     "同時在場峰值（含 system_bot）"),
        _metric_card("相遇事件", "—",
                     (str(m["encounters"]) if m["encounters"] else None),
                     "pass" if m["encounters"] else "nodata",
                     "character_encounter 累計"),
    ]

    card_html = ""
    for c in cards:
        card_html += f'''
      <article class="card v-{c['verdict']}">
        <div class="card-top">
          <span class="card-label">{c['label']}</span>
          <span class="chip chip-{c['verdict']}">{c['vlabel']}</span>
        </div>
        <div class="card-value">{c['actual']}</div>
        <div class="card-meta"><span class="tgt">目標 {c['target']}</span><span class="det">{c['detail']}</span></div>
      </article>'''

    # 事件計數表（依數量排序）
    rows = ""
    for k, v in sorted(m["counts"].items(), key=lambda kv: -kv[1]):
        rows += f'<tr><td class="ev">{k}</td><td class="num">{v:,}</td></tr>'

    series_json = json.dumps(m["series"], ensure_ascii=False)

    return _TEMPLATE.format(
        range_txt=range_txt,
        n_events=f'{m["n_events"]:,}',
        cards=card_html,
        rows=rows,
        peak_swarm=m["peak_swarm"],
        encounters=f'{m["encounters"]:,}',
        series_json=series_json,
    )


_TEMPLATE = r"""<title>PersonaFlow · M3 效能量測報告</title>
<style>
  :root {{
    --paper: #f4f6f7; --panel: #ffffff; --ink: #0e1520; --ink-soft: #4a5765;
    --line: #dde3e8; --signal: #158f82; --signal-soft: #7fc3bb;
    --pass: #1f9d6b; --warn: #c98a1e; --miss: #8a94a0; --nodata: #9aa4b0;
    --grid: #eef2f4;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --paper: #0c1218; --panel: #131b23; --ink: #e8edf1; --ink-soft: #93a2b0;
      --line: #223039; --signal: #34c0b0; --signal-soft: #1c5851;
      --pass: #3ed08c; --warn: #e0a63e; --miss: #6c7783; --nodata: #5a6570;
      --grid: #1a242c;
    }}
  }}
  :root[data-theme="light"] {{
    --paper: #f4f6f7; --panel: #ffffff; --ink: #0e1520; --ink-soft: #4a5765;
    --line: #dde3e8; --signal: #158f82; --signal-soft: #7fc3bb;
    --pass: #1f9d6b; --warn: #c98a1e; --miss: #8a94a0; --nodata: #9aa4b0; --grid: #eef2f4;
  }}
  :root[data-theme="dark"] {{
    --paper: #0c1218; --panel: #131b23; --ink: #e8edf1; --ink-soft: #93a2b0;
    --line: #223039; --signal: #34c0b0; --signal-soft: #1c5851;
    --pass: #3ed08c; --warn: #e0a63e; --miss: #6c7783; --nodata: #5a6570; --grid: #1a242c;
  }}

  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
    line-height: 1.5; -webkit-font-smoothing: antialiased;
  }}
  .wrap {{ max-width: 1000px; margin: 0 auto; padding: 40px 24px 80px; }}

  /* ── header / status strip ── */
  header {{ border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 28px; }}
  .eyebrow {{
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--signal); margin: 0 0 8px;
  }}
  h1 {{ font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; text-wrap: balance; }}
  .sub {{ color: var(--ink-soft); font-size: 14px; margin: 0; }}
  .range {{
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px; color: var(--ink-soft); margin-top: 10px;
    font-variant-numeric: tabular-nums;
  }}

  /* ── metric grid ── */
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; margin-bottom: 32px; }}
  .card {{
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px 18px; position: relative; overflow: hidden;
  }}
  .card::before {{ content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--miss); }}
  .card.v-pass::before {{ background: var(--pass); }}
  .card.v-warn::before {{ background: var(--warn); }}
  .card.v-nodata::before {{ background: var(--nodata); opacity: 0.5; }}
  .card-top {{ display: flex; justify-content: space-between; align-items: center; gap: 8px; }}
  .card-label {{
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft);
  }}
  .chip {{
    font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600;
    font-family: ui-monospace, monospace;
  }}
  .chip-pass {{ background: color-mix(in srgb, var(--pass) 16%, transparent); color: var(--pass); }}
  .chip-warn {{ background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }}
  .chip-miss {{ background: color-mix(in srgb, var(--miss) 18%, transparent); color: var(--miss); }}
  .chip-nodata {{ background: color-mix(in srgb, var(--nodata) 15%, transparent); color: var(--nodata); }}
  .card-value {{
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 30px; font-weight: 600; margin: 10px 0 6px; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }}
  .card-meta {{ display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--ink-soft); }}
  .card-meta .tgt {{ font-family: ui-monospace, monospace; }}

  /* ── sections ── */
  section {{ margin-bottom: 36px; }}
  h2 {{
    font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft);
    margin: 0 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); font-weight: 600;
  }}
  .chart-panel {{ background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 20px; }}
  canvas {{ display: block; width: 100%; height: auto; }}
  .chart-cap {{ font-size: 12px; color: var(--ink-soft); margin-top: 10px; font-family: ui-monospace, monospace; }}

  /* ── event table ── */
  .tbl-wrap {{ overflow-x: auto; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
  th, td {{ text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }}
  th {{ font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; }}
  td.ev {{ font-family: ui-monospace, monospace; color: var(--ink); }}
  td.num {{ text-align: right; font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--signal); }}

  footer {{ margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-soft); }}
  footer code {{ font-family: ui-monospace, monospace; background: var(--grid); padding: 1px 6px; border-radius: 4px; }}

  @media (prefers-reduced-motion: no-preference) {{
    .card {{ transition: none; }}
  }}
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">PersonaFlow · M3 通訊與集中式狀態管理</p>
    <h1>效能量測報告</h1>
    <p class="sub">依技術架構文件第 6 節指標，從結構化事件 log 計算。</p>
    <p class="range">量測區間　{range_txt}　·　事件總數 {n_events}</p>
  </header>

  <div class="grid">{cards}</div>

  <section>
    <h2>承載量時序 · swarm_summary</h2>
    <div class="chart-panel">
      <canvas id="loadChart" width="900" height="260"></canvas>
      <p class="chart-cap">每 5 秒一筆的在場人數快照（實線）與同時相遇數（填色）。峰值 {peak_swarm} 人。</p>
    </div>
  </section>

  <section>
    <h2>事件分佈</h2>
    <div class="chart-panel tbl-wrap">
      <table>
        <thead><tr><th>事件 event</th><th style="text-align:right">次數 count</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  </section>

  <footer>
    由 <code>backend/report_html.py</code> 從 <code>backend/logs/events-*.jsonl</code> 產生。
    重跑：<code>.venv/bin/python backend/report_html.py --glob -o docs/m3/perf_report.html</code>。
    生成延遲/失敗率若顯示「待實測」，跑 <code>bench_generate.py</code> 產生真數據後重跑本報告即可補上。
  </footer>
</div>

<script>
  const SERIES = {series_json};

  function cssVar(n) {{ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }}

  function drawLoad() {{
    const cv = document.getElementById('loadChart');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = 260;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const pad = {{ l: 40, r: 16, t: 16, b: 28 }};
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const n = SERIES.length;

    const gridC = cssVar('--grid'), inkSoft = cssVar('--ink-soft');
    const signal = cssVar('--signal'), signalSoft = cssVar('--signal-soft');

    if (n === 0) {{
      ctx.fillStyle = inkSoft; ctx.font = '13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('無 swarm_summary 資料 — 跑一次壓測即可產生', W / 2, H / 2);
      return;
    }}

    const maxSize = Math.max(5, ...SERIES.map(s => s.size));
    const x = i => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = v => pad.t + ih - (v / maxSize) * ih;

    // y grid + labels
    ctx.strokeStyle = gridC; ctx.fillStyle = inkSoft;
    ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'right';
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {{
      const val = Math.round(maxSize * t / ticks);
      const yy = y(val);
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
      ctx.fillText(val, pad.l - 6, yy + 4);
    }}
    // target line at 30
    if (maxSize >= 30 || true) {{
      const yy = y(30);
      if (yy > pad.t && yy < pad.t + ih) {{
        ctx.save(); ctx.strokeStyle = signal; ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = signal; ctx.textAlign = 'left'; ctx.font = '10px ui-monospace, monospace';
        ctx.fillText('目標 30', pad.l + 4, yy - 4);
      }}
    }}

    // greeting fill (area)
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    SERIES.forEach((s, i) => ctx.lineTo(x(i), y(s.greeting)));
    ctx.lineTo(x(n - 1), y(0)); ctx.closePath();
    ctx.fillStyle = signalSoft; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;

    // size line
    ctx.beginPath();
    SERIES.forEach((s, i) => (i ? ctx.lineTo(x(i), y(s.size)) : ctx.moveTo(x(i), y(s.size))));
    ctx.strokeStyle = signal; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

    // endpoint dot
    const last = SERIES[n - 1];
    ctx.beginPath(); ctx.arc(x(n - 1), y(last.size), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = signal; ctx.fill();
  }}

  drawLoad();
  let raf;
  window.addEventListener('resize', () => {{ cancelAnimationFrame(raf); raf = requestAnimationFrame(drawLoad); }});
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener && mq.addEventListener('change', drawLoad);
  new MutationObserver(drawLoad).observe(document.documentElement, {{ attributes: true, attributeFilter: ['data-theme'] }});
</script>
"""


def main():
    ap = argparse.ArgumentParser(description="PersonaFlow 事件 log → HTML 效能報告")
    ap.add_argument("paths", nargs="*", help="log 檔路徑（省略則用今日檔）")
    ap.add_argument("--glob", action="store_true", help="合併 logs/ 下所有 events-*.jsonl")
    ap.add_argument("-o", "--out", default="report.html", help="輸出 HTML 路徑")
    args = ap.parse_args()

    if args.glob:
        paths = sorted(glob.glob(os.path.join(_LOG_DIR, "events-*.jsonl")))
    elif args.paths:
        paths = args.paths
    else:
        today = datetime.now(_TZ).strftime("%Y%m%d")
        paths = [os.path.join(_LOG_DIR, f"events-{today}.jsonl")]

    events = _load(paths)
    if not events:
        print("⚠️ 沒讀到任何事件，先跑後端 / 壓測產生 log。")
        sys.exit(1)

    m = _compute(events)
    html = _build_html(m)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"✅ 報告已產生：{args.out}（{len(events):,} 筆事件）")
    print(f"   承載量峰值 {m['peak_swarm']}｜相遇 {m['encounters']:,}｜"
          f"生成延遲 p50 {_fmt_ms(m['gen_p50']) or '待實測'}")


if __name__ == "__main__":
    main()
