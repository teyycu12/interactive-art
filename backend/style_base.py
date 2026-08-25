"""Measured base style standard for the PersonaFlow brick species.

Every number here was measured from ``docs/style_reference/base_character.png``
rather than chosen by eye.  The reference render is 303x563 px of subject on a
near-white background, so all positions are relative to that subject box and
survive any later re-render at a different resolution.

The standard describes the *style language* only: material response, print
weight, detail density, palette discipline and where shading is allowed to come
from.  Per-person variation (height, build, outfit, hair) is carried in the
generation prompt and does not change anything in this module.

The reference is a render, and ``full_character`` generation now produces the
final image directly rather than textures for a separate renderer.  So the
measured shading values here are a *target* for the generated sprite, not a
budget it must stay under.

Confidence markers on measurements:

``measured``   directly readable from the reference.
``occluded``   the reference hides part of the feature; treated as a lower bound
               and NOT authoritative.
``ordinal``    the reference fixes the ordering reliably, but the absolute value
               still needs a render-side calibration pass.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict


STYLE_BASE_VERSION = 1

REFERENCE_IMAGE = "docs/style_reference/base_character.png"


STYLE_BASE: Dict[str, Any] = {
    "style_base_version": STYLE_BASE_VERSION,
    "reference": {
        "image": REFERENCE_IMAGE,
        "subject_width_px": 303,
        "subject_height_px": 563,
        "background_hex": "#FEFEFD",
        "note": "single-outfit reference; garment colours are examples, not constraints",
    },

    # ------------------------------------------------------------------
    # Vertical landmarks, as a fraction of total subject height.
    # ------------------------------------------------------------------
    "landmarks_y": {
        "hair_top": {"value": 0.000, "confidence": "measured"},
        "head_top": {"value": 0.096, "confidence": "occluded", "note": "fringe covers the crown"},
        "collar": {"value": 0.327, "confidence": "measured"},
        "waist": {"value": 0.614, "confidence": "measured", "note": "jersey hem / denim start"},
        "inseam": {"value": 0.765, "confidence": "measured"},
        "leg_split_visible": {"value": 0.770, "confidence": "measured"},
        "shoe_top": {"value": 0.925, "confidence": "measured"},
        "sole": {"value": 0.982, "confidence": "measured"},
    },

    # ------------------------------------------------------------------
    # Widths, as a fraction of total subject width.
    # ------------------------------------------------------------------
    "widths": {
        "head": {"value": 0.320, "confidence": "occluded", "note": "hair overhangs both sides"},
        "hair_max": {"value": 0.578, "confidence": "measured"},
        "torso_no_arms": {"value": 0.591, "confidence": "measured"},
        "arm_span": {"value": 0.868, "confidence": "measured"},
        "arm_span_with_hands": {"value": 0.993, "confidence": "measured"},
        "leg_single": {"value": 0.287, "confidence": "measured"},
        "leg_gap": {"value": 0.020, "confidence": "measured"},
        "shoe_pair_span": {"value": 0.680, "confidence": "measured"},
    },

    "derived_ratios": {
        "torso_height_over_total": 0.287,
        "leg_block_height_over_total": 0.311,
        "shoe_height_over_total": 0.075,
        "leg_pair_width_over_torso_width": 0.971,
        "arm_span_over_torso_width": 1.469,
        "shoe_span_over_leg_pair_span": 1.156,
        "head_aspect_w_over_h": {"value": 0.758, "confidence": "occluded"},
    },

    # ------------------------------------------------------------------
    # Palette. Saturation is the OpenCV HSV S channel (0-255).
    # ------------------------------------------------------------------
    "palette": {
        "background": {"hex": "#FEFEFD", "saturation": 2},
        "skin_plastic": {"hex": "#DFAB30", "saturation": 202, "L_median": 186},
        "hair_plastic": {"hex": "#2C2A26", "saturation": 30, "L_median": 43,
                         "note": "warm dark grey, never pure black"},
        "garment_dark_example": {"hex": "#122B1E", "saturation": 148, "L_median": 39},
        "denim_example": {"hex": "#7F8283", "saturation": 9, "L_median": 138},
        "rubber_example": {"hex": "#DEDBD6", "saturation": 10, "L_median": 223},
    },

    # ------------------------------------------------------------------
    # Per-material response. ``highlight_compactness`` is the measured
    # highlight area divided by its own bounding box: a low value means a thin
    # sharp specular streak (glossy), a high value means a broad soft falloff
    # (diffuse).  It is recorded as an observation only -- it also picks up the
    # shape of the part itself, so hair at 0.068 and rubber at 0.063 are a tie
    # rather than an ordering.  ``gloss_rank`` follows the ``roughness``
    # judgement instead.  A single global roughness cannot reproduce this
    # spread, which is the largest visual gap between the current render and
    # the reference.
    # ------------------------------------------------------------------
    "materials": {
        "hair": {
            "highlight_compactness": 0.068,
            "highlight_area_share": 0.108,
            "highfreq_std": 22.7,
            "roughness": {"value": 0.18, "confidence": "ordinal"},
            "gloss_rank": 1,
        },
        "skin": {
            "highlight_compactness": 0.133,
            "highlight_area_share": 0.110,
            "highfreq_std": 14.2,
            "roughness": {"value": 0.34, "confidence": "ordinal"},
            "gloss_rank": 3,
        },
        "garment_print": {
            "highlight_compactness": 0.026,
            "highlight_area_share": 0.034,
            "highfreq_std": 19.1,
            "roughness": {"value": 0.22, "confidence": "ordinal"},
            "gloss_rank": 2,
        },
        "denim": {
            "highlight_compactness": 0.075,
            "highlight_area_share": 0.055,
            "highfreq_std": 12.9,
            "roughness": {"value": 0.52, "confidence": "ordinal"},
            "gloss_rank": 5,
        },
        "rubber": {
            "highlight_compactness": 0.063,
            "highlight_area_share": 0.107,
            "highfreq_std": 9.7,
            "roughness": {"value": 0.38, "confidence": "ordinal"},
            "gloss_rank": 4,
        },
    },

    # ------------------------------------------------------------------
    # Print language.  Stroke widths are relative to the width of the surface
    # the print sits on, so they hold at any UV resolution.
    # ------------------------------------------------------------------
    "print": {
        "face_ink_share": 0.136,
        "render_edge_density": {
            "face": 0.063,
            "garment_torso": 0.037,
            "denim_leg": 0.101,
            "shoe": 0.116,
            "note": "measured on the render with an absolute ink threshold; kept "
                    "as documentation only, superseded for gating by "
                    "fingerprint_targets below",
        },
        "rule": "print carries seams, hems, trim, text, logos and wear; never a garment outline",
    },

    # ------------------------------------------------------------------
    # Targets produced by ``style_fingerprint.panel_fingerprint`` itself, so a
    # candidate panel and the reference are measured by the same code.  An
    # earlier hand-rolled measurement of the same features was not comparable
    # with the fingerprint output and produced bands nothing could satisfy.
    #
    # ``directional_gradient`` is deliberately absent: the reference values are
    # the render's own shading (0.10-0.20) and a texture is held to
    # ``shading_budget`` instead.
    # ------------------------------------------------------------------
    "fingerprint_targets": {
        "measured_with": "style_fingerprint_v1",
        "measured_at_px": 256,
        "face": {
            "stroke_width_rel": 0.050,
            "mark_share": 0.154,
            "edge_density": 0.036,
            "local_contrast": 14.1,
            "saturation_median": 201.0,
        },
        "garment_torso": {
            "stroke_width_rel": 0.058,
            "mark_share": 0.329,
            "edge_density": 0.030,
            "local_contrast": 15.4,
            "saturation_median": 130.0,
        },
        "denim_leg": {
            "stroke_width_rel": 0.031,
            "mark_share": 0.108,
            "edge_density": 0.009,
            "local_contrast": 4.2,
            "saturation_median": 11.0,
        },
        "shoe": {
            "stroke_width_rel": 0.070,
            "mark_share": 0.080,
            "edge_density": 0.005,
            "local_contrast": 3.6,
            "saturation_median": 13.0,
        },
    },

    # ------------------------------------------------------------------
    # The distinction the previous validator could not make.
    # ------------------------------------------------------------------
    "shading_taxonomy": {
        "allowed_in_texture": [
            "fabric_weave",
            "denim_fade",
            "wear_and_distressing",
            "seam_and_stitch_lines",
            "print_ink_edges",
            "material_soiling",
        ],
        "forbidden_in_texture": [
            "directional_key_light",
            "ambient_occlusion",
            "cast_shadow",
            "bevel_shading",
            "rim_light",
            "vignette",
            "garment_silhouette",
            "background_outside_garment",
        ],
        "discriminator": "weathering has no consistent light direction across the panel",
    },

    # ------------------------------------------------------------------
    # Shading budget.  The reference render itself carries a large top-to-bottom
    # luminance gradient; anything the texture adds lands on top of it.  The
    # texture budget is therefore far tighter than the render's own value.
    # ------------------------------------------------------------------
    "shading_budget": {
        "render_gradient_tb_measured": {
            "skin": 0.212,
            "denim": 0.241,
            "garment": 0.077,
            "shoe": 0.196,
        },
        "render_gradient_lr_measured": {
            "skin": 0.007,
            "denim": 0.014,
            "garment": 0.011,
            "shoe": 0.031,
        },
        "texture_directional_gradient_max": 0.06,
        "note": (
            "the render supplies 0.08-0.24 of vertical shading; a texture that "
            "also carries 0.19 doubles it, which is why the old 0.17/0.20 "
            "texture threshold still let obvious double-shading through"
        ),
    },

    "render": {
        "background": "#FEFEFD",
        "key_light": "large_softbox_upper_front",
        "dominant_gradient_axis": "top_to_bottom",
        "lateral_gradient": "near_zero",
        "ground_shadow": "soft_contact_only",
        "note": "lateral gradient measured at 0.007-0.031; the key light is essentially frontal",
    },
}


def get_style_base() -> Dict[str, Any]:
    return deepcopy(STYLE_BASE)


def material_roughness(name: str) -> float:
    """Roughness for one material class, or the skin default."""
    material = STYLE_BASE["materials"].get(name)
    if not material:
        return float(STYLE_BASE["materials"]["skin"]["roughness"]["value"])
    return float(material["roughness"]["value"])


def texture_gradient_budget() -> float:
    """Maximum directional luminance gradient allowed inside a UV panel."""
    return float(STYLE_BASE["shading_budget"]["texture_directional_gradient_max"])


def fingerprint_targets(region: str) -> Dict[str, float]:
    """Reference fingerprint for one region, empty if the region is unknown."""
    return deepcopy(STYLE_BASE["fingerprint_targets"].get(region, {}))


def face_stroke_width_px(panel_width_px: int) -> int:
    """Reference face print stroke width for a panel of the given width."""
    target = STYLE_BASE["fingerprint_targets"]["face"]["stroke_width_rel"]
    return int(round(float(target) * panel_width_px))
