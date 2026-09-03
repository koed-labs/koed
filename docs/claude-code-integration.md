# Claude Code Integration

Claude Code is a supported AI Client Integration for Koed. Its integration is
installed independently from Codex and provides automatic capture through a
Supported Capture Hook and supervised Transcript Watcher, Recall through the
MCP Server, and optional local Synthesis through Claude Code.

Koed does not require Codex for the Claude integration. Codex and Claude Code
may both connect to the same local Koed deployment, but neither installation is
used as a fallback for the other.

Desktop-managed Conversations require explicit `claude` driver and instance
selection. API accepts only an enabled instance with a fresh healthy,
authenticated `managed_conversation_start` capability snapshot. Worker keeps
that exact instance through restart, send, handoff, and fork; it does not fall
back to Codex or another Claude instance. Pi remains visible in Desktop as an
unsupported Managed Conversation owner.

## Requirements

- A running local `koed-server`. The default API host port is `3300`.
- A built MCP Server: `pnpm --filter @koed/mcp-server build`.
- A configured Local AI Runtime under `KOED_HOME`. `koed-server` provisions and
  retains its Personal API Token; Claude Code does not receive it.
- Claude Code 2.1.227 or newer installed separately and signed in with
  `claude auth login`. This is the oldest release covered by Koed's pinned
  Agent SDK compatibility contract; older or unparseable versions fail with an
  update diagnostic.

Koed does not bundle Claude Code and does not accept an Anthropic API key for
Claude-managed Synthesis. It uses the pinned official TypeScript Claude Agent
SDK with the canonical local Claude Code executable and reuses the User's
Claude Code subscription authentication. The executable path and authentication
state stay local and are not stored by the Koed backend.

## Configure Claude Code

In Koed Desktop, open **Preferences → Advanced Diagnostics** and choose **Set
up Claude Code integration**. Desktop verifies the independently installed
Claude Code executable and sign-in, then configures the Koed-owned MCP and Hook
entries after explicit confirmation. The same screen reports integration health
and provides an idempotent repair action.

From a contributor checkout after building the MCP Server, the equivalent Local
Operator Script is:

```bash
pnpm claude:configure
```

The Local Operator Script verifies Claude Code sign-in, installs the Koed MCP
Server at Claude Code's user scope, and merges the Koed Capture Hook into the
local Claude settings file. It preserves unrelated hooks. Restart Claude Code
after the command completes.

Validate or remove only the Koed-owned integration with:

```bash
pnpm claude:configure --check
pnpm claude:configure --remove
```

Running the normal configure command again repairs the Koed-owned MCP and Hook
entries without replacing unrelated Claude configuration. Desktop and the
headless CLI also expose read-only `check claude --json` plus protected
`remove claude --json`; removal requires consent and touches only Koed-owned
entries.

Koed first searches the inherited `PATH`. On macOS it also searches
`~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`, which lets a packaged
Koed app find Claude Code without loading interactive shell startup files. For
an installation elsewhere, pass an absolute executable path:

```bash
KOED_CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude \
pnpm claude:configure
```

`KOED_CLAUDE_CODE_EXECUTABLE` takes priority over discovered paths. The stable
absolute launcher path is stored in the AI Client registry before Claude
synthesis work and its current target is resolved at execution time. When that
target is a Node-based Claude Code CLI entry, Koed invokes it through its
trusted Node runtime rather than depending on `/usr/bin/env node` and an
interactive-shell `PATH`. A missing or invalid executable fails closed. There
is no direct CLI synthesis fallback and no bundled Claude runtime.

The setup script writes only `KOED_HOME` to the local MCP configuration. The
stateless MCP adapter discovers the authenticated Local AI Runtime through its
owner-only registration. Neither the MCP adapter nor Capture Hook receives a
Koed credential.

Before replacing an existing user-scoped MCP entry, setup verifies that its
command and `KOED_HOME` identify a Koed-owned adapter. An unrelated entry using
the configured MCP name is preserved and reported as a collision. Claude Code
setup subprocesses receive a strict system/profile environment allowlist; Koed
service secrets and provider credential environment variables are not passed
through.

The watcher coalesces transcript filesystem writes and lifecycle signals for a
short quiet period before reading the source frontier. This prevents a Stop or
SessionEnd signal from sealing a turn before Claude Code has flushed its final
assistant record. Configure the bounded quiet period with
`MEMORY_CLAUDE_TRANSCRIPT_DEBOUNCE_MS` when filesystem behavior requires it.
`SessionEnd` additionally requires the main transcript and every discovered
subagent transcript to remain unchanged for a bounded quiet interval before
Koed finalizes the source set. An unstable set fails closed and remains
recoverable instead of sealing an incomplete component set.

## Capture

Claude Code invokes the TypeScript Supported Capture Hook for lifecycle events
including session start/end, prompts, tool completion/failure, stop/failure,
and subagent start/stop. The Hook uses the event only to identify and wake the
matching local transcript source. It does not send prompt, response, or tool
content to the API.

