# PersonaFlow Brick v1

`brick_ai_texture` is the production character path. It combines an original,
fixed procedural 3D figure with AI-generated face and clothing materials.
The deterministic material is an internal pending preview only; it is not a
selectable or admissible formal result. Historical `body_sprite` and
`full_character` records remain visible in the developer dashboard.

## Runtime flow

1. `generate_avatar` runs the existing MediaPipe/OpenCV capture analysis.
2. Outfit and face VLM calls run in parallel with a shared six-second deadline.
   If they time out, the local CV result still produces a usable character.
3. `backend/character_spec.py` immediately creates a version 2 pending spec,
   bounded body-shape parameters and deterministic 512×512 WebP materials.
4. `backend/ai_texture_gen.py` sends the source photo, fixed 2×2 atlas guide and
   a person-free brick_v1 Style Anchor to the configured Pro image model. The model
   paints face, torso, left-leg and right-leg material panels; it never creates
   character geometry.
5. The returned atlas must pass registration, colour, flat-lighting, face-detail,
   outfit-fidelity and species-compliance checks. A valid atlas becomes material
   version 2. An invalid/failed atlas reports `ai_texture_status: "failed"` and
   cannot enter the formal projection. Failed attempts remain in developer history.
6. `join_swarm` stores that immutable specification once. Regular
   `update_positions` ticks omit the specification and texture data.
7. `projection3d.html` creates the fixed 3D geometry, applies the textures and
   maps the existing Boids `x/y` plane into the Three.js `x/z` world.

The source camera frame is not stored locally, but `brick_ai_texture` does send
it to the configured remote image-model provider.

## CharacterSpec v2

Required identity fields:

- `schema_version: 2` and `style_spec_version: 2`
- stable `character_id`
- `style_id: "brick_v1"`
- `height_profile: short | medium | tall`
- skin, hair, face and outfit attributes
- bounded `body_shape` values for height, shoulders, torso and limbs
- deterministic torso/lower pending WebP textures
- optional AI `face_decal`, `torso_front`, `left_leg_front` and
  `right_leg_front` WebP textures
- `material_version` for renderer hot replacement
- capture/texture confidence and fallback status

The schema is validated before `avatar_generated` is emitted. Low-confidence
shape observations move toward the canonical proportions. Formal admission is
allowed only after a validated AI atlas is attached.

## Projection controls

- Main 3D wall: `http://127.0.0.1:8000/projection3d.html`
- Three.js／AI Atlas 載入失敗時顯示失敗，不建立或切換至2D格柵替代角色。
- 舊 `projection.html` 僅保留供歷史相容檢查，不屬於正式流程。

The renderer caps device pixel ratio at 1.5, shares geometry, and renders hands
and feet with dynamic `InstancedMesh` pools for up to 128 simultaneous
characters. The top-left HUD shows the live character count and FPS.

## A/B metrics

The historical baseline in `backend/logs/generation_history.sqlite3` was:

| Mode | Samples | Median total | Median generation |
|---|---:|---:|---:|
| `body_sprite` | 3 | 28.09 s | 24.82 s |
| `full_character` | 11 | 27.48 s | 26.31 s |
| `full_character_refined` (legacy, removed) | 1 | 44.80 s | 43.96 s |

For the formal hybrid mode, track capture-to-pending and capture-to-AI-final
separately, plus species compliance, face detail, outfit fidelity, failure rate,
3D wall FPS, blind-review scores, P50/P95 latency and cost per accepted character.

## Validation

```powershell
python -m unittest discover -s backend\tests -v
```

`test_character_spec.py` covers deterministic fallback output.
`test_ai_texture_gen.py` covers atlas validation, split WebP materials and
material versioning. `test_m2_flow.py` verifies that formal mode emits base then
AI-enhanced specs without calling the old full-character generator.
