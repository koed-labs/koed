import os
import unittest
from unittest.mock import patch

from env_config import bool_env, int_env, resolve_env


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

    def test_resolve_env_applies_defaults_and_relationships(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LLAMA_N_CTX": "4096",
                "EMBEDDING_MAX_TOKENS": "",
                "EMBEDDING_SERVICE_TOKEN": " token ",
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

    def test_resolve_env_rejects_unknown_model_key(self) -> None:
        with patch.dict(os.environ, {"MODEL_KEY": "unsupported"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Unsupported MODEL_KEY"):
                resolve_env()

    def test_blank_model_key_uses_default(self) -> None:
        with patch.dict(os.environ, {"MODEL_KEY": ""}, clear=True):
            self.assertEqual(resolve_env().model_key, "qwen3-0.6b")

    def test_resolve_env_resolves_supported_reranker_key(self) -> None:
        with patch.dict(os.environ, {"RERANKER_KEY": "qwen3-reranker-0.6b"}, clear=True):
            config = resolve_env()

        self.assertTrue(config.reranker_enabled)
        self.assertEqual(config.reranker_key, "qwen3-reranker-0.6b")
        self.assertEqual(config.reranker_model, "n24q02m/Qwen3-Reranker-0.6B-ONNX")

    def test_blank_reranker_key_disables_reranking(self) -> None:
        with patch.dict(os.environ, {"RERANKER_KEY": ""}, clear=True):
            self.assertFalse(resolve_env().reranker_enabled)

    def test_resolve_env_rejects_unknown_reranker_key(self) -> None:
        with patch.dict(os.environ, {"RERANKER_KEY": "unsupported"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Unsupported RERANKER_KEY"):
                resolve_env()


if __name__ == "__main__":
    unittest.main()
