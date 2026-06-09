import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as app_module
import auth
from schemas import EmbeddedChunk, EmbedResponse, RerankResponse


class EmbeddingServiceRouteTest(unittest.TestCase):
    def client(self) -> TestClient:
        lifecycle_patches = (
            patch.object(app_module, "load_embedding_model"),
            patch.object(app_module, "load_reranker_model"),
        )
        for item in lifecycle_patches:
            item.start()
            self.addCleanup(item.stop)
        client = TestClient(app_module.app)
        self.addCleanup(client.close)
        return client

    def test_health_reports_ready_only_when_configured_reranker_is_loaded(self) -> None:
        client = self.client()
        fake_config = SimpleNamespace(
            model_key="qwen3-0.6b",
            model_name="qwen3-0.6b",
            expected_dimensions=1024,
            batch_limit=16,
            embedding_max_tokens=4096,
            embedding_max_text_chars=200000,
            embedding_max_request_chars=1000000,
            model_repo="Qwen/Qwen3-Embedding-0.6B-GGUF",
            model_file="Qwen3-Embedding-0.6B-Q8_0.gguf",
            llama_n_ctx=32768,
            reranker_enabled=True,
            reranker_key="qwen3-reranker-0.6b",
            reranker_model="reranker-model",
            reranker_batch_limit=100,
        )

        with (
            patch.object(app_module, "config", fake_config),
            patch.object(app_module, "embedding_token_auth_status", return_value=(True, True)),
            patch.object(app_module, "is_model_loaded", return_value=True),
            patch.object(app_module, "is_reranker_loaded", return_value=False),
            patch.object(app_module, "health_queue_snapshot", return_value={"active": False}),
        ):
            response = client.get("/health", headers={"x-koed-embedding-token": "secret"})

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["status"], "loading")
        self.assertEqual(payload["reranker"]["enabled"], True)
        self.assertEqual(payload["reranker"]["loaded"], False)
        self.assertEqual(payload["queue"], {"active": False})

    def test_health_returns_200_when_required_processes_are_loaded(self) -> None:
        client = self.client()
        fake_config = SimpleNamespace(
            model_key="qwen3-0.6b",
            model_name="qwen3-0.6b",
            expected_dimensions=1024,
            batch_limit=16,
            embedding_max_tokens=4096,
            embedding_max_text_chars=200000,
            embedding_max_request_chars=1000000,
            model_repo="Qwen/Qwen3-Embedding-0.6B-GGUF",
            model_file="Qwen3-Embedding-0.6B-Q8_0.gguf",
            llama_n_ctx=32768,
            reranker_enabled=True,
            reranker_key="qwen3-reranker-0.6b",
            reranker_model="reranker-model",
            reranker_batch_limit=100,
        )

        with (
            patch.object(app_module, "config", fake_config),
            patch.object(app_module, "embedding_token_auth_status", return_value=(True, True)),
            patch.object(app_module, "is_model_loaded", return_value=True),
            patch.object(app_module, "is_reranker_loaded", return_value=True),
            patch.object(app_module, "health_queue_snapshot", return_value={"active": False}),
        ):
            response = client.get("/health", headers={"x-koed-embedding-token": "secret"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["reranker"]["loaded"], True)

    def test_embed_requires_internal_token_and_returns_chunk_metadata(self) -> None:
        client = self.client()
        result = EmbedResponse(
            model="qwen3-0.6b",
            dimensions=3,
            measuredTokens=2,
            vectors=[[1.0, 0.0, 0.0]],
            chunks=[
                EmbeddedChunk(
                    inputIndex=0,
                    chunkIndex=0,
                    chunkCount=1,
                    tokenCount=2,
                    text="hello memory",
                    vector=[1.0, 0.0, 0.0],
                )
            ],
        )

        with (
            patch.object(auth, "config", SimpleNamespace(embedding_service_token="secret")),
            patch.object(app_module, "embed_texts", return_value=result) as embed_texts,
        ):
            rejected = client.post("/embed", json={"texts": ["hello memory"]})
            accepted = client.post(
                "/embed",
                json={"texts": ["hello memory"]},
                headers={
                    "x-koed-embedding-token": "secret",
                    "x-koed-embedding-priority": "background",
                },
            )

        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["measuredTokens"], 2)
        self.assertEqual(accepted.json()["chunks"][0]["chunkCount"], 1)
        self.assertEqual(accepted.json()["chunks"][0]["tokenCount"], 2)
        embed_texts.assert_called_once_with(["hello memory"], "background")

    def test_rerank_maps_model_failures_to_http_500_without_content_logging(self) -> None:
        client = self.client()
        with (
            patch.object(auth, "config", SimpleNamespace(embedding_service_token="secret")),
            patch.object(app_module, "rerank_texts", side_effect=RuntimeError("server down")),
        ):
            response = client.post(
                "/rerank",
                json={"query": "question", "documents": ["one", "two"]},
                headers={"x-koed-embedding-token": "secret"},
            )

        self.assertEqual(response.status_code, 500)
        self.assertIn("model reranking failed", response.json()["detail"])

    def test_rerank_returns_scores_in_adapter_contract_shape(self) -> None:
        client = self.client()
        result = RerankResponse(model="qwen3-reranker-0.6b", scores=[0.2, 0.9])

        with (
            patch.object(auth, "config", SimpleNamespace(embedding_service_token="")),
            patch.object(app_module, "rerank_texts", return_value=result) as rerank_texts,
        ):
            response = client.post(
                "/rerank",
                json={"query": "question", "documents": ["one", "two"]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"model": "qwen3-reranker-0.6b", "scores": [0.2, 0.9]})
        rerank_texts.assert_called_once_with("question", ["one", "two"])


if __name__ == "__main__":
    unittest.main()