The `koed-server`-supervised Local AI Runtime owns the Claude Transcript Watcher when
`MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED` is enabled (the default in developer
and local-personal runtime modes) and a local API Token is available. The
watcher consumes each signalled Claude session through
the official Claude Agent SDK session reader, uses the Claude transcript for
timestamps and complete-record validation, and submits canonical raw
conversation items through the normal Projection path. The transcript remains
the source of truth; Hook payloads are signals, not captured semantic content.
Duplicate signals and replayed transcript items converge through stable
idempotency keys.

The Claude capture implementation keeps filesystem discovery, transcript-to-item
adaptation, source journaling and generation transitions, one-signal capture,
and daemon scheduling behind separate module contracts. The watcher owns only
debounce, retry, and filesystem wake scheduling. This keeps changes to Claude's
disk layout independent from Projection policy and source-set lifecycle rules.

On first activation the watcher records an activation time and does not import
older messages as live capture. Historical import is a separate concern.
Capture creates Personal Memory only and grants no Team or Workspace authority.

On first activation, the Local AI Runtime automatically considers Claude
Conversations active in the inclusive previous 30 days, selects at most the
newest 50, and imports them oldest-first through the provider-neutral
historical-ingestion coordinator. The import includes the main transcript and
its discovered source components. Explicit User-selected import continues to
use the same historical-import orchestration boundary. Import registers the
complete signed source journal, then processes only the range before the live
activation frontier. It never treats pre-activation history as live capture and
cannot write Team Memory.

## Recall

Check the MCP connection:

```bash
claude mcp list
```

Inside Claude Code, `/mcp` shows the Koed server and tools. The normal recall
tool appears as `mcp__koed__memory_answer` when the default setup name is used.
Run the direct Koed access check with:

```bash
node packages/mcp-server/dist/cli.js doctor
```

`memory_answer` defaults to the Project Search Domain. Project search resolves
from the MCP Server process working directory; pass `project_id` explicitly
when it does not match the captured Project. Session search requires a backend
`session_id`, and global search spans all Personal Memory visible to the API
Token.

These checks confirm MCP and API connectivity; they are not a substitute for a
live capture acceptance test. After restarting Claude Code, create a fresh
session, then inspect Koed for the resulting Captured Session before treating
capture as verified.

## Per-flow Synthesis routing

Memory Answer, LCM Summary, session-title synthesis, and Curated Memory Review
resolve provider, AI Client instance, model, and reasoning effort independently.
Set a flow's provider to `claude` and choose a model exposed by the local Claude
Agent SDK model list. Other flows may remain on `codex` or `pi` when installed.
Desktop Advanced settings shows current auth, availability, and snapshot
staleness; unavailable persisted assignments remain visible and do not fall back.

For example:

```bash
MEMORY_ANSWER_PROVIDER=claude
MEMORY_ANSWER_MODEL=<claude-model>
MEMORY_LCM_SUMMARY_PROVIDER=claude
MEMORY_LCM_SUMMARY_MODEL=<claude-model>
```

Persisted User settings take precedence for flows that support them; environment
values are bootstrap defaults. Koed does not silently switch provider or model
when the selected provider is unavailable. Claude execution uses no AI-client
tools, does not load project settings, does not persist an SDK session, and
runs as a single local synthesis turn. The backend continues to store and
retrieve evidence but never calls an LLM.

See [Configuration](configuration.md) and
[Local Memory Agent Settings](local-memory-agent-settings.md) for all flow
settings and precedence.

## Running alongside Codex

Codex and Claude Code can attach separate stateless MCP adapters to the same
Local AI Runtime under one `KOED_HOME`. Persistent watcher, LCM, review, and
Memory Answer work has one runtime owner, so additional AI Client sessions do
not create competing ports or background services.

Claude Code currently connects through MCP's initialize-based stdio path. Koed
serves that path and MCP `2026-07-28` discovery through the same adapter factory;
neither path owns persistent work.

Capture remains provider-specific: Codex transcript growth is handled by the
Codex watcher, while Claude hook signals are handled by the Claude watcher.
Installing one integration neither configures nor disables the other.

## Current setup boundaries

- Claude Code remains optional. Guided first-run setup reports executable/profile
  availability, but never selects or configures Claude automatically. Select
  Claude Code explicitly in the post-core AI Client screen; setup has its own
  consent prompt and can be cancelled without affecting core or other clients.
  A detected but unsupported or unauthenticated installation affects only the
  Claude client result, not core Koed runtime health. Preferences can set up,
  check, repair, or remove Claude later.
- Desktop setup configures MCP and hooks but does not run an automated end-to-end
  capture fixture. Verify a fresh live session explicitly.
- Documented synthesis defaults remain Codex-oriented. A Claude-only installation
  must select `claude`, its explicit instance, and an exposed Claude model for each
  flow it wants Claude Code to run. Resetting one flow leaves other assignments
  unchanged.
