# ADR 0035: File Access Uses Runner-Owned Rooted Capabilities

- Status: Accepted
- Date: 2026-08-18

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0017 Verified Development Workspace Snapshots](./0017-verified-development-workspace-snapshots.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)
- [0032 AI Client Instance, Capability, And Permission Contracts](./0032-ai-client-instance-capability-and-permission-contracts.md)
- [0033 Runner-Owned Worktrees And Execution Checkpoints](./0033-runner-owned-worktrees-and-execution-checkpoints.md)

## Context

Koed needs file browsing, inspection, search, and structured file mentions for
managed coding Conversations. A Project path, repository remote, branch name,
renderer-selected path, or Team-visible Conversation does not grant filesystem
authority. Local and hosted executions also place the authoritative workspace
on different runners, while a remote coordinator must not learn a local
absolute path or gain ambient access to the owning device.

Filesystem reads are security-sensitive even when they do not write. Paths can
escape through traversal, symlinks, junctions, reparse points, mount changes,
case or Unicode aliases, and time-of-check/time-of-use races. Files may contain
credentials, be too large to render safely, change while being searched, or
invoke unsafe renderer behavior when treated as HTML. A stale file mention can
also make the AI Client act on content different from what the User selected.

Koed therefore needs one file-authority boundary before adding product file
surfaces. That boundary must build on the execution workspace and checkpoint
decisions rather than create a second notion of workspace ownership.

## Decision

The execution runner that owns a verified execution-workspace binding is the
sole authority for workspace file operations. The initial capability is
read-only and consists of bounded browse, text read, text search, and structured
file mentions. Desktop, Explorer, renderers, remote coordinators, provider
adapters, and Team backends do not receive ambient filesystem access.

Every operation is authorized against all of:

- the owning Personal User;
- an authenticated browser session or enrolled device credential with the
  explicit managed-execution file-read operation family;
- the managed execution id and current fencing generation;
- the exact execution-workspace binding and runner;
- the workspace lifecycle and cleanup state; and
- the requested operation and deployment limits.

Personal API Tokens remain Memory-only and cannot use this capability. Team
Membership, Workspace Access, a Captured Session Share Grant, Conversation
Source Access, or permission to watch a shared Conversation does not grant file
access. Collaborative repository access requires a later explicit execution
collaboration grant.

For a local execution profile, Electron main may use Koed's encrypted,
owner-bound Desktop Local Credential with the exact `managed_file_read`
operation family over the loopback API. The credential never enters preload or
renderer code, is rejected on non-loopback requests, and grants no generic HTTP
or filesystem authority. Remote Desktop and browser access still require an
enrolled device credential or browser session.

### Rooted Namespace

The runner assigns one immutable logical root to an execution-workspace binding.
Its canonical device path remains runner-local. File APIs accept only normalized
root-relative paths or opaque server-issued entry identities; they never accept
absolute paths, URI schemes, Git object expressions, shell fragments, or a
caller-selected root.

Protocol paths use UTF-8, `/` separators, NFC normalization, and non-empty
components. Empty, `.`, `..`, NUL, backslash-separated, non-normalized,
overlong, duplicate-normalization, case-colliding, Windows-device, or otherwise
platform-ambiguous paths fail closed. A path is display metadata, not proof of
authority.

The runner resolves each operation beneath its already verified root using a
platform-specific no-follow implementation. It validates every component,
filesystem identity, ownership, file type, and final opened object rather than
trusting lexical prefix checks or one prior `realpath`. Root, ancestor, mount,
or file replacement during an operation invalidates the result. A platform is
supported only when its native tests prove the implementation against symlink,
junction, reparse-point, case, Unicode, mount, and concurrent-replacement
attacks.

Git administration, Koed runtime state, provider homes, credential stores, and
paths outside the logical root are never part of the namespace. The file API is
VCS-neutral; Git metadata may classify entries but does not grant access.

### Symlinks And Unsupported Entries

The initial capability never follows symlinks. Browse may return a bounded
entry with kind `symlink` and an unavailable reason, but it does not return or
resolve the link target. Junctions, reparse points, mount redirects, sockets,
devices, FIFOs, nested repository administration, submodules, and other special
entries are likewise unavailable.

