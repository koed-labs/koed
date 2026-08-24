# ADR 0038: Source-Control Credentials Are Runner-Owned Capabilities

- Status: Accepted
- Date: 2026-08-19

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0033 Runner-Owned Worktrees And Execution Checkpoints](./0033-runner-owned-worktrees-and-execution-checkpoints.md)
- [0035 File Access Uses Runner-Owned Rooted Capabilities](./0035-runner-owned-rooted-file-authority.md)
- [0036 Terminals Are Runner-Owned Scoped Executions](./0036-runner-owned-scoped-terminal-authority.md)

## Context

Managed coding needs to inspect repository state and eventually fetch, push,
open or review a pull request or merge request. A Git remote identifies a
possible repository endpoint; it does not grant network access, select an
account, prove repository ownership, or authorize mutation. Personal API
Tokens, Team Membership, Workspace Access, Share Grants, Conversation access,
terminal access, file-read access, and AI Client credentials likewise grant no
source-control authority.

Credentials may already exist in a provider CLI, SSH agent, operating-system
credential store, browser OAuth session, hosted provider application, or
Operator-managed secret store. Reading tokens out of those systems, inheriting
ambient credential environment variables, or exposing a generic Git/HTTP proxy
would make managed execution an uncontrolled credential-exfiltration path.
Local and hosted runners require different credential custody, but they must
implement the same bounded operation contract.

## Decision

Koed adds a provider-neutral Source-Control Driver boundary. The initial
provider drivers are GitHub, GitLab, Bitbucket, and Azure DevOps, including
explicitly configured enterprise hosts. Provider-specific API behavior stays
behind that boundary; shared API, Desktop, audit, and approval surfaces use
common source-control records and operations.

Every operation binds:

- the owning User and current authenticated principal;
- the exact managed execution and fencing generation;
- the assigned runner deployment and device;
- the verified execution-workspace and repository identities;
- one normalized remote id, provider, host, account binding, and repository
  locator;
- an explicit capability such as repository read, fetch, push, pull-request
  read, comment, review, or create;
- the expected local and remote revision where mutation is possible;
- an idempotency key, policy version, expiry, and current credential generation;
  and
- the applicable User approval or Action Grant.

The renderer receives typed status and result DTOs only. It never receives a
credential, credential reference, authorization header, SSH agent socket,
provider CLI configuration, absolute repository path, arbitrary API URL, or
generic command surface.

### Remote And Repository Identity

The runner discovers remotes through Git using argument arrays and disabled
hooks, not by parsing `.git` files or shell output. Credential-bearing remote
URLs are rejected and redacted. SCP-style SSH and HTTP(S) URLs normalize to a
provider, host, namespace, repository, and transport without retaining user
info, query, fragment, or token material.

Multiple remotes, forks, changed remotes, linked worktrees, local-only
repositories, and multiple repositories beneath one Project remain distinct.
Koed never assumes `origin`, the first remote, a GitHub hostname, or a Project
folder is authoritative. The User selects a remote/account binding when more
than one verified candidate exists. A changed remote invalidates the binding
until it is reviewed again.

Provider matching uses an explicit configured host registry. Public GitHub,
GitLab, Bitbucket Cloud, and Azure DevOps hosts have built-in driver identity;
enterprise hosts require an Operator or User connection that declares the
provider and canonical HTTPS API origin. Hostname suffix matching, redirects to
new hosts, DNS results, and remote-provided API links do not extend authority.

### Local Credential Custody

For a local runner, source-control credentials remain on that device. Desktop
main owns connection setup and stores Koed-created OAuth or token material
through the established platform-secure secret-provider boundary: Keychain on
macOS, DPAPI on Windows, and Secret Service/KWallet or the approved WSL bridge
on Linux/WSL. Unsafe or unavailable secure storage fails closed while local
non-network Git operations remain available.

Existing provider CLI or SSH-agent sessions may be used only as delegated
credential providers after explicit User selection. Koed may ask a supported
CLI whether a named host/account is authenticated and may invoke an exact
allowlisted provider operation without extracting its token. It does not parse
general CLI configuration, copy credentials into Koed storage, inherit
credential-like environment variables, or expose the CLI to renderer or AI
Client input. An SSH agent binding names an exact host, repository, account,
and public-key fingerprint; Koed never reads private-key bytes.

Git network operations use a short-lived runner credential broker. Secrets are
delivered through a private pipe or process-local askpass helper, never command
arguments, repository config, remote URLs, inherited AI Client environment, or
durable files. Prompts are disabled. Helper processes and pipes are destroyed
after each bounded operation.

### Hosted Credential Custody

Hosted runners use provider-application or installation credentials where the
provider supports them. GitHub App, GitLab OAuth/application, Bitbucket OAuth
consumer/workspace, and Azure DevOps application identities are preferred over
long-lived Personal Access Tokens. Installation and refresh material is
envelope encrypted under the deployment's configured key provider; decrypted
credentials exist only in the source-control service process for the bounded
operation and are never delivered to the AI Client, generic worker jobs,
Desktop, or a remote coordinator.

A provider installation is scoped to an explicit User or Team account and
repository set. Team Workspace access does not select or widen it. Hosted
execution reauthorizes current User, Team, repository, entitlement, execution,
and credential state for every operation. BYOK or deployment-key changes rotate
envelopes without changing the source-control identity record.

Self-hosted deployments may configure their own provider applications and key
provider. Missing provider credentials produce an unavailable capability, not
a fallback to an Operator shell, process environment, shared machine account,
or anonymous write.

### Operation And Approval Policy

