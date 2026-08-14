# Experience Replay Benchmark

The Experience Replay benchmark measures whether relevant prior AI Client
experience improves later Terminal-Bench 3.0 task performance. It is not a
standard Terminal-Bench leaderboard run: the relevant condition deliberately
receives a sanitized, pre-verifier trajectory from an earlier attempt on the
same task.

## Boundaries

- Harbor `0.21.0` is a locked benchmark-only Python dependency. It is not a
  Koed product runtime dependency.
- Koed Memory is populated through canonical Conversation Item ingestion,
  Projection, capture policy and the Embedding Service. Direct database seeding
  is not a valid benchmark path.
- Recall uses the production MCP Server, `memory_answer`, Local AI Runtime and
  AI Client synthesis contracts.
- Every source and replay is one isolated Harbor trial with a fresh AI Client
  home. The transcript watcher is disabled.
- The runner consumes the exact digest-qualified task image approved by
  preflight. Mutable image references are rejected and the image is re-inspected
  before each recorded trial.
- Raw trajectories, databases, MCP configuration and logs are sensitive local
  artifacts. The harness never uploads them.

## Profiles

- `smoke`: deterministic two-task orchestration check; no paid credentials or
  external network calls.
- `quick`: fixed 12-task CPU subset; one replay per condition; directional and
  subset-specific only.
- `standard`: fixed 24-task CPU subset; two replays per condition.
- `full`: all 74 pinned tasks; three replays per condition.

`quick` and `standard` require the exact configured GPT-5.6 Luna low-reasoning
workflow and GPT-5.6 Luna medium reasoning for trajectory judging. The
deterministic `smoke` profile uses `deterministic-smoke` for its trajectory
judge. `full` requires explicit immutable model choices. Every configuration
must include the `trajectory_judge` worker and pin both its `prompt_version` and
`output_schema_version` to `experience-replay-trajectory-judge-v1`; full may
choose an explicit immutable judge model and reasoning effort. Every
model-driven profile requires an exact Codex binary identity, immutable task
and image digests, pricing for every configured model including the trajectory
judge, an explicit positive `timeouts.judge_seconds`, sufficient capacity, a
paid-cost stop and an external provider spending limit. No profile silently
falls back to smoke.

## Product-Path Proof

For the cheapest recorded integration check, use the dedicated product-path
proof. It uses the `quick` profile's GPT-5.6 Luna low-reasoning policy, but it
is not a quick-profile estimate. The immutable proof plan runs exactly two
pinned Terminal-Bench 3.0 source tasks, then replays one target once under each
of the cold, empty, placebo and relevant conditions. The second source is used
only as the placebo donor. This is six top-level coding-agent attempts in total:
two sources and four replays.

The proof fails closed unless the relevant replay completes `memory_answer`
successfully through the real product path. Its report identifies the execution
as `product_path_proof`, omits confidence claims and states that it is not a
benchmark estimate. For this proof only, the relevant replay is explicitly
required to make one `memory_answer` call before editing. Recorded benchmark
profiles retain normal intention-to-treat behavior and do not force tool use.

## Oracle-Seeded Product Proof

The oracle-seeded proof is a separate diagnostic for establishing whether a
known useful prior solution can be retrieved and reused. It does not alter the
natural four-condition benchmark. The corpus builder runs one pinned task once
with an operator-supplied solution brief, requires that source to pass the
unchanged Terminal-Bench verifier, and derives three provenance-separated
Memory artifacts: guidance only, sanitized execution trace only, and both
together.

The target is then replayed once under six conditions: cold, empty, an
irrelevant distractor, guidance plus that distractor, trace plus that
distractor, and full experience plus that distractor. Relevant conditions must
retrieve evidence through the production Memory Answer path. The strictly
sanitized, verifier-qualified source and corpus are stored as an immutable
private artifact in an operator-selected directory outside the repository.
Corpus artifacts, raw trajectories, credentials and provider artifacts must
never be committed. The private corpus is canonical transcript input, not a
prebuilt database. Every run constructs a fresh isolated Koed database and
imports it through normal Conversation Item ingestion, Projection, embedding,
and Memory Answer paths. A single proof validates integration and provides only
a stochastic smoke signal; it is not evidence of efficacy.

Use a concise brief that describes a viable approach without verifier output,
hidden tests, or a literal reference patch:

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config <resolved-quick-config.json> --codex-subscription \
  --oracle-seeded-proof --oracle-brief <brief.txt> \
  --oracle-corpus <absolute-private-corpus-directory>
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config <resolved-quick-config.json> --codex-subscription \
  --oracle-seeded-proof --oracle-brief <brief.txt> \
  --oracle-corpus <absolute-private-corpus-directory>
