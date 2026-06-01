import unittest
from types import SimpleNamespace
from unittest.mock import patch

import runtime


class FakeEmbeddingModel:
    def __init__(self) -> None:
        self.create_embedding_inputs: list[str | list[str]] = []

    def tokenize(self, value: bytes, add_bos: bool = False) -> list[int]:
        del add_bos
        text = value.decode("utf-8")
        return list(range(len(text.split())))

    def detokenize(self, tokens: list[int]) -> bytes:
        return " ".join(f"token{token}" for token in tokens).encode("utf-8")

    def create_embedding(self, value: str | list[str], model: str | None = None):
        del model
        self.create_embedding_inputs.append(value)
        values = value if isinstance(value, list) else [value]
        return {
            "data": [{"embedding": [float(index + 1), 1.0, 0.0]} for index, _ in enumerate(values)]
        }


def fake_config(**overrides):
    values = {
        "embedding_max_tokens": 100,
        "llama_n_ctx": 100,
        "llama_n_batch": 5,
        "suppress_llama_warnings": False,
        "expected_dimensions": 3,
        "model_name": "test-model",
        "reranker_enabled": False,
        "reranker_model": None,
        "reranker_key": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class RuntimeTest(unittest.TestCase):
    def test_embed_texts_preserves_chunk_order_and_metadata(self) -> None:
        fake_model = FakeEmbeddingModel()
        with (
            patch.object(runtime, "config", fake_config()),
            patch.object(runtime, "model", fake_model),
        ):
            response = runtime.embed_texts(["one two", "three four"], "background")

        self.assertEqual(response.model, "test-model")
        self.assertEqual(response.dimensions, 3)
        self.assertEqual(fake_model.create_embedding_inputs, [["one two", "three four"]])
        self.assertEqual([chunk.inputIndex for chunk in response.chunks], [0, 1])
        self.assertEqual([chunk.chunkIndex for chunk in response.chunks], [0, 0])
        self.assertEqual([chunk.chunkCount for chunk in response.chunks], [1, 1])
        self.assertEqual([chunk.text for chunk in response.chunks], ["one two", "three four"])
        self.assertEqual(len(response.vectors), 2)

    def test_embed_texts_batches_short_chunks_and_falls_back_for_long_chunk(self) -> None:
        fake_model = FakeEmbeddingModel()
        with (
            patch.object(runtime, "config", fake_config()),
            patch.object(runtime, "model", fake_model),
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
            fake_model.create_embedding_inputs,
            [
                ["one two", "three four"],
                "five six seven eight nine ten",
            ],
        )

    def test_embedding_groups_respects_n_batch(self) -> None:
        chunks = [
            runtime.ChunkCandidate(0, 0, 1, "a", 2),
            runtime.ChunkCandidate(1, 0, 1, "b", 3),
            runtime.ChunkCandidate(2, 0, 1, "c", 4),
        ]
        with patch.object(runtime, "config", fake_config(llama_n_batch=5)):
            groups = runtime.embedding_groups(chunks)
        self.assertEqual([[chunk.text for chunk in group] for group in groups], [["a", "b"], ["c"]])


if __name__ == "__main__":
    unittest.main()
