#!/usr/bin/env python3
"""Embedding-service reranking benchmark.

This script compares HTTP reranking endpoints with identical query/document
fixtures. It verifies shape and ordering, then records latency and document
throughput. It intentionally avoids importing Koed runtime code.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import platform
import random
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

QWEN_ONNX_SYSTEM_PROMPT = (
    "Judge whether the Document meets the requirements based on the Query and the Instruct provided. "
    'Note that the answer can only be "yes" or "no".'
)
QWEN_ONNX_DEFAULT_INSTRUCTION = (
    "Given a query and a document, judge whether the document is relevant to the query."
)
QWEN_ONNX_RERANK_TEMPLATE = (
    "<|im_start|>system\n{system}<|im_end|>\n"
    "<|im_start|>user\n<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}<|im_end|>\n"
    "<|im_start|>assistant\n<think>\n\n</think>\n\n"
)


@dataclass(frozen=True)
class Endpoint:
    name: str
    kind: str
    url: str
    model: str
    token: str | None


@dataclass
class RequestResult:
    ok: bool
    latency_ms: float
    scores: list[float] | None
    best_index: int | None
    prompt_tokens: int | None = None
    total_tokens: int | None = None
    error: str | None = None


@dataclass
class ScenarioResult:
    endpoint: str
    endpoint_kind: str
    document_count: int
    concurrency: int
    requests: int
    successes: int
    failures: int
    warmup_ok: bool
    warmup_ms: float
    warmup_prompt_tokens: int | None
    relevant_index: int
    correct_top_count: int
    score_shape_ok: bool
    wall_ms: float
    p50_ms: float | None
    p95_ms: float | None
    min_ms: float | None
    max_ms: float | None
    documents_per_second: float
    query_sha256: str
    documents_sha256: str
    min_prompt_tokens: int | None
    max_prompt_tokens: int | None
    mean_prompt_tokens: float | None
    total_prompt_tokens: int | None
    mean_prompt_tokens_per_document: float | None
    audit_onnx_formatted_prompt_tokens: int | None
    audit_onnx_formatted_tokens_per_document: float | None
    errors: list[str]


def run_command(args: list[str]) -> str | None:
    try:
        return subprocess.check_output(
            args, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return None


def host_specs() -> dict[str, Any]:
    return {
        "capturedAt": datetime.now(UTC).isoformat(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpuCount": run_command(["nproc"]) or None,
        "dockerVersion": run_command(["docker", "--version"]),
        "gitCommit": run_command(["git", "rev-parse", "HEAD"]),
        "gitBranch": run_command(["git", "branch", "--show-current"]),
    }


def make_fixture(document_count: int, salt: str) -> tuple[str, list[str], int]:
    rng = random.Random(f"rerank:{document_count}:{salt}")
    topic = f"harbor docker memory service {rng.randrange(10**9):09d}"
    query = "Which document says Koed runs Docker services for local memory?"
    relevant_index = max(0, min(document_count - 1, document_count // 2))
    distractors = [
        "A sourdough recipe mentions cardamom, rye flour, and a warm proofing drawer.",
        "A travel note describes a quiet coastal train route and ticket prices.",
        "A project note talks about painting UI cards with muted colors and spacing.",
        "A story fragment names a lighthouse keeper and a storm by the old pier.",
        "A finance note compares quarterly revenue and cash runway assumptions.",
        "A testing note discusses browser screenshots and visual regressions.",
        "A meeting note covers hiring plans and office furniture deliveries.",
        "A bug report mentions stale dropdown labels and missing icons.",
    ]
    docs: list[str] = []
    for index in range(document_count):
        if index == relevant_index:
            docs.append(
                "Koed runs Docker services for local memory, including Postgres, "
                f"Redis, API, worker, browser, and embedding service. Marker {topic}."
            )
        else:
            docs.append(
                f"{distractors[index % len(distractors)]} Marker {rng.randrange(10**9):09d}."
            )
    return query, docs, relevant_index


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def documents_digest(documents: list[str]) -> str:
    return sha256_text(json.dumps(documents, ensure_ascii=False, separators=(",", ":")))


def extract_usage(response: dict[str, Any]) -> tuple[int | None, int | None]:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None, None
    prompt_tokens = usage.get("prompt_tokens")
    total_tokens = usage.get("total_tokens")
    return (
        int(prompt_tokens) if isinstance(prompt_tokens, int | float) else None,
        int(total_tokens) if isinstance(total_tokens, int | float) else None,
    )


def format_qwen_onnx_rerank_prompt(query: str, document: str) -> str:
    return QWEN_ONNX_RERANK_TEMPLATE.format(
        system=QWEN_ONNX_SYSTEM_PROMPT,
        instruction=QWEN_ONNX_DEFAULT_INSTRUCTION,
        query=query.replace("<|im_start|>", "").replace("<|im_end|>", ""),
        document=document.replace("<|im_start|>", "").replace("<|im_end|>", ""),
    )


def tokenize_count(tokenizer_url: str, text: str, timeout: float) -> int:
    response = post_json(tokenizer_url, {"content": text}, {}, timeout)
    tokens = response.get("tokens")
    if not isinstance(tokens, list):
        raise ValueError("tokenizer response did not contain tokens")
    return len(tokens)


def audit_qwen_onnx_formatted_prompt_tokens(
    tokenizer_url: str | None,
    query: str,
    documents: list[str],
    timeout: float,
) -> tuple[int | None, float | None]:
    if not tokenizer_url:
        return None, None
    counts = [
        tokenize_count(
            tokenizer_url, format_qwen_onnx_rerank_prompt(query, document), timeout
        )
        for document in documents
    ]
    total = sum(counts)
    return total, round(total / len(documents), 2) if documents else None


def post_json(
    url: str, payload: dict[str, Any], headers: dict[str, str], timeout: float
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def extract_scores(response: dict[str, Any], document_count: int) -> list[float]:
    scores = response.get("scores")
    if isinstance(scores, list) and len(scores) == document_count:
        return [float(score) for score in scores]

    ranked = response.get("results") or response.get("data")
    if not isinstance(ranked, list):
        raise ValueError("response did not contain scores, results, or data")
    by_index: dict[int, float] = {}
    for fallback_index, item in enumerate(ranked):
        if not isinstance(item, dict):
            continue
        index = item.get("index", fallback_index)
        score = (
            item.get("relevance_score")
            if "relevance_score" in item
            else item.get("score")
        )
        if isinstance(index, int) and isinstance(score, int | float):
            by_index[index] = float(score)
    if len(by_index) != document_count:
        raise ValueError(
            f"incomplete scores: got {len(by_index)}, expected {document_count}"
        )
    return [by_index[index] for index in range(document_count)]


def call_endpoint(
    endpoint: Endpoint,
    query: str,
    documents: list[str],
    timeout: float,
) -> RequestResult:
    headers: dict[str, str] = {}
    if endpoint.kind == "koed-rerank":
        if endpoint.token:
            headers["x-koed-embedding-token"] = endpoint.token
        payload = {"query": query, "documents": documents}
    elif endpoint.kind == "llama-rerank":
        payload = {
            "model": endpoint.model,
            "query": query,
            "documents": documents,
            "top_n": len(documents),
        }
    else:
        return RequestResult(
            False, 0.0, None, None, f"unsupported endpoint kind {endpoint.kind!r}"
        )

    started = time.perf_counter()
    try:
        response = post_json(endpoint.url, payload, headers, timeout)
        latency_ms = (time.perf_counter() - started) * 1000
        scores = extract_scores(response, len(documents))
        prompt_tokens, total_tokens = extract_usage(response)
        best_index = max(range(len(scores)), key=lambda index: scores[index])
        return RequestResult(
            True, latency_ms, scores, best_index, prompt_tokens, total_tokens
        )
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return RequestResult(
            False,
            (time.perf_counter() - started) * 1000,
            None,
            None,
            f"HTTP {error.code}: {body[:500]}",
        )
    except Exception as error:  # noqa: BLE001 - benchmark should record all failures.
        return RequestResult(
            False, (time.perf_counter() - started) * 1000, None, None, str(error)[:500]
        )


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * ratio + 0.999999) - 1))
    return ordered[index]


def run_scenario(
    endpoint: Endpoint,
    document_count: int,
    concurrency: int,
    requests: int,
    timeout: float,
    fixture_salt: str,
    warmup: RequestResult,
    llama_tokenizer_url: str | None,
) -> ScenarioResult:
    started = time.perf_counter()
    fixtures = [
        make_fixture(
            document_count, f"{fixture_salt}:{document_count}:{concurrency}:{index}"
        )
        for index in range(requests)
    ]
    query, documents, relevant_index = fixtures[0]
    query_hash = sha256_text(query)
    docs_hash = documents_digest(documents)
    onnx_prompt_tokens, onnx_tokens_per_document = (
        audit_qwen_onnx_formatted_prompt_tokens(
            llama_tokenizer_url,
            query,
            documents,
            timeout,
        )
    )
    relevant_index = fixtures[0][2]
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [
            executor.submit(call_endpoint, endpoint, query, documents, timeout)
            for query, documents, _ in fixtures
        ]
        results = [
            future.result() for future in concurrent.futures.as_completed(futures)
        ]
    wall_ms = (time.perf_counter() - started) * 1000
    successes = [result for result in results if result.ok]
    failures = [result for result in results if not result.ok]
    latencies = [result.latency_ms for result in successes]
    prompt_token_counts = [
        result.prompt_tokens for result in successes if result.prompt_tokens is not None
    ]
    correct_top_count = sum(
        1 for result in successes if result.best_index == relevant_index
    )
    shape_ok = all(
        result.scores is not None and len(result.scores) == document_count
        for result in successes
    )
    return ScenarioResult(
        endpoint=endpoint.name,
        endpoint_kind=endpoint.kind,
        document_count=document_count,
        concurrency=concurrency,
        requests=requests,
        successes=len(successes),
        failures=len(failures),
        warmup_ok=warmup.ok,
        warmup_ms=round(warmup.latency_ms, 2),
        warmup_prompt_tokens=warmup.prompt_tokens,
        relevant_index=relevant_index,
        correct_top_count=correct_top_count,
        score_shape_ok=shape_ok,
        wall_ms=round(wall_ms, 2),
        p50_ms=round(statistics.median(latencies), 2) if latencies else None,
        p95_ms=round(percentile(latencies, 0.95), 2) if latencies else None,
        min_ms=round(min(latencies), 2) if latencies else None,
        max_ms=round(max(latencies), 2) if latencies else None,
        documents_per_second=round(
            (document_count * len(successes)) / (wall_ms / 1000), 2
        )
        if wall_ms > 0
        else 0.0,
        query_sha256=query_hash,
        documents_sha256=docs_hash,
        min_prompt_tokens=min(prompt_token_counts) if prompt_token_counts else None,
        max_prompt_tokens=max(prompt_token_counts) if prompt_token_counts else None,
        mean_prompt_tokens=round(statistics.mean(prompt_token_counts), 2)
        if prompt_token_counts
        else None,
        total_prompt_tokens=sum(prompt_token_counts) if prompt_token_counts else None,
        mean_prompt_tokens_per_document=(
            round(statistics.mean(prompt_token_counts) / document_count, 2)
            if prompt_token_counts
            else None
        ),
        audit_onnx_formatted_prompt_tokens=onnx_prompt_tokens,
        audit_onnx_formatted_tokens_per_document=onnx_tokens_per_document,
        errors=sorted({failure.error or "unknown error" for failure in failures})[:5],
    )


def parse_endpoint(value: str) -> Endpoint:
    parts = value.split(",", 4)
    if len(parts) < 4:
        raise argparse.ArgumentTypeError(
            "--endpoint must be name,kind,url,model[,token]"
        )
    return Endpoint(
        name=parts[0],
        kind=parts[1],
        url=parts[2],
        model=parts[3],
        token=parts[4] if len(parts) == 5 and parts[4] else None,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--endpoint", action="append", type=parse_endpoint, required=True
    )
    parser.add_argument("--document-counts", type=int, nargs="+", default=[10])
    parser.add_argument("--concurrency", type=int, nargs="+", default=[1, 2])
    parser.add_argument("--requests-per-scenario", type=int, default=4)
    parser.add_argument(
        "--warmup-timeout",
        type=float,
        default=None,
        help="Optional timeout for the explicit untimed warmup request. Defaults to --timeout.",
    )
    parser.add_argument(
        "--fixture-salt",
        default="embedding-service-rerank-strict-v1",
        help="Stable fixture seed shared across endpoints. Do not include endpoint names in this value.",
    )
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument(
        "--llama-tokenizer-url",
        default=None,
        help="Optional llama-server /tokenize URL for auditing Qwen ONNX formatted rerank prompt token counts.",
    )
    parser.add_argument("--output-dir", default="benchmarks/embedding-service/artifacts")
    args = parser.parse_args()

    results: list[ScenarioResult] = []
    warmup_timeout = (
        args.warmup_timeout if args.warmup_timeout is not None else args.timeout
    )
    for endpoint in args.endpoint:
        for document_count in args.document_counts:
            query, documents, _ = make_fixture(
                document_count, f"{args.fixture_salt}:{document_count}:warmup"
            )
            warmup = call_endpoint(endpoint, query, documents, warmup_timeout)
            if not warmup.ok:
                print(
                    f"{endpoint.name} docs={document_count} warmup failed: {warmup.error}",
                    flush=True,
                )
                continue
            print(
                f"{endpoint.name} docs={document_count} warmup_ms={round(warmup.latency_ms, 2)} "
                f"prompt_tokens={warmup.prompt_tokens}",
                flush=True,
            )
            for concurrency in args.concurrency:
                request_count = max(args.requests_per_scenario, concurrency)
                summary = run_scenario(
                    endpoint,
                    document_count,
                    concurrency,
                    request_count,
                    args.timeout,
                    args.fixture_salt,
                    warmup,
                    args.llama_tokenizer_url,
                )
                results.append(summary)
                print(
                    f"{summary.endpoint} docs={document_count} concurrency={concurrency} "
                    f"ok={summary.successes}/{summary.requests} "
                    f"top1={summary.correct_top_count}/{summary.successes} "
                    f"docs/sec={summary.documents_per_second} "
                    f"p50={summary.p50_ms} p95={summary.p95_ms} "
                    f"prompt_tokens={summary.mean_prompt_tokens}",
                    flush=True,
                )

    payload = {
        "host": host_specs(),
        "config": {
            "documentCounts": args.document_counts,
            "concurrency": args.concurrency,
            "requestsPerScenario": args.requests_per_scenario,
            "fixtureSalt": args.fixture_salt,
            "timeout": args.timeout,
            "endpoints": [asdict(endpoint) for endpoint in args.endpoint],
        },
        "results": [asdict(result) for result in results],
    }
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"rerank-runtime-{int(time.time())}.json"
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
