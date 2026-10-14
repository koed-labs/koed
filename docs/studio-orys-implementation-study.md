# Orys implementation study for Koed Pull Requests

Reviewed 2026-10-14 against Orys main at `bb94822abf0c989a1840a028666ccb5652efea5d`.
This is the same revision referenced by the earlier port plan. This review studies source, not a running Orys application.
The private repository was read through authenticated GitHub access. No Orys code or dependencies were added to Koed.
Koed recall returned an unverifiable answer. This study uses repository source and recorded ticket decisions.

## Result

Reuse Orys behavior and boundaries through Koed's existing TypeScript services.
Its native core is Rust, while its interface is TypeScript. Rust is not a barrier to adapting the design.
Do not introduce a Rust sidecar, another Agent Job engine or another Memory path.
Keep the existing Koed UI and supported Codex/Claude execution adapters.

## How Orys works

| Area             | Observed implementation                                                                                                                                                                                                                                 | Pieces to adapt for Koed                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR discovery     | Separate GraphQL searches for open authored PRs and requested reviews. Results use cursor pagination, 50 entries per page, PR-node deduplication and draft/archived filtering.                                                                          | Keep the combined inbox and explicit filters. Preserve visibility rules and decide draft policy explicitly rather than silently adopting Orys's exclusion.                                  |
| Refresh          | Startup discovery, a native five-minute timer, macOS wake recovery and manual Refresh. A separate webview timer also requests refresh every five minutes.                                                                                               | One shared scheduler per authorized account/computer context. Keep startup, five-minute, wake/reconnect and manual triggers. Multiple windows must not multiply polling.                    |
| Concurrency      | The recovery coordinator coalesces wake/periodic cycles after startup recovery. An atomic flag rejects concurrent GitHub sync. A credential generation prevents results from an old connection being committed.                                         | Use Koed's owner/account/connection/device authority and one in-flight request. Cancel or discard stale reads after account, device or repository changes.                                  |
| Network bounds   | Discovery returns summary fields, not patches or cloned repositories. Each response has a 2 MiB cap. Accepted cards stop at 1,000, with an explicit truncation message. HTTP connection and request timeouts are 15 and 30 seconds.                     | Bound bytes, pages, requests and duration per refresh. Fetch code/diffs/checks on demand. Show incomplete coverage rather than implying the inbox is complete.                              |
| Last known data  | Successful discovery replaces the stored inbox. A failed sync changes sync status without replacing the stored cards. Manual refresh remains available.                                                                                                 | Keep authorized last known cards on transient failures, show last success and retry. Clear protected data when access changes. An outage is different from revocation.                      |
| Changed commits  | An episode identifies repository, PR number, base and head commits. An unchanged episode retains its review state. A changed episode becomes stale and offers Review latest.                                                                            | Retain previous review evidence, mark outdated work and require explicit review of the new commits. Do not silently treat an old review as current.                                         |
| Review checkout  | The native layer resolves PR scope again, freezes exact revisions and derives isolated checkout paths. Workspace preparation verifies fetched commit identities and preserves scope for explicit retry.                                                 | Keep Koed's isolated checkout, exact revisions, permission checks and retry identity. PR discovery must not fetch repository history every five minutes.                                    |
| Execution        | A durable native pipeline runs staged Codex reviews, records progress and routes approvals. The default pipeline has several review/synthesis passes.                                                                                                   | Reuse native progress, cancellation and structured findings through Koed's current adapters. A configurable multi-stage pipeline is a separate scope decision, not an automatic port.       |
| Publication      | A frozen envelope binds repository, PR, reviewed head, action, summary and inline comments. Publication checks current remote eligibility. A consumed submission cannot be blindly sent again. Uncertain results are reconciled by remote marker reads. | Preserve exact-content confirmation, current-account and revision checks, inline anchors and read-only reconciliation. Refresh must never post reviews, push branches or start new AI work. |
| Recovery/storage | Signed local manifests, immutable evidence, atomic writes, local-first startup recovery and derived-index rebuild preserve durable authority.                                                                                                           | Use Koed's existing PostgreSQL transactions, encrypted records, migrations and execution leases. Reuse the principles, not Orys's local file storage architecture.                          |
| Notifications    | A durable transition ledger deduplicates notifications. Its first scan is silent.                                                                                                                                                                       | Apply only within approved notification scope. Do not notify for every poll or silently expand the deferred channel-notification feature.                                                   |

## Details to improve rather than copy

The native and webview timers can both request discovery. The in-flight flag prevents simultaneous requests, but does not establish one refresh per five-minute window.
Koed needs one scheduler, rather than a timer in every PR component.

The 2 MiB response cap is not a total refresh budget. The 1,000-card cap also does not cap pages scanned when many results are filtered.
Use an explicit per-refresh page/request/byte budget and a visible partial-results state.
Never download all PR files or repositories merely to refresh the inbox.

