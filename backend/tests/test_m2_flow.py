import base64
import io
import time
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

import backend.app as app_module


def _avatar_png(missing_right=False):
    image = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((50, 20, 150, 125), fill=(40, 100, 180, 255))
    draw.rectangle((60, 120, 92, 185), fill=(30, 30, 30, 255))
    if not missing_right:
        draw.rectangle((108, 120, 140, 185), fill=(30, 30, 30, 255))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _photo_data_url():
    image = Image.new("RGB", (80, 120), "gray")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _cv_result():
    return {
        "ok": True,
        "upper": {"hex": "#2864B4", "rgb": [40, 100, 180]},
        "lower": {"hex": "#1E1E1E", "rgb": [30, 30, 30]},
        "arm_color": {"hex": "#2864B4", "rgb": [40, 100, 180]},
        "upper_type": "long_sleeve",
        "lower_type": "long_pants",
        "body_poly": [[0.2, 0.1], [0.8, 0.1], [0.8, 0.95], [0.2, 0.95]],
        "regions": {"face": {"x1": 0.3, "y1": 0.05, "x2": 0.7, "y2": 0.3}},
        "height_ratio": 0.86,
        "height_class": "tall",
        "capture_quality": {"score": 1.0},
    }


def _received(client, final_events=1, timeout=4.0):
    events = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        for packet in client.get_received():
            if packet["name"] == "avatar_generated":
                args = packet.get("args") or []
                events.append(args[0] if isinstance(args, list) else args)
        if sum(bool(event.get("is_final")) for event in events) >= final_events:
            return events
        time.sleep(0.02)
    return events


