import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

from backend.detail_quality import analyze_detail


class DetailQualityTests(unittest.TestCase):
    def test_crisp_pattern_scores_higher_than_blurred_flat_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            detailed = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
            draw = ImageDraw.Draw(detailed)
            draw.rounded_rectangle((90, 35, 422, 485), radius=45, fill=(36, 98, 164, 255))
            for y in range(90, 450, 24):
                draw.line((120, y, 392, y), fill=(240, 240, 240, 255), width=5)
            for x in range(140, 390, 42):
                draw.line((x, 70, x, 455), fill=(15, 30, 55, 255), width=4)
            detailed_path = root / "detailed.png"
            detailed.save(detailed_path)

            flat = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
            ImageDraw.Draw(flat).rounded_rectangle(
                (90, 35, 422, 485), radius=45, fill=(36, 98, 164, 255)
            )
            flat = flat.filter(ImageFilter.GaussianBlur(3))
            flat_path = root / "flat.png"
            flat.save(flat_path)

            detailed_metrics = analyze_detail(detailed_path)
            flat_metrics = analyze_detail(flat_path)

        self.assertGreater(detailed_metrics["detail_score"], flat_metrics["detail_score"])
        self.assertGreater(detailed_metrics["edge_density"], flat_metrics["edge_density"])
        self.assertGreater(detailed_metrics["micro_contrast"], flat_metrics["micro_contrast"])


if __name__ == "__main__":
    unittest.main()
