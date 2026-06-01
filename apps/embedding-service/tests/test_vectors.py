import unittest

from vectors import extract_embedding_vectors, normalize_vector


class VectorHelpersTest(unittest.TestCase):
    def test_extract_embedding_vectors_accepts_llama_response(self) -> None:
        self.assertEqual(
            extract_embedding_vectors(
                {
                    "data": [
                        {"embedding": [1, 2.5, 3]},
                        {"embedding": [4.0, 5.0, 6.0]},
                    ]
                }
            ),
            [[1.0, 2.5, 3.0], [4.0, 5.0, 6.0]],
        )

    def test_extract_embedding_vectors_rejects_malformed_payloads(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid embedding"):
            extract_embedding_vectors({"data": [{"embedding": [[1.0]]}]})

    def test_normalize_vector_rejects_zero_vector(self) -> None:
        with self.assertRaisesRegex(ValueError, "zero vector"):
            normalize_vector([0.0, 0.0])


if __name__ == "__main__":
    unittest.main()
