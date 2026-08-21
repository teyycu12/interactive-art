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

    def test_retired_modes_are_rejected_without_spending_a_generation(self):
        # body_sprite and brick_ai_texture both stitched a character from parts
        # the renderer no longer has. Old history stays readable, but a new
        # request for either must fail before any paid call.
        for mode in ("body_sprite", "brick_ai_texture"):
            with self.subTest(mode=mode):
                with patch.object(app_module, "generate_full_character_png") as generate:
                    self._emit(mode, f"retired-{mode}")
                    event = _received(self.client)[-1]
                self.assertFalse(event["ok"])
                self.assertEqual(event["request_id"], f"retired-{mode}")
                self.assertTrue(event["is_final"])
                self.assertEqual(event["error"], "mode_retired")
                generate.assert_not_called()

    def test_unknown_mode_falls_back_to_full_character(self):
        with patch.object(
            app_module, "generate_full_character_png",
            return_value={"ok": True, "body_png": _avatar_png()},
        ) as generate:
            self._emit("brick_v1", "unknown-mode")
            event = _received(self.client)[-1]
        generate.assert_called_once()
        self.assertEqual(event["character_mode"], "full_character")
        self.assertTrue(event["ok"])

    def test_measured_skin_and_hair_survive_instead_of_snapping_to_a_palette(self):
        # The VLM's skin palette has 6 entries and its hair palette 8, so
        # routing measured colour through them collapsed distinct people onto
        # the same hex. CV measures the actual pixels and now wins.
        measured = {
            "ok": True, "face_shape": "oval", "eye_shape": "almond",
            "eyebrow_style": "straight", "smile_score": 0.7,
            "lip_color": "#B4675E", "skin_tone": "#C98A5F",
            "hair_color": "#2E1B10", "eye_color": "#5B3A21",
        }
        with patch.object(app_module, "get_face_features", return_value=measured), patch.object(
            app_module, "generate_full_character_png",
            return_value={"ok": True, "body_png": _avatar_png()},
        ) as generator:
            self._emit("full_character", "skin-measured")
            _received(self.client)

        face_data = generator.call_args[0][2]
        self.assertEqual(face_data["skin_tone"], "#C98A5F")
        self.assertEqual(face_data["hair_color"], "#2E1B10")
        self.assertEqual(face_data["eye_color"], "#5B3A21")
        self.assertNotIn(face_data["skin_tone"], app_module._SKIN_HEX.values())
        self.assertEqual(face_data["color_source"]["skin_tone"], "cv_measured")

    def test_vlm_palette_is_the_fallback_when_the_face_is_not_measurable(self):
        with patch.dict(app_module.os.environ, {"FULL_MODE_VLM_ENABLED": "1"}), patch.object(
            app_module, "get_face_features", return_value={"ok": False}
        ), patch.object(
            app_module, "analyze_face",
            return_value={"ok": True, "face": {"skin_tone": "dark", "hair_color": "black"}},
        ), patch.object(
            app_module, "generate_full_character_png",
            return_value={"ok": True, "body_png": _avatar_png()},
        ) as generator:
            self._emit("full_character", "skin-fallback")
            _received(self.client)

        face_data = generator.call_args[0][2]
        self.assertEqual(face_data["skin_tone"], app_module._SKIN_HEX["dark"])
        self.assertEqual(face_data["hair_color"], app_module._HAIR_HEX["black"])
        self.assertNotIn("color_source", face_data)

    def test_camera_generation_requires_valid_height_station(self):
        invalid_height = {**_cv_result(), "height_class": None, "height_measurement_valid": False}
        with patch.object(app_module, "get_clothing_features", return_value=invalid_height), patch.object(
            app_module, "generate_full_character_png"
        ) as generate:
            self.client.emit("generate_avatar", {
                "image": _photo_data_url(), "mode": "full_character",
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

    def test_removed_refined_mode_falls_back_to_full_character(self):
        with patch.object(
            app_module, "generate_full_character_png",
            return_value={"ok": True, "body_png": _avatar_png()},
        ) as full_generator:
            self._emit("full_character_refined", "refine-1")
            events = _received(self.client)
        full_generator.assert_called_once()
        self.assertTrue(events[-1]["is_final"])
        self.assertEqual({event["request_id"] for event in events}, {"refine-1"})
        self.assertEqual(events[-1]["character_mode"], "full_character")

    def test_swarm_metadata_is_preserved_by_join_and_update(self):
        payload = {
            "id": "metadata-test", "height_class": "short", "height_measurement_valid": True,
            "height_profile": {"id": "short", "display_scale": 99}, "style_id": "lego",
            "body_png": "complete-character", "character_mode": "history_sprite",
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
        self.client.get_received()
        self.client.emit("get_swarm", {})
        snapshots = [packet for packet in self.client.get_received() if packet["name"] == "update_positions"]
        characters = (snapshots[-1]["args"][0] if snapshots else {}).get("characters", [])
        restored = next(character for character in characters if character["id"] == "metadata-test")
        self.assertEqual(restored["body_png"], "complete-character")

    def test_swarm_rejects_character_without_measured_height(self):
        self.client.emit("join_swarm", {"id": "invalid-height", "height_class": "medium"})
        self.assertNotIn("invalid-height", app_module._swarm_chars)
        failures = [packet for packet in self.client.get_received() if packet["name"] == "swarm_join_failed"]
        self.assertTrue(failures)


if __name__ == "__main__":
    unittest.main()
