# ADR 0065: AI Subscription Usage From Official Sources Only

- Status: Accepted
- Date: 2026-10-23

Related decisions: [0001 AI Client Synthesis Only](./0001-ai-client-synthesis-only.md),
[0004 Team Memory Workspaces](./0004-team-memory-workspaces.md),
[0043 Durable Memory Answer Execution](./0043-durable-memory-answer-execution.md),
and [0054 AI Client Instance, Capability, And Permission Contracts](./0054-ai-client-instance-capability-and-permission-contracts.md).

This is the accepted design for D11–D11d. HQ-520, HQ-521, and HQ-522 implement it
later; this ADR does not claim the usage routes, stream, persistence, or UI exist.

## Context

Koed runs on the user's own AI subscriptions through AI Client instances
(`codex`, `claude`, `pi`): Claude through the Claude Agent SDK, ChatGPT through
the Codex app server, Pi through its own RPC mode and its own sign-in. These
subscriptions have usage limits, typically a rolling 5-hour window
and a weekly window. Users who hit a limit in the middle of work lose time, and
power users with more than one subscription want to know which one has room left.

What Koed does today: Codex is inspected every 5 minutes for the AI Client
capability snapshot (`account/read`, `model/list`); Claude's `rate_limit_event`
already reaches the runtime and is returned in the turn's `providerEvents`, but
nothing reads it. A Managed Conversation's AI Client is fixed for its life;
model, effort and permission can change per turn.

Community tools read these numbers in ways that are not supported by the
providers: undocumented endpoints called with a token read from another
application's credential file, scraping of web pages, or counting local session
files. Those break without warning and may breach the providers' terms.

Installed-source checks on 23 Oct 2026:

- **Codex:** `codex-cli 0.159.2`, checked with
  `codex app-server generate-json-schema`. The app server answers
  `account/rateLimits/read` (`v2/GetAccountRateLimitsResponse`) with
  `rateLimits` (a single-bucket view) and `rateLimitsByLimitId` (every bucket,
  keyed by metered ID, for example `codex`). The response also permits nullable
  `accountId` and `ordinaryUsageAllowed`, `rateLimitResetCredits`, and a
  `rateLimitUpsell` banner. Each bucket permits `limitId`, `limitName`,
  `normalModelSlug`, `primary` and `secondary` windows (`usedPercent`,
  `resetsAt`, `windowDurationMins`), `planType`, `credits`, `individualLimit`,
  `rateLimitReachedType`, and `spendControlReached`. Most fields are optional or
  nullable. `credits` reports `hasCredits`, `unlimited`, and optional
  `balance`; `individualLimit` reports limit, used, remaining percentage and
  reset. The reset-credit summary reports `availableCount` and optional detail
  rows (ID, grant/expiry, status and reset type). The schema also declares
  `account/rateLimits/updated`, a sparse
  notification; it cannot replace the full read without a safe merge or refetch.
  The app server is labelled experimental.
