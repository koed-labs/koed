import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import HTTPException

from logging_config import error_type, event, logger
from priority_scheduler import EmbeddingPriorityScheduler, normalize_embedding_priority
from schemas import EmbeddedChunk, EmbedResponse, RerankResponse
from settings import config
from vectors import extract_embedding_vectors, normalize_vectors

embedding_server: "LlamaServerClient | None" = None
reranker_server: "LlamaServerClient | None" = None
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


@dataclass(frozen=True)
class TokenPiece:
    token_id: int
    text: str


class LlamaServerError(RuntimeError):
    pass


def embedding_batch_token_limit() -> int:
    headroom = max(0, int(getattr(config, "llama_batch_token_headroom", 0)))
    return max(1, config.llama_n_batch - headroom)


class LlamaServerClient:
    def __init__(
        self,
        *,
        name: str,
        model_path: str,
        port: int,
        pooling: str,
        embedding: bool,
        reranking: bool,
        n_ctx: int,
        n_threads: int,
        n_batch: int,
        n_ubatch: int,
        parallel: int,
        prompt_cache_enabled: bool,
    ) -> None:
        self.name = name
        self.model_path = model_path
        self.port = port
        self.pooling = pooling
        self.embedding = embedding
        self.reranking = reranking
        self.n_ctx = n_ctx
        self.n_threads = n_threads
        self.n_batch = n_batch
        self.n_ubatch = n_ubatch
        self.parallel = parallel
        self.prompt_cache_enabled = prompt_cache_enabled
        self.base_url = f"http://127.0.0.1:{port}"
        self.process: subprocess.Popen[str] | None = None
        self.log_path = Path(f"/tmp/koed-{name}-llama-server.log")
        self.log_file: Any | None = None

    def start(self) -> None:
        if self.is_running():
            return
        args = [
            config.llama_server_binary,
            "--model",
            self.model_path,
            "--ctx-size",
            str(self.n_ctx),
            "--threads",
            str(self.n_threads),
            "--threads-batch",
            str(self.n_threads),
            "--batch-size",
            str(self.n_batch),
            "--ubatch-size",
            str(self.n_ubatch),
            "--parallel",
            str(self.parallel),
            "--poll",
            "0",
            "--poll-batch",
            "0",
            "--n-gpu-layers",
            "0",
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--pooling",
            self.pooling,
            "--no-ui",
            "--log-disable",
        ]
        if not self.prompt_cache_enabled:
            args.extend(["--no-cache-prompt", "--cache-ram", "0"])
        if self.embedding:
            args.append("--embedding")
        if self.reranking:
            args.append("--reranking")
        if self.embedding and not self.reranking:
            args.extend(["--embd-normalize", "2"])

        logger.info(
            "llama-server process starting",
            extra={
                "event": event("embedding.llama_server.starting"),
                "llama_server": {
                    "name": self.name,
                    "model_path": self.model_path,
                    "port": self.port,
                    "pooling": self.pooling,
                    "embedding": self.embedding,
                    "reranking": self.reranking,
                    "n_ctx": self.n_ctx,
                    "n_batch": self.n_batch,
                    "n_ubatch": self.n_ubatch,
                    "parallel": self.parallel,
                    "threads": self.n_threads,
                    "poll": 0,
                    "poll_batch": 0,
                    "prompt_cache_enabled": self.prompt_cache_enabled,
                },
            },
        )
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self.log_file = self.log_path.open("a", encoding="utf-8", errors="replace")
            self.log_file.write(f"\n--- starting {self.name} llama-server ---\n")
            self.log_file.flush()
            self.process = subprocess.Popen(
                args,
                stdout=self.log_file,
                stderr=subprocess.STDOUT,
                text=True,
                env={**os.environ, "LD_LIBRARY_PATH": "/opt/llama.cpp"},
            )
            self.wait_ready(config.llama_server_startup_timeout_seconds)
        except Exception:
            self.stop()
            raise

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def wait_ready(self, timeout_seconds: int) -> None:
        deadline = time.monotonic() + timeout_seconds
        last_error: str | None = None
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                stderr = self._read_stderr_tail()
                raise LlamaServerError(f"{self.name} llama-server exited during startup: {stderr}")
            try:
                self.get("/health", timeout=2)
                logger.info(
                    "llama-server process ready",
                    extra={
                        "event": event("embedding.llama_server.ready"),
                        "llama_server": {"name": self.name, "port": self.port},
                    },
                )
                return
            except Exception as error:  # noqa: BLE001 - preserve startup reason.
                last_error = str(error)
                time.sleep(0.5)
        stderr = self._read_stderr_tail()
        raise LlamaServerError(
            f"{self.name} llama-server did not become ready: {last_error}; {stderr}"
        )

    def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.process = None
        if self.log_file is not None:
            self.log_file.close()
            self.log_file = None

    def get(self, path: str, *, timeout: float) -> dict[str, Any]:
        request = urllib.request.Request(f"{self.base_url}{path}", method="GET")
        return self._open_json(request, timeout)

    def post(self, path: str, payload: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        return self._open_json(request, timeout)

    def tokenize(self, text: str) -> list[TokenPiece]:
        payload = {
            "content": text,
            "add_special": False,
            "parse_special": True,
            "with_pieces": True,
        }
        response = self.post("/tokenize", payload, timeout=60)
        tokens = response.get("tokens")
        if not isinstance(tokens, list):
            raise LlamaServerError("llama-server returned invalid tokenization payload")
        pieces: list[TokenPiece] = []
        for index, token in enumerate(tokens):
            if not isinstance(token, dict):
                raise LlamaServerError("llama-server returned token ids without pieces")
            token_id = token.get("id")
            piece = token.get("piece")
            if not isinstance(token_id, int):
                token_id = index
            pieces.append(TokenPiece(token_id=token_id, text=_token_piece_text(piece)))
        return pieces

    def detokenize(self, token_ids: list[int]) -> str:
        response = self.post("/detokenize", {"tokens": token_ids}, timeout=60)
        content = response.get("content")
        if isinstance(content, str):
            return content
        text = response.get("text")
        if isinstance(text, str):
            return text
        raise LlamaServerError("llama-server returned invalid detokenization payload")

    def embed(self, texts: list[str]) -> tuple[list[list[float]], int | None]:
        response = self.post(
            "/v1/embeddings",
            {"model": config.model_name, "input": texts},
            timeout=600,
        )
        usage = response.get("usage")
        measured_tokens = (
            int(usage["prompt_tokens"])
            if isinstance(usage, dict) and isinstance(usage.get("prompt_tokens"), int)
            else None
        )
        return normalize_vectors(extract_embedding_vectors(response)), measured_tokens

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        response = self.post(
            "/v1/rerank",
            {
                "model": config.reranker_key or "reranker",
                "query": query,
                "documents": documents,
                "top_n": len(documents),
            },
            timeout=600,
        )
        return _extract_rerank_scores(response, len(documents))

    def _open_json(self, request: urllib.request.Request, timeout: float) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise LlamaServerError(
                f"{self.name} llama-server HTTP {error.code}: {body[:500]}"
            ) from error
        except Exception as error:
            raise LlamaServerError(f"{self.name} llama-server request failed: {error}") from error
        if not isinstance(payload, dict):
            raise LlamaServerError(f"{self.name} llama-server returned a non-object payload")
        return payload

    def _read_stderr_tail(self) -> str:
        try:
            with self.log_path.open("rb") as log_file:
                log_file.seek(0, os.SEEK_END)
                size = log_file.tell()
                log_file.seek(max(0, size - 4096), os.SEEK_SET)
                return log_file.read().decode("utf-8", errors="replace")
        except FileNotFoundError:
            return "llama-server log file was not created"


def _token_piece_text(piece: Any) -> str:
    if isinstance(piece, str):
        return piece
    if isinstance(piece, list) and all(isinstance(value, int) for value in piece):
        return bytes(piece).decode("utf-8", errors="replace")
    return str(piece)


def _extract_rerank_scores(response: dict[str, Any], document_count: int) -> list[float]:
    if isinstance(response.get("scores"), list):
        scores = response["scores"]
        if len(scores) == document_count:
            return [float(score) for score in scores]

    ranked = response.get("results") or response.get("data")
    if not isinstance(ranked, list):
        raise LlamaServerError("llama-server returned invalid rerank payload")

    scores_by_index: dict[int, float] = {}
    for fallback_index, item in enumerate(ranked):
        if not isinstance(item, dict):
            continue
        index = item.get("index", fallback_index)
        score = item.get("relevance_score") if "relevance_score" in item else item.get("score")
        if isinstance(index, int) and isinstance(score, int | float):
            scores_by_index[index] = float(score)

    if len(scores_by_index) != document_count:
        raise LlamaServerError("llama-server returned incomplete rerank scores")
    return [scores_by_index[index] for index in range(document_count)]


def load_embedding_model() -> None:
    global embedding_server

    if embedding_server is not None and embedding_server.is_running():
        return

    with model_lock:
        if embedding_server is not None and embedding_server.is_running():
            return
        if embedding_server is not None:
            embedding_server.stop()
            embedding_server = None

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
                    "server": "llama-server",
                    "n_ctx": config.llama_n_ctx,
                    "n_batch": config.llama_n_batch,
                    "batch_token_headroom": config.llama_batch_token_headroom,
                    "batch_token_limit": embedding_batch_token_limit(),
                    "n_ubatch": config.llama_n_ubatch,
                    "n_threads": config.llama_n_threads,
                },
            },
        )
        try:
            if config.model_path:
                model_path = config.model_path
            else:
                from huggingface_hub import hf_hub_download

                model_path = hf_hub_download(repo_id=config.model_repo, filename=config.model_file)
            embedding_server = LlamaServerClient(
                name="embedding",
                model_path=model_path,
                port=config.embedding_server_port,
                pooling="last",
                embedding=True,
                reranking=False,
                n_ctx=config.llama_n_ctx,
                n_threads=config.llama_n_threads,
                n_batch=config.llama_n_batch,
                n_ubatch=config.llama_n_ubatch,
                parallel=config.llama_parallel,
                prompt_cache_enabled=False,
            )
            embedding_server.start()
        except Exception as error:
            logger.error(
                "embedding model load failed",
                extra={
                    "event": event("embedding.model.load_failed"),
                    "model": {"key": config.model_key},
                    "error": error_type(error),
                },
            )
            embedding_server = None
            raise
        logger.info(
            "embedding model load completed",
            extra={
                "event": event("embedding.model.load_completed"),
                "model": {"key": config.model_key, "dimensions": config.expected_dimensions},
                "runtime": {"server": "llama-server"},
            },
        )


