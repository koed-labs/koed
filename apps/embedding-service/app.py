# ruff: noqa: I001
import math
import os
from contextlib import asynccontextmanager, contextmanager
from hmac import compare_digest
from threading import Lock
from typing import Any

from env_config import resolve_env

from fastapi import Depends, FastAPI, Header, HTTPException
from huggingface_hub import hf_hub_download
from llama_cpp import LLAMA_POOLING_TYPE_LAST, Llama
from priority_scheduler import EmbeddingPriorityScheduler, normalize_embedding_priority
from pydantic import BaseModel, Field, field_validator, model_validator
from qwen3_embed import TextCrossEncoder

config = resolve_env()

model: Llama | None = None
reranker: TextCrossEncoder | None = None
model_lock = Lock()
reranker_lock = Lock()
embedding_scheduler = EmbeddingPriorityScheduler()


def validate_text_limits(values: list[str], field_name: str) -> None:
    total_chars = 0
    for index, value in enumerate(values):
        char_count = len(value)
        if char_count > config.embedding_max_text_chars:
            raise ValueError(
                f"{field_name}[{index}] exceeds maximum length of "
                f"{config.embedding_max_text_chars} characters"
            )
        total_chars += char_count
    if total_chars > config.embedding_max_request_chars:
        raise ValueError(
            f"{field_name} exceeds maximum total length of "
            f"{config.embedding_max_request_chars} characters"
        )


def require_internal_token(
    x_koed_embedding_token: str | None = Header(default=None),
) -> None:
    if not config.embedding_service_token:
        return
    if not x_koed_embedding_token or not compare_digest(
        x_koed_embedding_token, config.embedding_service_token
    ):
        raise HTTPException(status_code=401, detail="invalid embedding service token")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        if len(texts) > config.batch_limit:
            raise ValueError(f"too many texts; maximum batch size is {config.batch_limit}")
        for index, text in enumerate(texts):
            if not text or not text.strip():
                raise ValueError(f"texts[{index}] must not be empty")
        validate_text_limits(texts, "texts")
        return texts


class EmbeddedChunk(BaseModel):
    inputIndex: int
    chunkIndex: int
    chunkCount: int
    text: str
    vector: list[float]


class EmbedResponse(BaseModel):
    model: str
    dimensions: int
    vectors: list[list[float]]
    chunks: list[EmbeddedChunk]


class RerankRequest(BaseModel):
    query: str = Field(min_length=1)
    documents: list[str] = Field(min_length=1)

    @field_validator("query")
    @classmethod
    def validate_query(cls, query: str) -> str:
        if not query.strip():
            raise ValueError("query must not be empty")
        validate_text_limits([query], "query")
        return query

    @field_validator("documents")
    @classmethod
    def validate_documents(cls, documents: list[str]) -> list[str]:
        if len(documents) > config.reranker_batch_limit:
            raise ValueError(
                f"too many documents; maximum batch size is {config.reranker_batch_limit}"
            )
        for index, document in enumerate(documents):
            if not document or not document.strip():
                raise ValueError(f"documents[{index}] must not be empty")
        validate_text_limits(documents, "documents")
        return documents

    @model_validator(mode="after")
    def validate_total_chars(self) -> "RerankRequest":
        validate_text_limits([self.query, *self.documents], "request")
        return self


class RerankResponse(BaseModel):
    model: str
    scores: list[float]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    model_path = config.model_path or hf_hub_download(
        repo_id=config.model_repo, filename=config.model_file
    )
    model = Llama(
        model_path=model_path,
        embedding=True,
        pooling_type=LLAMA_POOLING_TYPE_LAST,
        n_ctx=config.llama_n_ctx,
        n_threads=config.llama_n_threads,
        n_batch=config.llama_n_batch,
        verbose=False,
    )
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health(
    x_koed_embedding_token: str | None = Header(default=None),
) -> dict[str, Any]:
    auth_required = bool(config.embedding_service_token)
    auth_valid = not auth_required or bool(
        x_koed_embedding_token
        and compare_digest(x_koed_embedding_token, config.embedding_service_token)
    )
    return {
        "status": "ok" if model is not None else "loading",
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
        "queue": embedding_scheduler.snapshot().__dict__,
        "reranker": {
            "enabled": config.reranker_enabled,
            "loaded": reranker is not None,
            "modelKey": config.reranker_key,
            "model": config.reranker_model,
            "batchLimit": config.reranker_batch_limit,
        },
    }


