"""SQLite-backed development history for M2 generation experiments.

Generated sprites, a resized/EXIF-stripped copy of the source photo, request
metadata, validation results, latency, token counts and the provider-reported
cost are retained under the gitignored ``backend/logs`` directory so history
entries can be compared against their input photo later.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sqlite3
import statistics
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from PIL import Image, ImageOps


_LOG_DIR = Path(__file__).resolve().parent / "logs"
_DB_PATH = _LOG_DIR / "generation_history.sqlite3"
_OUTPUT_DIR = _LOG_DIR / "generated"
_INPUT_DIR = _LOG_DIR / "inputs"


def _connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    path = Path(db_path or _DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


@contextmanager
def _db(db_path: Optional[Path] = None):
    connection = _connect(db_path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init_history_db(db_path: Optional[Path] = None) -> None:
    with _db(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS generation_runs (
                request_id TEXT PRIMARY KEY,
                created_at REAL NOT NULL,
                completed_at REAL,
                mode TEXT NOT NULL,
                style_id TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT 'camera',
                experiment_id TEXT,
                comparison_id TEXT,
                variant_id TEXT,
                metadata_source TEXT NOT NULL DEFAULT 'api_reported',
                status TEXT NOT NULL DEFAULT 'running',
                stage TEXT,
                height_class TEXT,
                height_ratio REAL,
                height_measurement_valid INTEGER,
                duration_ms INTEGER,
                cv_ms INTEGER,
                vlm_ms INTEGER,
                generation_ms INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0,
                fallback_used INTEGER NOT NULL DEFAULT 0,
                validation_errors TEXT NOT NULL DEFAULT '[]',
                validation_warnings TEXT NOT NULL DEFAULT '[]',
                error_code TEXT,
                guidance TEXT,
                output_path TEXT,
                detail_metrics TEXT,
                external_metadata TEXT,
                input_path TEXT
            );

            CREATE TABLE IF NOT EXISTS generation_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT NOT NULL,
                phase TEXT NOT NULL,
                attempt_index INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                provider_request_id TEXT,
                started_at REAL NOT NULL,
                duration_ms INTEGER,
                ok INTEGER NOT NULL DEFAULT 0,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                image_tokens INTEGER,
                cached_tokens INTEGER,
                cost_usd REAL,
                upstream_cost_usd REAL,
                error_code TEXT,
                validation_errors TEXT NOT NULL DEFAULT '[]',
                validation_warnings TEXT NOT NULL DEFAULT '[]',
                output_path TEXT,
                FOREIGN KEY(request_id) REFERENCES generation_runs(request_id)
                    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS generation_reviews (
                request_id TEXT PRIMARY KEY,
                verdict TEXT NOT NULL DEFAULT 'pending',
                completeness_score INTEGER,
                clothing_match_score INTEGER,
                face_match_score INTEGER,
                overall_score INTEGER,
                notes TEXT NOT NULL DEFAULT '',
                updated_at REAL NOT NULL,
                FOREIGN KEY(request_id) REFERENCES generation_runs(request_id)
                    ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_generation_runs_created
                ON generation_runs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_generation_attempts_request
                ON generation_attempts(request_id, id);
            """
        )
        # Forward-compatible migration for databases created by v1.3.
        attempt_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(generation_attempts)")
        }
        if "output_path" not in attempt_columns:
            connection.execute("ALTER TABLE generation_attempts ADD COLUMN output_path TEXT")
        if "style_fingerprint" not in attempt_columns:
            connection.execute("ALTER TABLE generation_attempts ADD COLUMN style_fingerprint TEXT")
        run_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(generation_runs)")
        }
        if "height_ratio" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN height_ratio REAL")
        if "height_measurement_valid" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN height_measurement_valid INTEGER")
        if "detail_metrics" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN detail_metrics TEXT")
        if "comparison_id" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN comparison_id TEXT")
        if "experiment_id" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN experiment_id TEXT")
        if "variant_id" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN variant_id TEXT")
        if "metadata_source" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'api_reported'")
        if "external_metadata" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN external_metadata TEXT")
        if "input_path" not in run_columns:
            connection.execute("ALTER TABLE generation_runs ADD COLUMN input_path TEXT")


