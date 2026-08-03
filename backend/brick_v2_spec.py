"""Executable visual contract for the PersonaFlow brick_v2 species.

This module contains no image-generation or renderer code.  It is the shared
contract that Blender/GLB assets, AI print generation, validators and Three.js
must satisfy before brick_v2 becomes the public production style.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict


BRICK_V2_SPEC: Dict[str, Any] = {
    "style_id": "brick_v2",
    "style_spec_version": 3,
    "design_target": "rounded_premium_brick_toy",
    "silhouette": {
        "overall_height": 5.45,
        "head": {
            "width": 1.58,
            "height": 1.15,
            "depth": 1.48,
            "corner_radius": 0.16,
        },
        "torso": {
            "top_width": 1.84,
            "bottom_width": 1.62,
            "height": 1.54,
            "depth": 0.78,
            "corner_radius": 0.10,
        },
        "arm": {
            "length": 1.30,
            "shoulder_width": 0.48,
            "wrist_width": 0.34,
            "depth": 0.50,
            "outward_angle_deg": 10,
        },
        "hand": {
            "type": "c_claw",
            "outer_radius": 0.34,
            "inner_radius": 0.18,
            "opening_deg": 86,
            "depth": 0.28,
        },
        "leg": {
            "width": 0.72,
            "height": 1.38,
            "depth": 0.72,
            "gap": 0.10,
            "corner_radius": 0.07,
        },
        "shoe": {
            "width": 0.78,
            "height": 0.42,
            "depth": 1.02,
            "toe_radius": 0.12,
            "sole_height": 0.09,
        },
        "connectors": {
            "neck_overlap": 0.06,
            "shoulder_overlap": 0.18,
            "hip_overlap": 0.08,
            "wrist_overlap": 0.07,
            "visible_body_gap_max": 0.02,
        },
    },
    "variation": {
        "height_scale_range": [0.90, 1.10],
        "shoulder_width_range": [0.92, 1.08],
        "torso_width_range": [0.90, 1.10],
        "torso_depth_range": [0.94, 1.08],
        "limb_thickness_range": [0.94, 1.08],
        "rule": "scale_canonical_parts_only",
    },
    "uv": {
        "floating_decals_allowed": False,
        "face": {
            "layout": "conformal_curved_front_surface",
            "size": [512, 512],
            "front_safe_area": [0.10, 0.10, 0.90, 0.90],
            "alpha": "ink_only",
        },
        "torso_front": {
            "layout": "trapezoid_front_surface",
            "size": [512, 512],
            "edge_to_edge_base_color": True,
            "garment_silhouette_allowed": False,
        },
        "left_leg_front": {
            "layout": "rounded_leg_front_surface",
            "size": [256, 512],
            "edge_to_edge_base_color": True,
        },
        "right_leg_front": {
            "layout": "rounded_leg_front_surface",
            "size": [256, 512],
            "edge_to_edge_base_color": True,
        },
        "shoe_front": {
            "layout": "rounded_shoe_upper_surface",
            "size": [256, 256],
            "optional": True,
        },
    },
    "hair_system": {
        "strategy": "selectable",
        "allowed_strategies": [
            "modular_parametric_3d",
            "ai_layered_hair_cards",
            "per_person_image_to_3d",
        ],
        "selected_strategy": "modular_parametric_3d",
        "modules": [
            "cap",
            "part_line",
            "front_fringe",
            "left_side_lock",
            "right_side_lock",
            "back_length",
            "bun",
            "ponytail",
        ],
        "parameters": [
            "part_position",
            "wave_amount",
            "curl_amount",
            "side_length",
            "back_length",
            "volume",
            "color",
        ],
    },
    "garment_geometry": {
        "grammar_version": 1,
        "sleeve_profiles": ["sleeveless", "short", "long"],
        "outer_shells": ["none", "vest", "jacket", "hoodie", "long_coat"],
        "lower_shells": ["trousers", "shorts", "skirt", "dress_skirt"],
        "legwear": ["covered", "bare", "tights", "leggings"],
        "fit_profiles": ["slim", "regular", "relaxed"],
        "attachments": ["hood", "coat_tail", "skirt_shell"],
        "rule": "finite_deterministic_parts_not_generated_silhouette",
    },
    "material": {
        "workflow": "pbr_plastic_plus_flat_print",
        "base_roughness": 0.30,
        "base_metalness": 0.01,
        "clearcoat": 0.42,
        "print_roughness": 0.36,
        "allow_baked_light": False,
        "allow_baked_shadow": False,
    },
    "render": {
        "camera": "front_studio_35mm",
        "background": "soft_white_or_transparent",
        "tone_mapping": "aces",
        "tone_mapping_exposure": 1.0,
        "key_light": "large_softbox_upper_left",
        "fill_light": "soft_front",
        "rim_light": "subtle_cool",
        "ground_shadow": "soft_contact_only",
    },
    "admission": {
        "requires_all_core_meshes": True,
        "requires_valid_uv": True,
        "requires_ai_print_status": "enhanced",
        "reject_on_render_failure": True,
        "fallback_character_allowed": False,
    },
}


def get_brick_v2_spec() -> Dict[str, Any]:
    return deepcopy(BRICK_V2_SPEC)


def clamp_brick_v2_variation(name: str, value: float) -> float:
    limits = BRICK_V2_SPEC["variation"].get(f"{name}_range")
    if not limits:
        raise KeyError(name)
    return round(max(float(limits[0]), min(float(limits[1]), float(value))), 3)
