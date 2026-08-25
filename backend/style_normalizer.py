"""Deterministic removal of directional lighting baked into a UV panel.

The renderer owns every light in the scene.  A print that also carries a key
light, ambient occlusion or a vignette lands on top of the render and doubles
it, which is what makes one generated character read as flat 2D and the next as
heavily shaded.

Flattening here is deliberately conservative in two ways:

* only a smooth low-order luminance field is removed, so patchy material
  weathering -- denim fade, soiling, distressing -- survives untouched.  That
  weathering is a large part of garment fidelity and must not be destroyed.
* the field is scaled by the *smallest* amount that brings the panel inside the
  shading budget.  A panel that is already clean is left byte-identical, which
  keeps the operation idempotent.

A panel that still exceeds the budget at full correction is not fixable by
flattening, and the caller is expected to fail it.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple

import cv2
import numpy as np

try:
    from backend.style_base import texture_gradient_budget  # type: ignore
except Exception:
    from style_base import texture_gradient_budget  # type: ignore


# Matches the measurement used for the reference render in style_base.py, so
# panel numbers and reference numbers stay directly comparable.
def directional_gradient(panel: np.ndarray) -> float:
    """Largest quartile-to-quartile luminance shift across a blurred panel."""
    if panel is None or panel.size == 0:
        return 0.0
    lab = cv2.cvtColor(panel, cv2.COLOR_BGR2LAB)
    light = lab[:, :, 0].astype(np.float32) / 255.0
    sigma = max(12.0, panel.shape[0] / 16.0)
    smooth = cv2.GaussianBlur(light, (0, 0), sigmaX=sigma)
    quarter_w = max(1, smooth.shape[1] // 4)
    quarter_h = max(1, smooth.shape[0] // 4)
    left, right = float(np.mean(smooth[:, :quarter_w])), float(np.mean(smooth[:, -quarter_w:]))
    top, bottom = float(np.mean(smooth[:quarter_h])), float(np.mean(smooth[-quarter_h:]))
    return max(abs(left - right), abs(top - bottom))


def _illumination_field(light: np.ndarray) -> Tuple[np.ndarray, float]:
    """Fit a second-order surface to the blurred luminance.

    Returns the fitted field and the fraction of blurred-luminance variance it
    explains.  A directional key light explains almost all of it; patchy
    weathering explains very little.
    """
    height, width = light.shape
    blurred = cv2.GaussianBlur(light, (0, 0), sigmaX=max(6.0, min(height, width) / 24.0))
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    x = (xx / max(1, width - 1)) * 2.0 - 1.0
    y = (yy / max(1, height - 1)) * 2.0 - 1.0
    terms = [np.ones_like(x), x, y, x * x, y * y, x * y]
    basis = np.stack([term.ravel() for term in terms], axis=1)
    values = blurred.ravel()

    # Trimming the extremes keeps bright print (text, numerals) and dark ink
    # from dragging the fitted plane away from the actual base material.
    low, high = np.percentile(values, (15, 85))
    selected = (values >= low) & (values <= high)
    if int(selected.sum()) < basis.shape[1] * 8:
        selected = np.ones_like(values, dtype=bool)

    coefficients, *_ = np.linalg.lstsq(basis[selected], values[selected], rcond=None)
    field = (basis @ coefficients).reshape(height, width)

    total = float(np.var(values))
    explained = 0.0 if total <= 1e-9 else max(0.0, 1.0 - float(np.var(values - field.ravel())) / total)
    return field, explained


def flatten_panel(panel: np.ndarray, budget: float | None = None) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Return the panel with baked directional lighting removed, plus metrics."""
    limit = float(texture_gradient_budget() if budget is None else budget)
    before = directional_gradient(panel)
    metrics: Dict[str, Any] = {
        "gradient_before": round(before, 4),
        "gradient_after": round(before, 4),
        "correction_strength": 0.0,
        "field_explained_variance": 0.0,
        "within_budget": before <= limit,
        "budget": round(limit, 4),
    }
    if panel is None or panel.size == 0 or before <= limit:
        return panel, metrics

    lab = cv2.cvtColor(panel, cv2.COLOR_BGR2LAB).astype(np.float32)
    light = lab[:, :, 0]
    field, explained = _illumination_field(light)
    metrics["field_explained_variance"] = round(explained, 4)
    residual = field - float(np.median(field))

    # Smallest correction that reaches the budget; never more than the fitted
    # field itself, so a panel can only lose lighting it actually had.
    best_strength, best_gradient, best_panel = 1.0, before, panel
    for step in range(1, 21):
        strength = step / 20.0
        candidate = lab.copy()
        candidate[:, :, 0] = np.clip(light - strength * residual, 0.0, 255.0)
        corrected = cv2.cvtColor(candidate.astype(np.uint8), cv2.COLOR_LAB2BGR)
        gradient = directional_gradient(corrected)
        if gradient < best_gradient:
            best_strength, best_gradient, best_panel = strength, gradient, corrected
        if gradient <= limit:
            break

    metrics.update({
        "gradient_after": round(best_gradient, 4),
        "correction_strength": round(best_strength, 3),
        "within_budget": best_gradient <= limit,
    })
    return best_panel, metrics


def flatten_panels(panels: Dict[str, np.ndarray], budget: float | None = None) -> Tuple[Dict[str, np.ndarray], Dict[str, Any]]:
    """Flatten a named set of panels and summarise what had to be corrected."""
    flattened: Dict[str, np.ndarray] = {}
    report: Dict[str, Any] = {"panels": {}, "corrected": [], "unfixable": []}
    for name, panel in panels.items():
        result, metrics = flatten_panel(panel, budget)
        flattened[name] = result
        report["panels"][name] = metrics
        if metrics["correction_strength"] > 0:
            report["corrected"].append(name)
        if not metrics["within_budget"]:
            report["unfixable"].append(name)
    report["corrected"].sort()
    report["unfixable"].sort()
    report["normalizer"] = "style_flatten_v1"
    return flattened, report