class M2FlowTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.socketio.test_client(app_module.app)
        self.common = [
            patch.object(app_module, "get_clothing_features", return_value=_cv_result()),
            patch.object(app_module, "get_face_features", return_value={"ok": False}),
            patch.object(app_module, "analyze_outfit", return_value={"ok": True, "outfit": {"outer": "none", "inner": "tshirt", "lower": "jeans"}}),
            patch.object(app_module, "analyze_face", return_value={"ok": True, "face": {}}),
            patch.object(app_module, "log_metric"),
            patch.object(app_module, "start_run"),
            patch.object(app_module, "record_attempt"),
            patch.object(app_module, "finish_run"),
        ]
        for mocked in self.common:
            mocked.start()

    def tearDown(self):
        self.client.disconnect()
        for mocked in reversed(self.common):
            mocked.stop()

    def _emit(self, mode, request_id):
        self.client.emit("generate_avatar", {
            "image": _photo_data_url(), "mode": mode,
            "request_id": request_id, "source_type": "upload",
        })

    def test_retired_body_sprite_is_rejected_without_generation(self):
        with patch.object(app_module, "generate_body_png") as generate:
            self._emit("body_sprite", "body-1")
            event = _received(self.client)[-1]
        self.assertFalse(event["ok"])
        self.assertEqual(event["request_id"], "body-1")
        self.assertTrue(event["is_final"])
        self.assertEqual(event["error"], "mode_retired")
        generate.assert_not_called()

    def test_removed_brick_v1_mode_maps_to_formal_ai_mode(self):
        failed_ai = {
            "ok": False, "error": "test_no_external_call",
            "validation": {"passed": False, "errors": ["test"], "warnings": []},
            "api_usage": {},
        }
        with patch.object(app_module, "generate_ai_character_textures", return_value=failed_ai), patch.object(
            app_module, "generate_full_character_png"
        ) as full_generator:
            self._emit("brick_v1", "brick-1")
            event = _received(self.client)[-1]
        full_generator.assert_not_called()
        self.assertFalse(event["ok"])
        self.assertEqual(event["character_mode"], "brick_ai_texture")
        self.assertEqual(event["style_id"], "brick_v1")
        self.assertIsNone(event["body_png"])
        self.assertIsNone(event["character_spec"])

    def test_formal_ai_texture_mode_emits_base_then_enhanced_spec(self):
        ai_result = {
            "ok": True,
            "model": "test-pro-image",
            "textures": {
                "face_decal": "data:image/webp;base64,face",
                "torso_front": "data:image/webp;base64,torso",
                "left_leg_front": "data:image/webp;base64,left",
                "right_leg_front": "data:image/webp;base64,right",
            },
            "validation": {
                "passed": True, "errors": [], "warnings": [], "detail_score": 0.91,
            },
            "api_usage": {"model": "test-pro-image"},
        }
        with patch.object(
            app_module, "generate_ai_character_textures", return_value=ai_result
        ) as texture_generator, patch.object(
            app_module, "generate_full_character_png"
        ) as full_generator:
            self._emit("brick_ai_texture", "brick-ai-1")
            events = _received(self.client)
        self.assertEqual([event["is_final"] for event in events], [False, True])
        self.assertEqual(events[-1]["character_mode"], "brick_ai_texture")
        self.assertEqual(events[-1]["garment_source"], "ai_texture")
        self.assertEqual(events[-1]["ai_texture_status"], "enhanced")
        self.assertEqual(events[-1]["character_spec"]["material_version"], 2)
        self.assertIn("face_decal", events[-1]["character_spec"]["textures"])
        texture_generator.assert_called_once()
        full_generator.assert_not_called()

    def test_formal_ai_texture_failure_is_not_a_finished_character(self):
        failed = {
            "ok": False,
            "error": "atlas_validation_failed",
            "validation": {
                "passed": False, "errors": ["face_missing_detail"], "warnings": [],
            },
            "api_usage": {"model": "test-pro-image"},
        }
        with patch.object(app_module, "generate_ai_character_textures", return_value=failed):
            self._emit("brick_ai_texture", "brick-ai-fallback")
            events = _received(self.client)
        final = events[-1]
        self.assertFalse(final["ok"])
        self.assertTrue(final["is_final"])
        self.assertFalse(final["fallback_used"])
        self.assertEqual(final["ai_texture_status"], "failed")
        self.assertIsNone(final["character_spec"])

    def test_camera_generation_requires_valid_height_station(self):
        invalid_height = {**_cv_result(), "height_class": None, "height_measurement_valid": False}
        with patch.object(app_module, "get_clothing_features", return_value=invalid_height), patch.object(
            app_module, "generate_ai_character_textures"
        ) as generate:
            self.client.emit("generate_avatar", {
                "image": _photo_data_url(), "mode": "brick_ai_texture",
                "request_id": "height-invalid", "source_type": "camera",
            })
            event = _received(self.client)[-1]
        self.assertFalse(event["ok"])
        self.assertEqual(event["error"], "height_station_not_aligned")
        self.assertIsNone(event["height_class"])
        generate.assert_not_called()

    def test_generation_progress_reports_real_milestones(self):
        with patch.object(app_module, "generate_full_character_png", return_value={"ok": True, "body_png": _avatar_png()}):
            self._emit("full_character", "progress-1")
            stages = []
            final_seen = False
            deadline = time.time() + 4
            while time.time() < deadline and ("complete" not in stages or not final_seen):
                for packet in self.client.get_received():
                    args = packet.get("args") or []
                    payload = args[0] if isinstance(args, list) and args else {}
                    if packet["name"] == "generation_progress":
                        stages.append(payload.get("stage"))
                    elif packet["name"] == "avatar_generated" and payload.get("is_final"):
                        final_seen = True
                time.sleep(0.02)
        self.assertTrue(final_seen)
        self.assertIn("received", stages)
        self.assertIn("features_ready", stages)
        self.assertIn("generating", stages)
        self.assertIn("validating", stages)
        self.assertIn("complete", stages)

    def test_full_character_success_uses_one_paid_generation(self):
        with patch.object(app_module, "generate_full_character_png", return_value={"ok": True, "body_png": _avatar_png()}) as generator:
            self._emit("full_character", "full-success")
            event = _received(self.client)[-1]
        self.assertEqual(generator.call_count, 1)
        self.assertEqual(event["retry_count"], 0)
        self.assertTrue(event["ok"])
        self.assertFalse(event["fallback_used"])
        self.assertEqual(event["character_mode"], "full_character")

    def test_full_character_failure_requests_retake_without_mode_one_fallback(self):
        invalid = {"ok": True, "body_png": _avatar_png(missing_right=True)}
        with patch.object(app_module, "generate_full_character_png", return_value=invalid) as generator:
            self._emit("full_character", "full-retake")
            event = _received(self.client)[-1]
        self.assertEqual(generator.call_count, 1)
        self.assertEqual(event["retry_count"], 0)
        self.assertFalse(event["ok"])
        self.assertFalse(event["fallback_used"])
        self.assertEqual(event["character_mode"], "full_character")
        self.assertEqual(event["error_kind"], "validation")
        self.assertIn("鞋", event["guidance"])

    def test_api_connection_failure_is_not_reported_as_bad_photo(self):
        failed = {
            "ok": False,
            "error": "APIConnectionError",
            "api_usage": {"error_code": "APIConnectionError"},
        }
        with patch.object(app_module, "generate_full_character_png", return_value=failed):
            self._emit("full_character", "full-connection-error")
            event = _received(self.client)[-1]
        self.assertFalse(event["ok"])
        self.assertEqual(event["error_kind"], "service")
        self.assertEqual(event["error"], "APIConnectionError")
        self.assertIn("不需要更換照片", event["guidance"])
        self.assertNotIn("完整性檢查", event["guidance"])

    def test_removed_refined_mode_maps_to_formal_mode(self):
        failed_ai = {
            "ok": False, "error": "test_no_external_call",
            "validation": {"passed": False, "errors": ["test"], "warnings": []},
            "api_usage": {},
        }
        with patch.object(app_module, "generate_ai_character_textures", return_value=failed_ai), patch.object(
            app_module, "generate_full_character_png"
        ) as full_generator:
            self._emit("full_character_refined", "refine-1")
            events = _received(self.client)
        self.assertEqual([event["stage"] for event in events], ["character_spec_base", "ai_texture"])
        self.assertEqual([event["is_final"] for event in events], [False, True])
        self.assertEqual({event["request_id"] for event in events}, {"refine-1"})
        self.assertEqual(events[-1]["character_mode"], "brick_ai_texture")
        full_generator.assert_not_called()

    def test_removed_refined_mode_never_calls_old_generators(self):
        failed_ai = {
            "ok": False, "error": "test_no_external_call",
            "validation": {"passed": False, "errors": ["test"], "warnings": []},
            "api_usage": {},
        }
        with patch.object(app_module, "generate_ai_character_textures", return_value=failed_ai), patch.object(
            app_module, "generate_full_character_png"
        ) as full_generator:
            self._emit("full_character_refined", "refine-fail")
            events = _received(self.client)
        self.assertEqual(len(events), 2)
        self.assertTrue(events[1]["is_final"])
        self.assertEqual(events[1]["ai_texture_status"], "failed")
        full_generator.assert_not_called()

    def test_swarm_metadata_is_preserved_by_join_and_update(self):
        character_spec = {
            "schema_version": 1, "character_id": "metadata-test",
            "style_id": "brick_v1", "textures": {"torso_front": "large-texture"},
        }
        payload = {
            "id": "metadata-test", "height_class": "short", "height_measurement_valid": True,
            "height_profile": {"id": "short", "display_scale": 99}, "style_id": "lego",
            "body_png": "complete-character", "character_mode": "history_sprite",
            "character_spec": character_spec,
        }
        self.client.emit("join_swarm", payload)
        self.client.emit("update_character", {"id": "metadata-test", "height_class": "tall"})
        stored = app_module._swarm_chars["metadata-test"]
        self.assertEqual(stored["height_class"], "tall")
        self.assertEqual(stored["height_profile"]["id"], "short")
        self.assertEqual(stored["height_profile"]["display_scale"], 0.9)
        self.assertEqual(stored["body_png"], "complete-character")
        self.assertEqual(stored["character_mode"], "history_sprite")
        self.assertEqual(stored["style_id"], "lego")
        self.assertEqual(stored["character_spec"], character_spec)
        self.client.get_received()
        self.client.emit("get_swarm", {})
        snapshots = [packet for packet in self.client.get_received() if packet["name"] == "update_positions"]
        characters = (snapshots[-1]["args"][0] if snapshots else {}).get("characters", [])
        restored = next(character for character in characters if character["id"] == "metadata-test")
        self.assertEqual(restored["body_png"], "complete-character")
        self.assertEqual(restored["character_spec"], character_spec)

    def test_swarm_rejects_character_without_measured_height(self):
        self.client.emit("join_swarm", {"id": "invalid-height", "height_class": "medium"})
        self.assertNotIn("invalid-height", app_module._swarm_chars)
        failures = [packet for packet in self.client.get_received() if packet["name"] == "swarm_join_failed"]
        self.assertTrue(failures)


if __name__ == "__main__":
    unittest.main()
