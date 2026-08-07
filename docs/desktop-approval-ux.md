# Desktop Approval UX

## Status And Scope

This document originated as a discussion proposal for approval UX in Koed
Desktop. The tiered authority protocol, Native review, Direct grants, bundled
Shared Memory decisions, and Step-up terminal handoff are now implemented.
The inventory and discussion below preserve the design rationale and may still
describe the pre-migration blanket-browser behavior as historical context.

The security decision is now accepted in
[ADR 0024](adr/0024-tiered-desktop-action-approval.md). Where provisional text
or open questions in this proposal differ from the ADR, the ADR and the
implemented backend-owned tier matrix are authoritative.

## Problem Statement

Koed currently sends every Desktop collaboration action classified as
high-risk through the same approval sequence:

1. Desktop requests an exact Action Grant through the local edge.
2. Koed opens the Team Backend approval page in the system browser.
3. The User authenticates if the browser session is not fresh.
4. The User approves or denies the exact mutation.
5. Desktop waits for the result, consumes the one-use Action Grant, and
   reconciles the authoritative result.

This creates a strong separation between an enrolled local device and the
User's browser-authenticated session. It also binds approval to the device,
backend, action, target, scope, request, and expiry instead of giving Desktop
reusable administrative authority.

The problem is that the same ceremony is applied to ordinary, reversible, and
read-like actions as well as destructive or authority-changing actions. The
result is disproportionate friction:

- routine Team setup opens the browser repeatedly;
- changing a select control, such as a member role or Workspace Access level,
  can immediately start an external approval flow;
- the Shared Memory workflow requires separate approval for preview, consent,
  and the resulting Share Grant;
- a first-time share therefore requires three browser round trips;
- changing a Shared Memory representation also requires three browser round
  trips;
- the rich review context remains in Desktop, while the browser page generally
  shows generic action copy and raw identifiers;
- after a decision, the external page remains open without a sufficiently
  prominent handoff back to Desktop or clear instruction that it is safe to
  close the window; and
- Managed Conversation and source-replication approvals fall back to generic
  browser copy rather than describing the exact User-facing operation.

This is both a usability problem and a confirmation-quality problem. Frequent,
low-value prompts train Users to approve reflexively, while the external page
does not always present enough human-readable context to justify the context
switch.

## Security Invariants To Preserve

Changing the approval UX should not mean giving the renderer credentials or
unbounded authority. Unless the threat model is deliberately changed, the
following properties should remain:

- API Tokens do not authorize Team administration or browser activations.
- Upstream device credentials, browser cookies, approval URLs, and Action Grant
  secrets do not enter renderer state.
- Every protected mutation remains bound to its exact action, body, target,
  Team or Workspace scope, enrolled device, Team Backend, and idempotency key.
- Authorization remains short-lived, one-use, auditable, and replay-safe.
- Role, membership, Workspace Access, and source-owner checks are enforced by
  the authoritative backend at execution time.
- Authority loss, backend changes, stale versions, and expired grants continue
  to fail closed.
- A native confirmation shown by the same renderer is treated as protection
  against mistakes, not as an independent security boundary.

The Action Grant mechanism and the User-facing approval ceremony should be
treated as separate design concerns. Koed can preserve exact one-use grants
without necessarily requiring a separate browser interaction for every grant.

## Proposed Approval Tiers

The inventory below uses four provisional tiers:

| Tier              | User experience                                                                                                                        | Intended use                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Direct**        | Execute from the explicit Desktop control without a second confirmation.                                                               | Read-like, additive, routine, or easily reversible actions.                                                                 |
| **Native review** | Show a human-readable review or destructive confirmation in Desktop. No separate authentication.                                       | Meaningful but expected actions where accidental activation is the main risk.                                               |
| **Step-up**       | Require independent proof of User presence, preferably native OS authentication with browser authentication as a fallback.             | Trust establishment, privilege escalation, access removal, destructive administration, or other authority-changing actions. |
| **Bundled stage** | Keep the stage as an internal protocol or audit boundary, but do not prompt independently. Bind it into one surrounding User decision. | Multi-step workflows where separate prompts do not represent separate User decisions.                                       |

