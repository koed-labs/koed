# LCM Summary Generation Benchmark

Live benchmark for AI Client model output on Koed LCM Summary generation
prompts, with deterministic pass/fail scoring and optional advisory semantic
judging.

The benchmark builds production LCM prompts from hand-authored pending LCM node
fixtures, runs the configured Codex app-server model, parses the
`lcm-structured-summary-v1` JSON, and scores the result locally. When
`--semantic-judge` is set, it also runs an advisory Codex app-server evaluation
pass over valid structured summaries. It does not call the Koed API, submit
summaries, mutate Memory Nodes, or write database state.

## Run

```bash
pnpm eval:lcm-summary
```

Reports are written to `benchmarks/lcm-summary-generation/artifacts/` by
default.

Useful options:

```bash
pnpm eval:lcm-summary -- --model gpt-5.4-mini --reasoning-effort medium
pnpm eval:lcm-summary -- --case accepted-decision-ai-client-synthesis
pnpm eval:lcm-summary -- --runs 3 --threshold 0.92
pnpm eval:lcm-summary -- --semantic-judge --judge-threshold 0.85
pnpm eval:lcm-summary -- --out benchmarks/lcm-summary-generation/artifacts/local.json
```

The wrapper script is equivalent:

```bash
sh benchmarks/lcm-summary-generation/run.sh --case secret-like-value-redaction
```

## Scoring

The v1 benchmark uses deterministic scoring for its pass/fail gate. Hard gates
cover:

- schema validity for `lcm-structured-summary-v1`
- required claim coverage
- forbidden claim absence, including secret-like literal leakage
- required structured fields

Weighted quality signals lower the score but do not fail a run by themselves:

- expected field placement, unless a fixture marks the field placement critical
- compression limit for `summary_text`
- non-critical noisy-output checks

A report passes only when all runs have valid JSON, zero critical failures,
every run passes its case threshold, and the aggregate weighted score meets the
configured threshold.

Optional semantic judging can be enabled with `--semantic-judge`. It runs a
second Codex app-server evaluation pass over each valid structured summary and
adds advisory quality ratings for faithfulness, durable coverage, field use,
conflict handling, compression, provenance, and safety. Semantic judge results
are written to the report but do not affect `passed` or the process exit code in
this v1 benchmark.

## Fixtures

Fixtures live in `packages/evals/src/lcm-summary-generation/cases.ts` so the
runner and unit tests share the same definitions. The benchmark currently uses
12 synthetic LCM nodes covering decisions, superseded decisions, errors, exact
identifiers, rollups, noisy source items, provenance, model names, and
secret-like value redaction.