The GraphQL query requests rate-limit information, but the discovery response model does not consume it.
The inspected discovery path does not implement ETag validation or adaptive rate-limit backoff.
Do not describe those features as already present in Orys.
For Koed, respect provider retry/reset guidance where available and avoid aggressive retries after authentication or rate-limit failures.

## Koed comparison and Ticket 16

Koed already has bounded authenticated inbox reads in `packages/shared/src/github-delegated.ts`.
The inbox combines authored and requested-review results and defaults to one page from each search.
The runner validates the selected account and connection before discovery.
Details, checkout, draft persistence, exact publication confirmation and uncertain-outcome handling already have dedicated code.

`PullRequestsView.tsx` loads the inbox on connection/repository changes and supports pagination.
Its 1.5-second timer reads an active review and draft. That timer is not GitHub inbox discovery.
No five-minute discovery scheduler was found in the inspected PR UI, runner, API or delegated GitHub reader.
The five-minute operation lease is also not a polling schedule.

Ticket 16 must explicitly include:

1. Restore native review completion without a succeeded legacy Agent Job dependency.
2. Add lightweight startup and five-minute inbox discovery through the existing authorized runner.
3. Coalesce manual, periodic, reconnect and supported wake triggers across windows.
4. Enforce refresh budgets and incomplete coverage, without automatic diff/repository downloads.
5. Preserve last success, transient failure recovery and account/access isolation.
6. Preserve revision-aware review history, explicit new reviews, exact publication and uncertain-outcome reconciliation.

Tests must cover overlapping triggers, sleep/resume, offline recovery, account switching, rate limits, partial results and unchanged PRs.
A discovery test must also prove that refresh creates no AI review, Git fetch, publication or push.
Hosted refresh must use the authorized selected computer. An offline computer must not trigger a different account or execution destination.
The scheduler's service placement must follow the existing local/hosted authority, not add a backend-owned GitHub credential.

This study records requirements and reuse candidates. It does not implement polling or reopen any external GitHub write approval.
It refines existing Ticket 16. The current count remains 12 open tickets.

## Collaboration includes the backend and database

The channel tickets cover complete behavior across Studio, API, database, authorization and realtime delivery.
They are not visual-only tickets. Reuse existing services and add or migrate storage only where the new behavior requires it.

| Layer                  | Existing Koed implementation                                                                                                                                                                            | Remaining integration requirement                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL             | `schema.ts` defines threads, participants, audiences, messages, revisions, reactions, receipts, outbox, replay watermarks and stream subscriptions. Applied migration files establish these structures. | Preserve historical data. Add reviewed migrations/indexes where native Agent participation requires new links or constraints.                   |
| Database operations    | `collaboration-repository.ts` implements durable collaboration access.                                                                                                                                  | Reuse the repository and verify current membership, audience, encryption, pagination and idempotent writes.                                     |
| API                    | `apps/api/src/collaboration/routes.ts` implements authenticated collaboration operations.                                                                                                               | Keep shared contracts, validation and permissions consistent with Studio. New AI routes need destination-specific authority.                    |
| Realtime               | `apps/api/src/collaboration/realtime.ts` and the local-edge broker implement delivery, reconnect and replay.                                                                                            | Test missed-message recovery, unread state, revocation and two-member delivery.                                                                 |
| Channel Agent requests | Existing Team request records and consent UI retain requester, owner, Agent, channel and outcome relationships. The execution handoff now returns 410.                                                  | Ticket 13 must replace the legacy Job handoff with native execution. Ticket 27 covers other supported AI destinations and their audience rules. |
| Team activity          | Public Square and For you use existing Team publication visibility.                                                                                                                                     | Tickets 12 and 20 must project native work while preserving Team visibility, frozen history and private-work isolation.                         |

Ticket 07 explicitly assigned PostgreSQL models/migrations, authorization, API/contracts and backend tests, as well as Studio implementation.
Its recorded acceptance includes real PostgreSQL migration and membership checks, plus live web/Desktop messaging.
Tickets 08 and 14 extend private messaging and message interactions. They do not establish that the new AI execution path is complete.
Implementation in source does not establish that migrations are applied to a deployed Team backend.

## Source map

All Orys links below pin the reviewed revision.

- [Native startup, wake and five-minute polling](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/lib.rs)
- [Frontend refresh timer](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src/main.ts)
- [Startup and wake coordination](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/lifecycle.rs)
- [GitHub discovery and limits](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/github/mod.rs)
- [Sync, credential generation and failure state](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/app.rs)
- [Retained inbox and changed-commit handling](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/storage/recovery.rs)
- [Checkout preparation](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/workspace.rs)
- [Native review execution](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/codex_review.rs)
- [Default review stages](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/pipelines/default.orys)
- [Publication broker](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/app/publication_broker.rs)
- [Exact publication envelope](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/publication/envelope.rs)
- [Atomic local writes](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/storage/atomic.rs)
- [Notification transition ledger](https://github.com/koed-labs/orys/blob/bb94822abf0c989a1840a028666ccb5652efea5d/apps/orys/src-tauri/src/storage/notifications.rs)