def shutdown_runtime() -> None:
    global embedding_server, reranker_server
    if reranker_server is not None:
        reranker_server.stop()
        reranker_server = None
    if embedding_server is not None:
        embedding_server.stop()
        embedding_server = None


def is_model_loaded() -> bool:
    return embedding_server is not None and embedding_server.is_running()


def is_reranker_loaded() -> bool:
    return reranker_server is not None and reranker_server.is_running()


def health_queue_snapshot() -> dict[str, Any]:
    return embedding_scheduler.snapshot().__dict__


def require_embedding_server() -> LlamaServerClient:
    try:
        load_embedding_model()
    except Exception as error:
        raise HTTPException(status_code=503, detail="embedding model is still loading") from error
    if embedding_server is None or not embedding_server.is_running():
        raise HTTPException(status_code=503, detail="embedding model is still loading")
    return embedding_server


def split_text_by_embedding_tokens(text: str, input_index: int) -> list[ChunkCandidate]:
    server = require_embedding_server()
    stripped = text.strip()
    max_tokens = max(
        1, min(config.embedding_max_tokens, config.llama_n_ctx, embedding_batch_token_limit())
    )
    pieces = server.tokenize(stripped)
    if len(pieces) <= max_tokens:
        chunks = [
            ChunkCandidate(
                input_index=input_index,
                chunk_index=0,
                chunk_count=1,
                text=stripped,
                token_count=len(pieces),
            )
        ]
    else:
        chunk_texts: list[tuple[str, int]] = []
        for start in range(0, len(pieces), max_tokens):
            chunk_pieces = pieces[start : start + max_tokens]
            chunk = server.detokenize([piece.token_id for piece in chunk_pieces]).strip()
            if chunk:
                chunk_texts.append((chunk, len(chunk_pieces)))
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
                "token_count": len(pieces),
                "max_tokens": max_tokens,
                "n_batch": config.llama_n_batch,
                "batch_token_headroom": config.llama_batch_token_headroom,
                "batch_token_limit": embedding_batch_token_limit(),
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
    batch_token_limit = embedding_batch_token_limit()
    for chunk in chunks:
        if chunk.token_count > batch_token_limit:
            if current:
                groups.append(current)
                current = []
                current_tokens = 0
            groups.append([chunk])
            continue
        if current and current_tokens + chunk.token_count > batch_token_limit:
            groups.append(current)
            current = []
            current_tokens = 0
        current.append(chunk)
        current_tokens += chunk.token_count
    if current:
        groups.append(current)
    return groups


