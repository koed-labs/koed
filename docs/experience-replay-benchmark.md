# Experience Replay Benchmark

The Experience Replay benchmark measures whether relevant prior AI Client
experience improves later Terminal-Bench 3.0 task performance. It is not a
standard Terminal-Bench leaderboard run: the relevant condition deliberately
receives a sanitized, pre-verifier trajectory from an earlier attempt on the
same task.

## Start Here

The benchmark coordinator currently requires a Linux host. Native Linux, WSL,
and Linux containers are supported. Native macOS and Windows hosts are not yet
supported. Running only the Terminal-Bench task containers through Docker
Desktop does not make a macOS coordinator compatible because the run lease,
telemetry, and local Codex bridge still execute on the host. macOS support can
be added later when those host-side boundaries have cross-platform
implementations and equivalent safety tests. Artifact-only report, sanitize,
and campaign-merge commands remain portable.

Choose the smallest workflow that answers the question you are testing:

| Goal                                           | Workflow                              | Model work                                         | Corpus                            |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------- | --------------------------------- |
| Verify orchestration without model calls       | Deterministic smoke                   | None                                               | Generated fixture                 |
| Verify real Codex, Harbor and Koed integration | Product-path proof                    | Luna low, six top-level attempts                   | Generated during the run          |
| Verify one successful experience can be reused | One-task oracle campaign              | Luna high qualification, then one Luna high replay | Private and reusable              |
| Measure stochastic behavior on one task        | Repeated study                        | Runtime-selected 1-100 matched repeats             | Reuses an existing private corpus |
| Measure a fixed subset                         | Oracle campaign shard                 | One Luna high replay per selected task             | One qualified entry per task      |
| Run the complete benchmark protocol            | `quick`, `standard` or `full` profile | Profile-defined four-condition runs                | Generated source trajectories     |

For a first checkout, run the deterministic smoke. For the smallest meaningful
model-backed test, qualify one task and run a one-task oracle campaign. Do not
start with all 74 tasks.

## Private Data And Cache

Keep the configuration, qualification manifest, campaign definition, oracle
material, corpus collection, prepared database cache and run output outside the
repository. They may contain credentials, local paths, source trajectories or
other private data. The benchmark rejects in-repository corpus and campaign
paths and requires private manifests to use mode `0600`; corpus directories use
mode `0700`.

The repository contains only the harness, pinned public task metadata and
deterministic test fixtures. A new operator generates their own corpus once.
Subsequent runs reuse the content-addressed corpus and prepared database cache
when their attested inputs are unchanged.

## First-Time Setup

From a clean checkout of the exact commit being evaluated:

```bash
pnpm install
pnpm --filter @koed/evals eval:experience-replay:harbor:test
pnpm --filter @koed/evals build
```

Recorded runs additionally require:

- Docker with enough free disk for the selected task images and run artifacts.
- `uv`, used with the locked Harbor `0.21.0` environment in
  `packages/evals/src/experience-replay/harbor`.
- PostgreSQL 17 with pgvector. The harness creates and removes isolated
  databases; never point it at a database containing valuable data.
- A private OCI registry reachable by the local Docker daemon.
- A healthy Koed Embedding Service whose Qwen model identity and artifact hash
  match the resolved configuration.
- The exact `codex` and `codex-code-mode-host` binaries recorded in the
  configuration.
- Either an OpenAI API key or a local Codex subscription login. Subscription
  mode is the cheapest normal local path and does not issue paid API requests.

The deterministic smoke needs only PostgreSQL/pgvector; it does not need
Docker task execution, Codex authentication, the registry or the live
Embedding Service.

Set the common database environment once:

```bash
export KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL=postgresql://127.0.0.1:5432/postgres
export KOED_EXPERIENCE_REPLAY_POSTGRES_USER=koed
export KOED_EXPERIENCE_REPLAY_POSTGRES_PASSWORD='<local test password>'
```

For a subscription-backed recorded run, configure the exact local toolchain
and private authentication source:

```bash
export MEMORY_CODEX_APP_SERVER_BINARY="$(command -v codex)"
export KOED_EXPERIENCE_REPLAY_HARBOR_UV_BINARY="$(command -v uv)"
export KOED_EXPERIENCE_REPLAY_DOCKER_BINARY="$(command -v docker)"
export KOED_EXPERIENCE_REPLAY_OCI_REGISTRY='127.0.0.1:5000/koed-benchmarks'
export KOED_EXPERIENCE_REPLAY_HOST_CODEX_BINARY="$(readlink -f "$(command -v codex)")"
export KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_BINARY="$KOED_EXPERIENCE_REPLAY_HOST_CODEX_BINARY"
export KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
export KOED_EXPERIENCE_REPLAY_EMBEDDING_URL='http://127.0.0.1:3801'
export KOED_EXPERIENCE_REPLAY_EMBEDDING_TOKEN='<local benchmark token>'
```

