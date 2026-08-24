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

from pathlib import Path

import cv2
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


# 模型名稱一律由 config 決定。此檔原本自行讀 os.environ 並各自寫死一組
# 後備值，與 config.py 的預設不一致 —— 實際發生過的後果是三條生成路徑
# 全都落到 google/gemini-2.5-flash-image-preview（該 ID 不存在，
# OpenRouter 回 404），而熔斷器只會回報 circuit_open，看不出真正原因。
try:
    from backend.config import config as _config  # type: ignore
except Exception:  # pragma: no cover - 直接以 backend/ 為工作目錄時
    from config import config as _config  # type: ignore


def _resolve_model(*candidates: Optional[str]) -> str:
    """取第一個非空的模型名，全空時退回 OUTFIT_GEN_MODEL。"""
    for c in candidates:
        if c and c.strip():
            return c.strip()
    return _config.OUTFIT_GEN_MODEL


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


_STYLE_SHEET_WIDTH = 1024
_STYLE_SHEET_COLUMNS = 3
_STYLE_SHEET_CELL_ASPECT = 1.5  # the curated sets are framed 2:3 portrait
_STYLE_REFERENCE_ROOT = Path(__file__).resolve().parents[1] / "docs" / "style_reference"
_STYLE_SHEET_SUFFIXES = {".png", ".webp"}

_style_sheet_cache: Dict[str, Optional[PILImage.Image]] = {}


