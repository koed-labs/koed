import math
import os
from contextlib import asynccontextmanager, contextmanager
from hmac import compare_digest
from threading import Lock
from typing import Any

os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

from fastapi import Depends, FastAPI, Header, HTTPException
from huggingface_hub import hf_hub_download
from llama_cpp import LLAMA_POOLING_TYPE_LAST, Llama
from pydantic import BaseModel, Field, field_validator, model_validator
from qwen3_embed import TextCrossEncoder

MODEL_REPO = os.getenv("MODEL_REPO", "Qwen/Qwen3-Embedding-0.6B-GGUF")
MODEL_FILE = os.getenv("MODEL_FILE", "Qwen3-Embedding-0.6B-Q8_0.gguf")
MODEL_PATH = os.getenv("MODEL_PATH")
MODEL_NAME = os.getenv("MODEL_NAME", MODEL_REPO)
EXPECTED_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1024"))
BATCH_LIMIT = int(os.getenv("EMBEDDING_BATCH_LIMIT", "16"))
LLAMA_N_CTX = int(os.getenv("LLAMA_N_CTX", "32768"))
EMBEDDING_MAX_TOKENS = int(os.getenv("EMBEDDING_MAX_TOKENS", str(LLAMA_N_CTX)))
EMBEDDING_MAX_TEXT_CHARS = int(os.getenv("EMBEDDING_MAX_TEXT_CHARS", "200000"))
EMBEDDING_MAX_REQUEST_CHARS = int(os.getenv("EMBEDDING_MAX_REQUEST_CHARS", "1000000"))
LLAMA_N_THREADS = int(os.getenv("LLAMA_N_THREADS", str(os.cpu_count() or 1)))
LLAMA_N_BATCH = int(os.getenv("LLAMA_N_BATCH", "512"))
SUPPRESS_LLAMA_WARNINGS = os.getenv("EMBEDDING_SUPPRESS_LLAMA_WARNINGS", "true").lower() == "true"
RERANKER_ENABLED = os.getenv("RERANKER_ENABLED", "false").lower() == "true"
RERANKER_MODEL = os.getenv("RERANKER_MODEL", "n24q02m/Qwen3-Reranker-0.6B-ONNX")
RERANKER_BATCH_LIMIT = int(os.getenv("RERANKER_BATCH_LIMIT", "100"))
EMBEDDING_SERVICE_TOKEN = os.getenv("EMBEDDING_SERVICE_TOKEN", "").strip()

model: Llama | None = None
reranker: TextCrossEncoder | None = None
model_lock = Lock()
reranker_lock = Lock()


def validate_text_limits(values: list[str], field_name: str) -> None:
    total_chars = 0
    for index, value in enumerate(values):
        char_count = len(value)
        if char_count > EMBEDDING_MAX_TEXT_CHARS:
            raise ValueError(
                f"{field_name}[{index}] exceeds maximum length of "
                f"{EMBEDDING_MAX_TEXT_CHARS} characters"
            )
        total_chars += char_count
    if total_chars > EMBEDDING_MAX_REQUEST_CHARS:
        raise ValueError(
            f"{field_name} exceeds maximum total length of {EMBEDDING_MAX_REQUEST_CHARS} characters"
        )


def require_internal_token(
    x_koed_embedding_token: str | None = Header(default=None),
) -> None:
    if not EMBEDDING_SERVICE_TOKEN:
        return
    if not x_koed_embedding_token or not compare_digest(
        x_koed_embedding_token, EMBEDDING_SERVICE_TOKEN
    ):
        raise HTTPException(status_code=401, detail="invalid embedding service token")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        if len(texts) > BATCH_LIMIT:
            raise ValueError(f"too many texts; maximum batch size is {BATCH_LIMIT}")
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
        if len(documents) > RERANKER_BATCH_LIMIT:
            raise ValueError(f"too many documents; maximum batch size is {RERANKER_BATCH_LIMIT}")
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
    model_path = MODEL_PATH or hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
    model = Llama(
        model_path=model_path,
        embedding=True,
        pooling_type=LLAMA_POOLING_TYPE_LAST,
        n_ctx=LLAMA_N_CTX,
        n_threads=LLAMA_N_THREADS,
        n_batch=LLAMA_N_BATCH,
        verbose=False,
    )
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health(
    x_koed_embedding_token: str | None = Header(default=None),
) -> dict[str, Any]:
    auth_required = bool(EMBEDDING_SERVICE_TOKEN)
    auth_valid = not auth_required or bool(
        x_koed_embedding_token
        and compare_digest(x_koed_embedding_token, EMBEDDING_SERVICE_TOKEN)
    )
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_NAME,
        "dimensions": EXPECTED_DIMENSIONS,
        "normalized": True,
        "batchLimit": BATCH_LIMIT,
        "maxTokens": EMBEDDING_MAX_TOKENS,
        "maxTextChars": EMBEDDING_MAX_TEXT_CHARS,
        "maxRequestChars": EMBEDDING_MAX_REQUEST_CHARS,
        "authRequired": auth_required,
        "authValid": auth_valid,
        "modelRepo": MODEL_REPO,
        "modelFile": MODEL_FILE,
        "nCtx": LLAMA_N_CTX,
        "reranker": {
            "enabled": RERANKER_ENABLED,
            "loaded": reranker is not None,
            "model": RERANKER_MODEL if RERANKER_ENABLED else None,
            "batchLimit": RERANKER_BATCH_LIMIT,
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
    max_tokens = max(1, min(EMBEDDING_MAX_TOKENS, LLAMA_N_CTX))
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
def embed(request: EmbedRequest) -> EmbedResponse:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")

    try:
        vectors: list[list[float]] = []
        chunks: list[EmbeddedChunk] = []
        with model_lock:
            for input_index, text in enumerate(request.texts):
                text_chunks = split_text_by_embedding_tokens(text)
                for chunk_index, chunk_text in enumerate(text_chunks):
                    with suppress_native_stderr(SUPPRESS_LLAMA_WARNINGS):
                        result = model.create_embedding(chunk_text, model=MODEL_NAME)
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
    if dimensions != EXPECTED_DIMENSIONS:
        raise HTTPException(
            status_code=500,
            detail=f"model returned {dimensions} dimensions; expected {EXPECTED_DIMENSIONS}",
        )

    return EmbedResponse(model=MODEL_NAME, dimensions=dimensions, vectors=vectors, chunks=chunks)


def get_reranker() -> TextCrossEncoder:
    global reranker
    if not RERANKER_ENABLED:
        raise HTTPException(status_code=404, detail="reranker is disabled")
    if reranker is None:
        with reranker_lock:
            if reranker is None:
                reranker = TextCrossEncoder(RERANKER_MODEL)
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

    return RerankResponse(model=RERANKER_MODEL, scores=[float(score) for score in scores])
