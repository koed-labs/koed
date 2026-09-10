# Managed Conversation AI Client Routing

Managed Conversation start requires an explicit AI Client driver and instance.
Desktop preserves the selected launch configuration across Project navigation.
Local authority and local-edge admission require an enabled instance with a
healthy, authenticated, fresh, identity-matched capability snapshot. Hosted
authority delegates deferred local execution readiness to the assigned Worker.
Missing or unavailable owners never fall back to another AI Client.

The managed Conversation worker marks its API traffic with the fixed
`x-koed-request-class: managed-conversation` header. Memory reads, memory writes,
and source-journal requests use separate buckets from background ingestion.
Each bucket retains its configured limit and authenticated User identity.
The header selects a bounded traffic class. It does not bypass authentication
or rate limits. Background ingestion cannot exhaust these Conversation budgets.
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
Desktop opens the Project Conversation detail after the first prompt enters the
managed queue. It retains stable launch and message identities during uncertain
responses, so recovery does not create a second execution or prompt. After the
first message is accepted, Desktop stores a bounded recovery record in its
encrypted, owner-scoped secret store. A restart can restore the provisional
Conversation before capture has supplied its canonical session identity.

An Independent launch uses an owner-local Independent Project for navigation.
The API creates a separate Koed-owned working directory for each execution. A
later resume uses the persisted runtime binding for that directory. Repository
features remain subject to their capability checks.

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
