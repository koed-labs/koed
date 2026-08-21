# Codex Integration

Codex, Claude Code, and Pi are supported AI Clients. This page covers Codex;
see [Claude Code integration](claude-code-integration.md) and
[Pi integration](pi-integration.md) for other client setup. Select each flow's
instance and model in [Local AI Runtime Settings](local-memory-agent-settings.md).

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
run a separate worker command. `MEMORY_CODEX_APP_SERVER_BINARY` can override
the Codex binary path when needed.

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
its own transcript until `task_complete` or `turn_aborted` is consumed.
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

## Experimental Koed-managed threads

The MCP package also exports a local `CodexManagedConversationSession` for the
app-server-first ingestion experiment. It owns a persistent stdio app-server
thread and journals generated JSONL before consuming it into the same canonical
records and sealing each turn. It can
resume an existing provider thread and Koed Captured Session after restart.
Its isolated Codex home is durable under `KOED_HOME`; the rollout and atomic
database-backed journal consumer cursor must be retained for the managed Captured Session's
lifetime and removed only through explicit managed-home cleanup.
An exclusive process lease prevents concurrent coordinators from using the same
home and includes operating-system process-start identity so PID reuse cannot
adopt a stale lease. Managed subagent `thread/started` events create linked
child Captured Sessions and reconcile each child rollout separately. Normal
shutdown releases the lease without deleting the rollout. Managed terminal
boundaries are held until their journaled records project successfully, so a
later turn cannot be folded into an earlier seal.

There is no Desktop entry point for this legacy experiment. Desktop-managed
Conversations use explicit registered AI Client ownership instead: Desktop
selects `codex` plus exact instance ID from a fresh capability snapshot, and the
API persists that owner. Worker resumes and transfers only through that exact
Codex instance; it never falls back to another instance or client. Existing
Codex CLI and native-app conversations remain captured from transcript growth;
Capture Hook signals only reduce watcher latency.

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