def embed_group(group: list[ChunkCandidate]) -> tuple[list[list[float]], int | None]:
    server = require_embedding_server()
    texts = [chunk.text for chunk in group]
    batch_token_limit = embedding_batch_token_limit()
    if len(group) == 1 and group[0].token_count > batch_token_limit:
        logger.debug(
            "embedding batch fell back to single long chunk",
            extra={
                "event": event("embedding.batch.fallback_single"),
                "embedding": {
                    "chunk_count": 1,
                    "token_count": group[0].token_count,
                    "n_batch": config.llama_n_batch,
                    "batch_token_limit": batch_token_limit,
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
                    "batch_token_limit": batch_token_limit,
                },
            },
        )
    vectors, measured_tokens = server.embed(texts)
    logger.debug(
        "embedding batch completed",
        extra={
            "event": event("embedding.batch.completed"),
            "embedding": {
                "chunk_count": len(group),
                "measured_tokens": measured_tokens,
            },
        },
    )
    if len(vectors) != len(group):
        raise ValueError("model returned an unexpected embedding count")
    return vectors, measured_tokens


def scheduled_embeddings(
    chunks: list[ChunkCandidate], priority: str
) -> tuple[list[list[float]], int | None]:
    vectors: list[list[float]] = []
    measured_token_total = 0
    measured_token_count = 0
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
            group_vectors, measured_tokens = embed_group(group)
            vectors.extend(group_vectors)
            if measured_tokens is not None:
                measured_token_total += measured_tokens
                measured_token_count += 1
            logger.debug(
                "embedding scheduler released model slot",
                extra={
                    "event": event("embedding.scheduler.released"),
                    "priority": priority,
                    "queue": embedding_scheduler.snapshot().__dict__,
                },
            )
    return vectors, measured_token_total if measured_token_count > 0 else None


