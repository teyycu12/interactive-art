"""Generation-style registry. LEGO is the only installed style for now."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Mapping


@dataclass(frozen=True)
class GenerationStyle:
    style_id: str
    body_prompt: str
    full_prompt_template: str
    refine_prompt: str
    negative_prompt: str
    supported_modes: FrozenSet[str]
    model_overrides: Mapping[str, str] = field(default_factory=dict)
    generation_params: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)


_STYLES: Dict[str, GenerationStyle] = {}


def register_style(style: GenerationStyle) -> None:
    _STYLES[style.style_id] = style


def get_style(style_id: str) -> GenerationStyle:
    if style_id in _STYLES:
        return _STYLES[style_id]
    if "lego" not in _STYLES:
        raise RuntimeError("LEGO generation style has not been registered")
    return _STYLES["lego"]


def get_event_style_id() -> str:
    requested = os.environ.get("CHARACTER_STYLE", "lego").strip().lower()
    return requested if requested in _STYLES else "lego"