```

After the private corpus exists, the repeated calibration reuses it without
another source attempt. It runs a runtime-selected 1 to 100 matched repeats of
four arms: direct developer guidance without Koed, full successful experience
through Koed Memory, guidance-only Koed Memory, and an empty Koed baseline. The
default and recommended calibration count is 10; smaller counts are functional
or directional checks. The scheduler distributes attempts over a balanced
four-arm Williams design as evenly as the selected count permits. Every Koed
arm must make exactly one explicit project-scoped `memory_answer` call with
`response_detail: "answer_only"`.

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config <resolved-quick-config.json> --codex-subscription \
  --oracle-repeated-study --oracle-corpus <absolute-private-corpus-directory> \
  --oracle-repeats <1..100>
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config <resolved-quick-config.json> --codex-subscription \
  --oracle-repeated-study --oracle-corpus <absolute-private-corpus-directory> \
  --oracle-repeats <1..100>
```

This is a one-task stochastic calibration, not a Terminal-Bench score or an
estimate across tasks. The direct arm establishes whether the configured model
can use the known guidance at all. The full-experience arm separates retrieval
fidelity from the coding agent's ability to act on guidance alone. The quick
policy uses GPT-5.6 Luna low; an explicit full-profile calibration policy uses
GPT-5.6 Luna high for the coding agent and AI Client memory workflows, with
Luna medium retained for blind trajectory judging. Both policies reuse the same
corpus identity; corpus generation must not be repeated merely to change the
replay model.

## Oracle-Seeded Campaign

The campaign mode is a treatment-only challenge that asks how highly GPT-5.6
Luna high can score when Koed exposes one genuine successful prior transcript
for each task. It is separate from the four-condition causal benchmark and is
not eligible for official Terminal-Bench leaderboard submission. The first
campaign runs one `relevant_full` replay per task. Matched no-Memory controls
and additional repeats are separate future protocols and cannot be pooled with
that result.

Every selected task must have one private corpus artifact that passed the
unchanged task verifier. Corpus generation may give a preparation agent
privileged solution guidance and iterative verifier feedback. The evaluated
agent never receives that guidance directly: it receives only the answer
synthesized through Koed's normal ingestion, Projection, Qwen embedding,
semantic Recall and `memory_answer` path. Each corpus is generated once,
attested, cached under a private `0700` collection directory and reused. Raw
transcripts, guidance and corpus artifacts remain outside Git.

Create corpora from a private `0600` qualification manifest. Attempts for one
task are serial; different tasks may qualify concurrently. A failed verifier
result becomes feedback for the next bounded attempt. Unqualified and
infrastructure-failed tasks remain in the immutable private ledger and must not
be silently removed from a declared campaign.

```json
{
  "schema_version": "koed-oracle-qualification-manifest-v1",
  "tasks": [
    {
      "task_digest": "sha256:<digest>",
      "oracle_brief": "Private implementation guidance for the preparation agent.",
      "maximum_attempts": 3
    }
  ]
}
```

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config <resolved-full-config.json> --codex-subscription \
  --oracle-qualify \
  --oracle-qualification-manifest <absolute-private-0600-file> \
  --oracle-corpus <absolute-private-collection-directory>
```

The campaign freezes GPT-5.6 Luna high for the coding agent and AI Client
workers, Memory Answer prompt v9, the full resolved configuration, dataset and
image pins, corpus policy, one-attempt treatment, seed and concurrency into a
content-addressed protocol. Material changes create a new protocol whose
results cannot be pooled. Different tasks may run concurrently, but work for
one task is serialized.

Each run also requires a private `0600` campaign definition. The complete task
universe is identical across every shard. Only `shard_task_digests` and
`shard_id` vary. The supplied corpus collection must exactly cover the shard.

```json
{
  "schema_version": "koed-oracle-campaign-definition-v1",
  "campaign_id": "luna-v9-tb3",
  "task_universe_digests": ["sha256:<all pinned campaign tasks>"],
  "shard_id": "day-1",
  "shard_task_digests": ["sha256:<this run's tasks>"],
  "reference_score": 0.208
}
```

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config <resolved-full-config.json> --codex-subscription \
  --oracle-campaign \
  --oracle-campaign-manifest <absolute-private-0600-file> \
  --oracle-corpus <absolute-private-collection-directory>
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config <resolved-full-config.json> --codex-subscription \
  --oracle-campaign \
  --oracle-campaign-manifest <absolute-private-0600-file> \
  --oracle-corpus <absolute-private-collection-directory>
```

