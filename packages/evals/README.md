# Koed evaluations

## Retrieval Arena

The Retrieval Arena compares evidence retrieval and answer quality without changing production retrieval. It keeps three leaderboards separate:

- `retrieval_only`: every arm searches the same flat corpus under the same evidence budget.
- `fixed_reader`: every retrieval arm feeds the same ordered evidence to one local reader. A separate semantic judge is mandatory.
- `product`: complete product-like Koed and configuration-driven ablation runs. These results are not mixed with flat-corpus results.

The first-party dataset is a hand-authored, versioned deterministic artifact containing development, validation, and held-out splits. Its corpus structurally includes Memory Events, LCM leaves and rollups, Curated Memory, lexical anchors, parent/child hierarchy, and positive Team Workspace recall. Product cases explicitly select Personal or Team-shared retrieval plus global, Project, or Session search domains. Reports pin its version, SHA-256 content hash, truthful hand-authored provenance, Koed commit, arm configuration, model labels, complete effective prompt-template hashes, hardware, resource use, and run number. Real customer Memory is not read by the built-in dataset.

The no-credential CPU smoke path runs only the pinned BM25 arm:

```bash
pnpm --filter @koed/evals eval:retrieval-arena -- --arm=bm25 --output=.koed/evals/retrieval-arena.json
```

### Retrieval scale and resource reports

Scale load is deliberately separate from the hand-authored quality corpus. Generated records are background load only, have no relevance judgments, and are never scored as quality evidence. Two versioned profiles are available:

| Profile             | Users | Team Workspaces | Projects | Sessions | Memory Events | LCM nodes | Curated Memory | Embeddings | Minimum measured queries |
| ------------------- | ----: | --------------: | -------: | -------: | ------------: | --------: | -------------: | ---------: | -----------------------: |
| `development-smoke` |     4 |               2 |       20 |      100 |        10,000 |     2,000 |            200 |     12,200 |                        3 |
| `realistic-launch`  |   250 |              50 |    2,000 |   25,000 |     1,000,000 |   200,000 |         25,000 |  1,225,000 |                       15 |

Generate deterministic JSONL without retaining the corpus in runner memory:

```bash
pnpm --filter @koed/evals eval:retrieval-scale -- generate-load \
  --profile=development-smoke \
  --seed=launch-benchmark-2026-08 \
  --output=.koed/evals/retrieval-scale-load.jsonl
```

Create a dedicated, migrated, non-public PostgreSQL schema for the scale run. The loader rejects production, remote PostgreSQL hosts, `public`, a missing schema, and any database/schema identity that does not exactly match the explicit guard arguments. It never creates or migrates the schema. The API and Product Arena must use this same schema (normally through their PostgreSQL `search_path`). Do not point these commands at a shared development, staging, or production schema.

Load and attest the JSONL against the production Koed tables:

```bash
pnpm --filter @koed/evals eval:retrieval-scale -- load \
  --profile=development-smoke \
  --seed=launch-benchmark-2026-08 \
  --input=.koed/evals/retrieval-scale-load.jsonl \
  --database-url="$KOED_EVAL_PRODUCT_DATABASE_URL" \
  --expected-database=koed_eval \
  --expected-schema=retrieval_scale_test \
  --runtime-identity="$KOED_EVAL_PRODUCT_RUNTIME_IDENTITY" \
  --attestation-output=.koed/evals/retrieval-scale-scope.json
```

`load` verifies every JSONL record against the exact deterministic generator stream before changing PostgreSQL. In one transaction it removes only the same load identity, then creates production User, Team, Workspace, access, Captured Session, Memory Event, LCM node/source/tree, Curated Memory/source, embedding metadata, and `memory_embeddings_1024` rows. Generated IDs and `generatorVersion`, `profileId`, `seed`, project/session/User ownership, source links, and context-only Team Workspace ordinals are retained in production fields or metadata. The generated records remain Personal Memory; a Team Workspace ordinal is background context and is not misrepresented as a Share Grant.