def normalize_vector(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        raise ValueError("model returned a zero vector")
    return [value / norm for value in vector]


def tokenize_text(text: str) -> list[int]:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")
    return list(model.tokenize(text.encode("utf-8"), add_bos=False))


def detokenize_text(tokens: list[int]) -> str:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")
    return model.detokenize(tokens).decode("utf-8", errors="replace").strip()


def split_text_by_embedding_tokens(text: str) -> list[str]:
    stripped = text.strip()
    tokens = tokenize_text(stripped)
    max_tokens = max(1, min(config.embedding_max_tokens, config.llama_n_ctx))
    if len(tokens) <= max_tokens:
        return [stripped]

    chunks: list[str] = []
    for start in range(0, len(tokens), max_tokens):
        chunk = detokenize_text(tokens[start : start + max_tokens])
        if chunk:
            chunks.append(chunk)
    return chunks


@contextmanager
def suppress_native_stderr(enabled: bool):
    if not enabled:
        yield
        return

    original_stderr = os.dup(2)
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, 2)
        yield
    finally:
        os.dup2(original_stderr, 2)
        os.close(original_stderr)
        os.close(devnull)


@app.post(
    "/embed",
    response_model=EmbedResponse,
    dependencies=[Depends(require_internal_token)],
)
def embed(
    request: EmbedRequest,
    x_koed_embedding_priority: str | None = Header(default=None),
) -> EmbedResponse:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")

    priority = normalize_embedding_priority(x_koed_embedding_priority)
    try:
        vectors: list[list[float]] = []
        chunks: list[EmbeddedChunk] = []
        with embedding_scheduler.slot(priority):
            with model_lock:
                for input_index, text in enumerate(request.texts):
                    text_chunks = split_text_by_embedding_tokens(text)
                    for chunk_index, chunk_text in enumerate(text_chunks):
                        with suppress_native_stderr(config.suppress_llama_warnings):
                            result = model.create_embedding(chunk_text, model=config.model_name)
                        embedding = result["data"][0]["embedding"]
                        vector = normalize_vector(list(embedding))
                        vectors.append(vector)
                        chunks.append(
                            EmbeddedChunk(
                                inputIndex=input_index,
                                chunkIndex=chunk_index,
                                chunkCount=len(text_chunks),
                                text=chunk_text,
                                vector=vector,
                            )
                        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"model embedding failed: {error}") from error

    dimensions = len(vectors[0]) if vectors else 0
    if dimensions != config.expected_dimensions:
        raise HTTPException(
            status_code=500,
            detail=f"model returned {dimensions} dimensions; expected {config.expected_dimensions}",
        )

    return EmbedResponse(
        model=config.model_name, dimensions=dimensions, vectors=vectors, chunks=chunks
    )


def get_reranker() -> TextCrossEncoder:
    global reranker
    if not config.reranker_enabled:
        raise HTTPException(status_code=404, detail="reranker is disabled")
    if reranker is None:
        with reranker_lock:
            if reranker is None:
                if config.reranker_model is None:
                    raise HTTPException(status_code=404, detail="reranker is disabled")
                reranker = TextCrossEncoder(config.reranker_model)
    return reranker


@app.post(
    "/rerank",
    response_model=RerankResponse,
    dependencies=[Depends(require_internal_token)],
)
def rerank(request: RerankRequest) -> RerankResponse:
    try:
        local_reranker = get_reranker()
        with reranker_lock:
            scores = list(local_reranker.rerank(request.query, request.documents))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"model reranking failed: {error}") from error

    return RerankResponse(
        model=config.reranker_key or "",
        scores=[float(score) for score in scores],
    )
