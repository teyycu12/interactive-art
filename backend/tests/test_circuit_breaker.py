import time
import unittest
from backend.circuit_breaker import CircuitBreaker, CircuitBreakerOpenException


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
