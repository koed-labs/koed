# ADR 0064: Project Contributions Stay With The Project, Share Origin, And The Sharing Page

## Status

Accepted design (23 Oct 2026); implementation remains pending in HQ-720–HQ-726.
Product decision D10 is accepted. Amends ADR 0057 (Project-backed Workspaces and
Project Share Policy) and ADR 0062 (Shared Project State). Builds on the Share
Grant freeze (HQ-715, `shared_memory.grant.freeze`) and the Project lifecycle in
`docs/project-sharing-lifecycle.md`. Relates to ADR 0004 and ADR 0024. Does not
change ADR 0001 or ADR 0013.

## Context

Koed's main team case is knowledge retention: a company brings in a contracted
team for many months, and when it leaves, how and why things were built must
stay.

The integration already freezes a member's Project-policy grants when they
leave a Project or a Team, are removed or disabled, lose Workspace Access, or
the shared Project is deleted. A freeze keeps the grant's consent and its last
published representation, stops future advancement, and does not end Team
recall. Rejoining does not resume a frozen grant.

Two paths still let shared knowledge disappear:

- **Make private** withdraws a Project-policy grant through `shared_memory.revoke`.
  Its representations are invalidated, semantic items deleted and a purge is
  scheduled, so teammates lose what was shared.
- **Author revocation.** The source owner can revoke any grant, including a
  frozen Project-policy grant, through
  `POST /v1/shared-memory/share-grants/{id}/revoke` (and the legacy Shares list).

Separately, users need one place to see what they share and with whom, and to
take a share back, including shares their agent made under Full access.
Invites record `created_by_user_id` and `inviter_agent_display_name`; grants
record `granted_by_user_id`; nothing records whether an agent acted or from
which chat.

## Decision

### 1. Make private freezes

- Making a Conversation in a shared Project private **freezes** its
  Project-policy grant through the existing owner-reviewed
  `shared_memory.grant.freeze` Native review, instead of revoking it.
- Both backends change together. On the Team side, both grant-selection paths
  (the original policy grant and explicit moved-in / share-again grants) treat
  frozen and revoked grants as settled; only active, unfrozen grants need a
  freeze, and several historical frozen grants are not a conflict. The
  Personal make-private route returns `freeze_required` until the freeze is
  confirmed, then `private`; its explicit-offer reconciliation and the Desktop
  parser accept the new state. Retries converge: a freeze already done is not
  repeated.
- The last published summary stays in Team recall, attributed to its author;
  later messages are not shared. "Share with the project" again creates a new
  grant with the normal confirmation, as today.
- Making private still needs no Team enrollment when there is no grant, and
  still does not stop Agent work or Scheduled Jobs.

### 2. Published knowledge stays: Project contributions

- A **Project contribution** is a Share Grant bound to a Workspace Project in
  `workspace_project_share_grant_bindings`: a Project-policy Conversation
  summary, or an uploaded Note Source (`workspace_project_source_id`).
