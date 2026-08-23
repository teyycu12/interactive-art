import tempfile
import unittest
import base64
import io
from pathlib import Path
from unittest.mock import patch
from PIL import Image, ImageDraw

from backend.generation_history import (
    backfill_style_fingerprints,
    finish_run,
    get_cast_drift,
    get_detail_benchmark,
    get_run,
    get_summary,
    list_runs,
    mark_render_failure,
    record_attempt,
    save_input_photo,
    save_rendered_output,
    save_review,
    start_run,
)
from backend.tests.test_style_probe import _sprite


class GenerationHistoryTests(unittest.TestCase):
    def test_frontend_render_failure_invalidates_ai_success(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "history.sqlite3"
            start_run(
                "render-fail-1", mode="brick_ai_texture", style_id="brick_v1",
                source_type="upload", db_path=db_path,
            )
            finish_run(
                "render-fail-1", status="success", stage="ai_texture",
                height_class="medium", duration_ms=1000, cv_ms=100,
                vlm_ms=100, generation_ms=800, retry_count=0,
                validation={"passed": True, "errors": [], "warnings": []},
                db_path=db_path,
            )
            mark_render_failure(
                "render-fail-1", error_code="ai_texture_load_failed", db_path=db_path,
            )
            run = get_run("render-fail-1", db_path=db_path)

        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["stage"], "frontend_3d_render")
        self.assertEqual(run["error_code"], "ai_texture_load_failed")
        self.assertIsNone(run["output_path"])

    def test_input_photo_is_saved_and_exposed_on_the_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            photo = Image.new("RGB", (600, 800), (10, 120, 200))
            buffer = io.BytesIO()
            photo.save(buffer, "PNG")
            data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

            with patch("backend.generation_history._INPUT_DIR", root / "inputs"):
                start_run(
                    "with-input-1", mode="full_character", style_id="lego",
                    source_type="upload", db_path=db_path,
                )
                filename = save_input_photo("with-input-1", data_url, db_path=db_path)
                run = get_run("with-input-1", db_path=db_path)
                self.assertTrue((root / "inputs" / filename).is_file())

        self.assertEqual(run["input_path"], filename)

    def test_input_photo_saving_can_be_disabled_via_env_var(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            photo = Image.new("RGB", (100, 100), (10, 120, 200))
            buffer = io.BytesIO()
            photo.save(buffer, "PNG")
            data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

            with patch("backend.generation_history._INPUT_DIR", root / "inputs"):
                start_run(
                    "disabled-input-1", mode="full_character", style_id="lego",
                    source_type="upload", db_path=db_path,
                )
                with patch.dict("os.environ", {"DEV_HISTORY_SAVE_INPUTS": "0"}):
                    self.assertIsNone(save_input_photo("disabled-input-1", data_url, db_path=db_path))
                self.assertFalse((root / "inputs").exists())

    def test_history_surfaces_the_model_from_the_successful_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "history.sqlite3"
            start_run(
                "model-visible-1", mode="full_character", style_id="lego",
                source_type="upload", db_path=db_path,
            )
            record_attempt(
                "model-visible-1", phase="full_character", attempt_index=0,
                result={"ok": False, "error": "RateLimitError", "api_usage": {"model": "primary-model"}},
                db_path=db_path,
            )
            record_attempt(
                "model-visible-1", phase="full_character", attempt_index=1,
                result={"ok": True, "api_usage": {"model": "fallback-model"}},
                db_path=db_path,
            )
            run = list_runs(db_path=db_path)[0]

        # The retry that actually produced the character matters more than
        # whichever attempt happened to run last.
        self.assertEqual(run["model"], "fallback-model")

    def test_same_photo_runs_are_paired_for_detail_parity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            image = Image.new("RGBA", (300, 420), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((50, 20, 250, 400), fill=(35, 95, 170, 255))
            for y in range(60, 380, 22):
                draw.line((70, y, 230, y), fill="white", width=4)
            output = io.BytesIO()
            image.save(output, "PNG")
            png_b64 = base64.b64encode(output.getvalue()).decode("ascii")

            with patch("backend.generation_history._OUTPUT_DIR", root / "generated"):
                for request_id, mode in (
                    ("formal-pair", "brick_ai_texture"),
                    ("full-pair", "full_character"),
                ):
                    start_run(
                        request_id, mode=mode, style_id="brick_v1",
                        source_type="upload", comparison_id="same-photo",
                        db_path=db_path,
                    )
                    save_rendered_output(request_id, png_b64, db_path=db_path)
                benchmark = get_detail_benchmark(db_path=db_path)

        self.assertEqual(benchmark["paired_sample_count"], 1)
        self.assertEqual(benchmark["paired_detail_ratio_median"], 1.0)
        self.assertFalse(benchmark["target_met"])
        self.assertEqual(benchmark["minimum_paired_samples"], 5)

    def test_recorded_attempts_carry_a_style_fingerprint_for_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            with patch("backend.generation_history._OUTPUT_DIR", root / "generated"):
                for index, stroke in enumerate((5, 9, 14)):
                    request_id = f"drift-{index}"
                    start_run(
                        request_id, mode="full_character", style_id="lego",
                        source_type="upload", experiment_id="drift-exp", db_path=db_path,
                    )
                    record_attempt(
                        request_id, phase="full_character", attempt_index=0,
                        result={"ok": True, "body_png": _sprite(stroke=stroke), "api_usage": {}},
                        validation={"passed": True, "errors": [], "warnings": []},
                        db_path=db_path,
                    )
                drift = get_cast_drift(experiment_id="drift-exp", db_path=db_path)

        self.assertEqual(drift["characters"], 3)
        torso = drift["regions"]["garment_torso"]
        self.assertTrue(torso["measurable"])
        self.assertGreater(torso["features"]["stroke_width_rel"]["relative_spread"], 0)

    def test_backfill_measures_old_attempts_once_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            with patch("backend.generation_history._OUTPUT_DIR", root / "generated"):
                start_run(
                    "backfill-1", mode="full_character", style_id="lego",
                    source_type="upload", db_path=db_path,
                )
                # Simulate a row written before the column existed.
                with patch(
                    "backend.generation_history._style_fingerprint_for_output",
                    return_value=None,
                ):
                    record_attempt(
                        "backfill-1", phase="full_character", attempt_index=0,
                        result={"ok": True, "body_png": _sprite(), "api_usage": {}},
                        validation={"passed": True, "errors": [], "warnings": []},
                        db_path=db_path,
                    )
                self.assertEqual(get_cast_drift(db_path=db_path)["characters"], 0)
                first = backfill_style_fingerprints(db_path=db_path)
                second = backfill_style_fingerprints(db_path=db_path)
                measured = get_cast_drift(db_path=db_path)["characters"]

        self.assertEqual(first, 1)
        self.assertEqual(second, 0, "backfill must not re-measure rows it already filled")
        self.assertEqual(measured, 1)

    def test_browser_composite_replaces_final_output_without_adding_api_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nmock").decode("ascii")
            start_run(
                "composite-1", mode="body_sprite", style_id="lego",
                source_type="upload", db_path=db_path,
            )
            with patch("backend.generation_history._OUTPUT_DIR", root / "generated"):
                output_path = save_rendered_output(
                    "composite-1", png_b64, db_path=db_path,
                )
            run = get_run("composite-1", db_path=db_path)

        self.assertEqual(output_path, "composite-1_frontend_final.png")
        self.assertEqual(run["output_path"], output_path)
        self.assertEqual(run["api_call_count"], 0)

    def test_run_attempt_tokens_and_provider_cost_are_aggregated(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "history.sqlite3"
            start_run(
                "history-1", mode="full_character_refined",
                style_id="lego", source_type="upload", db_path=db_path,
            )
            record_attempt(
                "history-1", phase="refined_base", attempt_index=0,
                result={
                    "ok": True,
                    "api_usage": {
                        "model": "flash-image", "provider_request_id": "gen-a",
                        "duration_ms": 1200, "prompt_tokens": 100,
                        "completion_tokens": 200, "total_tokens": 300,
                        "image_tokens": 180, "cached_tokens": 0,
                        "cost_usd": 0.08, "upstream_cost_usd": 0.07,
                    },
                },
                validation={"passed": True, "errors": [], "warnings": []},
                db_path=db_path,
            )
            record_attempt(
                "history-1", phase="refine", attempt_index=0,
                result={
                    "ok": True,
                    "api_usage": {
                        "model": "pro-image", "provider_request_id": "gen-b",
                        "duration_ms": 2200, "prompt_tokens": 150,
                        "completion_tokens": 250, "total_tokens": 400,
                        "image_tokens": 230, "cached_tokens": 10,
                        "cost_usd": 0.20, "upstream_cost_usd": 0.18,
                    },
                },
                validation={"passed": True, "errors": [], "warnings": ["lower_color_drift"]},
                db_path=db_path,
            )
            finish_run(
                "history-1", status="success", stage="refined",
                height_class="medium", duration_ms=4000, cv_ms=400,
                vlm_ms=0, generation_ms=3500, retry_count=0,
                validation={"passed": True, "errors": [], "warnings": []},
                height_ratio=0.80, height_measurement_valid=True,
                db_path=db_path,
            )
            save_review(
                "history-1", verdict="pass", completeness_score=5,
                clothing_match_score=4, face_match_score=3,
                overall_score=4, notes="good result", db_path=db_path,
            )

            run = get_run("history-1", db_path=db_path)
            summary = get_summary(db_path=db_path)

        self.assertEqual(run["source_type"], "upload")
        self.assertEqual(run["api_call_count"], 2)
        self.assertEqual(run["total_tokens"], 700)
        self.assertAlmostEqual(run["cost_usd"], 0.28)
        self.assertEqual(run["height_class"], "medium")
        self.assertAlmostEqual(run["height_ratio"], 0.80)
        self.assertTrue(run["height_measurement_valid"])
        self.assertEqual(len(run["attempts"]), 2)
        self.assertEqual(run["review"]["verdict"], "pass")
        self.assertEqual(run["review"]["overall_score"], 4)
        self.assertEqual(summary["run_count"], 1)
        self.assertEqual(summary["api_call_count"], 2)
        self.assertAlmostEqual(summary["cost_usd"], 0.28)
        self.assertEqual(summary["success_rate"], 1.0)
        self.assertEqual(summary["reviewed_count"], 1)
        self.assertEqual(summary["review_pass_count"], 1)


if __name__ == "__main__":
    unittest.main()
