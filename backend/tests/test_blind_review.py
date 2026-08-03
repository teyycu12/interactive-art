import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.blind_review import (
    blind_payload,
    create_review_session,
    import_external_generation,
    review_results,
    save_group_response,
    save_item_response,
    save_review_source,
    set_session_status,
)
from backend.generation_history import finish_run, save_rendered_output, start_run


def _data_url(color=(60, 110, 170)):
    image = Image.new("RGB", (180, 240), color)
    output = io.BytesIO()
    image.save(output, "PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


ITEM_SCORES = {
    "clothing_color_score": 4,
    "clothing_detail_score": 4,
    "identity_score": 3,
    "refinement_score": 5,
    "geometry_score": 5,
    "projection_score": 4,
}
GROUP_SCORES = {
    "species_score": 5,
    "face_style_score": 4,
    "lighting_score": 5,
    "body_diversity_score": 4,
    "separability_score": 4,
    "group_finish_score": 5,
}


class BlindReviewTests(unittest.TestCase):
    def test_external_import_marks_manual_metadata_and_unknown_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            with patch("backend.generation_history._OUTPUT_DIR", root / "generated"):
                item = import_external_generation({
                    "image": _data_url(),
                    "experiment_id": "exp-1",
                    "comparison_id": "P01",
                    "variant_id": "firefly",
                    "model": "Firefly manual",
                    "duration_ms": 3200,
                    "cost_usd": 0.25,
                    "parameters": {"style_strength": 80},
                }, db_path=db_path)
        self.assertEqual(item["metadata_source"], "manual_reported")
        self.assertEqual(item["variant_id"], "firefly")
        self.assertFalse(item["token_reported"])
        self.assertAlmostEqual(item["cost_usd"], 0.25)
        self.assertEqual(item["external_metadata"]["parameters"]["style_strength"], 80)

    def test_five_complete_reviewers_unlock_anonymized_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root / "history.sqlite3"
            image_b64 = _data_url().split(",", 1)[1]
            with patch("backend.generation_history._OUTPUT_DIR", root / "generated"):
                for person in ("P01", "P02"):
                    for variant in ("baseline", "style_anchor"):
                        request_id = f"{person}-{variant}"
                        start_run(
                            request_id, mode="brick_ai_texture", style_id="brick_v1",
                            source_type="upload", experiment_id="exp-1",
                            comparison_id=person, variant_id=variant, db_path=db_path,
                        )
                        save_rendered_output(request_id, image_b64, db_path=db_path)
                        finish_run(
                            request_id, status="success", stage="ai_texture", height_class="medium",
                            duration_ms=1000, cv_ms=100, vlm_ms=100, generation_ms=800,
                            retry_count=0, validation={"passed": True}, db_path=db_path,
                        )
                source_dir = root / "sources"
                for person in ("P01", "P02"):
                    save_review_source(
                        "exp-1", person, _data_url(), db_path=db_path, source_dir=source_dir,
                    )
                session = create_review_session(
                    name="ten people", experiment_id="exp-1", db_path=db_path,
                )
                set_session_status(session["session_id"], "locked", db_path=db_path)

                first = blind_payload(session["session_id"], "R1", db_path=db_path)
                self.assertNotIn("variant_id", first["items"][0])
                self.assertNotIn("cost_usd", first["items"][0])
                self.assertEqual(len(first["groups"]), 2)

                for reviewer in ("R1", "R2", "R3", "R4", "R5"):
                    payload = blind_payload(session["session_id"], reviewer, db_path=db_path)
                    for item in payload["items"]:
                        save_item_response(
                            session["session_id"], item["anonymous_code"], reviewer,
                            ITEM_SCORES, db_path=db_path,
                        )
                    for group in payload["groups"]:
                        save_group_response(
                            session["session_id"], group["candidate_code"], reviewer,
                            GROUP_SCORES, db_path=db_path,
                        )

                completed = set_session_status(
                    session["session_id"], "completed", db_path=db_path,
                )
                results = review_results(session["session_id"], db_path=db_path)

        self.assertEqual(completed["completed_reviewer_count"], 5)
        self.assertEqual({row["variant_id"] for row in results["variants"]}, {"baseline", "style_anchor"})
        self.assertTrue(all(row["species_score"] == 5 for row in results["variants"]))


if __name__ == "__main__":
    unittest.main()
