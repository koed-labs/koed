# Studio Home attention

Ticket 19 connects the existing Home design to the signed-in User's work. It includes their own native Agent work on Team Projects and retained legacy Jobs. Team messages and colleagues' work remain in Team → For you.

## Behavior

- **Needs you:** unresolved Agent questions or approvals, failed or uncertain work, explicit native work requiring owner review, retained assigned Jobs awaiting review, and actionable PR reviews/publication decisions. Ordinary successful chat replies do not create an approval or review requirement.
- **Ongoing work:** running work and conversations available to resume. These do not increase the Home badge. Home shows Needs you, Ongoing work and Cleared, with five items per section.
- Blocked work appears before review items. Each group uses the most recent relevant source activity first.
- Opening an item goes to its original Conversation or PR review and does not clear it. A PR link restores its assigned Agent and computer; it cannot silently select another computer or start another execution.
- **Clear** dismisses only a reminder. It does not answer, approve, stop, review or publish anything. **Restore** makes the current reminder visible again.
- Clearing follows the verified account across Desktop and web. It applies to the exact source event revision. Polling, reconnection and display text do not create a new event; relevant new source activity can resurface a reminder.
- When the source action is resolved, its reminder disappears. The badge counts uncleared action items, including items reachable through additional source pages.
- A dropped connection leaves the last verified account's feed visible with **Offline · may be out of date**. Actions requiring a connection are disabled. An account or backend change invalidates the previous protected feed before loading another account's data.

## Authority and transports

The API reads existing owned managed execution/runtime state, native conversation deliveries, accepted native Team Agent work, retained legacy Jobs and persisted PR review state. Home does not call an AI provider or post to GitHub. Dismissal storage contains owner/source/revision metadata, without chat or review content.

`GET /v1/home/access` verifies the effective account scope. `GET /v1/home` loads bounded source pages; `source`, `cursor` and `limit` request additional pages. Clear/restore writes recheck the owned current source and revision. A stale event returns a conflict; it is never silently applied to a newer event.

Native Studio uses `/studio-api/home-feed` and its access/reminder routes through the existing server-owned loopback credential and CSRF transport. The local API follows its configured managed authority, so linked Desktop and web read and clear the same hosted account's reminders. A failed configured upstream does not authorize falling back to a separate local owner's data. Hosted Studio uses the corresponding `/v1/home` routes.

No persistent browser cache, SQLite store, device-synced unsent chat drafts or Team attention feature is added here.

## Native activity sources

Home reads durable Personal conversation deliveries and accepted native Team Agent requests as `native_agent_activity`. Delivery links open the saved root conversation; Team request links open the owner's private execution. Agent names come from the recorded work identity. Direct AI Client work keeps its provider label. Retained Jobs remain readable, with exact source bindings preventing duplicate failure reminders.

Native event IDs are `delivery:<id>`, `team-request:<id>` or `command:<id>`. The last form covers failed current commands in otherwise open conversations. Their revisions reflect meaningful native state rather than display names or refresh timestamps. Reminder writes validate the current owned event and revision. Existing exact failure dismissals remain respected when a delivery gains native attribution; a subsequent native Clear or Restore takes precedence. No new Agent Job, execution, memory retrieval or content store is introduced.

## Review flow

1. Open Home under an authorized account with an Agent question, approval, failed Job, completed Job and PR review. Confirm blocked/review ordering and recognizable work labels.
2. Open a Conversation and a PR item. Confirm the exact existing destination appears and no new execution, answer, approval or publication is created.
3. Clear an item in one signed-in client. Refresh another client for the same account; confirm it remains cleared and both badges agree. Restore it and verify both clients again.
4. Refresh/poll without changing the source. Confirm the cleared item stays cleared through lease updates, reconnection and display-name changes. Create a relevant new source event/revision; confirm the new reminder appears.
5. Resolve an Agent request in its existing Conversation. Confirm it leaves Needs you without an explicit Clear operation. Explicitly continue past a failed delivery; confirm its child execution does not recreate the same failure reminder. A later different failed command must still appear.
6. Load additional source pages with more than the first page of action items. Confirm older unresolved work is reachable and the badge remains the authoritative total.
7. Drop the API connection while Home is open. Confirm the stale label and disabled actions. Reconnect and confirm the feed/badge update.
8. Change account or authority and fail the next feed request. Confirm the old account's work is absent. Unauthenticated and foreign-owner requests must not expose or mutate reminders.
9. Check Desktop and hosted web layouts at 320, 768 and 1440 pixels. Confirm Home controls and chat/project navigation retain the existing design.

Use synthetic browser fixtures for state timing and disposable PostgreSQL for source and cross-owner persistence checks. No provider execution or external GitHub write is required to validate this presentation and reminder authority.

## Deployment requirement

Deploy the API with migration `0082_home_native_agent_activity.sql` before using native Home activity. It extends the source allowlist in the existing `0067_home_reminder_states.sql` reminder table; it adds no new lifecycle or table. Desktop also needs the updated Studio gateway. A configured hosted authority must be reachable and authorized; Home reports unavailable rather than replacing that authority with a different account's local data.

## Native rewiring validation, 2026-10-14

- API Home and upstream routing: 53 tests passed, including all three native reminder ID forms and stale revision rejection. Desktop Home proxy: eight tests passed.
- Studio Home/client/routing/refresh: 26 tests passed. Six Home browser scenarios passed, including native root navigation and reminder-only Clear/Restore. Existing Agent, Team and responsive browser cases passed (19), as did PR browsing/review cases (three). Browser checks use synthetic API fixtures.
- Shared and DB builds, API typecheck and full build, Studio production build, changed-file lint, release consistency and migration metadata checks passed. All 15 migration acceptance scenarios passed through 0082 in disposable PostgreSQL.
- Disposable PostgreSQL Home authority acceptance passed. It covers native command/delivery/owned Team activity, exact failure deduplication, legacy dismissal continuity, explicit Restore, stable revisions through background updates, skipped-delivery resolution and later independent failure visibility.

Live native/hosted account synchronization and provider acceptance remain open. The configured Personal database was not migrated, and no AI provider execution or GitHub publication was performed. A broader shared-package run reported four custody-test failures outside the changed Home files; a clean-revision baseline was not established. Earlier broad lint/test limitations remain in the integration plan.

## Earlier Home validation evidence

- Maintained browser regression: 21 checks passed, covering Home, PR review chat, Agent pages, Team chat and responsive layouts. The final Home changes additionally passed five focused checks, including sign-out followed by same-account sign-in with an unavailable backend.
- Studio: 33 Agent checks, five Home client checks and 330 Node checks passed. The final native Home proxy checks passed, including encoded PR push reminder IDs.
- Disposable PostgreSQL 17: verified owner isolation, shared reminder state across repository clients, exact revision and alias rejection, runtime generation and source resolution, failed Job deduplication, uncertain push/reconciliation, and pagination beyond 100 items with exact microsecond cursors.
- Shared and DB builds, API typecheck and full API build, 64 focused API/auth/upstream checks, and migration metadata checks passed. Linked Desktop access and clearing use the enrolled hosted account; an unavailable upstream never falls back to local reminders.
- Final hosted and native Studio production builds passed. Changed frontend lint has no errors; the existing unused `HostedContextSidebar` warning remains.

These checks do not claim a deployed migration, live provider execution or external GitHub publication.
