import base64
import io
import unittest

import numpy as np
from PIL import Image

from backend.avatar_quality import validate_avatar_png
from backend.style_probe import (
    REGION_BANDS,
    cast_drift,
    cast_drift_by_region,
    sprite_fingerprint,
)


CANVAS = (400, 700)  # width, height


def _sprite(
    *,
    stroke: int = 6,
    torso_rgb=(40, 100, 180),
    leg_rgb=(60, 70, 110),
    shade: float = 0.0,
    opaque_background=False,
    missing_legs=False,
    split_torso=False,
) -> str:
    """A minimal front-facing figure on a transparent canvas.

    ``stroke`` drives the printed line weight, which is the feature that
    separates toy print from thin illustration line work. ``shade`` adds a
    top-to-bottom luminance ramp, standing in for baked directional lighting.
    """
    width, height = CANVAS
    image = Image.new("RGBA", (width, height), (255, 255, 255, 255) if opaque_background else (0, 0, 0, 0))
    array = np.array(image)

    def box(x0, y0, x1, y1, rgb):
        array[y0:y1, x0:x1, :3] = rgb
        array[y0:y1, x0:x1, 3] = 255

    # Bands land inside the style_base landmark proportions. Parts overlap by a
    # few pixels so the figure is one connected component, as a real generated
    # character is -- avatar_quality rejects a fragmented foreground.
    box(150, 20, 250, 215, (240, 205, 165))           # head
    box(110, 210, 290, 425, torso_rgb)                # torso
    if split_torso:
        # Pale top half over the base colour: a garment design, not shading.
        box(110, 210, 290, 320, (245, 245, 245))
    if not missing_legs:
        box(140, 420, 195, 645, leg_rgb)              # left leg
        box(205, 420, 260, 645, leg_rgb)              # right leg
        box(135, 640, 197, 685, (235, 235, 235))      # left shoe
        box(203, 640, 265, 685, (235, 235, 235))      # right shoe

    # Printed marks: eyes on the face, a placket down the torso, a leg seam.
    def mark(cx, cy, w, h, rgb=(20, 20, 24)):
        array[cy:cy + h, cx:cx + w, :3] = rgb
        array[cy:cy + h, cx:cx + w, 3] = 255

    mark(172, 120, stroke, stroke * 2)
    mark(222, 120, stroke, stroke * 2)
    mark(180, 165, stroke * 6, stroke)
    mark(196, 250, stroke, 150)
    mark(140, 275, stroke * 4, stroke)
    if not missing_legs:
        mark(165, 450, stroke, 170)
        mark(230, 450, stroke, 170)

    if shade:
        ramp = np.linspace(1.0 + shade, 1.0 - shade, height, dtype=np.float32)[:, None, None]
        array[:, :, :3] = np.clip(array[:, :, :3].astype(np.float32) * ramp, 0, 255).astype(np.uint8)

    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class SpriteFingerprintTests(unittest.TestCase):
    def test_every_region_is_measured_on_a_complete_figure(self):
        result = sprite_fingerprint(_sprite())
        self.assertTrue(result["valid"])
        self.assertEqual(set(result["regions"]), set(REGION_BANDS))
        for name, region in result["regions"].items():
            with self.subTest(region=name):
                self.assertTrue(region["valid"], f"{name} was not measurable")

    def test_accepts_data_url_and_bare_base64_alike(self):
        payload = _sprite()
        bare = sprite_fingerprint(payload)
        data_url = sprite_fingerprint("data:image/png;base64," + payload)
        self.assertEqual(
            bare["regions"]["garment_torso"]["stroke_width_rel"],
            data_url["regions"]["garment_torso"]["stroke_width_rel"],
        )

    def test_opaque_sprite_falls_back_to_contrast_mask(self):
        # _remove_white_background can fail upstream; a white-backed sprite must
        # still be measurable rather than reporting the whole canvas as subject.
        result = sprite_fingerprint(_sprite(opaque_background=True))
        self.assertTrue(result["valid"])
        self.assertTrue(result["regions"]["garment_torso"]["valid"])

    def test_undecodable_input_fails_closed_without_raising(self):
        for bad in (None, "", "not-base64!!", b"\x00\x01\x02"):
            with self.subTest(value=repr(bad)):
                result = sprite_fingerprint(bad)
                self.assertFalse(result["valid"])
                self.assertEqual(result["regions"], {})

    def test_structural_completeness_is_enforced_before_the_probe_runs(self):
        # Bands are proportions of the silhouette's own box, so a legless figure
        # measures its torso and calls it legs -- a confident wrong number. The
        # probe cannot detect that; validation is what keeps it from happening,
        # so the two have to agree on which sprites are admissible.
        legless = _sprite(missing_legs=True)
        verdict = validate_avatar_png(legless)
        self.assertFalse(verdict["passed"])
        self.assertTrue({"missing_bottom_left", "missing_bottom_right"} & set(verdict["errors"]))

        self.assertTrue(validate_avatar_png(_sprite())["passed"])

    def test_silhouette_outline_is_kept_out_of_the_crop(self):
        # A plain torso with no print must read as almost no edges. If the crop
        # straddled the silhouette, the outline alone would dominate the number.
        plain = _sprite(stroke=1)
        edges = sprite_fingerprint(plain)["regions"]["garment_torso"]["edge_density"]
        self.assertLess(edges, 0.05)

    def test_measurement_is_deterministic(self):
        payload = _sprite()
        first = sprite_fingerprint(payload)["regions"]["face"]
        second = sprite_fingerprint(payload)["regions"]["face"]
        self.assertEqual(first, second)


