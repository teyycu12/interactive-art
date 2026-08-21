"""AI material-atlas generation for the fixed PersonaFlow brick character.

The image model is allowed to paint four fixed UV panels only.  Geometry,
lighting, pose, and animation remain deterministic in Three.js.
"""

from __future__ import annotations

import base64
import io
import os
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw

try:
    from backend.style_family import get_style_family_spec  # type: ignore
except Exception:
    from style_family import get_style_family_spec  # type: ignore

try:
    from backend.brick_v2_atlas import validate_brick_v2_print_panels  # type: ignore
except Exception:
    from brick_v2_atlas import validate_brick_v2_print_panels  # type: ignore

try:
    from backend.brick_v2_spec import get_brick_v2_spec  # type: ignore
except Exception:
    from brick_v2_spec import get_brick_v2_spec  # type: ignore

try:
    from backend.style_normalizer import directional_gradient, flatten_panels  # type: ignore
except Exception:
    from style_normalizer import directional_gradient, flatten_panels  # type: ignore

try:
    from backend.style_fingerprint import compare_to_base, panel_fingerprint  # type: ignore
except Exception:
    from style_fingerprint import compare_to_base, panel_fingerprint  # type: ignore

try:
    from backend.garment_gen import _call_image_chat_multi  # type: ignore
except Exception:
    from garment_gen import _call_image_chat_multi  # type: ignore


ATLAS_SIZE = 1024
PANEL_SIZE = ATLAS_SIZE // 2
TEXTURE_SIZE = 512

# Atlas quadrant order, shared by validation, normalization and splitting.
PANEL_NAMES = ("face", "torso_front", "left_leg_front", "right_leg_front")
PANEL_CELLS = ((0, 0), (1, 0), (0, 1), (1, 1))


