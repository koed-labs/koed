# ADR 0032: AI Client Instance, Capability, And Permission Contracts

- Status: Accepted
- Date: 2026-08-18

Related decisions:

- [0001 AI Client Synthesis Only](./0001-ai-client-synthesis-only.md)
- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0025 MCP V2 Local AI Runtime Ownership](./0025-mcp-v2-local-ai-runtime-ownership.md)
- [0028 Claude Agent SDK Local Transport](./0028-claude-agent-sdk-local-transport.md)

## Context

Koed can use more than one supported AI Client and more than one local account
or installation of the same AI Client. Driver behavior, a configured local
installation, and observations from a running installation are different
facts. Treating them as one unbounded settings object would let callers invent
capabilities, leak local paths or account details to a renderer, and silently
degrade one permission model into a different one.

Codex, Claude Code, and Pi expose different native execution controls. Koed
needs stable product language without claiming parity where the underlying AI
Clients or Koed's interaction bridges differ.

## Decision

Koed separates three contracts:

1. An **AI Client Driver** is a Koed-owned adapter declaration. This build
   supports the `codex`, `claude`, and `pi` drivers.
2. An **AI Client Instance** is one configured installation/account boundary,
   identified by a stable instance id and one driver id. Built-in instances use
   `<driver>.default`; additional instances are configured in the owner-only
   local registry.
3. An **AI Client Capability Snapshot** is a time-bounded observation of one
   instance's version, authentication state, health, and models.

The API owns and derives the static driver capability declaration. A client
cannot submit or override it. The `koed-server`-supervised Local AI Runtime
reports bounded observations at startup and on a maintenance interval. An
expired or unhealthy snapshot cannot be treated as current capability.
Maintenance probing is not a renderer polling mechanism; interactive clients
consume normal Koed state and realtime delivery.

The local registry contains executable and optional configuration-home paths.
It is parsed strictly, accepts only drivers available in the current build,
requires canonical executable files and configuration directories, and rejects
unknown fields or duplicate instance ids. Local paths, configuration homes,
installation hashes, configuration hashes, account identity, and raw probe
errors remain inside the server/runtime boundary. Browser-visible API results
contain only the redacted instance descriptor and bounded snapshot.

Model observations use a strict schema: stable model id, bounded display
metadata, provenance, supported reasoning values, and explicit optional model
features. Arbitrary provider payloads are not persisted or returned.

Managed Conversation launch options are a redacted projection of the current
instance snapshots plus the current local runner identity. The projection is
the only supported source for Desktop selection. The submitted selection is
validated at the local edge, persisted as immutable execution configuration,
and resolved again by the execution runner. Hosted coordination may accept an
opaque, already locally validated instance id for a deferred local execution,
but it cannot reinterpret that id or claim local capabilities it cannot
observe.

## Capability Semantics

Each managed-Conversation capability is one of:

- `supported`: the current Koed driver implements and tests the behavior;
- `requires_bridge`: the AI Client can participate, but a required Koed
  interaction or streaming bridge is not complete, so the behavior must not be
  selectable yet;
- `unsupported`: no safe exact behavior exists in the current driver.

The declaration records provider-specific differences, including
interrupt support, approval and user-input bridges, transient output, file and
image attachment handling, model selection, and same-session model switching.
UI and runtime code consume the declaration instead of branching on product
names. Unknown drivers and capabilities fail closed.

The Codex driver supports command, file-change, and permission approvals,
structured User-input requests, active-turn interruption, and transient
assistant output through its supervised app-server bridge. Requests remain
execution-generation fenced and are answered through the owning User's
authenticated Koed surface. Claude Code uses SDK approval callbacks and text
deltas. Pi uses its native RPC events and an explicit tool-approval extension.
Each adapter is validated independently; one client's capabilities do not imply
another client's behavior.

## Permission Modes

Koed defines four AI Client-neutral execution modes:

- `supervised`: native approval requests are presented in the Conversation;
- `auto_edit`: routine workspace edits are pre-authorized, while other
  privileged actions still require approval;
- `auto`: the AI Client's automatic reviewer handles routine approvals;
- `full_access`: commands and edits run without permission prompts or an
  AI Client sandbox. This is the default for new Conversations.

Codex maps Supervised to `untrusted` plus `read-only`, Auto-accept edits to
`on-request` plus `workspace-write`, Auto to the same settings with
`approvalsReviewer: auto_review`, and Full access to `never` plus
`danger-full-access`. Other modes explicitly use the `user` reviewer so an
automatic reviewer cannot remain active after a mode change or resume.
Claude Code uses its default permission behavior, `acceptEdits`, `auto`, and
`bypassPermissions`, respectively. Full access explicitly enables the SDK's
bypass option. Planning is separate from permission policy.

Native requests use a shared approval UI, with provider-specific response
translation and session-scoped grants. Questions use the separate user-input
flow. A mapping marked `requires_bridge` or `unsupported` cannot be selected
by the execution runtime. Pi's managed bridge allows read tools in Supervised,
also allows write/edit in Auto-accept edits, asks the User in Auto, and allows
all tools in Full access. It does not claim native sandboxing or automatic
review.

An AI Client permission mode controls only the native AI Client process. It
cannot grant Koed authority, weaken an Action Grant tier, bypass Team or
Workspace authorization, override an execution lease or fencing generation,
expand Koed's file-service roots, or inject credentials. These Koed service
boundaries do not sandbox a Full access AI Client's shell commands: that
process operates with the runner account's operating-system access.

## Consequences

- Multiple accounts or installations can be represented without exposing
  their local secret-bearing configuration to Desktop or Explorer.
- Capability downgrade, probe failure, stale observations, and unavailable
  interaction bridges fail closed.
- New drivers require a reviewed static declaration, strict probe adapter,
  exact permission mappings, and conformance tests before the local registry or
  API accepts them.
- A declared permission mapping may exist before a later UI exposes it. The
  runtime still cannot use a `requires_bridge` mode until that bridge exists.
- Capability snapshots are operational observations, not durable proof that a
  future execution will succeed; execution repeats relevant readiness and
  authority checks.
- Resume and recovery use the execution's persisted instance, model,
  reasoning, permission, and runner selection. They do not fall back to newer
  environment defaults when the original selection is unavailable.
