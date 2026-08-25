import base64
import io
import unittest

import numpy as np
from PIL import Image, ImageDraw

from backend.garment_gen import _remove_white_background


class GarmentBackgroundTests(unittest.TestCase):
    def test_border_white_is_removed_even_when_legacy_shield_covers_it(self):
        image = Image.new("RGBA", (140, 180), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        # Reproduce an opaque white model canvas surrounded by a later-added
        # transparent margin.
        draw.rectangle((10, 10, 129, 169), fill="white")
        # A closed dark outline protects the white shirt interior naturally.
        draw.rectangle((40, 30, 100, 105), fill="white", outline="black", width=4)
        draw.rectangle((48, 105, 68, 155), fill="#224488", outline="black", width=3)
        draw.rectangle((72, 105, 92, 155), fill="#224488", outline="black", width=3)
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

        cleaned = _remove_white_background(
            encoded, shield_mask=np.ones((180, 140), dtype=bool)
        )
        result = Image.open(io.BytesIO(base64.b64decode(cleaned))).convert("RGBA")

        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(result.getpixel((result.width // 2, 45))[3], 255)


if __name__ == "__main__":
    unittest.main()
