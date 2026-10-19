# ADR 0063: Project Memory Scope and Combined Recall

- Status: Accepted (design; runtime implementation pending)
- Date: 2026-10-19

This is a target contract, not a claim that Project-scoped assertions or
combined Personal and Team recall are implemented. It adds no backend LLM
synthesis (ADR 0001).

Related decisions and contracts:

- [0001 AI Client Synthesis Only](./0001-ai-client-synthesis-only.md)
- [0004 Team Memory Uses User-Owned Share Grants and Workspaces](./0004-team-memory-workspaces.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0057 Project-Backed Workspaces and Project Share Policy](./0057-project-backed-workspaces-and-project-share-policy.md)
- [0059 First-Class Personal Projects](./0059-first-class-personal-projects.md)
- [Curated Memory](../curated-memory.md)
- [Team Workspace Project Mapping](../team-workspace-project-mapping.md)
- [Project-Sharing Lifecycle](../project-sharing-lifecycle.md)
- [Team Collaboration](../team-collaboration.md)

## Context

Curated Memory is Personal by default. Its current source-backed retrieval can
filter by a Project derived from evidence, but assertion rows do not yet carry
the target `scope` or first-class `project_id` classification. The current
`memoryAnswerInputSchema` accepts `search_domain` (`global`, `project`, or
`session`) and `project_id`; it has no trusted Me selector. Team recall is a
separate authorized query selected by backend and Workspace. The existing MCP
Project-to-Workspace mapping is recall-routing configuration, not the target
Personal Project-to-Workspace Project link and not Team authority.

## Decision

### Assertion scope and provenance

- Add `scope` to Curated Memory assertions: `me`, `project`, or `unscoped`.
  A `project_id` is required for `scope = project` and refers to the owner's
  Personal Project. Add the approved `kind`, `author_kind`, and `author_ref`
  fields. Legacy assertions migrate to `unscoped`; they are never relabelled as
  `me`. Present them under “Other things Koed knows” with an explicit move
  action. Existing recall continues to use legacy evidence under its current
  relevance rules.
- Preserve existing assertion writers in the additive schema change: define
  `scope` with a database default of `unscoped`, keep `project_id` nullable,
  and require a non-null `project_id` only when `scope = project`. Existing
  writes that omit the new classification fields remain valid. Keep current v1
  request shapes valid when `scope` is omitted; a request contract that
  requires scope must use an explicitly versioned shape. Do not fabricate
  `author_kind` or `author_ref` during legacy migration; populate author data
  only when supported by genuine source-owner provenance.
- Do not make the new eligibility rules or `unscoped` legacy backfill
  authoritative while a newly ineligible Team Curated representation or its
  routing/vector rows remain searchable. Withdraw or block those rows and
  fence stale publication first. The distributed withdrawal protocol and
  acknowledgements must be deployed before any HQ-301/302/303 scope or Project
  write, including eligibility-changing backfill activation, can commit. Keep
  activation pending until affected Team backends acknowledge; never infer a
  legacy Project assignment. This does not freeze unrelated grants or permit
  Team writes to Personal storage.
- The Local AI Runtime reviewer may propose assertion scope and kind; the
  deterministic write path validates and stores them. A new source enum alone
  does not make an assertion shareable.
- A Curated assertion may enter a summary Share Grant only if its complete,
  nonempty active direct-source set and all active provenance resolve wholly
  inside that exact granted owner-owned Captured Session. Its `scope` must be
  `project`, and its Personal Project must be the exact owner-owned Project
  linked to the Workspace Project. Multiple direct sources from that same
  Captured Session are allowed. A source outside the session, missing or
  incomplete provenance, or mixed-session evidence excludes the assertion.
  `me`, `unscoped`, and non-Conversation evidence remain Personal unless a
  separate explicit grant contract admits that source; Project Source Note
  revisions keep their own owner-authorized grant path.
- A scope or Project-assignment change invalidates affected Team Curated
  representations and their semantic routing/vector rows before the new
  Personal classification commits. When Personal and Team records are
  co-located, commit the classification and withdrawal in one database
  transaction. When Team storage is separate, the trusted source-owning local
  edge coordinates a durable, idempotent owner-authorized mutation through the
  existing source-publishing boundary and gets an atomic withdrawal
  acknowledgement from every affected Team backend before the Personal
  mutation commits or reports success. Each backend withdraws only its affected
  `curated_assertions` representation and semantic rows, and fences publication
  of the old classification. An
  unavailable backend leaves the Personal mutation uncommitted and retryable;
  if withdrawal succeeds but the Personal commit fails, retain the safer
  withdrawn state and retry rather than restoring old artifacts. A Team backend
  never reads or writes Personal storage, and a Personal API Token never
  authorizes the operation. This is representation invalidation, not the
  lifecycle freeze in HQ-715, which preserves published bytes that may no longer
  be eligible. Unrelated grants and shared source relationships remain intact.
  After commit, any eligible representation is republished only from current
  Personal state under existing grants, policy, and exact Project links.

### Separate consent and frozen grant coverage

- The Project join disclosure and bounded initial manifest in ADR 0057
  authorize `lcm_leaves` summaries only. They do not authorize
  `curated_assertions`. Enabling Curated Memory in an initial
  `shared_memory.pending_share`, and enabling it later through
  `shared_memory.change_fidelity`, each require separate explicit disclosure
  and ADR 0024 Step-up. Full access never lowers either requirement.
- A Share Grant freeze pins only its last actually published revision and its
  complete immutable authorized representation closure. Search, expansion, and
  unsuppression continue to enforce current consent, membership, Workspace
  Access, revocation, suppression, expiry, retention, and policy checks.
  Unsuppression can restore Team recall only for material already inside the
  pinned closure; it cannot advance a frozen grant or add new material.
