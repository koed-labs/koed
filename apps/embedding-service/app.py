import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response

from auth import embedding_token_auth_status, require_internal_token
from logging_config import (
    error_type,
    event,
    logger,
    parse_traceparent,
    request_context,
    reset_log_context,
    resolve_request_id,
    set_log_context,
)
from priority_scheduler import normalize_embedding_priority
from runtime import (
    embed_texts,
    health_queue_snapshot,
    is_model_loaded,
    is_reranker_loaded,
    load_embedding_model,
    rerank_texts,
)
from schemas import EmbedRequest, EmbedResponse, RerankRequest, RerankResponse
from settings import config


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_embedding_model()
    yield


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def attach_request_logging_context(request: Request, call_next):
    request_id = resolve_request_id(request.headers.get("x-request-id"))
    token = set_log_context(
        request_context(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            trace=parse_traceparent(request.headers.get("traceparent")),
        )
    )
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        reset_log_context(token)
    response.headers["x-request-id"] = request_id
    logger.debug(
        "http request completed",
        extra={
            "event": event("embedding.http.request_completed"),
            "request": {
                "id": request_id,
                "method": request.method,
                "path": request.url.path,
            },
            "http": {
                "status_code": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000),
            },
        },
    )
    return response


@app.get("/health")
def health(
    x_koed_embedding_token: str | None = Header(default=None),
) -> dict[str, Any]:
    auth_required, auth_valid = embedding_token_auth_status(x_koed_embedding_token)
    return {
        "status": "ok" if is_model_loaded() else "loading",
        "modelKey": config.model_key,
        "model": config.model_name,
        "dimensions": config.expected_dimensions,
        "normalized": True,
        "batchLimit": config.batch_limit,
        "maxTokens": config.embedding_max_tokens,
        "maxTextChars": config.embedding_max_text_chars,
        "maxRequestChars": config.embedding_max_request_chars,
        "authRequired": auth_required,
        "authValid": auth_valid,
        "modelRepo": config.model_repo,
        "modelFile": config.model_file,
        "nCtx": config.llama_n_ctx,
        "queue": health_queue_snapshot(),
        "reranker": {
            "enabled": config.reranker_enabled,
            "loaded": is_reranker_loaded(),
            "modelKey": config.reranker_key,
            "model": config.reranker_model,
            "batchLimit": config.reranker_batch_limit,
        },
    }


@app.post(
    "/embed",
    response_model=EmbedResponse,
    dependencies=[Depends(require_internal_token)],
)
def embed(
    request: EmbedRequest,
    response: Response,
    x_koed_embedding_priority: str | None = Header(default=None),
) -> EmbedResponse:
    started = time.perf_counter()
    try:
        result = embed_texts(request.texts, x_koed_embedding_priority)
    except HTTPException as error:
        _log_route_failure(
            "embedding.embed.failed",
            "embedding request failed",
            started,
            error.status_code,
            error,
        )
        raise
    except Exception as error:
        _log_route_failure(
            "embedding.embed.failed",
            "embedding request failed",
            started,
            500,
            error,
        )
        raise HTTPException(
            status_code=500,
            detail=f"model embedding failed: {error}",
        ) from error

    response.status_code = 200
    logger.info(
        "embedding request completed",
        extra={
            "event": event("embedding.embed.completed"),
            "http": {"status_code": 200, "duration_ms": _elapsed_ms(started)},
            "priority": normalize_embedding_priority(x_koed_embedding_priority),
            "embedding": {
                "model": result.model,
                "dimensions": result.dimensions,
                "input_count": len(request.texts),
                "chunk_count": len(result.chunks),
                "vector_count": len(result.vectors),
            },
        },
    )
    return result


@app.post(
    "/rerank",
    response_model=RerankResponse,
    dependencies=[Depends(require_internal_token)],
)
def rerank(request: RerankRequest, response: Response) -> RerankResponse:
    started = time.perf_counter()
    try:
        result = rerank_texts(request.query, request.documents)
    except HTTPException as error:
        _log_route_failure(
            "embedding.rerank.failed",
            "rerank request failed",
            started,
            error.status_code,
            error,
        )
        raise
    except Exception as error:
        _log_route_failure(
            "embedding.rerank.failed",
            "rerank request failed",
            started,
            500,
            error,
        )
        raise HTTPException(
            status_code=500,
            detail=f"model reranking failed: {error}",
        ) from error

    response.status_code = 200
    logger.info(
        "rerank request completed",
        extra={
            "event": event("embedding.rerank.completed"),
            "http": {"status_code": 200, "duration_ms": _elapsed_ms(started)},
            "reranker": {
                "model": result.model,
                "document_count": len(request.documents),
                "score_count": len(result.scores),
            },
        },
    )
    return result


def _elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def _log_route_failure(
    event_name: str,
    message: str,
    started: float,
    status_code: int,
    error: BaseException,
) -> None:
    logger.info(
        message,
        extra={
            "event": event(event_name),
            "http": {"status_code": status_code, "duration_ms": _elapsed_ms(started)},
            "error": error_type(error),
        },
    )