The tier is a product and threat-model decision. It does not determine whether
the backend still issues an exact Action Grant.

## Live Desktop Action Inventory

All 18 actions in this table are reachable from current Desktop UI paths and
currently require an independent browser-mediated Action Grant.

| Area                     | User-facing action                             | Desktop intent                                      | Backend action                        | Current behavior | Proposed tier      | Notes                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------- | ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team setup               | Create a Team                                  | `collaboration.create_team`                         | `team.create`                         | Browser approval | **Direct**         | Additive and initiated from an explicit creation form. Backend validation and exact grant binding should remain.                                                                                                    |
| Team setup               | Join a Team                                    | `collaboration.join_team`                           | `team.invite.accept`                  | Browser approval | **Native review**  | Show the Team identity, expected membership, and initial Workspace Access before accepting the invitation.                                                                                                          |
| Team setup               | Create a Workspace                             | `collaboration.create_workspace`                    | `team.workspace.create`               | Browser approval | **Direct**         | Additive and reversible through archive.                                                                                                                                                                            |
| Invitations              | Create an invitation                           | `collaboration.create_invitation`                   | `team.invite.create`                  | Browser approval | **Native review**  | Review recipient, role, default Workspace, access, and expiry in the existing form before issuing.                                                                                                                  |
| Invitations              | Revoke an invitation                           | `collaboration.revoke_invitation`                   | `team.invite.revoke`                  | Browser approval | **Native review**  | Prevents future use but does not remove an existing member.                                                                                                                                                         |
| Membership               | Change a member role                           | `collaboration.update_member_role`                  | `team.member.role_update`             | Browser approval | **Risk-sensitive** | Use **Step-up** when promoting to admin or owner. A demotion may need only **Native review**, subject to governance policy.                                                                                         |
| Membership               | Disable a member                               | `collaboration.disable_member`                      | `team.member.disable`                 | Browser approval | **Step-up**        | Removes current Team access and can interrupt active work.                                                                                                                                                          |
| Membership               | Leave a Team                                   | `collaboration.leave_team`                          | `team.leave`                          | Browser approval | **Native review**  | Clearly state loss of Team access. Existing last-owner protection remains mandatory.                                                                                                                                |
| Workspace administration | Archive a Workspace                            | `collaboration.archive_workspace`                   | `team.workspace.archive`              | Browser approval | **Native review**  | Changes availability but is reversible. Show affected Workspace and consequence.                                                                                                                                    |
| Workspace administration | Restore a Workspace                            | `collaboration.restore_workspace`                   | `team.workspace.restore`              | Browser approval | **Direct**         | Reverses archive and restores normal availability.                                                                                                                                                                  |
| Workspace administration | Change Workspace Access                        | `collaboration.set_workspace_access`                | `team.workspace.access_update`        | Browser approval | **Risk-sensitive** | Prefer a draft-and-save access editor. Use **Step-up** for material access expansion or removal; avoid opening a browser directly from each select change.                                                          |
| Shared Memory            | Prepare a source preview                       | `collaboration.preview_shared_memory`               | `shared_memory.preview`               | Browser approval | **Direct**         | Read-like preparation for the source owner. It creates neither consent nor a Share Grant.                                                                                                                           |
| Shared Memory            | Record sharing consent                         | `collaboration.consent_shared_memory`               | `shared_memory.consent`               | Browser approval | **Bundled stage**  | Preserve the consent record, but bind it to the single final sharing review instead of prompting separately.                                                                                                        |
| Shared Memory            | Share Memory with a Workspace                  | `collaboration.share_memory`                        | `shared_memory.share`                 | Browser approval | **Native review**  | One exact review should show source, Team, Workspace, representation, mode, and expiry, then create consent and the Share Grant as one User decision. Policy may elevate unusually sensitive shares to **Step-up**. |
| Shared Memory            | Revoke a Share Grant                           | `collaboration.revoke_shared_memory`                | `shared_memory.revoke`                | Browser approval | **Native review**  | Removes ordinary Team recall of the source without deleting Personal Memory.                                                                                                                                        |
| Shared Memory            | Change the shared representation               | `collaboration.change_shared_memory_representation` | `shared_memory.change_representation` | Browser approval | **Risk-sensitive** | Use one review. Moving to a more detailed representation may require **Step-up**; reducing detail should need only **Native review**. Consent remains an exact bundled record.                                      |
| Managed Conversations    | Move a Conversation to another Personal Device | `collaboration.managed_conversation_handoff`        | `managed_conversation.handoff`        | Browser approval | **Native review**  | Show both devices and explain that the current device stops writing after the verified handoff boundary. Consider **Step-up** if the target device is newly enrolled or the source is unusually sensitive.          |
| Managed Conversations    | Fork a Conversation on another Personal Device | `collaboration.managed_conversation_fork`           | `managed_conversation.fork`           | Browser approval | **Native review**  | Show both devices and explain that the original Conversation continues independently.                                                                                                                               |

