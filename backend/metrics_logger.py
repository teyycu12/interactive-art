"""Privacy-preserving JSONL metrics for M1/M2 comparison."""

from __future__ import annotations

import json
import logging
import os
import threading
from logging.handlers import RotatingFileHandler
from typing import Any, Dict


_lock = threading.Lock()
_logger: logging.Logger | None = None


def _get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger
    with _lock:
        if _logger is not None:
            return _logger
        logger = logging.getLogger("personaflow.metrics")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        if not logger.handlers:
            log_dir = os.path.join(os.path.dirname(__file__), "logs")
            os.makedirs(log_dir, exist_ok=True)
            handler = RotatingFileHandler(
                os.path.join(log_dir, "m1_m2_metrics.jsonl"),
                maxBytes=5 * 1024 * 1024,
                backupCount=3,
                encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
        _logger = logger
        return logger


def log_metric(record: Dict[str, Any]) -> None:
    if os.environ.get("METRICS_ENABLED", "1").strip().lower() in {"0", "false", "no"}:
        return
    allowed = {
        "ts", "mode", "style_id", "height_class", "stage",
        "duration_ms", "cv_ms", "vlm_ms", "generation_ms", "base_generation_ms",
        "refine_generation_ms", "quality_score", "validation_errors",
        "validation_warnings", "retry_count", "fallback_used", "status",
    }
    safe = {key: value for key, value in record.items() if key in allowed}
    _get_logger().info(json.dumps(safe, ensure_ascii=False, separators=(",", ":")))