def _hex_rgb(value: Any, fallback: str) -> Tuple[int, int, int]:
    text = str(value or fallback).strip().lstrip("#")
    try:
        if len(text) != 6:
            raise ValueError
        return tuple(int(text[index:index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return _hex_rgb(fallback, "#808080") if fallback != "#808080" else (128, 128, 128)


def _image_data_url(image: Image.Image, image_format: str = "PNG", **save_options: Any) -> str:
    output = io.BytesIO()
    image.save(output, format=image_format, **save_options)
    mime = "webp" if image_format.upper() == "WEBP" else "png"
    return f"data:image/{mime};base64,{base64.b64encode(output.getvalue()).decode('ascii')}"


def build_atlas_guide(character_spec: Dict[str, Any]) -> str:
    """Create the exact 2x2 layout the model must repaint."""
    outfit = character_spec.get("outfit") or {}
    colors = [
        _hex_rgb(character_spec.get("skin_color"), "#FFD0A8"),
        _hex_rgb(outfit.get("upper_color"), "#607D8B"),
        _hex_rgb(outfit.get("lower_color"), "#263238"),
        _hex_rgb(outfit.get("lower_color"), "#263238"),
    ]
    image = Image.new("RGB", (ATLAS_SIZE, ATLAS_SIZE), "white")
    draw = ImageDraw.Draw(image)
    boxes = [
        (0, 0, PANEL_SIZE, PANEL_SIZE),
        (PANEL_SIZE, 0, ATLAS_SIZE, PANEL_SIZE),
        (0, PANEL_SIZE, PANEL_SIZE, ATLAS_SIZE),
        (PANEL_SIZE, PANEL_SIZE, ATLAS_SIZE, ATLAS_SIZE),
    ]
    for box, color in zip(boxes, colors):
        draw.rectangle(box, fill=color)
    # Thick registration gutters make layout violations measurable after the
    # model returns the atlas. Cropping removes them from the final materials.
    gutter = 18
    draw.rectangle((PANEL_SIZE - gutter, 0, PANEL_SIZE + gutter, ATLAS_SIZE), fill=(8, 8, 10))
    draw.rectangle((0, PANEL_SIZE - gutter, ATLAS_SIZE, PANEL_SIZE + gutter), fill=(8, 8, 10))
    draw.rectangle((0, 0, ATLAS_SIZE - 1, ATLAS_SIZE - 1), outline=(8, 8, 10), width=gutter)
    return _image_data_url(image)


def build_style_anchor() -> str:
    """Return one person-free sheet containing render, face and outfit anchors."""
    image = Image.new("RGB", (ATLAS_SIZE, ATLAS_SIZE), (238, 242, 247))
    draw = ImageDraw.Draw(image)
    ink, skin, blue, dark = (24, 27, 31), (255, 208, 168), (52, 95, 140), (38, 41, 47)
    # Left: canonical complete brick_v1 render silhouette with flat material.
    draw.rounded_rectangle((145, 95, 505, 390), radius=90, fill=skin, outline=ink, width=10)
    draw.rectangle((170, 390, 480, 690), fill=blue, outline=ink, width=10)
    draw.rectangle((65, 410, 170, 705), fill=blue, outline=ink, width=10)
    draw.rectangle((480, 410, 585, 705), fill=blue, outline=ink, width=10)
    draw.ellipse((68, 665, 168, 765), fill=skin, outline=ink, width=8)
    draw.ellipse((482, 665, 582, 765), fill=skin, outline=ink, width=8)
    draw.rectangle((190, 690, 320, 930), fill=dark, outline=ink, width=10)
    draw.rectangle((330, 690, 460, 930), fill=dark, outline=ink, width=10)
    draw.ellipse((235, 205, 275, 262), fill=ink)
    draw.ellipse((370, 205, 410, 262), fill=ink)
    draw.arc((250, 245, 395, 345), 12, 168, fill=ink, width=14)
    # Right top: canonical flat face decal language.
    draw.rounded_rectangle((640, 90, 945, 395), radius=24, fill=skin, outline=(170, 180, 194), width=6)
    draw.line((700, 180, 755, 170), fill=ink, width=12)
    draw.line((830, 170, 885, 180), fill=ink, width=12)
    draw.ellipse((715, 205, 755, 260), fill=ink)
    draw.ellipse((830, 205, 870, 260), fill=ink)
    draw.arc((720, 235, 875, 340), 12, 168, fill=ink, width=14)
    # Right lower: canonical garment/leg albedo samples, no baked light.
    draw.rounded_rectangle((640, 440, 945, 700), radius=18, fill=blue, outline=(170, 180, 194), width=6)
    draw.line((700, 455, 792, 540), fill=(230, 235, 240), width=14)
    draw.line((885, 455, 792, 540), fill=(230, 235, 240), width=14)
    draw.line((792, 535, 792, 680), fill=ink, width=9)
    draw.rectangle((640, 755, 785, 950), fill=dark, outline=(170, 180, 194), width=6)
    draw.rectangle((800, 755, 945, 950), fill=dark, outline=(170, 180, 194), width=6)
    return _image_data_url(image)


def _prompt(character_spec: Dict[str, Any]) -> str:
    outfit = character_spec.get("outfit") or {}
    face = character_spec.get("face") or {}
    hair = character_spec.get("hair") or {}
    style_id = str(character_spec.get("style_id") or "brick_v1")
    surface_contract = """
The torso and leg panels are surface print maps for already-built 3D parts.
They must look like rectangular edge-to-edge fabric/material crops. Never draw
the outline of a shirt, dress, skirt, trousers, leg, pocket-shaped panel, or
any empty background around a garment. Do not try to change the body silhouette
inside the texture. Geometry supplies the neck, sleeves, waist, leg separation,
hands, shoes and all thickness.
""" if style_id == "brick_v2" else ""
    return f"""
Create ONE square 2x2 production-ready material atlas for PersonaFlow's
original brick-toy character. Image 1 is the photographed person and is the
only identity/outfit reference. Image 2 is the mandatory atlas layout guide.
Image 3 is the mandatory {style_id} style anchor. Copy Image 3's flat toy-print
line language, eye construction, palette discipline and material treatment;
never copy its identity or garment design.

Repaint Image 2 without moving its central black cross or outer border:
- TOP LEFT: flat front face print on an edge-to-edge {character_spec.get("skin_color", "#FFD0A8")}
  plastic base. Preserve recognizable eyebrow, eye, glasses, beard and smile
  traits from Image 1, but simplify them into premium toy-print illustration.
  No hair in this panel. Expression={face.get("expression", "smile")};
  glasses={bool(face.get("glasses"))}; beard={face.get("beard", "none")}.
- TOP RIGHT: edge-to-edge front torso material. Faithfully preserve the actual
  shirt/jacket colors, collar, zipper, buttons, stripes, graphics, seams and
  layering visible in Image 1. Garment={outfit.get("outer_type", "none")} over
  {outfit.get("upper_type", "tshirt")}; base color={outfit.get("upper_color", "#607D8B")}.
- BOTTOM LEFT: edge-to-edge LEFT trouser/skirt/leg front material.
- BOTTOM RIGHT: edge-to-edge RIGHT trouser/skirt/leg front material.
  Lower garment={outfit.get("lower_type", "pants")};
  base color={outfit.get("lower_color", "#263238")}.

The four panels are UV textures, NOT a character sheet. Do not draw a body,
head shape, arms, hands, legs, mannequin, scene, shadow, text, labels, logo,
numbers, watermark, swatches, fabric samples, or extra panels. Keep each panel
filled to every edge with its material base color. Preserve the guide's exact
square dimensions, equal quadrants, black central registration cross and black
outer border. Produce crisp, high-detail, front-facing FLAT ALBEDO toy printing.
Do not bake highlights, gradients, ambient occlusion, directional light, cast
shadows, bevel shading, material reflections or vignette into any panel. The
shared Three.js renderer supplies all 3D lighting. Output exactly one image.
Hair reference for consistency only: {hair.get("style", "short")},
{hair.get("color", "#3B2314")}.
{surface_contract}
""".strip()


def _decode_generated(image_b64: Optional[str]) -> Optional[np.ndarray]:
    if not image_b64:
        return None
    try:
        raw = base64.b64decode(image_b64)
        bgr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None
    if bgr is None or min(bgr.shape[:2]) < 512:
        return None
    height, width = bgr.shape[:2]
    side = min(height, width)
    y0 = (height - side) // 2
    x0 = (width - side) // 2
    return cv2.resize(bgr[y0:y0 + side, x0:x0 + side], (ATLAS_SIZE, ATLAS_SIZE))


def _panel(atlas: np.ndarray, col: int, row: int) -> np.ndarray:
    margin = 30
    x0, y0 = col * PANEL_SIZE + margin, row * PANEL_SIZE + margin
    x1, y1 = (col + 1) * PANEL_SIZE - margin, (row + 1) * PANEL_SIZE - margin
    return atlas[y0:y1, x0:x1]


def _lab_distance(panel: np.ndarray, expected_rgb: Tuple[int, int, int]) -> float:
    median_bgr = np.median(panel.reshape(-1, 3), axis=0).astype(np.uint8).reshape(1, 1, 3)
    expected_bgr = np.array(expected_rgb[::-1], dtype=np.uint8).reshape(1, 1, 3)
    actual_lab = cv2.cvtColor(median_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    expected_lab = cv2.cvtColor(expected_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    return float(np.linalg.norm(actual_lab - expected_lab))


def _registration_metrics(atlas: np.ndarray) -> Dict[str, float]:
    gray = cv2.cvtColor(atlas, cv2.COLOR_BGR2GRAY)
    band = 13
    cross = np.concatenate([
        gray[:, PANEL_SIZE - band:PANEL_SIZE + band].reshape(-1),
        gray[PANEL_SIZE - band:PANEL_SIZE + band, :].reshape(-1),
    ])
    border = np.concatenate([
        gray[:band].reshape(-1), gray[-band:].reshape(-1),
        gray[:, :band].reshape(-1), gray[:, -band:].reshape(-1),
    ])
    return {
        "cross_dark_ratio": float(np.mean(cross < 42)),
        "border_dark_ratio": float(np.mean(border < 42)),
    }


def normalize_atlas(atlas: np.ndarray) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Flatten baked directional lighting out of the four print panels.

    The renderer owns every light in the scene, so a panel that also carries a
    key light doubles the shading and is what makes one character read as flat
    2D and the next as heavily shaded.  Flattening is deterministic and costs
    no regeneration; a panel that is still over budget afterwards is reported
    as unfixable and fails validation.
    """
    corrected = atlas.copy()
    panels = {name: _panel(atlas, col, row).copy()
              for name, (col, row) in zip(PANEL_NAMES, PANEL_CELLS)}
    flattened, report = flatten_panels(panels)
    margin = 30
    for name, (col, row) in zip(PANEL_NAMES, PANEL_CELLS):
        x0, y0 = col * PANEL_SIZE + margin, row * PANEL_SIZE + margin
        x1, y1 = (col + 1) * PANEL_SIZE - margin, (row + 1) * PANEL_SIZE - margin
        corrected[y0:y1, x0:x1] = flattened[name]
    return corrected, report


def _decode_texture_data_url(value: Any) -> Optional[np.ndarray]:
    text = str(value or "")
    if not text.startswith("data:image/") or "," not in text:
        return None
    try:
        raw = base64.b64decode(text.split(",", 1)[1])
        return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def _source_pattern_fidelity(panel: np.ndarray, source: Optional[np.ndarray]) -> float:
    if source is None or source.size == 0:
        return 0.5
    source = cv2.resize(source, (panel.shape[1], panel.shape[0]))
    panel_gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    source_gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
    panel_edges = float(np.count_nonzero(cv2.Canny(panel_gray, 60, 140))) / panel_gray.size
    source_edges = float(np.count_nonzero(cv2.Canny(source_gray, 60, 140))) / source_gray.size
    if max(panel_edges, source_edges) < 0.004:
        return 1.0
    return max(0.0, 1.0 - abs(panel_edges - source_edges) / max(0.02, panel_edges, source_edges))


def validate_ai_atlas(atlas: np.ndarray, character_spec: Dict[str, Any]) -> Dict[str, Any]:
    outfit = character_spec.get("outfit") or {}
    expected = [
        _hex_rgb(character_spec.get("skin_color"), "#FFD0A8"),
        _hex_rgb(outfit.get("upper_color"), "#607D8B"),
        _hex_rgb(outfit.get("lower_color"), "#263238"),
        _hex_rgb(outfit.get("lower_color"), "#263238"),
    ]
    # Flatten first, judge second. Baked lighting that can be removed
    # deterministically is not worth a paid regeneration; what survives the
    # flatten is what the model actually got wrong.
    atlas, normalization = normalize_atlas(atlas)
    panels = [_panel(atlas, col, row) for col, row in PANEL_CELLS]
    errors = []
    warnings = []
    details = []
    registration = _registration_metrics(atlas)
    if registration["cross_dark_ratio"] < 0.72:
        errors.append("registration_cross_missing")
    if registration["border_dark_ratio"] < 0.72:
        errors.append("registration_border_missing")
    for index, (panel, color) in enumerate(zip(panels, expected)):
        gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
        variation = float(np.std(gray))
        edge_ratio = float(np.count_nonzero(cv2.Canny(gray, 60, 140))) / float(gray.size)
        color_distance = _lab_distance(panel, color)
        gradient = directional_gradient(panel)
        if float(np.std(panel)) < 2.0 and index > 0:
            # Plain shirts and trousers are valid; keep this observable without
            # rejecting faithful solid-colour clothing.
            warnings.append(f"panel_{index}_solid")
        if color_distance > 105:
            errors.append(f"panel_{index}_color_mismatch")
        elif color_distance > 70:
            warnings.append(f"panel_{index}_color_shift")
        # Only lighting the flatten could not remove is a failure. The budget
        # lives in style_base because the renderer already supplies 0.08-0.24
        # of its own vertical shading on top of whatever the texture carries.
        if not normalization["panels"][PANEL_NAMES[index]]["within_budget"]:
            errors.append(f"panel_{index}_baked_lighting")
        details.append({
            "variation": round(variation, 2),
            "edge_ratio": round(edge_ratio, 4),
            "color_distance": round(color_distance, 2),
            "lighting_gradient": round(gradient, 4),
        })

    # A face and torso without any printable edges usually means that the model
    # merely copied the blank guide rather than translating the photograph.
    if details[0]["edge_ratio"] < 0.004:
        errors.append("face_missing_detail")
    if details[1]["edge_ratio"] < 0.003:
        warnings.append("torso_low_detail")

    face_gray = cv2.cvtColor(panels[0], cv2.COLOR_BGR2GRAY)
    face_edges = cv2.Canny(face_gray, 60, 140)
    moments = cv2.moments(face_edges)
    if moments["m00"]:
        cx = moments["m10"] / moments["m00"] / face_edges.shape[1]
        cy = moments["m01"] / moments["m00"] / face_edges.shape[0]
        if not 0.28 <= cx <= 0.72 or not 0.22 <= cy <= 0.78:
            errors.append("face_features_off_center")

    textures = character_spec.get("textures") or {}
    torso_fidelity = _source_pattern_fidelity(panels[1], _decode_texture_data_url(textures.get("torso_front")))
    left_fidelity = _source_pattern_fidelity(panels[2], _decode_texture_data_url(textures.get("legs_front")))
    right_fidelity = _source_pattern_fidelity(panels[3], _decode_texture_data_url(textures.get("legs_front")))

    # Style fingerprints: the first check in this pipeline that asks whether
    # the panels speak the same visual language as the base standard, rather
    # than only whether each panel is individually well formed.
    style: Dict[str, Any] = {}
    for index, name in enumerate(PANEL_NAMES):
        fingerprint = panel_fingerprint(panels[index])
        comparison = compare_to_base(fingerprint, name)
        style[name] = {"fingerprint": fingerprint, "comparison": comparison}
        errors.extend(comparison["violations"])
        warnings.extend(comparison["observations"])

    v2_validation = None
    if character_spec.get("style_id") == "brick_v2":
        v2_validation = validate_brick_v2_print_panels({
            "face": panels[0],
            "torso_front": panels[1],
            "left_leg_front": panels[2],
            "right_leg_front": panels[3],
        })
        errors.extend(v2_validation["errors"])
        warnings.extend(v2_validation["warnings"])

    errors = sorted(set(errors))
    warnings = sorted(set(warnings))
    passed = not errors
    detail_score = min(1.0, (details[0]["edge_ratio"] + details[1]["edge_ratio"]) / 0.08)
    face_detail = min(1.0, details[0]["edge_ratio"] / 0.045)
    outfit_fidelity = float(np.mean([torso_fidelity, left_fidelity, right_fidelity]))
    species_penalty = min(1.0, len([item for item in errors if "registration" in item or "baked_lighting" in item]) * 0.24)
    species_compliance = max(0.0, 1.0 - species_penalty - min(0.25, sum(item["color_distance"] for item in details) / 1000.0))
    result = {
        "passed": passed,
        "errors": errors,
        "warnings": warnings,
        "detail_score": round(detail_score, 3),
        "species_compliance": round(species_compliance, 3),
        "face_detail": round(face_detail, 3),
        "outfit_fidelity": round(outfit_fidelity, 3),
        "registration": {key: round(value, 3) for key, value in registration.items()},
        "panels": details,
        "normalization": normalization,
        "style": style,
        "style_distance": round(
            float(np.mean([style[name]["comparison"]["distance"] for name in PANEL_NAMES])), 4
        ),
    }
    if v2_validation is not None:
        result["brick_v2_print"] = v2_validation
    return result


def _webp(panel: np.ndarray) -> str:
    rgb = cv2.cvtColor(cv2.resize(panel, (TEXTURE_SIZE, TEXTURE_SIZE), interpolation=cv2.INTER_LANCZOS4), cv2.COLOR_BGR2RGB)
    return _image_data_url(Image.fromarray(rgb), "WEBP", quality=92, method=5)


def _face_decal_webp(panel: np.ndarray) -> str:
    """Remove the generated skin base so only the facial print overlays 3D."""
    resized = cv2.resize(panel, (TEXTURE_SIZE, TEXTURE_SIZE), interpolation=cv2.INTER_LANCZOS4)
    edge = max(8, TEXTURE_SIZE // 20)
    border = np.concatenate([
        resized[:edge].reshape(-1, 3),
        resized[-edge:].reshape(-1, 3),
        resized[:, :edge].reshape(-1, 3),
        resized[:, -edge:].reshape(-1, 3),
    ])
    base = np.median(border, axis=0)
    distance = np.linalg.norm(resized.astype(np.float32) - base.astype(np.float32), axis=2)
    alpha = np.clip((distance - 10.0) * (255.0 / 24.0), 0, 255).astype(np.uint8)
    # Avoid a rectangular decal edge even when the model adds a slight vignette.
    fade = np.ones((TEXTURE_SIZE, TEXTURE_SIZE), dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, edge, dtype=np.float32)
    fade[:edge] *= ramp[:, None]
    fade[-edge:] *= ramp[::-1, None]
    fade[:, :edge] *= ramp[None, :]
    fade[:, -edge:] *= ramp[None, ::-1]
    alpha = (alpha.astype(np.float32) * fade).astype(np.uint8)
    rgba = cv2.cvtColor(resized, cv2.COLOR_BGR2RGBA)
    rgba[:, :, 3] = alpha
    return _image_data_url(Image.fromarray(rgba), "WEBP", quality=92, method=5)


def split_atlas_textures(atlas: np.ndarray) -> Dict[str, str]:
    return {
        "face_decal": _face_decal_webp(_panel(atlas, 0, 0)),
        "torso_front": _webp(_panel(atlas, 1, 0)),
        "left_leg_front": _webp(_panel(atlas, 0, 1)),
        "right_leg_front": _webp(_panel(atlas, 1, 1)),
    }


def generate_ai_character_textures(
    source_image_data_url: str,
    character_spec: Dict[str, Any],
) -> Dict[str, Any]:
    """Generate, validate and split a fixed-layout material atlas."""
    model = (
        os.environ.get("BRICK_TEXTURE_MODEL", "").strip()
        or os.environ.get("REFINE_CHARACTER_MODEL", "").strip()
        or os.environ.get("FULL_CHARACTER_MODEL", "").strip()
        or "google/gemini-3-pro-image-preview"
    )
    response = _call_image_chat_multi(
        [source_image_data_url, build_atlas_guide(character_spec), build_style_anchor()],
        _prompt(character_spec),
        model=model,
        with_metadata=True,
    )
    atlas = _decode_generated(response.get("image_b64"))
    if atlas is None:
        return {
            "ok": False,
            "error": response.get("error") or "invalid_atlas_image",
            "validation": {"passed": False, "errors": ["invalid_atlas_image"], "warnings": []},
            "api_usage": response.get("api_usage") or {},
        }
    # Normalize once here so the textures that ship are the same flattened
    # panels validation judged, not the raw model output.
    atlas, _ = normalize_atlas(atlas)
    validation = validate_ai_atlas(atlas, character_spec)
    if not validation["passed"]:
        return {
            "ok": False,
            "error": "atlas_validation_failed",
            "body_png": response.get("image_b64"),
            "validation": validation,
            "api_usage": response.get("api_usage") or {},
        }
    return {
        "ok": True,
        # record_attempt stores this generated atlas for the developer A/B
        # dashboard. It is never sent as the public character body image.
        "body_png": response.get("image_b64"),
        "textures": split_atlas_textures(atlas),
        "validation": validation,
        "api_usage": response.get("api_usage") or {},
        "model": model,
    }


def apply_ai_textures(character_spec: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    """Return a new CharacterSpec enriched with a validated AI texture set."""
    required = {"face_decal", "torso_front", "left_leg_front", "right_leg_front"}
    textures = result.get("textures") or {}
    missing = sorted(key for key in required if not str(textures.get(key) or "").startswith("data:image/"))
    if missing:
        raise ValueError(f"incomplete_ai_texture_atlas:{','.join(missing)}")
    enriched = dict(character_spec)
    enriched["material_version"] = int(character_spec.get("material_version") or 1) + 1
    enriched["textures"] = {
        **(character_spec.get("textures") or {}),
        **textures,
    }
    enriched["quality"] = {
        **(character_spec.get("quality") or {}),
        "ai_texture_status": "enhanced",
        "ai_texture_model": result.get("model"),
        "ai_detail_score": (result.get("validation") or {}).get("detail_score"),
        "species_compliance": (result.get("validation") or {}).get("species_compliance"),
        "face_detail": (result.get("validation") or {}).get("face_detail"),
        "outfit_fidelity": (result.get("validation") or {}).get("outfit_fidelity"),
        "style_spec_version": (
            get_brick_v2_spec()["style_spec_version"]
            if character_spec.get("style_id") == "brick_v2"
            else get_style_family_spec()["style_spec_version"]
        ),
    }
    return enriched
