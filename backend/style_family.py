"""Versioned visual contract for PersonaFlow's original brick species."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict


STYLE_FAMILY_SPEC: Dict[str, Any] = {
    "style_id": "brick_v1",
    "style_spec_version": 2,
    "geometry": {
        "head_body_ratio": 0.31,
        "height_scale_range": [0.85, 1.15],
        "shoulder_width_range": [0.85, 1.15],
        "torso_width_range": [0.85, 1.15],
        "torso_depth_range": [0.90, 1.10],
        "limb_thickness_range": [0.88, 1.12],
    },
    "render": {
        "output_color_space": "srgb",
        "roughness": 0.32,
        "metalness": 0.01,
        "tone_mapping": "aces",
        "tone_mapping_exposure": 1.08,
        "shadow_type": "pcf_soft",
        "shadow_softness": 0.65,
        "allow_baked_lighting": False,
    },
    "face": {
        "allowed_expressions": ["neutral", "smile"],
        "eye_style": "brick_round_v2",
        "line_width_px": [4, 18],
        "allowed_hair": ["short", "wave", "curl", "bob", "long", "ponytail", "bun", "bald"],
        "allowed_beard": ["none", "short", "full", "mustache"],
    },
    "atlas": {
        "layout": "persona_2x2_v2",
        "size": 1024,
        "panel_size": 512,
        "texture_size": 512,
        "allow_background": False,
        "allow_text": False,
        "allow_logo": False,
        "allow_baked_shadow": False,
    },
}


def get_style_family_spec() -> Dict[str, Any]:
    return deepcopy(STYLE_FAMILY_SPEC)


def clamp_style_value(name: str, value: float) -> float:
    limits = STYLE_FAMILY_SPEC["geometry"].get(f"{name}_range", [0.85, 1.15])
    return round(max(float(limits[0]), min(float(limits[1]), float(value))), 3)
