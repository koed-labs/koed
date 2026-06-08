import unittest
from types import SimpleNamespace
from unittest.mock import mock_open, patch

import runtime


class FakeLlamaServer:
    def __init__(self) -> None:
        self.embed_inputs: list[list[str]] = []
        self.rerank_inputs: list[tuple[str, list[str]]] = []
        self.token_text_by_id: dict[int, str] = {}

    def is_running(self) -> bool:
        return True

    def stop(self) -> None:
        return None

    def tokenize(self, text: str) -> list[runtime.TokenPiece]:
        self.token_text_by_id = {
            index: piece if index == 0 else f" {piece}"
            for index, piece in enumerate(text.split(" "))
        }
        return [
            runtime.TokenPiece(
                token_id=index,
                text=self.token_text_by_id[index],
            )
            for index, piece in enumerate(text.split(" "))
        ]

    def detokenize(self, token_ids: list[int]) -> str:
        return "".join(self.token_text_by_id[token_id] for token_id in token_ids)

    def embed(self, texts: list[str]) -> tuple[list[list[float]], int]:
        self.embed_inputs.append(texts)
        return (
            [[float(index + 1), 1.0, 0.0] for index, _ in enumerate(texts)],
            len(" ".join(texts).split()),
        )

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        self.rerank_inputs.append((query, documents))
        return [float(len(document)) for document in documents]


class DeadLlamaServer(FakeLlamaServer):
    def is_running(self) -> bool:
        return False


