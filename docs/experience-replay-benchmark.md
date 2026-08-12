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
workflow. `full` requires explicit immutable model choices. Every model-driven
profile requires an exact Codex binary identity, immutable task and image
digests, a versioned price table, sufficient capacity, a paid-cost stop and an
external provider spending limit. No profile silently falls back to smoke.

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

The configured paid stop prevents new admissions. In-flight work may consume
at most the reported concurrency overshoot. The independent provider spending
limit must be between the paid stop and that worst-case bound. Memory
preparation and replay costs are reported separately. Do not run a paid profile
without explicit operator confirmation and a verified provider limit.

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
