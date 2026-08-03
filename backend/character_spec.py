"""Deterministic PersonaFlow brick-character specification and UV textures.

This module deliberately contains no generative-model calls.  It converts the
existing pose-masked colour grids into small, repeatable WebP textures and a
versioned CharacterSpec that both preview and projection clients can consume.
"""

from __future__ import annotations

import base64
import io
import os
import uuid
from typing import Any, Dict, Iterable, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

try:
    from backend.style_family import clamp_style_value, get_style_family_spec  # type: ignore
except Exception:
    from style_family import clamp_style_value, get_style_family_spec  # type: ignore

try:
    from backend.brick_v2_spec import clamp_brick_v2_variation, get_brick_v2_spec  # type: ignore
except Exception:
    from brick_v2_spec import clamp_brick_v2_variation, get_brick_v2_spec  # type: ignore

try:
    from backend.brick_v2_garment import derive_garment_geometry  # type: ignore
except Exception:
    from brick_v2_garment import derive_garment_geometry  # type: ignore


SCHEMA_VERSION = 2
STYLE_ID = "brick_v1"
SUPPORTED_STYLE_IDS = {"brick_v1", "brick_v2"}
TEXTURE_SIZE = 512

_HAIR_STYLES = {
    "short_straight": "short",
    "short_wavy": "wave",
    "short_curly": "curl",
    "medium_straight": "bob",
    "medium_wavy": "wave",
    "long_straight": "long",
    "long_wavy": "long",
    "ponytail": "ponytail",
    "bun": "bun",
    "bald": "bald",
}


def _hex(value: Any, fallback: str) -> str:
    text = str(value or "").strip().upper()
    if len(text) == 7 and text.startswith("#"):
        try:
            int(text[1:], 16)
            return text
        except ValueError:
            pass
    return fallback


def _rgb(hex_color: str) -> Tuple[int, int, int]:
    value = hex_color.lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]


def _grid_arrays(grid: Optional[Dict[str, Any]], fallback_hex: str) -> Tuple[np.ndarray, np.ndarray]:
    if not grid or not grid.get("cells"):
        color = np.array(_rgb(fallback_hex), dtype=np.uint8)
        return np.tile(color, (2, 2, 1)), np.zeros((2, 2), dtype=np.uint8)

    cols = max(1, int(grid.get("cols") or 1))
    rows = max(1, int(grid.get("rows") or 1))
    cells = list(grid.get("cells") or [])
    fallback = np.array(_rgb(fallback_hex), dtype=np.uint8)
    colors = np.tile(fallback, (rows, cols, 1))
    active = np.zeros((rows, cols), dtype=np.uint8)
    for index, cell in enumerate(cells[: rows * cols]):
        row, col = divmod(index, cols)
        if bool(cell.get("active")):
            colors[row, col] = [
                np.clip(int(cell.get("r", fallback[0])), 0, 255),
                np.clip(int(cell.get("g", fallback[1])), 0, 255),
                np.clip(int(cell.get("b", fallback[2])), 0, 255),
            ]
            active[row, col] = 255
    return colors, active


def _fill_inactive(colors: np.ndarray, active: np.ndarray, fallback_hex: str) -> np.ndarray:
    if not active.any():
        return np.tile(np.array(_rgb(fallback_hex), dtype=np.uint8), (*active.shape, 1))
    inactive = active == 0
    # OpenCV inpainting grows real garment colours into pose-mask holes and
    # creates padded texture edges without inventing body geometry.
    filled = cv2.inpaint(colors, inactive.astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)
    return filled