- If the grant has attached continuous Conversation Source Access, the same
  atomic freeze pins its last authorized sanitized source generation and
  segment frontier. Conversation Source Access remains separate from semantic
  sharing and follows ADR 0047's independent consent, revocation, expiry,
  membership, Workspace Access, and Team-audience checks. Recipients may access
  only the sanitized artifact and verified segments permitted by that policy;
  the owner's raw private journal and values removed by the policy remain
  unavailable. Snapshot source access and unrelated grants remain unchanged.

### Combined Personal and Team recall

- For a Desktop-launched Conversation in a linked Project, the trusted Local AI
  Runtime performs distinct Personal and Team retrievals, then merges their
  evidence for the AI Client. Koed does not synthesize the answer in a backend.
- Keep the selectors distinct. The assertion `scope` classifies a Curated
  assertion; **Retrieval Scope** selects which visible memory classes may be
  searched; **Search Domain** filters by Session, Project, resolved Workspace
  context, or all visible memory. `search_domain = global` alone selects no
  Team and grants no access. Today the API's `retrieval_scope` is `personal`;
  Team recall is selected separately by an authorized `team_workspace_id` and
  backend context. Do not treat the current Personal-only field or a Search
  Domain value as a new Team authorization mechanism.
- HQ-714 adds a trusted, additive Personal selector/union for the linked
  Personal Project context plus `scope = me`. It may include legacy
  `unscoped` evidence only under existing relevance rules. The Me branch must
  not use a Personal `global` query, which would include unrelated Projects.
  This is new target behavior, not a current `memoryAnswerInputSchema`
  capability.
- The Team query resolves only from the trusted Personal Project-to-Workspace
  Project link defined by HQ-712—not a path, remote, or the separate
  `project-team-workspaces.json` MCP mapping. It sends that link's exact
  `team_workspace_id` and `team_backend_id`, sets `search_domain = global`,
  and omits `project_id`. The query uses existing Team authorization and
  preserves its signed frozen Share Grant boundary through retrieval,
  expansion, backend selection, and citation creation. Never pass a member's
  local Personal Project ID to Team search.
- If the selected Team backend is unavailable, the answer states that Team
  Memory was not checked. It must not silently present Personal-only results
  as a successful combined query.

### Persisted citations and User actions

- Store Desktop-turn citations in an encrypted, owner-scoped
  `managed_conversation_turn_citations` map linked to the logical Session,
  execution/generation, provider turn, tool call, and persisted
  `memory_questions` reference including backend. `memory_questions.citations`
  remains the citation source; transient runtime output is deletable, and
  `memory_citations` is not an existing supported runtime kind. Persist source
  identity/type and visibility, plus a backend-qualified source-owner identity:
  Personal identity uses the source deployment and owner principal; Team
  identity uses its authorized Team/backend namespace and source-owner
  principal. Never compare bare Personal and Team User IDs across backends. This
  extends the current citation contract rather than claiming those fields are
  already present everywhere.
- An immutable namespaced alias map supports multiple recalls per provider
  turn. Citation tags resolve only through persisted aliases and citation
  identities, never model-supplied IDs. Citation detail reauthorizes current
  Team access; after access is revoked, the citation remains recorded but its
  Team detail is unavailable.
- `memory_forget` resolves the explicitly referenced citation or the latest
  cited item, then verifies ownership before any mutation. It never skips a
  teammate's item to delete an older assertion. Ambiguity asks the User; there
  is no silent fallback.

| Item                                                                                   | Forget                                                     | Correct                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| The User's own assertion (`me`, `project`, or `unscoped`)                              | Yes, with the seven-day Undo target                        | Yes; create a `supersede` proposal                                |
| A teammate's shared item                                                               | No; show “Shared by Mark” and “Ask Mark”                   | No                                                                |
| A summary of the User's own Conversation (`memory_node`, `memory_event`, or `message`) | Only by forgetting that Conversation through its lifecycle | No; a correction creates a new assertion                          |
| A Project Source revision                                                              | Through the owner's Personal Note revision forget path     | A correction creates a new assertion with valid source provenance |

Team Chat Messages and Project Thread messages remain collaboration data. Under
the current policy in ADR 0013 and D2, they are never Memory or Agent input,
including HQ catch-up. They cannot become Curated evidence or enter either
retrieval branch under this decision.

## Consequences

- One additive migration backfills legacy Curated assertions as `unscoped` and
  preserves existing writers through the `unscoped` database default. Added
  response fields are compatible only with clients that tolerate unknown
  response properties; use an explicit response version where that tolerance
  is not part of the client contract.
- The memory panel can separate Project, Me, and Other assertions without
  changing assertion ownership.
- Combined recall remains two separately authorized Local AI Runtime queries
  and preserves Personal and Team visibility and ownership in persisted
  citations.
- A session Share Grant cannot admit unrelated assertions merely because they
  mention the same Project.

## Implementation Boundary

The scope fields, Me selector/union, linked-Project combined recall, persisted
turn-citation map, and citation detail flow are target behavior and require
implementation. Existing Personal and Team recall remain separate; this ADR
does not authorize a Personal API Token to perform Team recall. Existing
Team-chat separation remains in force.

## Alternatives Considered

- **Treat a null Project ID as `me`.** Rejected: that would relabel legacy
  assertions as User-wide information.
- **Treat the Project join disclosure as Curated consent.** Rejected: summaries
  and Curated assertions are distinct representations and require separate
  disclosure and Step-up.
- **Copy Personal assertions into Team-owned Memory.** Rejected by ADR 0004;
  Team-shared Memory remains User-owned and grant-scoped.
- **Use one merged retrieval index.** Rejected: Personal and Team remain
  separately authorized retrieval boundaries.