def _build_style_reference_sheet(set_id: str) -> Optional[PILImage.Image]:
    """Pack a curated set's full-body references into one sheet.

    No cell labels are drawn here, unlike ``_build_detail_sheet``.  That sheet
    labels its cells because its crops come from the visitor and the model has to
    know which body part each one is.  This sheet is read holistically as one
    visual language, so a label would buy nothing and cost a great deal: it would
    put readable glyphs into the reference image, which is the single strongest
    copy vector and the exact thing the set is curated to exclude.
    """
    directory = _STYLE_REFERENCE_ROOT / set_id
    if not directory.is_dir():
        return None
    paths = sorted(
        path for path in directory.glob("full_body_*")
        if path.suffix.lower() in _STYLE_SHEET_SUFFIXES
    )
    if not paths:
        return None

    columns = min(_STYLE_SHEET_COLUMNS, len(paths))
    cell_w = _STYLE_SHEET_WIDTH // columns
    cell_h = int(cell_w * _STYLE_SHEET_CELL_ASPECT)
    rows = -(-len(paths) // columns)
    sheet = PILImage.new("RGB", (_STYLE_SHEET_WIDTH, cell_h * rows), (254, 254, 253))

    for index, path in enumerate(paths):
        try:
            figure = PILImage.open(path).convert("RGB")
        except Exception as exc:
            print(f"[garment_gen] style reference {path.name} unreadable: {exc}")
            continue
        figure.thumbnail((cell_w, cell_h), PILImage.LANCZOS)
        row, column = divmod(index, columns)
        # Centre a short final row rather than leaving it hanging to the left,
        # so no figure reads as more important than the others.
        in_row = min(columns, len(paths) - row * columns)
        left = (_STYLE_SHEET_WIDTH - in_row * cell_w) // 2 + column * cell_w
        sheet.paste(figure, (left + (cell_w - figure.width) // 2,
                             row * cell_h + (cell_h - figure.height) // 2))
    return sheet


def _style_reference_sheet() -> Optional[PILImage.Image]:
    """The active style sheet, or None when the switch is off or the set is absent.

    ``STYLE_REFERENCE_MODE=off`` rolls the send back to the three-image shape for
    a controlled comparison; a missing set degrades to the same thing rather than
    failing the generation.
    """
    if os.environ.get("STYLE_REFERENCE_MODE", "sheet").strip().lower() != "sheet":
        return None
    set_id = os.environ.get("STYLE_REFERENCE_SET", "").strip() or "2026q3_owner_curated"
    if set_id not in _style_sheet_cache:
        sheet = _build_style_reference_sheet(set_id)
        _style_sheet_cache[set_id] = sheet
        detail = f"{sheet.width}x{sheet.height}" if sheet else "not found, sending without it"
        print(f"[garment_gen] style reference set '{set_id}': {detail}")
    return _style_sheet_cache[set_id]


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


# Sized against what must survive, not against what we want gone. A shoe that
# renders a few pixels clear of the leg above it is roughly 0.5-1.5% of the
# figure, and erasing one would manufacture the very fault
# ``missing_bottom_left`` exists to catch. A painted ground shadow is an order
# of magnitude smaller, so the cutoff sits below the shoe and above the shadow.
ISLAND_KEEP_RATIO = 0.005


def _drop_detached_islands(arr: np.ndarray, keep_ratio: float = ISLAND_KEEP_RATIO) -> np.ndarray:
    """Erase opaque islands too small to be part of the figure.

    The white cut above only reaches *white* reachable from the border, so a
    shadow the model painted beside the feet survives it: the blob is grey, and
    the flood fill has nothing to travel through.  ``validate_avatar_png`` does
    not catch it either -- its ``fragmented_foreground`` gate fires at
    ``main_component_ratio < 0.75``, tuned for a severed limb, while a 2% blob
    leaves the ratio near 0.97 and passes silently.

    Deleting is deliberate, rather than routing this into the retry loop: a
    stray blob is free to erase and expensive to re-roll, and the retry loop
    should stay reserved for faults the model can actually fix from a text note.

    This runs before the tight crop below, because an island out beside the feet
    widens the opaque bounding box and shifts the whole figure off centre.
    """
    opaque = (arr[:, :, 3] > 5).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(opaque, connectivity=8)
    if count <= 2:  # background plus at most one component: nothing detached
        return arr

    areas = stats[1:, cv2.CC_STAT_AREA]
    main = int(np.argmax(areas)) + 1
    cutoff = float(stats[main, cv2.CC_STAT_AREA]) * keep_ratio
    dropped = 0
    for label in range(1, count):
        if label == main or float(stats[label, cv2.CC_STAT_AREA]) >= cutoff:
            continue
        arr[labels == label, 3] = 0
        dropped += 1
    if dropped:
        print(f"[garment_gen] erased {dropped} detached island(s) smaller than "
              f"{keep_ratio:.1%} of the figure")
    return arr


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

        arr = _drop_detached_islands(arr)

        # Soft alpha at the boundary: fade the 2-px ring around the cutout
        # so the polygon clip in the frontend doesn't show a hard white line.
        # (Simple Manhattan dilation of the visited mask.)
        boundary = np.zeros_like(removed)
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


def _provider_message(exc: Exception) -> str:
    """The provider's own sentence, without the SDK wrapper around it.

    ``str(exc)`` on an API error is the whole serialised body -- status line,
    nested metadata, user id -- which hides the part a human needs (how many
    credits short the request was).
    """
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        inner = body.get("error") if isinstance(body.get("error"), dict) else body
        message = inner.get("message") if isinstance(inner, dict) else None
        if message:
            return str(message)
    return str(exc)


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
        model = _resolve_model(_config.OUTFIT_GEN_MODEL)

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
        # 402 is a billing state, not a crash. The provider reserves budget
        # against max_tokens before the call, so the request is refused at the
        # door in under two seconds and no retry can succeed until the balance
        # moves. A stack trace for it buries the one line that says why.
        if getattr(e, "status_code", None) == 402:
            code = "insufficient_credits"
            print(f"[garment_gen] provider refused the call, out of credits: {_provider_message(e)}")
        else:
            code = type(e).__name__
            print(f"[garment_gen] chat call failed (model={model}, n_images={len(image_data_urls)}): {e}")
            traceback.print_exc()
        failure = {
            "image_b64": None,
            "error": code,
            "api_usage": {
                "model": requested_model,
                "started_at": started_at,
                "duration_ms": int((time.perf_counter() - t_start) * 1000),
                "error_code": code,
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


# ─────────────────────────────────────────────────────────────────────────────
#  FULL-CHARACTER MODE — generate the whole LEGO minifigure in one go
# ─────────────────────────────────────────────────────────────────────────────

_FULL_CHARACTER_NEGATIVE = (
    "Strictly NO text, NO labels, NO numbers, NO measurement marks, "
    "NO size tags, NO fabric callouts, NO arrows, NO design-sketch annotations, "
    "NO watermarks, NO signatures. "
    "The subject is a moulded plastic toy, never a real human: NO skin pores, "
    "NO individual hair strands, NO fabric weave, NO cloth folds - every surface "
    "is smooth moulded plastic. Equally, NO flat cel-shaded cartoon styling. "
    "NO side view, NO three-quarter angle, NO sitting pose, NO action pose, "
    "NO twisted torso. Stand strictly straight, facing the viewer. "
    "ABSOLUTELY NO background: NO walls, NO floor, NO scenery, NO patterns, "
    "and NO shadow, contact shadow or reflection cast onto the background - "
    "every pixel outside the figure must be pure solid white #FFFFFF, completely "
    "uniform. Shading ON the figure itself is required; see the art style rules. "
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
    "Create a complete premium LEGO minifigure product render based on the person in this photograph.\n\n"

    "### DETECTED CHARACTER ATTRIBUTES:\n"
    "{attrs}\n\n"

    "### MANDATORY LEGO DESIGN RULES:\n"
    "1. **Proportions & Pose**: Strict front-facing view, perfectly centered and symmetric. Neutral stance: arms angled ~15 degrees outward at the sides, legs straight and parallel. When the lower body is trousered or bare, leave a clear vertical gap between the legs; a one-piece garment reaching below the hip closes that gap instead.\n"
    "2. **Head & Face**: Smooth cylindrical LEGO-style head in the specified skin tone. Simple clean facial features: two glossy black dot eyes, clean eyebrows, and a pleasant simple mouth. Hair piece must sit cleanly on top of the head in the matching hair style and color.\n"
    "3. **Torso & Outerwear**: Trapezoidal LEGO torso wearing the outfit. Each individual garment piece is one clean uniform colour, but the torso may carry SEVERAL pieces at once - an open jacket over a shirt, a collar, a scarf - and those pieces keep their own separate colours and overlap each other with real visible thickness. Draw clear printed lines for shirts, zippers, buttons, or jacket collars. Hands must be classic C-shaped claw hands attached at the wrist, in the same specified skin tone as the head.\n"
    "4. **Lower Body**: Follow what the person actually wears. Trousers or shorts become two separate rectangular LEGO legs of equal length in that garment's colour. A dress, skirt, robe or long coat instead becomes ONE continuous moulded piece running unbroken from the waist to its hem with no vertical split, and the bare legs continue below that hem in the person's own skin tone. Keep each piece uniform in colour with no patchwork.\n"
    "5. **Shoes & Footwear**: Mandatory distinct shoes at the bottom of each leg. Draw them as clean rectangular slabs (black, grey, or brown) slightly wider than the leg, with a clean horizontal seam line separating the shoe from the leg or trouser above it.\n\n"

    "### ART STYLE GUIDELINES - GLOSSY MOULDED PLASTIC, NOT FLAT VECTOR:\n"
    "- Render the figure as a physical moulded-plastic toy shot in a studio: smooth "
    "surfaces with real material response, soft form shading and specular highlights. "
    "This is a product render, not a flat illustration.\n"
    "- **Lighting**: one large softbox above and IN FRONT of the figure. Brightness "
    "falls off gently from top to bottom on every part. Left and right stay evenly lit "
    "- no side light, no rim light, no coloured light.\n"
    "- **Gloss order** (glossiest first, keep this ranking exactly): hair, with a tight "
    "highlight streak; then printed garment surfaces; then skin, satin with one broad "
    "soft highlight; then shoe rubber, duller; then denim, the most matte of all with "
    "almost no highlight. Two materials must never read as equally shiny.\n"
    "- **Print versus shading**: seams, hems, trim, stitching, wear, text and logos are "
    "printed flat onto the surface and carry no light direction of their own. Every "
    "highlight and shadow comes from the studio light on the plastic form.\n"
    "- Hair plastic is a warm dark grey, never pure black.\n"
    "- Let the plastic form and clean colour separation define edges, rather than a "
    "uniform black cartoon outline drawn around every part.\n"
    "- Center the figure on a pure solid white background (#FFFFFF). The figure is "
    "shaded; the background is not. No text, no border lines.\n\n"
    + _FULL_CHARACTER_NEGATIVE
)


_ROLE_PERSON = (
    "the source person. This is WHO the figure is: their face, their skin tone, "
    "their hair, their actual garments and their actual colours."
)
_ROLE_DETAIL = "close-up crops of that same person. Same authority as Image 1, detail only."
_ROLE_POSE = (
    "a neutral pose reference. Copy its stance, its proportions and its body-part "
    "count: front-facing, arms at the sides, two legs, two shoes. It is drawn in "
    "trousers, so its lower-body silhouette is only correct for a trousered "
    "person - the actual lower-body shape follows the source person's garment. Its "
    "colours and blank surfaces carry no meaning."
)
_ROLE_STYLE = (
    "a style reference sheet of DIFFERENT characters rendered in the target style. "
    "This sheet is the PRIMARY authority on how anything is built and finished: how "
    "the plastic catches light, how tight the specular highlights are, the gloss "
    "ordering between materials, how seams and hems are printed flat with no light "
    "of their own, how edges come from clean colour separation rather than drawn "
    "outlines, the discipline of large uniform colour fields, and how this species "
    "constructs a garment - a one-piece garment moulded as a single unbroken flare "
    "with bare legs below its hem, one layer overlapping another with real "
    "thickness. Where a design rule above and this sheet disagree about surface, "
    "material, finish or garment construction, FOLLOW THE SHEET. Pose, body-part "
    "count and which garments the figure wears are not the sheet's to decide."
)

_STYLE_SHEET_FIREWALL = (
    "CRITICAL - the style sheet decides HOW things are made, never WHO the figure is "
    "or WHAT it wears. Not one colour, pattern, print, hairstyle, hair colour, skin "
    "tone, face or accessory from it may appear in the output, and never the specific "
    "garment a sheet character happens to wear. Which garments the figure wears, and "
    "in which colours, comes only from the source person. If the source person wears "
    "a red jacket and every character on the sheet wears blue, the output jacket is "
    "red. Take the construction and the craft from the sheet; take the content from "
    "the person."
)


def _compose_inputs(
    person_url: str,
    detail_sheet: Optional[PILImage.Image],
    style_sheet: Optional[PILImage.Image],
) -> Tuple[List[str], str]:
    """Pair every attachment with its role, numbered from what is actually sent.

    Numbering is derived from the list rather than written by hand so the prompt
    can never name an image the model did not receive.  The previous wording
    hard-coded the pose reference as "the final image"; adding the style sheet
    would have silently redirected that sentence onto the style sheet, telling the
    model to copy the reference characters' geometry.
    """
    parts: List[Tuple[str, str]] = [(person_url, _ROLE_PERSON)]
    if detail_sheet is not None:
        parts.append((_pil_to_data_url(detail_sheet), _ROLE_DETAIL))
    parts.append((_pil_to_data_url(_canonical_lego_pose()), _ROLE_POSE))
    if style_sheet is not None:
        parts.append((_pil_to_data_url(style_sheet), _ROLE_STYLE))

    text = "\n\n### HOW TO USE THE INPUT IMAGES\n" + "\n".join(
        f"Image {index}: {role}" for index, (_, role) in enumerate(parts, 1)
    )
    if style_sheet is not None:
        text += "\n\n" + _STYLE_SHEET_FIREWALL
    return [url for url, _ in parts], text


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
    # 優先序取本分支（風格註冊表可覆寫模型），但模型名本身改由 config 統一供應：
    # 直接讀 os.environ 會繞過 config 的空字串處理，且預設值散落在程式碼裡，
    # 正是 main 修掉「三條生成路徑全部 404」的原因。
    model = (
        (model_override or "").strip()
        or style.model_overrides.get("full_character", "").strip()
        or _resolve_model(_config.FULL_CHARACTER_MODEL, _config.OUTFIT_GEN_MODEL)
    )
    print(f"[garment_gen] start full-character (frame={w}x{h}, model={model}, remove_bg={remove_bg})")
    t_start = time.perf_counter()

    try:
        # Wide crop so head + arms + feet all sit inside the input frame.
        square, (x1, y1, x2, y2) = _crop_square_padded(
            rgb, body_poly_norm, pad_ratio=0.22, pad_ratio_x=0.30,
        )
        data_url = _pil_to_data_url(square)

        # 這條路徑刻意不使用護盾。
        #
        # 護盾是依「輸入照片」的人體多邊形畫出來的，但它被套用在「模型新生成
        # 的那張圖」上 —— 兩張圖的構圖、比例、姿勢都不同，多邊形與生成結果
        # 之間沒有任何對應關係。實測預設中央框會蓋住生成圖的 35%（x 192~832、
        # y 224~800），保護的幾乎全是背景而不是衣物，結果就是角色頂著一大片
        # 白色方塊出現在投影牆上。
        #
        # 白色衣物的保護改由連通性負責：背景是「連到畫面邊界」的白色，
        # 衣物上的白是被人偶包住的白，洪水填充本來就不會碰到後者。
        shield_mask = None

        prompt = style.full_prompt_template.format(
            attrs=_attr_lines(face_data, outfit_data)
        )
        if correction:
            prompt += "\n\n### REQUIRED CORRECTION\n" + correction
        input_urls, role_text = _compose_inputs(
            data_url,
            _build_detail_sheet(rgb, regions),
            _style_reference_sheet(),
        )
        prompt += role_text
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


# ─────────────────────────────────────────────────────────────────────────────
#  REFINE MODE — pass 2 on top of generate_full_character_png
# ─────────────────────────────────────────────────────────────────────────────


register_style(GenerationStyle(
    style_id="lego",
    full_prompt_template=_FULL_CHARACTER_PROMPT_TEMPLATE,
    supported_modes=frozenset({"full_character"}),
))
