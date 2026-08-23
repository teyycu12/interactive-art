"""The prompt must not forbid clothes the visitor is actually wearing.

The design rules used to mandate a two-piece body three separate times: two
rectangular legs "in the matching pants color", a torso garment "clean and
uniform in color", and a shoe seam separating the shoe "from the pants". A
visitor in a dress or a layered suit could not be represented, and no reference
image could rescue it -- the curated set already carried a one-piece dress and an
open jacket over a shirt, sent on every single call, and the output still came
back as trousers. Text beat pictures, silently, with no error anywhere.

These tests pin the topology the rules must keep allowing. They are deliberately
about what the prompt permits rather than how it is worded, because the wording
will keep moving.
"""

import unittest

from backend.garment_gen import (
    _FULL_CHARACTER_PROMPT_TEMPLATE,
    _ROLE_POSE,
    _ROLE_STYLE,
    _STYLE_SHEET_FIREWALL,
)


PROMPT = _FULL_CHARACTER_PROMPT_TEMPLATE.lower()


class LowerBodyTests(unittest.TestCase):
    def test_one_piece_garments_are_named_as_a_supported_case(self):
        for garment in ("dress", "skirt", "robe"):
            with self.subTest(garment=garment):
                self.assertIn(garment, PROMPT)

    def test_a_one_piece_garment_is_described_as_unbroken(self):
        self.assertIn("one continuous moulded piece", PROMPT)
        self.assertIn("no vertical split", PROMPT)

    def test_bare_legs_below_a_hem_use_the_persons_own_skin(self):
        self.assertIn("below that hem in the person's own skin tone", PROMPT)

    def test_trousers_are_conditional_rather_than_mandatory(self):
        # The regression: an unconditional "two legs in the matching pants
        # colour" makes a dress unrepresentable.
        self.assertIn("follow what the person actually wears", PROMPT)
        self.assertNotIn("**legs & pants**", PROMPT)

    def test_the_leg_gap_is_tied_to_what_the_lower_body_is_wearing(self):
        self.assertIn("when the lower body is trousered or bare", PROMPT)


class TorsoLayeringTests(unittest.TestCase):
    def test_the_torso_may_carry_more_than_one_garment(self):
        self.assertIn("several pieces at once", PROMPT)

    def test_uniform_colour_is_scoped_to_one_piece_not_the_whole_torso(self):
        # "the torso garment is clean and uniform in color" read as a ban on a
        # jacket differing from the shirt under it.
        self.assertIn("each individual garment piece is one clean uniform colour", PROMPT)

    def test_layers_overlap_with_depth_rather_than_reading_as_a_print(self):
        self.assertIn("overlap each other with real visible thickness", PROMPT)


class ShoeSeamTests(unittest.TestCase):
    def test_the_shoe_seam_no_longer_assumes_trousers_above_it(self):
        self.assertIn("separating the shoe from the leg or trouser above it", PROMPT)


class ReferenceAuthorityTests(unittest.TestCase):
    def test_the_pose_reference_does_not_claim_authority_over_the_lower_body(self):
        # It is drawn in trousers; taken literally it forces every visitor into
        # trousers, which is the same failure as the old rule 4.
        self.assertIn("follows the source person's garment", _ROLE_POSE)

    def test_the_style_sheet_wins_on_construction_and_finish(self):
        role = _ROLE_STYLE.lower()
        self.assertIn("follow the sheet", role)
        for subject in ("surface", "material", "finish", "garment construction"):
            with self.subTest(subject=subject):
                self.assertIn(subject, role)

    def test_the_style_sheet_does_not_win_on_pose_or_on_what_is_worn(self):
        # Priority has to stop somewhere, or the sheet starts dictating content.
        self.assertIn(
            "pose, body-part count and which garments the figure wears are not the "
            "sheet's to decide",
            _ROLE_STYLE.lower(),
        )

    def test_the_firewall_still_blocks_the_sheets_own_garments(self):
        firewall = _STYLE_SHEET_FIREWALL.lower()
        self.assertIn("never the specific garment a sheet character happens to wear", firewall)
        self.assertIn("comes only from the source person", firewall)


if __name__ == "__main__":
    unittest.main()
