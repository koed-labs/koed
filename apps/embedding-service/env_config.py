import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent

os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
load_dotenv(APP_DIR / ".env", override=False)


@dataclass(frozen=True)
class SupportedEmbeddingModel:
    key: str
    repo: str
    file: str
    dimensions: int


@dataclass(frozen=True)
class SupportedRerankerModel:
    key: str
    repo: str
    file: str


SUPPORTED_EMBEDDING_MODELS: dict[str, SupportedEmbeddingModel] = {
    "qwen3-0.6b": SupportedEmbeddingModel(
        key="qwen3-0.6b",
        repo="Qwen/Qwen3-Embedding-0.6B-GGUF",
        file="Qwen3-Embedding-0.6B-Q8_0.gguf",
        dimensions=1024,
    )
}

SUPPORTED_RERANKER_MODELS: dict[str, SupportedRerankerModel] = {
    "qwen3-reranker-0.6b": SupportedRerankerModel(
        key="qwen3-reranker-0.6b",
        repo="Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp",
        file="Qwen3-Reranker-0.6B-Q4_K_M.gguf",
    )
}

DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b"
DEFAULT_EMBEDDING_MAX_TOKENS = 4096
DEFAULT_LLAMA_BATCH_TOKEN_HEADROOM = 8
DEFAULT_LLAMA_SERVER_BINARY = "/opt/llama.cpp/llama-server"
QWEN_OPERATIONAL_MAX_TOKENS = 32768


