#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any


EMBEDDING_NAME_RE = re.compile(
    r"^(?P<runtime>adapter)-t(?P<threads>\d+)(?:-p(?P<parallel>\d+))?$"
)
RERANK_NAME_RE = re.compile(
    r"^(?P<runtime>.+?)-t(?P<threads>\d+)(?:-(?:p|parallel)(?P<parallel>\d+))?(?:-.+)?$"
)
RERANK_DIAGNOSTIC_NAME_RE = re.compile(
    r"^(?P<runtime>.+?)(?:-(?:p|parallel)(?P<parallel>\d+))?(?:-.+)?$"
)


def rows_from_file(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for result in payload.get("results", []):
        match = EMBEDDING_NAME_RE.match(result["endpoint"])
        if not match:
            continue
        rows.append(
            {
                "runtime": match.group("runtime"),
                "threads": int(match.group("threads")),
                "server_parallel": int(match.group("parallel") or "1"),
                "client_concurrency": result["concurrency"],
                "target_tokens": result["target_tokens"],
                "requests": result["requests"],
                "successes": result["successes"],
                "failures": result["failures"],
                "tokens_per_second": result["estimated_tokens_per_second"],
                "measured_tokens": result.get("measured_tokens"),
                "measured_tokens_per_second": result.get("measured_tokens_per_second"),
                "measured_tokens_source": result.get("measured_tokens_source"),
                "p50_ms": result["p50_ms"],
                "p95_ms": result["p95_ms"],
                "wall_ms": result["wall_ms"],
                "dimensions": result["dimensions"],
                "mean_vector_norm": result["mean_vector_norm"],
            }
        )
    return rows

def rerank_rows_from_file(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for result in payload.get("results", []):
        endpoint = result["endpoint"]
        match = RERANK_NAME_RE.match(endpoint)
        if not match:
            match = RERANK_DIAGNOSTIC_NAME_RE.match(endpoint)
        if not match:
            continue
        threads_group = match.groupdict().get("threads")
        parallel_group = match.groupdict().get("parallel")
        if not parallel_group:
            parallel_match = re.search(r"(?:^|-)p(?P<parallel>\d+)(?:-|$)", endpoint)
            parallel_group = (
                parallel_match.group("parallel") if parallel_match else None
            )
        rows.append(
            {
                "runtime": match.group("runtime"),
                "threads": int(threads_group) if threads_group else None,
                "server_parallel": int(parallel_group or "1"),
                "client_concurrency": result["concurrency"],
                "document_count": result["document_count"],
                "requests": result["requests"],
                "successes": result["successes"],
                "failures": result["failures"],
                "warmup_ms": result.get("warmup_ms"),
                "correct_top_count": result["correct_top_count"],
                "score_shape_ok": result["score_shape_ok"],
                "documents_per_second": result["documents_per_second"],
                "mean_prompt_tokens": result.get("mean_prompt_tokens"),
                "mean_prompt_tokens_per_document": result.get(
                    "mean_prompt_tokens_per_document"
                ),
                "audit_onnx_formatted_prompt_tokens": result.get(
                    "audit_onnx_formatted_prompt_tokens"
                ),
                "audit_onnx_formatted_tokens_per_document": result.get(
                    "audit_onnx_formatted_tokens_per_document"
                ),
                "p50_ms": result["p50_ms"],
                "p95_ms": result["p95_ms"],
                "wall_ms": result["wall_ms"],
            }
        )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_dir")
    parser.add_argument("--csv", default=None)
    args = parser.parse_args()

    artifact_dir = Path(args.artifact_dir)
    rows: list[dict[str, Any]] = []
    for path in sorted(artifact_dir.glob("embedding-runtime-*.json")):
        rows.extend(rows_from_file(path))

    rows.sort(
        key=lambda row: (
            row["runtime"],
            row["target_tokens"],
            row["threads"],
            row["client_concurrency"],
        )
    )

    rerank_rows: list[dict[str, Any]] = []
    for path in sorted(artifact_dir.glob("rerank-runtime-*.json")):
        rerank_rows.extend(rerank_rows_from_file(path))
    rerank_rows.sort(
        key=lambda row: (
            row["runtime"],
            row["document_count"],
            row["threads"],
            row["client_concurrency"],
        )
    )

    if not rows and not rerank_rows:
        raise SystemExit(f"No benchmark rows found in {artifact_dir}")

    if rows and args.csv:
        headers = list(rows[0].keys())
        with Path(args.csv).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)

    if rows:
        print(
            "| runtime | tokens | threads | concurrency | parallel | tokens/sec | measured tokens/sec | token source | p50 ms | p95 ms | ok |"
        )
        print("|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|")
        for row in rows:
            print(
                "| {runtime} | {target_tokens} | {threads} | {client_concurrency} | {server_parallel} | "
                "{tokens_per_second} | {measured_tokens_per_second} | {measured_tokens_source} | "
                "{p50_ms} | {p95_ms} | {successes}/{requests} |".format(**row)
            )

    if rerank_rows:
        print()
        print(
            "| runtime | threads | concurrency | parallel | docs | docs/sec | prompt toks | toks/doc | onnx audit toks | onnx audit/doc | warmup ms | p50 ms | p95 ms | top1 | shape | ok |"
        )
        print(
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|"
        )
        for row in rerank_rows:
            print(
                "| {runtime} | {threads} | {client_concurrency} | {server_parallel} | "
                "{document_count} | {documents_per_second} | {mean_prompt_tokens} | "
                "{mean_prompt_tokens_per_document} | {audit_onnx_formatted_prompt_tokens} | "
                "{audit_onnx_formatted_tokens_per_document} | {warmup_ms} | {p50_ms} | {p95_ms} | "
                "{correct_top_count}/{successes} | {score_shape_ok} | {successes}/{requests} |".format(
                    **row
                )
            )


if __name__ == "__main__":
    main()
