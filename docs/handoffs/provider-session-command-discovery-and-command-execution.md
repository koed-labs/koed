# Handoff: Provider-Session Command Discovery and Command Execution

**Status:** Planning handoff; implementation not started.
**Branch:** `feat/ai-client-aware-slash-suggestions`
**No PR has been opened.**

This handoff supersedes the file-only adapter direction described as complete in
[AI Client-aware Slash Suggestions Phase 4/5](./ai-client-aware-slash-suggestions-phase4-5.md).
It is the next task after that work: make command suggestions reflect the selected
AI Client's actual session/provider catalog and execute commands according to
their semantics.

## Goal

In a Chat without a Project, selecting Codex should make applicable client-global
commands and skills discoverable. In a Project Conversation, discovery may also
include Project-specific entries. Commands such as `/compact` must invoke the
provider/runtime operation they represent; they must not accidentally be sent as
ordinary prompt text.

## Why this work is needed

Testing the current branch in a new Chat showed no autocomplete for `/co`. The
current implementation only scans file-backed definitions; it does not list
Codex's loaded skills or built-ins. The default `~/.codex/prompts` directory on
the test machine was empty.

Paseo's current implementation demonstrates the missing distinction:

- The composer fetches a catalog associated with a running agent, or a draft
  provider configuration, and caches the result.
- A daemon `list_commands_request` asks the live provider session for
  `listCommands()`. Draft discovery calls the provider's listing adapter (or
  opens a temporary listing session and closes it).
- Paseo's Codex adapter queries the App Server's `skills/list` for the active
  working directory, includes built-in `/compact`, and reads custom prompts
  from `$CODEX_HOME/prompts`. It falls back to scanning skill directories when
  the live skill list is unavailable.
- Paseo handles `/compact` out of band through the Codex App Server compaction
  method rather than assuming it is a normal prompt.

Useful Paseo source references (reference behavior, not code to copy blindly):