def int_env(name: str, fallback: int) -> int:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def bool_env(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return fallback
    return value.strip().lower() in {"1", "true", "yes", "on"}


def str_env(name: str, fallback: str) -> str:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return fallback
    return value.strip()


@dataclass(frozen=True)
class EmbeddingServiceEnv:
    model_key: str
    model_repo: str
    model_file: str
    model_path: str | None
    model_name: str
    expected_dimensions: int
    batch_limit: int
    llama_n_ctx: int
    embedding_max_tokens: int
    embedding_max_text_chars: int
    embedding_max_request_chars: int
    llama_n_threads: int
    llama_n_batch: int
    llama_batch_token_headroom: int
    llama_n_ubatch: int
    llama_parallel: int
    llama_server_binary: str
    llama_server_startup_timeout_seconds: int
    embedding_server_port: int
    reranker_key: str | None
    reranker_repo: str | None
    reranker_file: str | None
    reranker_model_path: str | None
    reranker_server_port: int
    reranker_batch_limit: int
    reranker_context_per_slot: int
    reranker_n_ctx: int
    reranker_n_threads: int
    reranker_n_batch: int
    reranker_n_ubatch: int
    reranker_parallel: int
    reranker_prompt_cache_enabled: bool
    embedding_service_token: str
    log_level: str

    @property
    def reranker_enabled(self) -> bool:
        return self.reranker_repo is not None or self.reranker_model_path is not None

    @property
    def reranker_model(self) -> str | None:
        if self.reranker_key is None:
            return None
        if self.reranker_model_path is not None:
            return self.reranker_model_path
        if self.reranker_repo is not None and self.reranker_file is not None:
            return f"{self.reranker_repo}:{self.reranker_file}"
        return self.reranker_key


def resolve_env() -> EmbeddingServiceEnv:
    model_key = os.getenv("MODEL_KEY", DEFAULT_EMBEDDING_MODEL_KEY).strip()
    if not model_key:
        model_key = DEFAULT_EMBEDDING_MODEL_KEY
    model_config = SUPPORTED_EMBEDDING_MODELS.get(model_key)
    if model_config is None:
        supported = ", ".join(sorted(SUPPORTED_EMBEDDING_MODELS))
        raise ValueError(f"Unsupported MODEL_KEY {model_key!r}. Supported model keys: {supported}")

    reranker_key = os.getenv("RERANKER_KEY", "").strip()
    reranker_model_path = os.getenv("RERANKER_MODEL_PATH") or None
    reranker_config = None
    if reranker_key:
        reranker_config = SUPPORTED_RERANKER_MODELS.get(reranker_key)
        if reranker_config is None:
            supported = ", ".join(sorted(SUPPORTED_RERANKER_MODELS))
            raise ValueError(
                f"Unsupported RERANKER_KEY {reranker_key!r}. Supported model keys: {supported}"
            )
    elif reranker_model_path:
        raise ValueError("RERANKER_MODEL_PATH requires a supported RERANKER_KEY for model identity")

    llama_n_ctx = min(
        int_env("LLAMA_N_CTX", QWEN_OPERATIONAL_MAX_TOKENS),
        QWEN_OPERATIONAL_MAX_TOKENS,
    )
    llama_n_batch = int_env("LLAMA_N_BATCH", 8192)
    llama_batch_token_headroom = int_env(
        "LLAMA_BATCH_TOKEN_HEADROOM", DEFAULT_LLAMA_BATCH_TOKEN_HEADROOM
    )
    llama_batch_token_limit = max(1, llama_n_batch - llama_batch_token_headroom)
    reranker_context_per_slot = min(
        int_env("RERANKER_CONTEXT_PER_SLOT", 8192),
        QWEN_OPERATIONAL_MAX_TOKENS,
    )
    reranker_parallel = int_env("RERANKER_PARALLEL", 4)
    reranker_n_ctx = min(
        int_env("RERANKER_LLAMA_N_CTX", reranker_context_per_slot * reranker_parallel),
        QWEN_OPERATIONAL_MAX_TOKENS * reranker_parallel,
    )
    reranker_n_batch = int_env("RERANKER_LLAMA_N_BATCH", reranker_context_per_slot)
    reranker_n_ubatch = int_env("RERANKER_LLAMA_N_UBATCH", reranker_n_batch)
    embedding_server_port = int_env("LLAMA_EMBEDDING_SERVER_PORT", 18080)
    reranker_server_port = int_env("LLAMA_RERANKER_SERVER_PORT", 18081)
    if embedding_server_port == reranker_server_port:
        raise ValueError("LLAMA_EMBEDDING_SERVER_PORT and LLAMA_RERANKER_SERVER_PORT must differ")

    return EmbeddingServiceEnv(
        model_key=model_config.key,
        model_repo=model_config.repo,
        model_file=model_config.file,
        model_path=os.getenv("MODEL_PATH") or None,
        model_name=model_config.key,
        expected_dimensions=model_config.dimensions,
        batch_limit=int_env("EMBEDDING_BATCH_LIMIT", 16),
        llama_n_ctx=llama_n_ctx,
        embedding_max_tokens=min(
            int_env("EMBEDDING_MAX_TOKENS", DEFAULT_EMBEDDING_MAX_TOKENS),
            QWEN_OPERATIONAL_MAX_TOKENS,
            llama_n_ctx,
            llama_batch_token_limit,
        ),
        embedding_max_text_chars=int_env("EMBEDDING_MAX_TEXT_CHARS", 200000),
        embedding_max_request_chars=int_env("EMBEDDING_MAX_REQUEST_CHARS", 1000000),
        llama_n_threads=int_env("LLAMA_N_THREADS", os.cpu_count() or 1),
        llama_n_batch=llama_n_batch,
        llama_batch_token_headroom=llama_batch_token_headroom,
        llama_n_ubatch=int_env("LLAMA_N_UBATCH", llama_n_batch),
        llama_parallel=int_env("LLAMA_PARALLEL", 1),
        llama_server_binary=str_env("LLAMA_SERVER_BINARY", DEFAULT_LLAMA_SERVER_BINARY),
        llama_server_startup_timeout_seconds=int_env("LLAMA_SERVER_STARTUP_TIMEOUT_SECONDS", 180),
        embedding_server_port=embedding_server_port,
        reranker_key=reranker_config.key if reranker_config else None,
        reranker_repo=reranker_config.repo if reranker_config else None,
        reranker_file=reranker_config.file if reranker_config else None,
        reranker_model_path=reranker_model_path,
        reranker_server_port=reranker_server_port,
        reranker_batch_limit=int_env("RERANKER_BATCH_LIMIT", 100),
        reranker_context_per_slot=reranker_context_per_slot,
        reranker_n_ctx=reranker_n_ctx,
        reranker_n_threads=int_env(
            "RERANKER_LLAMA_N_THREADS", int_env("LLAMA_N_THREADS", os.cpu_count() or 1)
        ),
        reranker_n_batch=reranker_n_batch,
        reranker_n_ubatch=reranker_n_ubatch,
        reranker_parallel=reranker_parallel,
        reranker_prompt_cache_enabled=bool_env("RERANKER_PROMPT_CACHE_ENABLED", True),
        embedding_service_token=os.getenv("EMBEDDING_SERVICE_TOKEN", "").strip(),
        log_level=os.getenv("LOG_LEVEL", "info").strip() or "info",
    )
