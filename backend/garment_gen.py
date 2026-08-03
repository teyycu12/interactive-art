"""
Image-to-image garment regeneration via OpenRouter chat completions.

OpenRouter doesn't expose OpenAI's /v1/images/edits endpoint; image-output
multimodal models (e.g. google/gemini-2.5-flash-image-preview,
openai/gpt-image-*) are invoked through /v1/chat/completions with
modalities=["image","text"]. Given the original webcam frame and the
pose-derived upper/lower polygons, crop the garment region, pad to a square,
send it to the chat model with a flat-illustration prompt, and return the
generated PNG as base64. The frontend overlays this on the lego character.
"""

from __future__ import annotations

import base64
import io
import os
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image as PILImage, ImageDraw

try:
    from backend.style_registry import GenerationStyle, get_style, register_style  # type: ignore
except Exception:
    from style_registry import GenerationStyle, get_style, register_style  # type: ignore

try:
    from openai import OpenAI  # type: ignore
    _HAS_OPENAI = True
except ImportError:
    _HAS_OPENAI = False


_client: Optional["OpenAI"] = None


def _get_client() -> Optional["OpenAI"]:
    """Build an OpenAI-SDK client. Auto-detects OpenRouter from key prefix."""
    global _client
    if _client is not None:
        return _client
    if not _HAS_OPENAI:
        print("[garment_gen] openai package not installed")
        return None
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("[garment_gen] OPENAI_API_KEY not set")
        return None

    base_url = os.environ.get("OPENAI_BASE_URL", "").strip()
    if not base_url:
        # Auto-detect: OpenRouter keys start with sk-or-
        if api_key.startswith("sk-or-"):
            base_url = "https://openrouter.ai/api/v1"
            print(f"[garment_gen] detected OpenRouter key, using base_url={base_url}")

    client_options = {"api_key": api_key, "timeout": 45.0, "max_retries": 0}
    if base_url:
        client_options["base_url"] = base_url
    _client = OpenAI(**client_options)
    print(f"[garment_gen] client ready (base_url={base_url or 'openai-default'})")
    return _client