This restriction applies even when a link appears to resolve inside the root.
Future link support requires a separate accepted compatibility extension with
object-handle containment and native platform evidence; it is not enabled by a
configuration flag.

### Content Policy And Bounds

Browse returns bounded metadata, not file contents. The initial read and search
surface serves regular UTF-8 text only. Binary, malformed text, unsupported
encoding, individually oversized, aggregate-oversized, deeply nested, and
excessive-result content returns stable unavailable or truncated metadata. It
is never decoded heuristically into renderer text, returned as a data URL, or
partially represented as a complete result.

Each request enforces versioned protocol ceilings and the lower deployment
limits for directory entries, depth, path length, individual bytes, aggregate
bytes, search candidates, matches, line length, response bytes, duration, and
concurrency. Pagination and continuation tokens are server-issued, scoped to
the same principal, execution generation, workspace binding, operation, and
revision, and have a short expiry. They are not offsets into an unbounded live
walk.

The existing Development Workspace Snapshot content policy is the minimum
safety floor. Git administration, ignored build/cache output, recognized
credential paths, private keys, accepted token patterns, and other hard-denied
secret material are unavailable to browse content, read, search, mentions, and
prompt attachment. A denial returns a stable redacted reason code and no match,
snippet, target, digest derived from secret bytes, or content-dependent timing
detail intended for the client. This is defense in depth, not a claim that all
secrets can be detected.

Search is implemented by the runner using a fixed, argument-safe engine and
the same rooted entry classifier. It does not invoke a shell, User aliases,
repository hooks, provider tools, arbitrary ignore files outside the root, or
renderer-supplied executable configuration. Search results contain only
bounded relative paths, ranges, and escaped text snippets from authorized
files.

### Revision Identity And Consistency

File responses are revision-bound. The server, never the renderer, derives the
revision identity.

Koed supports two explicit read classes:

1. **Checkpoint reads** resolve an immutable, server-selected execution
   checkpoint and its captured object id under ADR 0033. They are used for
   recorded historical inspection and diff-adjacent views.
2. **Live reads** resolve the current workspace through the assigned runner and
   return an opaque workspace observation plus per-entry content identity. The
   runner verifies the execution generation, workspace identity, and observed
   filesystem state before and after the bounded operation.

A directory continuation, later range read, search continuation, or file
mention that no longer matches its observation fails with a stale-revision
result. It does not silently read the new content. Live multi-file results that
cannot prove one stable bounded observation are marked unstable and discarded.
The UI may refresh explicitly; it may not splice pages from different revisions
into one apparently coherent view.

Revision tokens are opaque, short-lived capabilities. They contain or bind a
digest of the principal, execution, fencing generation, workspace binding,
operation class, checkpoint or observation, and expiry. Clients cannot
construct arbitrary Git refs, commits, filesystem generations, or paths from
them.

### Structured File Mentions

A file mention is a structured server-issued reference, not interpolated text
such as `@/absolute/path` and not renderer-provided file bytes. It binds:

- execution and fencing generation;
- workspace binding and runner;
- normalized relative path or opaque entry id;
- checkpoint or live observation;
- exact content identity;
- optional bounded line or byte range; and
- issuing principal, purpose, and expiry.

On prompt submission, the execution runner reauthorizes and re-resolves the
mention, verifies the exact content identity and range, applies current content
policy, and supplies bounded content directly to the provider adapter. A stale,
revoked, moved, newly secret, or unavailable mention fails rather than attaching
different content. Prompt text and renderer state never become authority for
the attachment.

### Renderer And Transport Boundary

The renderer receives typed escaped data through the shared client runtime. It
does not receive Node filesystem APIs, native file handles, `file://` URLs,
absolute runner paths, Git administrative paths, provider credentials, or a
general local HTTP file server. Syntax highlighting and diff presentation must
treat file content as inert text; grammars, language services, previews, and
extensions cannot execute content.

The owning User may inspect files from another enrolled device only through
the same authenticated, runner-authorized capability. Local runner operations
remain local-edge operations. If the coordinator and runner differ, the
coordinator issues a narrowly scoped durable operation to the current runner
and relays only the bounded response over the accepted realtime transport. It
does not persist local absolute paths or acquire a reusable filesystem
credential.

