# Consented Team Memory Retention

Status: Accepted product and authority decision. Implementation validation is
tracked in the Studio integration Ticket 09 review.

## Context

Teams need to retain knowledge contributed by people who later leave. Removing
a contributor's access must not silently remove knowledge that the contributor
explicitly agreed the Team could retain.

Koed already stores encrypted, processed Team representations and semantic
indexes. Personal source soft deletion and retention processing can preserve
those representations. The missing boundary is consented recall and management
after the contributor stops sharing or leaves. Existing owner membership and
grant lifecycle checks must be extended explicitly; retained storage alone is
not an authorization decision.

## Decision

A Team administrator configures retention per member within that Team. The
default is enabled for new members. The sharing preview discloses the applicable
retention policy and the contributor confirms it. The confirmed policy and
version bind to that exact share. Existing shares do not become retained through
a migration or a later setting change. Conversion requires fresh contributor
consent. Disabling the setting applies to future shares and does not remove
existing retained representations.

Snapshot sharing is the default. Ongoing updates require an explicit choice.
Refreshing a snapshot requires a new preview and confirmation, updates the
same destination share, and keeps the previous authorized revision available
until the replacement is ready.

For a consented retained share, stopping sharing ends future updates. Its
existing Team representation remains recallable to authorized current Team
members after the contributor leaves or deletes the Personal Conversation.
The departing contributor loses Team access. Rejoining does not restart updates
or restore stopped non-retained shares automatically.

Only an authorized Team administrator can remove the retained representation
from that Team's recall. Removal does not affect another Team's independent
share, the Personal source, or Agent replies already delivered. A non-retained
share continues to use ordinary revocation: future recall and updates stop.

Retained knowledge remains attributed to the originating User. This is neither
an ownership transfer nor a fork of Personal Memory. Reuse processed encrypted
Team representations and their provenance. Do not create transcript or file
copies through retention. Conversation Source Access remains a separate,
explicitly authorized capability.

The Studio Team-wide destination must work without a Project and be available
to every current Team member, including later joiners. It still has an explicit,
stable Workspace identity for memory authorization. This destination must not
widen access to existing restricted Workspaces. Independent Teams have separate
grant, retention, update and removal authority.

## Consequences

Consent, recall, expansion, citation, materialization and maintenance must agree
on the retained authority. A retention flag must not become a blanket bypass
for Team membership, Team lifecycle, representation policy, privacy filtering,
encryption scope, provenance or separate source access.

The contributor's update authority and the Team's retained-recall authority
have different lifecycles. Update stopping must be scoped to the destination
grant so another Team can continue receiving its authorized updates. A late job
or retry cannot revive stopped updates or an administratively removed share.

Studio exposes per-member retention under Settings → Teams → Members and a
compact retained-memory list and removal action under Settings → Teams → Memory.
Sharing confirmation must explain the retention effect. It must not promise
that stopping updates removes retained Team knowledge or retracts replies
already delivered.

## Consent and browser transport

Persist the retention choice and member policy version in the reviewed preview,
then bind the same values to consent and the Share Grant. An older caller that
omits retention fields must never inherit enabled retention from a member setting.
The member policy version is separate from the existing storage retention version.

Browser sharing uses the signed-in owner's existing synchronized replica and the
existing session and CSRF protections. An owner-only replica locator may return
its identifier and exact source binding after checking Team and Workspace access.
This lookup does not enroll a source, upload content, or grant transcript access.
A missing or unavailable replica must return an unavailable state.

## Alternatives

Revoking all recall when the contributor leaves loses organizational knowledge.
Keeping knowledge without disclosed consent ignores the contributor's sharing
boundary. Retaining the original Personal transcript or transferring ownership
is unnecessary for the approved processed-memory use case. Reusing the existing
encrypted Team representation with explicit retained authority preserves both
the knowledge and its provenance.

## Validation

Require source-deletion and departure retention, recipient membership denial,
non-retained revocation, fresh-consent conversion, per-Team update isolation,
administrator removal, stale-version rejection, encrypted storage and
web/Desktop sharing checks. Record exact tested revisions and keep live results
separate from controlled DB and contract evidence.
