# Claude Code Integration

Claude Code is a supported AI Client Integration for Koed. Its integration is
installed independently from Codex and provides automatic capture through a
Supported Capture Hook and supervised Transcript Watcher, Recall through the
MCP Server, and optional local Synthesis through Claude Code.

Koed does not require Codex for the Claude integration. Codex and Claude Code
may both connect to the same local Koed deployment, but neither installation is
used as a fallback for the other.

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

From the Koed checkout after building the MCP Server, run:

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
entries without replacing unrelated Claude configuration.

When Claude Code is not on `PATH`, pass an absolute executable path:

```bash
KOED_CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude \
pnpm claude:configure
```

`KOED_CLAUDE_CODE_EXECUTABLE` is resolved to its canonical real path before
Claude synthesis work. A missing or invalid executable fails closed. There is
no direct CLI synthesis fallback and no bundled Claude runtime.

The setup script writes only `KOED_HOME` to the local MCP configuration. The
stateless MCP adapter discovers the authenticated Local AI Runtime through its
owner-only registration. Neither the MCP adapter nor Capture Hook receives a
Koed credential.

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

Historical Claude sessions are imported only after explicit User selection
through the historical-import orchestration boundary. Import registers the
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
resolve provider and model independently. Set a flow's provider to `claude` and
choose a model exposed by the local Claude Agent SDK model list. Other flows may
remain on `codex` when Codex is also installed.

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

- Claude setup is a Local Operator Script and is not yet a Koed Desktop guided
  setup or repair stage.
- The Claude setup command configures MCP and hooks but does not run an automated
  end-to-end capture fixture. Verify a fresh live session explicitly.
- Existing synthesis defaults remain Codex-oriented. A Claude-only installation
  must select `claude` and an exposed Claude model for each flow it wants Claude
  Code to run.