def embed_texts(texts: list[str], requested_priority: str | None) -> EmbedResponse:
    require_embedding_server()

    priority = normalize_embedding_priority(requested_priority)
    chunks: list[ChunkCandidate] = []
    for input_index, text in enumerate(texts):
        chunks.extend(scheduled_text_chunks(text, input_index, priority))

    vectors, measured_tokens = scheduled_embeddings(chunks, priority)
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
            tokenCount=chunk.token_count,
            text=chunk.text,
            vector=vector,
        )
        for chunk, vector in zip(chunks, vectors, strict=True)
    ]
    return EmbedResponse(
        model=config.model_name,
        dimensions=dimensions,
        measuredTokens=measured_tokens,
        vectors=vectors,
        chunks=embedded_chunks,
    )


def load_reranker_model() -> None:
    global reranker_server
    if not config.reranker_enabled:
        return
    if reranker_server is None or not reranker_server.is_running():
        with reranker_lock:
            if reranker_server is None or not reranker_server.is_running():
                logger.info(
                    "reranker load started",
                    extra={
                        "event": event("embedding.reranker.load_started"),
                        "reranker": {
                            "model_key": config.reranker_key,
                            "runtime": "llama-server",
                        },
                    },
                )
                try:
                    model_path = resolve_reranker_model_path()
                    reranker_server = LlamaServerClient(
                        name="reranker",
                        model_path=model_path,
                        port=config.reranker_server_port,
                        pooling="rank",
                        embedding=True,
                        reranking=True,
                        n_ctx=config.reranker_n_ctx,
                        n_threads=config.reranker_n_threads,
                        n_batch=config.reranker_n_batch,
                        n_ubatch=config.reranker_n_ubatch,
                        parallel=config.reranker_parallel,
                        prompt_cache_enabled=config.reranker_prompt_cache_enabled,
                    )
                    reranker_server.start()
                except Exception as error:
                    logger.error(
                        "reranker load failed",
                        extra={
                            "event": event("embedding.reranker.load_failed"),
                            "reranker": {"model_key": config.reranker_key},
                            "error": error_type(error),
                        },
                    )
                    reranker_server = None
                    raise
                logger.info(
                    "reranker load completed",
                    extra={
                        "event": event("embedding.reranker.load_completed"),
                        "reranker": {
                            "model_key": config.reranker_key,
                            "runtime": "llama-server",
                        },
                    },
                )


def get_reranker() -> LlamaServerClient:
    if not config.reranker_enabled:
        raise HTTPException(status_code=404, detail="reranker is disabled")
    load_reranker_model()
    if reranker_server is None or not reranker_server.is_running():
        raise HTTPException(status_code=503, detail="reranker model is still loading")
    return reranker_server


def resolve_reranker_model_path() -> str:
    if config.reranker_model_path:
        return config.reranker_model_path
    if config.reranker_repo is None or config.reranker_file is None:
        raise HTTPException(status_code=404, detail="reranker is disabled")
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=config.reranker_repo, filename=config.reranker_file)


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
    scores = local_reranker.rerank(query, documents)
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