Each generated Memory Event, LCM node, and Curated Memory receives one queryable deterministic one-hot 1024-dimensional vector. PostgreSQL constructs the vectors from hash-selected positions, avoiding multi-gigabyte vector-literal transfer for the launch profile. The production compatibility fields use `qwen3-0.6b` so the normal retrieval SQL can include the background rows, but the artifact hash, pooling, and input transform explicitly label the vector as `koed-scale-synthetic-deterministic-v1`, `synthetic_hash_expansion`, and `synthetic_deterministic_hash_vector_not_qwen`. These vectors make production pgvector indexing and resource measurement possible; they do not model semantic quality and are not Qwen outputs. Installed-Qwen retrieval quality remains separately measured by the hand-authored Retrieval Arena cases and model-backed arms.

Prepare and embed the hand-authored Product cases before loading the synthetic background rows, then stop the Worker for the measured scale run. The synthetic compatibility metadata is intentionally distinguishable from a real Qwen embedding, so a live Worker will correctly classify it as stale and enqueue replacement work. Re-embedding generated background load would invalidate the deterministic scale profile and measure a backfill workload instead of retrieval. The API, PostgreSQL, and Embedding Service remain live during the run; only background mutation is paused.

The emitted `koed-retrieval-scale-scope-v1` is built from fresh database queries. It rejects count drift, a missing vector row, or inconsistent User/session/project/source/embedding ownership. Re-attest an unchanged load without reloading it:

```bash
pnpm --filter @koed/evals eval:retrieval-scale -- attest \
  --profile=development-smoke \
  --seed=launch-benchmark-2026-08 \
  --database-url="$KOED_EVAL_PRODUCT_DATABASE_URL" \
  --expected-database=koed_eval \
  --expected-schema=retrieval_scale_test \
  --runtime-identity="$KOED_EVAL_PRODUCT_RUNTIME_IDENTITY" \
  --output=.koed/evals/retrieval-scale-scope-before-run.json
```

The runtime identity must be the exact `runtimeIdentity` used by the live Product Arena state manifest. Neither command prints the database URL. Output files are create-only, while database loading is idempotent for the same profile and seed.

Run the normal strict Product Arena against that loaded database. Use hand-authored Arena cases as the probes, at least the profile's minimum query count, and include the process inventory described below. Then create the scale-only aggregate:

```bash
pnpm --filter @koed/evals eval:retrieval-scale -- report \
  --profile=development-smoke \
  --arena-report=.koed/evals/retrieval-arena-live.json \
  --scope-attestation=.koed/evals/retrieval-scale-scope.json \
  --output=.koed/evals/retrieval-scale-report.json
```

The strict scale report rejects missing or failed Product queries, runtime identity mismatches, scope/count mismatches, incomplete per-query DB read, hydration/decryption count and byte, embedding, cost, latency, or participating-process RAM measurements. It reports count, sum, mean, p50, p95, and max for each resource metric and pins the generated-load, source-tree, Arena dataset, and Arena run identities. `runRetrievalScaleBenchmark` is the preferred orchestration API: supply the existing live `runRetrievalArena` call and a database-backed `observeScope` callback; it observes the scope before and after measurement and rejects workload drift. The `realistic-launch` profile is a manual launch-hardware benchmark and is not required in CI.

Cleanup is transaction-scoped and deletes only rows marked by the exact profile/seed load identity:

```bash
pnpm --filter @koed/evals eval:retrieval-scale -- cleanup \
  --profile=development-smoke \
  --seed=launch-benchmark-2026-08 \
  --database-url="$KOED_EVAL_PRODUCT_DATABASE_URL" \
  --expected-database=koed_eval \
  --expected-schema=retrieval_scale_test
```

Point model-backed arms at the existing local Embedding Service:

