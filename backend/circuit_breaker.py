"""
API 熔斷器與退避重試模組 (Circuit Breaker & Retry)。

保護外部 API (Gemini VLM / OpenRouter Image Gen) 呼叫。
當外部 API 發生連續錯誤或超時達到門檻時自動進入 OPEN (熔斷) 狀態，
直接快速失敗或回傳 fallback，避免執行緒池持續被無效等待卡死。
在冷卻時間過後自動進入 HALF_OPEN 狀態試探復原。
"""

import functools
import threading
import time
from typing import Any, Callable, Dict, Optional


class CircuitBreakerOpenException(Exception):
    """當熔斷器處於開啟狀態且拒絕外部呼叫時拋出。"""
    pass


class CircuitBreaker:
    STATE_CLOSED = "CLOSED"        # 正常運作
    STATE_OPEN = "OPEN"            # 熔斷中，阻斷請求
    STATE_HALF_OPEN = "HALF_OPEN"  # 試探復原中

    def __init__(
        self,
        name: str = "default",
        failure_threshold: int = 3,
        recovery_timeout: float = 30.0,
        expected_exceptions: tuple = (Exception,),
    ):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.expected_exceptions = expected_exceptions

        self._state = self.STATE_CLOSED
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._last_state_change = time.time()
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        with self._lock:
            # 如果處於 OPEN 且已超過冷卻時間，自動轉為 HALF_OPEN 試探
            if self._state == self.STATE_OPEN:
                if time.time() - self._last_failure_time >= self.recovery_timeout:
                    self._state = self.STATE_HALF_OPEN
                    self._last_state_change = time.time()
                    print(f"[circuit_breaker:{self.name}] State changed: OPEN -> HALF_OPEN (probing)")
            return self._state

    def record_success(self) -> None:
        with self._lock:
            if self._state in (self.STATE_HALF_OPEN, self.STATE_OPEN):
                print(f"[circuit_breaker:{self.name}] Probe succeeded! State changed: {self._state} -> CLOSED")
            self._state = self.STATE_CLOSED
            self._failure_count = 0
            self._last_state_change = time.time()

    def record_failure(self, exception: Optional[Exception] = None) -> None:
        with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.time()

            if self._state == self.STATE_HALF_OPEN:
                # 試探失敗，立即再次熔斷
                self._state = self.STATE_OPEN
                self._last_state_change = time.time()
                print(f"[circuit_breaker:{self.name}] Probe failed. State changed: HALF_OPEN -> OPEN ({exception})")
            elif self._state == self.STATE_CLOSED and self._failure_count >= self.failure_threshold:
                self._state = self.STATE_OPEN
                self._last_state_change = time.time()
                print(f"[circuit_breaker:{self.name}] Threshold reached ({self._failure_count} failures). State changed: CLOSED -> OPEN ({exception})")

    def call(
        self,
        func: Callable[..., Any],
        *args: Any,
        fallback: Optional[Any] = None,
        max_retries: int = 1,
        base_delay: float = 0.3,
        **kwargs: Any,
    ) -> Any:
        """
        透過熔斷器執行函式。
        若熔斷器處於 OPEN 狀態：
            - 若有提供 fallback，回傳 fallback 或呼叫 fallback()
            - 否則拋出 CircuitBreakerOpenException
        若處於 CLOSED / HALF_OPEN：
            - 執行 func，若失敗且 max_retries > 0 則以指數退避重試。
        """
        current_state = self.state
        if current_state == self.STATE_OPEN:
            print(f"[circuit_breaker:{self.name}] Circuit is OPEN. Fast-failing request.")
            if fallback is not None:
                return fallback(*args, **kwargs) if callable(fallback) else fallback
            raise CircuitBreakerOpenException(f"Circuit breaker '{self.name}' is OPEN")

        attempts = 0
        while True:
            try:
                result = func(*args, **kwargs)
                self.record_success()
                return result
            except self.expected_exceptions as e:
                attempts += 1
                if attempts <= max_retries:
                    delay = base_delay * (2 ** (attempts - 1))
                    print(f"[circuit_breaker:{self.name}] Call failed ({e}). Retrying in {delay:.2f}s ({attempts}/{max_retries})...")
                    time.sleep(delay)
                else:
                    self.record_failure(e)
                    if fallback is not None:
                        return fallback(*args, **kwargs) if callable(fallback) else fallback
                    raise e

    def reset(self) -> None:
        """手動重設熔斷器狀態為 CLOSED。"""
        with self._lock:
            self._state = self.STATE_CLOSED
            self._failure_count = 0
            self._last_state_change = time.time()


# 全域單例實例方便共用
gemini_breaker = CircuitBreaker("gemini_api", failure_threshold=3, recovery_timeout=20.0)
image_gen_breaker = CircuitBreaker("image_gen_api", failure_threshold=3, recovery_timeout=20.0)
