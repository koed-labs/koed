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
