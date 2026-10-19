# ADR 0061: Pull Request Merge as a Runner-Owned Source-Control Mutation

- Status: Accepted (design; runtime implementation pending)
- Date: 2026-10-19

Related decisions:

- [0038 Runner-Owned Source-Control Credentials](./0038-runner-owned-source-control-credentials.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)

## Context

D7 accepts the product direction: the Agent proposes; Koed merges. A User can
request a merge through a Desktop button or by asking their Agent. The Agent
must not receive provider credentials or use ambient CLI authority to perform
the mutation. ADR 0038 reserves source-control mutations to Koed's
runner-owned service and currently says merge is unavailable until separately
designed and approved.

The current shared source-control contract does not yet define merge. It has no
`review_request_merge` capability or operation, no repository-allowed merge
methods, no complete readiness snapshot and digest, no PR review or
mergeability fields, and no merge outcome. The contract and runtime work
described below are target requirements; this decision does not claim those
fields, APIs, providers, or Desktop flows are implemented.

## Decision

### Authority and capability

Pull-request merge is an explicit source-control capability,
`review_request_merge`, executed only by Koed's runner-owned source-control
service using fixed provider method and path templates. The Merge button and
the Koed tool `review_request_merge_propose` use one Desktop merge service.
The untrusted proposal carries only the minimum PR selector. Koed resolves it
against current verified provider state and derives the User, provider,
account, repository, remote, runner execution, and credential. The server
produces the prepared/review operation envelope with those verified identities,
their relevant generations, the expected head, and the complete readiness
snapshot. A DTO may carry these prepared values so the exact operation can be
shown and bound, but the server revalidates them under ADR 0038;
renderer- or Agent-supplied authority fields are never trusted.

A provider must report the repository's exact `allowedMergeMethods`. The
User's selected `mergeMethod` must be a member of that set and is shown in
Native review. Koed never guesses a default, accepts an arbitrary method, or
falls back to a generic CLI. If the provider, connection, or runner cannot
advertise and safely execute an allowed method, it exposes no merge capability
and Desktop shows `Open on <provider>` for that PR.

AI Clients, renderer messages, terminal access, Conversation permission mode,
and provider CLI sessions do not grant merge authority. They cannot supply or
change credentials, provider endpoints, account bindings, repository identity,
refs, expected revisions, or approval results.

### Target DTO contract

Preserve the existing version-1 request, response, and capability DTO shapes.
The current source-control routes do not negotiate a contract version. Introduce
the merge operation, merge-capability value, and expanded review/result DTOs
only through an explicitly negotiated newer source-control contract or a
versioned route; advertising a capability alone is not negotiation. Existing
version-1 clients continue to receive and send unchanged version-1 DTOs. HQ-408
conformance tests must verify that compatibility and that newer DTOs are used
only by clients that negotiated the newer contract.

Within that newer contract, extend the shared source-control contract
additively. Keep current merge behavior unchanged until the corresponding
contract, service, and provider driver have landed and advertise the negotiated
capability.

- **Capability and operation.** Keep version 1's `mutationBase` and all
  version 1 operation variants unchanged. In the negotiated newer contract,
  use a version-appropriate base that retains the non-merge bindings and
  fields. Add a `review_request_merge` discriminated-union variant with only
  the merge-specific fields, including `reviewRequestNumber`, `targetBranch`, the
  repository-allowed `mergeMethod`, and `readinessSnapshotDigest`. The
  operation's `expectedHeadObjectId`, `credentialGeneration`, and
  `idempotencyKey` remain bound by the reused base; do not add merge fields to
  the shared base. Keep the untrusted proposal input separate from the
  prepared, approval-bound operation: the former contains only a minimum PR
  selector, while the latter contains the server-derived and revalidated
  provider/account/repository/remote, execution and credential generations,
  expected head, and readiness binding.
- **Provider review snapshot.** Extend the target `SourceControlReviewRequest`
  DTO with typed `allowedMergeMethods` method-enum values, a `mergeability`
  enum, and a `reviewDecision` enum. Carry required review state and relevant
  reviews, plus a complete bounded
  `checks` snapshot pinned to `expectedHeadObjectId`; include the canonical
  readiness snapshot and `readinessSnapshotDigest`. Unknown or incomplete
  readiness is not positive evidence that merge is ready.
- **Operation result.** The target result DTO reports
  `outcome: "pending" | "merged" | "rejected" | "unknown"`, the Koed
  operation identity, provider operation identity when available, and merge
  commit identity when known. Keep the result bounded and typed.

The canonical readiness snapshot covers the verified PR and repository
identity, account and remote, target branch, exact head, mergeability, required
review state, relevant check states, the allowed method set, selected method,
and the applicable policy and credential/runner generations. Its digest is
stable for that exact snapshot and is displayed with a readable summary; the
digest does not replace the fields needed to validate and show the operation.

### Native review and stale state

Every merge requires ADR 0024 **Native review** through Koed's existing
Desktop-local source-control trust boundary. The current generic confirmation
and boolean approval marker do not satisfy this contract. Merge review must
show the authoritative prepared operation, including repository, PR, target
branch, head, selected method, a readable readiness summary and digest, and
expiry. Approval produces a server-verifiable, one-use proof bound to the User,
immutable operation identity and generation, readiness digest, and expiry. The
server verifies that proof against the prepared operation and consumes it with
the durable dispatch claim; a boolean header alone or a replay for a changed
operation cannot authorize a merge. This target extends the merge approval
flow only; current confirmation for other source-control mutations is
unchanged. Native review is not a Step-up or “high-risk” tier, and it has no
“always allow” option. Full access and every other Conversation permission
mode still require the approval. A declined approval cancels the proposal,
leaves the Work Item In review, and is not a provider **rejected** outcome.