Read-only local status, exact diff, remote metadata, pull-request details, and
checks use the relevant read capability. Network fetch and clone are explicit
operations. Pull is represented as fetch plus an explicit, revision-checked
fast-forward or merge/rebase choice; Koed never runs an ambiguous `git pull`.

Push, branch publication, pull-request creation, comments, reviews, merge,
close, reopen, label, reviewer assignment, and destructive branch actions are
separate mutations. Each mutation requires an expected head object id and
remote state, an idempotency key, current credential generation, and the
approval tier from ADR 0024. Force push, history rewrite, protected-branch
changes, merge, repository administration, secrets, workflows, package
publication, and deploy-key management are unavailable until separately
designed and approved.

AI Clients may propose a structured operation but cannot choose credentials,
hosts, accounts, repository ids, arbitrary refs, arbitrary provider endpoints,
or approval outcomes. Koed derives those fields from current verified state.
An operation that becomes stale returns a stable conflict and must be reviewed
again; it is not silently rebased, redirected, or retried against newer state.

### Provider-Neutral Contract

The common driver declares capabilities rather than pretending all providers
are identical. The shared contract covers:

- authenticated host/account status and revocation generation;
- repository and default-branch metadata;
- verified remote refs, fetch, clone, and revision-bound push;
- pull-request or merge-request list, detail, diff metadata, checks, comments,
  reviews, creation, and lifecycle actions; and
- stable unsupported, unavailable, stale, rate-limited, and authorization
  outcomes.

Provider-specific concepts are returned as bounded typed extensions only when
the capability declaration advertises them. Shared UI branches on capabilities,
not provider names. Public web URLs are display/navigation data and are opened
only through the existing HTTPS external-navigation adapter; API origins remain
main-process or server-side authority.

### Network And Data Boundary

Direct provider HTTP clients use fixed methods and path templates against the
configured canonical API origin. Redirects are disabled. DNS and resolved
addresses are checked by the secure-fetch boundary; loopback, private,
link-local, metadata, changed-host, credential-bearing, and non-HTTPS targets
fail closed except for an explicitly approved local development fixture.
Response sizes, pages, timeouts, concurrency, and retry windows are bounded.
Provider rate limits are surfaced and do not trigger uncontrolled retry.

Diffs and source content continue through the runner-owned checkpoint and file
boundaries. Provider responses cannot introduce an arbitrary local path or Git
object id. Comments and review text are untrusted remote content and use the
same inert rendering and size limits as other external text.

### Redaction, Audit, And Revocation

Logs, metrics, traces, queues, durable events, diagnostics, audits, and error
messages may contain only opaque binding/operation ids, provider class, host
class, capability, status, reason code, duration bucket, and rate-limit bucket.
They exclude tokens, authorization headers, credential references, remote URLs
with user info, SSH sockets, key material, repository paths, diff content,
comment bodies, and provider response bodies.

Audits record connection, operation proposal, approval, dispatch, completion,
failure, credential rotation, and revocation. They do not become operation
authority.

Disconnect or revocation increments the credential generation, cancels queued
and in-flight operations where possible, destroys cached access tokens, and
fails future authorization. Removing Team access, changing repository access,
execution handoff, runner fencing, remote change, provider-app uninstall, SSO
loss, token expiry, or secure-store loss has the same fail-closed effect.
Revocation does not delete User commits or rewrite remote history.

## Required Evidence

The implementation must prove:

- local-only, multiple-remote, fork, changed-remote, linked-worktree, nested
  repository, SSH, and HTTP(S) identity behavior;
- exact account/repository binding and denial for another User, Team,
  Workspace, runner, execution generation, remote, host, or credential
  generation;
- no token extraction or leakage through renderer IPC, AI Client environment,
  process arguments, Git config, URLs, logs, diagnostics, queues, or errors;
- secure-store unavailable, CLI unauthenticated, SSH-agent unavailable,
  credential expiry, rotation, provider uninstall, SSO loss, and revocation;
- redirect, DNS rebinding, private/link-local/metadata target, oversized
  response, pagination, timeout, rate-limit, and malformed-provider denial;
- revision-bound idempotent fetch, clone, push, create, comment, and review,
  including stale-head and duplicate-delivery behavior;
- common contract conformance for GitHub, GitLab, Bitbucket, and Azure DevOps,
  with unsupported capabilities reported honestly; and
- Linux/WSL, macOS, and Windows credential/process behavior before each local
  platform is claimed.

## Consequences

- Local and hosted runners can offer the same source-control product contract
  without moving local credentials to Koed Cloud.
- Provider drivers remain replaceable and shared UI does not encode one
  provider's vocabulary as the domain model.
- Existing CLI and SSH sessions can be delegated safely, but never become
  ambient authority inherited by every managed process.
- Mutation requires more explicit state and approval than a shell command, but
  failures are explainable, replay-safe, and revocable.
- Repository source control remains separate from Personal Memory, Team Memory,
  Conversation sharing, terminal access, and general filesystem access.

## Rejected Alternatives

- Passing provider tokens, SSH sockets, or credential environment variables to
  the renderer or AI Client.
- Reading tokens out of provider CLI stores or copying them into Koed.
- Treating a remote URL, Team Membership, Workspace Access, Share Grant, or
  terminal permission as source-control authorization.
- Running renderer-supplied Git, provider CLI, shell, HTTP, GraphQL, or URL
  operations.
- Using one shared machine or Team credential without a User/repository binding.
- Storing credentials in repository config, remote URLs, environment files,
  command arguments, logs, queues, or database plaintext.
- Implementing only GitHub-shaped domain objects and adding provider branches
  throughout shared UI.
- Automatically pulling, rebasing, force-pushing, merging, or rewriting remote
  history to resolve stale state.
