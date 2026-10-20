# Managed Source Control

Koed exposes source control only for the exact Git checkout assigned to a
Managed Conversation. The API and Desktop use one provider-neutral contract;
GitHub, GitLab, Bitbucket, and Azure DevOps behavior stays behind server-side
drivers.

## Authority boundary

A Git remote is discovery data, not authorization. Each usable remote requires
one exact source-control connection binding with:

- provider and canonical host;
- canonical HTTPS API origin;
- opaque account label and credential reference;
- credential generation and active/revoked state; and
- the explicit capabilities granted to that connection.

The connection metadata is private `KOED_HOME` control-plane state. The
credential value lives in the configured secure secret provider and is resolved
only for one bounded operation. It must not be placed in a remote URL, Git
configuration, environment variable, renderer message, command argument, log,
or database row.

Desktop local mutations require native confirmation. Browser mutations require
a fresh session. Personal API Tokens cannot mutate source control. Every
operation re-verifies the User, current runner assignment at the execution's
local or upstream authority, execution generation, checkout identity,
remote identity, credential generation, required capability, and expected
revision.

## Operations

The normalized contract supports remote inspection, branches, review requests,
checks, and comments. Mutations include fetch, explicit fast-forward, push of
the current execution `HEAD`, review-request creation, comments, approvals, and
change requests.

Koed never runs `git pull`. Updating a checkout is two reviewed steps:

1. fetch the selected remote with hooks and interactive credential prompts
   disabled;
2. fast-forward to the exact fetched object id, or leave merge/rebase for an
   explicit future operation.

Push cannot accept an arbitrary local source ref; it publishes the verified
execution `HEAD` to a validated branch name. Force push, local Git merge,
history rewrite, repository administration, and direct protected-branch
mutation are unavailable. Pull-request merge has a separate version-2 service
described below.

## Reviewed pull-request merge (version 2)

The strict version-1 route and DTOs remain unchanged. A Desktop explicitly
selects `/v2/managed-conversations/:executionId/source-control` to prepare,
dispatch, discover capability, or read a pull-request merge. Discovery returns
verified allowed methods when ready, or a bounded unavailability reason and
provider URL when one can be read. This route accepts only the Desktop
local credential on loopback in a local Personal deployment. The renderer or
Agent sends a minimal PR selector to Desktop main; it cannot supply credentials,
approval proof, repository identity, target, head, or readiness evidence.

Merge requires an explicit private
`KOED_HOME/config/source-control-merge-policy.json` allowlist, separate from
version-1 connection capabilities. It has `version: 1` and `repositories`
entries containing the exact `connectionId`, `remoteIdentityHash`,
`targetBranch`, and nonempty `allowedMethods` subset of `merge`, `squash`, and
`rebase`. Koed also reads the provider's repository-allowed methods. Both sets
must admit the selected method. Missing policy, unavailable data, an unsupported
provider, or an unprotected/unsupported target leaves merge unavailable; the
Desktop can open the pull request on its provider.

For now, Koed supports a narrow GitHub direct-merge path. It reads the exact
PR, repository merge settings, target branch protection, branch rules,
paginated reviews, check runs, and commit statuses. It requires positive
mergeability, a clean provider state, the required approving reviews and checks,
admin-enforced protection, and no unhandled branch ruleset. The bounded
snapshot binds account, repository, remote, runner, execution and credential
generations, PR, target, head, method, policy, reviews, checks, and protection.
An unknown or incomplete snapshot fails closed. GitLab, Bitbucket, Azure
DevOps, merge queues, and policies Koed cannot prove remain unavailable.

The server stores the prepared operation as an owner-scoped encrypted envelope
bound to its operation ID and readiness digest. Rotation uses the same
custody-checked rewrap path as other encrypted Personal records. Desktop main
displays the exact repository, PR, target, head, selected method, readiness
summary, digest, and expiry in a Native review dialog. On approval it signs a
one-use receipt with the Desktop-local credential; this proof never enters a
renderer message. The server verifies the proof and current authority,
re-reads readiness, and atomically claims the approved operation before any
provider write. Full access does not bypass Native review. A changed head,
check, review, method, target, credential or policy needs a new approval.

The durable SQL journal allows one claim per approval and fences any later
merge for the same provider PR across all Users while a predecessor is claimed, pending, or
unknown. GitHub's fixed asynchronous merge path uses the expected head SHA,
`merge_action: direct_merge`, and `bypass_rules: false`; provider protections
remain authoritative at mutation time. A provider-accepted operation is
`pending`; only authoritative merge evidence is `merged`. After a timeout or
crash, recovery reads the exact PR and operation status without resubmitting
the mutation. An open PR alone leaves the outcome `unknown`. An operation
status record that has expired or cannot be bound to the approved head and
method also remains `unknown`.

Read-only recovery may use a newer generation of the same active connection
credential, with the same provider host, API origin, account label, and
connection ID. It does not require the original execution still to run; no
later mutation is authorized by that recovery read.

Existing local Project selection establishes the source checkout used by a
Managed Conversation. Another enrolled device receives source through the
encrypted handoff/fork restoration protocol rather than a renderer-directed
clone. Hosted-runner cloning remains unavailable until the backend can select
and fence the credential, destination root, source revision, and resulting
checkout identity; it must not introduce a second credential path.

## Provider behavior

Public provider hosts have built-in driver identities. Enterprise hosts are
recognized only by an exact configured host/provider connection. Provider
requests use the configured HTTPS API origin, fixed method/path templates,
disabled redirects, bounded bodies and timeouts, and Koed's DNS-pinned secure
upstream fetch. Shared UI branches on advertised capabilities rather than a
provider name. Advertised capabilities are the connection's grants filtered by
what that remote transport and provider driver can execute. SSH remotes omit
fetch and push; Bitbucket and Azure DevOps omit formal review writes. The same
filtered capabilities govern runtime admission before credential resolution.

Desktop follows provider continuations for later review requests and comments.
Push resolves a branch beyond the first page before choosing the expected remote
revision. Standard Azure DevOps SSH remotes map to the configured public Azure
API connection. Review details and continuation pages are tied to the selected
remote and review request. Selection changes clear the previous details and
ignore late responses; review actions wait for the current details to load.

Bitbucket approvals remain unavailable because the provider approval operation
cannot bind the reviewed commit atomically. Unsupported formal review decisions
return a capability error without submitting a substitute comment.

Azure DevOps review voting remains unavailable until an exact reviewer identity
binding is present; the driver reports the unsupported capability instead of
guessing a vote identity.

## Recovery and replay

Mutations are durably journaled by User and idempotency key. Cached results
require current execution authority before replay. Local validation failures do
not enter the journal. Koed writes `dispatching` immediately before an external
or local side effect and writes the bounded result after completion. A crash in
between returns an indeterminate outcome for review rather than silently
replaying a possibly completed write.

Credential rotation or revocation invalidates queued operations through the
credential generation. A changed remote, execution handoff, checkout change,
or revision change fails closed and requires a fresh operation.