### High-Friction Composite Workflows

| Workflow                                                     |                                                                                            Current browser approvals | Proposed experience                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-time Shared Memory share                               |                                                                                           3: preview, consent, share | Preview directly, then one exact native review for consent plus Share Grant.                                                                                           |
| Change Shared Memory representation                          |                                                                           3: preview, consent, representation change | Preview directly, then one exact review; require step-up only when policy or increased detail warrants it.                                                             |
| Move or fork a Conversation when source transfer is required | At least 1 explicit transfer approval, with source-download authorization also represented by the high-risk protocol | One User decision should authorize the exact transfer and its required source download rather than creating a second interactive decision for an implementation stage. |
| Edit several members' Workspace Access                       |                                                               One browser flow per immediately applied select change | Edit a draft access matrix, review the diff, and submit one bounded batch or a deliberate sequence.                                                                    |

## Additional High-Risk Protocol Actions

These eight backend actions use the same high-risk protocol but are not ordinary
actions in the current Desktop collaboration UI.

| Area                      | Backend action                    | Purpose                                                                                           | Current approval model        | Proposed direction                                                                                                                                          |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commercial administration | `team.entitlement.update`         | Change the Team entitlement and access state.                                                     | Browser approval              | Retain **Step-up**. Present the resulting access impact clearly.                                                                                            |
| Commercial administration | `team.billing_seats.update`       | Change the Team billing-seat policy.                                                              | Browser approval              | Retain **Step-up**. Browser authentication may remain appropriate for account and billing administration.                                                   |
| Retention                 | `team.retention.delete_request`   | Start governed Team deletion.                                                                     | Browser approval              | Retain strong **Step-up**, explicit consequence review, and any required delay or dual-control policy.                                                      |
| Retention                 | `team.legal_hold.place`           | Place selected Team data under legal hold.                                                        | Browser approval              | Retain strong **Step-up** and governance-specific review.                                                                                                   |
| Retention                 | `team.legal_hold.release_request` | Start governed legal-hold release.                                                                | Browser approval              | Retain strong **Step-up** and the existing multi-stage governance boundary.                                                                                 |
| Retention                 | `team.legal_hold.release_confirm` | Complete governed legal-hold release.                                                             | Browser approval              | Retain strong **Step-up**; do not collapse request and confirmation into one decision.                                                                      |
| Source replication        | `conversation_source.discover`    | Discover available conversation sources from an enrolled backend.                                 | Browser-mediated Action Grant | Prefer policy-bound authorization from the enrolled sync relationship. Source discovery should not normally be a standalone interactive prompt.             |
| Source replication        | `conversation_source.download`    | Authorize an exact source generation download to an enrolled target deployment and recipient key. | Browser-mediated Action Grant | Bundle into the reviewed handoff, fork, restore, or sync operation when possible. Use independent **Step-up** only for standalone or exceptional downloads. |

## Other Approval And Confirmation Surfaces

These flows are related to the discussion but are not part of the recurring
Desktop collaboration Action Grant list.

