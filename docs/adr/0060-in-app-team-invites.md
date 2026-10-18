# ADR 0060: In-App Team Invites

## Status

Accepted (decision D3, 18 October 2026). Under D5, Koed-hosted cloud is the
default Team backend for invitations and sharing.

Related decisions:

- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0057 Project-Backed Workspaces And Project Share Policy](./0057-project-backed-workspaces-and-project-share-policy.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [Personal Project identity](../personal-project-identity.md)
- [Project-sharing lifecycle](../project-sharing-lifecycle.md)
- [Team collaboration action credential matrix](../team-collaboration-action-credential-matrix.md)

## Context

Today, an enabled Team owner or admin creates an email-bound invitation. The
Team Backend stores the token hash, normalized recipient email, backend-origin
binding, expiry, and version. Desktop returns the opaque token once so the
inviter can share its link. The invitee pastes the link into **Join a Team**.
Acceptance checks the invite token and email, then atomically creates or
enables membership and initial Workspace Access. Outside the isolated
developer profile, Team administration requires a current verified external
identity. An enrolled-device path also requires the exact one-use Action Grant.

The redesign adds an in-app Accept / Decline card in Desktop. It must not turn
an invite ID into a bearer credential, reveal other people's invitations, or
replace the existing email, backend, expiry, identity, device, or action
approval checks. The copied-link path remains available.

## Decision

### Discover invitations for the enrolled recipient

Desktop reads `GET /v1/team-invites/mine` through the enrolled local edge using
the backend's `team_workspace_read` device capability. The request has no
caller-supplied email or Team filter. The Team Backend derives the recipient
from the authenticated User and returns only that User's invitations on this
backend.

Outside the explicitly enabled, isolated `developer` profile, discovery
requires a currently linked, verified external identity whose provider
environment is the one configured for this backend and whose verified email
matches the current Koed User email after normalization. The invite's
normalized recipient email and backend-origin binding must also match. A
missing, stale, unverified, or mismatched external identity fails closed and
returns no invitation data. The isolated developer profile retains only the
existing local-auth exception; the current Koed User email must still match the
invite. The invite is not shown if it is expired, no longer pending, revoked,
or its Team or target Workspace is inactive or no longer eligible for access.
Disabled or deleted Users receive no invitation data. The developer-only
local-auth exception is not available to managed or production Team
deployments.

The result contains only the display-safe fields needed to review each exact
invitation, including its identifier and version, Team and target Workspace
names, offered role, initial Workspace Access, the inviter's display name and
Agent display name, and expiry. At invitation creation, resolve the Agent name
from the approved inviter-owned Agent profile through the existing trusted
owner edge and bind it as display-only invitation metadata. The Team Backend
does not read the Personal database for it. It is not an Agent message or
input, and it grants no authority. When the invite is for a shared Project,
show that Project's name and the D1 summary-sharing notice before **Accept**.
Do not return the invite token, token hash, token-bearing URL, credential
material, or unrelated Team roster data. An invite identifier is a selector,
never authority. A recipient who is not enrolled may use the existing
copied-link flow through a fresh browser session if the current identity checks
pass. An unverified or mismatched external identity fails closed outside the
isolated `developer` profile, which retains only the existing local-auth
exception and still requires the account email to match the invitation.

Desktop presents eligible invitations in **Now → Needs you** with **Accept**
and **Decline** actions. The invitation card displays the authoritative scope
and access being offered; it does not infer authority from the inviter's
message or from local Project metadata.

### Accept with the existing security boundary

The copied-link path and `POST /v1/team-invites/accept` remain supported. For
an in-app decision, Desktop submits the exact invitation identifier and
version to the backend; it never fetches or stores the raw token. The
identifier selects a server-side invitation and is not sufficient to accept
it. The backend binds the decision to the authenticated recipient, the exact
normalized invite-email match, current backend, exact invitation and version,
and existing one-use action authority. Outside the explicitly enabled,
isolated `developer` deployment profile, the current linked verified external
identity must use the provider environment configured for that backend and
match the current Koed User email. Only that isolated developer profile keeps
the local-auth exception used by the existing acceptance route; the current
Koed User email must still match the invitation, and backend-origin, action,
and version checks still apply. This exception is unavailable to managed or
production Team deployments. The existing `team.invite.accept` approval tier
and its other requirements in ADR 0024 remain in force: Native review for the
enrolled-Desktop action, with any existing fresh-session or deployment
verification requirement preserved. Full access and agent intent cannot bypass
the recipient's decision.

The backend repeats the checks in the existing acceptance transaction:

- The invitation is pending, unexpired, at the expected version, and bound to
  this backend.
- The Team is active and eligible under current entitlement policy; its target
  Workspace is active and belongs to the Team.
- Current acceptance rejects every disabled membership. The D9 target
  exception below is limited to an exact `member_left` state with all required
  generation and membership-snapshot bindings. The User must be enabled, not
  deleted, and the current Koed User email must match the normalized recipient
  email. Outside the isolated `developer` profile, also require the current
  linked verified WorkOS/AuthKit identity, configured provider environment,
  and matching email.
- Existing enabled membership and Workspace Access rules are preserved.

Acceptance atomically marks the invitation accepted and applies membership and
initial Workspace Access, with the existing audit, outbox, and idempotency
behavior. If any check fails or the invitation changes while the user reviews
it, no partial membership or access is granted; Desktop re-reads the card from
authoritative state. A successful acceptance is not repeated by a retry.
The D3 target text command for a request such as "invite Ana to landing-site"
uses the existing `collaboration.create_invitation` preparation service and
opens the same invite-creation flow and exact Native review for
`team.invite.create` as the form. The invitation is issued only after the User
approves that review. A Koed tool or Agent may prepare the request but cannot
bypass or replace the approval. This ADR does not claim that freeform text
already routes to that service today.

### Return after voluntary Team leave (D9; implementation pending)

Current behavior rejects every disabled membership during invite review and
acceptance. It does not distinguish a voluntary leave from manager disablement.
D9 says leaving has no Undo and return requires a new invite. HQ-703 and HQ-704
must implement the target below; this ADR does not claim rejoining after leave
works today.

A new authorized invite may re-enable only a membership exactly in
`status = disabled` with `disabledReason = member_left`. It cannot override
manager-disabled membership, a disabled or deleted User, or any other disabled
state. First-time acceptance and existing enabled-membership rules stay intact.
The fresh invite grants only its stated role and initial Workspace Access. It
does not recreate old grants, restore old role/access or Project links, or
resume old Personal Conversation progress or Project Scheduled Jobs. Retained published
recall remains governed by current grants and Workspace Access; frozen grant
advancement never resumes.

Persist a durable leave generation on the Team/User membership lifecycle. It
starts at zero only when no prior leave is established, increments only in the
successful voluntary `team.leave` commit, and remains unchanged on invite
acceptance or manager disablement. Backfill existing `member_left` rows to a
positive generation. A missing row or historical value does not prove the User
never left; fail closed when prior leave history cannot be established. Do not
use timestamps as the authority boundary.

At invitation creation, resolve the addressed User from normalized email. For a
known User, immutably bind the exact recipient User ID and current generation.
If a membership row is disabled, also capture its exact version/status/reason;
that issuance snapshot is required for `member_left` rejoin. For a known User
with no membership row, bind the authoritative no-row state and generation zero
only when the backend establishes no prior leave; otherwise fail closed. An
unknown recipient retains the existing unbound first-invite flow. For an
enabled row without an issuance-time disabled-row snapshot, capture the
current exact membership version/status/reason at review. The renderer cannot
supply or change these bindings; changing an issuance binding requires
revocation and a new invite.

Native review and acceptance bind and recheck the exact invite version,
authenticated recipient, current generation, and membership state. For an
existing row, state means exact version/status/reason; for no row, it means the
authoritative absence of a row. The enrolled one-use review binds this state to
the approved operation, and acceptance must still match. Copied-link acceptance
keeps its fresh-session requirement and checks the same state atomically.

A `member_left` rejoin requires the invite's bound User ID and generation to
match the authenticated recipient and current generation, plus its issuance
snapshot to match the exact current disabled row. Missing or stale bindings
fail closed. Whenever present, an issuance-time membership snapshot must still
match at review and consumption, even if the row is now enabled; never replace
a stale snapshot with fresh review state. Thus, another invite captured against
the prior disabled version cannot restore old access after one invite succeeds.
Legacy or unbound invites cannot reactivate `member_left` or be used after the
leave generation advances, including for an enabled membership after rejoin.
The generation also blocks an old-email invite if the User changes email away
and back. A legacy first invite remains usable only when the recipient's
lifecycle is established as never-left.

HQ-704 must atomically revoke still-pending invitations in the exact Team whose
normalized recipient email matches the departing User's current normalized
email, increment their versions, and emit the existing invite-state
invalidation through the collaboration outbox. Other Teams' and recipients'
invites remain untouched. This same-Team cleanup is housekeeping, not the
authority boundary: User ID, generation, and membership version make stale
invites unusable even when an old email token survives. Failed, canceled,
denied, or incomplete leave changes neither generation nor invite state. The
recipient's `mine` list also filters invites whose recipient, generation, or
membership snapshot is stale.

Invite creation, acceptance, and leave serialize against the exact
Team/recipient lifecycle, including when no membership row exists. A pre-leave
invite carries the prior generation and becomes stale; a committed post-leave
invite captures the new generation and disabled membership version. At
consumption, recheck all bindings under that serialization. A race or changed
authority requires a new review; do not retry stale authority or partially
change membership/access.

HQ-703 must ship generation storage/backfill, the successful-leave increment,
and invite binding/review/acceptance enforcement as one deployable security
change. Do not enable the `member_left` exception or issue generation-bound
invites while any leave path can commit without advancing the generation.
Existing unbound invites remain compatible only for established first-time,
never-left membership; fail closed when generation is positive or prior leave
cannot be ruled out. HQ-704 adds the required same-Team invalidation and broader
leave lifecycle on top, preserving atomic generation updates and serialization.
Regression coverage groups backfill and failed-leave behavior, exact
recipient/generation/snapshot matching, manager/User-disabled rejection,
legacy and old-email stale invites, same-Team-only cleanup, create/accept/leave
races, and absence of partial membership or access changes.

### Decline as a versioned recipient decision

Add `declined` as an invitation lifecycle state. Only the authenticated
recipient whose current Koed User email matches the invitation may decline it
on the matching backend. Outside the explicitly enabled, isolated `developer`
deployment profile, require a currently linked, verified external identity
for the provider environment configured for that backend, with its email
matching the current Koed User email. Only that isolated developer profile
keeps the local-auth exception used by the existing acceptance route; it still
requires the exact account-email match and all invitation, backend-origin,
action, expiry, and version checks. This exception is unavailable to managed
or production Team deployments.

The backend binds the action to the exact invitation, current recipient,
backend, and expected version; it does not create membership or Workspace
Access. The current `team.invite.accept` action uses Native review. The target
`team.invite.decline` contract in the implementation-pending section of ADR
0024 also uses Native review. The Team Backend derives the recipient from the
current authenticated Koed User and binds approval and execution to that exact
still-pending, unexpired invitation at its expected version. The recipient
need not already be a Team member. Decline grants neither Team membership nor
Workspace Access. No separate browser Step-up or new notification channel is
introduced by D3.

A successful decline updates only a still-pending, unexpired invite at the
expected version, increments its version, writes a content-free audit record,
and emits the already-defined content-free in-app invitation-state invalidation
through the existing collaboration outbox path. The authorized inviter sees
the `declined` state in the existing invitation-management view. This updates
that view; it does not add email, push, or Agent-message notification channels.
The recipient's Now card is removed from the successful response or the next
authoritative refresh. Any realtime event is only an invalidation hint; it
contains no token and grants no authority.

Canceling a Native review leaves the invitation pending. Accept, Decline,
expiry, and inviter revocation race on the same pending state and expected
version. Exactly one transition may commit. A stale or lost race produces a
non-success result and Desktop re-reads authoritative state; it never reports
a rejected action as successful or silently performs the other action.
Replaying the same
approved operation returns its durable result without duplicating membership,
access, audit, or outbox effects. A new invitation is a separate record.

## Consequences

- Enrolled, verified recipients can find invitations without copying tokens.
- Email binding, backend binding, expiry, invite creation approval, recipient
  identity, and acceptance approval remain server-enforced.
- The in-app list cannot enumerate invitations for another email, Team, or
  backend. It exposes no reusable token.
- Decline is represented in the invitation lifecycle and is visible in the
  authorized inviter's existing invitation view through content-free in-app
  invalidation, without a new email, push, or Agent-message channel.
- Self-hosted and private-VPS backends remain supported advanced choices; the
  first-share and first-invite default is Koed-hosted cloud under D5.

## Implementation Boundary

This ADR records accepted behavior. It does not claim that the in-app list,
inviter Agent display metadata, recipient-ID decision path, Decline action,
`declined` lifecycle value, Now card, freeform text shortcut, or
generation-bound rejoin behavior exists today. The API and Desktop
implementation must preserve this contract and the existing token-based
acceptance path. The prototype's local Undo toast does not define a persisted
state-reversal contract; do not reopen a declined invitation unless a later
approved contract defines that operation.