Locate `codex-code-mode-host` from the same standalone Codex release as the
configured `codex` binary. Hash both binaries and the embedding GGUF with
`sha256sum`; record those exact values in the resolved configuration. Do not
copy hashes from another machine or an older run.

## Resolved Configuration

Every command receives one private resolved configuration. Use
`packages/evals/src/experience-replay/fixtures/smoke.config.json` as the field
shape and `packages/evals/src/experience-replay/core/config.ts` as the
authoritative schema.

For the smallest real one-task campaign, the configuration must use:

- profile `full` with explicit concurrency;
- GPT-5.6 Luna high for the coding agent, Memory Answer, LCM summary and
  session-title workers;
- GPT-5.6 Luna medium for the trajectory judge;
- the production prompt and output-schema versions currently declared by the
  respective Koed workers;
- the exact Codex version and binary hashes from this machine;
- the healthy Embedding Service's model, tokenizer, transform, dimensions and
  artifact hash;
- an immutable price-table version and digest, even in subscription mode, so
  API-equivalent cost remains comparable;
- explicit timeouts, token/call limits, disk estimates, concurrency and cost
  admission limits; and
- an absolute output directory outside the repository.

Run `preflight` after any configuration change. It is the authoritative check
for model policy, binary identity, task pins, image provenance, disk capacity,
credentials, provider limits and service health. Do not weaken the
configuration merely to bypass a preflight failure.

## Smallest Real Luna Run

The following path proves corpus generation, normal Koed ingestion,
Projection, LCM, Qwen embedding, `memory_answer` and replay with one task.

1. Select a task and read its pinned digest:

```bash
task_name='terminal-bench/<task-name>'
task_digest="$(jq -r --arg name "$task_name" \
  '.tasks[] | select(.name == $name) | .task_digest' \
  packages/evals/src/experience-replay/fixtures/tb3-v3.0.0.json)"
test -n "$task_digest" && test "$task_digest" != null
```

2. Create private working paths outside the checkout:

```bash
private_root="$(mktemp -d "$HOME/koed-experience-replay-XXXXXX")"
chmod 700 "$private_root"
corpus_dir="$private_root/corpus"
mkdir -m 700 "$corpus_dir"
qualification_manifest="$private_root/qualification.json"
campaign_manifest="$private_root/campaign.json"
config="$private_root/luna-high.json"
```

3. Write the resolved full-profile configuration described above to `$config`.
   Give it a new absolute `output_dir` for each qualification or campaign run.

4. Create a qualification manifest containing concise implementation guidance.
   The guidance may use a pinned public reference implementation, but must not
   contain hidden tests, verifier output or private verifier/cache paths:

```bash
jq -n --arg digest "$task_digest" --arg brief '<implementation guidance>' '{
  schema_version: "koed-oracle-qualification-manifest-v1",
  tasks: [{
    task_digest: $digest,
    oracle_brief: $brief,
    maximum_attempts: 3
  }]
}' > "$qualification_manifest"
chmod 600 "$qualification_manifest"
```

5. Qualify and cache one successful source experience:

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config "$config" --codex-subscription \
  --oracle-qualify \
  --oracle-qualification-manifest "$qualification_manifest" \
  --oracle-corpus "$corpus_dir"
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config "$config" --codex-subscription \
  --oracle-qualify \
  --oracle-qualification-manifest "$qualification_manifest" \
  --oracle-corpus "$corpus_dir"
```

6. Create a one-task campaign definition:

```bash
jq -n --arg digest "$task_digest" '{
  schema_version: "koed-oracle-campaign-definition-v1",
  campaign_id: "one-task-luna-high",
  task_universe_digests: [$digest],
  shard_id: "one-task",
  shard_task_digests: [$digest],
  reference_score: 0
}' > "$campaign_manifest"
chmod 600 "$campaign_manifest"
```

7. Change only the configuration's `output_dir`, then preflight and run the
   replay. Do not change the frozen model, prompt, corpus or task policy between
   preflight and run:

```bash
pnpm --filter @koed/evals eval:experience-replay -- \
  preflight --config "$config" --codex-subscription \
  --oracle-campaign \
  --oracle-campaign-manifest "$campaign_manifest" \
  --oracle-corpus "$corpus_dir"