```bash
KOED_EVAL_EMBEDDING_SERVICE_URL=http://127.0.0.1:3800 \
  EMBEDDING_SERVICE_TOKEN=local-token \
  pnpm --filter @koed/evals eval:retrieval-arena -- --layer=retrieval_only
```

Use `--strict-providers` to turn an unavailable requested provider into a failed run. Repeat `--split=...`, `--case=...`, `--arm=...`, or `--layer=...` to select subsets. `--runs=N` repeats every selected case. Dispersion and Student-t 95% confidence intervals use per-run means over the same completed cases, so case difficulty is never treated as run variance; each leaderboard exposes the paired case count, repeated-run sample count, and sample unit. Product/agentic arms require at least `--runs=3`. `productComparisons` pairs each ablation with `koed-production` by exact case/run and reports production-minus-ablation estimates and 95% confidence intervals for semantic quality, binary correctness, aggregate cost, and end-to-end latency. Bad answers remain failed runs but contribute zero quality and zero correctness instead of disappearing from the denominator.

Fixed-reader, judge, and rewrite workers run through the existing Codex app-server runtime. Configure them with `--reader-model`, `--judge-model`, `--rewrite-model`, their matching `--*-reasoning-effort` flags, `--codex`, and `--model-timeout-ms`. Product runs use a real Koed Memory Answer endpoint plus the production local Memory Answer worker:

```bash
KOED_EVAL_PRODUCT_API_URL=http://127.0.0.1:3300 \
KOED_EVAL_PRODUCT_AUTHORIZATION='Bearer local-isolated-token' \
KOED_EVAL_PRODUCT_DATABASE_URL='postgresql://localhost/koed_arena_isolated' \
KOED_EVAL_PRODUCT_STATE_MANIFEST=/absolute/path/to/product-state.json \
pnpm --filter @koed/evals eval:retrieval-arena -- \
  --layer=product --arm=koed-production --runs=3 --strict-providers
```

Use a disposable local runtime and isolated database. The eval-only seeder accepts explicit case IDs, sends each supported item through the authenticated Conversation Item capture and live Projection APIs, reads the resulting production rows back from that database, and writes a state manifest:

```bash
pnpm --filter @koed/evals build
node packages/evals/dist/retrieval-arena/live-product-fixture-cli.js \
  --api-url=http://127.0.0.1:3300 \
  --authorization='Bearer local-isolated-token' \
  --database-url=postgresql://localhost/koed_arena_isolated \
  --case=dev-exact-anchor \
  --case=dev-semantic-paraphrase \
  --output=/absolute/path/to/product-state.json
```

The command rejects production, non-loopback API/database targets, an existing output file, a non-empty Projection backlog, and every case it cannot truthfully instantiate. In particular, the current seeder fails closed for hand-authored LCM leaf/rollup, Curated Memory, Team Workspace, cross-User/private, and revoked-state cases; it never substitutes Personal Memory Events for those representations. The deterministic Team SaaS fixture separately exercises production Team Memory Event, LCM leaf, LCM rollup, Curated Memory, expansion, and authorization paths. Its data is not misrepresented as the Arena's hand-authored corpus, so those Arena cases remain unavailable to product scoring until an eval-only orchestrator can materialize their exact source graph and authority state.

`KOED_EVAL_PRODUCT_STATE_MANIFEST` is a `koed-retrieval-arena-product-state-v1` artifact with exact source-type bindings and a Product-context hash. `KOED_EVAL_PRODUCT_DATABASE_URL` is mandatory for product runs. Before and after every arm, the eval process independently queries the bound live rows, follows LCM and Curated relationships through `memory_node_sources` and `curated_memory_sources`, hashes the observed state, and checks the live API capability/database identity. It rejects stale, incomplete, invalidated, changed-during-run, cross-runtime, cross-corpus, source-type, Product-context, or configuration mismatches. The proof is attached by this explicit test-only local harness after verification; production API/MCP routes do not expose eval controls or claim to emit Arena proof. Unit adapters may construct proof metadata only for unit tests.

