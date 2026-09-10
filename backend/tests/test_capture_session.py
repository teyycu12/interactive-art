"""拍攝閘門時序判定的測試。

這裡驗的是跨影格的規則：連續幾幀不動才算穩、身高要連續幾幀落在同一範圍。
單張影格好不好由 capture_quality 負責，不在這裡。
"""

import re
import time

from backend import capture_session
from backend.capture_session import SessionStore, new_session, update


def frame(*, ready=True, height_ratio=None, valid=None, **extra):
    f = {"ok": True, "capture_ready_raw": ready, "capture_quality": {"capture_checks": {}}}
    if height_ratio is not None:
        f["height_ratio"] = height_ratio
        f["height_measurement_valid"] = valid if valid is not None else True
    f.update(extra)
    return f


class TestStability:
    def test_needs_consecutive_still_frames(self):
        live = new_session()
        for i in range(capture_session.STABLE_FRAMES - 1):
            f = update(live, frame(), 0.001)
            assert not f["capture_ready"], f"第 {i + 1} 幀就宣告可拍攝"
        f = update(live, frame(), 0.001)
        assert f["stability_count"] >= capture_session.STABLE_FRAMES

    def test_movement_resets_the_window(self):
        live = new_session()
        for _ in range(capture_session.STABLE_FRAMES):
            update(live, frame(), 0.001)
        f = update(live, frame(), capture_session.MOTION_MAX * 10)
        assert f["stability_count"] == 0, "動了就必須從頭數起"

    def test_leaving_the_frame_clears_the_window(self):
        """人走出去再走回來，不得沿用走出去之前的計數。"""
        live = new_session()
        for _ in range(capture_session.STABLE_FRAMES):
            update(live, frame(), 0.001)
        update(live, frame(ready=False), None)
        f = update(live, frame(), 0.001)
        assert f["stability_count"] == 1

    def test_first_frame_counts_as_zero_movement(self):
        """第一幀沒有前一幀可比。捨棄它會讓計數永遠少一格。"""
        live = new_session()
        f = update(live, frame(), None)
        assert f["stability_count"] == 1


class TestHeightWindow:
    def test_needs_consecutive_consistent_samples(self):
        live = new_session()
        for _ in range(capture_session.HEIGHT_STABLE_FRAMES - 1):
            f = update(live, frame(height_ratio=0.80), 0.0)
            assert not f["height_measurement_ready"]
        f = update(live, frame(height_ratio=0.80), 0.0)
        assert f["height_measurement_ready"]

    def test_wide_span_is_not_ready(self):
        live = new_session()
        span = capture_session.HEIGHT_RATIO_SPAN_MAX
        for r in (0.80, 0.80 + span * 0.9, 0.80 + span * 1.8):
            f = update(live, frame(height_ratio=r), 0.0)
        assert not f["height_measurement_ready"], "跨距過大不得算量到"

    def test_outlier_restarts_the_window(self):
        """換人或遮罩跳動時整個視窗重來，不得把兩個人的身高平均起來。"""
        live = new_session()
        for _ in range(capture_session.HEIGHT_STABLE_FRAMES):
            update(live, frame(height_ratio=0.80), 0.0)
        f = update(live, frame(height_ratio=0.80 + capture_session.HEIGHT_OUTLIER_JUMP * 2), 0.0)
        assert f["height_sample_count"] == 1
        assert not f["height_measurement_ready"]

    def test_invalid_measurement_clears_trusted_value(self):
        live = new_session()
        for _ in range(capture_session.HEIGHT_STABLE_FRAMES):
            update(live, frame(height_ratio=0.80), 0.0)
        assert live.get("trusted_height_class") is not None or "trusted_height_ratio" in live
        update(live, frame(height_ratio=0.80, valid=False), 0.0)
        assert "trusted_height_ratio" not in live

    def test_classify_height_is_injected_not_imported(self):
        live = new_session()
        f = update(live, frame(height_ratio=0.80), 0.0, classify_height=lambda r: "tall")
        assert f["height_class"] == "tall"


class TestReadyRequiresEverything:
    def test_stable_but_no_height_is_not_ready(self):
        live = new_session()
        for _ in range(capture_session.STABLE_FRAMES + 2):
            f = update(live, frame(), 0.0)
        assert f["stability_count"] >= capture_session.STABLE_FRAMES
        assert not f["capture_ready"], "沒量到身高不得宣告可拍攝"
        assert f["guidance_reason"] == "hold_still"

    def test_all_conditions_met(self):
        live = new_session()
        for _ in range(max(capture_session.STABLE_FRAMES, capture_session.HEIGHT_STABLE_FRAMES)):
            f = update(live, frame(height_ratio=0.80), 0.0)
        assert f["capture_ready"]
        assert f["guidance_reason"] == "ready"


class TestSessionStore:
    def test_ids_are_server_assigned_and_unguessable(self):
        store = SessionStore()
        ids = {store.new_id() for _ in range(50)}
        assert len(ids) == 50
        assert all(re.fullmatch(r"[0-9a-f]{32}", i) for i in ids)

    def test_sessions_do_not_leak_between_people(self):
        """兩個人同時在拍照，穩定度計數不得互相污染。"""
        store = SessionStore()
        a, b = store.new_id(), store.new_id()
        live_a = store.get(a)
        for _ in range(capture_session.STABLE_FRAMES):
            update(live_a, frame(), 0.0)
        store.put(a, live_a)

        live_b = store.get(b)
        f = update(live_b, frame(), 0.0)
        store.put(b, live_b)
        assert f["stability_count"] == 1

    def test_unknown_id_gets_a_fresh_session(self):
        store = SessionStore()
        assert store.get("f" * 32)["stable_count"] == 0

    def test_expired_sessions_are_swept(self):
        store = SessionStore(ttl_sec=0.01)
        sid = store.new_id()
        store.put(sid, new_session())
        time.sleep(0.05)
        store.get("other")          # 任一次存取都會觸發清掃
        assert len(store) == 0

    def test_store_is_bounded(self):
        """沒有上限的話，每個曾經開過鏡頭的人都會永遠留在記憶體裡。"""
        store = SessionStore(max_sessions=8)
        for _ in range(40):
            store.put(store.new_id(), new_session())
        assert len(store) <= 8