- [Command query hook](https://github.com/getpaseo/paseo/blob/main/packages/app/src/hooks/use-agent-commands-query.ts)
- [Daemon command request handler](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/session.ts)
- [Draft command listing](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/agent-manager.ts)
- [Codex command listing and handling](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/codex-app-server-agent.ts)
- [Claude command listing](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/claude/agent.ts)
- [Pi command listing and handling](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/pi/agent.ts)

## Current Koed worktree

The existing work is **uncommitted** and should be inspected before changing it.
It already provides the UI and request path for suggestions, plus a file-backed
adapter. Do not discard it wholesale; replace or retain the file scanner as a
fallback after deciding the provider/session source of truth.

- `apps/desktop/src/renderer/views/personal/ConversationInput.tsx` detects a
  slash query, renders suggestions, and inserts the selected command into the
  draft.
- `apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts`
  fetches and caches catalog results.
- `apps/desktop/src/renderer/views/personal/NewConversationComposer.tsx`,
  `PersonalAskView.tsx`, and `PersonalMemoryViews.tsx` connect discovery to
  Chat and Project composers. Project-free Chat omits `projectId`.
- IPC and the Koed Server manager route `command_discovery` to
  `POST /v1/managed-conversations/commands`.
- `apps/api/src/managed-conversations/routes.ts` checks User/instance ownership,
  capability readiness, and resolves an optional Project ID from verified local
  Project metadata.
- `apps/worker/src/command-discovery-adapter.ts` currently reads bounded
  Markdown files for Codex prompts, Claude commands/skills, and Pi prompts/
  skills. It labels global versus Project scope, blocks root-escaping symlinks,
  and prefers Project definitions on same-kind/name collisions. It does not
  query provider sessions and does not discover Codex skills or built-ins.
- The current command result has `name`, `description`, `argumentHint`, `kind`,
  `source`, and `scope`; it has no execution-semantics field. Every selection is
  treated as text in the ordinary send path.
- `packages/mcp-server/src/ai-client-runner.ts` now marks
  `slash_command_discovery` ready for supported clients when discovery itself is
  available.
- `docs/managed-conversation-ai-client-routing.md` describes the current
  file-backed implementation and must be updated when the source/semantics
  change.

Current branch: `feat/ai-client-aware-slash-suggestions`. Relevant validation
already run before this handoff: API route tests (42), Worker adapter tests (6),
MCP runner tests (23), Desktop targeted tests (124), API/Desktop/Worker
TypeScript checks, API build, and Desktop build passed. Targeted lint and
formatting checks passed. Full Prettier check was blocked by unrelated
`.pi/todos` formatting. The Desktop app is running from
`KOED_DEPENDENCY_MODE=bundled-local pnpm desktop:start`; log:
`/tmp/koed-desktop-start.log` (startup emitted transient `not_ready` errors).

No changeset has been added. The change is user-visible and likely merits a
minor changeset, but the Operator has not confirmed adding one.

## Required design work

### 1. Establish the command catalog interface and semantics

Keep the external interface small and provider-neutral, but represent at least:

- command name, description, optional argument hint, command/skill kind;
- `global` or `project` scope and owning AI Client instance;
- how invocation works, distinguishing ordinary provider-recognized prompt/
  skill input from an explicit provider/runtime action.

The provider's returned metadata must not authorize arbitrary Koed operations.
Use a Koed-owned allowlist/registry to map known control commands to known
handlers. Do not infer executable behavior from a display name or description.

Decide whether to add an invocation category to the command metadata or to keep
catalog metadata separate from a Koed-owned command-action registry. Preserve
backward compatibility for ordinary prompt submissions.

### 2. Find the actual runtime owner and add session listing

Before adding another HTTP hop, trace who owns the live managed session in each
execution profile. The session implementations are in `packages/mcp-server/src/`
and are created/used by `apps/worker/src/managed-conversation-service.ts` and
its runtime coordinator. The API process currently performs filesystem scanning;
it must not pretend to have access to a live session it does not own.

Add a read-only `listCommands()` capability to the managed provider-session
interface and expose it through the process that owns the session. Ensure it is
specific to the current execution generation, AI Client instance, and verified
Project context. It must not start a user turn, mutate Conversation state, or
scrape transcripts.

Provider investigation/implementation:

- **Codex:** expose a bounded App Server request for `skills/list` using the
  session's verified cwd. Combine the live skill list with supported built-ins
  and Codex custom prompt definitions. Verify the App Server protocol/version
  support before relying on a method. Current `CodexAppServerClient.request()`
  is private; add purpose-specific public methods rather than exposing generic
  arbitrary RPC dispatch.
- **Claude Code:** verify the installed Claude Agent SDK version/API for
  `supportedCommands()` (Paseo uses it), and expose only supported command and
  skill metadata from the managed SDK query/session.
- **Pi:** verify the Pi SDK/RPC command-list surface (Paseo uses
  `runtimeSession.getCommands()`) and expose the session's actual catalog.

Keep file-backed discovery as a fallback only where session/provider discovery
cannot provide the needed catalog. Preserve global versus Project provenance;
for Project-free Chats, omit Project definitions. Use the verified Project root
or the execution's persisted cwd, never a renderer-supplied arbitrary path.

### 3. Support the pre-start composer

The new Chat composer has no live managed session yet. Add a draft-discovery
path for the selected AI Client instance, model/config, and optional verified
Project context. Prefer provider listing operations that do not create a thread
or Conversation. If a provider requires a temporary session, bound its lifetime,
close it on every path, avoid transcript/Memory side effects, and cache the
result so it is not launched on every slash keystroke.

For a Chat without a Project, discover client-global commands and skills only.
If the provider API requires a cwd, decide on an existing Koed-owned Independent
working directory or a safe global-only query; do not manufacture Project
scope or accept arbitrary cwd from the renderer.

### 4. Implement command actions according to provider semantics

`ConversationInput` currently inserts every command name into prompt text, and
the normal managed send path submits it as a turn. That is correct only for
commands whose semantics are prompt/skill input.

For a command such as Codex `/compact`:

- map the visible command to a Koed-owned action identifier;
- dispatch it to the owning managed session (Paseo uses Codex App Server
  `thread/compact/start`); do not call normal `turn/start` with `/compact`;
- serialize with active turns and respect cancellation, execution ownership,
  generation fencing, and permission/runtime state;
- make retries/idempotency explicit so uncertain delivery cannot compact twice;
- present progress, completion, and failure through existing Conversation
  presentation without fabricating a user prompt or Memory Event.

Selection should not unexpectedly execute a control action. A safe initial UX is
to let selection fill the composer, then on explicit submission resolve an
exact command invocation and route it by its trusted semantics. Ordinary text
such as `Please explain /compact` must remain an ordinary prompt. Confirm this
UX and define argument parsing, quoting, unknown-command, and in-flight-turn
behavior before implementation.

Do not assume every slash command has the same semantics across Codex, Claude,
and Pi. Add only provider actions that Koed can implement safely and test; other
provider commands/skills may remain provider-recognized prompt input.

### 5. Update protocol, UI, tests, and docs

- Extend IPC/API contracts for live and draft command results and any explicit
  command-action request. Keep request validation strict and enforce owner,
  instance, generation, Project, and capability checks on the server/runtime
  side.
- Preserve the existing scope-aware UI/cache behavior. Key caches by enough
  identity to avoid showing another instance/execution/Project's catalog, and
  invalidate on owner, branch, execution-generation, instance, and Project
  changes. Keep debounce, bounded deadlines, and fail-closed behavior.
- Add provider tests for command discovery and action dispatch; API/IPC tests for
  authorization and strict parsing; Desktop tests for popup, selection, exact
  invocation, normal-text behavior, and no accidental ordinary send for
  control actions.
- Add integration coverage proving Codex `/compact` calls the dedicated method
  once and never sends `/compact` through the prompt path. Cover global commands
  in a Chat without a Project and Project additions/overrides in Project scope.
- Update `docs/managed-conversation-ai-client-routing.md` and this handoff with
  the final source-of-truth, topology, command semantics, failure modes, and
  cache behavior. Do not change `CONTEXT.md` unless a genuinely new domain term
  is resolved.

## Suggested implementation order

1. Trace runtime ownership and settle the typed catalog/action contract.
2. Implement and test a Codex live-session vertical slice: catalog (`skills/list`,
   built-ins, prompts), global no-Project draft discovery, and safe `/compact`
   dispatch. Keep ordinary sends unchanged.
3. Wire Desktop/API/runtime contracts through the actual session owner; remove
   any assumption that API filesystem scanning is live provider discovery.
4. Add Claude and Pi session listing and provider-specific semantics where
   supported; retain bounded file scanning as fallback.
5. Add end-to-end tests, update routing docs, run relevant builds/typechecks and
   formatting/lint checks, then ask before adding the minor changeset.

## Acceptance criteria

- With Codex selected in a Project-free Chat, `/` shows applicable global
  commands and skills, including supported built-ins such as `/compact`.
- A Project Conversation can additionally show commands/skills discovered for
  its verified Project context, without leaking them into Project-free Chats.
- Discovery is tied to the selected client/session and does not create a turn,
  mutate Conversation state, or read transcript content.
- Selecting `/compact` and explicitly submitting it invokes the dedicated,
  serialized, idempotent provider/runtime action; it does not submit `/compact`
  as prompt text or create a fabricated user message.
- Ordinary prompts, including prose containing a slash command name, retain
  normal send behavior. Unknown, stale, unavailable, unauthorized, or
  unsupported commands fail closed without changing prompt behavior.
- Codex, Claude, and Pi behavior is tested where supported; limitations are
  explicit rather than silently treated as ordinary text.

## Product constraints

- No arbitrary shell execution, renderer-controlled paths, transcript scraping,
  or automatic command execution on suggestion selection.
- Do not add server-side LLM synthesis. LCM Summary and Memory Answer
  synthesis remain Local AI Runtime / connected AI Client behavior as already
  documented.
- Do not open a PR or commit unless separately requested.
