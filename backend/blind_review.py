"""Local, privacy-scoped blind review workflow for generation experiments."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import random
import secrets
import statistics
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from PIL import Image, ImageOps

try:
    from backend.generation_history import (  # type: ignore
        _db,
        _save_generated_output,
        finish_run,
        get_run,
        init_history_db,
        record_attempt,
        start_run,
    )
except Exception:
    from generation_history import (  # type: ignore
        _db,
        _save_generated_output,
        finish_run,
        get_run,
        init_history_db,
        record_attempt,
        start_run,
    )


_SOURCE_DIR = Path(__file__).resolve().parent / "logs" / "review_sources"
_SCORE_FIELDS = (
    "clothing_color_score", "clothing_detail_score", "identity_score",
    "refinement_score", "geometry_score", "projection_score",
)
_GROUP_SCORE_FIELDS = (
    "species_score", "face_style_score", "lighting_score",
    "body_diversity_score", "separability_score", "group_finish_score",
)


def init_blind_review_db(db_path: Optional[Path] = None) -> None:
    init_history_db(db_path)
    with _db(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS review_source_images (
                experiment_id TEXT NOT NULL,
                comparison_id TEXT NOT NULL,
                output_path TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (experiment_id, comparison_id)
            );
            CREATE TABLE IF NOT EXISTS blind_review_sessions (
                session_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                experiment_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at REAL NOT NULL,
                locked_at REAL,
                completed_at REAL
            );
            CREATE TABLE IF NOT EXISTS blind_review_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                comparison_id TEXT NOT NULL,
                variant_id TEXT NOT NULL,
                anonymous_code TEXT NOT NULL,
                group_code TEXT NOT NULL,
                UNIQUE(session_id, request_id),
                UNIQUE(session_id, anonymous_code),
                FOREIGN KEY(session_id) REFERENCES blind_review_sessions(session_id) ON DELETE CASCADE,
                FOREIGN KEY(request_id) REFERENCES generation_runs(request_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS blind_review_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                reviewer_code TEXT NOT NULL,
                clothing_color_score INTEGER NOT NULL,
                clothing_detail_score INTEGER NOT NULL,
                identity_score INTEGER NOT NULL,
                refinement_score INTEGER NOT NULL,
                geometry_score INTEGER NOT NULL,
                projection_score INTEGER NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                UNIQUE(session_id, request_id, reviewer_code)
            );
            CREATE TABLE IF NOT EXISTS blind_group_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                group_code TEXT NOT NULL,
                reviewer_code TEXT NOT NULL,
                species_score INTEGER NOT NULL,
                face_style_score INTEGER NOT NULL,
                lighting_score INTEGER NOT NULL,
                body_diversity_score INTEGER NOT NULL,
                separability_score INTEGER NOT NULL,
                group_finish_score INTEGER NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                UNIQUE(session_id, group_code, reviewer_code)
            );
            CREATE INDEX IF NOT EXISTS idx_blind_items_session ON blind_review_items(session_id);
            CREATE INDEX IF NOT EXISTS idx_blind_responses_session ON blind_review_responses(session_id, reviewer_code);
            """
        )


def _safe_code(value: Any, *, maximum: int = 96) -> str:
    text = str(value or "").strip()
    if not text or len(text) > maximum or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for ch in text):
        raise ValueError("invalid_code")
    return text


def _score_payload(payload: Dict[str, Any], fields: Iterable[str]) -> Dict[str, int]:
    result: Dict[str, int] = {}
    for field in fields:
        value = int(payload.get(field))
        if not 1 <= value <= 5:
            raise ValueError(f"{field}_out_of_range")
        result[field] = value
    return result


def _decode_image_data_url(data_url: str) -> Image.Image:
    if not str(data_url).startswith("data:image/") or "," not in data_url:
        raise ValueError("invalid_image")
    raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    image = Image.open(io.BytesIO(raw))
    image.load()
    return ImageOps.exif_transpose(image).convert("RGB")


