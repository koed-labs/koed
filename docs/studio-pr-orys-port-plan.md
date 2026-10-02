# Current PR implementation scope (2026-10-02)

The User approved a unified feature covering former integration Tickets 16–18.
The existing Studio PR prototype defines the user flow and presentation. Orys at
`bb94822abf0c989a1840a028666ccb5652efea5d` is a code reference only.
This section supersedes conflicting scope assumptions in the historical plan below.

- Reuse an explicitly selected supported GitHub CLI account; offer browser sign-in
  when needed. Keep credentials on the selected authorized computer.
- Browse a combined authored/requested-review inbox with separate filters and
  authorized repository selection, including bounded details, code, checks and discussions.
- Assign PR work to owned Agents through existing managed Conversations and Jobs.
  Preserve private chat and encrypted history across revisions, restarts and devices.
  Multiple Agents can review independently with separate Jobs and review drafts.
- Offer verified matching Project context; a Project is not required. Review exact
  base/head revisions in an isolated checkout, preserving the user's Project files.
- Team Project review Jobs follow existing Public Square sharing rules. Personal
  Jobs remain private and appear in Home and Agents activity.
- Review is read-only by default. Explicit fix requests use existing permissions.
  Normal branch pushes require inspecting and confirming exact changes. No merge
  or non-fast-forward push feature is included.
- Support Comment, Approve and Request changes with selected inline findings,
  draft editing and exact-content confirmation. Revalidate account, repository,
  permissions and revisions before dispatch. Reconcile uncertain writes instead
  of blind retries.
- New commits mark reviews outdated. The User explicitly initiates another review.
  Existing authorized Memory can inform work, but findings need current code evidence;
  private Memory content/citations are not automatically posted to GitHub.
- Web Studio uses the existing authorized local runner gateway, including offline
  Pending work and cancellation before claiming. Browser code receives no secrets.

Pipeline editors, extra notification designs and other Orys UI additions are not
requirements of this implementation. Existing Agent/tool wiring remains authoritative.
The API enforces permission and publication checks independently of disabled controls.

## Historical reference plan

# Orys to Koed: Pull Requests integration plan

Status: incremental implementation; contracts, local identity, PR browsing and local PR chat are implemented in the Studio prototype.
Date: 2026-09-22.
Reference: `koed-labs/orys` main at `bb94822abf0c989a1840a028666ccb5652efea5d`.

## Agreed direction

Retain Koed Studio's imported Personal UI and port Orys's review capabilities
incrementally into the TypeScript stack. Preserve behaviour and safety contracts,
not Rust syntax or macOS-specific infrastructure. Use Luna High implementation
subagents for bounded slices, followed by independent validation.

All Orys product capabilities belong in the inventory. They need not all ship in
the first slice. Desktop notifications are explicitly included. Home and New Chat
remain parked while we establish this integration.

Two boundaries are mandatory:

1. Discussion is not publication. Chat, reviews and notifications cannot post to
   GitHub or approve a PR without explicit user confirmation of an exact payload.
2. Memory informs review; the current code remains the evidence for code claims.
   Preserve an independent first review pass without supplied memory or earlier
   reviewers' findings. Later passes can use authorized memory with provenance.

## Ownership and runtime boundaries

| Boundary             | Responsibility                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Studio renderer      | Existing Plugins/PR UI, transient selection, draft editing and typed commands; no secrets, process spawning or canonical review state.           |
| GitHub connector     | Account identity, repository access, observations, rate limits and authenticated GitHub requests. Read and publish capabilities remain distinct. |
| Shared review domain | Versioned contracts, stage graph, immutable run scope, findings, drafts, freshness and legal lifecycle transitions.                              |
| Runner adapter       | Local Desktop or authorized remote execution, checkout isolation, AI Client supervision, cancellation and resource limits.                       |
| Publication service  | Revalidate scope/access, freeze exact payload, consume single-use authority, publish once and reconcile uncertain outcomes.                      |
| Notification adapter | Desktop delivery and click routing from durable, authorized review events; never authority to execute or publish.                                |

Reuse Koed's managed-conversation contracts where they satisfy the same guarantees.
Do not create a second AI execution engine by default. Orys's sealed checkout,
pipeline evidence and publication authority still require explicit review-domain
contracts; a successful managed conversation is not proof of a valid review.

