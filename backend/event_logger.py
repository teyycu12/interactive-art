"""
M3 結構化事件 log 落地模組。

所有互動事件（上場、移動彙總、相遇、離場、生成延遲、失敗）以 JSON lines
（每事件一行）寫入 logs/events-YYYYMMDD.jsonl，供 WP-C 九月實測與期末報告的
效能量測（技術架構文件第 6 節）取用真實數據。

設計原則：
- 執行緒安全（Flask-SocketIO 背景 thread、ThreadPoolExecutor、主 handler 皆會呼叫）
- 非阻塞失敗：log 寫檔本身絕不能讓主流程當掉，任何例外都吞掉並 print 警告
- 不落地影像：payload 只存結構化欄位，原始 base64 影像絕不寫入（隱私原則，見第 8 節）
"""

import json
import os
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

# 台北時區（UTC+8），log 檔名與時間戳用本地時間方便現場對照
_TZ = timezone(timedelta(hours=8))

# log 目錄：backend/logs/
_LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")

# 寫檔鎖 + 檔案 handle 快取
_lock = threading.Lock()
_current_date_str: Optional[str] = None
_current_fh = None

# 是否啟用（可用環境變數 EVENT_LOG_ENABLED=0 關閉，例如純渲染測試時）
_ENABLED = os.environ.get("EVENT_LOG_ENABLED", "1") not in ("0", "false", "False", "")

# 這些 key 一律不寫進 log（避免影像 / base64 落地）
_BLOCKED_KEYS = {"image", "img", "img_str", "body_png", "stencil", "cloth_grid",
                 "lower_grid", "frame", "base64", "data"}


def _now_iso() -> str:
    return datetime.now(_TZ).isoformat(timespec="milliseconds")


def _ensure_fh():
    """依當日日期取得（必要時輪替）log 檔案 handle。呼叫端須持有 _lock。"""
    global _current_date_str, _current_fh
    date_str = datetime.now(_TZ).strftime("%Y%m%d")
    if date_str != _current_date_str or _current_fh is None:
        if _current_fh is not None:
            try:
                _current_fh.close()
            except Exception:
                pass
        os.makedirs(_LOG_DIR, exist_ok=True)
        path = os.path.join(_LOG_DIR, f"events-{date_str}.jsonl")
        _current_fh = open(path, "a", encoding="utf-8")
        _current_date_str = date_str
    return _current_fh


def _sanitize(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """移除影像 / 大型二進位欄位，只保留可分析的結構化資料。"""
    if not payload:
        return {}
    out: Dict[str, Any] = {}
    for k, v in payload.items():
        if k in _BLOCKED_KEYS:
            continue
        # 巢狀 dict 也遞迴清理（例如 outfit / face），但避免無限深度
        if isinstance(v, dict):
            out[k] = _sanitize(v)
        elif isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v
        elif isinstance(v, (list, tuple)):
            # list 只保留長度資訊，避免 landmarks / grid 等巨量陣列寫爆 log
            out[k] = f"<list len={len(v)}>"
        else:
            out[k] = f"<{type(v).__name__}>"
    return out


def log_event(event: str, *, pid: Optional[str] = None,
              latency_ms: Optional[float] = None,
              **fields: Any) -> None:
    """
    寫一筆結構化事件。

    參數：
        event       事件名（沿用 CLAUDE.md「動詞_名詞 snake_case」慣例）
        pid         參與者 / 角色 id（char_id 或 socket sid）
        latency_ms  該事件相關延遲（毫秒），如生成延遲、子流程延遲
        **fields    其他結構化欄位（會經過 _sanitize 移除影像）

    格式範例（技術架構文件 5.3）：
        {"ts": "...", "event": "join_swarm", "pid": "...", "latency_ms": 2140}
    """
    if not _ENABLED:
        return

    record: Dict[str, Any] = {"ts": _now_iso(), "event": event}
    if pid is not None:
        record["pid"] = pid
    if latency_ms is not None:
        record["latency_ms"] = round(float(latency_ms), 1)
    if fields:
        record.update(_sanitize(fields))

    line = json.dumps(record, ensure_ascii=False)
    try:
        with _lock:
            fh = _ensure_fh()
            fh.write(line + "\n")
            fh.flush()
    except Exception as e:
        # log 寫檔失敗絕不能中斷主流程
        print(f"[event_logger] write failed: {e}")


class Timer:
    """
    量測子流程耗時的 context manager，離開時自動 log。

    用法：
        with Timer("generate_avatar", pid=sid, mode=mode) as t:
            ...做事...
            t.mark("cv_done")          # 可選：記錄中間里程碑毫秒數
        # 離開 with 區塊時自動寫一筆 event，latency_ms = 總耗時

    若區塊內拋例外，仍會 log 一筆並帶 ok=False / error 欄位後再重新拋出，
    確保失敗率（第 6 節指標）可被統計。
    """

    def __init__(self, event: str, *, pid: Optional[str] = None, **fields: Any):
        self.event = event
        self.pid = pid
        self.fields = fields
        self._start = 0.0
        self._marks: Dict[str, float] = {}

    def __enter__(self) -> "Timer":
        self._start = time.perf_counter()
        return self

    def mark(self, name: str) -> float:
        """記錄一個里程碑，回傳自 Timer 起始至今的毫秒數，並存入最終 log。"""
        elapsed = (time.perf_counter() - self._start) * 1000.0
        self._marks[f"{name}_ms"] = round(elapsed, 1)
        return elapsed

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        elapsed_ms = (time.perf_counter() - self._start) * 1000.0
        fields = dict(self.fields)
        fields.update(self._marks)
        if exc_type is not None:
            fields["ok"] = False
            fields["error"] = str(exc_val)
        else:
            fields.setdefault("ok", True)
        log_event(self.event, pid=self.pid, latency_ms=elapsed_ms, **fields)
        return False  # 不吞例外，讓上層繼續處理
