import json
import logging
import unittest

from logging_config import (
    JsonLogFormatter,
    event,
    parse_traceparent,
    request_context,
    reset_log_context,
    resolve_request_id,
    set_log_context,
)


class LoggingConfigTest(unittest.TestCase):
    def test_json_formatter_emits_required_base_fields(self) -> None:
        record = logging.LogRecord(
            name="koed-embedding-service",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="embedding request completed",
            args=(),
            exc_info=None,
        )
        record.event = event("embedding.embed.completed")  # type: ignore[attr-defined]
        payload = json.loads(JsonLogFormatter().format(record))

        self.assertEqual(payload["schema_version"], "embedding_service_log_v1")
        self.assertEqual(payload["service"], "koed-embedding-service")
        self.assertEqual(payload["level"], "info")
        self.assertEqual(payload["message"], "embedding request completed")
        self.assertEqual(payload["event"], {"name": "embedding.embed.completed"})
        self.assertIn("time", payload)

    def test_request_context_is_sanitized(self) -> None:
        token = set_log_context(
            request_context(
                request_id="req-1",
                method="POST",
                path="/embed",
                trace={"trace_id": "a" * 32, "span_id": "b" * 16},
            )
        )
        try:
            record = logging.LogRecord(
                name="koed-embedding-service",
                level=logging.DEBUG,
                pathname=__file__,
                lineno=1,
                msg="http request completed",
                args=(),
                exc_info=None,
            )
            payload = json.loads(JsonLogFormatter().format(record))
        finally:
            reset_log_context(token)

        serialized = json.dumps(payload)
        self.assertEqual(
            payload["request"],
            {"id": "req-1", "method": "POST", "path": "/embed"},
        )
        self.assertEqual(payload["trace"]["trace_id"], "a" * 32)
        self.assertNotIn("authorization", serialized.lower())
        self.assertNotIn("secret", serialized.lower())
        self.assertNotIn("vector", serialized.lower())

    def test_request_id_and_traceparent_parsing(self) -> None:
        self.assertEqual(resolve_request_id("operator-request-1"), "operator-request-1")
        self.assertNotEqual(resolve_request_id("contains space"), "contains space")
        self.assertEqual(
            parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
            {
                "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
                "span_id": "00f067aa0ba902b7",
            },
        )
        self.assertIsNone(parse_traceparent("invalid"))


if __name__ == "__main__":
    unittest.main()