- **Claude:** installed `@anthropic-ai/claude-agent-sdk` `0.3.226`, checked in
  `sdk.d.ts`, emits
  `rate_limit_event` messages during a run (`SDKRateLimitInfo`: `status`
  `allowed` | `allowed_warning` | `rejected`; optional `resetsAt`;
  `rateLimitType` `five_hour` | `seven_day` | `seven_day_opus` |
  `seven_day_sonnet` | `seven_day_overage_included` | `overage`; optional
  `utilization`, often absent when not near a limit; `overageStatus`, `overageResetsAt`,
  `overageDisabledReason`, `isUsingOverage`, `overageInUse`,
  `surpassedThreshold`, `errorCode`, `canUserPurchaseCredits`, and
  `hasChargeableSavedPaymentMethod`). The SDK also declares
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` on `Query`
  (`sdk.d.ts`, around line 2521). Its documentation explicitly says not to rely
  on it yet, so this decision uses events only.
- **Pi:** manages its own provider sign-in; Koed has no approved usage feed for
  its credentials or limits.
- Other providers have no approved usage integration in this release.

## Decision

### 1. Official sources only

- Koed records usage only from the approved Codex and Claude sources above. It never calls undocumented
  endpoints, never reads another application's credentials, never scrapes web
  pages or other applications' local files.
- **Codex:** `account/rateLimits/read` runs in a **separate background usage
  probe** that reads the whole response (every bucket, `accountId` and the
  restriction fields) with its own app-server client, lifetime and timeout,
  after the capability snapshot is published, and after each Codex turn. The optional
  `account/rateLimits/updated` notification may trigger a refetch; its sparse
  fields alone must not imply recovery. The probe does not run inside
  `inspectCodexAppServer`: awaiting it there would delay the inspection,
  and that function's `finally` closes the client. It is optional in the
  protocol compatibility check: if it is missing or fails, nothing is recorded.
- **Claude:** each `rate_limit_event` is recorded **as it arrives** in the
  runtime's message loop, retaining every declared `SDKRateLimitInfo` field.
  Events already return with an SDK error result, but cancellation and thrown
  transport failures bypass that return; capturing on
  arrival covers every case.
- A provider that offers nothing is shown as "Not shared by <provider>". A window
  a provider does not report, or whose reset time has passed, is shown as "—".

### 2. Nothing estimated in this release

- The UI shows only reported values and when they were reported. Pace,
  projections and fills between readings are a later decision; when they come,
  they are labelled as estimates and kept apart from reported values.
- A reset never creates a reading: once a reading's reset time has passed, it
  no longer describes the current window, and the UI shows "—" until a new
  reading arrives.
- Readings are kept as a short history (see 3) so that later decision has data.

### 3. Usage Snapshots, Personal only

- Each reading is a **Usage Snapshot**: AI Client instance, hashed account
  identity, provider bucket (Codex `limitId` and `limitName`; Claude limit
  type), window (Codex `primary` / `secondary` with `windowDurationMins`;
  Claude's limit type, including `seven_day_overage_included`), percentage used
  when reported, status (`ok` | `near_limit` | `limited` | `unknown`; Claude
  from `allowed` | `allowed_warning` | `rejected`), reset time when reported,
  source and observed time. Read Codex `accountId` for identity binding; only
  its hash is persisted. Preserve `ordinaryUsageAllowed`,
  `rateLimitResetCredits`, all bucket restriction, plan and credit fields, and
  every Claude `SDKRateLimitInfo` field in the bounded private contract. Do not
  flatten distinct buckets or discard the fact that an unknown value was
  reported. Expose only an allowlisted, redacted owner-facing projection.
- **Unknown values are conservative.** A bucket, limit type, enum value or field
  Koed does not know is stored as `unknown`, shown as "—" and never counts as
  fine.
- **Account identity** comes from official sources. The Codex probe reads
  `account/read` and `account/rateLimits/read` through one app-server client
  and binds the former to the latter's `accountId` when supplied. Re-read the
  account before committing; reject a probe if the account changed during it.
  The current
  capability inspection already calls `account/read` but discards its result.
  Claude uses SDK `accountInfo()` or `account` in
  `SDKControlInitializeResponse` (email, organization, subscription type).
  `SDKSystemMessage` (`type: system`, `subtype: init`) does **not** contain
  `account`. Hash a stable, identifying value with the owner, backend, profile,
  instance and provider namespace; a plan or authentication state alone is not
  identity. A Codex account without a usable `account/read` identity may use
  the `accountId` from its own rate-limits response if it can be bound to the
  current inspected account; otherwise it is unverified. A Claude identity
  without an identifying account field is also unverified. Store no raw email,
  organization or account ID in Desktop events. When identity changes, hide
  earlier readings. If identity cannot be verified, never reuse readings
  across authentication changes and never offer that instance as an alternative.
- The latest reading is kept **per bucket and window**: two Codex buckets never
  merge, and a new five-hour reading never replaces a weekly or model-specific
  restriction.
- **Late results are discarded.** Each probe carries the account identity it
  started with plus owner, backend, profile generation and instance. A result
  for an account or authority generation that is no longer current, or older
  than the newest stored reading for that bucket and window, is not stored.
- Snapshots are stored on the **Personal backend** only, next to the AI Client
  capability snapshots (`ai_client_usage_snapshots`), kept 30 days, never shared
  with a Team, never written to memory, never added to an agent's context.

### 4. A deterministic suggestion, never an automatic switch

- While the user types, Desktop checks the AI Client that would run the
  message. It is **low** if Codex reports 90% or more in a current window of a
  bucket that applies to the selected model, or reports a restriction
  (`ordinaryUsageAllowed: false`, a reached limit or spend control), or
  Claude reports `near_limit` or `limited` for a current limit that applies to
  the selected model (five-hour, weekly, or that model's own weekly limit).
- Another AI Client is **fine** only with **positive evidence, defined per
  provider**. Freshness (under 30 minutes, with any reported reset still in the
  future) is checked on **each** applicable reading, not on the newest one
  alone. The account identity must be verified and bound to the current
  instance and authentication generation.
  - **Codex:** for every bucket that applies to the model being offered (the
    default `codex` bucket and any model-specific one), every reported window
    has a valid percentage under 90%; `ordinaryUsageAllowed` is explicitly
    true; no bucket reports a reached limit, exhausted individual limit, or
    reached spend control. An absent bucket, missing applicable window,
    unresolved model-to-bucket mapping, or unavailable restriction state is
    insufficient evidence. Neither a reset timestamp nor available credits
    overrides a reported restriction.
  - **Claude:** a fresh event with status `allowed`, and no unexpired
    `allowed_warning` or `rejected` on any known applicable limit type
    (`five_hour`, `seven_day`, the selected model's weekly type, or applicable
    overage limits). The applicable limit types must be known from current
    evidence. A percentage is **not** required: the SDK may omit utilization
    when the account is not near a limit. An optional, absent `resetsAt` does
    not by itself defeat a fresh `allowed` status, but a reported reset in the
    past does. An overage error or disabled status cannot be treated as room.
  - Missing status, identity or applicable limit information, unknown values,
    stale readings and passed resets are never fine.
- Three outcomes are kept apart: **no warning** (the current AI is not low);
  **warning with a suggestion** (an alternative is fine); **warning only** (no
  alternative is fine: "No other AI reports room right now."). In a Project HQ
  Conversation it is always the warning only.
- The AI Client of a Managed Conversation stays fixed. In a new Conversation
  before its first message, "Use <other>" changes that Conversation's selection
  (the saved default is unchanged). In a running Conversation, the suggestion
  offers "New chat with <other>", carrying the typed text. In a Project HQ
  Conversation (the Chief of Staff's fixed AI Client), it only warns.
- "Keep <current>" silences the suggestion until that window resets, or for one
  hour when no reset time was reported. Nothing switches until the user accepts
  the suggestion.
- The rule is fixed thresholds over reported values: no AI judgement (ADR 0001).

## Consequences

- New Personal table, contract and routes in the AI Client family
  (`/v1/memory/ai-client-instances/…`); the existing local AI Client IPC bridge
  gains `usage` and a bounded `usage.refresh`. HQ-520's new completion path
  publishes probe completion to Desktop, which re-reads current snapshots.
  Desktop also re-reads on window focus and after a Conversation turn (a read
  after capability refresh alone can finish before the background usage probe).
- **Completion delivery is new HQ-520 work.** The current AI Client bridge has
  command responses only; it has no change subscription. HQ-520 adds an
  owner-authenticated Personal API stream at
  `GET /v1/memory/ai-client-instances/usage/events` (the existing
  `local_synthesis` route-identity family), the runtime completion publisher,
  the Desktop main-process stream client, and a typed
  `localAiClients.onUsageChanged(listener)` preload subscription returning an
  unsubscribe function. HQ-521 connects the HQ table and model menu to it.
- The Personal API publishes a completion only after the corresponding usage
  write commits, or after a probe reports `failed` or `unsupported`. Events carry
  only instance ID, completion ID, outcome and observed time; no usage values,
  source content, credentials or account identifiers. Desktop re-reads the
  authorized usage route rather than treating an event as usage data. The
  completion ID is monotonic or otherwise deduplicable within its authority
  generation; reconnect correctness comes from re-reading, not replaying it.
- The stream and IPC listeners are bound to the current Personal owner, backend,
  profile generation and allowed AI Client instances. Revalidate authority on
  connection and delivery; close on authority loss. On sign-out, profile,
  backend or account change, cancel the old subscription and discard queued
  events and stale responses. On reconnect, subscribe before reading the current
  snapshots so a missed completion cannot leave the UI stale. Unmount removes
  listeners. This adds no Team collaboration realtime family and sends no usage
  to an agent or Team backend. Put the main-process client in a dedicated module
  with only minimal registration wiring; do not change legacy presentation.
- **Refresh is truthful.** `usage.refresh` runs one bounded probe and returns
  `checked`, `failed` or `unsupported`, each bound to the requesting authority
  generation; Desktop says "Checked Codex just now." only on `checked`,
  otherwise that it couldn't check (showing the last reading's time) or that
  this Codex version doesn't share usage.
- Codex usage is checked after periodic capability inspections (5 minutes) or
  Codex turns, subject to probe success. Claude's row can be up to one run old;
  the UI shows each reading's age, and
  the suggestion ignores it once it is older than 30 minutes.
- If the Codex method changes or disappears, the row falls back to "—"; HQ-520
  adds a schema check against the installed Codex for future changes.
- No change to Managed Conversation settings, routing, fork or transfer.

## Alternatives Considered

- **Read the undocumented Claude usage endpoint with Claude Code's token.**
  Rejected: unsupported, may breach terms, breaks silently.
- **Count tokens locally and estimate the percentage.** Rejected for this
  release: it misses use outside Koed and would present guesses as facts.
- **Switch automatically when an account runs low.** Rejected for this release:
  quality differs between AIs and users choose on purpose; a later opt-in rule
  per Agent can build on the same snapshots.
