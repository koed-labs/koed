# ADR 0024: Tiered Desktop Action Approval

- Status: Accepted
- Date: 2026-07-31

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

Every path retains exact action, body, target, Team or Workspace, device,
backend, request-hash, commitment, idempotency, expiry, single-use, audit, and
replay bindings. API Tokens never authorize these actions. Upstream device
credentials, browser cookies, activation URLs, Action Grant secrets, and
reusable authority remain outside renderer state. The backend repeats current
role, membership, Workspace Access, source-owner, expected-version, and policy
checks when the grant is consumed. Authority loss and backend changes fail
closed.

## Accepted Action Matrix

| Action                                | Tier                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `team.create`                         | Direct                                                                                            |
| `team.invite.accept`                  | Native review                                                                                     |
| `team.workspace.create`               | Direct                                                                                            |
| `team.invite.create`                  | Native review                                                                                     |
| `team.invite.revoke`                  | Native review                                                                                     |
| `team.member.role_update`             | Step-up for promotion to admin or owner; Native review for a privilege decrease                   |
| `team.member.disable`                 | Step-up                                                                                           |
| `team.leave`                          | Native review, with authoritative last-owner protection                                           |
| `team.workspace.archive`              | Native review                                                                                     |
| `team.workspace.restore`              | Direct                                                                                            |
| `team.workspace.access_update`        | Step-up when access expands or becomes disabled; Native review when write decreases to read       |
| `shared_memory.preview`               | Direct when the source-owner policy is unchanged; Step-up when it creates or replaces that policy |
| `shared_memory.consent`               | Bundled stage of the exact share or representation-change decision                                |
| `shared_memory.share`                 | Native review; Step-up when the selected representation is raw `memory_events`                    |
| `shared_memory.revoke`                | Native review                                                                                     |
| `shared_memory.change_representation` | Step-up when fidelity increases; Native review when it decreases                                  |
| `managed_conversation.handoff`        | Native review; Step-up for an untrusted or newly enrolled target                                  |
| `managed_conversation.fork`           | Native review; Step-up for an untrusted or newly enrolled target                                  |
| `conversation_source.discover`        | Direct only within an enrolled sync relationship; otherwise fail closed                           |
| `conversation_source.download`        | Bundled into an exact reviewed transfer/restore/sync; standalone downloads use Step-up            |
| `team.entitlement.update`             | Step-up                                                                                           |
| `team.billing_seats.update`           | Step-up                                                                                           |
| `team.retention.delete_request`       | Step-up                                                                                           |
| `team.legal_hold.place`               | Step-up                                                                                           |
| `team.legal_hold.release_request`     | Step-up                                                                                           |
| `team.legal_hold.release_confirm`     | Separate Step-up decision                                                                         |

The representation fidelity order is `lcm_rollups`, `lcm_leaves`, then
`memory_events`. Unknown actions, missing current state needed for a conditional
tier, and attempts to invoke Bundled stages outside their accepted workflow
fail closed.

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

Browser authentication remains the Step-up mechanism for this decision. It is
not reusable administrative authority, and browser-window closure is never the
signal that lets Desktop execute.
