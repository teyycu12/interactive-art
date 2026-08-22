"""The generation prompt and the measured style standard must ask for the same thing.

These two drifted apart once already: the prompt demanded "flat design with
minimal/no gradients and no realistic shadows" while ``style_base`` recorded
0.21-0.24 of vertical shading and a five-step gloss ranking measured off the
reference render. The model was obeying the prompt, so every character came out
flat, and no amount of reference imagery would have fixed it while the text
pulled the other way. These tests pin the agreement rather than the wording.
"""

import unittest

from backend.garment_gen import _FULL_CHARACTER_PROMPT_TEMPLATE
from backend.style_base import get_style_base


PROMPT = _FULL_CHARACTER_PROMPT_TEMPLATE.lower()


class PromptStyleAgreementTests(unittest.TestCase):
    def test_prompt_does_not_forbid_the_shading_the_standard_measures(self):
        shading = get_style_base()["shading_budget"]["render_gradient_tb_measured"]
        self.assertGreater(
            min(shading.values()), 0.05,
            "the reference carries real vertical shading; if this ever drops to zero "
            "the flat-illustration prompt was right and these tests are wrong",
        )
        for banned in (
            "no gradients",
            "minimal/no gradients",
            "no realistic shadows",
            "no gloss",
            "no highlights",
            "flat vector illustration",
            "no 3d render",
        ):
            with self.subTest(phrase=banned):
                self.assertNotIn(banned, PROMPT)

    def test_prompt_asks_for_a_render_rather_than_a_flat_illustration(self):
        self.assertIn("product render", PROMPT)
        self.assertIn("specular highlight", PROMPT)
        self.assertIn("form shading", PROMPT)

    def test_prompt_states_the_measured_gloss_ranking_in_order(self):
        # gloss_rank is 'ordinal' confidence: the ordering transfers, the
        # absolute roughness values do not, so the prompt names the order.
        materials = get_style_base()["materials"]
        ranked = sorted(materials, key=lambda name: materials[name]["gloss_rank"])
        self.assertEqual(ranked, ["hair", "garment_print", "skin", "rubber", "denim"])

        gloss_section = PROMPT.split("**gloss order**", 1)[1].split("- **print", 1)[0]
        positions = [
            gloss_section.index(word)
            for word in ("hair", "garment", "skin", "rubber", "denim")
        ]
        self.assertEqual(
            positions, sorted(positions),
            "the prompt lists the materials in a different order than style_base ranks them",
        )

    def test_prompt_keeps_the_frontal_key_light_the_reference_was_lit_with(self):
        render = get_style_base()["render"]
        self.assertEqual(render["dominant_gradient_axis"], "top_to_bottom")
        self.assertEqual(render["lateral_gradient"], "near_zero")
        self.assertIn("top to bottom", PROMPT)
        self.assertIn("no side light", PROMPT)
        self.assertIn("no rim light", PROMPT)

    def test_figure_is_shaded_but_the_background_stays_cuttable(self):
        # _remove_white_background strips the background, so a shadow thrown
        # onto it survives as a grey blob and breaks the cutout. The prompt has
        # to separate "shade the figure" from "shade the background".
        self.assertIn("cast onto the background", PROMPT)
        self.assertIn("shading on the figure itself is required", PROMPT)

    def test_print_is_kept_flat_so_it_does_not_double_the_lighting(self):
        self.assertIn("carry no light direction of their own", PROMPT)


if __name__ == "__main__":
    unittest.main()