Desktop may use local execution and OS credential facilities. A web browser needs
an authenticated remote runner and server-side credential storage; it cannot
inherit local filesystem, Keychain or process APIs. Define adapters now without
implementing a multi-tenant review service implicitly. The current Studio gateway
is read-only and is not a sufficient authorization boundary for new writes.

Keep pipeline state/evidence authoritative and UI/search indexes rebuildable.
Choose persistence after inspecting existing Koed transaction and ownership
patterns. Do not copy Orys's signed-file storage into SQL mechanically or lose its
atomicity, integrity checks and recovery guarantees in the translation.

## Feature map and delivery slices

| Slice                    | Capabilities                                                                                                                                     | Existing surface / required work                                             | Acceptance gate                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0. Contracts             | Identity, review run, evidence, finding, draft, publication and event schemas                                                                    | New review-domain contracts; inspect managed-conversation reuse              | State-machine and compatibility tests before real side effects                                                      |
| 1. GitHub plug-in        | Connect, validate identity/access, select repository scope, reconnect, disconnect, connection health                                             | Wire existing GitHub tile in prototype Plugins page; no new catalogue design | No credentials in renderer/storage/logs; disconnect and identity changes invalidate stale requests                  |
| 2. PR browsing           | Requested reviews, authored PRs, search/filter, pagination, details, comments, CI, history links                                                 | Port existing PR list/detail design and replace placeholders                 | Authored/Reviewing use actual viewer/review identity; incomplete sync cannot remove valid PRs                       |
| 3. Review execution      | Exact base/head scope, isolated checkout, stages, bounded scheduling, progress, approvals, cancellation, resume/retry                            | Small status/action additions in PR detail                                   | Changed head creates a new run; crash/cancel/timeout cannot yield Ready or approval                                 |
| 4. Findings              | Severity/status, evidence, causes, impact, requested fixes, completion criteria, deduplication and prior-comment reconciliation                  | Review results within current detail pane                                    | One canonical finding model drives views/reports; no repeated stale or already-resolved comments                    |
| 5. Publication           | Editable revisioned draft, finding inclusion, action selection, preflight, inline anchors/fallbacks, exact confirmation, receipts/reconciliation | Wire Submit review; confirm final action and content                         | Stale/revoked requests fail closed; ambiguous network outcome never causes a blind second POST                      |
| 6. Memory and discussion | PR-scoped chat, source-linked relevant decisions, discussion of findings                                                                         | Existing Chat tab; per-PR draft and conversation state                       | Suggestions populate, never autosend; memory access checked at retrieval and publication; no cross-PR draft leakage |
| 7. Notifications         | Desktop alerts, preferences, deduplication and PR deep links                                                                                     | OS notification plus existing in-app state                                   | Permission denied or delivery failure never blocks review; click never authorizes an action                         |
| 8. Pipeline tools        | Default pipeline, graph editor, skill discovery, import/export, immutable versions                                                               | Reuse existing settings patterns; add editor only where needed               | Strict schema/DAG validation; running review retains its frozen pipeline despite edits                              |
| 9. Operations            | History/report export, evidence deletion, diagnostics, startup/wake recovery, cleanup, notification recovery                                     | PR history/settings and existing app lifecycle                               | Historical evidence survives checkout cleanup; deletion never deletes GitHub data; diagnostics exclude secrets      |

Notifications should first become functional with the review execution/results
slice, not wait for every pipeline-editor feature. Numeric slice order expresses
dependencies, not a requirement to postpone all work in later rows.

## GitHub plug-in scope

The imported prototype already lists GitHub, but that is not a working connection.
Show account, authorized scope, last successful sync and actionable connection
failures. Keep connection grants separate from Koed Memory Share Grants.
Support bounded pagination, cancellation, last-known-good observations and stale
identity fencing. Preserve Orys's distinction between no longer eligible and an
unavailable/rate-limited observation.

Orys currently uses a fine-grained token. Decide the first Koed credential flow
before implementation; evaluate a native personal-token flow for local testing
versus a GitHub App-based flow for the hosted product. Do not make a token entered
into browser storage the shortcut. Provider permissions and hosted callback flows
must be verified against current GitHub documentation before implementation.

