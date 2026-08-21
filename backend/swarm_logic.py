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
_MARGIN = 80.0          # Distance from border where soft turn force begins
_MARGIN_TURN_FORCE = 0.4
_GREETING_DURATION = 15 # Number of ticks (~1.5s) to stay in GREETING state after encounter
_GREETING_DAMPING = 0.35 # Speed multiplier when greeting (slow down to wave)


def _limit(vx: float, vy: float, max_val: float):
    mag = math.sqrt(vx * vx + vy * vy)
    if mag > max_val and mag > 0:
        return vx / mag * max_val, vy / mag * max_val
    return vx, vy


def update_swarm_state(characters, *, width: float = 1920, height: float = 1080):
    """
    Boids: separation, alignment, cohesion with soft boundary avoidance & greeting hold.
    Input: list of dicts with {id, x, y, vx?, vy?, greeting_ticks?}
    Returns updated list with {x, y, vx, vy, state, greeting_ticks} merged in.
    """
    if not characters:
        return characters

    updated = []
    for i, c in enumerate(characters):
        # Ensure vx and vy are floats
        vx = c.get("vx")
        if vx is None:
            vx = random.uniform(-1.0, 1.0)
        vy = c.get("vy")
        if vy is None:
            vy = random.uniform(-1.0, 1.0)

        x_cur = float(c.get("x", 960.0))
        y_cur = float(c.get("y", 540.0))
        greeting_ticks = int(c.get("greeting_ticks", 0))

        sep_x = sep_y = 0.0
        sep_n = 0
        ali_vx = ali_vy = 0.0
        ali_n = 0
        coh_x = coh_y = 0.0
        coh_n = 0
        near_neighbor = False

        for j, other in enumerate(characters):
            if i == j:
                continue
            ox = float(other.get("x", 0.0))
            oy = float(other.get("y", 0.0))
            dx = x_cur - ox
            dy = y_cur - oy
            dist = math.sqrt(dx * dx + dy * dy) + 1e-6

            if dist < GREETING_DIST:
                near_neighbor = True
            if dist < _SEP_RADIUS:
                sep_x += dx / dist
                sep_y += dy / dist
                sep_n += 1
            if dist < _ALI_RADIUS:
                ali_vx += float(other.get("vx", 0.0))
                ali_vy += float(other.get("vy", 0.0))
                ali_n += 1
            if dist < _COH_RADIUS:
                coh_x += ox
                coh_y += oy
                coh_n += 1

        # Greeting state machine with hold timer
        if near_neighbor:
            greeting_ticks = _GREETING_DURATION
        elif greeting_ticks > 0:
            greeting_ticks -= 1

        is_greeting = greeting_ticks > 0

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
            tx, ty = _limit(coh_x / coh_n - x_cur, coh_y / coh_n - y_cur, _MAX_FORCE)
            fx += tx * _COH_WEIGHT
            fy += ty * _COH_WEIGHT

        # Slight random wander force for natural organic movement
        fx += random.uniform(-0.05, 0.05)
        fy += random.uniform(-0.05, 0.05)

        # Soft boundary repulsion so characters steer smoothly away from projection edges
        if x_cur < _MARGIN:
            fx += _MARGIN_TURN_FORCE * (1.0 - x_cur / _MARGIN)
        elif x_cur > width - _MARGIN:
            fx -= _MARGIN_TURN_FORCE * (1.0 - (width - x_cur) / _MARGIN)

        if y_cur < _MARGIN:
            fy += _MARGIN_TURN_FORCE * (1.0 - y_cur / _MARGIN)
        elif y_cur > height - _MARGIN:
            fy -= _MARGIN_TURN_FORCE * (1.0 - (height - y_cur) / _MARGIN)

        # Slow down slightly when greeting (waving pose)
        speed_limit = _MAX_SPEED * _GREETING_DAMPING if is_greeting else _MAX_SPEED
        vx, vy = _limit(vx + fx, vy + fy, speed_limit)

        new_x = x_cur + vx
        new_y = y_cur + vy

        # Hard boundary bounce/clamp as safety fallback
        if new_x < 0:
            new_x = 0
            vx = abs(vx)
        elif new_x > width:
            new_x = width
            vx = -abs(vx)

        if new_y < 0:
            new_y = 0
            vy = abs(vy)
        elif new_y > height:
            new_y = height
            vy = -abs(vy)

        nc = {
            **c,
            "x": round(new_x, 2),
            "y": round(new_y, 2),
            "vx": round(vx, 3),
            "vy": round(vy, 3),
            "state": "GREETING" if is_greeting else "ROAMING",
            "greeting_ticks": greeting_ticks,
        }
        updated.append(nc)

    return updated