def fake_config(**overrides):
    values = {
        "embedding_max_tokens": 100,
        "llama_n_ctx": 100,
        "llama_n_batch": 5,
        "llama_batch_token_headroom": 0,
        "llama_n_ubatch": 5,
        "llama_parallel": 1,
        "expected_dimensions": 3,
        "model_name": "test-model",
        "reranker_enabled": False,
        "reranker_model_path": None,
        "reranker_repo": None,
        "reranker_file": None,
        "reranker_key": None,
        "reranker_server_port": 18081,
        "reranker_n_ctx": 100,
        "reranker_n_threads": 5,
        "reranker_n_batch": 5,
        "reranker_n_ubatch": 5,
        "reranker_parallel": 1,
        "reranker_prompt_cache_enabled": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class RuntimeTest(unittest.TestCase):
    def test_embed_texts_preserves_chunk_order_and_metadata(self) -> None:
        fake_server = FakeLlamaServer()
        with (
            patch.object(runtime, "config", fake_config()),
            patch.object(runtime, "embedding_server", fake_server),
        ):
            response = runtime.embed_texts(["one two", "three four"], "background")

        self.assertEqual(response.model, "test-model")
        self.assertEqual(response.dimensions, 3)
        self.assertEqual(response.measuredTokens, 4)
        self.assertEqual(fake_server.embed_inputs, [["one two", "three four"]])
        self.assertEqual([chunk.inputIndex for chunk in response.chunks], [0, 1])
        self.assertEqual([chunk.chunkIndex for chunk in response.chunks], [0, 0])
        self.assertEqual([chunk.chunkCount for chunk in response.chunks], [1, 1])
        self.assertEqual([chunk.tokenCount for chunk in response.chunks], [2, 2])
        self.assertEqual([chunk.text for chunk in response.chunks], ["one two", "three four"])
        self.assertEqual(len(response.vectors), 2)

    def test_embed_texts_batches_short_chunks_and_splits_long_input(self) -> None:
        fake_server = FakeLlamaServer()
        with (
            patch.object(runtime, "config", fake_config()),
            patch.object(runtime, "embedding_server", fake_server),
        ):
            runtime.embed_texts(
                [
                    "one two",
                    "three four",
                    "five six seven eight nine ten",
                ],
                "background",
            )

        self.assertEqual(
            fake_server.embed_inputs,
            [
                ["one two", "three four"],
                ["five six seven eight nine"],
                ["ten"],
            ],
        )

    def test_split_text_chunks_using_token_pieces(self) -> None:
        fake_server = FakeLlamaServer()
        with (
            patch.object(runtime, "config", fake_config(embedding_max_tokens=2)),
            patch.object(runtime, "embedding_server", fake_server),
        ):
            chunks = runtime.split_text_by_embedding_tokens("one two three four", 0)

        self.assertEqual([chunk.text for chunk in chunks], ["one two", "three four"])
        self.assertEqual([chunk.token_count for chunk in chunks], [2, 2])
        self.assertEqual([chunk.chunk_count for chunk in chunks], [2, 2])

    def test_split_text_chunks_uses_detokenize_for_chunk_text(self) -> None:
        class UnicodeSplitServer(FakeLlamaServer):
            def tokenize(self, text: str) -> list[runtime.TokenPiece]:
                return [
                    runtime.TokenPiece(token_id=101, text="caf"),
                    runtime.TokenPiece(token_id=102, text="�"),
                    runtime.TokenPiece(token_id=103, text=" au"),
                    runtime.TokenPiece(token_id=104, text=" lait"),
                ]

            def detokenize(self, token_ids: list[int]) -> str:
                mapping = {
                    (101, 102): "café",
                    (103, 104): " au lait",
                }
                return mapping[tuple(token_ids)]

        fake_server = UnicodeSplitServer()
        with (
            patch.object(runtime, "config", fake_config(embedding_max_tokens=2)),
            patch.object(runtime, "embedding_server", fake_server),
        ):
            chunks = runtime.split_text_by_embedding_tokens("café au lait", 0)

        self.assertEqual([chunk.text for chunk in chunks], ["café", "au lait"])
        self.assertEqual([chunk.token_count for chunk in chunks], [2, 2])

    def test_embedding_groups_respects_n_batch(self) -> None:
        chunks = [
            runtime.ChunkCandidate(0, 0, 1, "a", 2),
            runtime.ChunkCandidate(1, 0, 1, "b", 3),
            runtime.ChunkCandidate(2, 0, 1, "c", 4),
        ]
        with patch.object(runtime, "config", fake_config(llama_n_batch=5)):
            groups = runtime.embedding_groups(chunks)
        self.assertEqual([[chunk.text for chunk in group] for group in groups], [["a", "b"], ["c"]])

    def test_embedding_groups_respects_safe_batch_headroom(self) -> None:
        chunks = [
            runtime.ChunkCandidate(0, 0, 1, "a", 2),
            runtime.ChunkCandidate(1, 0, 1, "b", 3),
            runtime.ChunkCandidate(2, 0, 1, "c", 1),
        ]
        with patch.object(
            runtime,
            "config",
            fake_config(llama_n_batch=5, llama_batch_token_headroom=1),
        ):
            groups = runtime.embedding_groups(chunks)
        self.assertEqual([[chunk.text for chunk in group] for group in groups], [["a"], ["b", "c"]])

    def test_split_text_respects_safe_batch_headroom(self) -> None:
        fake_server = FakeLlamaServer()
        with (
            patch.object(
                runtime,
                "config",
                fake_config(
                    embedding_max_tokens=5,
                    llama_n_ctx=100,
                    llama_n_batch=5,
                    llama_batch_token_headroom=1,
                ),
            ),
            patch.object(runtime, "embedding_server", fake_server),
        ):
            chunks = runtime.split_text_by_embedding_tokens("one two three four five", 0)

        self.assertEqual([chunk.text for chunk in chunks], ["one two three four", "five"])
        self.assertEqual([chunk.token_count for chunk in chunks], [4, 1])

    def test_extract_rerank_scores_keeps_original_document_order(self) -> None:
        scores = runtime._extract_rerank_scores(
            {
                "results": [
                    {"index": 1, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.2},
                ]
            },
            2,
        )

        self.assertEqual(scores, [0.2, 0.9])

    def test_rerank_texts_uses_llama_server_scores(self) -> None:
        fake_server = FakeLlamaServer()
        with (
            patch.object(
                runtime, "config", fake_config(reranker_enabled=True, reranker_key="test-reranker")
            ),
            patch.object(runtime, "get_reranker", return_value=fake_server),
        ):
            response = runtime.rerank_texts("query", ["short", "longer"])

        self.assertEqual(response.model, "test-reranker")
        self.assertEqual(response.scores, [5.0, 6.0])
        self.assertEqual(fake_server.rerank_inputs, [("query", ["short", "longer"])])

    def test_load_embedding_model_restarts_dead_llama_server(self) -> None:
        with (
            patch.object(
                runtime,
                "config",
                fake_config(
                    model_path="/models/embedding.gguf",
                    model_key="test-embedding",
                    model_repo="repo",
                    model_file="model.gguf",
                    embedding_server_port=18080,
                    llama_n_threads=7,
                ),
            ),
            patch.object(runtime.LlamaServerClient, "start") as start,
        ):
            old_server = DeadLlamaServer()
            runtime.embedding_server = old_server
            runtime.load_embedding_model()
            server = runtime.embedding_server
            runtime.embedding_server = None

        self.assertIsNotNone(server)
        self.assertIsNot(server, old_server)
        self.assertEqual(server.model_path, "/models/embedding.gguf")
        self.assertEqual(server.pooling, "last")
        self.assertTrue(server.embedding)
        self.assertFalse(server.reranking)
        start.assert_called_once()

    def test_load_reranker_model_starts_llama_server_when_configured(self) -> None:
        with (
            patch.object(
                runtime,
                "config",
                fake_config(
                    reranker_enabled=True,
                    reranker_key="test-reranker",
                    reranker_model_path="/models/reranker.gguf",
                ),
            ),
            patch.object(runtime.LlamaServerClient, "start") as start,
        ):
            runtime.reranker_server = None
            runtime.load_reranker_model()
            server = runtime.reranker_server
            runtime.reranker_server = None

        self.assertIsNotNone(server)
        self.assertEqual(server.model_path, "/models/reranker.gguf")
        self.assertEqual(server.pooling, "rank")
        self.assertTrue(server.embedding)
        self.assertTrue(server.reranking)
        start.assert_called_once()

    def test_load_reranker_model_is_noop_when_disabled(self) -> None:
        with patch.object(runtime, "config", fake_config(reranker_enabled=False)):
            runtime.reranker_server = None
            runtime.load_reranker_model()

        self.assertIsNone(runtime.reranker_server)

    def test_llama_server_client_uses_reranker_specific_geometry_and_cache(self) -> None:
        client = runtime.LlamaServerClient(
            name="reranker",
            model_path="/models/reranker.gguf",
            port=18081,
            pooling="rank",
            embedding=True,
            reranking=True,
            n_ctx=32768,
            n_threads=7,
            n_batch=8192,
            n_ubatch=8192,
            parallel=4,
            prompt_cache_enabled=True,
        )

        with (
            patch.object(runtime.subprocess, "Popen") as popen,
            patch.object(client, "wait_ready"),
            patch.object(runtime.Path, "open", mock_open()),
        ):
            popen.return_value.poll.return_value = None
            client.start()

        args = popen.call_args.args[0]
        self.assertIn("--reranking", args)
        self.assertEqual(args[args.index("--pooling") + 1], "rank")
        self.assertEqual(args[args.index("--ctx-size") + 1], "32768")
        self.assertEqual(args[args.index("--threads") + 1], "7")
        self.assertEqual(args[args.index("--batch-size") + 1], "8192")
        self.assertEqual(args[args.index("--ubatch-size") + 1], "8192")
        self.assertEqual(args[args.index("--parallel") + 1], "4")
        self.assertEqual(args[args.index("--poll") + 1], "0")
        self.assertEqual(args[args.index("--poll-batch") + 1], "0")
        self.assertNotIn("--no-cache-prompt", args)
        self.assertNotIn("--cache-ram", args)

    def test_llama_server_client_disables_prompt_cache_when_requested(self) -> None:
        client = runtime.LlamaServerClient(
            name="embedding",
            model_path="/models/embedding.gguf",
            port=18080,
            pooling="last",
            embedding=True,
            reranking=False,
            n_ctx=4096,
            n_threads=7,
            n_batch=4096,
            n_ubatch=4096,
            parallel=1,
            prompt_cache_enabled=False,
        )

        with (
            patch.object(runtime.subprocess, "Popen") as popen,
            patch.object(client, "wait_ready"),
            patch.object(runtime.Path, "open", mock_open()),
        ):
            popen.return_value.poll.return_value = None
            client.start()

        args = popen.call_args.args[0]
        self.assertIn("--no-cache-prompt", args)
        self.assertIn("--cache-ram", args)
        self.assertIn("--embd-normalize", args)
        self.assertEqual(args[args.index("--poll") + 1], "0")
        self.assertEqual(args[args.index("--poll-batch") + 1], "0")
        self.assertNotIn("--reranking", args)


if __name__ == "__main__":
    unittest.main()