| Flow                                      | Current surface                                        | Recommendation                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enroll the local edge with a Team Backend | One-time browser approval                              | Retain strong browser or equivalent step-up. This establishes reusable device trust and operation families. Improve human-readable device and backend details where needed. |
| Pair another Personal Device              | Native Desktop comparison-code approval                | Retain. The code comparison and explicit approval are proportionate to establishing a new Personal Device relationship.                                                     |
| Save the Personal Device recovery kit     | Native save flow plus explicit saved-code confirmation | Retain. Losing the recovery material has significant consequences.                                                                                                          |
| Apply first-run local setup               | Native Desktop confirmation                            | Retain as a single confirmation before Koed performs incomplete setup stages.                                                                                               |
| Remove a Team Connection                  | Native destructive confirmation                        | Retain. Clearly distinguish clearing authorized Team state from deleting Personal Memory.                                                                                   |
| Stop Shared Memory updates or sync        | Native confirmation                                    | Retain where it prevents accidental interruption. Do not confuse stopping sync with revoking a Share Grant.                                                                 |

## Recommended Direction

### 1. Make Browser Approval Exceptional

Use browser or OS-backed step-up for trust establishment, privilege escalation,
access removal, destructive governance, billing, and other actions where an
independent proof of User presence materially reduces risk.

Do not require independent browser approval for read-like preparation,
ordinary additive creation, reversible lifecycle changes, or internal stages of
one User decision.

### 2. Preserve Main-Process And Backend Mediation

Removing a browser prompt must not cause credentials or general remote
authority to enter the renderer. Desktop should continue sending a narrow,
schema-validated intent to a trusted main-process or local-edge broker. That
broker should obtain or construct the exact authorization permitted for the
action's tier.

If Koed introduces native OS authentication, the challenge and result should be
owned by Electron main or another trusted local component rather than by the
renderer.

### 3. Make Confirmation Match The User Decision

One User decision should normally produce one confirmation:

- Shared Memory preview is preparation, not sharing.
- Consent and Share Grant creation are protocol stages of one reviewed share.
- Consent and representation replacement are stages of one reviewed change.
- Source download for a handoff or fork is an implementation requirement of the
  reviewed transfer, not necessarily a second User decision.

The resulting authorization can still be exact, one-use, and independently
audited at each backend mutation boundary.

### 4. Improve Remaining Step-Up Pages

For actions that retain browser approval, show human-readable context rather
than relying on UUIDs or generic descriptions:

- acting User and enrolled device;
- Team and Workspace names;
- affected member, invitation, Share Grant, or Personal Device;
- before-and-after role or access values;
- Shared Memory source title, representation, mode, and destination;
- whether the action is reversible; and
- the exact consequence of approving or denying.

Managed Conversation and source-replication actions need dedicated copy rather
than the generic "sensitive Team action" fallback.

### 5. Complete The Browser-To-Desktop Handoff

The browser page should not leave the User wondering whether Desktop received
the decision or whether the page must remain open. After an approval or denial:

1. Show the terminal result immediately and make clear that Koed Desktop has
   received, or is retrieving, the decision.
2. Attempt to close the browser window when the browser permits a script-opened
   approval window to close itself.
3. If the window cannot close, replace the approval controls with a prominent
   terminal message such as **Approved — you can safely close this window and
   return to Koed**.
4. Keep the terminal page inert. It must not expose the Action Grant secret,
   permit the decision to be replayed, or continue polling after the result is
   final.

If the decision request loses its response, the page must reload the
authoritative activation state before claiming success or failure. When that
status check also fails, the outcome is explicitly **unknown**, the window
stays open, and the User can retry the status check; the page must not claim
that no decision was submitted.

Denial, cancellation, expiry, and already-consumed states need equivalent
terminal copy. For example, a denied page should say that no change was made
and that the window can be closed; an expired page should direct the User to
restart the action in Desktop.

Desktop should independently show the authoritative outcome. Browser closure
must be a convenience, not the signal that allows Desktop to continue. If Koed
later adds a **Return to Koed** button or app deep link, it must use a narrowly
scoped, validated Desktop route and carry no reusable credentials or grant
secret.

