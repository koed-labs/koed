# Managed Conversation AI Client Routing

Managed Conversation start requires an explicit AI Client driver and instance.
Desktop preserves the selected launch configuration across Project navigation.
Local authority and local-edge admission require an enabled instance with a
healthy, authenticated, fresh, identity-matched capability snapshot. Hosted
authority delegates deferred local execution readiness to the assigned Worker.
Missing or unavailable owners never fall back to another AI Client.

Managed Conversation endpoints use separate read and write budgets from Memory
endpoints. The API selects each budget from the endpoint and authenticated User
identity. Memory reads, Memory writes, and source-journal requests share their
respective budgets with background ingestion. The `x-koed-request-class` header
does not select an additional API budget.
The Memory API client retries managed Conversation capture requests at most
twice after HTTP 429. Registration outside this traffic class requires an
idempotency key for retry. Each retry retains the original API request and
waits for Retry-After, with a maximum delay of 60 seconds per retry.
These retries do not resend prompts to the AI Client. Other API errors are
returned without retry.

Desktop retains displayed messages when a Chat route changes from execution
identity to captured-session identity. Reconciliation does not clear those
messages while their captured versions are unavailable.

Ask and Projects use the same managed launch controller and Conversation input.
One Desktop lifecycle module owns provisional Conversations, identity updates,
startup retries, and encrypted recovery. App owns navigation and recent history.
The Project view consumes lifecycle state without changing the recovery map.
Recovery writes run in order and remain specific to the current owner.
Desktop opens the Project Conversation detail after start, including when the
first prompt has an uncertain delivery response. It retains stable launch and
message identities during uncertain responses, so recovery does not create a
second execution or prompt. After the
start succeeds, Desktop stores the launch and first-prompt identities in a
bounded recovery record, including uncertain delivery, in its encrypted,
owner-scoped secret store. A restart can restore the provisional
Conversation before capture has supplied its canonical session identity.
After inspection reports a failed, stopped, or fenced execution, Retry creates
and stores a new start key before dispatch. The replacement execution retains
the existing navigation route. Uncertain requests retain their start key.

Enter submits only an enabled Send action. It never invokes Interrupt during
startup or an active turn. The Interrupt button requires a running execution,
and the control handler checks that state again.

An Independent launch uses an owner-local Independent Project for navigation.
The API creates a separate Koed-owned working directory for each execution. A
later resume uses the persisted runtime binding for that directory. Repository
features remain subject to their capability checks.
The start digest includes Independent context. Reusing a start key with a
different context returns a conflict before the API changes the runtime binding.
Desktop identifies Chats from metadata for the exact Koed-owned Independent
Project directory. A User-controlled Project name does not establish this identity.

Recents reads additional graph pages until it collects the requested number of
Conversations or reaches the end. Subagent rows consume raw offsets but do not
consume Conversation slots. An owner change clears and reloads both recent lists.
Launch selections resolve model defaults through the canonical ID, qualified ID,
or model alias from the capability snapshot. Model labels preserve the AI Client's
`displayName`, including available version qualifiers; model values remain unchanged.
Launch options read the selected instance's latest unexpired snapshot, not a new SDK
model query. Local AI Runtime refresh defaults to five minutes with a ten-minute
snapshot lifetime; refresh capabilities when labels lag behind the CLI's catalog.

After API readiness, the supervisor resolves the active local API Token and
passes the same credential to the Worker and Local AI Runtime. This includes
credentials already stored under `KOED_HOME`, not only process-environment or
newly provisioned credentials.

Managed Codex and Claude Code launches register Koed's packaged stdio MCP Server
explicitly for the selected `KOED_HOME`; recall does not depend on global AI
Client configuration. Pi loads the Koed extension explicitly. These connections
use the Local AI Runtime and do not put API Tokens in AI Client configuration.
Managed Codex launches mark Koed as a required MCP Server. Codex waits for its
tools before the first turn and fails startup if the server cannot initialize.
Desktop credentials include the distinct file, terminal, preview, and source-control
operation families; none grants an AI Client permission or a remote mutation approval.

## Slash command suggestions

Desktop command discovery reaches the Worker adapters through
`discoverCommands` IPC → the Koed Server manager →
`POST /v1/managed-conversations/commands`. Draft Codex discovery uses a temporary,
non-Project working directory and normalizes the nested `skills/list` response
(`data[].skills`), excluding disabled and repository-scoped entries. It uses the
selected instance's configured executable. Claude Code draft discovery reads only
the selected instance's global commands and skills through the bounded file
adapter; it does not inherit the API process's Project directory. Pi draft
discovery remains a bounded file fallback.
The route requires an owned, enabled instance and a fresh capability snapshot that
marks slash-command discovery ready. Hosted execution does not read an Operator's
local command files. Codex managed sessions now expose read-only `listCommands()`
and a purpose-specific `skills/list` RPC wrapper, but API/Worker discovery routing
has not yet been connected to that live session owner.

