import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Lock
from typing import Any

from fastapi import HTTPException

from logging_config import error_type, event, logger
from priority_scheduler import EmbeddingPriorityScheduler, normalize_embedding_priority
from schemas import EmbeddedChunk, EmbedResponse, RerankResponse
from settings import config
from vectors import extract_embedding_vectors, normalize_vectors

model: Any | None = None
reranker: Any | None = None
model_lock = Lock()
reranker_lock = Lock()
embedding_scheduler = EmbeddingPriorityScheduler()


@dataclass(frozen=True)
class ChunkCandidate:
    input_index: int
    chunk_index: int
    chunk_count: int
    text: str
    token_count: int


@contextmanager
def suppress_native_stderr(enabled: bool) -> Iterator[None]:
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


def load_embedding_model() -> None:
    global model
    from huggingface_hub import hf_hub_download
    from llama_cpp import LLAMA_POOLING_TYPE_LAST, Llama

    logger.info(
        "embedding model load started",
        extra={
            "event": event("embedding.model.load_started"),
            "model": {
                "key": config.model_key,
                "repo": config.model_repo,
                "file": config.model_file,
            },
            "runtime": {
                "n_ctx": config.llama_n_ctx,
                "n_batch": config.llama_n_batch,
                "n_threads": config.llama_n_threads,
            },
        },
    )
    try:
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
    except Exception as error:
        logger.error(
            "embedding model load failed",
            extra={
                "event": event("embedding.model.load_failed"),
                "model": {"key": config.model_key},
                "error": error_type(error),
            },
        )
        raise
    logger.info(
        "embedding model load completed",
        extra={
            "event": event("embedding.model.load_completed"),
            "model": {"key": config.model_key, "dimensions": config.expected_dimensions},
        },
    )


def is_model_loaded() -> bool:
    return model is not None


def is_reranker_loaded() -> bool:
    return reranker is not None


def health_queue_snapshot() -> dict[str, Any]:
    return embedding_scheduler.snapshot().__dict__


def tokenize_text(text: str) -> list[int]:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")
    return list(model.tokenize(text.encode("utf-8"), add_bos=False))


def detokenize_text(tokens: list[int]) -> str:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")
    return model.detokenize(tokens).decode("utf-8", errors="replace").strip()


def split_text_by_embedding_tokens(text: str, input_index: int) -> list[ChunkCandidate]:
    stripped = text.strip()
    max_tokens = max(1, min(config.embedding_max_tokens, config.llama_n_ctx))
    tokens = tokenize_text(stripped)
    if len(tokens) <= max_tokens:
        chunks = [
            ChunkCandidate(
                input_index=input_index,
                chunk_index=0,
                chunk_count=1,
                text=stripped,
                token_count=len(tokens),
            )
        ]
    else:
        chunk_texts: list[tuple[str, int]] = []
        for start in range(0, len(tokens), max_tokens):
            chunk_tokens = tokens[start : start + max_tokens]
            chunk = detokenize_text(chunk_tokens)
            if chunk:
                chunk_texts.append((chunk, len(chunk_tokens)))
        chunks = [
            ChunkCandidate(
                input_index=input_index,
                chunk_index=index,
                chunk_count=len(chunk_texts),
                text=chunk_text,
                token_count=token_count,
            )
            for index, (chunk_text, token_count) in enumerate(chunk_texts)
        ]

    logger.debug(
        "embedding text chunked",
        extra={
            "event": event("embedding.text.chunked"),
            "embedding": {
                "input_index": input_index,
                "chunk_count": len(chunks),
                "token_count": len(tokens),
                "max_tokens": max_tokens,
                "n_batch": config.llama_n_batch,
            },
        },
    )
    return chunks


def scheduled_text_chunks(text: str, input_index: int, priority: str) -> list[ChunkCandidate]:
    logger.debug(
        "embedding scheduler waiting for tokenization",
        extra={
            "event": event("embedding.scheduler.waiting"),
            "priority": priority,
            "queue": embedding_scheduler.snapshot().__dict__,
        },
    )
    with embedding_scheduler.slot(priority):
        logger.debug(
            "embedding scheduler acquired tokenization slot",
            extra={
                "event": event("embedding.scheduler.acquired"),
                "priority": priority,
                "queue": embedding_scheduler.snapshot().__dict__,
            },
        )
        with model_lock:
            chunks = split_text_by_embedding_tokens(text, input_index)
        logger.debug(
            "embedding scheduler released tokenization slot",
            extra={
                "event": event("embedding.scheduler.released"),
                "priority": priority,
                "queue": embedding_scheduler.snapshot().__dict__,
            },
        )
        return chunks


def embedding_groups(chunks: list[ChunkCandidate]) -> list[list[ChunkCandidate]]:
    groups: list[list[ChunkCandidate]] = []
    current: list[ChunkCandidate] = []
    current_tokens = 0
    for chunk in chunks:
        if chunk.token_count > config.llama_n_batch:
            if current:
                groups.append(current)
                current = []
                current_tokens = 0
            groups.append([chunk])
            continue
        if current and current_tokens + chunk.token_count > config.llama_n_batch:
            groups.append(current)
            current = []
            current_tokens = 0
        current.append(chunk)
        current_tokens += chunk.token_count
    if current:
        groups.append(current)
    return groups


