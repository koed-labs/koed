# Codex Integration

Codex, Claude Code, and Pi are supported AI Clients. This page covers Codex;
see [Claude Code integration](claude-code-integration.md) and
[Pi integration](pi-integration.md) for other client setup. Select each flow's
instance and model in [Local AI Runtime Settings](local-memory-agent-settings.md).

Personal Memory Answers use [durable execution](durable-memory-answer.md).
Codex uses blocking recall by default. An optional native CLI integration lets
the original turn continue while recall runs. Its synchronous Stop hook supplies
the completed result when that turn reaches its stop boundary.

## Optional deferred recall in the native CLI

Enable the adapter through the packaged Local Operator Script:

```bash
koed-server setup codex --deferred-recall --json
```

From a contributor checkout, use `pnpm codex:configure --deferred-recall`.
Restart Codex and review its native hook trust request before use. Setup installs
matched PreToolUse and PostToolUse hooks, a synchronous Stop hook, and SessionEnd
and Interrupt cleanup hooks. It preserves Capture Hooks and unrelated settings.
A trusted PreToolUse hook binds each request to its exact native call. Missing
readiness uses blocking recall instead.

In the VS Code extension, a yellow badge on the hook icon can indicate hooks
awaiting approval. Open **Review hooks** and review the Koed definitions before
starting recall; folder trust is a separate decision. New or changed hook
definitions are skipped until trusted. See the [official hook trust guide](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

The default Stop wait is five minutes (`--wait-ms 300000`), with a 305-second
native hook timeout. The helper accepts waits from 1,000 to 1,800,000 milliseconds.
If you manually change that flag, set the native timeout to the wait in seconds,
rounded up, plus five. A wait failure supplies no recalled answer and does not
guarantee later delivery. The worker can continue under its separate hard limit.

Plain setup or repair preserves the existing selection. Use `--blocking-recall`
with setup to disable this adapter. Contributor `pnpm codex:configure --check`
checks the owned configuration without writing. `--remove` removes only Koed's
owned configuration and managed global guidance.

The contributor checker accepts configuration written by server repair in both
recall modes. Isolated configuration checks cover repeat setup, repair, explicit
blocking selection and owned removal while preserving unrelated settings and
Capture Hooks. Runtime provisioning and native trust require separate checks.

Only one recall per native turn can use deferred delivery. Further calls in that
turn use blocking recall. A missing pre-call hook uses blocking recall; a consumed
or invalid receipt fails instead of starting another task. Unsupported native
subagent calls also retain blocking recall.

Receipt files contain task and origin identities, not recalled results. A crash
can leave a locked receipt that cannot recover delivery. Expired unlocked state
is collected, but locked state is retained and the store is bounded. To repair
that state, first close all Codex sessions and stop their Koed MCP and hook
processes, then clear only `KOED_HOME/codex-memory-delivery`. This does not cancel
or replay durable tasks, and it does not restore delivery to exited sessions.

Isolated Codex 0.159.3 native CLI tests verified useful-work overlap, automatic
original-turn delivery, token revocation, expiry, one scheduler failure and one
durable cancellation. The cancellation run used a managed backend at 0.160.0;
the failure run used a managed backend at 0.159.3. A timeout run showed the
native notice and later durable completion, but did not meet its strict delayed
read criterion. A pending-exit run failed its criterion: `/quit` disconnected
the CLI while the backend kept the original turn running, so a model answer
appeared after the User left and before SessionEnd retired the receipt. A
separate native fork test verified that an interrupted parent's result did not
reach its package-only child when the User forked before completion; it used
one unchanged real query response held for 90 seconds to create that window.
A separate `/new` test used the same controlled hold after native parent
interruption. The new Conversation completed package-only work before durable
completion and received no original answer; the parent produced no later
model answer. This qualifies CLI origin isolation for that interrupted-parent
selection path. Active foreground switching, natural-latency fork/switch
timing remain unverified for those CLI cases.
Stop waits inside the original active turn. This integration does not wake an
idle conversation or recover a result into a new session after exit.
The adapter uses the shared delivery lifecycle and the same durable executor.
It does not poll through model tools or synthesize answers on the backend.
The [manual test checklist](codex-deferred-recall-manual-tests.md) records the
remaining cases, preparation, and required evidence.

A separate VS Code 1.139.1 test with extension 26.5930.51102 and bundled Codex
0.160.0 demonstrated the normal active-turn path with `gpt-5.6-luna`. Native
evidence showed one pending recall, an exact package read and summary 13.1
seconds before real recall completed, then one automatic answer with the
original source citation in that same turn. No added delay, polling or retry
was used. The transcript stayed unchanged through a later check and window
closure, and the isolated services and credentials were cleaned up. This
qualifies that bounded positive behavior only. A separate User-driven pending
window-close test showed the frontend backend exiting before real completion,
binding absence by genuine SessionEnd, and no late answer or result context.
SessionEnd found the binding already retired; its first-removal handler was
not directly observed. That controlled case also passed scoped cleanup and
four selected normal-file baseline comparisons. The additional IDE evidence
is recorded below. Desktop coverage is recorded separately below; strict exit
retirement, broader recovery and deferred setup gaps remain explicit. The CLI
pending-exit failure remains separate.

A controlled IDE fork test also passed native parent interruption, distinct
child identity and recorded parent lineage. Real child package work preceded
durable completion; neither history changed after completion or window closure.
No answer reached the child or a later parent model response, and scoped cleanup
passed. This does not establish natural fork speed. A separate active foreground
switch also passed: the User opened a distinct non-fork Conversation without
interrupting the original; the new Conversation finished package work before
completion and received no original result. One answer stayed in the continuing
original owner, and scoped cleanup passed. Real core provisioning/reuse and
native blocking fallback with a healthy runtime but missing pre-call hook also
passed. Plain repair restored the prehook, preserved Capture Hooks/instructions
and passed contributor checking; scoped cleanup passed. A final simulated
orphan-lock cleanup after durable completion also passed without replay or late
answer. This does not prove state removal during pending work or crash recovery.
Independent review accepts the bounded IDE active-Stop route. Desktop and the
unresolved CLI cases remain separate; idle wake-up and exited-session result
recovery are not claimed.

A separate IDE durable-cancellation case also passed: one protected Koed API
cancel changed the owned running task to cancelled, stopped real execution,
and produced one native cancellation notice and model report without an answer,
retry or duplicate delivery. The User kept the native turn open; this did not
use VS Code's Stop action. Scoped cleanup and four selected normal-file
comparisons passed. Further IDE and distinct Desktop evidence appears below;
remaining strict-exit, recovery and deferred-bootstrap gaps are separate.

A further failure case on VS Code 1.140.0 with the same extension/backend
verified accepted recall and package work before the original scheduler claim,
then actual executor start and a genuine hard-deadline failure. One native
failure notice arrived without an answer, retry or duplicate delivery. Scoped
cleanup and selected normal-file comparisons passed.

A separate IDE observation-timeout case then passed a short Stop wait, one
actual nonterminal read drained unchanged after observation abort, and genuine
task completion without cancellation or late answer. The test delayed the
already-read client-port snapshot; it does not qualify the earlier CLI
server-side delay whose socket closed. Scoped cleanup and selected normal-file
comparisons passed. The IDE origin/setup closeout is recorded above; Other Desktop behavior
remains unverified.

A confirmed interruption can still race a Stop hook that has already returned.
Codex may record that late hook prompt in the interrupted turn. Interrupt cleanup
is advisory and does not provide an atomic cancellation fence. This upstream
limitation is accepted for this opt-in integration.
The pending-exit model answer is outside that accepted exception. Until the
exit path is resolved, do not treat `/quit` during a pending recall as proof
that result delivery or model generation has stopped.

A separate first Desktop positive test on ChatGPT.app 26.930.61225 and bundled
Codex 0.160.1 now passes the active-turn contract. Its real package summary
preceded completion by 11.6 seconds without added delay; one Stop hook delivered
the exact owned decision/source to the originating turn without another User
message, polling or retry. Private app/backend/home/IPC paths and sign-in were
observed independently. Scoped cleanup and four selected normal-file comparisons
passed; independent review verified 26 artifact hashes. Metadata labels the
originator Codex Desktop while serializing source as vscode; that label does not
transfer IDE classification. Native SQL rows and rollout were joined separately.
A separate controlled active Desktop switch also passed distinct non-fork owners,
real new-conversation package work before completion, and one answer only in the
continuing original owner, with cleanup and bounded independent review. Close
Window followed by private Dock Quit also passed bounded pending-exit safety;
window-close alone and first-removal attribution remain unverified. A controlled
interrupted-parent fork also passed actual child work before completion, no child
result or later parent answer, cleanup and independent review of 27 artifacts.
Retired receipt binding and full live-history timing remain recorded limits.
A subsequent-turn Desktop durable port cancellation also passed one protected
cancel of the running owner, no saved answer/Question and one native no-answer
notice, with cleanup and independent review of 27 artifacts. Two earlier
fallback/wrong-project attempts remain inconclusive. The native cwd preflight
does not add first-turn admission or native UI cancellation evidence.
A subsequent-turn Desktop scheduler/executor failure also passed a genuine
1,002 ms hard deadline after real package work, one failed attempt and one native
no-answer notice. Worker entry and its returned boundary are explicitly retained;
no full inference is claimed. Cleanup and independent review of 27 artifacts
passed. Corrected Desktop observation timeout also passed actual unchanged
late-read drain with the exact six-second native watchdog, backend completion
without cancellation and no late answer, with cleanup and independent review
of 33 artifacts. Prior 305-second fixture remains behavior-only. Setup and
recovery remain separate Desktop checks. Subsequent Desktop setup evidence also
passes actual core credential provisioning/reuse, supported repeated repair,
configuration selection/removal and native missing-prehook blocking recall,
with cleanup and independent review of 25 artifacts. Full contributor
setup/bootstrap exceeded the fixture deadline and is deferred; direct repair
does not qualify it. Desktop post-completion simulated orphan-state cleanup
also passes exact owned state removal after native/helper exit and real task
completion, unchanged one task/Question and no replay or late answer, with cleanup
and independent review of 30 artifacts. In-flight removal and crash/restart
recovery remain unverified.
Live receipt/full-history checks are observations, not full archived replay;
zero Keychain/protocol activity is not claimed.

## Recommended Setup

Start the local control plane supervisor in one terminal:

```bash
pnpm --filter @koed/koed-server build
node packages/koed-server/dist/cli.js start
```

`koed-server start` is long-running. After it reports that the API is ready, run
client-neutral core setup from another terminal:

```bash
node packages/koed-server/dist/cli.js setup core --json
```

Core setup creates or reuses the local API Token and writes the app-provisioned
local credential. It does not edit Codex configuration or record final
verification; `doctor --json` records each final verification result. To explicitly configure Codex after core setup,
run:

```bash
node packages/koed-server/dist/cli.js setup codex --json
```

That compatibility command writes only Koed-owned Codex MCP/Capture Hook
configuration, reconciles Koed's managed memory guidance in
`CODEX_HOME/AGENTS.md`, registers the resolved Codex executable, and preserves
unrelated Codex settings. Koed Desktop mandatory setup runs core setup only.
`pnpm clients:bootstrap` remains an explicit Codex-focused Local Operator
Script for manual recovery.

Koed first uses a non-empty `MEMORY_CODEX_APP_SERVER_BINARY` override, then
searches the inherited `PATH`. On macOS it also searches `~/.local/bin`,
`/opt/homebrew/bin`, and `/usr/local/bin`, in that order. This supports packaged
Koed apps started from Finder without running an interactive shell or loading
shell startup files. Set `MEMORY_CODEX_APP_SERVER_BINARY` to the executable's
absolute path for installations in other locations. Koed stores the stable
absolute launcher path in `KOED_HOME/config/ai-client-instances.json` and
resolves its current target at execution time, so package upgrades can retarget
the launcher. When that target is a Node-based Codex CLI entry, Koed invokes it
through its trusted Node runtime rather than depending on `/usr/bin/env node`
and an interactive-shell `PATH`.

Koed changes only the section between its `koed-memory-guidance` HTML comment
markers. Existing global instructions and all Project-level `AGENTS.md` files
remain untouched. Repeated setup updates that section in place. If the markers
are duplicated, unmatched, or reversed, setup stops and asks the Operator to
repair or remove the malformed managed block rather than guessing which text
it owns. Restart Codex after setup or repair so new sessions load the guidance.

The guidance is recommended and installed by default, but optional. Operators
can persistently opt out while keeping the MCP Server and Capture Hook enabled:

```bash
node packages/koed-server/dist/cli.js setup codex --without-memory-guidance --json
```

Run the same command with `--with-memory-guidance` to enable it again. Setup,
repair, status, and doctor honor the persisted choice. Opting out removes only
Koed's marked block and preserves all other global instructions.

Packaged app runtimes keep the Codex guidance beside the stable MCP Server
wrapper under `mcp-server/dist/prompts`. Setup and status read that copy. The
MCP Server's complete prompt bundle remains in the shared production dependency
graph under `node_modules/@koed/mcp-server/dist/prompts`.

## API Token

Create a local API token and copy it immediately. Full token values are shown once.

```bash
pnpm api-token:create --owner-email local@koed.ai --name "Client Integration"
```

## MCP Server

The MCP Server is the supported recall path. It lets Codex ask Koed for cited
memory evidence. It is a thin MCP `2026-07-28` stdio adapter; it does not own
capture or persistent local services.

```bash
pnpm --filter @koed/mcp-server build
```

In Codex Desktop, add a custom MCP server using `STDIO`:

```text
Name: koed-selfhost
Command: node
Argument: /path/to/koed/packages/mcp-server/dist/cli.js
Environment:
  KOED_HOME=~/.koed
Working directory: /path/to/koed
```

`koed-server setup codex` writes this configuration only after explicit Codex
setup. Desktop exposes the same protected setup, check, repair, and remove
commands after per-action consent. `check codex --json` is read-only and
`remove codex --json` transactionally removes Koed's marked MCP/Capture Hook
block, managed global guidance block, and registry entry while preserving all
User-owned content. A failed repair or removal restores both managed files. The
adapter discovers the authenticated Local AI Runtime through an owner-only
local registration under `KOED_HOME`; API and upstream credentials are not
copied into Codex MCP configuration. Installing or detecting Codex does not
select it for other flows. The same setup operation installs the packaged Koed
memory guidance in Codex's global instructions. `koed-server status --json` and
`doctor --json` report missing, stale, or malformed guidance through the
existing Codex configuration check, and **Fix Codex integration** reconciles
missing or stale content.

If Koed is not available during MCP initialization, the MCP Server starts in
degraded mode. Codex does not show an MCP startup warning. A memory tool returns
this error until the MCP Server connects:

```text
The koed MCP cannot connect to the local server.
```

Start Koed Desktop or `koed-server`. Then call the memory tool again. The MCP
Server reconnects without a Codex restart.

If Codex Desktop cannot resolve `node`, set the command to an absolute Node path
or run setup with `MEMORY_NODE_COMMAND=/path/to/node`. Shell-managed versions
from NVM, pyenv, or similar tools may not be on the PATH when Codex runs hooks.

## Memory Questions

Memory Questions persisted by `memory_answer` remain available through the API
for inspection. Question submission and synthesis happen through the calling AI
Client and the Local AI Runtime. There is no browser answer bridge.

The Local AI Runtime starts the provider selected for each synthesis flow.
Codex-backed work uses app-server mode; Claude-backed work uses the pinned
Claude Agent SDK with the confirmed local Claude Code executable. Users do not
run a separate worker command. `MEMORY_CODEX_APP_SERVER_BINARY` is the explicit
override for a Codex binary in a nonstandard installation location.

## Transcript Watcher and Capture Hook

The Transcript Watcher owns automatic-capture correctness for externally
managed Codex Conversations. It runs inside the Local AI Runtime supervised by
`koed-server`, starts after API readiness and local credential provisioning,
and stops before the API. Developer and local-personal runtime modes enable it
by default. External runtime mode does not run a Local AI Runtime or Transcript
Watcher; user-local capture belongs on the User's local `koed-server`.

By default, the watcher scans `CODEX_HOME/sessions` (`~/.codex/sessions` when
`CODEX_HOME` is unset). `MEMORY_CODEX_TRANSCRIPT_ROOTS` replaces that default
with a platform path-delimited list of explicit transcript roots. Filesystem
notifications enqueue the exact changed transcript ahead of other work.
Supported Capture Hook signals coalesce additional wakeups without carrying
content. Known active transcripts are serviced before bounded discovery, and
discovery traverses timestamped Codex paths newest-first. Each Hook signal
requests one complete discovery sweep: bounded pages continue automatically
until the sweep completes, and a signal received during a sweep coalesces into
one refreshed sweep afterward. This prevents a newly created Conversation from
being hidden by an older directory snapshot. During initial activation, the
same bounded continuation records the complete baseline before live capture
begins. The watcher does not poll after activation: a missed filesystem
notification is recovered by the next Hook signal, source event, explicit
verification, or process restart through the same idempotent source cursor.

The TypeScript Supported Capture Hook is only a low-latency signal. It receives
no API credentials and reads only bounded source-routing and lifecycle fields
from stdin. Ordinary events write a private timestamp wake hint. `Stop` and
`SubagentStop` additionally write an atomic boundary timestamp under hashed
session/path identities together with the exact complete JSONL byte frontier
observed by the Hook. The Hook makes those boundary files durable before it
publishes the watcher wake, so the watcher cannot consume a Stop wake without
seeing its matching frontier. The matching watcher journals through that
frontier, persists one idempotent `codex-hook-signal-v1` lifecycle control for
the active transcript turn, and schedules one trailing catch-up after Codex has
had time to flush records written after the Stop Hook returned. It only then
processes newer bytes. The control is content-free and cannot render or embed
by itself. No prompt, response, tool payload, raw path, or session identifier is
retained in the signal files.
Independently of Hook and filesystem notification delivery, a one-second
catch-up tick checks a bounded rotation of known sources and the newest
discovery page. A canonical cursor with an open turn additionally rechecks only
its own transcript until exact `task_complete` or `turn_aborted` evidence is
persisted. That evidence is authoritative regardless of which legitimate
transcript reader records it; a managed runner or the Projection worker can
then release the corresponding held turn.
Unchanged open turns back off to a five-second interval; terminal turns stop
rechecking immediately. Exact hints and active sources are always serviced
before discovery work.
Missing signals can delay a fallback turn seal until later transcript evidence
arrives; duplicate, delayed, or reordered signals cannot seal a later frontier
or create duplicate content. Transcript JSONL remains the only content,
provider item identity, and chronology source of truth.

If you install the package binary, use:

```text
koed-capture-hook
```

For a direct Koed checkout, build `@koed/mcp-server` and point Codex at:

```text
/path/to/koed/packages/mcp-server/dist/capture-hook.js
```

Install the Capture Hook for these Codex hook events:

```text
SessionStart
UserPromptSubmit
PostToolUse
Stop
SubagentStart
SubagentStop
```

Parent and child transcripts are discovered independently. Provider session metadata in each journaled transcript preserves child identity and parent linkage; Hook payload paths are never trusted as content locations.

Discovery registers a transcript through one local API-token-authenticated
operation. Koed applies Capture Policy and atomically converges the Personal
Captured Session with its source-journal artifact before any segment can be
consumed. Capture Hook invocations only wake the watcher; they neither submit
content nor create Captured Sessions themselves.

Transcript Watcher settings:

```text
MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED=true
MEMORY_CODEX_TRANSCRIPT_DEBOUNCE_MS=200
MEMORY_CODEX_TRANSCRIPT_POLL_MS=1000
MEMORY_CODEX_TRANSCRIPT_TURN_SETTLE_MS=500
MEMORY_CODEX_TRANSCRIPT_MAX_ENTRIES_PER_SCAN=4000
MEMORY_CODEX_TRANSCRIPT_MAX_FILES_PER_SCAN=200
MEMORY_CODEX_TRANSCRIPT_MAX_BYTES_PER_BATCH=1048576
```

## Koed-managed Conversations

`CodexManagedConversationSession` owns a persistent stdio app-server thread and
journals generated JSONL before consuming it into the same canonical records
and sealing each turn. It can resume an existing provider thread and Koed
Captured Session after restart.

Desktop-managed Conversations use explicit registered AI Client ownership:
Desktop selects the driver and exact instance ID from a fresh capability
snapshot, and the API persists that owner. Worker resumes and transfers only
through that exact instance; it never falls back to another instance or client.

Local managed Conversations use the selected AI Client instance's normal Codex
home, normally `~/.codex`, and the selected Project checkout or explicit
worktree as `cwd`. This preserves the User's authentication, MCP servers,
Capture Hooks, skills, settings, and provider session history. Multiple managed
Conversations may share that Codex home; command and workspace fencing provide
execution isolation. Koed never removes or rewrites the provider home during
shutdown or cleanup.

Desktop's managed app-server process configures Koed's packaged stdio MCP
Server with the selected `KOED_HOME` and `required=true`. Codex waits for
Koed's tools before the first turn and fails startup if the server cannot
initialize. The User's normal Codex configuration remains unchanged, while
`memory_answer` uses the same active Koed runtime as Desktop.

Managed subagent `thread/started` events create linked child Captured Sessions
and reconcile each child rollout separately. Managed terminal boundaries are
held until their journaled records project successfully, so a later turn cannot
be folded into an earlier seal. Existing Codex CLI and native-app conversations
remain captured from transcript growth; Capture Hook signals only reduce watcher
latency.

Codex hook configuration should include `Stop` as well as prompt/tool hooks. If
Codex asks you to review or trust changed hooks after editing `config.toml`,
accept the Koed hook entries only after confirming the paths point to your
checkout or installed package binary.

For Linux and WSL, use absolute Linux paths for the hook command and working
directory, and keep the API URL reachable from that environment. For Docker
Desktop on Windows, this usually means using the host/port that WSL can reach,
not a macOS-style or Windows-only path.

## Verify

Verify the local Capture Hook from the checkout:

```bash
MEMORY_API_URL=http://localhost:3300 MEMORY_API_TOKEN=<token> pnpm codex:verify-capture
```

This command starts an isolated Transcript Watcher, writes a fresh Codex JSONL
fixture, invokes the same content-free TypeScript Capture Hook signals, and
requires a separately embedded user event plus one embedded agent-turn bundle
containing the tool call, tool result, and final response. After
that, start a fresh Codex session and ask it to check memory access through the
`koed-selfhost` MCP server.

The Local AI Runtime uses the Koed API Token for Recall, LCM Summary submission,
and Memory Answer evidence. The MCP adapter receives neither that token nor
upstream credentials. Koed relies on the selected connected AI Client for
Synthesis; the backend does not
make server-side LLM calls in this build. The runtime-hosted Transcript Watcher
performs automatic Conversation capture; running the MCP adapter alone does
not. Recall-only or MCP-only integrations are experimental because they do not
provide supported automatic capture.

`memory_answer` is the normal recall tool exposed by default. It is described
to Codex as recall for prior conversations, remembered preferences,
user-provided facts, project history, decisions, and cross-session context. It
instructs Codex to consult the relevant available Personal or authorized Team
Memory before substantive work in a new chat or on a sufficiently new topic,
unless the task is simple and Memory certainly cannot materially help. It
defaults to project search, uses session search only for a known captured
conversation, and uses global search only for broad cross-project or
personal-history recall. It returns a compact answer by default so normal Codex
sessions are not filled with large evidence bundles. Use its explicit
evidence/detail option only when debugging retrieval. Optional bounded
retrieval hints can seed exact checks, semantic reformulations, entities, and
temporal intent. The Local AI Runtime treats them as untrusted suggestions and
cannot use them to broaden authorization or the selected Search Domain.

Koed's generated Codex configuration pre-approves `memory_answer`, so read-only
recall does not require a separate tool approval. This rule does not pre-approve
Curated Memory intake or other write-capable tools. Their approval behavior
follows the Conversation's selected permission mode.

`memory_intake_propose` is also exposed by default for Curated Memory intake. It
only queues async review of durable source-linked facts; it does not directly
write canonical Curated Memory. When source IDs or a Captured Session ID are not
known, the tool sends the exact supporting User statement so the API can bind
one unambiguous source instead of guessing from the current Project. See
[Curated Memory](curated-memory.md).

Setup checks should use `pnpm codex:bootstrap` or `pnpm codex:doctor`;
optional MCP diagnostic tools such as `memory_access_check`, `memory_search`,
and `memory_expand` require explicit development/operator environment flags and
are not part of the normal agent-facing surface.

The watcher reads only complete JSONL records. Its first bounded full discovery cycle is the activation baseline: every candidate file observed before activation is durably marked baseline even when parsing it fails, so a malformed file cannot block later live capture or be replayed as live after recovery. Baseline files register at their immutable complete-record frontier; files first observed after activation start with a zero frontier and are live from their first complete record. Restart resumes post-frontier growth from an independent durable live cursor and compares bounded SHA-256 first/last prefix sentinels plus offset; it never derives from or updates the historical checkpoint. Sentinel-covered prefix mutation, malformed complete records, and truncation fail visibly without advancing it; mutations outside sentinel windows are intentionally not detected by this bounded check. Partial trailing records hold the cursor. Capture Policy and Capture Pause are checked before session creation and every batch. Output converges through `codex-transcript-v1`, canonical raw ingestion, and Projection as Personal Memory only; the watcher grants no Team authority and performs no backend synthesis.

Captured-session titles and LCM summaries are processed by the Local AI Runtime
through the provider selected for each flow. If that local service is
delayed or fails, Koed still returns pending placeholders as degraded evidence
and reports the backlog through diagnostics instead of marking the backend
unhealthy.
