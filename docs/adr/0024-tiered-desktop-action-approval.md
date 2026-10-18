# ADR 0024: Tiered Desktop Action Approval

- Status: Accepted
- Date: 2026-07-31
- Last updated: 2026-08-10

## Context

Koed Desktop historically requested a browser-mediated Action Grant for every
protected collaboration mutation. That preserved strong credential isolation
and exact one-use authorization, but applied the same ceremony to read-like
preparation, reversible lifecycle actions, privilege changes, and destructive
governance. The result was both excessive friction and low-quality
confirmation: repeated generic prompts encouraged reflexive approval while the
human-readable context remained in Desktop.

The renderer, Electron main process/local edge, Team Backend, and browser have
different trust properties. A confirmation rendered by the same renderer that
initiated a request can prevent mistakes, but cannot stop a compromised
renderer. Browser authentication is an independent channel, but it is only
proportionate when a compromised renderer or stolen unlocked Desktop session
must not silently authorize the action.

## Decision

Koed separates exact Action Grant issuance from the User-facing approval
ceremony. The Team Backend assigns one of four tiers from an allowlisted action
and authoritative request state. The renderer and local edge may request an
exact action, but cannot select or downgrade its tier.

| Tier          | Authorizing component                                    | Security purpose                                                                                                             |
| ------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Direct        | Team Backend policy                                      | No second User decision. Suitable for explicit, additive, read-like, or restoring actions.                                   |
| Native review | Desktop renderer through the schema-validated local edge | Prevent accidental activation by reviewing an authoritative, display-safe summary. It is not a renderer-compromise boundary. |
| Step-up       | Fresh browser-authenticated User session                 | Independent User-presence proof for trust, privilege, access-removal, destructive, commercial, and governance actions.       |
| Bundled stage | Team Backend workflow                                    | Preserve a distinct validation and audit stage while consuming the one decision attached to its surrounding exact workflow.  |

Direct grants are issued immediately after the Team Backend validates the
device credential, operation family, authoritative tier, and exact request.
Native-review requests pause without an activation URL; Desktop displays the
backend-provided review and sends an exact approve or cancel decision through
the local edge. Step-up requests expose only a short-lived browser activation
URL and require a fresh browser session. Bundled stages cannot be requested as
standalone interactive approvals by supported Desktop callers.

The Team Backend API process serves the exceptional Step-up and device-
enrollment pages on the same public origin as the authoritative JSON and
authentication endpoints. These pages are a narrow browser bundle packaged
with `@koed/api`; they are not a separate application, service, or authority.
The API serves only backend-derived display-safe details, applies restrictive
browser security headers, and accepts decisions only through the existing
session-authenticated endpoints. An independently deployed Explorer or browser
client is not part of this architecture.

Every path retains exact action, body, target, Team or Workspace, device,
backend, request-hash, commitment, idempotency, expiry, single-use, audit, and
replay bindings. API Tokens never authorize these actions. Upstream device
credentials, browser cookies, activation URLs, Action Grant secrets, and
reusable authority remain outside renderer state. The backend repeats current
role, membership, Workspace Access, source-owner, expected-version, and policy
checks when the grant is consumed. Authority loss and backend changes fail
closed.

## Accepted Action Matrix

| Action                                     | Tier                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `team.create`                              | Direct                                                                                                         |
| `team.invite.accept`                       | Native review                                                                                                  |
| `team.workspace.create`                    | Direct                                                                                                         |
| `team.invite.create`                       | Native review                                                                                                  |
| `team.invite.revoke`                       | Native review                                                                                                  |
| `team.member.role_update`                  | Step-up for promotion to admin or owner; Native review for a privilege decrease                                |
| `team.member.disable`                      | Step-up                                                                                                        |
| `team.leave`                               | Native review, with authoritative last-owner protection                                                        |
| `team.workspace.archive`                   | Native review                                                                                                  |
| `team.workspace.restore`                   | Direct                                                                                                         |
| `team.workspace.access_update`             | Step-up when access expands or becomes disabled; Native review when write decreases to read                    |
| `shared_memory.candidate_preview`          | Direct; validates destination and policy for a bounded local candidate without starting sync                   |
| `shared_memory.preview`                    | Direct; persists an owner-private policy proposal and preview but activates no Workspace access                |
| `shared_memory.pending_share`              | Native review for derived representations; Step-up for raw `memory_events`; acceptance creates a Pending Share |
| `shared_memory.revoke`                     | Native review                                                                                                  |
| `shared_memory.change_fidelity`            | Step-up when fidelity increases or Curated Memory is enabled; Native review when fidelity decreases            |
| `shared_memory.conversation_source_grant`  | Step-up because it exposes exact source records independently of semantic fidelity                             |
| `shared_memory.conversation_source_revoke` | Native review                                                                                                  |
| `managed_conversation.handoff`             | Native review; Step-up for an untrusted or newly enrolled target                                               |
| `managed_conversation.fork`                | Native review; Step-up for an untrusted or newly enrolled target                                               |
| `conversation_source.discover`             | Direct only within an enrolled sync relationship; otherwise fail closed                                        |
| `conversation_source.download`             | Bundled into an exact reviewed transfer/restore/sync; standalone downloads use Step-up                         |
| `team.entitlement.update`                  | Step-up                                                                                                        |
| `team.billing_seats.update`                | Step-up                                                                                                        |
| `team.retention.delete_request`            | Step-up                                                                                                        |
| `team.legal_hold.place`                    | Step-up                                                                                                        |
| `team.legal_hold.release_request`          | Step-up                                                                                                        |
| `team.legal_hold.release_confirm`          | Separate Step-up decision                                                                                      |