def embed_group(group: list[ChunkCandidate]) -> list[list[float]]:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")
    texts = [chunk.text for chunk in group]
    create_input: str | list[str] = texts[0] if len(texts) == 1 else texts
    if len(group) == 1 and group[0].token_count > config.llama_n_batch:
        logger.debug(
            "embedding batch fell back to single long chunk",
            extra={
                "event": event("embedding.batch.fallback_single"),
                "embedding": {
                    "chunk_count": 1,
                    "token_count": group[0].token_count,
                    "n_batch": config.llama_n_batch,
                },
            },
        )
    else:
        logger.debug(
            "embedding batch started",
            extra={
                "event": event("embedding.batch.started"),
                "embedding": {
                    "chunk_count": len(group),
                    "token_count": sum(chunk.token_count for chunk in group),
                    "n_batch": config.llama_n_batch,
                },
            },
        )
    with suppress_native_stderr(config.suppress_llama_warnings):
        result = model.create_embedding(create_input, model=config.model_name)
    vectors = normalize_vectors(extract_embedding_vectors(result))
    if len(vectors) != len(group):
        raise ValueError("model returned an unexpected embedding count")
    return vectors


def scheduled_embeddings(chunks: list[ChunkCandidate], priority: str) -> list[list[float]]:
    vectors: list[list[float]] = []
    for group in embedding_groups(chunks):
        logger.debug(
            "embedding scheduler waiting for model slot",
            extra={
                "event": event("embedding.scheduler.waiting"),
                "priority": priority,
                "queue": embedding_scheduler.snapshot().__dict__,
            },
        )
        with embedding_scheduler.slot(priority):
            logger.debug(
                "embedding scheduler acquired model slot",
                extra={
                    "event": event("embedding.scheduler.acquired"),
                    "priority": priority,
                    "queue": embedding_scheduler.snapshot().__dict__,
                },
            )
            with model_lock:
                vectors.extend(embed_group(group))
            logger.debug(
                "embedding scheduler released model slot",
                extra={
                    "event": event("embedding.scheduler.released"),
                    "priority": priority,
                    "queue": embedding_scheduler.snapshot().__dict__,
                },
            )
    return vectors


def embed_texts(texts: list[str], requested_priority: str | None) -> EmbedResponse:
    if model is None:
        raise HTTPException(status_code=503, detail="embedding model is still loading")

    priority = normalize_embedding_priority(requested_priority)
    chunks: list[ChunkCandidate] = []
    for input_index, text in enumerate(texts):
        chunks.extend(scheduled_text_chunks(text, input_index, priority))

    vectors = scheduled_embeddings(chunks, priority)
    dimensions = len(vectors[0]) if vectors else 0
    if dimensions != config.expected_dimensions:
        raise ValueError(
            f"model returned {dimensions} dimensions; expected {config.expected_dimensions}"
        )

    embedded_chunks = [
        EmbeddedChunk(
            inputIndex=chunk.input_index,
            chunkIndex=chunk.chunk_index,
            chunkCount=chunk.chunk_count,
            text=chunk.text,
            vector=vector,
        )
        for chunk, vector in zip(chunks, vectors, strict=True)
    ]
    return EmbedResponse(
        model=config.model_name,
        dimensions=dimensions,
        vectors=vectors,
        chunks=embedded_chunks,
    )


def get_reranker() -> Any:
    global reranker
    if not config.reranker_enabled:
        raise HTTPException(status_code=404, detail="reranker is disabled")
    if reranker is None:
        with reranker_lock:
            if reranker is None:
                if config.reranker_model is None:
                    raise HTTPException(status_code=404, detail="reranker is disabled")
                logger.info(
                    "reranker load started",
                    extra={
                        "event": event("embedding.reranker.load_started"),
                        "reranker": {"model_key": config.reranker_key},
                    },
                )
                try:
                    from qwen3_embed import TextCrossEncoder

                    reranker = TextCrossEncoder(config.reranker_model)
                except Exception as error:
                    logger.error(
                        "reranker load failed",
                        extra={
                            "event": event("embedding.reranker.load_failed"),
                            "reranker": {"model_key": config.reranker_key},
                            "error": error_type(error),
                        },
                    )
                    raise
                logger.info(
                    "reranker load completed",
                    extra={
                        "event": event("embedding.reranker.load_completed"),
                        "reranker": {"model_key": config.reranker_key},
                    },
                )
    return reranker


def rerank_texts(query: str, documents: list[str]) -> RerankResponse:
    local_reranker = get_reranker()
    logger.debug(
        "reranker scoring started",
        extra={
            "event": event("embedding.reranker.scoring_started"),
            "reranker": {
                "model_key": config.reranker_key,
                "document_count": len(documents),
            },
        },
    )
    with reranker_lock:
        scores = list(local_reranker.rerank(query, documents))
    logger.debug(
        "reranker scoring completed",
        extra={
            "event": event("embedding.reranker.scoring_completed"),
            "reranker": {
                "model_key": config.reranker_key,
                "document_count": len(documents),
                "score_count": len(scores),
            },
        },
    )
    return RerankResponse(
        model=config.reranker_key or "",
        scores=[float(score) for score in scores],
    )
