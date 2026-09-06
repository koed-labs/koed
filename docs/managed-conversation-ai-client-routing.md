# Managed Conversation AI Client Routing

Managed Conversation start requires an explicit AI Client driver and instance.
Desktop preserves the selected launch configuration across Project navigation.
Local authority and local-edge admission require an enabled instance with a
healthy, authenticated, fresh, identity-matched capability snapshot. Hosted
authority delegates deferred local execution readiness to the assigned Worker.
Missing or unavailable owners never fall back to another AI Client.

After API readiness, the supervisor resolves the active local API Token and
passes the same credential to the Worker and Local AI Runtime. This includes
credentials already stored under `KOED_HOME`, not only process-environment or
newly provisioned credentials.

Managed Codex and Claude Code launches register Koed's packaged stdio MCP Server
explicitly for the selected `KOED_HOME`; recall does not depend on global AI
Client configuration. Pi loads the Koed extension explicitly. These connections
use the Local AI Runtime and do not put API Tokens in AI Client configuration.
Desktop credentials include the distinct file, terminal, preview, and source-control
operation families; none grants an AI Client permission or a remote mutation approval.

The execution persists driver, instance, model, reasoning effort, permission
mode, and runner identity. These choices are immutable for that execution.
Runtime reuse requires the same execution generation and instance configuration
hash. Capture and Local Synthesis assignments are independent of this owner.

## Native adapters

| AI Client   | Managed runtime                             | Source and portability                                                                  |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Codex       | Native app-server protocol                  | Verified Codex transcript journal and native resume/fork                                |
| Claude Code | Official Claude Agent SDK                   | Isolated managed Session Store, verified source boundary, and SDK fork                  |
| Pi          | Installed public SDK with native RPC server | Pi v3 JSONL journal, explicit workspace-bound resume, and SDK `SessionManager.forkFrom` |

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
workspace before and after turns; restoring files does not rewind Conversation
history or implicitly grant AI Client permissions. Restore retains a recovery
checkpoint and publishes a completed workspace checkpoint and updated diff.
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
closure, workspace snapshot, and exclusive next execution generation before
resuming. Credentials and origin signing keys are not transferred.

Pi managed execution requires the configured npm installation's public SDK.
The SDK receives the target workspace explicitly; the original transcript
header remains unchanged during handoff. Native fork creates a new identity
and target-workspace header, and the adapter verifies its parent reference and
that parent bytes were not modified. Ordinary Pi capture and background
Local Synthesis continue to use their separate integration paths.