- Its author cannot revoke its **Share Grant**, **whether active or frozen** (403,
  "This was shared with {project} and stays with it. Make it private to stop
  future updates."). Making it private (a freeze) is how an author stops future
  updates.
- The restriction applies to the author-facing Share Grant revoke only. System
  paths (retention jobs, cascades, suppression, expiry, owner removal) are not
  routed through it.
- **Conversation Source Access is separate** (ADR 0047). The source owner can
  still revoke transcript access (`/transcript-access/revoke`) to a
  contribution's Conversation; withdrawing it does not withdraw the retained
  summary.
- **What "stays" means.** A retained contribution is still governed by its
  author's suppression ("Forget"), by expiry and by current policy checks, and
  by the Workspace Project owner's removal. Chats are shared under each
  member's Project Share Policy; eligible Project-scoped Curated Memory requires the existing administrator
  policy opt-in, separate source-owner Step-up consent and complete provenance
  inside the exact granted Captured Session (ADR 0063). Me-scoped assertions
  remain Personal. Note Source revisions keep their separate owner-authorized
  grant path.
- The **Workspace Project owner** can remove one contribution through a
  dedicated path with its own Native-reviewed Action definition
  (`workspace_project.contribution_remove`); the existing revoke requires the
  source owner and is not reused. Removal invalidates and purges the
  contribution for everyone (a revoked grant leaves recall) and is audited.
- An uploader can still delete a Source's metadata: the grant is frozen and the
  entry leaves the Sources list, while what it added stays in recall. Only the
  Workspace Project owner removes the knowledge itself.
- Shares not bound to a Workspace Project keep the ADR 0004 lifecycle,
  revocation included.
- Personal memory stays user-owned: the author's Personal records are
  untouched. Me-scoped assertions, HQ Conversations and anything added to a
  Conversation after it is made private are never shared.

### 3. Access stays with people

- Removing people uses the existing Team actions with their **existing
  authority and approval tier**, unchanged: `workspace_project.member_remove`
  (Project owner, Step-up), `team.member.disable` (Team owner/admin, Step-up),
  and Team invitation revocation (a current Team owner or admin, an owner
  invite only by an owner; Native review). This ADR extends no authorization.
- Several removals at once ("stop sharing a Project", "stop sharing everything
  with a person") use **one review per target, in sequence** in this release.
  Every member removal increments the Project version, so a review is requested
  only after the previous target's removal has finished or been cancelled and
  authority and version have been re-read; approvals are never collected against
  one snapshot. Results are reported per target. A batch Action definition is a later decision: it would
  need its own Step-up contract, exact target and version binding, replay
  handling and an atomic-or-partial rule.
- **Undo** cancels a pending removal: after approval, Desktop waits 5 seconds
  before the Team call. Undo drops the call; it never re-grants. At dispatch the
  Action Grant is revalidated (unused, not expired; default lifetime 60
  seconds); if expired, nothing is sent and the user is told. Quit, sign-out, an
  identity or backend change, or a crash inside the window cancels it.
- A lost response is an unknown outcome: Desktop retries with the same mutation
  identity and the exact approved request, recovers the existing receipt where
  supported, and never turns a retry into a new removal or new authority.
- "Recently shared" (last 24 hours) is a shortcut list. Its rows offer the real
  operations, **Remove access** or **Cancel invitation**, with the same review.
  They do not erase what was already shared.

### 4. Share Origin

- Team invites and Workspace Access grants record `actor_kind`
  (`person` | `agent_on_behalf`) and `access_mode` (`ask_first` |
  `full_access`, agents only), next to the existing `created_by_user_id` /
  `granted_by_user_id` and `inviter_agent_display_name`. Existing rows stay
  null and read as "not recorded".
- The agent name is shown to the inviter and the Project owner only, as today.
- The originating Conversation id is stored **only on the sharer's Personal
  backend** (`share_origins`), owned by that Personal User. The typed target is
  either `invitation` with a backend-qualified `invite_id`, or `workspace_access`
  with backend, `team_workspace_id` and Team `user_id` (the existing composite
  primary key). Record the Workspace Access version with the origin to preserve
  attribution across later re-grants. Shape checks distinguish the target kinds;
  no standalone Workspace Access grant UUID is introduced.

### 5. The Sharing page and the agent

- One read model per Team backend (`GET /v1/me/sharing`), aggregated once with
  pending invites (`GET /v1/team-invites/mine`, ADR 0060) and local Share
  Origins. Each backend is reported as available or unavailable; an
  unavailable backend is never silently dropped. Each item carries the
  caller's authority (`canRemove`, `canCancel`), computed from the actions'
  current authority.
- An accepted invite's provenance (`actor_kind`, `access_mode`, Share Origin)
  carries into the Workspace Access row it creates or updates. Link the Personal
  invitation origin to that backend-qualified composite target and its resulting
  version; preserve earlier attribution and leave historical unknowns unknown.
- "Shared by {name} (no longer in {group})" follows the author's current Team
  membership; leaving a Project while still in the group adds no group label.
- The read model returns Team ids, display names, access (edit or view),
  status, since, Share Origin and counts only; never Conversation content or
  another member's Personal ids.
- The page and a **data-returning** agent tool (`sharing_overview`) read the
  same aggregate, served by an authenticated Personal local-edge route that
  Desktop and the runtime share. The route authenticates the current Personal
  owner and profile; only that owner may read their Share Origins. It resolves
  only that owner's enrolled backend registry and custody, and calls only
  metadata-read routes allowed by the backend's route policy. Each upstream
  validates current Team membership and Workspace visibility and computes
  `canRemove` and `canCancel` from current action authority, never from renderer
  flags. An unenrolled or unavailable backend fails closed and is reported as
  unavailable. The aggregate exposes no upstream credential, other member's
  Personal ids, or Conversation content to Desktop or the agent. This sharing
  metadata contract does not reuse Team recall's durable-task guard or broaden
  existing operation families. Removal requests from the agent are text-action
  requests that end in the same review as on the page.
- One help text, shipped with Desktop, is shown on the page and used in the
  Chief of Staff's instructions.

## Consequences

- **ADR 0057 is amended in three places:**
  - The paragraph "Marking a Conversation private is a local owner control…": the
    owner authorizes a **freeze** through `shared_memory.grant.freeze`, not a
    revocation.
  - "Revocation, suppression, expiry, and current policy checks continue to govern
    frozen grants as well": for grants bound to a Workspace Project, active or
    frozen, revocation by the source owner is replaced by the Workspace Project
    owner's removal. Suppression, expiry and policy checks are unchanged.
  - "…unless the owner separately revokes that exact grant" (moving a Conversation
    out of a shared Project): the same restriction applies.
- **ADR 0062 is amended once.** Under "Freeze and lifecycle", the revocation
  that governs published evidence is, for Project contributions, the Workspace
  Project owner's removal.
- **Docs and tests.** HQ-720 will rewrite "Make a Conversation private" in
  `docs/project-sharing-lifecycle.md` and change HQ-713 step 6 so the earlier
  summary stays in the teammate's recall. It will also change I713.06 in
  `apps/desktop/scripts/hq-acceptance-contract.mjs` and its clause in
  `scripts/hq-acceptance-owned-suites.mjs`.
- **High-risk actions.** One new Action definition:
  `workspace_project.contribution_remove`.
- **Legacy interface.** Not changed (behind `KOED_DESKTOP_HQ_ENABLED=false`).
  HQ-726 will make the API refuse the revoke; the legacy list will show that
  refusal.
- **Existing assertions.** The branch's `N11.I` (`hq713-lifecycle.ts`, the
  author revoking a frozen Project-bound grant) and any matching `N11.T` case
  change to expect the refusal; "revocation still denies" is covered by a grant
  not bound to a Project and by the owner removal. The `I713.06` acceptance
  contract also changes to assert that the earlier summary remains in recall.
- **Schema.** New nullable columns on `team_invites` and
  `team_workspace_access_grants`, a Personal `share_origins` table, one Team read
  route and one owner removal route.
- **Curated suppression.** An author's suppression ("Forget") of a curated
  assertion shared through explicit curated opt-in keeps its existing effect.
  Project-policy grants remain summary-only.

## Alternatives Considered

- **Keep revocation on make private.** Rejected: making a chat private just
  before leaving would bypass retention.
- **A separate "Workspace Retention" setting and retained state.** Rejected: the
  existing freeze already does this; a second mechanism would diverge.
- **Copy shared content into Team-owned memory.** Rejected: introduces
  Team-owned memory (ADR 0004).
