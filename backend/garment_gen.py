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
import traceback
from typing import Any, Dict, Optional, Tuple

import numpy as np
from PIL import Image as PILImage

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

    _client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
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


def _remove_white_background(png_b64: str, tolerance: int = 18) -> str:
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
        # BFS from the border so logos / interior white stay opaque
        from collections import deque
        visited = np.zeros((h, w), dtype=bool)
        q: deque = deque()
        for x in range(w):
            for y in (0, h - 1):
                if near_white[y, x] and not visited[y, x]:
                    visited[y, x] = True
                    q.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if near_white[y, x] and not visited[y, x]:
                    visited[y, x] = True
                    q.append((y, x))
        while q:
            y, x = q.popleft()
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and near_white[ny, nx]:
                    visited[ny, nx] = True
                    q.append((ny, nx))
        arr[visited, 3] = 0  # punch transparency

        # Soft alpha at the boundary: fade the 2-px ring around the cutout
        # so the polygon clip in the frontend doesn't show a hard white line.
        # (Simple Manhattan dilation of the visited mask.)
        boundary = np.zeros_like(visited)
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                if dy == 0 and dx == 0:
                    continue
                shifted = np.roll(np.roll(visited, dy, axis=0), dx, axis=1)
                boundary |= shifted & ~visited
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
    "silhouette must be pure solid white #FFFFFF, completely uniform."
)

_BODY_PROMPT = (
    "Convert this photograph into a LEGO minifigure body wearing this outfit "
    "(NECK DOWN — NO head, NO face, NO neck).\n\n"

    "STRICT EXCLUSIONS:\n"
    "- NO head, NO face, NO neck stud, NO collar opening showing skin.\n"
    "- NO hands (each arm ends FLAT at the wrist — hands will be added later).\n"
    "- NO feet / NO shoes (each leg ends FLAT at the ankle — feet will be added later).\n"
    "- NO skin pixels anywhere; the outfit fully covers the visible body.\n\n"

    "Preserve EXACTLY the outfit's colour, knit/weave pattern, buttons, "
    "collar shape, hood, drawstrings, jeans wash and distressing.\n\n"

    "MANDATORY LEGO minifigure proportions (front-facing, perfectly symmetric):\n"
    "- Trapezoidal torso (wider at the bottom than the top), height ≈ width.\n"
    "- Two short straight arms attached at the top corners of the torso, "
    "angled outward ~15 degrees from vertical, length ≈ torso height. "
    "Sleeve fabric matches the photo (long-sleeve or short-sleeve as seen).\n"
    "- TWO separate rectangular legs below the torso with a CLEAR gap "
    "between them. Both legs of equal length, ending flat at the ankle.\n\n"

    "Style: cel-shaded flat vector illustration, crisp black outlines, "
    "solid block colours. Centred, fills most of the canvas. "
    "Pure solid white (#FFFFFF) background filling every empty pixel so it "
    "can be keyed out. No shadows on the background. "
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


def _call_image_chat(image_data_url: str, prompt: str, model: Optional[str] = None) -> Optional[str]:
    """Call chat completions with multimodal input + image-output modality.

    model: explicit override (used by full-character mode with its own env var).
    When None, falls back to OUTFIT_GEN_MODEL.
    """
    client = _get_client()
    if client is None:
        return None

    if model is None:
        model = os.environ.get("OUTFIT_GEN_MODEL", "google/gemini-2.5-flash-image-preview").strip()

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }],
            modalities=["image", "text"],
        )
    except Exception as e:
        print(f"[garment_gen] chat call failed (model={model}): {e}")
        traceback.print_exc()
        return None

    try:
        msg = response.choices[0].message
    except Exception as e:
        print(f"[garment_gen] response shape unexpected: {e}; raw={response}")
        return None

    b64 = _extract_image_b64(msg)
    if not b64:
        # Dump enough info to debug without flooding logs
        snippet = str(msg)[:400]
        print(f"[garment_gen] no image in response. msg_preview={snippet}")
    return b64


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
    "NEVER omit shoes — both feet must always wear visible LEGO shoes."
)

