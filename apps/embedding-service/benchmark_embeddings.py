import argparse
import json
import math
import os
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]


@dataclass
class BenchmarkResult:
    target_tokens: int
    measured_tokens: int | None
    text_chars: int
    status: str
    dimensions: int | None
    latencies_ms: list[float]
    error: str | None = None

    def summary(self) -> dict[str, Any]:
        latencies = self.latencies_ms
        return {
            "target_tokens": self.target_tokens,
            "measured_tokens": self.measured_tokens,
            "text_chars": self.text_chars,
            "status": self.status,
            "dimensions": self.dimensions,
            "runs": len(latencies),
            "min_ms": round(min(latencies), 2) if latencies else None,
            "median_ms": round(statistics.median(latencies), 2) if latencies else None,
            "max_ms": round(max(latencies), 2) if latencies else None,
            "tokens_per_second": (
                round(
                    (self.measured_tokens or self.target_tokens)
                    / (statistics.median(latencies) / 1000),
                    2,
                )
                if latencies
                else None
            ),
            "error": self.error,
        }


def make_repeated_text(target_tokens: int) -> str:
    # Short ASCII words keep tokenization stable across runtimes and make failures
    # easier to reason about when HTTP text-length limits are lower than token limits.
    return ("memory benchmark retrieval qwen " * max(1, math.ceil(target_tokens / 5))).strip()


def fit_text_to_tokens(llm: Any, target_tokens: int) -> tuple[str, int]:
    text = make_repeated_text(target_tokens)

    def count_tokens(value: str) -> int:
        return len(llm.tokenize(value.encode("utf-8"), add_bos=False))

    while count_tokens(text) < target_tokens:
        text += " memory benchmark retrieval qwen"

    words = text.split()
    low = 1
    high = len(words)
    best_text = text
    best_delta = abs(count_tokens(text) - target_tokens)
    while low <= high:
        mid = (low + high) // 2
        candidate = " ".join(words[:mid])
        tokens = count_tokens(candidate)
        delta = abs(tokens - target_tokens)
        if delta < best_delta:
            best_text = candidate
            best_delta = delta
        if tokens < target_tokens:
            low = mid + 1
        elif tokens > target_tokens:
            high = mid - 1
        else:
            best_text = candidate
            break

    return best_text, count_tokens(best_text)


def normalize_vector(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        raise ValueError("model returned a zero vector")
    return [value / norm for value in vector]


def post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def run_http(args: argparse.Namespace) -> list[BenchmarkResult]:
    results: list[BenchmarkResult] = []
    for size in args.sizes:
        text = make_repeated_text(size)
        latencies: list[float] = []
        dimensions: int | None = None
        error: str | None = None
        status = "ok"
        for _ in range(args.runs):
            try:
                started = time.perf_counter()
                response = post_json(args.url, {"texts": [text]}, args.timeout)
                elapsed_ms = (time.perf_counter() - started) * 1000
                dimensions = int(response["dimensions"])
                vector = response["vectors"][0]
                if len(vector) != dimensions:
                    raise ValueError(f"vector length {len(vector)} != dimensions {dimensions}")
                latencies.append(elapsed_ms)
            except urllib.error.HTTPError as exc:
                status = "error"
                error = f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}"
                break
            except Exception as exc:
                status = "error"
                error = str(exc)
                break
        results.append(
            BenchmarkResult(
                target_tokens=size,
                measured_tokens=None,
                text_chars=len(text),
                status=status,
                dimensions=dimensions,
                latencies_ms=latencies,
                error=error,
            )
        )
    return results


def run_direct(args: argparse.Namespace) -> list[BenchmarkResult]:
    from huggingface_hub import hf_hub_download
    from llama_cpp import LLAMA_POOLING_TYPE_LAST, Llama

    model_path = args.model_path or hf_hub_download(
        repo_id=args.model_repo,
        filename=args.model_file,
    )
    llm = Llama(
        model_path=model_path,
        embedding=True,
        pooling_type=LLAMA_POOLING_TYPE_LAST,
        n_ctx=args.n_ctx,
        n_batch=args.n_batch,
        n_threads=args.n_threads,
        verbose=False,
    )

    for _ in range(args.warmup_runs):
        result = llm.create_embedding("warmup", model=args.model_name)
        normalize_vector(list(result["data"][0]["embedding"]))

    results: list[BenchmarkResult] = []
    for size in args.sizes:
        text, measured_tokens = fit_text_to_tokens(llm, size)
        latencies: list[float] = []
        dimensions: int | None = None
        error: str | None = None
        status = "ok"
        for _ in range(args.runs):
            try:
                if hasattr(llm, "reset"):
                    llm.reset()
                started = time.perf_counter()
                result = llm.create_embedding(text, model=args.model_name)
                elapsed_ms = (time.perf_counter() - started) * 1000
                vector = normalize_vector(list(result["data"][0]["embedding"]))
                dimensions = len(vector)
                latencies.append(elapsed_ms)
            except Exception as exc:
                status = "error"
                error = str(exc)
                break
        results.append(
            BenchmarkResult(
                target_tokens=size,
                measured_tokens=measured_tokens,
                text_chars=len(text),
                status=status,
                dimensions=dimensions,
                latencies_ms=latencies,
                error=error,
            )
        )
    return results


def print_markdown(results: list[BenchmarkResult]) -> None:
    print(
        "| Target tokens | Measured tokens | Chars | Status | "
        "Median ms | Tokens/sec | Dimensions | Error |"
    )
    print("|---:|---:|---:|---|---:|---:|---:|---|")
    for result in results:
        summary = result.summary()
        print(
            (
                "| {target_tokens} | {measured_tokens} | {text_chars} | {status} | "
                "{median_ms} | {tokens_per_second} | {dimensions} | {error} |"
            ).format(
                **{key: "" if value is None else value for key, value in summary.items()}
            )
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark Qwen GGUF embedding latency.")
    parser.add_argument("--mode", choices=["http", "direct"], default="http")
    parser.add_argument("--url", default="http://127.0.0.1:8000/embed")
    parser.add_argument("--sizes", type=int, nargs="+", default=DEFAULT_SIZES)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument(
        "--model-repo",
        default=os.getenv("MODEL_REPO", "Qwen/Qwen3-Embedding-0.6B-GGUF"),
    )
    parser.add_argument(
        "--model-file",
        default=os.getenv("MODEL_FILE", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
    )
    parser.add_argument("--model-path", default=os.getenv("MODEL_PATH"))
    parser.add_argument(
        "--model-name",
        default=os.getenv("MODEL_NAME", "Qwen/Qwen3-Embedding-0.6B-GGUF"),
    )
    parser.add_argument("--n-ctx", type=int, default=int(os.getenv("BENCHMARK_N_CTX", "32768")))
    parser.add_argument("--n-batch", type=int, default=int(os.getenv("LLAMA_N_BATCH", "512")))
    parser.add_argument(
        "--n-threads",
        type=int,
        default=int(os.getenv("LLAMA_N_THREADS", str(os.cpu_count() or 1))),
    )
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    results = run_http(args) if args.mode == "http" else run_direct(args)
    if args.format == "json":
        print(json.dumps([result.summary() for result in results], indent=2))
    else:
        print_markdown(results)


if __name__ == "__main__":
    main()
