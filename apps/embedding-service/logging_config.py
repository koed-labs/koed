import json
import logging
import re
import sys
from contextvars import ContextVar, Token
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from settings import config

SCHEMA_VERSION = "embedding_service_log_v1"
SERVICE_NAME = "koed-embedding-service"

_request_context: ContextVar[dict[str, Any] | None] = ContextVar("request_context", default=None)
_request_id_pattern = re.compile(r"^[A-Za-z0-9._~:-]{1,128}$")
_traceparent_pattern = re.compile(
    r"^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$",
    re.IGNORECASE,
)

_reserved_log_record_fields = {
    "args",
    "asctime",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "module",
    "msecs",
    "message",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "thread",
    "threadName",
}

_allowed_log_levels = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "warn": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "service": SERVICE_NAME,
            "level": record.levelname.lower(),
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "message": record.getMessage(),
        }
        for key, value in (_request_context.get() or {}).items():
            if value is not None:
                payload[key] = value
        for key, value in record.__dict__.items():
            if key not in _reserved_log_record_fields and value is not None:
                payload[key] = value
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def normalize_log_level(value: str | None) -> int:
    return _allowed_log_levels.get((value or "info").strip().lower(), logging.INFO)


def configure_logging() -> logging.Logger:
    logger = logging.getLogger(SERVICE_NAME)
    logger.setLevel(normalize_log_level(config.log_level))
    logger.propagate = False
    logger.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLogFormatter())
    logger.addHandler(handler)
    return logger


logger = configure_logging()


def resolve_request_id(value: str | None) -> str:
    return value if value and _request_id_pattern.fullmatch(value) else str(uuid4())


def parse_traceparent(value: str | None) -> dict[str, str] | None:
    match = _traceparent_pattern.fullmatch(value or "")
    if not match:
        return None
    return {"trace_id": match.group(1).lower(), "span_id": match.group(2).lower()}


def request_context(
    *,
    request_id: str,
    method: str,
    path: str,
    trace: dict[str, str] | None,
) -> dict[str, Any]:
    return {
        "request": {
            "id": request_id,
            "method": method,
            "path": path,
        },
        **({"trace": trace} if trace else {}),
    }


def set_log_context(context: dict[str, Any]) -> Token[dict[str, Any] | None]:
    return _request_context.set(context)


def reset_log_context(token: Token[dict[str, Any] | None]) -> None:
    _request_context.reset(token)


def event(name: str) -> dict[str, str]:
    return {"name": name}


def error_type(error: BaseException) -> dict[str, str]:
    return {"type": type(error).__name__}
