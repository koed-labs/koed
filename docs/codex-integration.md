# Codex Integration

Codex is currently the only supported AI Client for Koed.

For an experimental recall-only Claude Code setup, see
[Claude Code integration](claude-code-integration.md).

## Recommended Setup

Start the local control plane supervisor in one terminal:

```bash
pnpm --filter @koed/koed-server build
node packages/koed-server/dist/cli.js start
```

`koed-server start` is long-running. After it reports that the API is ready, run
the Codex setup wrapper from another terminal:

```bash
node packages/koed-server/dist/cli.js setup codex --json
```

The setup command prepares the environment, creates or reuses the local API
Token once the API is ready, writes the app-provisioned Explorer credential,
writes the Codex MCP and Capture Hook configuration, verifies capture, and
finishes with a doctor check. Koed Desktop runs this guided client setup path
automatically on startup when needed; `pnpm clients:bootstrap` remains the
underlying Local Operator Script for manual recovery.

## API Token

Create a local API token and copy it immediately. Full token values are shown once.

```bash
pnpm api-token:create --owner-email local@koed.ai --name "Client Integration"
```

Use `pnpm explorer:bootstrap` if you already have a token and just want to write
it into Explorer local config.

## MCP Server

The MCP Server is the supported recall path. It lets Codex ask Koed for cited
memory evidence. It does not automatically capture whole conversations.

```bash
pnpm --filter @koed/mcp-server build
```

In Codex Desktop, add a custom MCP server using `STDIO`:

```text
Name: koed-selfhost
Command: node
Argument: /path/to/koed/packages/mcp-server/dist/cli.js
Environment:
  MEMORY_API_URL=http://localhost:3300
  MEMORY_API_TOKEN=<token>
  MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000
Working directory: /path/to/koed
```

The supervised `koed-server` default API host port is `3300`; direct app-local
API runs use `3300` by default. If your API runs on a different host port, use that
port in `MEMORY_API_URL`.
If Codex Desktop cannot resolve `node`, set the command to an absolute Node path
or run setup with `MEMORY_NODE_COMMAND=/path/to/node`. Shell-managed versions
from NVM, pyenv, or similar tools may not be on the PATH when Codex runs hooks.

## Browser Questions

The Explorer Questions tab uses the local MCP server as its AI-client
sidecar. The browser can ask a question and persist it in Koed, then the MCP
server delegates answer synthesis to Codex app-server mode in the local Codex
environment. The backend stores questions, retrieval evidence, citations, and
answer status, but does not run LLM synthesis.

When the MCP server starts, it also starts a local browser bridge on
`http://localhost:3210` by default. The Explorer uses that local endpoint
for Questions; there is no separate bridge process to run. `MEMORY_API_TOKEN`
also enables the MCP server's local pending-question catch-up service, which
claims unanswered browser questions and finishes them through local Codex answer
synthesis after a refresh or interrupted browser request.

Koed starts Codex app-server mode internally when it needs local answer or LCM
summary synthesis. Users do not need to run a separate app-server or answer
bridge command. `MEMORY_CODEX_APP_SERVER_BINARY` can override the `codex`
binary path when needed; the default is correct for normal Codex installs.

## Transcript Watcher and Capture Hook

The Transcript Watcher owns automatic-capture correctness for externally managed Codex Conversations. `koed-server` supervises the `@koed/mcp-server` command `watch-codex-transcripts` after its startup readiness check when a local API Token is available; the watcher keeps retrying through bounded rescans if the API is still recovering. It stops the watcher before the API. Developer and local-personal runtime modes enable it by default; external runtime mode requires `MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED=true` explicitly.

By default, the watcher scans `CODEX_HOME/sessions` (`~/.codex/sessions` when
`CODEX_HOME` is unset). `MEMORY_CODEX_TRANSCRIPT_ROOTS` replaces that default
with a platform path-delimited list of explicit transcript roots. Filesystem
notifications enqueue the exact changed transcript ahead of other work.
Supported Capture Hook signals coalesce additional wakeups without carrying
content. Known active transcripts are serviced before bounded discovery, and
discovery traverses timestamped Codex paths newest-first. The watcher does not
poll: a missed filesystem notification is recovered by the next Hook signal,
source event, explicit verification, or process restart through the same
idempotent source cursor.

The TypeScript Supported Capture Hook is only a low-latency signal. It receives
no API credentials and reads only bounded source-routing and lifecycle fields
from stdin. Ordinary events write a private timestamp wake hint. `Stop` and
`SubagentStop` additionally write an atomic boundary timestamp under hashed
session/path identities together with the exact complete JSONL byte frontier
observed by the Hook. The matching watcher journals through that frontier,
persists one idempotent `codex-hook-signal-v1` lifecycle control for the active
transcript turn, and only then processes newer bytes. The control is
content-free and cannot render or embed by itself. No prompt, response, tool
payload, raw path, or session identifier is retained in the signal files.
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

There is no Desktop or Explorer entry point for this experiment. It does not
attach to external Codex processes and does not replace the supported Transcript
Watcher. Existing Codex CLI and native-app conversations are captured from
transcript growth; Capture Hook signals only reduce watcher latency.

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

The MCP Server uses the Koed API Token for Recall, LCM summary submission, and Memory Answer evidence. Koed relies on Codex for Synthesis; the backend does not make server-side LLM calls in this build. The separately supervised Transcript Watcher performs automatic Conversation capture; running the MCP tool server alone does not. Recall-only or MCP-only integrations are experimental because they do not provide supported automatic capture.

`memory_answer` is the normal recall tool exposed by default. It is described
to Codex as recall for prior conversations, remembered preferences,
user-provided facts, project history, decisions, and cross-session context. It
defaults to project search, uses session search only for a known captured
conversation, and uses global search only for broad cross-project or
personal-history recall. It returns a compact answer by default so normal Codex
sessions are not filled with large evidence bundles. Use its explicit
evidence/detail option only when debugging retrieval.

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

Captured-session titles and LCM summaries are processed by the MCP-local
background service through Codex app-server mode. If that local service is
delayed or fails, Koed still returns pending placeholders as degraded evidence
and reports the backlog through diagnostics instead of marking the backend
unhealthy.