## Intended Project Sharing and Lifecycle Action Matrix (Implementation Pending)

The following exact allowlisted action names and tiers are the target contract
for Project sharing and lifecycle work. They do not mean that the actions,
endpoints, or APIs exist today. As with the accepted matrix above, the Team
Backend selects the tier from the allowlisted action and authoritative state;
callers cannot select or downgrade a tier. Bind every request to the exact
User, source owner, Team, Workspace, resource identity, destination when
present, expected version, request hash, idempotency key, expiry, and
single-use authority.

Local Personal Project and Conversation commands are not Team actions. Their
owner controls them locally and does not need Team enrollment or browser
approval. If a local command affects existing Team grants, it must obtain the
source owner's separate approval for each required exact-grant freeze through
`shared_memory.grant.freeze` and wait for those Team operations before reporting
completion. It cannot invoke or impersonate a Team lifecycle action.

| Exact action                                             | Tier          | Authority and effect boundary                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_project.delete`                               | Step-up       | Exact Workspace Project owner with current Team membership and Workspace authority; delete shared Project metadata without archiving its Workspace or revoking grants.                                                                                     |
| `workspace_project.member_remove`                        | Step-up       | Workspace Project owner with current Team membership and Workspace authority; disable only the named member's access to this Project, never global Team Membership.                                                                                        |
| `workspace_project.leave`                                | Step-up       | Self-service only for a current non-owner member with Workspace Project access; reject the Workspace Project owner. Disable only the caller's access and freeze only their affected grants. It does not change Team Membership or another member's access. |
| `project_source.team_metadata.delete`                    | Step-up       | Source uploader or Workspace Project owner with current authority; delete Team metadata only, not the owner's Personal Note content.                                                                                                                       |
| `shared_memory.grant.freeze`                             | Native review | Exact source owner and one exact Share Grant; pin published authorization without revoking the grant or changing consent.                                                                                                                                  |
| `project.lifecycle.freeze_grant`                         | Bundled stage | Backend-only substage of the exact outer lifecycle action; inherits its target, authority, request binding, and approval. It cannot be requested as a standalone action.                                                                                   |
| `shared_memory.project_share_policy.enable`              | Native review | Review summary-sharing disclosure and bind a versioned policy plus a bounded manifest built by the source owner's trusted local edge from authoritative local capture and Project state; it never shares another member's sources.                         |
| `shared_memory.project_share_policy.revoke`              | Native review | Exact source owner and current policy version; disable future policy-based grant issuance. Existing Share Grants continue under their own consent and lifecycle unless separately frozen or revoked.                                                       |
| `shared_memory.project_share_policy.apply_session_grant` | Bundled stage | Backend-only stage under one current policy version; one-use exact per-grant backend authority for one eligible Captured Session, never a reusable UI Action Grant or generic pending-share approval.                                                      |
| `workspace_project.restore`                              | Direct        | Only the Workspace Project owner with current Team membership and Workspace authority; restores Team metadata only and does not restore another User's Personal records or resume grants.                                                                  |
| `project_source.team_metadata.restore`                   | Direct        | Source uploader or Workspace Project owner with current authority; restores Team metadata only. Personal Note content remains restorable only by its owner.                                                                                                |

### Target initial Curated Memory approval (Implementation Pending)

The accepted matrix above records current `shared_memory.pending_share`
behavior. Before the redesign's Curated-sharing policy ships, strengthen
initial `shared_memory.pending_share` tier selection. The target tier is Native
review for derived representations that do not enable Curated Memory, and
Step-up when the initial Pending Share enables `curated_assertions` or shares
raw `memory_events`. Every initial Curated activation requires its own
disclosure and Step-up; Full access does not bypass the requirement. This is a
target contract, not a claim that this policy is already implemented.

### Target Project Share Policy consent and per-session authority (Implementation Pending)

The actions above are target policy, not current routes or behavior. Each
member enables summary sharing for only their own sources through the explicit
Native-review `shared_memory.project_share_policy.enable` action. Its reviewed,
versioned consent is separate from the expiring, single-use UI Action Grant
that records that decision. Bind consent to the source owner, the currently
enrolled source-owner device credential generation and backend origin, Team,
Workspace, exact Workspace Project, the owner's exact Personal Project, and
fidelity `lcm_leaves`. It excludes `curated_assertions`, raw `memory_events`,
and Conversation Source Access. Full access and another member's policy cannot
authorize these sources.

When the owner enables the policy, the owner's trusted local edge builds a
bounded manifest from authoritative local capture and Project state for the
currently eligible Captured Sessions whose Conversations are already
associated with the exact shared Project. Native review binds consent to that
manifest. It contains each exact Session ID, its source revision, trusted
Conversation-to-session mapping revision, and approved summary scope. The
renderer cannot supply or alter the authoritative set. The Team Backend
validates authenticated source-owner/device provenance, exact Project link,
current policy scope, and source/mapping versions; the remote Team Backend
never reads the owner's Personal database. It creates a separate Share Grant
for each Session through the Bundled
`shared_memory.project_share_policy.apply_session_grant` stage, using a fresh,
one-use backend authority bound to that exact Session and policy scope. If the
set or any bound source or mapping revision changes before execution, the
initial batch conflicts and requires new review; it must not widen or backfill
a different set.

While the versioned policy remains active, the Team Backend may use that same
Bundled stage for each newly captured eligible source whose Conversation is
already associated with the exact shared Project at capture time, with a
separate fresh, one-use backend authority bound to one exact owner-owned
Captured Session.
This backend authority is not exposed to the renderer and cannot authorize
another source, action, destination, or later operation. The Backend verifies
the current owner and device association, backend origin, Team membership and
Workspace Access, Project link, policy version and scope, and trusted mapping
from the owner's Conversation to that exact Captured Session before issuing
and again before consuming authority. It derives eligibility from
authenticated capture and trusted source association; a renderer-supplied
path, Project flag, or arbitrary source ID is not authority. This is a
separately allowlisted stage, not generic reuse of or a bypass around
`shared_memory.pending_share`; that action keeps its accepted tier for ordinary
exact shares. Once created, a Share Grant remains bound to its exact Captured
Session and follows its own grant consent and lifecycle for future revisions.

Moving an existing Conversation into the shared Project after policy enablement
does not add its already-captured Sessions to the reviewed initial set or make
them eligible for future policy issuance; sharing each requires a separate
exact source-sharing confirmation. A missing or ambiguous
Conversation-to-session mapping, including multiple candidate sessions, fails
closed.

The source owner may disable this durable policy with the exact
Native-review `shared_memory.project_share_policy.revoke` action bound to the
current policy version. Revocation prevents future policy-based grant
issuance only. Existing Share Grants continue to advance under their own exact
grant consent and lifecycle; policy revocation does not change their state,
consent, advancement, or published evidence. Freezing or revoking an
individual grant to stop advancement or remove access remains a separate
explicit action. Credential rotation or re-enrollment, backend change, source
owner change, Project-link change, mapping change, or scope mismatch fails
closed and requires new reviewed consent; authority is never migrated
automatically. Making a source private, moving or deleting it, or freezing or
revoking its grant invalidates its policy eligibility. Restoring, rejoining, or
moving it back cannot recreate or restart a frozen or revoked grant; a fresh
source/share decision is required.

Implementation must include regression checks that reject another member's
source, stale or revoked policy versions, changed device/backend/Project scope,
renderer-selected source identifiers, ambiguous mappings, and a source whose
grant is frozen or revoked. A changed initial set or source/mapping revision
before execution must conflict and require new review, without partial
execution or wildcard backfill. A Conversation moved into the Project after
policy enablement must not make its existing Sessions eligible. Each rejection
must create no new grant and no Team-visible revision.

`project.lifecycle.freeze_grant` is permitted only inside an exact parent
operation such as `workspace_project.delete`,
`workspace_project.member_remove`, `workspace_project.leave`,
`project_source.team_metadata.delete`, `team.leave`, `team.member.disable`, or
the Step-up `team.workspace.access_update` path that disables access. The last
of these remains for an authorized workspace manager; self-service Project
leave uses `workspace_project.leave`. A lifecycle freeze runs only as a
Team-authoritative stage. It receives no independent approval because it is a
required stage of that already approved operation. Its freeze remains
grant-specific and cannot change an unrelated Share Grant or Cross-Identity
Sync relationship.

This target matrix does not change the accepted/current `team.leave` Native
review tier or its authoritative last-Team-owner guard. The conditional target
below does not change current behavior. It also does not weaken
`team.workspace.access_update`: access expansion or disablement remains
Step-up. Workspace restoration, Team membership, invitations, and Team-governed
access recovery continue to use the existing Team actions and authority checks;
a Project owner cannot restore Team membership or another User's Personal
resource.

### Target Team leave escalation for owner-owned Projects (Implementation Pending)

The accepted action matrix above records current behavior: `team.leave` uses
Native review. In the target lifecycle, a leave with no Workspace Projects
owned by the departing member keeps Native review. If current server-side
preflight finds one or more owner-owned Workspace Projects that would be
deleted, `team.leave` requires Step-up before any copy-back, tombstone, or
destructive change. The browser review binds the exact Team and membership
version, the complete current set of owned Workspace Project IDs and versions,
and all associated copy-back, tombstone, and removal effects. This conditional
Step-up is as strong as the separate `workspace_project.delete` review; a
Native `team.leave` grant cannot authorize or smuggle Project deletion.

The Team Backend checks last-Team-owner eligibility before any destructive
work, then derives the owned-Project set and exact versions. It repeats both
checks when consuming the Step-up authority. Any membership, ownership, set,
version, or authority change invalidates the approval and returns a conflict;
there is no automatic retry or copy-back under stale authority. The user must
review a new exact operation. The Step-up covers only the exact current leave
and deletion set, not wildcard Project authority. Ordinary non-owner leave
remains Native review. This target condition does not alter the accepted
matrix or claim that conditional escalation is implemented.

The representation fidelity order is `lcm_rollups`, `lcm_leaves`, then
`memory_events`. Unknown actions, missing current state needed for a conditional
tier, and attempts to invoke Bundled stages outside their accepted workflow
fail closed.

A Shared Memory preview may bind an exact proposed source-owner policy version
into its immutable artifact, but preview creation does not activate that policy,
pause consent, or invalidate a Share Grant. The final reviewed share or
representation-change bundle revalidates and activates the exact proposal in
the same database transaction as consent and grant mutation. A stale proposal
fails closed. This keeps source review Direct while retaining atomic policy
effects at the User's one meaningful sharing decision.

For managed Conversation transfer, a target becomes established 24 hours after
its oldest active credential was enrolled. The credential must be active for
both sync and managed execution, resolve to exactly one protocol deployment,
and differ from the current runner device. Missing or ambiguous device state is
untrusted and therefore uses Step-up.

## Threat Model

- **Accidental activation:** Native review and Step-up both address it; Direct
  is reserved for controls whose explicit activation is proportionate.
- **Malicious remote content:** Remote content cannot select a tier or supply
  trusted review copy. Display summaries are derived or allowlisted by the
  backend and are bound to the exact request.
- **Compromised renderer:** It may approve Native review, because that tier is
  deliberately not a separate security boundary. It cannot receive secrets or
  silently authorize Step-up.
- **Stolen unlocked device:** Device possession can perform Direct and Native
  actions within the enrolled credential's operation families. Step-up actions
  require a fresh independent browser session.
- **Compromised enrolled device:** Exact grants, narrow operation-family
  credentials, expiry, one-use execution, authoritative revalidation, and audit
  limit the device. The device cannot choose a weaker tier or mint Step-up
  authority.

## Consequences

Koed gains a second device-authenticated decision route and persists the
backend-selected tier plus display-safe review alongside the exact grant
binding. Desktop gains a reusable accessible Native-review surface. Remaining
browser pages become exceptional, action-specific Step-up surfaces.

Ordinary renderer Native review does not protect against renderer compromise.
If Koed later adds native OS authentication, Electron main or another trusted
local component must own the challenge and result. That future change may move
selected actions to stronger confirmation without changing exact Action Grant
execution semantics.

Browser authentication remains the Step-up mechanism for this decision. The
API-hosted page uses a validated relative authentication return path, so the
session cookie and decision stay same-origin. It is not reusable administrative
authority, and browser-window closure is never the signal that lets Desktop
execute.

The activation read requires the same fresh browser authentication as the
decision write. A stale session therefore shows authentication before any
actionable approval controls, rather than accepting a click and requesting
sign-in afterward.