Each completion creates an immutable cumulative progress snapshot containing
pass rate, Wilson 95% interval, delta from the declared 20.8% reference,
qualified/pending corpus counts, elapsed time, tokens and API-equivalent cost.
Run separate task shards on different days with the exact same protocol. Merge
them through an explicit private manifest:

```json
{ "run_directories": ["/absolute/run-a", "/absolute/run-b"] }
```

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  campaign-merge --merge-manifest <manifest.json> \
  --output <absolute-new-merged-directory>
```

Merge rejects changed protocols, duplicate run inputs, overlapping task units,
inconsistent progress ledgers and modified corpus attestations. The pooled
report retains each run/shard identity and date so execution blocks remain
visible.

## Deterministic Smoke

Prerequisites are Node/pnpm and a PostgreSQL 17 server with pgvector. Use a
non-credentialed admin URL plus separate credentials; the harness creates and
deletes isolated databases itself.

```bash
export KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL=postgresql://127.0.0.1:5432/postgres
export KOED_EXPERIENCE_REPLAY_POSTGRES_USER=koed
export KOED_EXPERIENCE_REPLAY_POSTGRES_PASSWORD='<local test password>'

run_root="$(mktemp -d /tmp/koed-experience-replay-XXXXXX)"
jq --arg output "$run_root/run" '.output_dir = $output' \
  packages/evals/src/experience-replay/fixtures/smoke.config.json \
  > "$run_root/config.json"

pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config "$run_root/config.json"
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config "$run_root/config.json"
pnpm --filter @koed/evals eval:experience-replay -- \
  resume --run "$run_root/run"
pnpm --filter @koed/evals eval:experience-replay -- \
  report --run "$run_root/run"
pnpm --filter @koed/evals eval:experience-replay -- \
  sanitize --run "$run_root/run"
```

The smoke run must report `productPathExercised: true`, eight replay attempts
and zero failures. `sanitize` writes only `summary.json` and `summary.md` to a
separate `<run>.publication` directory.

## Recorded Runs

Recorded preflight additionally requires:

```bash
export OPENAI_API_KEY='<paid provider credential>'
export MEMORY_CODEX_APP_SERVER_BINARY='/absolute/path/to/codex-app-server'
export KOED_EXPERIENCE_REPLAY_HARBOR_UV_BINARY='/absolute/path/to/uv'
export KOED_EXPERIENCE_REPLAY_DOCKER_BINARY='/absolute/path/to/docker'
export KOED_EXPERIENCE_REPLAY_OCI_REGISTRY='registry.example/koed-benchmarks'
export KOED_EXPERIENCE_REPLAY_HOST_CODEX_BINARY='/absolute/path/to/host/codex'
export KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_BINARY='/absolute/path/to/container/codex'
export KOED_EXPERIENCE_REPLAY_HOST_CODEX_HOME='/isolated/host-codex-home'
export KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_HOME='/isolated/container-codex-home'
export KOED_EXPERIENCE_REPLAY_EMBEDDING_URL='http://127.0.0.1:<port>'
export KOED_EXPERIENCE_REPLAY_EMBEDDING_TOKEN='<benchmark embedding credential>'
```

API-key authentication is the default recorded-run mode. The two Codex homes
must be distinct authenticated contexts. The OCI registry
must support pushes and digest-qualified pulls from the Docker host. The
Embedding Service model, dimensions and artifact hash must match the resolved
configuration.

For an explicitly local subscription-backed run, omit `OPENAI_API_KEY` and the
two Codex-home variables, then provide the private auth file created by the
host Codex login:

```bash
export KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
```

Add `--codex-subscription` to both preflight and run. The locked Harbor Codex
adapter uploads the credential and the exact attested `codex` and
`codex-code-mode-host` binary pair into each ephemeral task container, while
each host-side worker gets a private credential copy in its disposable Codex
home. Credentials are never serialized into benchmark requests or reports and
are removed during trial teardown. Subscription mode is for trusted local
execution of the pinned corpus; API-key mode remains the default.

The benchmark bridge uses `host.docker.internal` on supported native Docker
hosts. On WSL it advertises the current private WSL `eth0` address because
Docker Desktop's host-gateway alias does not route back into the WSL namespace.
The task runner accepts that private address only when it exactly matches the
attested MCP URL host.

Completed task failures are retained with a null reward and a stable failure
classification. Their frozen source trajectories remain in the cohort;
discarding them would introduce survivorship bias. Runtime, lifecycle,
credential, attestation, and malformed-output failures still stop the run.

Run preflight first. It verifies the clean repository, locked corpus and
toolchain, exact host/container Codex identities, model availability, task
image build provenance, registry digest, separate verifier environment builds
and capacity. A paid run then requires explicit confirmation:

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config <resolved-config.json> --confirm-paid-run
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config <resolved-config.json> --confirm-paid-run
```

