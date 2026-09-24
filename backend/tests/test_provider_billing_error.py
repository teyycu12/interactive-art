"""A provider 402 is a billing state and has to read as one, end to end.

Before this, running out of OpenRouter credits surfaced as a fifteen-line stack
trace in the terminal and "生圖服務沒有回傳圖片…請稍後重試" in the UI. Both
were wrong in the same way: they described a transient fault. The request never
reached the model -- the provider reserves budget against max_tokens and refuses
at the door in under two seconds -- so retrying burns the operator's time on
something that cannot succeed until the balance moves.
"""

import unittest
from types import SimpleNamespace
from unittest import mock

from backend.garment_gen import _call_image_chat_multi, _provider_message


class _Refused(Exception):
    """Shaped like the SDK's APIStatusError for a 402."""

    status_code = 402
    body = {"error": {"message": "This request requires more credits, or fewer "
                                 "max_tokens. You requested up to 32768 tokens, "
                                 "but can only afford 21724."}}


class _Broke(Exception):
    status_code = 500


def _client_raising(exc: Exception):
    def create(**_kwargs):
        raise exc
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


class ProviderMessageTests(unittest.TestCase):
    def test_pulls_the_providers_own_sentence_out_of_the_wrapper(self):
        self.assertTrue(_provider_message(_Refused()).startswith("This request requires more credits"))
        self.assertNotIn("status_code", _provider_message(_Refused()))

    def test_falls_back_to_the_exception_text_when_there_is_no_body(self):
        self.assertEqual(_provider_message(ValueError("plain")), "plain")

    def test_survives_a_body_that_is_not_the_shape_we_expect(self):
        odd = ValueError("odd")
        odd.body = ["not", "a", "dict"]  # type: ignore[attr-defined]
        self.assertEqual(_provider_message(odd), "odd")


class CallClassificationTests(unittest.TestCase):
    def test_402_is_reported_as_insufficient_credits(self):
        with mock.patch("backend.garment_gen._get_client", return_value=_client_raising(_Refused())):
            result = _call_image_chat_multi(["data:image/png;base64,AA"], "prompt", with_metadata=True)
        self.assertEqual(result["error"], "insufficient_credits")
        self.assertEqual(result["api_usage"]["error_code"], "insufficient_credits")
        self.assertIsNone(result["image_b64"])

    def test_other_status_errors_keep_their_own_class_name(self):
        with mock.patch("backend.garment_gen._get_client", return_value=_client_raising(_Broke())):
            result = _call_image_chat_multi(["data:image/png;base64,AA"], "prompt", with_metadata=True)
        self.assertEqual(result["error"], "_Broke")

    def test_402_does_not_print_a_stack_trace(self):
        with mock.patch("backend.garment_gen._get_client", return_value=_client_raising(_Refused())), \
                mock.patch("backend.garment_gen.traceback.print_exc") as printed:
            _call_image_chat_multi(["data:image/png;base64,AA"], "prompt", with_metadata=True)
        printed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