_FULL_CHARACTER_PROMPT_TEMPLATE = (
    "Convert this photograph into a COMPLETE LEGO minifigure illustration "
    "(head + hair + face + torso + arms + hands + legs + feet — the full "
    "character in a single image).\n\n"

    "DETECTED ATTRIBUTES (match faithfully):\n"
    "{attrs}\n\n"

    "MANDATORY POSE — for future skeletal rigging:\n"
    "- Strict front view, character facing the viewer head-on, perfectly symmetric.\n"
    "- Stand straight in a neutral T-pose-like stance: both arms hanging "
    "naturally at the sides, angled outward ~15 degrees from vertical "
    "(NOT raised, NOT crossed, NOT touching anything).\n"
    "- Both legs straight, parallel, slightly apart with a visible gap.\n"
    "- Head facing forward, no tilt. Neutral expression unless the photo "
    "shows a clear smile.\n\n"

    "MANDATORY LEGO minifigure proportions:\n"
    "- Yellow-style cylindrical head with simple cel-shaded face (two dot eyes, "
    "small mouth, optional eyebrows). Head colour must match the detected "
    "skin tone, NOT default yellow.\n"
    "- Hair piece sits on top of the head, matching the detected hair colour "
    "and style.\n"
    "- Trapezoidal torso (wider at the bottom than the top), height ≈ width, "
    "wearing the detected outfit. The torso garment MUST be ONE uniform "
    "solid colour across the entire chest and back (only the collar / button "
    "placket / cuffs may differ as thin trim lines). NO mid-garment patches, "
    "NO random coloured squares, NO different-coloured pocket area.\n"
    "- Collar / neckline is a single simple shape with ONE consistent colour, "
    "either matching the top garment or slightly darker as a trim — never "
    "multiple competing colours.\n"
    "- Two short straight arms attached at the top corners of the torso, "
    "sleeves matching the photo (long or short). Each sleeve is ONE uniform "
    "colour matching the top garment.\n"
    "- LEGO claw-style hands at the wrist ends, in the detected skin tone.\n"
    "- Two separate rectangular legs with a clear visible gap between them, "
    "wearing the detected lower garment. BOTH legs MUST be the exact same "
    "uniform colour — NO patch, NO swatch, NO contrasting square anywhere "
    "on the pants.\n"
    "- MANDATORY visible footwear: at the bottom of EACH leg, draw a flat "
    "LEGO shoe — a clearly distinct dark slab (dark grey / black / brown) "
    "that is WIDER than the leg, with a thin horizontal seam line where "
    "the shoe meets the leg. The shoe must be obviously a separate piece "
    "from the leg, not just the leg ending. NEVER omit the shoes.\n\n"

    "Style: cel-shaded flat vector illustration, crisp black outlines, "
    "solid block colours, no gradients. Centred, fills most of the canvas. "
    "Pure solid white (#FFFFFF) background filling every empty pixel "
    "so it can be keyed out. No shadows under the figure.\n\n"
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
) -> Dict[str, Any]:
    """Generate ONE complete LEGO-minifigure sprite (head→feet, all-in-one).

    Uses a SEPARATE env var FULL_CHARACTER_MODEL so the user can swap the
    image-gen model independently of the body-only flow. Returns the same
    shape as generate_body_png so the frontend can stay simple.
    """
    out: Dict[str, Any] = {"ok": False}

    if _get_client() is None:
        out["error"] = "openai_unavailable"
        return out

    if body_poly_norm is None or len(body_poly_norm) < 3:
        out["error"] = "no_body_poly"
        return out

    h, w = rgb.shape[:2]
    model = (
        os.environ.get("FULL_CHARACTER_MODEL", "").strip()
        or os.environ.get("OUTFIT_GEN_MODEL", "").strip()
        or "google/gemini-2.5-flash-image-preview"
    )
    print(f"[garment_gen] start full-character (frame={w}x{h}, model={model})")

    try:
        # Wide crop so head + arms + feet all sit inside the input frame.
        square, (x1, y1, x2, y2) = _crop_square_padded(
            rgb, body_poly_norm, pad_ratio=0.22, pad_ratio_x=0.30,
        )
        data_url = _pil_to_data_url(square)
        prompt = _FULL_CHARACTER_PROMPT_TEMPLATE.format(
            attrs=_attr_lines(face_data, outfit_data)
        )
        b64 = _call_image_chat(data_url, prompt, model=model)
        if b64:
            b64 = _remove_white_background(b64)
            out["body_png"] = b64
            out["body_bbox"] = [x1 / w, y1 / h, x2 / w, y2 / h]
            out["ok"] = True
            print(f"[garment_gen] full-character OK ({len(b64)} b64 chars, bg removed)")
        else:
            print("[garment_gen] full-character failed (no image in response)")
    except Exception as e:
        print(f"[garment_gen] full-character error: {e}")
        traceback.print_exc()

    print(f"[garment_gen] full-character done, ok={out['ok']}")
    return out


def generate_body_png(
    rgb: np.ndarray,
    body_poly_norm: Optional[np.ndarray],
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

    try:
        # Wide horizontal pad so arms / hands are inside the crop; moderate
        # vertical pad so the head is not cut off in the input (Nano Banana
        # still needs context but the prompt forbids it from drawing a head).
        square, (x1, y1, x2, y2) = _crop_square_padded(
            rgb, body_poly_norm, pad_ratio=0.08, pad_ratio_x=0.30,
        )
        data_url = _pil_to_data_url(square)
        b64 = _call_image_chat(data_url, _BODY_PROMPT)
        if b64:
            b64 = _remove_white_background(b64)
            out["body_png"] = b64
            out["body_bbox"] = [x1 / w, y1 / h, x2 / w, y2 / h]
            out["ok"] = True
            print(f"[garment_gen] body OK ({len(b64)} b64 chars, bg removed)")
        else:
            print("[garment_gen] body failed (no image in response)")
    except Exception as e:
        print(f"[garment_gen] body error: {e}")
        traceback.print_exc()

    print(f"[garment_gen] done, ok={out['ok']}")
    return out
