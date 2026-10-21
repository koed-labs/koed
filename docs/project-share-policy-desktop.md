# Project summary sharing on Desktop

Each member controls sharing of their own captured chat summaries for a linked
Personal Project. The Share Project sheet shows the current policy state and
calls `window.koed.projects.sharedPolicyStatus`, `sharedPolicyEnable`, or
`sharedPolicyRevoke` with that **owner Personal Project ID only**. The renderer
does not select Captured Session IDs, grant IDs, a manifest, a Team destination,
or fidelity. The trusted owner-local broker resolves the current Project link,
builds and checks the bounded source manifest, and opens the exact Native
review before enabling or revoking the versioned policy.

Enablement returns the current policy and the initial staging result. A staged
Pending Share is not yet a published Team summary. The sheet shows pending or
unconfirmed outcomes, occupied, already-issued, or no-longer-eligible skips,
and sources that changed since review. Changed sources need separate review; retry cannot adopt
newer content. The User can choose **Retry pending summaries** to reconcile
the same approved manifest through `sharedPolicyStageInitial`. A read or app
restart never starts an unbounded staging retry.

After a successful first Project share, the sheet immediately offers the
separate Native summary-policy review. If the User cancels that review, the
Project remains shared while summary sharing stays off; the linked sheet shows
**Review summary sharing** for a later retry. The linked sheet also shows
**Stop future summary sharing** when the policy is active. Revoking the policy
stops future policy-issued grants only. Existing grants keep their own consent
and lifecycle, including later summary updates, until the owner separately
freezes or revokes them. A failed or
unavailable broker response leaves the UI uncertain and requires a fresh
status read before another mutation. A durable enable or revoke attempt whose
result is still unknown appears as pending on that status read; the sheet offers
**Check status again** and withholds further policy changes until the broker
reconciles the exact receipt. Curated Memory and full transcripts each
require their separate approval paths.

An active Team policy is compared with the owner-local current Project link
epoch, enrolled device, signing key, version, and binding. If they differ after
a relink or device change, the sheet shows **Review needed**. Automatic initial
and future summary issuance stops. The owner can use the exact Native revoke
flow for the old Team policy, then review a fresh enablement. An obsolete sealed
attempt remains available for audit but cannot become the current link's
receipt. A pending Project-wide policy result does not prevent **Make private**
for one chat: that action still needs a Team exclusion acknowledgement and, if
an activated grant exists, its separately approved withdrawal.

If an active Team policy belongs to an older owner-local Project link epoch,
the sheet shows **Review needed: stop this old summary policy, then review
sharing again**. It withholds pending-summary staging while the exact Native
revoke remains available. A fresh policy enablement needs a new review.

The Share sheet is keyed by current owner, profile, visibility revision, and
Personal Project. Its asynchronous replies are discarded after that scope
changes. Labels displayed in the sheet are bounded broker results; the sheet
never renders source or manifest identifiers. The new HQ renderer fixture
validates disclosure and controls in light and dark themes. That fixture does
not prove Native grant authority or the compound two-member Scenario 15.

## HQ-703 join integration hook

On **successful, exact invitation acceptance**, HQ-703 must pass the newly
linked owner Personal Project ID and current owner/profile/backend binding to
the HQ-702 Desktop policy broker and offer `sharedPolicyEnable` once. The
broker performs a fresh exact Native review; acceptance of a Team invitation
does not approve summary sharing. Cancellation leaves the policy off, with
retry available in the linked Share Project sheet. Do not trigger this offer
from a Project list snapshot, an absent policy on app restart, or a poll. The
join consumer and Scenario 13 remain HQ-703 work.

Moving an existing chat into a shared Project requires the separate exact
**“Share a summary of this chat with Koed team?”** Pending Share confirmation.
The HQ move coordinator offers this review only after the move completes and
the destination is still the same linked Project. It reads the exact chat
status first; only an unshared captured chat can receive the moved-in offer.
Declining leaves the chat moved but its summary unshared. A pending result is
shown as pending, not published. A failed status or offer read leaves a visible
status-check message without undoing or misreporting the completed move. An
eligible chat whose exact status is unshared shows **Share a summary** in its
menu. This is an explicit retry with a fresh status check and a new Native
decision; it does not require moving the chat out and back.
The HQ chat menu reads an exact owner Project and Captured Session status before
showing **Make private** for a shared or pending summary. Its Desktop broker
holds the exact owner-local Session, fences Team issuance, obtains a separate
Native withdrawal decision for any activated affected grant, waits for the
Team withdrawal acknowledgement, then commits the Personal private exclusion.
The existing move coordinator likewise keeps its hold until an exact move or
known cancellation has released it. Cancellation or an unknown result never appears as private; the menu
offers a fresh status read. This changes only that chat, not the whole Project
policy. **Share again** appears only when the exact status says private. It
starts a fresh Native-reviewed Pending Share through the trusted Desktop broker;
cancellation leaves the chat private and a pending result stays pending. The
renderer sends only the owner Personal Project ID, Captured Session ID, and
offer reason. The broker derives the candidate and destination, rechecks the
offer before each effect, and withholds grant and offer IDs from the renderer.
An ineligible Project HQ chat has no sharing controls. Moving a chat alone
never implies that its summary was shared.

Moving a chat out of a linked shared Project first reconciles its exact
published and pending issues. The owner-local service then obtains a Team
exclusion and explicit-offer fence even when it finds no issue. Only after that
acknowledgement may the existing HQ-107 move coordinator run. An unavailable
Team fence leaves the chat in its old Project. If the User cancels the Native
move review and HQ-107 confirms the old placement with no pending review, the
Desktop broker reads the acknowledged fence by the same Project, chat, link,
and mapping revision before releasing its local move hold. An uncertain move
keeps that hold; a status guess cannot release it.

The authorization and source lifecycle rules are in
[ADR 0057](./adr/0057-project-backed-workspaces-and-project-share-policy.md)
and [Project-sharing lifecycle](./project-sharing-lifecycle.md).
