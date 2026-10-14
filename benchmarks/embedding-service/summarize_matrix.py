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

    if not rows:
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



if __name__ == "__main__":
    main()