pnpm --filter @koed/evals eval:experience-replay -- \
  run --config "$config" --codex-subscription \
  --oracle-campaign \
  --oracle-campaign-manifest "$campaign_manifest" \
  --oracle-corpus "$corpus_dir"
```

The first campaign run prepares and caches the complete one-task database. A
later run with the same materialization identity reuses that cache. Changing
only coding-agent or Memory Answer settings does not force LCM or embedding
preparation to run again, but creates a different recorded protocol where
required.

## Scale Up

To move from one task to a subset:

1. Add each selected task and its digest to the private qualification manifest.
2. Qualify until every selected task has one passing corpus entry.
3. Put the same complete digest list in `task_universe_digests`.
4. Put the tasks for the current execution block in `shard_task_digests`.
5. Run each shard against the same complete corpus and frozen protocol.
6. Merge non-overlapping shards with `campaign-merge`.

The full campaign uses all 74 tasks from `tb3-v3.0.0.json`. Generate the
complete corpus before measured replay so every shard searches an identically
sized Memory. Qualification may run different tasks concurrently, but attempts
for one task remain serial. Campaign replay may use the explicitly configured
concurrency after the shared prepared database exists.

## Boundaries

- Harbor `0.21.0` is a locked benchmark-only Python dependency. It is not a
  Koed product runtime dependency.
- Koed Memory is populated through canonical Conversation Item ingestion,
  Projection, capture policy and the Embedding Service. Direct database seeding
  is not a valid benchmark path.
- Recall uses the production MCP Server, `memory_answer`, Local AI Runtime and
  AI Client synthesis contracts.
- The benchmark is a Koed-adapted Terminal-Bench evaluation, not an official
  leaderboard submission. Every source and replay replaces the task corpus's
  exact final prohibition on online solutions or task-specific hints with
  `Do not use online solutions. You may use Koed memory.` This keeps network
  cheating prohibited without misclassifying the User's local Koed Memory as
  an external hint. The runner fails closed when the expected sentence is
  absent or duplicated, leaves the pinned task cache unchanged, and records
  both instruction digests.
- Every source and replay is one isolated Harbor trial with a fresh AI Client
  home. The transcript watcher is disabled.
- The runner consumes the exact digest-qualified task image approved by
  preflight. Mutable image references are rejected and the image is re-inspected
  before each recorded trial.
- Raw trajectories, databases, MCP configuration and logs are sensitive local
  artifacts. The harness never uploads them.

## Four-Condition Profiles

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
with operator-supplied oracle material, requires that source to pass the
unchanged Terminal-Bench verifier, and derives three provenance-separated
Memory artifacts: guidance only, sanitized execution trace only, and both
together. Oracle material is normally a concise implementation brief. When a
known-success experience cannot otherwise be qualified, it may instead be the
exact implementation from a pinned public reference source. It must never
contain hidden tests or verifier output.

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

Use a private oracle file containing either the concise implementation brief or
the explicitly pinned public reference implementation. Do not include hidden
tests or verifier output:

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
arm must use `memory_answer` successfully, but the tested agent chooses its
query, scope, response detail, and whether follow-up recall is useful.

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
agent never receives that guidance directly. Its Terminal-Bench instruction
retains the prohibition on online solutions but removes the phrase prohibiting
task-specific hints, which could reasonably prohibit the User's own Memory.
No task text names Koed, requires a Memory call or prescribes how to call it.
The original and adapted instruction hashes are recorded.

The task workspace receives one canonical, hash-attested `AGENTS.md` with
generic project guidance: use Koed early when prior work could plausibly help,
ask focused follow-up questions when useful detail is missing, and skip Recall
for genuinely self-contained work. The agent may still solve the task however
it chooses. Any answer it requests is synthesized through Koed's normal
ingestion, Projection, Qwen embedding, semantic Recall and `memory_answer`
path. Each corpus is generated once, attested, cached under a private `0700`
collection directory and reused. Raw transcripts, oracle guidance and corpus
artifacts remain outside Git.

Create corpora from a private `0600` qualification manifest. Attempts for one
task are serial; different tasks may qualify concurrently. A failed verifier
result becomes feedback for the next bounded attempt. Unqualified and
infrastructure-failed tasks remain in the immutable private ledger and must not
be silently removed from a declared campaign.

Qualification normally uses GPT-5.6 Luna with high reasoning. A task that
remains unqualified after its bounded Luna attempts may be retried with the
explicitly pinned GPT-5.6 Sol `xhigh` fallback. The corpus attestation records
the qualification model and trajectory; measured campaign agents and AI Client
workers remain frozen to the campaign's Luna policy.

Oracle material must not name private cache or verifier paths from which it was
prepared. Those paths are rejected by the ATIF sanitizer and never become
reusable Memory. An exact implementation must identify its pinned public source
in the private corpus provenance.

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
workers, Memory Answer prompt v9, the production MCP server-instruction and
tool-description versions, the full resolved configuration, dataset and image
pins, corpus policy, one-attempt treatment, seed and concurrency into a
content-addressed protocol. Material changes create a new protocol whose
results cannot be pooled. The campaign uses these production prompt owners
directly and has no benchmark-specific copies. Different tasks may run
concurrently, but work for one task is serialized.

The complete qualified corpus is imported once under one synthetic User, with
one Project per task. LCM and embedding preparation run once over that complete
state. Embedding preparation uses the Worker's production chunk validation and
replacement workflow, including the Embedding Service's advertised batch and
request-size limits. The resulting immutable database is content-addressed in
a private local cache outside the repository. Every measured attempt receives
an exact clone; only the target task's Project is in Recall scope. The
configured campaign concurrency applies after this single frozen template is
ready.

Prepared-database identity covers the complete corpus collection, the tracked
production sources that materialize Conversation Items, Projection, LCM and
embeddings, the latest migration, LCM model/reasoning/prompt/schema/token
budget, and embedding model artifact/tokenizer/transform/dimensions. Coding
agent settings, task guidance, Memory Answer model and Memory Answer prompt do
not alter already-materialized rows and therefore do not invalidate this
cache. Full run provenance still records the exact Koed commit, and resume
still rejects a source-revision change.

Each run also requires a private `0600` campaign definition. The complete task
universe is identical across every shard. Only `shard_task_digests` and
`shard_id` vary. The supplied corpus collection must exactly cover the complete
task universe, so every shard starts from the same experienced-User database.

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

After completing the common PostgreSQL setup above, create a disposable output
directory and run the free orchestration check:

```bash
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