The standalone API Docker image runs the MCP Server package build before building
and deploying the API. This includes the bundled prompt assets required by the
discovery adapters' import graph; TypeScript project compilation alone does not
copy them. The image build imports the deployed routes from `/deploy/api`, outside
the source checkout, so missing packaged dependencies or prompt assets fail the
build rather than API startup.

A Chat without a Project requests client-global definitions only. A Project Chat
requests both global and Project definitions. The API resolves a supplied Project
ID against Koed's local Project registry and passes only that verified root to the
adapter; the renderer never supplies an arbitrary working directory. A Project
command with the same kind and name takes precedence over the global definition.

The fallback adapters read metadata from bounded Markdown files and return names,
descriptions, optional argument hints, command/skill kind, provenance, verification,
and `global` or `project` scope. File entries are unverified and must be revalidated
before executable dispatch. Codex live listing supports provider skills and the
allowlisted `/compact` built-in; custom prompts remain file-backed and unverified.
The API currently does not expose invocation metadata or dispatch control actions.
The adapters do not return prompt bodies, scrape Conversations, or invoke a provider
shell. Supported roots are:

- Codex: `<CODEX_HOME>/prompts` and `<Project>/.codex/prompts`.
- Claude Code: `<CLAUDE_CONFIG_DIR>/commands` and `skills`, plus the corresponding
  `<Project>/.claude/commands` and `skills` roots. Skill names use `SKILL.md`
  frontmatter `name`, falling back to the containing directory name. Nested sync
  directories are storage paths, not slash-command namespaces; their UUID prefixes
  must not consume the command-name length budget. Command files retain relative
  path namespaces.
- Pi: `<PI_CODING_AGENT_DIR>/prompts` and `skills`, plus the corresponding
  `<Project>/.pi/prompts` and `skills` roots.

When the environment variable is unset, each AI Client uses its standard home
configuration directory. Symlinks that escape the selected configuration or
Project root are ignored. File-backed discovery returns at most 128 commands and
visits at most 256 file/directory entries per source root, sharing that root's
budget across all descendants. Non-command files, directories, and rejected
metadata consume the same budget. Streaming directory reads use fixed-size
buffers; only the admitted, bounded entries are sorted. An oversized directory
may therefore yield a truncated catalog rather than a globally sorted prefix.
A containing directory that exhausts the budget leaves no entries for descendants;
for example, 256 skill directories can yield an empty catalog without reading their
`SKILL.md` files. Markdown size and scan depth remain bounded.

The two-second adapter deadline cancels every root scan and returns an empty
catalog. Metadata reads receive the cancellation signal, directory handles close,
and no further traversal or metadata work is scheduled after cancellation.
Already-running non-abortable filesystem calls may finish before cleanup; the
deadline is not a promise that the operating system cancels those calls.
The Desktop hook debounces requests by 500 ms and keeps
instance-and-scope-keyed results for up to 30 seconds when a refresh fails;
unauthorized and stale results clear the cached suggestions. Typing `/` also
shows loading, failure, and no-match states when there are no suggestions;
an empty list no longer hides discovery diagnostics. The suggestion popup is
anchored to the composer with a bounded, scrollable height and an opaque themed
background, rather than positioned above the page's clipped content. Keyboard
navigation scrolls the selected suggestion into view without moving textarea
focus. Enter or Tab inserts the selected suggestion without submitting. Shift+Enter
retains newline insertion, Shift+Tab retains focus navigation, and IME composition
is not intercepted. When there is no selectable suggestion, Enter uses normal
submission behavior and Tab uses normal focus navigation; loading, error, and
no-match diagnostics remain visible. Before launch options arrive, the AI Client picker shows
“Loading AI Clients…” instead of reporting the selected client unavailable.
To validate
visibility in a local Electron test window on the new Chat screen, launch with
`--remote-debugging-port=9223` and run
`node apps/desktop/scripts/validate-slash-suggestions.mjs`. Use localhost-only
debugging for testing and restart without the port afterward.
Pi's file fallback does not
include package-provided skills or symlinks outside its configured roots, so such
installations can legitimately return no entries. Suggestions do not execute a provider command when selected. End-to-end exact
invocation parsing and control-action dispatch remain pending; until then, do not
route `/compact` through ordinary prompt submission.

The execution persists driver, instance, model, reasoning effort, permission
mode, and runner identity. The driver and instance remain fixed for that
execution. Runner changes use the explicit handoff flow.

Users can select model, reasoning effort, and permission changes between turns.
Desktop submits these changes with the next prompt, including the expected
previous settings. The repository locks the execution and admits the settings
and prompt in one transaction. A conflicting selection or unfinished operation
rejects the change. Each prompt retains an encrypted settings snapshot, and its
idempotency digest includes the requested change. Retrying that request cannot
change its settings or create another turn.

Runtime reuse requires the same execution generation, instance configuration
hash, and turn settings. The Worker closes an incompatible cached session and
resumes the same Conversation with the selected settings. It checks current
capability evidence before dispatch. A settings rejection before dispatch fails
the command without placing the Conversation in an uncertain state. Checkpoint
recovery retains the original turn settings and does not replay the prompt.
Capture and Local Synthesis assignments are independent of this owner.