Approval binds the exact immutable operation: User, provider, account,
repository, remote identity, runner execution and generation, PR number, target
branch, expected head, selected repository-allowed method, complete readiness
snapshot and digest, credential generation, policy version, idempotency key,
and expiry. It cannot authorize a different PR, method, head, or snapshot.

Immediately before dispatch, Koed revalidates current User and runner
authority, repository/account/remote, credential generation, policy, PR state,
and the complete readiness snapshot. A changed head, target, allowed method
set, selected method, mergeability, required review state, or check snapshot
returns a pre-dispatch conflict and requires a fresh snapshot and Native
review. Koed never silently substitutes newer state.

The provider write must be conditional on the approved expected head (or an
equivalent provider precondition), and provider-enforced branch protections,
required reviews, and required checks remain authoritative at mutation time.
A driver that cannot bind the expected head or establish the provider's
required mutation-time protections must not advertise merge capability.
Re-reading readiness immediately before dispatch narrows the race window; it
does not replace provider-side conditions.

### Single-use dispatch and predecessor fencing

Before any provider write, Koed durably records the immutable approved
operation and atomically claims its one dispatch. Only one process may move
that approval from approved to claimed. Duplicate submissions of the same
approval reuse the same idempotency key and return the recorded operation
state; they do not issue another provider write after the claim exists.
Recovery never clears or recreates the claim to try the write again.

A durable per-PR predecessor fence blocks any later merge mutation while an
earlier dispatch claim exists or its outcome is pending or unknown. It is
released only after an authoritative terminal outcome or authoritative
evidence that the provider never accepted the predecessor. A changed-check
approval on the same head is possible only after the predecessor is resolved;
it receives a new immutable operation identity and idempotency key. Approval
renewal cannot bypass an unresolved predecessor.

### Outcomes and read-only recovery

- **pending**: the provider confirms acceptance of the exact merge operation,
  including an accepted merge-queue operation that has not completed.
- **merged**: the provider authoritatively confirms the merge. Include the
  merge commit identity when available; only this outcome makes the Work Item
  Done.
- **rejected**: the provider authoritatively confirms that it refused the
  mutation and did not accept or complete it. A pre-dispatch conflict and a
  declined User approval are not merge outcomes.
- **unknown**: a write may have reached the provider, but its outcome cannot
  be proven. Timeout, crash, lost response, ambiguous state, and incomplete or
  unreadable reconciliation remain unknown.

After the dispatch claim, startup and User-requested recovery are read-only.
Koed queries the exact PR and, when available, the exact provider operation or
merge-queue status. An open PR alone proves neither rejection nor that the
provider never accepted the request. Keep confirmed asynchronous work
**pending**; keep unproven work **unknown**. Never automatically retry, create a
second mutation identity, or release the predecessor fence because a read
failed. If the provider cannot prove a terminal outcome or non-acceptance, the
operation remains visibly unresolved.

Normalize provider outcomes to bounded typed results or safe summaries. Do not
expose raw provider response bodies through renderer payloads, logs, or
diagnostics.

### Unavailable operations and implementation boundary

Force push, history rewrite, protected-branch changes, repository
administration, branch deletion after merge, and deploy-key management remain
unavailable under ADR 0038. Providers without the exact conditional operation
and authoritative state required above keep merge unavailable; Desktop shows
`Open on <provider>`.

At this decision's date, the shared DTO, API route, provider drivers, operation
journal behavior for merge, and Desktop flow are not implemented. The existing
generic source-control confirmation and boolean approval marker do not bind an
exact prepared merge operation, so they cannot serve as merge approval proof.
HQ-408 owns the API/driver contract and server verification; HQ-405 owns the
authoritative merge-review UI and flow. HQ-010 records the design only; current
approval behavior for other source-control operations remains unchanged. No
runtime should expose merge until it satisfies this ADR and advertises the
capability.

### Reference

The review-publication work at Orys commit
**41b59cde1184c4025957f0d3542ca46d1b1124c4** is a read-only reference for
immutable confirmation, one-use authority, and read-only reconciliation only.
Orys has no merge driver to port. Adapt those concepts to Koed's existing
source-control boundary; do not copy or port Orys code. The implementation PR
must include a brief borrow/skip note.

## Consequences

- An Agent can propose a merge without receiving source-control credentials or
  mutation authority.
- The source-control DTOs, journal, service, provider drivers, and Desktop
  approval flow need additive merge support and conformance tests.
- Unsupported providers keep the external-navigation action labeled
  `Open on <provider>`.
- A provider outcome may remain pending or unknown until authoritative evidence
  resolves it; Koed prefers visible unresolved state to a duplicate mutation.

## Alternatives considered

- Let the Agent merge with its own tools or the User's CLI session: rejected
  because that bypasses ADR 0038's runner-owned authority and exact-operation
  review.
- Treat Full access as approval: rejected because a Conversation permission
  mode cannot authorize source-control mutation.
- Retry an uncertain provider write: rejected because the original request
  may have been accepted, may be queued, or may have completed.
- Always open the PR on the provider: retained when Koed cannot safely establish
  or execute the exact merge operation; Desktop shows `Open on <provider>`.
