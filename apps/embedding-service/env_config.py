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
    model: str


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
        model="n24q02m/Qwen3-Reranker-0.6B-ONNX",
    )
}

DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b"
QWEN_OPERATIONAL_MAX_TOKENS = 32000


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
    suppress_llama_warnings: bool
    reranker_key: str | None
    reranker_model: str | None
    reranker_batch_limit: int
    embedding_service_token: str

    @property
    def reranker_enabled(self) -> bool:
        return self.reranker_model is not None


def resolve_env() -> EmbeddingServiceEnv:
    model_key = os.getenv("MODEL_KEY", DEFAULT_EMBEDDING_MODEL_KEY).strip()
    if not model_key:
        model_key = DEFAULT_EMBEDDING_MODEL_KEY
    model_config = SUPPORTED_EMBEDDING_MODELS.get(model_key)
    if model_config is None:
        supported = ", ".join(sorted(SUPPORTED_EMBEDDING_MODELS))
        raise ValueError(
            f"Unsupported MODEL_KEY {model_key!r}. Supported model keys: {supported}"
        )

    reranker_key = os.getenv("RERANKER_KEY", "").strip()
    reranker_config = None
    if reranker_key:
        reranker_config = SUPPORTED_RERANKER_MODELS.get(reranker_key)
        if reranker_config is None:
            supported = ", ".join(sorted(SUPPORTED_RERANKER_MODELS))
            raise ValueError(
                f"Unsupported RERANKER_KEY {reranker_key!r}. Supported model keys: {supported}"
            )

    llama_n_ctx = min(
        int_env("LLAMA_N_CTX", QWEN_OPERATIONAL_MAX_TOKENS),
        QWEN_OPERATIONAL_MAX_TOKENS,
    )
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
            int_env("EMBEDDING_MAX_TOKENS", llama_n_ctx),
            QWEN_OPERATIONAL_MAX_TOKENS,
        ),
        embedding_max_text_chars=int_env("EMBEDDING_MAX_TEXT_CHARS", 200000),
        embedding_max_request_chars=int_env("EMBEDDING_MAX_REQUEST_CHARS", 1000000),
        llama_n_threads=int_env("LLAMA_N_THREADS", os.cpu_count() or 1),
        llama_n_batch=int_env("LLAMA_N_BATCH", 512),
        suppress_llama_warnings=bool_env("EMBEDDING_SUPPRESS_LLAMA_WARNINGS", True),
        reranker_key=reranker_config.key if reranker_config else None,
        reranker_model=reranker_config.model if reranker_config else None,
        reranker_batch_limit=int_env("RERANKER_BATCH_LIMIT", 100),
        embedding_service_token=os.getenv("EMBEDDING_SERVICE_TOKEN", "").strip(),
    )