See [Conversation settings](conversation-settings.md) for the Desktop behavior.

## Native adapters

| AI Client   | Managed runtime                             | Source and portability                                                                 |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Codex       | Native app-server protocol                  | Verified Codex transcript journal and native resume/fork                               |
| Claude Code | Official Claude Agent SDK                   | Isolated managed Session Store, verified source boundary, and SDK fork                 |
| Pi          | Installed public SDK with native RPC server | Pi v3 JSONL journal, explicit checkout-bound resume, and SDK `SessionManager.forkFrom` |

All three adapters support start, resume, prompt submission, cancellation,
approval interaction, streaming presentation, source identity, handoff, and
fork. Capabilities are checked per instance rather than inferred from another
client. Desktop disables unavailable owner operations; API admission revalidates
the current snapshot when an action is requested.

Claude capture reads through the same managed Session Store used for native
execution and resume, including child transcripts, with paths confined to that
store. Pi allows up to 60 seconds for cold runtime initialization; subsequent
RPC acknowledgements retain their separate 10-second deadline.

Provider text deltas enter bounded, generation-fenced transient presentation.
They do not become Memory Events directly. Provider-specific Transcript Watchers
admit the durable source and advance canonical capture. Prompts with uncertain
delivery are not replayed automatically. Checkpoints capture the assigned local
checkout before and after turns; restoring files does not rewind Conversation
history or implicitly grant AI Client permissions. Restore retains a recovery
checkpoint and publishes a completed checkout checkpoint and updated diff.
File browsing selects the completed checkpoint for the latest command.

## Permissions

New Conversations default to Full access. The launch picker also exposes
Supervised, Auto-accept edits, and Auto. Codex and Claude use their native
approval/reviewer modes. Pi uses an explicitly loaded tool-approval extension:
read tools are allowed, Auto-accept edits also allows write/edit, and Auto asks
the User because Pi has no native automatic reviewer. Full access allows tools
without prompts. Pi does not provide an operating-system sandbox.

Approval replies preserve native request identity and execution generation.
One-time and session grants have distinct replies. User questions are separate
from approval decisions, and cancellation closes pending interactions. Permission
settings never bypass Koed authentication, file authority, or execution leases.

## Handoff and fork

The source runner stops writing and seals an exact journal boundary. The target
verifies the signed transfer, provider compatibility, local credentials, source
closure, verified snapshot of Project files, and exclusive next execution generation before
resuming. Credentials and origin signing keys are not transferred.

Pi managed execution requires the configured npm installation's public SDK.
The SDK receives the target checkout explicitly; the original transcript
header remains unchanged during handoff. Native fork creates a new identity
and header recording the target Project, and the adapter verifies its parent reference and
that parent bytes were not modified. Ordinary Pi capture and background
Local Synthesis continue to use their separate integration paths.

Pi resume reads the verified transcript once from an opened regular file, then
starts the provider against an exclusively created copy in a private managed
session directory. That copy becomes the active transcript; provider migration
and append operations preserve the original transcript, including hard-linked
sources. The runner persists the private transcript identity before exposing a
resumed process, even when no new prompt follows. Later resumes atomically
replace that owned file with a freshly verified copy at the same path. This
keeps resume storage bounded and preserves external hard links to earlier
inodes. Unmarked source transcripts remain retained.

Runner-local checkout readiness and upstream start acknowledgement are separate
durable steps. Ready bindings remain discoverable until the authority has
released the start and the runner records acknowledgement. Retries verify the
existing checkout, including after runner restart. Pending assignments are
checked against current execution authority before preparation or fenced cleanup;
a stale local execution mirror cannot hide them from reconciliation.

Desktop shows the device switch control during startup, disabled until the
Conversation is ready. New Conversations show zero context usage until the
AI Client reports usage. Existing Conversations without a usage report do not
claim zero usage.

The Codex Transcript Watcher backs off repeated truncated or mutated source
ranges per file, from one second to a maximum of one minute. Filesystem hints
do not bypass this delay. Healthy files continue through normal capture. A
successful retry clears the backoff; retries never rewind captured cursors.

Codex startup emits `worker.managed_conversation.startup_stage` Worker events.
Each event includes the execution ID, generation, stage, status, stage duration,
and elapsed startup time in milliseconds. Stages separate protocol validation,
client initialization, thread opening, event flushing, capture registration,
startup event persistence, and resume or fork transcript reconciliation.
Failures report the stage before cleanup. These events contain no prompts,
message content, credentials, or local paths. Diagnostic failures do not stop
startup. Compare these timings with command creation and dispatch timestamps
to separate queue delays from runtime preparation.

Startup capture adapts buffered Codex events in provider order and sends them
through the existing byte- and item-bounded batch transport. Events leave the
buffer only after their batch succeeds. This reduces capture requests during
new launches and recovery without releasing prompts before startup capture.
Desktop recognises both `agent` capture events and `assistant` message events
when deciding whether the current response still needs an empty placeholder.
