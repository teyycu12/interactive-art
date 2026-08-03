"""Map open-ended clothing labels onto a finite brick_v2 geometry grammar.

AI may classify garments and paint their print maps, but it never invents the
character silhouette.  This module selects deterministic geometry attachments
that remain inside the shared brick species.
"""

from __future__ import annotations

from typing import Any, Dict


def _tokens(outfit: Dict[str, Any]) -> str:
    return " ".join(str(value or "").strip().lower() for value in (
        outfit.get("inner"), outfit.get("outer"), outfit.get("lower"),
        outfit.get("upper_type"), outfit.get("outer_type"), outfit.get("lower_type"),
        outfit.get("fit"), outfit.get("sleeve_length"), outfit.get("legwear"),
    ))


def derive_garment_geometry(outfit: Dict[str, Any]) -> Dict[str, Any]:
    text = _tokens(outfit)
    outer = str(outfit.get("outer") or outfit.get("outer_type") or "none").lower()
    lower = str(outfit.get("lower") or outfit.get("lower_type") or "pants").lower()
    inner = str(outfit.get("inner") or outfit.get("upper_type") or "tshirt").lower()

    if any(word in text for word in ("sleeveless", "tank", "vest_top")):
        sleeve_profile = "sleeveless"
    elif any(word in text for word in ("long_sleeve", "hoodie", "sweater", "coat", "jacket", "blazer", "cardigan")):
        sleeve_profile = "long"
    else:
        sleeve_profile = "short"

    if any(word in outer for word in ("coat", "trench", "parka")):
        outer_shell = "long_coat"
    elif "hood" in outer or "hood" in inner:
        outer_shell = "hoodie"
    elif any(word in outer for word in ("jacket", "blazer", "cardigan")):
        outer_shell = "jacket"
    elif "vest" in outer:
        outer_shell = "vest"
    else:
        outer_shell = "none"

    if "dress" in text:
        lower_shell = "dress_skirt"
    elif "skirt" in lower:
        lower_shell = "skirt"
    elif "short" in lower:
        lower_shell = "shorts"
    else:
        lower_shell = "trousers"

    if any(word in text for word in ("tights", "stockings", "pantyhose")):
        legwear = "tights"
    elif "leggings" in text:
        legwear = "leggings"
    else:
        legwear = "bare" if lower_shell in {"skirt", "dress_skirt", "shorts"} else "covered"

    if any(word in text for word in ("oversized", "loose", "relaxed")):
        fit = "relaxed"
    elif any(word in text for word in ("slim", "fitted", "skinny")):
        fit = "slim"
    else:
        fit = "regular"

    attachments = []
    if outer_shell == "hoodie":
        attachments.append("hood")
    elif outer_shell == "long_coat":
        attachments.append("coat_tail")
    if lower_shell in {"skirt", "dress_skirt"}:
        attachments.append("skirt_shell")

    return {
        "grammar_version": 1,
        "upper_shell": "canonical_torso",
        "outer_shell": outer_shell,
        "lower_shell": lower_shell,
        "legwear": legwear,
        "sleeve_profile": sleeve_profile,
        "fit": fit,
        "attachments": attachments,
        "source_labels": {"inner": inner, "outer": outer, "lower": lower},
        "rule": "deterministic_parts_only",
    }