def _crop_square_padded(
    rgb: np.ndarray,
    poly_norm: np.ndarray,
    pad_ratio: float = 0.10,
    pad_ratio_x: Optional[float] = None,
    size: int = 1024,
) -> Tuple[PILImage.Image, Tuple[int, int, int, int]]:
    """Crop polygon bounding box with padding, pad to white square, resize.

    pad_ratio_x lets the caller widen horizontally without inflating vertical
    padding — needed for upper-body crops so Nano Banana sees the sleeves.
    """
    h, w = rgb.shape[:2]
    px = (poly_norm * np.array([w, h], dtype=np.float32)).astype(np.int32)
    x1, y1 = int(px[:, 0].min()), int(px[:, 1].min())
    x2, y2 = int(px[:, 0].max()), int(px[:, 1].max())

    bw, bh = x2 - x1, y2 - y1
    pad_x = int(bw * (pad_ratio_x if pad_ratio_x is not None else pad_ratio))
    pad_y = int(bh * pad_ratio)
    x1 = max(0, x1 - pad_x)
    y1 = max(0, y1 - pad_y)
    x2 = min(w, x2 + pad_x)
    y2 = min(h, y2 + pad_y)

    crop = rgb[y1:y2, x1:x2]
    pil = PILImage.fromarray(crop.astype(np.uint8), mode="RGB")

    side = max(pil.width, pil.height)
    square = PILImage.new("RGB", (side, side), (255, 255, 255))
    square.paste(pil, ((side - pil.width) // 2, (side - pil.height) // 2))
    square = square.resize((size, size), PILImage.LANCZOS)
    return square, (x1, y1, x2, y2)


def _pil_to_data_url(pil: PILImage.Image) -> str:
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{b64}"


def _crop_norm_region(rgb: np.ndarray, region: Optional[Dict[str, float]], size: int = 480) -> Optional[PILImage.Image]:
    if not region:
        return None
    h, w = rgb.shape[:2]
    x1 = max(0, min(w - 1, int(region.get("x1", 0) * w)))
    y1 = max(0, min(h - 1, int(region.get("y1", 0) * h)))
    x2 = max(x1 + 1, min(w, int(region.get("x2", 1) * w)))
    y2 = max(y1 + 1, min(h, int(region.get("y2", 1) * h)))
    crop = PILImage.fromarray(rgb[y1:y2, x1:x2].astype(np.uint8), mode="RGB")
    crop.thumbnail((size, size), PILImage.LANCZOS)
    canvas = PILImage.new("RGB", (size, size), "white")
    canvas.paste(crop, ((size - crop.width) // 2, (size - crop.height) // 2))
    return canvas


def _build_detail_sheet(
    rgb: np.ndarray,
    regions: Optional[Dict[str, Any]],
    names: Tuple[str, ...] = ("face", "upper_body", "lower_body", "feet"),
) -> Optional[PILImage.Image]:
    if not regions:
        return None
    sheet = PILImage.new("RGB", (1024, 1024), "white")
    draw = ImageDraw.Draw(sheet)
    placed = 0
    for idx, name in enumerate(names):
        crop = _crop_norm_region(rgb, regions.get(name), size=480)
        if crop is None:
            continue
        x = 16 + (idx % 2) * 504
        y = 16 + (idx // 2) * 504
        sheet.paste(crop, (x, y))
        draw.rectangle((x, y, x + 480, y + 480), outline=(40, 40, 40), width=3)
        draw.rectangle((x, y, x + 150, y + 24), fill="white")
        draw.text((x + 6, y + 5), name.replace("_", " ").upper(), fill=(0, 0, 0))
        placed += 1
    return sheet if placed else None


def _canonical_lego_pose(size: int = 1024) -> PILImage.Image:
    """Neutral reference geometry; appearance is intentionally generic."""
    img = PILImage.new("RGB", (size, size), "white")
    d = ImageDraw.Draw(img)
    outline = (25, 25, 25)
    fill = (190, 190, 190)
    skin = (235, 205, 165)
    # Head, trapezoid torso, arms, separated legs and distinct shoes.
    d.rounded_rectangle((412, 105, 612, 290), radius=32, fill=skin, outline=outline, width=10)
    d.polygon([(405, 305), (619, 305), (660, 600), (364, 600)], fill=fill, outline=outline)
    d.polygon([(395, 325), (330, 350), (270, 590), (340, 610), (440, 360)], fill=fill, outline=outline)
    d.polygon([(629, 325), (694, 350), (754, 590), (684, 610), (584, 360)], fill=fill, outline=outline)
    d.rounded_rectangle((252, 575, 342, 665), radius=24, fill=skin, outline=outline, width=10)
    d.rounded_rectangle((682, 575, 772, 665), radius=24, fill=skin, outline=outline, width=10)
    d.rectangle((380, 600, 500, 875), fill=fill, outline=outline, width=10)
    d.rectangle((524, 600, 644, 875), fill=fill, outline=outline, width=10)
    d.rounded_rectangle((360, 855, 500, 925), radius=14, fill=(55, 55, 55), outline=outline, width=10)
    d.rounded_rectangle((524, 855, 664, 925), radius=14, fill=(55, 55, 55), outline=outline, width=10)
    return img


def _merge_upper_refinement(base_b64: str, refined_b64: str, split: float = 0.64) -> str:
    """Keep the base lower body exactly; feather only the refined upper region."""
    base = PILImage.open(io.BytesIO(base64.b64decode(base_b64))).convert("RGBA")
    refined = PILImage.open(io.BytesIO(base64.b64decode(refined_b64))).convert("RGBA").resize(base.size, PILImage.LANCZOS)
    w, h = base.size
    end = max(1, min(h, int(h * split)))
    feather = max(8, int(h * 0.05))
    mask = np.zeros((h, w), dtype=np.uint8)
    solid_end = max(0, end - feather)
    mask[:solid_end, :] = 255
    if end > solid_end:
        ramp = np.linspace(255, 0, end - solid_end, dtype=np.uint8)[:, None]
        mask[solid_end:end, :] = ramp
    merged = PILImage.composite(refined, base, PILImage.fromarray(mask, mode="L"))
    buf = io.BytesIO()
    merged.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _get_shield_mask(
    poly_norm: Optional[np.ndarray],
    crop_box: Tuple[int, int, int, int],
    img_w: int,
    img_h: int,
    target_size: int = 1024,
) -> Optional[np.ndarray]:
    """Create a boolean mask of target_size x target_size where the body polygon is.
    Pixels inside this mask should never be made transparent.
    """
    if poly_norm is None or len(poly_norm) < 3:
        return None

    try:
        mask = np.zeros((target_size, target_size), dtype=bool)
        x1, y1, x2, y2 = crop_box
        cw, ch = x2 - x1, y2 - y1
        side = max(cw, ch)
        if side <= 0:
            return None

        offset_x = (side - cw) // 2
        offset_y = (side - ch) // 2
        scale = target_size / side

        # Map normalized poly coordinates to square coordinates
        px = poly_norm * np.array([img_w, img_h], dtype=np.float32)
        square_pts = []
        for pt in px:
            sx = int(((pt[0] - x1) + offset_x) * scale)
            sy = int(((pt[1] - y1) + offset_y) * scale)
            sx = max(0, min(target_size - 1, sx))
            sy = max(0, min(target_size - 1, sy))
            square_pts.append((sx, sy))

        # Draw polygon using PIL
        img_mask = PILImage.new("L", (target_size, target_size), 0)
        draw = ImageDraw.Draw(img_mask)
        draw.polygon(square_pts, fill=255)

        # Convert to numpy boolean array
        mask = np.array(img_mask) > 128
        return mask
    except Exception as e:
        print(f"[garment_gen] failed to build shield mask: {e}")
        return None


def _remove_white_background(png_b64: str, tolerance: int = 18, shield_mask: Optional[np.ndarray] = None) -> str:
    """Flood-fill from the four corners turning near-white pixels transparent.

    Connected white regions touching any edge become alpha=0; white pixels
    enclosed by the garment (e.g. shirt logo, paper detail) are preserved.
    Tolerance is per-channel max distance from pure white.
    """
    try:
        raw = base64.b64decode(png_b64)
        img = PILImage.open(io.BytesIO(raw)).convert("RGBA")
        arr = np.array(img)
        h, w, _ = arr.shape
        # Mask of "near-white" pixels
        rgb = arr[:, :, :3]
        near_white = np.all(rgb >= (255 - tolerance), axis=-1)

        # Do not subtract ``shield_mask`` here. The generated character is not
        # guaranteed to align with the source-photo polygon, so the old shield
        # could preserve a large white rectangle behind the character. Border
        # connectivity already protects enclosed white garments and shoes.
        # Keep the argument for compatibility with existing generation calls.

        # Treat existing transparency as exterior too. Some stages add a
        # transparent margin before this function runs, which otherwise leaves
        # the old white canvas as an enclosed rectangle.
        transparent = arr[:, :, 3] <= 5
        exterior_candidate = near_white | transparent

        # BFS from the border so logos / interior white stay opaque.
        from collections import deque
        visited = np.zeros((h, w), dtype=bool)
        q: deque = deque()
        for x in range(w):
            for y in (0, h - 1):
                if exterior_candidate[y, x] and not visited[y, x]:
                    visited[y, x] = True
                    q.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if exterior_candidate[y, x] and not visited[y, x]:
                    visited[y, x] = True
                    q.append((y, x))
        while q:
            y, x = q.popleft()
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and exterior_candidate[ny, nx]:
                    visited[ny, nx] = True
                    q.append((ny, nx))
        removed = visited & near_white
        arr[removed, 3] = 0  # punch transparency

        # Soft alpha at the boundary: fade the 2-px ring around the cutout
        # so the polygon clip in the frontend doesn't show a hard white line.
        # (Simple Manhattan dilation of the visited mask.)
        boundary = np.zeros_like(visited)
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                if dy == 0 and dx == 0:
                    continue
                shifted = np.roll(np.roll(removed, dy, axis=0), dx, axis=1)
                boundary |= shifted & ~removed
        # For boundary pixels keep colour but halve alpha
        arr[boundary, 3] = (arr[boundary, 3].astype(int) // 2).astype(np.uint8)

        # Tight-crop to the opaque content bounding box so the frontend can
        # place the cardigan flush against the head with no top/bottom margin.
        opaque = arr[:, :, 3] > 5
        if opaque.any():
            ys, xs = np.where(opaque)
            y0, y1 = int(ys.min()), int(ys.max())
            x0, x1 = int(xs.min()), int(xs.max())
            # Small padding so outlines aren't clipped
            pad = 4
            y0 = max(0, y0 - pad); y1 = min(h - 1, y1 + pad)
            x0 = max(0, x0 - pad); x1 = min(w - 1, x1 + pad)
            arr = arr[y0:y1 + 1, x0:x1 + 1]

        out = PILImage.fromarray(arr, mode="RGBA")
        buf = io.BytesIO()
        out.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as e:
        print(f"[garment_gen] bg-remove failed (returning original): {e}")
        return png_b64


_NEGATIVE = (
    "Strictly NO text, NO labels, NO numbers, NO measurement marks, "
    "NO size tags, NO fabric callouts, NO arrows, NO design-sketch "
    "annotations, NO logos added by you, NO watermarks, NO signatures. "
    "ABSOLUTELY NO accessories: NO backpacks, NO bags, NO straps, NO necklaces, "
    "NO jewellery, NO watches, NO sunglasses, NO hats, NO scarves "
    "(unless the scarf IS the outfit). "
    "ABSOLUTELY NO background: NO walls, NO bricks, NO tiles, NO floor, NO "
    "scenery, NO patterns behind the garment — everything outside the garment "
    "silhouette must be pure solid white #FFFFFF, completely uniform. "
    "NO human skin texture, NO realistic rendering, NO 3D shadows, NO lighting gradients."
)

_BODY_PROMPT = (
    "Create a clean, premium LEGO minifigure torso and legs graphic based on the clothing in this photograph.\n\n"

    "### MANDATORY EXCLUSIONS:\n"
    "- NO head, NO face, NO neck stud, NO collar opening showing human skin.\n"
    "- NO arms, NO hands. The output starts at the shoulders and contains only torso and legs.\n"
    "- NO feet, NO shoes (each leg must end flat at the ankle).\n"
    "- NO skin pixels anywhere; the clothing must fully cover the body.\n\n"

    "### MANDATORY PROPORTIONS:\n"
    "- Torso: Perfect LEGO trapezoid shape (wider at the bottom, narrower at the top).\n"
    "- Legs: Two separate rectangular LEGO legs standing straight with a clear gap between them.\n\n"

    "### ART STYLE GUIDELINES:\n"
    "- Flat 2D vector graphic pop-art illustration style, official LEGO cartoon design.\n"
    "- Clean, bold, consistent black outlines around all parts.\n"
    "- Pure, solid, vibrant colors matching the photo. No gradients, no gloss, no highlights.\n"
    "- Perfectly centered on a pure solid white background (#FFFFFF) with absolutely no shadows, floor reflections, or background texture.\n\n"
    + _NEGATIVE
)


def _extract_image_b64(message) -> Optional[str]:
    """Pull the base64 PNG out of an OpenRouter chat completion message.
    Tries the common response shapes used by image-output models."""
    # Shape 1: message.images = [{"type":"image_url","image_url":{"url":"data:..."}}, ...]
    images = getattr(message, "images", None)
    if images:
        for item in images:
            url = None
            if isinstance(item, dict):
                url = item.get("image_url", {}).get("url") if isinstance(item.get("image_url"), dict) else item.get("image_url")
            else:
                iu = getattr(item, "image_url", None)
                if iu is not None:
                    url = getattr(iu, "url", None) or (iu.get("url") if isinstance(iu, dict) else None)
            if isinstance(url, str) and url.startswith("data:image"):
                return url.split(",", 1)[1]

    # Shape 2: message.content is a list of parts including image_url
    content = getattr(message, "content", None)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                if url.startswith("data:image"):
                    return url.split(",", 1)[1]

    return None


def _call_image_chat_multi(
    image_data_urls: List[str],
    prompt: str,
    model: Optional[str] = None,
    generation_params: Optional[Dict[str, Any]] = None,
    with_metadata: bool = False,
) -> Any:
    """Call chat completions with one OR MORE input images + image-output.

    image_data_urls: list of data: URLs (PNG/JPEG base64). Order matters when
    the prompt refers to "Image 1 / Image 2" etc.
    model: explicit override; falls back to OUTFIT_GEN_MODEL.
    """
    started_at = time.time()
    t_start = time.perf_counter()
    client = _get_client()
    if client is None:
        empty = {
            "image_b64": None,
            "error": "openai_unavailable",
            "api_usage": {"started_at": started_at, "duration_ms": 0, "error_code": "openai_unavailable"},
        }
        return empty if with_metadata else None

    if model is None:
        model = os.environ.get("OUTFIT_GEN_MODEL", "google/gemini-2.5-flash-image-preview").strip()

    content: list = [{"type": "text", "text": prompt}]
    for url in image_data_urls:
        content.append({"type": "image_url", "image_url": {"url": url}})

    requested_model = model
    try:
        params = dict(generation_params or {})
        for reserved in ("model", "messages", "modalities"):
            params.pop(reserved, None)
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": content}],
            modalities=["image", "text"],
            **params,
        )
    except Exception as e:
        print(f"[garment_gen] chat call failed (model={model}, n_images={len(image_data_urls)}): {e}")
        traceback.print_exc()
        failure = {
            "image_b64": None,
            "error": type(e).__name__,
            "api_usage": {
                "model": requested_model,
                "started_at": started_at,
                "duration_ms": int((time.perf_counter() - t_start) * 1000),
                "error_code": type(e).__name__,
            },
        }
        return failure if with_metadata else None

    try:
        msg = response.choices[0].message
    except Exception as e:
        print(f"[garment_gen] response shape unexpected: {e}; raw={response}")
        failure = {
            "image_b64": None,
            "error": "unexpected_response",
            "api_usage": {
                "model": requested_model,
                "provider_request_id": getattr(response, "id", None),
                "started_at": started_at,
                "duration_ms": int((time.perf_counter() - t_start) * 1000),
                "error_code": "unexpected_response",
            },
        }
        return failure if with_metadata else None

    b64 = _extract_image_b64(msg)
    if not b64:
        snippet = str(msg)[:400]
        print(f"[garment_gen] no image in response. msg_preview={snippet}")
    usage = getattr(response, "usage", None)
    usage_data = usage.model_dump() if hasattr(usage, "model_dump") else (usage if isinstance(usage, dict) else {})
    usage_data = usage_data or {}
    prompt_details = usage_data.get("prompt_tokens_details") or {}
    completion_details = usage_data.get("completion_tokens_details") or {}
    cost_details = usage_data.get("cost_details") or {}
    api_usage = {
        "model": getattr(response, "model", None) or requested_model,
        "provider_request_id": getattr(response, "id", None),
        "started_at": started_at,
        "duration_ms": int((time.perf_counter() - t_start) * 1000),
        "prompt_tokens": usage_data.get("prompt_tokens"),
        "completion_tokens": usage_data.get("completion_tokens"),
        "total_tokens": usage_data.get("total_tokens"),
        "image_tokens": completion_details.get("image_tokens"),
        "cached_tokens": prompt_details.get("cached_tokens"),
        "cost_usd": usage_data.get("cost"),
        "upstream_cost_usd": cost_details.get("upstream_inference_cost"),
        "error_code": None if b64 else "missing_image",
    }
    result = {"image_b64": b64, "error": None if b64 else "missing_image", "api_usage": api_usage}
    return result if with_metadata else b64


def _call_image_chat(image_data_url: str, prompt: str, model: Optional[str] = None) -> Optional[str]:
    """Single-image convenience wrapper around _call_image_chat_multi."""
    return _call_image_chat_multi([image_data_url], prompt, model=model)


# ─────────────────────────────────────────────────────────────────────────────
#  FULL-CHARACTER MODE — generate the whole LEGO minifigure in one go
# ─────────────────────────────────────────────────────────────────────────────

_FULL_CHARACTER_NEGATIVE = (
    "Strictly NO text, NO labels, NO numbers, NO measurement marks, "
    "NO size tags, NO fabric callouts, NO arrows, NO design-sketch annotations, "
    "NO watermarks, NO signatures. "
    "ABSOLUTELY NO photo-realism, NO 3D render, NO ray tracing — keep the "
    "flat cel-shaded LEGO illustration style. "
    "NO side view, NO three-quarter angle, NO sitting pose, NO action pose, "
    "NO twisted torso. Stand strictly straight, facing the viewer. "
    "ABSOLUTELY NO background: NO walls, NO floor, NO scenery, NO shadow, "
    "NO patterns behind the character — every pixel outside the figure "
    "must be pure solid white #FFFFFF, completely uniform. "
    "ABSOLUTELY NO random patches of differing colour on a garment, "
    "NO plaid/tartan/checkered squares unless the photo clearly shows them, "
    "NO patchwork, NO sewn-on badges, NO pocket stickers, NO logos, "
    "NO mismatched colour blocks within a single garment piece. "
    "NEVER omit shoes — both feet must always wear visible LEGO shoes. "
    "STRICT BODY-PART COUNT: EXACTLY one head, exactly two arms, "
    "EXACTLY TWO hands total (one at the end of each arm, at the wrist), "
    "exactly two legs, exactly two feet/shoes. "
    "NO extra hands, NO duplicate hands, NO floating hands, "
    "NO hands attached to the torso, hip, or legs, "
    "NO hands at the bottom of the legs (those positions are for SHOES, not hands). "
    "NO extra arms, NO duplicate limbs anywhere."
)

_FULL_CHARACTER_PROMPT_TEMPLATE = (
    "Create a complete premium LEGO minifigure illustration based on the person in this photograph.\n\n"

    "### DETECTED CHARACTER ATTRIBUTES:\n"
    "{attrs}\n\n"

    "### MANDATORY LEGO DESIGN RULES:\n"
    "1. **Proportions & Pose**: Strict front-facing view, perfectly centered and symmetric. Neutral T-pose-like stance: arms angled ~15 degrees outward at the sides, legs standing straight and parallel with a clear vertical gap between them.\n"
    "2. **Head & Face**: Smooth cylindrical LEGO-style head in the specified skin tone. Simple clean facial features: two glossy black dot eyes, clean eyebrows, and a pleasant simple mouth. Hair piece must sit cleanly on top of the head in the matching hair style and color.\n"
    "3. **Torso & Outerwear**: Trapezoidal LEGO torso wearing the outfit. Ensure the torso garment is clean and uniform in color. Draw clear printed lines for shirts, zippers, buttons, or jacket collars. Hands must be classic yellow/flesh LEGO claw hands attached at the wrist.\n"
    "4. **Legs & Pants**: Two separate rectangular LEGO legs of equal length in the matching pants color. Keep the pants uniform with no patchwork.\n"
    "5. **Shoes & Footwear**: Mandatory distinct shoes at the bottom of each leg. Draw them as clean rectangular slabs (black, grey, or brown) slightly wider than the leg, with a clean horizontal seam line separating the shoe from the pants.\n\n"

    "### ART STYLE GUIDELINES:\n"
    "- Cel-shaded flat vector illustration, premium minimalist pop-art concept style.\n"
    "- Thick, clean, consistent black outlines around all body parts and details.\n"
    "- Solid vibrant colors, flat design with minimal/no gradients and no realistic shadows.\n"
    "- The character must be centered on a pure solid white background (#FFFFFF) with no shadows, text, or border lines.\n\n"
    + _FULL_CHARACTER_NEGATIVE
)


def _attr_lines(face_data: Optional[Dict[str, Any]], outfit_data: Optional[Dict[str, Any]]) -> str:
    """Render the detected face + outfit attributes as bullet text for the prompt."""
    lines: list = []
    f = face_data or {}
    o = outfit_data or {}

    if f.get("skin_tone"):
        lines.append(f"- Skin tone (head + hands): {f['skin_tone']}")
    if f.get("hair_color"):
        lines.append(f"- Hair colour: {f['hair_color']}")
    if f.get("hair_style"):
        lines.append(f"- Hair style: {f['hair_style']}")
    if f.get("eye_color"):
        lines.append(f"- Eye colour: {f['eye_color']}")
    if f.get("has_beard"):
        lines.append(f"- Facial hair: {f.get('beard_style', 'short_beard')}")
    if f.get("smile_score") is not None:
        smiling = "smiling" if float(f.get("smile_score", 0)) > 0.4 else "neutral expression"
        lines.append(f"- Expression: {smiling}")

    if o.get("inner"):
        lines.append(f"- Top garment: {o['inner']}")
    if o.get("inner_color"):
        lines.append(f"- Top colour: {o['inner_color']}")
    if o.get("outer") and o.get("outer") != "none":
        lines.append(f"- Outer garment: {o['outer']}" + (f" ({o['outer_color']})" if o.get('outer_color') else ""))
    if o.get("lower"):
        lines.append(f"- Lower garment: {o['lower']}")
    if o.get("lower_color"):
        lines.append(f"- Lower colour: {o['lower_color']}")

    return "\n".join(lines) if lines else "- (no extra attributes — infer from the photo)"


def generate_full_character_png(
    rgb: np.ndarray,
    body_poly_norm: Optional[np.ndarray],
    face_data: Optional[Dict[str, Any]] = None,
    outfit_data: Optional[Dict[str, Any]] = None,
    remove_bg: bool = True,
    regions: Optional[Dict[str, Any]] = None,
    style_id: str = "lego",
    correction: Optional[str] = None,
    model_override: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate ONE complete LEGO-minifigure sprite (head→feet, all-in-one).

    Uses a SEPARATE env var FULL_CHARACTER_MODEL so the user can swap the
    image-gen model independently of the body-only flow. Returns the same
    shape as generate_body_png so the frontend can stay simple.

    remove_bg: when False, returns the raw b64 with white background intact.
    Used by the refine pipeline so the base image still carries the white
    background signal when fed back to the model in pass 2.
    """
    out: Dict[str, Any] = {"ok": False}

    if _get_client() is None:
        out["error"] = "openai_unavailable"
        return out

    if body_poly_norm is None or len(body_poly_norm) < 3:
        out["error"] = "no_body_poly"
        return out

    h, w = rgb.shape[:2]
    style = get_style(style_id)
    model = (
        (model_override or "").strip()
        or style.model_overrides.get("full_character", "").strip()
        or os.environ.get("FULL_CHARACTER_MODEL", "").strip()
        or os.environ.get("OUTFIT_GEN_MODEL", "").strip()
        or "google/gemini-2.5-flash-image-preview"
    )
    print(f"[garment_gen] start full-character (frame={w}x{h}, model={model}, remove_bg={remove_bg})")
    t_start = time.perf_counter()

    try:
        # Wide crop so head + arms + feet all sit inside the input frame.
        square, (x1, y1, x2, y2) = _crop_square_padded(
            rgb, body_poly_norm, pad_ratio=0.22, pad_ratio_x=0.30,
        )
        data_url = _pil_to_data_url(square)

        # Generate shield mask to prevent eating white clothes/shoes
        shield_mask = _get_shield_mask(body_poly_norm, (x1, y1, x2, y2), w, h, target_size=1024)

        prompt = style.full_prompt_template.format(
            attrs=_attr_lines(face_data, outfit_data)
        )
        if correction:
            prompt += "\n\n### REQUIRED CORRECTION\n" + correction
        input_urls = [data_url]
        detail_sheet = _build_detail_sheet(rgb, regions)
        if detail_sheet is not None:
            input_urls.append(_pil_to_data_url(detail_sheet))
        input_urls.append(_pil_to_data_url(_canonical_lego_pose()))
        prompt += "\n\nImage 1 is the source person. Image 2 (when present) is a close-up reference sheet. The final image is a neutral LEGO pose reference; copy only its complete front-facing geometry, including both shoes."
        api_result = _call_image_chat_multi(
            input_urls, prompt, model=model,
            generation_params=dict(style.generation_params.get("full_character", {})),
            with_metadata=True,
        )
        out["api_usage"] = api_result.get("api_usage")
        b64 = api_result.get("image_b64")
        if b64:
            if remove_bg:
                b64 = _remove_white_background(b64, shield_mask=shield_mask)
            out["body_png"] = b64
            out["body_bbox"] = [x1 / w, y1 / h, x2 / w, y2 / h]
            out["ok"] = True
            bg_note = "bg removed" if remove_bg else "raw (bg kept)"
            print(f"[garment_gen] full-character OK ({len(b64)} b64 chars, {bg_note})")
        else:
            out["error"] = api_result.get("error") or "generation_failed"
            print("[garment_gen] full-character failed (no image in response)")
    except Exception as e:
        print(f"[garment_gen] full-character error: {e}")
        traceback.print_exc()

    elapsed = time.perf_counter() - t_start
    print(f"[garment_gen] full-character done in {elapsed:.2f}s, ok={out['ok']}")
    return out


def generate_body_png(
    rgb: np.ndarray,
    body_poly_norm: Optional[np.ndarray],
    *,
    style_id: str = "lego",
    correction: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate ONE full-body LEGO-minifigure sprite (neck down).

    body_poly_norm is a 4-point polygon (normalised 0..1) covering the
    region from shoulders to feet with some horizontal slack for arms.

    Returns dict with body_png (base64 PNG, transparent background) and
    body_bbox (normalised xyxy) so the frontend can size/centre the sprite.
    """
    out: Dict[str, Any] = {"ok": False}

    if _get_client() is None:
        out["error"] = "openai_unavailable"
        return out

    if body_poly_norm is None or len(body_poly_norm) < 3:
        out["error"] = "no_body_poly"
        return out

    h, w = rgb.shape[:2]
    print(f"[garment_gen] start full-body (frame={w}x{h})")
    t_start = time.perf_counter()

    try:
        # Wide horizontal pad so arms / hands are inside the crop; moderate
        # vertical pad so the head is not cut off in the input (Nano Banana
        # still needs context but the prompt forbids it from drawing a head).
        square, (x1, y1, x2, y2) = _crop_square_padded(
            rgb, body_poly_norm, pad_ratio=0.08, pad_ratio_x=0.30,
        )
        data_url = _pil_to_data_url(square)

        # Generate shield mask to prevent eating white clothes/shoes
        shield_mask = _get_shield_mask(body_poly_norm, (x1, y1, x2, y2), w, h, target_size=1024)

        style = get_style(style_id)
        prompt = style.body_prompt
        if correction:
            prompt += "\n\n### REQUIRED CORRECTION\n" + correction
        body_model = style.model_overrides.get("body") or None
        api_result = _call_image_chat_multi(
            [data_url], prompt, model=body_model,
            generation_params=dict(style.generation_params.get("body", {})),
            with_metadata=True,
        )
        out["api_usage"] = api_result.get("api_usage")
        b64 = api_result.get("image_b64")
        if b64:
            b64 = _remove_white_background(b64, shield_mask=shield_mask)
            out["body_png"] = b64
            out["body_bbox"] = [x1 / w, y1 / h, x2 / w, y2 / h]
            out["ok"] = True
            print(f"[garment_gen] body OK ({len(b64)} b64 chars, bg removed)")
        else:
            out["error"] = api_result.get("error") or "generation_failed"
            print("[garment_gen] body failed (no image in response)")
    except Exception as e:
        print(f"[garment_gen] body error: {e}")
        traceback.print_exc()

    elapsed = time.perf_counter() - t_start
    print(f"[garment_gen] body done in {elapsed:.2f}s, ok={out['ok']}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  REFINE MODE — pass 2 on top of generate_full_character_png
# ─────────────────────────────────────────────────────────────────────────────

_REFINE_PROMPT = (
    "Refine this LEGO minifigure illustration. You are given TWO images:\n"
    "  • Image 1: the ORIGINAL photograph of the person (detail reference).\n"
    "  • Image 2: a DRAFT LEGO minifigure illustration of that same person (composition lock — pose, proportions, colours, background placement).\n\n"

    "TASK: Produce a sharper, cleaner, premium version of Image 2. STRICTLY preserve the pose, proportions, layout, and white background of Image 2, while refining outlines and detail quality.\n\n"

    "### DETECTED ATTRIBUTES (must match):\n"
    "{attrs}\n\n"

    "### STRICT CONSTRAINTS (do NOT change from Image 2):\n"
    "- Overall pose: Strict front view, arms at ~15° outward, both legs straight with a visible gap.\n"
    "- LEGO proportions and the position/size of head, torso, arms, legs, and feet.\n"
    "- Dominant garment colors from Image 2.\n"
    "- Flat cel-shaded vector style with clean black outlines (NOT 3D, NOT photorealistic).\n"
    "- Pure solid white (#FFFFFF) background.\n\n"

    "### HIGH-QUALITY REFINEMENTS TO MAKE:\n"
    "1. **Face & Eyes**: Symmetrical, cleanly redrawn facial features. Sharp dot eyes, perfect clean eyebrows and mouth. No smudging.\n"
    "2. **Hair & Head**: Extremely clean outline of the hair piece sitting perfectly on the head, with a clear boundary. Consistent single hair color matching Image 2.\n"
    "3. **Torso & Outerwear**: Crisp, tight garment silhouette and outlines. Uniform color across chest, back, and sleeves. Draw clean buttons, zippers, or pocket seams.\n"
    "4. **Upper-body Line Art**: Ensure the head, hair, arms, and torso outlines are clean, uniform, and sharp black vector-like strokes.\n"
    "5. **Locked Lower Body**: Do not redesign, repaint, move, crop, or regenerate the hips, legs, feet, or shoes from Image 2.\n\n"
    + _FULL_CHARACTER_NEGATIVE
)


register_style(GenerationStyle(
    style_id="lego",
    body_prompt=_BODY_PROMPT,
    full_prompt_template=_FULL_CHARACTER_PROMPT_TEMPLATE,
    refine_prompt=_REFINE_PROMPT,
    negative_prompt=_NEGATIVE + _FULL_CHARACTER_NEGATIVE,
    supported_modes=frozenset({"body_sprite", "full_character"}),
))


def generate_refine_character_png(
    base_b64: str,
    rgb: np.ndarray,
    body_poly_norm: Optional[np.ndarray],
    face_data: Optional[Dict[str, Any]] = None,
    outfit_data: Optional[Dict[str, Any]] = None,
    regions: Optional[Dict[str, Any]] = None,
    style_id: str = "lego",
) -> Dict[str, Any]:
    """Pass 2 of the refined pipeline.

    Takes the (non-bg-removed) base PNG from generate_full_character_png plus
    the original photo, and asks the model to sharpen face / hair / upper-body
    detail while preserving the base's lower body. Returns the same
    schema as generate_full_character_png.
    """
    out: Dict[str, Any] = {"ok": False}

    if _get_client() is None:
        out["error"] = "openai_unavailable"
        return out

    if body_poly_norm is None or len(body_poly_norm) < 3:
        out["error"] = "no_body_poly"
        return out

    if not base_b64:
        out["error"] = "no_base_image"
        return out

    h, w = rgb.shape[:2]
    style = get_style(style_id)
    model = (
        style.model_overrides.get("refine", "").strip()
        or os.environ.get("REFINE_CHARACTER_MODEL", "").strip()
        or os.environ.get("FULL_CHARACTER_MODEL", "").strip()
        or os.environ.get("OUTFIT_GEN_MODEL", "").strip()
        or "google/gemini-2.5-flash-image-preview"
    )
    print(f"[garment_gen] start refine pass (frame={w}x{h}, model={model})")
    t_start = time.perf_counter()

    try:
        # Same crop params as generate_full_character_png so the original photo
        # we feed in lines up with the base draft.
        square, (x1, y1, x2, y2) = _crop_square_padded(
            rgb, body_poly_norm, pad_ratio=0.22, pad_ratio_x=0.30,
        )
        orig_url = _pil_to_data_url(square)
        base_url = f"data:image/png;base64,{base_b64}"

        # Generate shield mask to prevent eating white clothes/shoes
        shield_mask = _get_shield_mask(body_poly_norm, (x1, y1, x2, y2), w, h, target_size=1024)

        prompt = style.refine_prompt.format(
            attrs=_attr_lines(face_data, outfit_data)
        )
        detail_sheet = _build_detail_sheet(rgb, regions, names=("face", "upper_body"))
        inputs = [orig_url]
        if detail_sheet is not None:
            inputs.append(_pil_to_data_url(detail_sheet))
        inputs.append(base_url)
        prompt += "\n\nRefine only the head, hair, face, and upper torso. The lower body and shoes will be kept from the draft and must not be redesigned."
        api_result = _call_image_chat_multi(
            inputs, prompt, model=model,
            generation_params=dict(style.generation_params.get("refine", {})),
            with_metadata=True,
        )
        out["api_usage"] = api_result.get("api_usage")
        b64 = api_result.get("image_b64")
        if b64:
            b64 = _merge_upper_refinement(base_b64, b64)
            b64 = _remove_white_background(b64, shield_mask=shield_mask)
            out["body_png"] = b64
            out["body_bbox"] = [x1 / w, y1 / h, x2 / w, y2 / h]
            out["ok"] = True
            print(f"[garment_gen] refine OK ({len(b64)} b64 chars, bg removed)")
        else:
            out["error"] = api_result.get("error") or "generation_failed"
            print("[garment_gen] refine failed (no image in response)")
    except Exception as e:
        print(f"[garment_gen] refine error: {e}")
        traceback.print_exc()

    elapsed = time.perf_counter() - t_start
    print(f"[garment_gen] refine done in {elapsed:.2f}s, ok={out['ok']}")
    return out
