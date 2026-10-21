# Koed text command actions

Managed Codex, Claude, and Pi Conversations can request Koed actions through
bounded MCP tools. A tool response means **requested**. It does not grant the
AI Client a Project, chat, or Personal Memory write credential and does not
assert that the action succeeded.

The local worker forwards a request only while its exact command lease is
current. The Personal API checks the authenticated owner, execution,
generation, leased command, and an immutable human-origin receipt created with
the original HQ first message or Desktop prompt. Synthetic catch-up commands
and unbound Scheduled Job prompts cannot create action requests. The ledger
encrypts the arguments and current target snapshot, binds the provider turn
and tool call, and admits a given tool call once. Changing arguments on retry
is a conflict.

Koed applies the same permission mode and service used by each supported
button. Project creation and chat moves require an action card in Ask First;
Full Access skips that card within its existing scope. Project and chat
deletion always use their separate Native review. To-do add/send and local
HQ/Settings actions use their existing button policy. Before dispatching an
effect, Koed claims its exact ledger revision and checks the target again.
An action reviewed after the AI Client turn completes remains usable only when
the originating command has a verified completed state and its immutable
human-origin receipt still matches. An active turn must retain its lease.
After an uncertain response it reads only the exact service receipt and never
automatically repeats the effect. The User can inspect the claimed state.
For a reloaded durable action, **Check result** reads only the latest exact
receipt and can mark it applied; it never claims or dispatches again. A
missing receipt stays uncertain. Local-only UI actions have no such receipt
recovery path.
Personal Project and to-do creation write an action-specific receipt in the
same database transaction as the new record. An ordinary button request with
the same idempotency key cannot be adopted as a text-action result. The local
Desktop credential is required for these optional text-action request fields;
ordinary button requests keep their existing contract.

The current action family covers Personal Project creation/deletion, chat
move/deletion, to-do add/send, and HQ/Settings controls. For a linked Project,
to-do add/send rechecks the exact enrolled Team principal, Project membership,
write access, versions, and Personal link before use. The Team create uses an
optional compare-and-swap that preserves existing button requests. A private
action receipt distinguishes a text-command dispatch from a concurrent button
dispatch with the same Work Item key. Team to-do creation goes through the
Personal coordinator's claimed action and sealed Team device credential. An
encrypted 256-bit nonce is minted once with the private claim and is never
returned to the renderer or AI Client. The Team write stores only its hash in
the exact member/action/item receipt. Personal completion compares that hash
to its private nonce, so an ordinary item, guessed nonce, or same-UUID Team
write cannot be credited as this action. Team still enforces current member
write access and version checks; it does not read the Personal action ledger.
Moving a chat out of a shared Project uses the existing Project-policy move
journal. It binds each requested session to the exact text action and Native
grant-freeze batch; placement and the action-specific receipt commit together
only after the original grant manifest is frozen and the source Project,
Conversation, target, and assignment versions still match. The existing
button does not allow a move into a linked Project, so the tool does not grant
that path. A lost response can look up and continue only a previously prepared
batch; it never prepares another batch on restart. For a multi-chat request,
Koed requires a receipt for every pinned session before showing the action as
done. A missing batch or partial result remains visible as uncertain.
The `koed_chat_create` tool uses the existing new-chat UI
operation: it opens a blank composer with the requested Project selected and
returns the typed `opened_composer` outcome. No Conversation is reported as
persisted until the User sends a first message. A hidden Conversation's request waits for its HQ action
surface to mount. Scheduled Job text effects require the future exact attempt
and current job authority adapter. Invite, sharing, leave, Scheduled Job, and
flashcard tools belong to their respective feature tickets and are not
published by this action family.

The owner-private action ledger is introduced by the additive HQ-504 schema
migration. The migration must preserve owner-forget cascade while rejecting
direct rewrites of action identity, encrypted payload, human-origin receipt,
or review binding.
