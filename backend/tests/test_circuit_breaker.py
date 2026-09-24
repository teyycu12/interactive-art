import time
import unittest
from backend.circuit_breaker import CircuitBreaker, CircuitBreakerOpenException
from service import _raise_on_failure


class TestCircuitBreaker(unittest.TestCase):
    def setUp(self):
        self.breaker = CircuitBreaker("test_breaker", failure_threshold=2, recovery_timeout=0.1)

    def test_normal_successful_call(self):
        def good_fn(x, y):
            return x + y

        result = self.breaker.call(good_fn, 3, 5)
        self.assertEqual(result, 8)
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_CLOSED)

    def test_trips_to_open_after_threshold(self):
        def bad_fn():
            raise RuntimeError("API network down")

        # 1st failure (with 1 retry)
        with self.assertRaises(RuntimeError):
            self.breaker.call(bad_fn, max_retries=0)
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_CLOSED)

        # 2nd failure -> should trip to OPEN
        with self.assertRaises(RuntimeError):
            self.breaker.call(bad_fn, max_retries=0)
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_OPEN)

        # 3rd call should fast-fail with CircuitBreakerOpenException without running func
        with self.assertRaises(CircuitBreakerOpenException):
            self.breaker.call(bad_fn, max_retries=0)

    def test_fallback_when_open(self):
        def bad_fn():
            raise ValueError("Error")

        # Force state to open
        self.breaker.record_failure()
        self.breaker.record_failure()
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_OPEN)

        # Call with fallback
        result = self.breaker.call(bad_fn, fallback={"ok": False, "fallback": True})
        self.assertEqual(result, {"ok": False, "fallback": True})

    def test_recovery_to_half_open_and_closed(self):
        self.breaker.record_failure()
        self.breaker.record_failure()
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_OPEN)

        # Wait for recovery_timeout (0.1s)
        time.sleep(0.12)
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_HALF_OPEN)

        # Successful probe call resets to CLOSED
        def good_fn():
            return "recovered"

        res = self.breaker.call(good_fn)
        self.assertEqual(res, "recovered")
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_CLOSED)


if __name__ == "__main__":
    unittest.main()


class TestRaiseOnFailure(unittest.TestCase):
    """{ok: False} 必須被熔斷器算成失敗。

    circuit_breaker.call 只在 func 拋例外時 record_failure()，正常回傳一律
    record_success()。而 analyze_outfit / analyze_face 把所有例外都吞掉、改回
    {"ok": False, "error": ...}。少了這層轉換，熔斷器永遠不會累積失敗、
    永遠不會跳開 —— Gemini 全掛時每個參與者仍各自等滿一次逾時。
    """

    def setUp(self):
        self.breaker = CircuitBreaker("vlm_test", failure_threshold=2, recovery_timeout=0.1)

    def test_passes_through_success(self):
        ok = {"ok": True, "outfit": {"inner": "hoodie"}}
        self.assertEqual(_raise_on_failure(lambda _: ok, "img"), ok)

    def test_converts_ok_false_to_exception(self):
        with self.assertRaises(RuntimeError):
            _raise_on_failure(lambda _: {"ok": False, "error": "quota"}, "img")

    def test_breaker_opens_after_repeated_ok_false(self):
        failing = lambda _: {"ok": False, "error": "quota"}
        fallback = {"ok": False, "error": "circuit_open"}
        for _ in range(2):
            self.breaker.call(_raise_on_failure, failing, "img",
                              max_retries=0, fallback=fallback)
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_OPEN,
                         "連續失敗後熔斷器必須跳開，否則整段保護是死的")

    def test_breaker_stays_closed_without_the_wrapper(self):
        """對照組：直接把原函式交給熔斷器，它會把失敗當成功。"""
        failing = lambda _: {"ok": False, "error": "quota"}
        for _ in range(5):
            self.breaker.call(failing, "img", max_retries=0, fallback=None)
        self.assertEqual(self.breaker.state, CircuitBreaker.STATE_CLOSED)
