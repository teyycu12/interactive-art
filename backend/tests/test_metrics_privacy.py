import json
import unittest
from unittest.mock import Mock, patch

from backend.metrics_logger import log_metric


class MetricsPrivacyTests(unittest.TestCase):
    def test_only_allowlisted_anonymous_fields_are_written(self):
        logger = Mock()
        with patch("backend.metrics_logger._get_logger", return_value=logger):
            log_metric({
                "ts": 1.0,
                "mode": "body_sprite",
                "quality_score": 0.9,
                "request_id": "user-entered-value",
                "image": "data:image/png;base64,secret",
                "upper_color": "#ffffff",
                "landmarks": [{"x": 0.5}],
                "face": {"hair": "black"},
            })
        saved = json.loads(logger.info.call_args.args[0])
        self.assertEqual(saved, {"ts": 1.0, "mode": "body_sprite", "quality_score": 0.9})


if __name__ == "__main__":
    unittest.main()