def save_review_source(
    experiment_id: str,
    comparison_id: str,
    image_data_url: str,
    *,
    db_path: Optional[Path] = None,
    source_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    init_blind_review_db(db_path)
    experiment_id = _safe_code(experiment_id)
    comparison_id = _safe_code(comparison_id)
    image = _decode_image_data_url(image_data_url)
    image.thumbnail((640, 640), Image.Resampling.LANCZOS)
    directory = Path(source_dir or _SOURCE_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{experiment_id}_{comparison_id}_{secrets.token_hex(5)}.webp"
    image.save(directory / filename, "WEBP", quality=78, method=5)
    with _db(db_path) as connection:
        old = connection.execute(
            "SELECT output_path FROM review_source_images WHERE experiment_id=? AND comparison_id=?",
            (experiment_id, comparison_id),
        ).fetchone()
        connection.execute(
            """
            INSERT INTO review_source_images(experiment_id, comparison_id, output_path, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(experiment_id, comparison_id) DO UPDATE SET
              output_path=excluded.output_path, created_at=excluded.created_at
            """,
            (experiment_id, comparison_id, filename, time.time()),
        )
    if old and old["output_path"] != filename:
        try:
            (directory / old["output_path"]).unlink()
        except OSError:
            pass
    return {"experiment_id": experiment_id, "comparison_id": comparison_id, "stored": True}


def delete_review_sources(
    experiment_id: str,
    *,
    db_path: Optional[Path] = None,
    source_dir: Optional[Path] = None,
) -> int:
    init_blind_review_db(db_path)
    experiment_id = _safe_code(experiment_id)
    directory = Path(source_dir or _SOURCE_DIR)
    with _db(db_path) as connection:
        rows = connection.execute(
            "SELECT output_path FROM review_source_images WHERE experiment_id=?", (experiment_id,)
        ).fetchall()
        connection.execute("DELETE FROM review_source_images WHERE experiment_id=?", (experiment_id,))
    for row in rows:
        try:
            (directory / row["output_path"]).unlink()
        except OSError:
            pass
    return len(rows)


def import_external_generation(payload: Dict[str, Any], *, db_path: Optional[Path] = None) -> Dict[str, Any]:
    init_blind_review_db(db_path)
    experiment_id = _safe_code(payload.get("experiment_id"))
    comparison_id = _safe_code(payload.get("comparison_id"))
    variant_id = _safe_code(payload.get("variant_id"))
    image = _decode_image_data_url(str(payload.get("image") or ""))
    output = io.BytesIO()
    image.save(output, "PNG", optimize=True)
    png_b64 = base64.b64encode(output.getvalue()).decode("ascii")
    request_id = f"external-{uuid.uuid4().hex}"
    duration_ms = max(0, int(payload.get("duration_ms") or 0))
    cost = payload.get("cost_usd")
    cost_usd = None if cost in (None, "") else max(0.0, float(cost))
    model = str(payload.get("model") or "external-unknown")[:160]
    parameters = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else {}
    start_run(
        request_id,
        mode="external_import",
        style_id="brick_v1",
        source_type="external",
        experiment_id=experiment_id,
        comparison_id=comparison_id,
        variant_id=variant_id,
        metadata_source="manual_reported",
        db_path=db_path,
    )
    result = {
        "ok": True,
        "body_png": png_b64,
        "api_usage": {
            "model": model,
            "duration_ms": duration_ms,
            "cost_usd": cost_usd,
            "started_at": time.time(),
        },
    }
    record_attempt(
        request_id, phase="external_import", attempt_index=0, result=result,
        validation={"passed": True, "errors": [], "warnings": ["manual_reported_metadata"]},
        db_path=db_path,
    )
    finish_run(
        request_id, status="success", stage="external_import", height_class=None,
        duration_ms=duration_ms, cv_ms=None, vlm_ms=None, generation_ms=duration_ms,
        retry_count=0, validation={"passed": True, "errors": [], "warnings": ["manual_reported_metadata"]},
        output_png=png_b64, db_path=db_path,
    )
    with _db(db_path) as connection:
        connection.execute(
            "UPDATE generation_runs SET external_metadata=? WHERE request_id=?",
            (json.dumps({"model": model, "parameters": parameters}, ensure_ascii=False), request_id),
        )
    return get_run(request_id, db_path=db_path) or {"request_id": request_id}


def create_review_session(
    *, name: str, experiment_id: str, request_ids: Optional[Iterable[str]] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    init_blind_review_db(db_path)
    experiment_id = _safe_code(experiment_id)
    session_id = f"review-{uuid.uuid4().hex}"
    with _db(db_path) as connection:
        if request_ids:
            ids = [str(item) for item in request_ids]
            placeholders = ",".join("?" for _ in ids)
            rows = connection.execute(
                f"""SELECT request_id, comparison_id, variant_id FROM generation_runs
                    WHERE experiment_id=? AND status='success' AND output_path IS NOT NULL
                      AND request_id IN ({placeholders})""",
                (experiment_id, *ids),
            ).fetchall()
        else:
            rows = connection.execute(
                """SELECT request_id, comparison_id, variant_id FROM generation_runs
                   WHERE experiment_id=? AND status='success' AND output_path IS NOT NULL""",
                (experiment_id,),
            ).fetchall()
        valid = [row for row in rows if row["comparison_id"] and row["variant_id"]]
        if not valid:
            raise ValueError("no_reviewable_runs")
        variants = sorted({row["variant_id"] for row in valid})
        group_codes = {variant: f"G-{secrets.token_hex(3).upper()}" for variant in variants}
        connection.execute(
            "INSERT INTO blind_review_sessions(session_id,name,experiment_id,status,created_at) VALUES(?,?,?,'draft',?)",
            (session_id, str(name or experiment_id)[:160], experiment_id, time.time()),
        )
        for row in valid:
            connection.execute(
                """INSERT INTO blind_review_items
                   (session_id,request_id,comparison_id,variant_id,anonymous_code,group_code)
                   VALUES(?,?,?,?,?,?)""",
                (
                    session_id, row["request_id"], row["comparison_id"], row["variant_id"],
                    f"I-{secrets.token_hex(5).upper()}", group_codes[row["variant_id"]],
                ),
            )
    return get_review_session(session_id, db_path=db_path)


def list_review_sessions(*, db_path: Optional[Path] = None) -> list[Dict[str, Any]]:
    init_blind_review_db(db_path)
    with _db(db_path) as connection:
        rows = connection.execute(
            """SELECT s.*,
                      (SELECT COUNT(*) FROM blind_review_items i WHERE i.session_id=s.session_id) item_count,
                      (SELECT COUNT(DISTINCT reviewer_code) FROM blind_review_responses r WHERE r.session_id=s.session_id) reviewer_count
               FROM blind_review_sessions s ORDER BY s.created_at DESC"""
        ).fetchall()
    output = []
    for row in rows:
        item = dict(row)
        item["completed_reviewer_count"] = _completed_reviewer_count(
            item["session_id"], db_path=db_path
        )
        output.append(item)
    return output


def _completed_reviewer_count(session_id: str, *, db_path: Optional[Path] = None) -> int:
    with _db(db_path) as connection:
        item_total = int(connection.execute(
            "SELECT COUNT(*) FROM blind_review_items WHERE session_id=?", (session_id,)
        ).fetchone()[0])
        group_total = int(connection.execute(
            "SELECT COUNT(DISTINCT group_code) FROM blind_review_items WHERE session_id=?", (session_id,)
        ).fetchone()[0])
        if not item_total or not group_total:
            return 0
        row = connection.execute(
            """SELECT COUNT(*) FROM (
                 SELECT reviewer_code FROM blind_review_responses
                 WHERE session_id=? GROUP BY reviewer_code HAVING COUNT(*)=?
               ) item_done
               WHERE reviewer_code IN (
                 SELECT reviewer_code FROM blind_group_responses
                 WHERE session_id=? GROUP BY reviewer_code HAVING COUNT(*)=?
               )""",
            (session_id, item_total, session_id, group_total),
        ).fetchone()
    return int(row[0] if row else 0)


def get_review_session(session_id: str, *, db_path: Optional[Path] = None) -> Dict[str, Any]:
    sessions = [item for item in list_review_sessions(db_path=db_path) if item["session_id"] == session_id]
    if not sessions:
        raise KeyError(session_id)
    return sessions[0]


def set_session_status(session_id: str, status: str, *, db_path: Optional[Path] = None) -> Dict[str, Any]:
    init_blind_review_db(db_path)
    current = get_review_session(session_id, db_path=db_path)
    if status == "locked" and current["status"] != "draft":
        raise ValueError("invalid_transition")
    if status == "completed":
        if current["status"] != "locked":
            raise ValueError("invalid_transition")
        if int(current.get("completed_reviewer_count") or 0) < 5:
            raise ValueError("minimum_five_reviewers")
    if status not in {"locked", "completed"}:
        raise ValueError("invalid_status")
    field = "locked_at" if status == "locked" else "completed_at"
    with _db(db_path) as connection:
        connection.execute(
            f"UPDATE blind_review_sessions SET status=?, {field}=? WHERE session_id=?",
            (status, time.time(), session_id),
        )
    return get_review_session(session_id, db_path=db_path)


def _ordered(items: list[Dict[str, Any]], session_id: str, reviewer_code: str) -> list[Dict[str, Any]]:
    seed = int(hashlib.sha256(f"{session_id}:{reviewer_code}".encode()).hexdigest()[:16], 16)
    copied = list(items)
    random.Random(seed).shuffle(copied)
    return copied


def blind_payload(session_id: str, reviewer_code: str, *, db_path: Optional[Path] = None) -> Dict[str, Any]:
    reviewer_code = _safe_code(reviewer_code, maximum=64)
    session = get_review_session(session_id, db_path=db_path)
    if session["status"] != "locked":
        raise ValueError("session_not_open")
    with _db(db_path) as connection:
        rows = connection.execute(
            """SELECT anonymous_code,group_code,comparison_id FROM blind_review_items
               WHERE session_id=?""", (session_id,),
        ).fetchall()
        done = {row[0] for row in connection.execute(
            "SELECT request_id FROM blind_review_responses WHERE session_id=? AND reviewer_code=?",
            (session_id, reviewer_code),
        )}
        group_done = {row[0] for row in connection.execute(
            "SELECT group_code FROM blind_group_responses WHERE session_id=? AND reviewer_code=?",
            (session_id, reviewer_code),
        )}
        request_by_code = {
            row["anonymous_code"]: row["request_id"] for row in connection.execute(
                "SELECT anonymous_code,request_id FROM blind_review_items WHERE session_id=?", (session_id,)
            )
        }
    items = [
        {
            "anonymous_code": row["anonymous_code"],
            "candidate_code": row["group_code"],
            "comparison_id": row["comparison_id"],
            "source_url": f"/api/dev/blind-assets/{session_id}/{row['anonymous_code']}/source",
            "output_url": f"/api/dev/blind-assets/{session_id}/{row['anonymous_code']}/output",
            "completed": request_by_code[row["anonymous_code"]] in done,
        }
        for row in rows
    ]
    ordered = _ordered(items, session_id, reviewer_code)
    grouped: Dict[str, list[Dict[str, str]]] = {}
    for item in ordered:
        grouped.setdefault(item["candidate_code"], []).append({
            "anonymous_code": item["anonymous_code"],
            "output_url": item["output_url"],
        })
    groups = [
        {"candidate_code": code, "items": values, "completed": code in group_done}
        for code, values in grouped.items()
    ]
    groups = _ordered(groups, session_id, f"group:{reviewer_code}")
    return {"session": session, "reviewer_code": reviewer_code, "items": ordered, "groups": groups}


def resolve_blind_asset(
    session_id: str, anonymous_code: str, kind: str, *, db_path: Optional[Path] = None,
) -> tuple[Path, str]:
    init_blind_review_db(db_path)
    with _db(db_path) as connection:
        row = connection.execute(
            """SELECT i.comparison_id,r.output_path,s.experiment_id
               FROM blind_review_items i
               JOIN blind_review_sessions s ON s.session_id=i.session_id
               JOIN generation_runs r ON r.request_id=i.request_id
               WHERE i.session_id=? AND i.anonymous_code=?""",
            (session_id, anonymous_code),
        ).fetchone()
        if not row:
            raise KeyError(anonymous_code)
        if kind == "source":
            source = connection.execute(
                "SELECT output_path FROM review_source_images WHERE experiment_id=? AND comparison_id=?",
                (row["experiment_id"], row["comparison_id"]),
            ).fetchone()
            if not source:
                raise KeyError("source_missing")
            return _SOURCE_DIR, source["output_path"]
        if kind == "output" and row["output_path"]:
            return Path(__file__).resolve().parent / "logs" / "generated", row["output_path"]
    raise KeyError("asset_missing")


def save_item_response(
    session_id: str, anonymous_code: str, reviewer_code: str, payload: Dict[str, Any],
    *, db_path: Optional[Path] = None,
) -> None:
    reviewer_code = _safe_code(reviewer_code, maximum=64)
    scores = _score_payload(payload, _SCORE_FIELDS)
    session = get_review_session(session_id, db_path=db_path)
    if session["status"] != "locked":
        raise ValueError("session_not_open")
    with _db(db_path) as connection:
        item = connection.execute(
            "SELECT request_id FROM blind_review_items WHERE session_id=? AND anonymous_code=?",
            (session_id, anonymous_code),
        ).fetchone()
        if not item:
            raise KeyError(anonymous_code)
        connection.execute(
            f"""INSERT INTO blind_review_responses
              (session_id,request_id,reviewer_code,{','.join(_SCORE_FIELDS)},notes,created_at)
              VALUES (?,?,?,{','.join('?' for _ in _SCORE_FIELDS)},?,?)""",
            (
                session_id, item["request_id"], reviewer_code,
                *(scores[field] for field in _SCORE_FIELDS),
                str(payload.get("notes") or "")[:2000], time.time(),
            ),
        )


def save_group_response(
    session_id: str, group_code: str, reviewer_code: str, payload: Dict[str, Any],
    *, db_path: Optional[Path] = None,
) -> None:
    reviewer_code = _safe_code(reviewer_code, maximum=64)
    scores = _score_payload(payload, _GROUP_SCORE_FIELDS)
    session = get_review_session(session_id, db_path=db_path)
    if session["status"] != "locked":
        raise ValueError("session_not_open")
    with _db(db_path) as connection:
        exists = connection.execute(
            "SELECT 1 FROM blind_review_items WHERE session_id=? AND group_code=?", (session_id, group_code)
        ).fetchone()
        if not exists:
            raise KeyError(group_code)
        connection.execute(
            f"""INSERT INTO blind_group_responses
              (session_id,group_code,reviewer_code,{','.join(_GROUP_SCORE_FIELDS)},notes,created_at)
              VALUES (?,?,?,{','.join('?' for _ in _GROUP_SCORE_FIELDS)},?,?)""",
            (
                session_id, group_code, reviewer_code,
                *(scores[field] for field in _GROUP_SCORE_FIELDS),
                str(payload.get("notes") or "")[:2000], time.time(),
            ),
        )


def review_results(session_id: str, *, db_path: Optional[Path] = None) -> Dict[str, Any]:
    session = get_review_session(session_id, db_path=db_path)
    if session["status"] != "completed":
        raise ValueError("results_still_blind")
    with _db(db_path) as connection:
        variants = connection.execute(
            "SELECT DISTINCT variant_id,group_code FROM blind_review_items WHERE session_id=?",
            (session_id,),
        ).fetchall()
        output = []
        for variant in variants:
            operational = connection.execute(
                """SELECT COUNT(*) run_count,
                          SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) success_count,
                          AVG(r.duration_ms) avg_duration_ms,MAX(r.duration_ms) max_duration_ms,
                          COALESCE(SUM((SELECT SUM(a.cost_usd) FROM generation_attempts a WHERE a.request_id=r.request_id)),0) total_cost_usd,
                          SUM(CASE WHEN EXISTS(SELECT 1 FROM generation_attempts a WHERE a.request_id=r.request_id AND a.cost_usd IS NOT NULL) THEN 1 ELSE 0 END) cost_reported_count,
                          COALESCE(SUM((SELECT COUNT(*) FROM generation_attempts a WHERE a.request_id=r.request_id)),0) api_call_count,
                          COALESCE(SUM((SELECT SUM(a.total_tokens) FROM generation_attempts a WHERE a.request_id=r.request_id)),0) total_tokens,
                          SUM(CASE WHEN EXISTS(SELECT 1 FROM generation_attempts a WHERE a.request_id=r.request_id AND a.total_tokens IS NOT NULL) THEN 1 ELSE 0 END) token_reported_count
                   FROM generation_runs r WHERE r.experiment_id=? AND r.variant_id=?""",
                (session["experiment_id"], variant["variant_id"]),
            ).fetchone()
            duration_rows = connection.execute(
                """SELECT duration_ms FROM generation_runs
                   WHERE experiment_id=? AND variant_id=? AND duration_ms IS NOT NULL
                   ORDER BY duration_ms""",
                (session["experiment_id"], variant["variant_id"]),
            ).fetchall()
            durations = [float(row[0]) for row in duration_rows]

            def percentile(values: list[float], ratio: float) -> Optional[float]:
                if not values:
                    return None
                position = (len(values) - 1) * ratio
                lower = int(position)
                upper = min(len(values) - 1, lower + 1)
                return values[lower] + (values[upper] - values[lower]) * (position - lower)

            item_scores = connection.execute(
                f"""SELECT {','.join('AVG(resp.' + field + ') ' + field for field in _SCORE_FIELDS)}
                    FROM blind_review_responses resp
                    JOIN blind_review_items i ON i.request_id=resp.request_id AND i.session_id=resp.session_id
                    WHERE resp.session_id=? AND i.variant_id=?""",
                (session_id, variant["variant_id"]),
            ).fetchone()
            group_scores = connection.execute(
                f"""SELECT {','.join('AVG(' + field + ') ' + field for field in _GROUP_SCORE_FIELDS)}
                    FROM blind_group_responses WHERE session_id=? AND group_code=?""",
                (session_id, variant["group_code"]),
            ).fetchone()
            row = {**dict(variant), **dict(operational)}
            row["sample_count"] = int(connection.execute(
                "SELECT COUNT(*) FROM blind_review_items WHERE session_id=? AND variant_id=?",
                (session_id, variant["variant_id"]),
            ).fetchone()[0])
            row.update({key: round(value, 3) if value is not None else None for key, value in dict(item_scores).items()})
            row.update({key: round(value, 3) if value is not None else None for key, value in dict(group_scores).items()})
            row["duration_p50_ms"] = round(percentile(durations, 0.50), 1) if durations else None
            row["duration_p95_ms"] = round(percentile(durations, 0.95), 1) if durations else None
            row["success_rate"] = round(
                float(row["success_count"] or 0) / max(1, int(row["run_count"] or 0)), 4
            )
            row["api_failure_rate"] = round(1.0 - row["success_rate"], 4)
            row["effective_character_cost"] = round(
                float(row["total_cost_usd"]) / max(1, int(row["success_count"] or 0)), 6
            ) if int(row["cost_reported_count"] or 0) else None
            output.append(row)
    return {"session": session, "variants": output}


def results_csv(session_id: str, *, db_path: Optional[Path] = None) -> str:
    results = review_results(session_id, db_path=db_path)
    rows = results["variants"]
    if not rows:
        return ""
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def source_directory() -> Path:
    return _SOURCE_DIR
