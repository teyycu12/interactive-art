import unittest
from unittest import mock

from backend.app import app


class BrickV2ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_v2_contract_is_publicly_inspectable(self):
        response = self.client.get("/api/styles/brick_v2")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["style_id"], "brick_v2")
        self.assertFalse(payload["uv"]["floating_decals_allowed"])

    def test_health_reports_actual_character_style_flag(self):
        with mock.patch.dict("os.environ", {"BRICK_CHARACTER_STYLE": "brick_v2"}):
            response = self.client.get("/health")
        self.assertEqual(response.get_json()["character_style"], "brick_v2")


if __name__ == "__main__":
    unittest.main()
