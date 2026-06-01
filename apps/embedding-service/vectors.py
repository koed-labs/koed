import math
from collections.abc import Iterable
from typing import Any


def normalize_vector(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        raise ValueError("model returned a zero vector")
    return [value / norm for value in vector]


def _float_vector(value: Any) -> list[float]:
    if not isinstance(value, list) or not all(isinstance(item, int | float) for item in value):
        raise ValueError("model returned an invalid embedding vector")
    return [float(item) for item in value]


def extract_embedding_vectors(result: Any) -> list[list[float]]:
    if not isinstance(result, dict):
        raise ValueError("model returned an invalid embedding response")
    data = result.get("data")
    if not isinstance(data, list):
        raise ValueError("model returned an invalid embedding response")

    vectors: list[list[float]] = []
    for item in data:
        if not isinstance(item, dict):
            raise ValueError("model returned an invalid embedding response")
        vectors.append(_float_vector(item.get("embedding")))
    return vectors


def normalize_vectors(vectors: Iterable[list[float]]) -> list[list[float]]:
    return [normalize_vector(vector) for vector in vectors]
