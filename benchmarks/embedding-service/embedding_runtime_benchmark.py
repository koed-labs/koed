#!/usr/bin/env python3
"""Embedding-service runtime benchmark.

This script intentionally avoids importing Koed runtime code. It benchmarks the
Koed Embedding Service adapter over HTTP and reports throughput under different
client concurrency levels.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
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


DEFAULT_SIZES = [256, 1024, 4096]
DEFAULT_CONCURRENCY = [1, 2, 4, 8]
REALISTIC_WORDS = [
    "koed",
    "memory",
    "embedding",
    "thread",
    "project",
    "tool",
    "output",
    "decision",
    "evidence",
    "summary",
    "agent",
    "question",
    "answer",
    "retrieval",
    "semantic",
    "chunk",
    "turn",
    "codex",
    "linear",
    "docker",
    "worker",
    "queue",
    "latency",
    "benchmark",
    "acceptance",
    "criteria",
    "configuration",
    "transcript",
]


@dataclass(frozen=True)
class Endpoint:
    name: str
    kind: str
    url: str
    token: str | None
    model: str


@dataclass
class RequestResult:
    ok: bool
    latency_ms: float
    dimensions: int | None
    vector_norm: float | None
    measured_tokens: int | None = None
    measured_tokens_source: str | None = None
    error: str | None = None


@dataclass
class ScenarioResult:
    endpoint: str
    endpoint_kind: str
    target_tokens: int
    text_chars: int
    concurrency: int
    requests: int
    successes: int
    failures: int
    wall_ms: float
    p50_ms: float | None
    p95_ms: float | None
    min_ms: float | None
    max_ms: float | None
    dimensions: int | None
    mean_vector_norm: float | None
    estimated_tokens_per_second: float
    measured_tokens: int | None
    measured_tokens_per_second: float | None
    measured_tokens_source: str | None
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
        "cpuCount": os.cpu_count(),
        "dockerVersion": run_command(["docker", "--version"]),
        "gitCommit": run_command(["git", "rev-parse", "HEAD"]),
        "gitBranch": run_command(["git", "branch", "--show-current"]),
    }


def make_repeated_text(target_tokens: int, salt: str = "") -> str:
    unit = (
        "Koed embedding benchmark measures local retrieval throughput with "
        "synthetic project memory evidence, tool output, decisions, and "
        "implementation notes. "
    )
    words_per_unit = max(1, len(unit.split()))
    repeat = max(1, math.ceil(target_tokens / words_per_unit))
    text = (unit * repeat).strip()
    return f"{text} Unique benchmark marker: {salt}." if salt else text


def make_realistic_text(target_tokens: int, salt: str = "") -> str:
    # Use varied tokens throughout the whole fixture. Repeated-prefix fixtures can
    # accidentally benchmark llama.cpp KV/prompt reuse instead of unrelated memory
    # chunks, which is not representative of Koed's embedding queue.
    rng = random.Random(f"{target_tokens}:{salt}")
    word_count = max(1, math.ceil(target_tokens / 3))
    parts = []
    for index in range(word_count):
        word = rng.choice(REALISTIC_WORDS)
        if index % 7 == 0:
            parts.append(f"{word}-{rng.randrange(10**9):09d}")
        else:
            parts.append(word)
    return " ".join(parts)


def make_text(target_tokens: int, salt: str = "", mode: str = "realistic") -> str:
    if mode == "repeated":
        return make_repeated_text(target_tokens, salt)
    if mode == "realistic":
        return make_realistic_text(target_tokens, salt)
    raise ValueError(f"unsupported fixture mode {mode!r}")


def post_json(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout: float,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def vector_norm(vector: list[float]) -> float:
    return math.sqrt(sum(value * value for value in vector))


def call_endpoint(endpoint: Endpoint, text: str, timeout: float) -> RequestResult:
    headers: dict[str, str] = {}
    if endpoint.kind == "koed":
        if endpoint.token:
            headers["x-koed-embedding-token"] = endpoint.token
        payload = {"texts": [text]}
    else:
        return RequestResult(
            ok=False,
            latency_ms=0.0,
            dimensions=None,
            vector_norm=None,
            measured_tokens=None,
            error=f"unsupported endpoint kind {endpoint.kind!r}; expected 'koed'",
        )

    started = time.perf_counter()
    try:
        response = post_json(endpoint.url, payload, headers, timeout)
        latency_ms = (time.perf_counter() - started) * 1000
        vector = response["vectors"][0]
        dimensions = int(response["dimensions"])
        measured_tokens = (
            int(response["measuredTokens"])
            if isinstance(response.get("measuredTokens"), int)
            else None
        )
        measured_tokens_source = (
            "koed_adapter_llama_server_usage"
            if measured_tokens is not None
            else None
        )
        return RequestResult(
            ok=True,
            latency_ms=latency_ms,
            dimensions=dimensions,
            vector_norm=vector_norm([float(value) for value in vector]),
            measured_tokens=measured_tokens,
            measured_tokens_source=measured_tokens_source,
        )
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return RequestResult(
            ok=False,
            latency_ms=(time.perf_counter() - started) * 1000,
            dimensions=None,
            vector_norm=None,
            measured_tokens=None,
            error=f"HTTP {error.code}: {body[:500]}",
        )
    except Exception as error:  # noqa: BLE001 - benchmark should record all failures.
        return RequestResult(
            ok=False,
            latency_ms=(time.perf_counter() - started) * 1000,
            dimensions=None,
            vector_norm=None,
            measured_tokens=None,
            error=str(error)[:500],
        )


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * ratio) - 1))
    return ordered[index]


def run_scenario(
    endpoint: Endpoint,
    text: str,
    target_tokens: int,
    concurrency: int,
    requests: int,
    timeout: float,
    fixture_mode: str,
) -> ScenarioResult:
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [
            executor.submit(
                call_endpoint,
                endpoint,
                make_text(
                    target_tokens,
                    f"shared-{target_tokens}-{concurrency}-{index}",
                    fixture_mode,
                ),
                timeout,
            )
            for index in range(requests)
        ]
        results = [
            future.result() for future in concurrent.futures.as_completed(futures)
        ]
    wall_ms = (time.perf_counter() - started) * 1000

    successes = [result for result in results if result.ok]
    failures = [result for result in results if not result.ok]
    latencies = [result.latency_ms for result in successes]
    norms = [
        result.vector_norm for result in successes if result.vector_norm is not None
    ]
    measured_tokens = [
        result.measured_tokens
        for result in successes
        if result.measured_tokens is not None
    ]
    measured_tokens_sources = {
        result.measured_tokens_source
        for result in successes
        if result.measured_tokens_source is not None
    }
    dimensions = next(
        (result.dimensions for result in successes if result.dimensions is not None),
        None,
    )
    total_tokens = target_tokens * len(successes)
    total_measured_tokens = (
        sum(measured_tokens) if len(measured_tokens) == len(successes) else None
    )
    return ScenarioResult(
        endpoint=endpoint.name,
        endpoint_kind=endpoint.kind,
        target_tokens=target_tokens,
        text_chars=len(text),
        concurrency=concurrency,
        requests=requests,
        successes=len(successes),
        failures=len(failures),
        wall_ms=round(wall_ms, 2),
        p50_ms=round(statistics.median(latencies), 2) if latencies else None,
        p95_ms=round(percentile(latencies, 0.95), 2) if latencies else None,
        min_ms=round(min(latencies), 2) if latencies else None,
        max_ms=round(max(latencies), 2) if latencies else None,
        dimensions=dimensions,
        mean_vector_norm=round(statistics.mean(norms), 6) if norms else None,
        estimated_tokens_per_second=round(total_tokens / (wall_ms / 1000), 2)
        if wall_ms > 0
        else 0,
        measured_tokens=total_measured_tokens,
        measured_tokens_per_second=round(total_measured_tokens / (wall_ms / 1000), 2)
        if total_measured_tokens is not None and wall_ms > 0
        else None,
        measured_tokens_source=next(iter(measured_tokens_sources))
        if len(measured_tokens_sources) == 1
        else None,
        errors=sorted({failure.error or "unknown error" for failure in failures})[:5],
    )


def parse_endpoint(value: str) -> Endpoint:
    # name,kind,url,model[,token]
    parts = value.split(",", 4)
    if len(parts) < 4:
        raise argparse.ArgumentTypeError(
            "--endpoint must be name,kind,url,model[,token]"
        )
    token = parts[4] if len(parts) == 5 and parts[4] else None
    if parts[1] != "koed":
        raise argparse.ArgumentTypeError("--endpoint kind must be 'koed'")
    return Endpoint(
        name=parts[0],
        kind=parts[1],
        url=parts[2],
        model=parts[3],
        token=token,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--endpoint",
        action="append",
        type=parse_endpoint,
        required=True,
        help="name,kind,url,model[,token]; kind must be koed",
    )
    parser.add_argument("--sizes", type=int, nargs="+", default=DEFAULT_SIZES)
    parser.add_argument(
        "--concurrency", type=int, nargs="+", default=DEFAULT_CONCURRENCY
    )
    parser.add_argument("--requests-per-scenario", type=int, default=16)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument(
        "--fixture-mode",
        choices=["realistic", "repeated"],
        default="realistic",
        help=(
            "realistic varies tokens throughout the input; repeated is useful only "
            "for reproducing prefix-cache effects"
        ),
    )
    parser.add_argument(
        "--output-dir",
        default="benchmarks/embedding-service/artifacts",
    )
    args = parser.parse_args()

    results: list[ScenarioResult] = []
    for endpoint in args.endpoint:
        for size in args.sizes:
            text = make_text(size, f"shared-{size}-shape", args.fixture_mode)
            # Warm model allocation with an unrelated fixture. Do not warm with the
            # measured fixture, or llama.cpp prefix/KV reuse can dominate results.
            call_endpoint(
                endpoint,
                make_text(size, f"shared-{size}-warmup", args.fixture_mode),
                args.timeout,
            )
            for concurrency in args.concurrency:
                request_count = max(args.requests_per_scenario, concurrency)
                results.append(
                    run_scenario(
                        endpoint=endpoint,
                        text=text,
                        target_tokens=size,
                        concurrency=concurrency,
                        requests=request_count,
                        timeout=args.timeout,
                        fixture_mode=args.fixture_mode,
                    )
                )
                summary = results[-1]
                tps = (
                    summary.measured_tokens_per_second
                    if summary.measured_tokens_per_second is not None
                    else summary.estimated_tokens_per_second
                )
                print(
                    f"{summary.endpoint} size={size} concurrency={concurrency} "
                    f"ok={summary.successes}/{summary.requests} "
                    f"tps={tps} "
                    f"p50={summary.p50_ms} p95={summary.p95_ms}",
                    flush=True,
                )

    payload = {
        "host": host_specs(),
        "config": {
            "sizes": args.sizes,
            "concurrency": args.concurrency,
            "requestsPerScenario": args.requests_per_scenario,
            "timeout": args.timeout,
            "fixtureMode": args.fixture_mode,
            "endpoints": [asdict(endpoint) for endpoint in args.endpoint],
        },
        "results": [asdict(result) for result in results],
    }
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"embedding-runtime-{int(time.time())}.json"
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