Product ablations use a direct-call-only worker controller; it is not available through production environment variables or API/MCP schemas. The `one-api-retrieval-call` arm limits calls to the product retrieval API; reports separately measure every internal vector/database stage, candidate and hydration count, decrypt, embedding call/token count, database read, latency, and peak RAM. `rewrite-one-dense` uses the Arena rewrite provider followed by exactly one call to the configured Qwen Embedding Service. `qwen-0.6b-single-shot` embeds the original query exactly once through that same provider. Both use Koed's shared `qwen3-retrieval-query-v1` and `qwen3-retrieval-document-v1` transforms and fail unless the service reports the canonical `qwen3-0.6b` model and 1024 dimensions; they do not infer behavior from an endpoint label.

`no-lexical-anchors` must use a separate eval runtime whose valid structured summaries were composed and indexed with empty lexical-anchor lists. Configure the harness with `KOED_EVAL_NO_LEXICAL_PRODUCT_API_URL`, `KOED_EVAL_NO_LEXICAL_PRODUCT_AUTHORIZATION`, and `KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST`. Case-specific scope and search-domain context remains authoritative. The harness routes that arm to the isolated runtime; it never simulates the ablation by hiding anchor fields after retrieval. Missing required rewrite, Qwen, or no-anchor configuration fails the requested arm instead of silently relabeling production behavior.

The isolated API process must receive the same absolute `KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST` path, `KOED_EVAL_NO_LEXICAL_INDEX_PROOF_SHA256` set to the SHA-256 of the exact manifest bytes (for example, `sha256sum "$KOED_EVAL_NO_LEXICAL_INDEX_MANIFEST"`), and `MEMORY_API_URL` equal to the manifest's `runtimeBaseUrl`. The API validates every document's summary-only embedding input/hash/generation and exact vector checksum against the live isolated database rows, as well as the database/schema identity, complete document-set hash, pinned Qwen runtime configuration, and configured manifest proof before advertising `retrieval-arena-structured-summary-v2:summary_text+empty_lexical_anchors`. The title and summary composition policy is otherwise identical to production; only the anchors section is omitted. Partial, stale, anchor-influenced, wrong-runtime, or proof-mismatched configuration returns 503. `KOED_EVAL_RETRIEVAL_COMPOSITION` is not an attestation and is ignored. Before an arm runs, the harness requires the API's hash-bound capability response and also rejects anchors or a different proof returned by any subsequent search.

The runner refuses to complete an answer-quality run when its mandatory semantic judge errors/fails or any deterministic status, exact-fact, schema, or forbidden-fact check fails. One case deadline covers retrieval, product synthesis, fixed reading, and judging; embedding HTTP requests receive the same cancellation signal. Product and fixed reader calls and judge calls report latency, actual model, cumulative tokens, status, errors, and measured or configured-price cost separately under `answerResources`. Product synthesis receives the shared candidate, evidence-item, evidence-token, search, expansion, and deadline budgets before the worker runs.

Product-arm peak memory is never inferred from the eval-runner process. Set `KOED_EVAL_PRODUCT_PROCESS_TELEMETRY` to a `koed-retrieval-arena-process-telemetry-v1` JSON inventory containing unique live PIDs for the three stable roles: `api`, `database`, and `embedding_service`. Each stable component requires a `component` label and provenance from runtime status, database status, or Embedding Service health. Do not predeclare `ai_client_model`: the Memory Answer worker measures every actual Codex app-server child from spawn through shutdown and returns its PID, sampled peak RSS, measurement method, sample count, interval, and attempt index.

