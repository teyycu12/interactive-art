"""拍攝閘門時序判定的測試。

這裡驗的是跨影格的規則：連續幾幀不動才算穩、身高要連續幾幀落在同一範圍。
單張影格好不好由 capture_quality 負責，不在這裡。
"""

import re
import time
from pathlib import Path

import pytest

from backend import capture_session
from backend.capture_session import SessionStore, new_session, update


def frame(*, ready=True, height_ratio=None, valid=None, **extra):
    f = {"ok": True, "capture_ready_raw": ready, "capture_quality": {"capture_checks": {}}}
    if height_ratio is not None:
        f["height_ratio"] = height_ratio
        f["height_measurement_valid"] = valid if valid is not None else True
    f.update(extra)
    return f


class TestThresholdsMatchAppPy:
    """app.py 仍有自己一份實作 —— 門檻漂移不會有任何錯誤訊息。

    兩邊各自演化的話，同一個站姿在 2D 備援版與整合版控制器會得到不同的判定，
    表現出來只是「兩個入口拍出來的角色品質不一樣」，沒有人會聯想到門檻。
    """

    def test_defaults_are_identical(self):
        # 路徑相對於本檔而非工作目錄：CI 是 `cd backend && pytest tests/`，
        # 本機習慣從根目錄跑 `pytest backend/` —— 寫死 "backend/app.py"
        # 只在後者成立，前者會以 FileNotFoundError 失敗。
        app_py = Path(__file__).resolve().parents[1] / "app.py"
        src = app_py.read_text(encoding="utf-8")
        for name, ours in (
            ("CAPTURE_STABLE_FRAMES", capture_session.STABLE_FRAMES),
            ("CAPTURE_MOTION_MAX", capture_session.MOTION_MAX),
            ("HEIGHT_STABLE_FRAMES", capture_session.HEIGHT_STABLE_FRAMES),
            ("HEIGHT_RATIO_SPAN_MAX", capture_session.HEIGHT_RATIO_SPAN_MAX),
        ):
            m = re.search(rf'getenv\("{name}", "([0-9.]+)"\)', src)
            assert m, f"app.py 找不到 {name}，實作可能已改名"
            assert float(m.group(1)) == pytest.approx(float(ours)), \
                f"{name} 在 app.py 與 capture_session 不一致"


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


class TestSharpnessGate:
    """模糊只在「其他都站好了」之後才擋人。

    這個順序是刻意的：模糊靠站穩重拍就能解決，太早提示會蓋掉
    「請露出雙腳」那類更該先處理的訊息。
    """

    def _settle(self, sharp_ok=None):
        live = new_session()
        quality = {"capture_checks": {}}
        if sharp_ok is not None:
            quality["sharpness_ok"] = sharp_ok
        features = None
        for _ in range(8):
            f = frame(height_ratio=0.50)
            f["height_station_valid"] = True
            f["capture_quality"] = dict(quality)
            features = update(live, f, 0.0, classify_height=lambda r: "mid")
        return features

    def test_sharp_capture_is_ready(self):
        features = self._settle(sharp_ok=True)
        assert features["capture_ready"] is True
        assert features["guidance_reason"] == "ready"

    def test_blurry_capture_is_blocked_with_actionable_guidance(self):
        """擋下來的理由要說得出下一步，否則參與者只會反覆按同一個鍵。"""
        features = self._settle(sharp_ok=False)
        assert features["capture_ready"] is False
        assert features["guidance_reason"] == "too_blurry"

    def test_unmeasured_sharpness_never_blocks(self):
        """量不到就擋人，等於把降級路徑變成死路（CLAUDE.md：一律降級不擋人）。"""
        features = self._settle(sharp_ok=None)
        assert features["capture_ready"] is True
        assert features["guidance_reason"] == "ready"

    def test_blur_does_not_preempt_a_pose_problem(self):
        """站姿還沒過的時候，訊息要留給站姿，不能被模糊蓋掉。"""
        live = new_session()
        f = frame(ready=False, height_ratio=0.50)
        f["capture_quality"] = {"capture_checks": {}, "sharpness_ok": False}
        features = update(live, f, 0.0, classify_height=lambda r: "mid")
        assert features["capture_ready"] is False
        # raw_ready 未過時 update() 不覆寫 guidance_reason，交給上游那份
        # （cv_module 的 pose_incomplete / show_feet 等）——重點是別變成 too_blurry。
        assert features.get("guidance_reason") != "too_blurry"