class CastDriftTests(unittest.TestCase):
    def test_a_consistent_cast_reads_tighter_than_a_drifting_one(self):
        # This is the whole point of the module: if these two come out the same,
        # the metric cannot tell a unified species from a drifting one and
        # nothing downstream can be judged by it.
        consistent = [sprite_fingerprint(_sprite(stroke=s)) for s in (6, 7, 6)]
        drifting = [sprite_fingerprint(_sprite(stroke=s)) for s in (2, 8, 16)]

        tight = cast_drift(consistent, "garment_torso")
        loose = cast_drift(drifting, "garment_torso")

        self.assertTrue(tight["measurable"])
        self.assertTrue(loose["measurable"])
        self.assertLess(
            tight["features"]["stroke_width_rel"]["relative_spread"],
            loose["features"]["stroke_width_rel"]["relative_spread"],
        )

    def test_baked_shading_differences_show_up_as_gradient_spread(self):
        flat = [sprite_fingerprint(_sprite(shade=s)) for s in (0.0, 0.02, 0.0)]
        uneven = [sprite_fingerprint(_sprite(shade=s)) for s in (0.0, 0.25, 0.5)]
        self.assertLess(
            cast_drift(flat, "garment_torso")["features"]["directional_gradient"]["std"],
            cast_drift(uneven, "garment_torso")["features"]["directional_gradient"]["std"],
        )

    def test_drift_needs_at_least_two_measurable_characters(self):
        single = cast_drift([sprite_fingerprint(_sprite())], "garment_torso")
        self.assertFalse(single["measurable"])
        self.assertEqual(single["characters"], 1)

    def test_unmeasurable_sprites_are_excluded_rather_than_counted(self):
        cast = [sprite_fingerprint(_sprite()), sprite_fingerprint(None), sprite_fingerprint(_sprite(stroke=9))]
        drift = cast_drift(cast, "garment_torso")
        self.assertEqual(drift["characters"], 2)

    def test_a_region_missing_from_some_characters_only_counts_the_rest(self):
        # A crop can fail on its own (too thin a band, no dense column run)
        # without the sprite being invalid; those characters drop out of that
        # region's spread instead of contributing a fabricated number.
        cast = [sprite_fingerprint(_sprite()), sprite_fingerprint(_sprite())]
        cast[1]["regions"]["denim_leg"] = {"valid": False, "error": "region_not_measurable"}
        self.assertEqual(cast_drift(cast, "garment_torso")["characters"], 2)
        self.assertEqual(cast_drift(cast, "denim_leg")["characters"], 1)

    def test_two_tone_garment_inflates_the_torso_gradient(self):
        # A white top over dark trousers reads as a strong vertical gradient
        # even with no shading at all, because a second-order surface fits a
        # step. brick_v2_atlas used to reject two-tone panels separately and is
        # gone, so this confound is live and callers are warned about it.
        flat = sprite_fingerprint(_sprite(torso_rgb=(40, 100, 180)))
        two_tone = sprite_fingerprint(_sprite(torso_rgb=(40, 100, 180), split_torso=True))
        self.assertGreater(
            two_tone["regions"]["garment_torso"]["directional_gradient"],
            flat["regions"]["garment_torso"]["directional_gradient"],
        )

    def test_clothed_regions_carry_the_gradient_confound_warning(self):
        cast = [sprite_fingerprint(_sprite(stroke=s)) for s in (5, 9)]
        self.assertIn("directional_gradient_confound", cast_drift(cast, "garment_torso"))
        # Skin is one material, so the face gradient needs no such caveat.
        self.assertNotIn("directional_gradient_confound", cast_drift(cast, "face"))

    def test_by_region_reports_every_band(self):
        cast = [sprite_fingerprint(_sprite(stroke=s)) for s in (5, 9)]
        report = cast_drift_by_region(cast)
        self.assertEqual(set(report), set(REGION_BANDS))
        self.assertTrue(report["garment_torso"]["measurable"])


if __name__ == "__main__":
    unittest.main()