def start_run(
    request_id: str,
    *,
    mode: str,
    style_id: str,
    source_type: str,
    experiment_id: Optional[str] = None,
    comparison_id: Optional[str] = None,
    variant_id: Optional[str] = None,
    metadata_source: str = "api_reported",
    db_path: Optional[Path] = None,
) -> None:
    init_history_db(db_path)
    source = source_type if source_type in {"upload", "camera", "external"} else "camera"
    with _db(db_path) as connection:
        connection.execute(
            """
            INSERT OR REPLACE INTO generation_runs
                (request_id, created_at, mode, style_id, source_type,
                 experiment_id, comparison_id, variant_id, metadata_source, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
            """,
            (
                request_id, time.time(), mode, style_id, source,
                str(experiment_id or "")[:96] or None,
                str(comparison_id or "")[:96] or None,
                str(variant_id or "")[:96] or None,
                metadata_source if metadata_source in {"api_reported", "manual_reported"} else "api_reported",
            ),
        )


def _json_list(value: Optional[Iterable[Any]]) -> str:
    return json.dumps(list(value or []), ensure_ascii=False, separators=(",", ":"))


def record_attempt(
    request_id: str,
    *,
    phase: str,
    attempt_index: int,
    result: Dict[str, Any],
    validation: Optional[Dict[str, Any]] = None,
    db_path: Optional[Path] = None,
) -> None:
    usage = result.get("api_usage") or {}
    validation = validation or {}
    output_path = _save_generated_output(
        request_id, f"{phase}_{int(attempt_index)}", result.get("body_png")
    )
    with _db(db_path) as connection:
        connection.execute(
            """
            INSERT INTO generation_attempts (
                request_id, phase, attempt_index, model, provider_request_id,
                started_at, duration_ms, ok, prompt_tokens, completion_tokens,
                total_tokens, image_tokens, cached_tokens, cost_usd,
                upstream_cost_usd, error_code, validation_errors,
                validation_warnings, output_path, style_fingerprint
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                request_id,
                phase,
                int(attempt_index),
                usage.get("model"),
                usage.get("provider_request_id"),
                float(usage.get("started_at") or time.time()),
                usage.get("duration_ms"),
                int(bool(result.get("ok"))),
                usage.get("prompt_tokens"),
                usage.get("completion_tokens"),
                usage.get("total_tokens"),
                usage.get("image_tokens"),
                usage.get("cached_tokens"),
                usage.get("cost_usd"),
                usage.get("upstream_cost_usd"),
                result.get("error") or usage.get("error_code"),
                _json_list(validation.get("errors")),
                _json_list(validation.get("warnings")),
                output_path,
                _style_fingerprint_for_output(output_path),
            ),
        )


def _decode_input_image(image_data_url: str) -> Image.Image:
    raw_b64 = image_data_url.split(",", 1)[1] if image_data_url.startswith("data:image") else image_data_url
    image = Image.open(io.BytesIO(base64.b64decode(raw_b64)))
    image.load()
    return ImageOps.exif_transpose(image).convert("RGB")


def save_input_photo(
    request_id: str,
    image_data_url: Optional[str],
    *,
    db_path: Optional[Path] = None,
) -> Optional[str]:
    """Persist a resized, EXIF-stripped copy of the source photo for history comparison."""
    if not image_data_url or os.environ.get("DEV_HISTORY_SAVE_INPUTS", "1").lower() in {"0", "false", "no"}:
        return None
    init_history_db(db_path)
    filename = None
    try:
        image = _decode_input_image(image_data_url)
        image.thumbnail((640, 640), Image.Resampling.LANCZOS)
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", request_id)[:96]
        _INPUT_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{safe_id}.webp"
        image.save(_INPUT_DIR / filename, "WEBP", quality=78, method=5)
        with _db(db_path) as connection:
            connection.execute(
                "UPDATE generation_runs SET input_path=? WHERE request_id=?",
                (filename, request_id),
            )
    except Exception:
        if filename:
            (_INPUT_DIR / filename).unlink(missing_ok=True)
        return None
    return filename


def input_directory() -> Path:
    return _INPUT_DIR


def _save_generated_output(request_id: str, stage: str, png_b64: Optional[str]) -> Optional[str]:
    if not png_b64 or os.environ.get("DEV_HISTORY_SAVE_OUTPUTS", "1").lower() in {"0", "false", "no"}:
        return None
    try:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", request_id)[:96]
        safe_stage = re.sub(r"[^A-Za-z0-9_.-]", "_", stage)[:32]
        _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        target = _OUTPUT_DIR / f"{safe_id}_{safe_stage}.png"
        target.write_bytes(base64.b64decode(png_b64))
        return target.name
    except Exception:
        return None


def save_rendered_output(
    request_id: str,
    png_b64: str,
    *,
    db_path: Optional[Path] = None,
) -> Optional[str]:
    """Save the browser-composited final avatar without counting an API call."""
    with _db(db_path) as connection:
        exists = connection.execute(
            "SELECT 1 FROM generation_runs WHERE request_id=?", (request_id,)
        ).fetchone()
        if not exists:
            raise KeyError(request_id)

    output_path = _save_generated_output(request_id, "frontend_final", png_b64)
    if output_path:
        detail_metrics = _detail_metrics_for_output(output_path)
        with _db(db_path) as connection:
            connection.execute(
                "UPDATE generation_runs SET output_path=?, detail_metrics=? WHERE request_id=?",
                (output_path, detail_metrics, request_id),
            )
    return output_path


def finish_run(
    request_id: str,
    *,
    status: str,
    stage: str,
    height_class: Optional[str],
    duration_ms: int,
    cv_ms: Optional[int],
    vlm_ms: Optional[int],
    generation_ms: Optional[int],
    retry_count: int,
    validation: Optional[Dict[str, Any]] = None,
    error_code: Optional[str] = None,
    guidance: Optional[str] = None,
    output_png: Optional[str] = None,
    height_ratio: Optional[float] = None,
    height_measurement_valid: Optional[bool] = None,
    db_path: Optional[Path] = None,
) -> None:
    validation = validation or {}
    output_path = _save_generated_output(request_id, stage, output_png)
    detail_metrics = _detail_metrics_for_output(output_path)
    with _db(db_path) as connection:
        connection.execute(
            """
            UPDATE generation_runs SET
                completed_at=?, status=?, stage=?, height_class=?, height_ratio=?,
                height_measurement_valid=?, duration_ms=?,
                cv_ms=?, vlm_ms=?, generation_ms=?, retry_count=?,
                fallback_used=0, validation_errors=?, validation_warnings=?,
                error_code=?, guidance=?, output_path=COALESCE(output_path, ?),
                detail_metrics=COALESCE(detail_metrics, ?)
            WHERE request_id=?
            """,
            (
                time.time(), status, stage, height_class, height_ratio,
                None if height_measurement_valid is None else int(bool(height_measurement_valid)),
                int(duration_ms), cv_ms,
                vlm_ms, generation_ms, int(retry_count),
                _json_list(validation.get("errors")),
                _json_list(validation.get("warnings")), error_code, guidance,
                output_path, detail_metrics, request_id,
            ),
        )


def mark_render_failure(
    request_id: str,
    *,
    error_code: str = "frontend_3d_render_failed",
    guidance: str = "Three.js 正式角色渲染失敗。",
    db_path: Optional[Path] = None,
) -> None:
    """Turn an AI-success run into a formal failure when its 3D output cannot render."""
    with _db(db_path) as connection:
        cursor = connection.execute(
            """
            UPDATE generation_runs SET
                completed_at=?, status='failed', stage='frontend_3d_render',
                fallback_used=0, validation_errors=?, error_code=?, guidance=?,
                output_path=NULL, detail_metrics=NULL
            WHERE request_id=?
            """,
            (
                time.time(),
                _json_list([error_code]),
                error_code,
                guidance,
                request_id,
            ),
        )
        if cursor.rowcount == 0:
            raise KeyError(request_id)


def _decode_row(row: sqlite3.Row) -> Dict[str, Any]:
    item = dict(row)
    for key in ("validation_errors", "validation_warnings", "detail_metrics", "external_metadata"):
        try:
            default = "{}" if key in {"detail_metrics", "external_metadata"} else "[]"
            item[key] = json.loads(item.get(key) or default)
        except json.JSONDecodeError:
            item[key] = {} if key in {"detail_metrics", "external_metadata"} else []
    for key in ("fallback_used", "ok"):
        if key in item:
            item[key] = bool(item[key])
    if "height_measurement_valid" in item and item["height_measurement_valid"] is not None:
        item["height_measurement_valid"] = bool(item["height_measurement_valid"])
    return item


def update_run_experiment(
    request_id: str,
    *,
    experiment_id: Optional[str],
    comparison_id: Optional[str],
    variant_id: Optional[str],
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    with _db(db_path) as connection:
        cursor = connection.execute(
            """
            UPDATE generation_runs
            SET experiment_id=?, comparison_id=?, variant_id=?
            WHERE request_id=?
            """,
            (
                str(experiment_id or "")[:96] or None,
                str(comparison_id or "")[:96] or None,
                str(variant_id or "")[:96] or None,
                request_id,
            ),
        )
        if not cursor.rowcount:
            raise KeyError(request_id)
    return get_run(request_id, db_path=db_path) or {}


def list_runs(
    limit: int = 100,
    mode: Optional[str] = None,
    experiment_id: Optional[str] = None,
    variant_id: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> list[Dict[str, Any]]:
    init_history_db(db_path)
    backfill_detail_metrics(db_path=db_path)
    limit = max(1, min(int(limit), 500))
    clauses = []
    values: list[Any] = []
    if mode:
        clauses.append("r.mode=?")
        values.append(mode)
    if experiment_id:
        clauses.append("r.experiment_id=?")
        values.append(experiment_id)
    if variant_id:
        clauses.append("r.variant_id=?")
        values.append(variant_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params: tuple[Any, ...] = (*values, limit)
    with _db(db_path) as connection:
        rows = connection.execute(
            f"""
            SELECT r.*, rv.verdict AS review_verdict,
                   rv.completeness_score, rv.clothing_match_score,
                   rv.face_match_score, rv.overall_score,
                   COUNT(a.id) AS api_call_count,
                   COALESCE(SUM(a.prompt_tokens), 0) AS prompt_tokens,
                   COALESCE(SUM(a.completion_tokens), 0) AS completion_tokens,
                   COALESCE(SUM(a.total_tokens), 0) AS total_tokens,
                   COALESCE(SUM(a.image_tokens), 0) AS image_tokens,
                   COALESCE(SUM(a.cost_usd), 0.0) AS cost_usd,
                   MAX(CASE WHEN a.total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS token_reported,
                   (
                       SELECT a2.model FROM generation_attempts a2
                       WHERE a2.request_id = r.request_id AND a2.model IS NOT NULL
                       ORDER BY a2.ok DESC, a2.id DESC LIMIT 1
                   ) AS model
            FROM generation_runs r
            LEFT JOIN generation_attempts a ON a.request_id=r.request_id
            LEFT JOIN generation_reviews rv ON rv.request_id=r.request_id
            {where}
            GROUP BY r.request_id
            ORDER BY r.created_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    return [_decode_row(row) for row in rows]


def get_run(request_id: str, db_path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    runs = [row for row in list_runs(500, db_path=db_path) if row["request_id"] == request_id]
    if not runs:
        return None
    with _db(db_path) as connection:
        attempts = connection.execute(
            "SELECT * FROM generation_attempts WHERE request_id=? ORDER BY id",
            (request_id,),
        ).fetchall()
        review = connection.execute(
            "SELECT * FROM generation_reviews WHERE request_id=?",
            (request_id,),
        ).fetchone()
    runs[0]["attempts"] = [_decode_row(row) for row in attempts]
    runs[0]["review"] = dict(review) if review else None
    return runs[0]


def save_review(
    request_id: str,
    *,
    verdict: str,
    completeness_score: Optional[int] = None,
    clothing_match_score: Optional[int] = None,
    face_match_score: Optional[int] = None,
    overall_score: Optional[int] = None,
    notes: str = "",
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    verdict = verdict if verdict in {"pending", "pass", "fail"} else "pending"

    def _score(value: Optional[int]) -> Optional[int]:
        if value in (None, ""):
            return None
        number = int(value)
        if not 1 <= number <= 5:
            raise ValueError("review scores must be between 1 and 5")
        return number

    values = (
        _score(completeness_score), _score(clothing_match_score),
        _score(face_match_score), _score(overall_score),
    )
    with _db(db_path) as connection:
        exists = connection.execute(
            "SELECT 1 FROM generation_runs WHERE request_id=?", (request_id,)
        ).fetchone()
        if not exists:
            raise KeyError(request_id)
        connection.execute(
            """
            INSERT INTO generation_reviews (
                request_id, verdict, completeness_score, clothing_match_score,
                face_match_score, overall_score, notes, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO UPDATE SET
                verdict=excluded.verdict,
                completeness_score=excluded.completeness_score,
                clothing_match_score=excluded.clothing_match_score,
                face_match_score=excluded.face_match_score,
                overall_score=excluded.overall_score,
                notes=excluded.notes,
                updated_at=excluded.updated_at
            """,
            (request_id, verdict, *values, str(notes or "")[:2000], time.time()),
        )
    item = get_run(request_id, db_path=db_path)
    return (item or {}).get("review") or {}


def get_summary(db_path: Optional[Path] = None) -> Dict[str, Any]:
    init_history_db(db_path)
    with _db(db_path) as connection:
        totals = connection.execute(
            """
            SELECT (SELECT COUNT(*) FROM generation_runs) AS run_count,
                   (SELECT COUNT(*) FROM generation_attempts) AS api_call_count,
                   (SELECT COALESCE(SUM(cost_usd), 0.0) FROM generation_attempts) AS cost_usd,
                   (SELECT COALESCE(SUM(total_tokens), 0) FROM generation_attempts) AS total_tokens,
                   (SELECT COALESCE(AVG(duration_ms), 0) FROM generation_runs WHERE status='success') AS avg_success_ms,
                   (SELECT COUNT(*) FROM generation_runs WHERE status IN ('success', 'base_only')) AS success_count
                   ,(SELECT COUNT(*) FROM generation_reviews WHERE verdict!='pending') AS reviewed_count
                   ,(SELECT COUNT(*) FROM generation_reviews WHERE verdict='pass') AS review_pass_count
            """
        ).fetchone()
        by_mode = connection.execute(
            """
            SELECT r.mode, COUNT(*) AS run_count,
                   COALESCE(SUM((SELECT COUNT(*) FROM generation_attempts a WHERE a.request_id=r.request_id)), 0) AS api_call_count,
                   COALESCE(SUM((SELECT COALESCE(SUM(a.cost_usd), 0.0) FROM generation_attempts a WHERE a.request_id=r.request_id)), 0.0) AS cost_usd,
                   COALESCE(AVG(r.duration_ms), 0) AS avg_duration_ms
            FROM generation_runs r
            GROUP BY r.mode ORDER BY r.mode
            """
        ).fetchall()
    output = dict(totals or {})
    output["by_mode"] = [dict(row) for row in by_mode]
    output["success_rate"] = (
        output["success_count"] / output["run_count"] if output.get("run_count") else 0.0
    )
    return output


def get_detail_benchmark(db_path: Optional[Path] = None) -> Dict[str, Any]:
    """Return mode-level final-render detail medians and formal/reference parity."""
    runs = list_runs(500, db_path=db_path)
    fields = ("detail_score", "edge_density", "sharpness", "micro_contrast", "entropy")
    grouped: Dict[str, list[Dict[str, Any]]] = {}
    for run in runs:
        metrics = run.get("detail_metrics")
        if not isinstance(metrics, dict) or metrics.get("detail_score") is None:
            continue
        grouped.setdefault(str(run.get("mode")), []).append(metrics)

    by_mode = {}
    for mode, rows in grouped.items():
        by_mode[mode] = {
            "sample_count": len(rows),
            **{
                field: round(statistics.median(float(row[field]) for row in rows if row.get(field) is not None), 4)
                for field in fields
            },
        }

    formal = by_mode.get("brick_ai_texture")
    reference_mode = "full_character" if by_mode.get("full_character") else None
    reference = by_mode.get(reference_mode) if reference_mode else None
    ratio = None
    if formal and reference and float(reference.get("detail_score") or 0) > 0:
        ratio = float(formal["detail_score"]) / float(reference["detail_score"])
    paired_ratios = []
    if reference_mode:
        paired: Dict[str, Dict[str, list[float]]] = {}
        for run in runs:
            comparison_id = run.get("comparison_id")
            metrics = run.get("detail_metrics")
            mode = run.get("mode")
            if (
                not comparison_id or not isinstance(metrics, dict)
                or metrics.get("detail_score") is None
                or mode not in {"brick_ai_texture", reference_mode}
            ):
                continue
            paired.setdefault(str(comparison_id), {}).setdefault(str(mode), []).append(
                float(metrics["detail_score"])
            )
        for modes in paired.values():
            formal_values = modes.get("brick_ai_texture")
            reference_values = modes.get(reference_mode)
            if formal_values and reference_values and statistics.median(reference_values) > 0:
                paired_ratios.append(
                    statistics.median(formal_values) / statistics.median(reference_values)
                )
    paired_ratio = statistics.median(paired_ratios) if paired_ratios else None
    return {
        "analyzer_version": 1,
        "by_mode": by_mode,
        "formal_mode": "brick_ai_texture",
        "reference_mode": reference_mode,
        "detail_parity_ratio": round(ratio, 3) if ratio is not None else None,
        "paired_sample_count": len(paired_ratios),
        "paired_detail_ratio_median": round(paired_ratio, 3) if paired_ratio is not None else None,
        "minimum_paired_samples": 5,
        "target_ratio": 0.95,
        "target_met": len(paired_ratios) >= 5 and paired_ratio is not None and paired_ratio >= 0.95,
        "note": "細節分只衡量清晰度與局部紋理；人物相似度仍需同照片盲評。",
    }


def output_directory() -> Path:
    return _OUTPUT_DIR


def _detail_metrics_for_output(output_path: Optional[str]) -> Optional[str]:
    if not output_path:
        return None
    try:
        from backend.detail_quality import analyze_detail  # type: ignore
    except Exception:
        try:
            from detail_quality import analyze_detail  # type: ignore
        except Exception:
            return None
    try:
        return json.dumps(
            analyze_detail(_OUTPUT_DIR / output_path),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except Exception:
        return None


def _style_fingerprint_for_output(output_path: Optional[str]) -> Optional[str]:
    """Measure one stored sprite's style, for cross-character drift.

    Kept separate from ``_detail_metrics_for_output``: detail metrics score a
    single character's richness, this measures the style language so a *set* of
    characters can be compared against each other.
    """
    if not output_path:
        return None
    try:
        from backend.style_probe import sprite_fingerprint  # type: ignore
    except Exception:
        try:
            from style_probe import sprite_fingerprint  # type: ignore
        except Exception:
            return None
    try:
        target = _OUTPUT_DIR / output_path
        if not target.is_file():
            return None
        fingerprint = sprite_fingerprint(target.read_bytes())
        if not fingerprint.get("valid"):
            return None
        return json.dumps(fingerprint, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return None


def backfill_style_fingerprints(*, db_path: Optional[Path] = None) -> int:
    """Measure historical attempts once so pre-change drift stays comparable."""
    init_history_db(db_path)
    updated = 0
    with _db(db_path) as connection:
        rows = connection.execute(
            """
            SELECT id, output_path FROM generation_attempts
            WHERE output_path IS NOT NULL AND style_fingerprint IS NULL
            """
        ).fetchall()
        for row in rows:
            fingerprint = _style_fingerprint_for_output(row["output_path"])
            if not fingerprint:
                continue
            connection.execute(
                "UPDATE generation_attempts SET style_fingerprint=? WHERE id=?",
                (fingerprint, row["id"]),
            )
            updated += 1
    return updated


def get_cast_drift(
    *,
    experiment_id: Optional[str] = None,
    mode: str = "full_character",
    limit: int = 50,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Cross-character style drift over the most recent successful attempts."""
    init_history_db(db_path)
    try:
        from backend.style_probe import cast_drift_by_region  # type: ignore
    except Exception:
        from style_probe import cast_drift_by_region  # type: ignore

    clauses = ["a.style_fingerprint IS NOT NULL", "a.ok = 1"]
    params: List[Any] = []
    if mode:
        clauses.append("r.mode = ?")
        params.append(mode)
    if experiment_id:
        clauses.append("r.experiment_id = ?")
        params.append(experiment_id)
    params.append(int(max(2, limit)))

    with _db(db_path) as connection:
        rows = connection.execute(
            f"""
            SELECT a.style_fingerprint FROM generation_attempts a
            JOIN generation_runs r ON r.request_id = a.request_id
            WHERE {' AND '.join(clauses)}
            ORDER BY a.started_at DESC LIMIT ?
            """,
            params,
        ).fetchall()

    fingerprints = []
    for row in rows:
        try:
            fingerprints.append(json.loads(row["style_fingerprint"]))
        except (TypeError, ValueError):
            continue
    return {
        "mode": mode,
        "experiment_id": experiment_id,
        "characters": len(fingerprints),
        "regions": cast_drift_by_region(fingerprints),
    }


def backfill_detail_metrics(*, db_path: Optional[Path] = None) -> int:
    """Analyze historical final outputs once so old experiment runs are comparable."""
    init_history_db(db_path)
    updated = 0
    with _db(db_path) as connection:
        rows = connection.execute(
            """
            SELECT request_id, output_path FROM generation_runs
            WHERE output_path IS NOT NULL AND detail_metrics IS NULL
            """
        ).fetchall()
        for row in rows:
            metrics = _detail_metrics_for_output(row["output_path"])
            if not metrics:
                continue
            connection.execute(
                "UPDATE generation_runs SET detail_metrics=? WHERE request_id=?",
                (metrics, row["request_id"]),
            )
            updated += 1
    return updated
