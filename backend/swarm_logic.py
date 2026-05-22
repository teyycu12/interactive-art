import math
import random

_SEP_RADIUS = 80.0
_ALI_RADIUS = 150.0
_COH_RADIUS = 200.0
_SEP_WEIGHT = 1.5
_ALI_WEIGHT = 1.0
_COH_WEIGHT = 1.0
_MAX_SPEED = 2.0
_MAX_FORCE = 0.3
GREETING_DIST = 80.0


def _limit(vx: float, vy: float, max_val: float):
    mag = math.sqrt(vx * vx + vy * vy)
    if mag > max_val and mag > 0:
        return vx / mag * max_val, vy / mag * max_val
    return vx, vy


def update_swarm_state(characters, *, width: float = 1920, height: float = 1080):
    """
    Boids: separation, alignment, cohesion.
    Input: list of dicts with {id, x, y, vx?, vy?}
    Returns updated list with {x, y, vx, vy, state} merged in.
    """
    if not characters:
        return characters

    updated = []
    for i, c in enumerate(characters):
        # Ensure vx and vy are floats
        vx = c.get("vx")
        if vx is None: vx = random.uniform(-1.0, 1.0)
        vy = c.get("vy")
        if vy is None: vy = random.uniform(-1.0, 1.0)

        sep_x = sep_y = 0.0
        sep_n = 0
        ali_vx = ali_vy = 0.0
        ali_n = 0
        coh_x = coh_y = 0.0
        coh_n = 0
        greeting = False

        for j, other in enumerate(characters):
            if i == j:
                continue
            ox = other.get("x", 0.0)
            oy = other.get("y", 0.0)
            dx = c.get("x", 0.0) - ox
            dy = c.get("y", 0.0) - oy
            dist = math.sqrt(dx * dx + dy * dy) + 1e-6

            if dist < GREETING_DIST:
                greeting = True
            if dist < _SEP_RADIUS:
                sep_x += dx / dist
                sep_y += dy / dist
                sep_n += 1
            if dist < _ALI_RADIUS:
                ali_vx += other.get("vx", 0.0)
                ali_vy += other.get("vy", 0.0)
                ali_n += 1
            if dist < _COH_RADIUS:
                coh_x += ox
                coh_y += oy
                coh_n += 1

        fx = fy = 0.0
        if sep_n:
            sx, sy = _limit(sep_x / sep_n, sep_y / sep_n, _MAX_FORCE)
            fx += sx * _SEP_WEIGHT
            fy += sy * _SEP_WEIGHT
        if ali_n:
            ax, ay = _limit(ali_vx / ali_n - vx, ali_vy / ali_n - vy, _MAX_FORCE)
            fx += ax * _ALI_WEIGHT
            fy += ay * _ALI_WEIGHT
        if coh_n:
            tx, ty = _limit(coh_x / coh_n - c.get("x", 0.0), coh_y / coh_n - c.get("y", 0.0), _MAX_FORCE)
            fx += tx * _COH_WEIGHT
            fy += ty * _COH_WEIGHT

        vx, vy = _limit(vx + fx, vy + fy, _MAX_SPEED)
        x = (c.get("x", 0.0) + vx) % width
        y = (c.get("y", 0.0) + vy) % height

        nc = {**c, "x": x, "y": y, "vx": vx, "vy": vy,
              "state": "GREETING" if greeting else "ROAMING"}
        updated.append(nc)

    return updated