The Arena samples the three stable processes concurrently for the whole arm. It combines their maximum concurrent aggregate with the largest dynamically measured Codex child peak. Retry children are reported individually but only their maximum is added, because attempts are sequential and summing them would falsely claim concurrency. Reports use `koed-retrieval-arena-peak-memory-v2` with `aggregation=stable_concurrent_plus_max_dynamic_child`, per-component details, stable and dynamic subtotals, and the combined `peakRssBytes`. Strict product runs fail closed when the stable inventory is missing/incomplete, when a stable PID cannot be measured, or when no Memory Answer execution contains measured child telemetry. No prompt, response, environment, or credential content is included in process telemetry.

For the Team synthetic fixture, pass `--authorization-manifest=packages/evals/fixtures/retrieval-arena-authorization.json`. The `koed-retrieval-authorization-v1` schema requires the complete captured, retained, cross-User, cross-Team, cross-Workspace, revoked, private, removed-member, uncaptured, and API-token denial matrix. Each probe names a credential environment variable, query, optional Workspace/Project, expected HTTP status, and `mustContain`/`mustNotContain` sentinels, then executes the real `/v1/memory/answer` authorization path. Run `pnpm team-fixture:seed` against an isolated database first. Captured and retained positive probes require real HTTP 200 Team recall; forbidden boundaries must return the declared denial or an authorized response without the forbidden sentinel.

Optional embedding competitors use `createKoedEmbeddingServiceProvider` with a distinct provider/model identity and `createDenseArm` with a distinct arm ID. Keep each dimension in an isolated eval index. Do not add competitor models to the production allowlist. External datasets are accepted only through a validated manifest containing the exact repository, revision, license, source hash, transformation version, and resulting corpus hash; downloads must remain explicit and outside unit tests.

Reproducibility records use explicit nullable fields rather than inferred labels. Every report is checked against the strict exported `retrievalArenaReportSchema` before it is returned or written. Report metadata identifies both the complete dataset corpus and the selected-case corpus, and derives a deterministic SHA-256 seed from dataset, selection, arm configuration, run count, and run number. The seed controls case/arm ordering and run-index assignment; it explicitly does not claim to control external model sampling or live service state. Set role-specific `KOED_EVAL_*_ARTIFACT`, `_ARTIFACT_REVISION`, `_ARTIFACT_HASH`, `_TOKENIZER`, `_TOKENIZER_REVISION`, and `_ACCELERATION` when known. `KOED_EVAL_ACCELERATION` remains the host-wide fallback; do not use it when participating model roles use different acceleration. The reranked baseline additionally retains the service-reported reranker model, artifact, loaded-artifact SHA-256, and SHA-derived artifact revision and reports call count, model-call latency, measured input tokens, and local cost; strict mode rejects missing or mismatched identity, proof, or call telemetry. Configure independent prices with `KOED_EVAL_READER_INPUT_PRICE_PER_MILLION_USD` / `...OUTPUT...` and the equivalent `JUDGE`, `REWRITE`, and `PRODUCT` variables. The unscoped `KOED_EVAL_INPUT_PRICE_PER_MILLION_USD` and output counterpart remain fallbacks. Each cost component records a billing basis: `local_no_cost`, `api_equivalent_estimate`, `provider_reported`, `not_applicable`, or `unavailable`. A zero local cost is therefore an explicit no-charge execution, while configured token prices remain estimates rather than claimed bills. Every answer run exposes aggregate cost components and a completeness flag. Strict mode rejects incomplete aggregate cost and configured-versus-observed reader/product-worker or judge model mismatches. It validates only applicable model roles and resources: every arm requires latency, RAM, retrieval-call, candidate, and evidence measurements; embedding arms additionally require service-measured embedding calls/tokens; generative roles require artifact, tokenizer, price, token, and cost metadata; product arms additionally require database, hydration, decrypt, vector-stage, and complete participating-process telemetry. Optional unavailable arms may instead record an explicit skipped/failed reason. Reports hash complete effective prompt templates—including the loaded `memory-answer-worker` body selected by `KOED_PROMPT_DIR`—plus schema examples, framing, and prompt-serialization version, and include every selected case's shared budget.
