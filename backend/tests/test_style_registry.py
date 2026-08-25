import os
import unittest
from unittest.mock import patch

# Importing garment_gen registers the only supported style for this release.
import backend.garment_gen  # noqa: F401
from backend.style_registry import get_event_style_id, get_style


class StyleRegistryTests(unittest.TestCase):
    def test_lego_loads_and_unknown_style_falls_back(self):
        self.assertEqual(get_style("lego").style_id, "lego")
        self.assertEqual(get_style("future-style").style_id, "lego")
        self.assertEqual(dict(get_style("lego").model_overrides), {})
        self.assertEqual(dict(get_style("lego").generation_params), {})
        with patch.dict(os.environ, {"CHARACTER_STYLE": "future-style"}):
            self.assertEqual(get_event_style_id(), "lego")


if __name__ == "__main__":
    unittest.main()