The prototype's All tab needs a bounded definition: PRs in the connected, selected
repository scope, not all PRs visible anywhere on GitHub. Requested-review
eligibility must remain distinct from broader browsing and authored PRs. Human
approval, GitHub CI status and AI review verdict are separate states.

## Desktop notifications

Proposed initial events: newly requested review, review ready, user input/approval
needed, terminal failure requiring action, stale reviewed head, and confirmed
publication result. These are the target Koed set; audit Orys's implemented set
before claiming parity. Suppress routine stage updates and non-actionable polling.

- Offer explicit notification enablement; respect OS permissions and quiet hours.
- Default to silent notifications. Sound, if offered, requires a separate opt-in.
- Provide event-category preferences and a privacy mode that hides repository,
  PR title, author and finding content on the lock screen.
- Deduplicate by identity, run/episode, event kind and relevant state version;
  repeated polling, retries and restart must not resend the same alert endlessly.
- Route clicks using validated internal IDs. Recheck account and repository
  authorization; unavailable/deleted/stale targets must have an honest fallback.
- Never include tokens, diffs, raw memory evidence or executable action payloads.
- A delivered notification is not proof of successful review/publication.
- Persist delivery intent separately from review truth. OS delivery is best effort;
  in-app state is the durable fallback. No claim of exactly-once OS delivery.
- Browser notifications are a separate capability/permission path. Web users retain
  in-app status even when native desktop notifications are unavailable.

## Memory-enhanced review policy

Supply bounded, permission-checked evidence to a designated later context pass or
PR discussion, not indiscriminately to every independent review pass. Record the
source and retrieval time. Distinguish historical decisions from current accepted
decisions; investigate contradictions rather than automatically preferring memory.
Treat repo text, PR comments and recalled material as untrusted input.

A user seeing private memory does not authorize posting it to a public PR. The
publication draft must make any quoted sensitive context visible for deliberate
review and respect source permissions. Keep private discussion and publishable
findings separate. Self-hosted synthesis stays with the AI Client, not backend LLM
calls. Do not automatically turn approval-operation telemetry into semantic Memory.

## Porting and validation method

For each slice, record source modules, public contracts, target ownership, Orys
test cases to preserve, UI changes and remaining gaps. Use synthetic GitHub and
runner fixtures first. Run the old/new contract cases against matching inputs when
possible, then sandbox-repository integration tests before production use.

Required fault coverage includes changed heads, duplicate commands, partial
pagination, revoked credentials, identity changes, stale draft revisions, malformed
pipelines, failed stages, approval waits, cancellation, process crashes, restart,
tampered/missing evidence, ambiguous publication and notification click after
disconnect. Validate Desktop and web capability differences explicitly.

Do not port the Tauri menu-bar shell, release signing or autostart implementation
as a second Koed shell. Map their useful behaviour to Koed's existing app lifecycle.
Preserve applicable license/attribution when adapting code. The original planning
pass added no runtime code. Implementation progress is tracked below; no Linear
ticket or release metadata has been created.

## Implementation progress

The first local slice adds pure review contracts and an explicit GitHub identity
connection via the operator's existing GitHub CLI sign-in, approved by the user.
That initial connector made only a fixed authenticated `/user` read. It exposes account
status without credentials and does not claim repository permissions. Secrets
are used transiently, not retained as connection state. Disconnect clears local
identity status without logging out GitHub CLI. Restart starts disconnected.

Plugins has separate live and labelled demo paths. Connection commands require
an expiring origin-bound CSRF token, strict JSON payloads and loopback origin
validation. Tests use injected credentials/provider responses, not real tokens.
These are local single-operator controls, not SaaS authentication.

Validation: 45 tests pass, along with the Studio build, typecheck and targeted
lint. Browser checks covered demo isolation, Home/New Chat navigation, and a
live read-only identity connection using the existing GitHub CLI sign-in.
The live connection was disconnected after the smoke test. No GitHub content
was published or modified.

Review contracts are advisory typed state helpers, not authorization for external
actions. The trusted publication service must still validate current access,
sealed evidence and consume durable authority. PR discovery, execution, posting,
memory discussion and desktop notifications were not implemented in that slice.

The next bounded slice adds repository selection, paginated PR lists and PR
summaries. Every read reacquires a transient CLI credential, verifies the
connected identity and uses fixed GitHub API paths. Disconnect and identity
changes fence pending responses. All means the selected repository, not every
repository on GitHub. Authored uses author identity; Reviewing uses direct
requested-reviewer identity, not merely open status. Team-based review requests
need a later membership-aware implementation.