Recorded attempts preserve each pinned Terminal Bench task's authored agent and
verifier timeout. Koed does not replace those ceilings with campaign settings;
its outer Harbor watchdog uses the same task metadata plus bounded setup and
teardown allowances. The configured agent and verifier timeouts are explicit
short ceilings for deterministic smoke runs, while the agent timeout also bounds
the Memory Answer worker.

Use the common toolchain environment from First-Time Setup. API-key
authentication is the default mode; set `OPENAI_API_KEY` and distinct
`KOED_EXPERIENCE_REPLAY_HOST_CODEX_HOME` and
`KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_HOME` directories, then use
`--confirm-paid-run`. For local subscription execution, omit those three
variables, provide `KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH`, and add
`--codex-subscription` to both preflight and run. Never combine the two modes.

The OCI registry must support pushes and digest-qualified pulls from the Docker
host. The Embedding Service model, dimensions and artifact hash must match the
resolved configuration. The locked Harbor Codex
adapter uploads the credential and the exact attested `codex` and
`codex-code-mode-host` binary pair into each ephemeral task container, while
each host-side worker gets a private credential copy in its disposable Codex
home. Credentials are never serialized into benchmark requests or reports and
are removed during trial teardown. Subscription mode is for trusted local
execution of the pinned corpus; API-key mode remains the default.

The benchmark bridge uses Docker's `host.docker.internal` gateway on native
Docker and Docker Desktop. Before Codex starts, the task container waits for
that bridge to become reachable so transient host-gateway startup does not
consume the MCP client's bounded initialization retries.

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
`--codex-subscription`. Subscription mode does not submit paid API requests.
It records API-equivalent cost for comparison but does not enforce that
counterfactual amount as provider spend. Timeouts, concurrency, per-call token
limits, call limits, disk admission and artifact-size bounds still apply.

For API-key runs, the configured paid stop prevents new admissions. In-flight replay work may
consume at most `maximum_top_level_attempt_cost_usd` per concurrent attempt.
Full-corpus template preparation receives that finite allowance once per
selected corpus task because it prepares all selected tasks in one job.
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
- Recorded runs require a clean tracked Koed source tree, persist its exact Git
  commit, and reject resume under a different source revision.
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

Preparation telemetry is resumable without rewriting history. Every
preparation invocation publishes an immutable, sequence-addressed attempt
artifact. A run publishes `preparation-telemetry.json` only after every
required template is ready; that completion summary references the ordered
attempt history, final template count and total preparation cost. An
interrupted attempt therefore remains diagnosable without being mistaken for
the final preparation state after a successful resume.

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
