# Managed Source Control

Koed exposes source control only for the exact Git workspace assigned to a
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
operation re-verifies the User, execution generation, workspace identity,
remote identity, credential generation, required capability, and expected
revision.

## Operations

The normalized contract supports remote inspection, branches, review requests,
checks, and comments. Mutations include fetch, explicit fast-forward, push of
the current execution `HEAD`, review-request creation, comments, approvals, and
change requests.

Koed never runs `git pull`. Updating a workspace is two reviewed steps:

1. fetch the selected remote with hooks and interactive credential prompts
   disabled;
2. fast-forward to the exact fetched object id, or leave merge/rebase for an
   explicit future operation.

Push cannot accept an arbitrary local source ref; it publishes the verified
execution `HEAD` to a validated branch name. Force push, merge, history rewrite,
repository administration, and protected-branch mutation are unavailable.

Existing local Project selection establishes the source checkout used by a
Managed Conversation. Another enrolled device receives source through the
encrypted handoff/fork restoration protocol rather than a renderer-directed
clone. Hosted-runner cloning remains unavailable until the backend can select
and fence the credential, destination root, source revision, and resulting
workspace identity; it must not introduce a second credential path.

## Provider behavior

Public provider hosts have built-in driver identities. Enterprise hosts are
recognized only by an exact configured host/provider connection. Provider
requests use the configured HTTPS API origin, fixed method/path templates,
disabled redirects, bounded bodies and timeouts, and Koed's DNS-pinned secure
upstream fetch. Shared UI branches on advertised capabilities rather than a
provider name.

Azure DevOps review voting remains unavailable until an exact reviewer identity
binding is present; the driver reports the unsupported capability instead of
guessing a vote identity.

## Recovery and replay

Mutations are durably journaled by idempotency key. Local validation failures do
not enter the journal. Koed writes `dispatching` immediately before an external
or local side effect and writes the bounded result after completion. A crash in
between returns an indeterminate outcome for review rather than silently
replaying a possibly completed write.

Credential rotation or revocation invalidates queued operations through the
credential generation. A changed remote, execution handoff, workspace change,
or revision change fails closed and requires a fresh operation.
