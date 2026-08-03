"""Inject a synthetic high-detail CharacterSpec for browser render QA.

Usage:
    python backend/tools/e2e_render_fixture.py --request-id e2e-ai-detail
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import socketio

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.ai_texture_gen import ATLAS_SIZE, split_atlas_textures
from backend.generation_history import finish_run, start_run


def build_fixture(request_id: str) -> dict:
    atlas = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 3), dtype=np.uint8)
    atlas[:512, :512] = (168, 208, 255)
    atlas[:512, 512:] = (165, 92, 32)
    atlas[512:, :] = (42, 42, 46)

    # Face print: eyebrows, eyes, glasses and smile.
    for x in (205, 307):
        cv2.circle(atlas, (x, 235), 25, (20, 20, 24), 9)
        cv2.circle(atlas, (x, 235), 7, (245, 245, 245), -1)
    cv2.line(atlas, (170, 185), (235, 175), (26, 26, 30), 11)
    cv2.line(atlas, (278, 175), (343, 185), (26, 26, 30), 11)
    cv2.ellipse(atlas, (256, 330), (82, 38), 0, 0, 180, (25, 25, 30), 10)

    # Torso print: collar, zipper, seams, fine stripes and badge.
    cv2.line(atlas, (768, 45), (768, 468), (18, 32, 50), 10)
    cv2.line(atlas, (650, 45), (768, 140), (225, 230, 236), 12)
    cv2.line(atlas, (886, 45), (768, 140), (225, 230, 236), 12)
    for y in range(180, 440, 30):
        cv2.line(atlas, (555, y), (981, y), (205, 135, 75), 5)
    cv2.rectangle(atlas, (850, 170), (938, 245), (238, 238, 238), -1)
    cv2.circle(atlas, (894, 207), 24, (40, 90, 160), -1)

    # Separate left/right leg seams and subtle textile highlights.
    for x0 in (0, 512):
        cv2.line(atlas, (x0 + 255, 550), (x0 + 255, 985), (15, 15, 18), 9)
        for y in range(610, 960, 42):
            cv2.line(atlas, (x0 + 80, y), (x0 + 430, y), (58, 58, 64), 4)

    textures = split_atlas_textures(atlas)
    return {
        "schema_version": 2,
        "style_spec_version": 2,
        "material_version": 2,
        "character_id": request_id,
        "style_id": "brick_v1",
        "height_profile": "medium",
        "body_shape": {
            "height_scale": 1.0,
            "shoulder_width": 1.08,
            "torso_width": 1.06,
            "torso_depth": 1.03,
            "limb_thickness": 1.04,
            "confidence": 1.0,
        },
        "skin_color": "#FFD0A8",
        "hair": {"style": "short", "color": "#26150D"},
        "face": {"expression": "smile", "glasses": True, "beard": "none"},
        "outfit": {
            "upper_type": "jacket",
            "lower_type": "pants",
            "outer_type": "jacket",
            "upper_color": "#205CA5",
            "lower_color": "#2E2A2A",
            "arm_color": "#205CA5",
        },
        "textures": {
            **textures,
            "legs_front": textures["left_leg_front"],
        },
        "quality": {
            "capture_score": 1.0,
            "texture_confidence": 1.0,
            "fallback_used": False,
            "ai_texture_status": "enhanced",
            "ai_detail_score": 1.0,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-id", default="e2e-ai-detail")
    parser.add_argument("--backend", default="http://127.0.0.1:5001")
    args = parser.parse_args()

    spec = build_fixture(args.request_id)
    start_run(
        args.request_id,
        mode="brick_ai_texture",
        style_id="brick_v1",
        source_type="upload",
        comparison_id="synthetic-render-fixture",
    )
    finish_run(
        args.request_id,
        status="success",
        stage="ai_texture",
        height_class="medium",
        duration_ms=1,
        cv_ms=0,
        vlm_ms=0,
        generation_ms=0,
        retry_count=0,
        validation={"passed": True, "errors": [], "warnings": []},
        height_ratio=0.8,
        height_measurement_valid=True,
    )

    client = socketio.Client()
    client.connect(args.backend, transports=["polling"])
    client.emit("join_swarm", {
        "id": args.request_id,
        "x": 960,
        "y": 540,
        "character_spec": spec,
        "character_mode": "brick_ai_texture",
        "height_class": "medium",
        "height_measurement_valid": True,
        "style_id": "brick_v1",
    })
    time.sleep(0.5)
    client.disconnect()
    print(args.request_id)


if __name__ == "__main__":
    main()