Content, snippets, file names when sensitive, and revision capabilities do not
enter logs, analytics, metrics, traces, queue diagnostics, audit summaries, or
support views. Operational telemetry is limited to redacted operation class,
status, reason code, byte/result buckets, duration, runner class, and capability
version.

### Cache And Lifecycle

Server and client caches are bounded by principal, execution generation,
workspace binding, revision, content-policy version, and authorization floor.
They are invalidated by execution handoff, generation change, workspace
cleanup, device revocation, access suspension, policy change, or expiry.
Remote decrypted file content is memory-only unless a later explicit offline
file-cache decision provides encryption, revocation, and purge semantics.

Settling, snoozing, or hiding a Conversation does not revoke file authority.
Stopping an execution may preserve checkpoint reads while disabling live reads.
Workspace cleanup, orphaning, ownership mismatch, or deletion disables both
classes except any separately retained Personal Development Workspace Snapshot
that has its own authority.

### Future Writes

The read capability cannot be widened into writes by adding an HTTP method or
operation enum. Future file mutation requires a separate accepted decision and
capability with, at minimum:

- explicit execution and workspace ownership;
- an expected revision and content digest;
- current fencing and provider-quiescence checks;
- bounded atomic replacement without symlink following;
- file mode, newline, encoding, rename, deletion, and conflict semantics;
- pre-write recovery checkpoint and post-write verification;
- different policy for Koed-managed and User-managed workspaces;
- idempotency, audit, rollback, and crash recovery; and
- separate Team collaboration and remote-runner authorization.

Source-control operations, patch application, provider tool writes, terminal
commands, preview automation, Development Workspace Snapshot materialization,
and file writes remain distinct authorities even when they affect the same
workspace.

## Required Evidence

The rooted read implementation must prove:

- owner access and denial for another User, Team member, Personal API Token,
  revoked device, stale execution generation, and wrong runner;
- traversal, absolute path, URI, normalization, case-collision, symlink,
  junction, reparse-point, mount, special-file, and concurrent-replacement
  rejection on each claimed native platform;
- secret path/content, ignored output, Git administration, binary,
  unsupported encoding, large file, aggregate limit, timeout, and result-limit
  behavior;
- stable browse pagination, range reads, search continuation, stale revision,
  checkpoint reads, and live mutation detection;
- file-mention issue, prompt-time reauthorization, exact-content attachment,
  expiry, policy change, and stale-content rejection;
- local runner, hosted runner, and remote coordinator routing without absolute
  path or content leakage;
- renderer isolation, inert rendering, cache invalidation, reconnect, handoff,
  cleanup, and revocation; and
- logs, metrics, traces, diagnostics, queues, and audit summaries remaining
  content-free.

Native compatibility evidence covers Linux, WSL on a Linux filesystem, WSL on
DrvFS, macOS, and Windows before each platform is claimed. Missing evidence is
an explicit unsupported platform state.

## Consequences

- Koed gains one authority model for local and hosted file inspection without
  exposing ambient filesystem access.
- Recorded checkpoint inspection and current live inspection remain honest,
  separate read classes.
- Common symlinked or ignored development content may be unavailable in the
  initial product even when the User can inspect it outside Koed.
- Secret detection and strict bounds trade some convenience for a smaller
  remote and renderer attack surface.
- File writes, Team repository collaboration, previews, terminals, and source
  control require their own authority rather than inheriting read access.

## Rejected Alternatives

- Giving Desktop, Explorer, or a renderer direct filesystem or `file://`
  access.
- Treating a Project path, Git remote, Team Share Grant, or Conversation access
  as filesystem authorization.
- Sending local absolute paths to a remote coordinator.
- Accepting caller-selected roots, arbitrary Git refs, or renderer-provided
  revision ids.
- Checking only lexical path prefixes or one `realpath` before a later open.
- Following symlinks that currently appear to stay inside the root.
- Returning arbitrary binary/large files and relying on the renderer to cope.
- Treating stale file mentions as best-effort references to current content.
- Reusing the read API as a generic write, patch, terminal, preview, or
  source-control endpoint.
