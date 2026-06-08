import os
import unittest
from unittest.mock import patch

from env_config import (
    DEFAULT_LLAMA_SERVER_BINARY,
    QWEN_OPERATIONAL_MAX_TOKENS,
    bool_env,
    int_env,
    resolve_env,
    str_env,
)


class EnvConfigTest(unittest.TestCase):
    def test_int_env_uses_positive_integer_or_fallback(self) -> None:
        with patch.dict(os.environ, {"COUNT": "12"}, clear=False):
            self.assertEqual(int_env("COUNT", 3), 12)
        with patch.dict(os.environ, {"COUNT": "0"}, clear=False):
            self.assertEqual(int_env("COUNT", 3), 3)
        with patch.dict(os.environ, {"COUNT": "not-a-number"}, clear=False):
            self.assertEqual(int_env("COUNT", 3), 3)

    def test_bool_env_accepts_truthy_values(self) -> None:
        with patch.dict(os.environ, {"FLAG": "yes"}, clear=False):
            self.assertTrue(bool_env("FLAG", False))
        with patch.dict(os.environ, {"FLAG": "false"}, clear=False):
            self.assertFalse(bool_env("FLAG", True))

    def test_str_env_uses_trimmed_value_or_fallback(self) -> None:
        with patch.dict(os.environ, {"PATH_VALUE": " /custom/bin "}, clear=False):
            self.assertEqual(str_env("PATH_VALUE", "/fallback"), "/custom/bin")
        with patch.dict(os.environ, {"PATH_VALUE": ""}, clear=False):
            self.assertEqual(str_env("PATH_VALUE", "/fallback"), "/fallback")

    def test_resolve_env_applies_defaults_and_relationships(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LLAMA_N_CTX": "4096",
                "EMBEDDING_MAX_TOKENS": "",
                "EMBEDDING_SERVICE_TOKEN": " token ",
                "LOG_LEVEL": "debug",
            },
            clear=True,
        ):
            config = resolve_env()

        self.assertEqual(config.model_key, "qwen3-0.6b")
        self.assertEqual(config.model_repo, "Qwen/Qwen3-Embedding-0.6B-GGUF")
        self.assertEqual(config.model_name, "qwen3-0.6b")
        self.assertEqual(config.expected_dimensions, 1024)
        self.assertEqual(config.llama_n_ctx, 4096)
        self.assertEqual(config.embedding_max_tokens, 4096)
        self.assertFalse(config.reranker_enabled)
        self.assertIsNone(config.reranker_key)
        self.assertIsNone(config.reranker_model)
        self.assertEqual(config.embedding_service_token, "token")
        self.assertEqual(config.log_level, "debug")
        self.assertEqual(config.llama_n_batch, 8192)
        self.assertEqual(config.llama_batch_token_headroom, 8)
        self.assertEqual(config.llama_n_ubatch, 8192)
        self.assertEqual(config.llama_parallel, 1)
        self.assertEqual(config.llama_server_binary, DEFAULT_LLAMA_SERVER_BINARY)
        self.assertEqual(config.embedding_server_port, 18080)
        self.assertEqual(config.reranker_context_per_slot, 8192)
        self.assertEqual(config.reranker_n_ctx, 32768)
        self.assertEqual(config.reranker_n_batch, 8192)
        self.assertEqual(config.reranker_n_ubatch, 8192)
        self.assertEqual(config.reranker_parallel, 4)
        self.assertTrue(config.reranker_prompt_cache_enabled)

    def test_resolve_env_defaults_embedding_max_tokens_to_operational_chunk_size(self) -> None:
        with patch.dict(os.environ, {"EMBEDDING_MAX_TOKENS": ""}, clear=True):
            config = resolve_env()

        self.assertEqual(config.llama_n_ctx, 32768)
        self.assertEqual(config.embedding_max_tokens, 4096)

    def test_resolve_env_caps_embedding_max_tokens_to_qwen_limit(self) -> None:
        above_qwen_limit = str(QWEN_OPERATIONAL_MAX_TOKENS + 1)
        with patch.dict(
            os.environ,
            {
                "LLAMA_N_CTX": above_qwen_limit,
                "LLAMA_N_BATCH": str(QWEN_OPERATIONAL_MAX_TOKENS + 8),
                "EMBEDDING_MAX_TOKENS": above_qwen_limit,
            },
            clear=True,
        ):
            config = resolve_env()

        self.assertEqual(config.llama_n_ctx, QWEN_OPERATIONAL_MAX_TOKENS)
        self.assertEqual(config.embedding_max_tokens, QWEN_OPERATIONAL_MAX_TOKENS)

    def test_resolve_env_caps_embedding_max_tokens_to_context(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LLAMA_N_CTX": "2048",
                "EMBEDDING_MAX_TOKENS": "4096",
            },
            clear=True,
        ):
            config = resolve_env()

        self.assertEqual(config.llama_n_ctx, 2048)
        self.assertEqual(config.embedding_max_tokens, 2048)

    def test_resolve_env_caps_embedding_max_tokens_to_safe_batch_limit(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LLAMA_N_CTX": "32768",
                "LLAMA_N_BATCH": "8192",
                "LLAMA_BATCH_TOKEN_HEADROOM": "8",
                "EMBEDDING_MAX_TOKENS": "32768",
            },
            clear=True,
        ):
            config = resolve_env()

        self.assertEqual(config.llama_n_batch, 8192)
        self.assertEqual(config.llama_batch_token_headroom, 8)
        self.assertEqual(config.embedding_max_tokens, 8184)

    def test_resolve_env_rejects_unknown_model_key(self) -> None:
        with patch.dict(os.environ, {"MODEL_KEY": "unsupported"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Unsupported MODEL_KEY"):
                resolve_env()

    def test_blank_model_key_uses_default(self) -> None:
        with patch.dict(os.environ, {"MODEL_KEY": ""}, clear=True):
            self.assertEqual(resolve_env().model_key, "qwen3-0.6b")

    def test_blank_llama_server_binary_uses_default(self) -> None:
        with patch.dict(os.environ, {"LLAMA_SERVER_BINARY": ""}, clear=True):
            self.assertEqual(resolve_env().llama_server_binary, DEFAULT_LLAMA_SERVER_BINARY)

    def test_resolve_env_resolves_supported_reranker_key(self) -> None:
        with patch.dict(os.environ, {"RERANKER_KEY": "qwen3-reranker-0.6b"}, clear=True):
            config = resolve_env()

        self.assertTrue(config.reranker_enabled)
        self.assertEqual(config.reranker_key, "qwen3-reranker-0.6b")
        self.assertEqual(config.reranker_repo, "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp")
        self.assertEqual(config.reranker_file, "Qwen3-Reranker-0.6B-Q4_K_M.gguf")
        self.assertEqual(
            config.reranker_model,
            "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp:Qwen3-Reranker-0.6B-Q4_K_M.gguf",
        )

    def test_resolve_env_uses_separate_reranker_llama_settings(self) -> None:
        with patch.dict(
            os.environ,
            {
                "RERANKER_KEY": "qwen3-reranker-0.6b",
                "LLAMA_N_CTX": "4096",
                "LLAMA_PARALLEL": "1",
                "RERANKER_CONTEXT_PER_SLOT": "2048",
                "RERANKER_PARALLEL": "3",
                "RERANKER_LLAMA_N_THREADS": "7",
                "RERANKER_LLAMA_N_BATCH": "2048",
                "RERANKER_LLAMA_N_UBATCH": "1024",
                "RERANKER_PROMPT_CACHE_ENABLED": "false",
            },
            clear=True,
        ):
            config = resolve_env()

        self.assertEqual(config.llama_n_ctx, 4096)
        self.assertEqual(config.llama_parallel, 1)
        self.assertEqual(config.reranker_context_per_slot, 2048)
        self.assertEqual(config.reranker_n_ctx, 6144)
        self.assertEqual(config.reranker_n_threads, 7)
        self.assertEqual(config.reranker_n_batch, 2048)
        self.assertEqual(config.reranker_n_ubatch, 1024)
        self.assertEqual(config.reranker_parallel, 3)
        self.assertFalse(config.reranker_prompt_cache_enabled)

    def test_blank_reranker_key_disables_reranking(self) -> None:
        with patch.dict(os.environ, {"RERANKER_KEY": ""}, clear=True):
            self.assertFalse(resolve_env().reranker_enabled)

    def test_resolve_env_rejects_unknown_reranker_key(self) -> None:
        with patch.dict(os.environ, {"RERANKER_KEY": "unsupported"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Unsupported RERANKER_KEY"):
                resolve_env()

    def test_resolve_env_requires_reranker_key_for_path_override(self) -> None:
        with patch.dict(os.environ, {"RERANKER_MODEL_PATH": "/models/reranker.gguf"}, clear=True):
            with self.assertRaisesRegex(ValueError, "RERANKER_MODEL_PATH requires"):
                resolve_env()

    def test_resolve_env_rejects_port_collision(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LLAMA_EMBEDDING_SERVER_PORT": "18080",
                "LLAMA_RERANKER_SERVER_PORT": "18080",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "must differ"):
                resolve_env()


if __name__ == "__main__":
    unittest.main()