Run the two-source product-path proof by adding the same flag to preflight and
run:

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config <resolved-quick-config.json> --confirm-paid-run \
  --product-path-proof
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config <resolved-quick-config.json> --confirm-paid-run \
  --product-path-proof
```

For the subscription-backed proof, replace `--confirm-paid-run` with
`--codex-subscription`. The configured monetary limits remain conservative
API-equivalent accounting bounds; subscription mode does not submit paid API
requests.

The configured paid stop prevents new admissions. In-flight replay work may
consume at most `maximum_top_level_attempt_cost_usd` per concurrent attempt.
Trajectory judgments run sequentially, so the reported
`maximum_concurrent_overshoot_usd` adds one
`maximum_judge_call_cost_usd` to the concurrent replay-attempt bound; judge
cost is deliberately not folded into replay-attempt cost. The independent
provider spending limit must be between the paid stop and that worst-case
bound. Memory preparation, replay and trajectory-judge costs are reported
separately. Do not run a paid profile without explicit operator confirmation
and a verified provider limit.

## Resume And Evidence

The resolved config, manifest and balanced schedule are immutable before paid
work begins. The append-only journal records admission, agent start and an
attested terminal artifact per execution generation.

- Completed attempts are never rerun.
- A pre-agent interruption may use a new generation under the same attempt ID.
- An interruption after agent start is retained as a missing outcome and is not
  silently repeated.
- A source missing after agent start blocks dependent Memory preparation.
- Recorded resume rejects changed runtime, Codex or task-image attestations.
- A process-identity lease prevents concurrent run/resume writers and only
  reclaims a lease after proving its Linux owner stale.

Reports include every attempted replay and distinguish admission, setup, agent,
teardown and missing-outcome failures. Telemetry is collected from Harbor,
Codex, Koed Recall, Memory Answer, LCM, embeddings and runtime observers. A
metric that cannot be observed is explicitly unavailable; it is never replaced
with invented zeroes.

## Blind Trajectory Judge

Terminal-Bench reward is the sole task-performance result. After all replay
attempts finish, a separate judge compares each required pair using only the
public task instruction, the sanitized source experience, sanitized replay
trajectories frozen before verification, and each attempt's public reward/pass
state. Conditions are deterministically hidden behind opaque `A` and `B`
labels. The judge never receives verifier logs, hidden tests, reference
solutions, condition names, database identities or local paths.

The secondary judgment measures progress quality, efficiency, error
recognition, failed-approach avoidance and informed failure. Retrieval quality,
correct prior-experience reuse and distraction resistance are nullable when the
attempt did not visibly retrieve experience. Every non-zero assessment must
cite an exact supplied event reference, and unknown or cross-candidate
references are rejected. Equal Terminal-Bench scores can therefore expose
useful behavior without being reclassified as a task win.

Judge failures remain missing secondary observations and never retry or alter a
replay. Judge latency, token usage and cost are reported as evaluation overhead
and excluded from treatment comparisons. Quick and standard runs use the
configured GPT-5.6 Luna medium-reasoning judge; smoke uses a deterministic tie.

## Resource Comparisons

Every required comparison reports paired task-first deltas for observed agent
wall time, complete sequential trial time, setup/agent/verifier timings,
uncached and cached input, output and
reasoning tokens, provider/API-equivalent/subscription costs, turns, tool and
MCP calls and failures, Memory Answer work, recall searches/expansions/stages,
and evidence count. The top-level token classes include the coding agent and
Memory Answer worker exactly once; the worker breakdown remains separate for
diagnosis. Missing telemetry stays `null`, and parallel durations are never
summed into invented elapsed time.

## Cleanup

Each replay owns its database clone, private Redis Unix socket, API, Local AI
Runtime, MCP credential, AI Client home and child processes. Teardown revokes
credentials first, terminates processes, removes transient resources and emits
cleanup attestations. Incomplete runs retain frozen templates so a safe resume
can re-adopt them; completed runs remove them.

Run the benchmark checks with:

```bash
pnpm --filter @koed/evals test
pnpm --filter @koed/evals eval:experience-replay:harbor:test
```

After a completed smoke run, PostgreSQL must contain no database whose name
starts with `koed_eval_`. Publication sanitization never edits raw artifacts in
place and fails if credential-shaped content remains.