## Proposed Next Steps

1. **Confirm the threat model.** Decide which risks the approval system must
   address: accidental activation, malicious remote content, compromised
   renderer, stolen unlocked device, compromised enrolled device, or some
   combination. Record whether browser authentication is a required independent
   channel or simply the current implementation of step-up.
2. **Approve an action-tier matrix.** Review every row above with product and
   security owners. Resolve the conditional cases for member roles, Workspace
   Access, Shared Memory detail increases, and Personal Device transfers.
3. **Define the trusted native confirmation boundary.** Choose whether native
   review is ordinary renderer UX, a main-process-owned trusted window, or an
   OS-authenticated prompt. Specify what each option protects against.
4. **Separate grant issuance from interactive approval.** Design how the Team
   Backend issues exact one-use grants for Direct and Native-review tiers
   without accepting reusable authority from the renderer.
5. **Redesign Shared Memory as one decision.** Remove interactive approval from
   preview. Bind the reviewed preview, consent, destination, representation,
   mode, expiry, and Share Grant mutation into one final confirmation and
   auditable workflow.
6. **Redesign access administration as draft-and-save.** Do not launch an
   external flow directly from each select change. Let the User review a
   human-readable before-and-after diff, then apply the approved bounded
   changes.
7. **Bundle transfer-related source authorization.** Ensure a reviewed handoff
   or fork can authorize its exact source download without surprising the User
   with another generic approval prompt.
8. **Improve the browser fallback.** Add dedicated copy and resolved display
   names for every retained browser action while keeping sensitive credential
   material out of the page and renderer.
9. **Complete the browser handoff.** After every terminal decision, attempt to
   close the approval window. When automatic closure is unavailable, render a
   clear result, state that the window is safe to close, and direct the User
   back to Desktop. Cover approved, denied, canceled, expired, consumed, and
   failed states.
10. **Implement in risk-ordered slices.** Start with Shared Memory preview and
    other Direct actions, then bundled Shared Memory confirmation, then native
    review actions, and finally step-up alternatives.
11. **Update validation and documentation.** Cover renderer compromise
    boundaries, stale versions, cancellation, expiry, replay, backend changes,
    authority revocation, accessibility, and recovery. Update the Team
    collaboration, Desktop UI, security, service-sequence, and credential
    matrix documentation when the design is accepted and implemented.

## Suggested Success Criteria

- Preparing a Shared Memory preview opens no external browser.
- A normal first-time Shared Memory share requires one meaningful User review,
  not three browser approvals.
- Ordinary Team and Workspace creation does not leave Desktop.
- Remaining step-up prompts identify the affected people and resources by name
  and show the before-and-after consequence.
- After a browser decision, the approval window closes automatically when
  permitted or prominently states that it is safe to close and return to Koed.
- Approved, denied, canceled, expired, consumed, and failed browser states each
  provide a clear terminal result without requiring the page to remain open.
- No reusable upstream credential, browser cookie, approval URL, or Action Grant
  secret enters renderer state.
- Every protected mutation remains exact, short-lived, one-use, auditable, and
  replay-safe.
- A compromised renderer cannot silently perform actions classified as
  Step-up.
- Denial, cancellation, expiry, stale versions, and authority changes leave
  Desktop in a coherent recoverable state.

## Open Questions

- Is protection from a compromised renderer a requirement for every current
  Action Grant, or only for the proposed Step-up tier?
- Can an enrolled device receive a bounded approval lease after OS or browser
  step-up, while each mutation still receives its own exact one-use grant?
- Should privilege decreases and access removal use the same tier as privilege
  increases and access grants?
- Which Shared Memory representations or source classifications warrant
  Step-up when increasing detail?
- Should a handoff or fork authorization always include its exact required
  source transfer, or are there cases where source download is a separate User
  decision?
- Is browser authentication the preferred long-term step-up mechanism, or a
  fallback for platforms without suitable native OS authentication?