Search and tabs apply to loaded pages only. Pagination is explicit and bounded;
an error is not an authoritative empty result. This is not yet a durable sync or
review history. Comments, CI, diff inspection and reviewed-by-me history remain
follow-ups before full browsing parity. Execution and publishing stay disabled.
The existing list/detail composition is retained, with live and isolated demo
paths. Electron opens only validated HTTPS GitHub PR links in the system browser.

Read-only slice validation: 52 automated tests pass. Production build, typecheck
and targeted lint pass. Browser checks covered live repository selection, PR
details and pagination through 60 PRs; demo tabs and repository changes without
GitHub requests; temporary-failure retention; account-change clearing; and
narrow-window detail/back navigation without horizontal overflow. No GitHub
writes were performed. The desktop external-link policy has unit coverage;
native OS browser launch was not exercised in this browser validation.

Provider references checked for this slice:
[GitHub CLI token lookup](https://cli.github.com/manual/gh_auth_token) and
[authenticated user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user),
[repository listing](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
and [PR reads](https://docs.github.com/en/rest/pulls/pulls).

## Next implementation gate

### Initial PR Chat integration

The next slice connects explicit PR questions to the existing isolated Codex
app-server runner. It is not an automated review pipeline or GitHub publication.
The connector supplies a bounded description and changed-file patches and checks
the base/head again after collection. The runtime binds history to the connected
GitHub identity, repository, PR, base and head. It revalidates access and commits
after generation before retaining or returning a reply.

The renderer never supplies authoritative PR text, local paths, executable
arguments, credentials or permission modes. It sends only validated scope,
question and request ID through an origin/CSRF-protected local route. Repeated
request IDs must not execute twice or accept a different question. Runtime and
context failures never generate a synthetic reply in live mode.

The initial chat runs in read-only mode with an empty working directory,
credential-filtered environment, no inherited MCP/hooks/project instructions,
disabled execution tools and no tool network access. Read-only is the default.
Ask-before-run and Full access use a temporary local PR checkout pinned to the
validated head SHA. Both are confined to that checkout with a workspace-write
sandbox and no network; Ask-before-run additionally pauses for per-action user
approval, while Full access does not prompt for actions inside the checkout.
Neither mode grants GitHub comments, approvals, pushes, merges or other
publication authority. Checkouts are removed when the Studio server closes.

When a user selects or mentions a Personal Agent, the local runtime rechecks
its active version and Codex model preference, retrieves bounded authorized
Personal Memory, and supplies its soul and evidence to that PR turn. Replies
persist an explicit author identity rather than inferring the author from the
currently selected Agent. PR chat currently accepts Codex-backed Agents only;
unsupported providers are rejected instead of silently switched. Koed Memory
recall is never inherited through MCP or hooks.

History and request receipts are bounded, in-process preview state, not durable
conversation storage. Service restart clears them. Stopping the browser wait
does not guarantee cancellation of provider work; retries must keep the original
request ID. Hosted authentication, GitHub App installation, persistent
conversations, full review execution and review publication remain separate
implementation gates.

After validating repository selection and basic PR reads, add comments, CI and
history observations before claiming full browsing parity. Local testing uses
the approved existing CLI sign-in. Resolve hosted credentials and local versus remote runner support before
enabling execution side effects.
Keep the first implementation Personal/local; Team-wide review ownership and
shared publication authority need a separate authorization design.

## Source inventory and parity notes

### Local PR Chat validation

The initial Chat integration was exercised against a real Koed pull request through
Plugins, repository selection, PR detail and Chat. The isolated AI Client returned
a response from the supplied PR patches. Switching to a different PR showed a
separate conversation; returning restored the original discussion. Demo Chat
filled the composer from a suggestion and returned an explicitly synthetic reply
without making any Studio API requests. GitHub publication was not invoked.

The preview is not durable conversation storage: restarting the Studio service
clears its in-process history. Authorized Koed Memory context, hosted GitHub App
authentication and standalone packaged runtime dependencies remain follow-up work.

The read-only source audit identified these implemented reference points. Paths
below are relative to `koed-labs/orys`, not Koed's integration branch.

| Feature                   | Orys source anchors                                                                           | Porting notes                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub identity/discovery | `apps/orys/src-tauri/src/github/mod.rs`, `github/credentials.rs`, `app.rs`                    | Discovery includes requested and authored searches; the review-eligibility model is narrower. Preserve pagination, bounded responses, no redirects, generation fencing and last-known-good cache. |
| Inbox and operations      | `apps/orys/src/views/inbox.ts`, `src-tauri/src/domain/projection.rs`                          | Review, Cancel, Resume, Retry, Allow once/Deny and console are distinct actions. Preserve legal-state predicates rather than inferring them from labels.                                          |
| Scope and checkout        | `apps/orys/src-tauri/src/workspace.rs`, `app/review_run.rs`                                   | Exact commits, detached worktree, scope/patch hashes, ownership checks and credential-isolated Git access are execution prerequisites.                                                            |
| Pipeline execution        | `apps/orys/src-tauri/src/native_pipeline.rs`, `codex_runner.rs`, `codex_protocol.rs`          | One global review lease, up to two ready stages, separate fresh contexts, explicit evidence inputs, bounded output and attempt-scoped approvals.                                                  |
| Pipeline designer         | `apps/orys/src/views/pipeline-studio.ts`, `pipeline/canvas.ts`, `src-tauri/src/pipeline.rs`   | Graph editing, skills, dependency/input edges, YAML preview, undo/redo and draft recovery exist. Validation and canonical digest belong to the trusted host.                                      |
| Pipeline catalogue        | `apps/orys/src-tauri/src/storage/pipeline_catalog.rs`, `ipc.rs`                               | Strict import preview/confirmation, immutable versions, deduplicated definitions, selected entry protection and atomic export.                                                                    |
| Review draft              | `apps/orys/src/views/review.ts`, `src-tauri/src/app.rs`                                       | Optimistic revision checks, editable summary/finding bodies and inclusion do not mutate canonical findings.                                                                                       |
| Publication               | `apps/orys/src-tauri/src/publication/`, `app/publication_broker.rs`, `github/publication.rs`  | Exact payload/anchor validation, consumed authority before mutation, receipts, and GET-only recovery after ambiguity.                                                                             |
| Storage and recovery      | `apps/orys/src-tauri/src/storage/`, `lifecycle.rs`                                            | Atomic versioned records, integrity/ownership checks, quarantine, rebuildable SQLite projection and startup/wake barriers.                                                                        |
| History and cleanup       | `apps/orys/src/views/history.ts`, `history-review.ts`, `src-tauri/src/workspace.rs`, `ipc.rs` | Markdown reports, historical results, publication reconciliation, explicit local evidence deletion and resumable cleanup.                                                                         |
| Notifications             | `apps/orys/src-tauri/src/storage/notifications.rs`, `lib.rs`, `apps/orys/src/main.ts`         | Current triggers are NeedsReview, Ready, Failed and Stale. First observation is silent; ledger claims precede best-effort OS delivery. Native clicks route to a review or Inbox.                  |
| Diagnostics               | `apps/orys/src/diagnostics.ts`, `src-tauri/src/lifecycle_log.rs`                              | Allowlisted diagnostic preview, index rebuild, bounded private logs and sanitized failure help. No telemetry or automatic uploads.                                                                |

Important differences between parity and proposed Koed additions:

- Orys has no in-app notification category, sound or quiet-hours preferences.
  Its notification bodies are generic; Koed should preserve that privacy-first
  baseline. The richer controls above are new work, not an existing feature port.
- NeedsAttention currently does not trigger an Orys desktop notification. Koed's
  proposed user-input/approval alert therefore needs new policy and tests.
- Orys already discovers authored PRs; that does not make those PRs eligible for
  its requested-review episode lifecycle. Preserve the distinction in our tabs.
- Orys diagnostics provide a preview, not a diagnostic-file export control.
  Markdown review/history export is a separate implemented feature.
- Developer ID signing, notarization and automatic updates are outside Orys's
  internal V1 scope. Koed should retain its own packaging/update work.
- Some Orys documents describe architecture targets and a stale projection
  comment still says publication is disabled. Current broker/IPC code implements
  publication; use executable contracts/tests as the porting reference.

The inventory is not a runtime certification: no live reviews, credential changes,
publication or full Orys test suite were executed during this planning pass.