def _normalise_lighting(rgb: np.ndarray) -> np.ndarray:
    """Compress illumination variation while retaining colour and patterns."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    light = lab[:, :, 0]
    p10, p90 = np.percentile(light, (10, 90))
    if p90 - p10 > 12:
        light = np.clip((light.astype(np.float32) - p10) * (190.0 / (p90 - p10)) + 32.0, 0, 255)
        lab[:, :, 0] = light.astype(np.uint8)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)


def grid_to_webp_data_url(
    grid: Optional[Dict[str, Any]],
    fallback_hex: str,
    *,
    size: int = TEXTURE_SIZE,
) -> Tuple[str, float, bool]:
    """Return a deterministic square material texture, confidence, fallback."""
    colors, active = _grid_arrays(grid, fallback_hex)
    active_ratio = float(np.count_nonzero(active)) / float(active.size)
    fallback_used = active_ratio < 0.18
    if fallback_used:
        colors[:] = np.array(_rgb(fallback_hex), dtype=np.uint8)
    else:
        colors = _fill_inactive(colors, active, fallback_hex)
        colors = _normalise_lighting(colors)

    # Nearest-neighbour first preserves garment motifs from the sampled grid;
    # a small final bilinear pass avoids visibly jagged UV texels.
    scaled = cv2.resize(colors, (size, size), interpolation=cv2.INTER_NEAREST)
    scaled = cv2.GaussianBlur(scaled, (3, 3), 0.35)
    image = Image.fromarray(scaled, mode="RGB")
    output = io.BytesIO()
    image.save(output, format="WEBP", quality=86, method=4)
    data = base64.b64encode(output.getvalue()).decode("ascii")

    active_pixels = colors.reshape(-1, 3)
    variation = min(1.0, float(np.std(active_pixels)) / 64.0)
    confidence = 0.25 if fallback_used else min(0.98, 0.55 + active_ratio * 0.3 + variation * 0.13)
    return f"data:image/webp;base64,{data}", round(confidence, 3), fallback_used


def _expression(face: Dict[str, Any]) -> str:
    try:
        return "smile" if float(face.get("smile_score", 0.0)) >= 0.35 else "neutral"
    except (TypeError, ValueError):
        return "neutral"


def _has_glasses(face: Dict[str, Any], accessories: Iterable[str]) -> bool:
    return bool(face.get("has_glasses") or "glasses" in set(accessories))


def active_character_style_id() -> str:
    """Return the opt-in fixed-geometry version used by new requests."""
    requested = os.environ.get("BRICK_CHARACTER_STYLE", STYLE_ID).strip().lower()
    return requested if requested in SUPPORTED_STYLE_IDS else STYLE_ID


def _body_shape(cv_result: Dict[str, Any], outfit: Dict[str, Any], style_id: str) -> Dict[str, Any]:
    """Map observable 2D proportions into deliberately narrow toy parameters."""
    landmarks = list(cv_result.get("landmarks") or [])
    bbox = cv_result.get("person_bbox") or {}

    def point(index: int) -> Optional[Tuple[float, float, float]]:
        if index >= len(landmarks) or not isinstance(landmarks[index], dict):
            return None
        item = landmarks[index]
        try:
            return float(item["x"]), float(item["y"]), float(item.get("v", 1.0))
        except (KeyError, TypeError, ValueError):
            return None

    def distance(left: Optional[Tuple[float, float, float]], right: Optional[Tuple[float, float, float]]) -> float:
        if not left or not right:
            return 0.0
        return float(np.hypot(left[0] - right[0], left[1] - right[1]))

    try:
        bbox_width = max(0.12, float(bbox.get("x2", 0.0)) - float(bbox.get("x1", 0.0)))
    except (TypeError, ValueError):
        bbox_width = 0.5
    shoulders = distance(point(11), point(12))
    hips = distance(point(23), point(24))
    visibility = [p[2] for p in (point(11), point(12), point(23), point(24)) if p]
    confidence = float(np.mean(visibility)) if visibility else 0.35
    capture_score = float((cv_result.get("capture_quality") or {}).get("score") or 0.0)
    confidence = min(confidence, capture_score) if capture_score else confidence

    shoulder_observed = shoulders / bbox_width if shoulders else 0.46
    torso_observed = ((shoulders + hips) / 2.0) / bbox_width if shoulders and hips else 0.43
    shoulder_scale = 1.0 + (shoulder_observed - 0.46) * 0.75
    torso_scale = 1.0 + (torso_observed - 0.43) * 0.72
    limb_scale = 1.0 + ((shoulder_scale + torso_scale) / 2.0 - 1.0) * 0.55
    depth_scale = 1.0 + (torso_scale - 1.0) * 0.45

    outer = str(outfit.get("outer") or "none").lower()
    if outer not in {"", "none", "no", "null"}:
        # Coats make silhouette width a weak body-shape observation.
        shoulder_scale = 1.0 + (shoulder_scale - 1.0) * 0.55
        torso_scale = 1.0 + (torso_scale - 1.0) * 0.45
        limb_scale = 1.0 + (limb_scale - 1.0) * 0.45
        confidence *= 0.72

    height_class = str(cv_result.get("height_class") or "medium")
    height_scale = {"short": 0.90, "medium": 1.0, "tall": 1.10}.get(height_class, 1.0)
    raw_shape = {
        "height_scale": height_scale,
        "shoulder_width": shoulder_scale,
        "torso_width": torso_scale,
        "torso_depth": depth_scale,
        "limb_thickness": limb_scale,
    }
    bounded_shape = (
        {key: clamp_brick_v2_variation(key, value) for key, value in raw_shape.items()}
        if style_id == "brick_v2"
        else {key: clamp_style_value(key, value) for key, value in raw_shape.items()}
    )
    result = {
        **bounded_shape,
        "confidence": round(max(0.0, min(1.0, confidence)), 3),
        "measurement": "bounded_stylized_2d",
    }
    return result


def build_character_spec(
    *,
    request_id: Optional[str],
    cv_result: Dict[str, Any],
    face_data: Optional[Dict[str, Any]] = None,
    outfit_data: Optional[Dict[str, Any]] = None,
    accessories: Optional[Iterable[str]] = None,
    style_id: Optional[str] = None,
) -> Dict[str, Any]:
    face = dict(face_data or {})
    outfit = dict(outfit_data or {})
    accessory_list = list(accessories or [])
    resolved_style_id = str(style_id or active_character_style_id()).strip().lower()
    if resolved_style_id not in SUPPORTED_STYLE_IDS:
        resolved_style_id = STYLE_ID
    upper_hex = _hex((cv_result.get("upper") or {}).get("hex"), "#607D8B")
    lower_hex = _hex((cv_result.get("lower") or {}).get("hex"), "#263238")
    arm_hex = _hex((cv_result.get("arm_color") or {}).get("hex"), upper_hex)

    torso_texture, torso_confidence, torso_fallback = grid_to_webp_data_url(
        cv_result.get("cloth_grid"), upper_hex
    )
    legs_texture, legs_confidence, legs_fallback = grid_to_webp_data_url(
        cv_result.get("lower_grid"), lower_hex
    )

    raw_hair = str(face.get("hair_style") or "short_straight").lower()
    hair_style = _HAIR_STYLES.get(raw_hair, "short")
    skin_color = _hex(face.get("skin_tone"), "#FFD0A8")
    hair_color = _hex(face.get("hair_color"), "#3B2314")
    beard_style = str(face.get("beard_style") or ("short" if face.get("has_beard") else "none"))
    height = str(cv_result.get("height_class") or "medium")
    if height not in {"short", "medium", "tall"}:
        height = "medium"

    capture_quality = cv_result.get("capture_quality") or {}
    result = {
        "schema_version": SCHEMA_VERSION,
        "material_version": 1,
        "character_id": str(request_id or uuid.uuid4().hex),
        "style_id": resolved_style_id,
        "style_spec_version": int(
            get_brick_v2_spec()["style_spec_version"]
            if resolved_style_id == "brick_v2"
            else get_style_family_spec()["style_spec_version"]
        ),
        "height_profile": height,
        "body_shape": _body_shape(cv_result, outfit, resolved_style_id),
        "skin_color": skin_color,
        "hair": {
            "strategy": "modular_parametric_3d" if resolved_style_id == "brick_v2" else "legacy_parts",
            "style": hair_style,
            "color": hair_color,
            "part_position": 0.0,
            "wave_amount": 0.72 if hair_style in {"wave", "curl", "long"} else 0.12,
            "side_length": 1.02 if hair_style == "long" else (0.64 if hair_style in {"bob", "wave", "curl"} else 0.45),
            "back_length": 1.10 if hair_style == "long" else (0.55 if hair_style in {"bob", "wave", "curl"} else 0.30),
            "volume": 1.0,
        },
        "face": {
            "expression": _expression(face),
            "glasses": _has_glasses(face, accessory_list),
            "beard": beard_style,
        },
        "outfit": {
            "upper_type": str(outfit.get("inner") or cv_result.get("upper_type") or "tshirt"),
            "lower_type": str(outfit.get("lower") or cv_result.get("lower_type") or "pants"),
            "outer_type": str(outfit.get("outer") or "none"),
            "upper_color": upper_hex,
            "lower_color": lower_hex,
            "arm_color": arm_hex,
        },
        "textures": {
            "torso_front": torso_texture,
            "legs_front": legs_texture,
        },
        "quality": {
            "capture_score": round(float(capture_quality.get("score") or 0.0), 3),
            "texture_confidence": round((torso_confidence + legs_confidence) / 2.0, 3),
            "fallback_used": bool(torso_fallback or legs_fallback),
        },
    }
    if resolved_style_id == "brick_v2":
        result["garment_geometry"] = derive_garment_geometry({
            **outfit,
            "upper_type": result["outfit"]["upper_type"],
            "lower_type": result["outfit"]["lower_type"],
            "outer_type": result["outfit"]["outer_type"],
        })
    return result


def validate_character_spec(spec: Dict[str, Any]) -> Dict[str, Any]:
    errors = []
    if spec.get("schema_version") not in {1, SCHEMA_VERSION}:
        errors.append("schema_version")
    if spec.get("style_id") not in SUPPORTED_STYLE_IDS:
        errors.append("style_id")
    if spec.get("height_profile") not in {"short", "medium", "tall"}:
        errors.append("height_profile")
    if spec.get("schema_version") == SCHEMA_VERSION:
        body_shape = spec.get("body_shape") or {}
        if spec.get("style_id") == "brick_v2":
            family = get_brick_v2_spec()["variation"]
            range_key = lambda key: family[f"{key}_range"]
        else:
            family = get_style_family_spec()["geometry"]
            range_key = lambda key: family[f"{key}_range"]
        for key in ("height_scale", "shoulder_width", "torso_width", "torso_depth", "limb_thickness"):
            try:
                value = float(body_shape[key])
                lower, upper = range_key(key)
                if not float(lower) <= value <= float(upper):
                    errors.append(f"body_shape_{key}")
            except (KeyError, TypeError, ValueError):
                errors.append(f"body_shape_{key}")
    for key in ("torso_front", "legs_front"):
        if not str((spec.get("textures") or {}).get(key, "")).startswith("data:image/webp;base64,"):
            errors.append(f"texture_{key}")
    textures = spec.get("textures") or {}
    enhanced_keys = ("face_decal", "left_leg_front", "right_leg_front")
    if any(textures.get(key) for key in enhanced_keys):
        for key in enhanced_keys:
            if not str(textures.get(key, "")).startswith("data:image/webp;base64,"):
                errors.append(f"texture_{key}")
    return {"passed": not errors, "errors": errors, "warnings": []}
