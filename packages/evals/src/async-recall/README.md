# Submit/collect Memory Answer evaluation

Four hand-authored deterministic cases cover independent diagnostics, an
immediately dependent decision, no relevant memory, and a follow-up changing
from non-blocking to blocking recall. The synthetic MCP fixture returns an
immediate task receipt, completes after a configurable delay, and requires the
AI Client to collect through `memory_answer_result` before a dependent action.
It does not use Stop hooks, Code Mode, or MCP Tasks.

Run the scorer against scripted reference traces, without a model:

```bash
pnpm --filter @koed/evals eval:async-recall
pnpm --filter @koed/evals exec vitest run src/async-recall/benchmark.test.ts
```

These checks validate fixture and scoring logic, **not actual model behavior**.
To observe actual native Codex tool behavior against the delayed synthetic MCP
fixture (requires a configured Codex binary and credentials):

```bash
pnpm --filter @koed/evals eval:async-recall:live -- --runs 3 --model gpt-6.1-sol --reasoning-effort medium --delay-ms 5000 --out /absolute/path/outside-repo/async-recall.json
```

The live server uses the production `createKoedMcpServer` factory with a
synthetic delayed Local AI Runtime client. Tool schemas, descriptions, receipts,
collection, cancellation, and answer formatting are therefore production code;
the recalled data and background execution are still synthetic. Ordinary
negotiated MCP clients are supported without Code Mode.
Mode events record effective production-factory dispatch, not the raw adapter
argument: an omitted/default delivery mode that dispatches blocking is recorded
as blocking. Use the existing tool-choice suite for raw argument selection.

Select one scenario with `--case independent-diagnostics`,
`--case dependent-decision`, `--case no-relevant-memory`, or
`--case followup-mixed-modes`. Reports preserve each observable event, decision,
exit code, and final response. Output files are create-only. Isolated temporary
workspaces are removed on success or failure; credentials are neither copied
nor written to reports. Model sampling and scheduling are not deterministic.

Hard violations include a missing recall/decision, wrong task attribution,
using results before collection, incorrect recalled values, invented settings
after no relevant memory, identical normalized query resubmission before
collection, and follow-up actions before the primary decision.
They determine `passed` and CLI exit status. Background completion alone does
not establish that the AI Client has received the answer.

Advisory scores separately measure preferred delivery mode, a fixture diagnostic
action between receipt and completion, additional retrieval, and polling discipline.
Distinct narrower queries are not hard duplicates merely because the synthetic
fixture maps them to the same primary phase. Query text is retained in traces.
The benchmark
flags more than two pending polls or more than one sub-second pending poll as
excessive. These thresholds are experimental benchmark policy, not protocol
invariants or production waiting guidance. The first pending result is allowed.
Final successful collection is not counted as a pending poll. Internal runtime
reads during a `wait: true` result request are not model polls. By default,
collection returns immediately; `wait: true` awaits the same task until it is
terminal, expires, or the caller aborts, subject to the existing observation
lifecycle. No separate short collection timeout is introduced.
Unexpected result-argument keys are retained in request telemetry; rejected
argument calls are not classified as pending polls.

The diagnostic and decision tools are explicit fixture-only observability
points. This suite does not prove production recall quality, shell-work
usefulness, notification delivery, or natural-language answer correctness.
Post-receipt tool-action ordering does not prove a separate main-model reasoning
sample: actions might be preissued within one native tool batch. The suite does
not capture native model-sampling events and makes no separate-sample claim.
It retains the final prose for manual review but does not semantically judge it.
The configured delay can finish before independent work if the model is slow;
the event trace makes that missed overlap visible rather than assuming it.

Score an externally supplied JSON event array with
`eval:async-recall -- --case CASE_ID --trace /absolute/path/trace.json`.
Such reports are labelled `external_trace_unverified`, not live model evidence.
