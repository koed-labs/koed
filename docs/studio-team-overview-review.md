# Studio Team For you review

## Behavior

For you shows activity from Teams the signed-in User can currently access. The default is All teams; Team filters show their own attention counts.

Issues and blockers appear first. Unread direct messages, explicit mentions, replies to the User's messages and explicit work requests belong in attention. Messages are grouped by Conversation or channel thread. Ordinary unread channel activity belongs in catch-up and does not increase the attention badge.

Clear hides the current reminder without marking messages read or acting on work. Restore brings that reminder back. A new relevant event can show it again. Opening the overview does not mark message previews read.

Catch-up includes meaningful Team-visible work outcomes. Routine phase, presence and connection changes stay in existing live work views. A work outcome is acknowledged for future visits only when its entry is visible. The current visit remains stable while the User reads.

Desktop and web share the collaboration backend and existing message, request, native work and Pull Request actions, with retained legacy Job history. The overview does not share private Agent Conversations. Offline presentation uses only the last verified active-session snapshot. Confirmed account, authority or Team-access changes remove affected data.

Owned Agent details allow per-Team availability and an owner-approved description. Existing Team controls use the same offers authority. Disabling availability prevents new proposals, closes unanswered requests and preserves accepted work under existing access rules.

## Backend contract

Desktop and web use `GET /v1/collaboration/teams/overview`. Desktop forwards it through the existing authenticated local gateway. The feed returns authorized source revisions, grouped counts and paginated rows. Refresh re-reads the pages already loaded, including a final page without another cursor. Clear, Restore and seen acknowledgements use `POST /v1/collaboration/teams/:teamId/overview/:sourceEventId/:action` with the exact `sourceRevision`.

The database stores only per-User reminder and seen metadata in `team_overview_reminder_states`. Source content remains in its existing collaboration, native work, retained Job and Pull Request stores. The backend rechecks current source access and revision before writing that metadata. Explicit human mentions use selected Team member IDs stored inside the existing encrypted message metadata. Unsent selections are restored with the existing account- and channel-scoped encrypted draft. Typing a name alone does not create a mention. A colleague Agent proposal cannot also carry selected human mentions through its current request contract; the composer asks the User to send those separately.

Seen outcomes retain their current-visit presentation only while the backend confirms the exact outcome is still authorized. Unsharing a Project or withdrawing its publication removes that outcome. Team Workspace channels require their existing Workspace grants. Shared-memory session discussions remain governed by their separate memory-grant and consent rules and are outside this ordinary Team chat overview.

## Native Agent work

Native activity reuses the Team's existing Public Square publications and exact native command status. Private conversations, execution and command identifiers, prompts and response text are excluded from shared feed items. A native work destination carries only its authorized Team publication and Team Project identifiers. Any readable shared brief must come from an explicitly published Team brief.

Native action and outcome sources preserve legacy Job history. Actionable blockers remain owner-scoped; significant Team-visible outcomes can enter catch-up. Accepted Agent requests do not create another work lifecycle. Specific PR actions and explicitly shared channel outcomes take precedence over duplicate generic work cards. Routine presence, phase and connection changes do not create catch-up outcomes. Already-published terminal history follows Public Square visibility through local connection remaps; withdrawal and Project unshare still remove it.

Desktop and hosted Studio use one outcome-source predicate for visibility acknowledgements. The v1 `currentJobOutcomes` field also carries native outcome references, preserving the existing current-visit access checks. Clear, Restore and seen writes recheck the exact current User, Team, source and revision. Display names, polling and unrelated private follow-ups must not invalidate those acknowledgements. Reminder lookup, page merging and pending controls use the Team ID together with the source event ID, so a PR shared in two Teams retains independent state.

## Review flow

Use two disposable Users in one Team and a second Team accessible only to one User. Use Studio's current entrypoint, not the legacy Koed toolbar.

1. Send several replies to a message owned by the first User. Check that For you shows one item with the relevant unread count. Send ordinary channel messages and check they enter catch-up without increasing the attention badge.
2. Send a direct message and an explicit mention. Verify their destinations and counts. Opening For you must not advance the original message read cursors. Open and read the original messages; verify that their attention resolves.
3. Clear a reminder, reload and verify that it stays cleared. Restore it. Clear again and send a new relevant message; verify that it resurfaces once. Polling alone must not resurface it.
4. Check that an explicit blocking work request is above ordinary message attention. Open it and use the existing work action. Opening must not start duplicate work or share private Agent chat content. Clear a native approval reminder; reconnect without changing the exact request and verify it stays cleared. A changed request revision must resurface.
5. Complete native Team-visible Agent work or a retained Job. Verify a concise outcome in catch-up. Scroll it into view and verify that a later visit acknowledges it while the current view stays stable. Routine phase changes must not create catch-up noise. Explicitly share a request outcome in its channel and verify the same result is not repeated as generic Agent catch-up. Check that a linked PR action takes precedence over duplicate generic work.
6. Compare All teams and Team filter counts. Verify that the second User cannot see the private second Team's items or mutate its reminders. Publish the same PR work to both Teams; clear it in one Team and verify the other Team's reminder and badge remain intact. Remove Team access and verify that its data and badges disappear.
7. Disconnect the backend while the verified feed is open. Verify the out-of-date notice and disabled connection-dependent actions. Reconnect and verify a fresh feed. Sign out or change accounts and verify that protected rows are cleared.
8. Open an owned Agent's details. Change its Team availability and description; verify that the existing Team offer controls reflect the change. Disable it and verify the established unanswered-request lifecycle.

## Validation and deployment

The current native rewiring adds migration `0083_team_overview_native_agent_activity.sql`, widening the existing reminder source allowlist without adding a work lifecycle. Validate it in a disposable database before deployment. Native implementation validation is recorded below; the earlier evidence remains historical.

Deploy database migration `0068_team_overview_states.sql` before serving the new overview routes. The isolated PostgreSQL tests validate the schema and authorization behavior; they do not deploy the migration to the configured live backend.

Native rewiring validation, 2026-10-14:

- API collaboration and local-edge routing: 69 tests passed, including native and legacy outcome/action pagination, badges, source-specific Clear/Restore/seen, source-change conflicts and upstream authority.
- Desktop overview proxy: six tests passed. Existing Team overview, Public Square, request and saved-navigation client/helper checks: 21 passed. Team Agent UI/progress regression: seven passed.
- Maintained browser checks: 30 scenarios passed across Home, Team, Agents, PR and responsive layouts. The native scenarios verify visible-only seen, current-visit retention, access removal, exact public-card navigation and independent reminders across Teams and refreshed pages. These use synthetic API fixtures.
- Disposable PostgreSQL source/reminder suites passed: two files, six tests. Native cases cover exact-turn blockers, private-field exclusion, stable clears, revised questions, outcome seen, explicit result dedupe, native PR draft/account/commit checks, duplicate publication suppression and retained terminal history after disconnect. Shared contracts: two tests passed. All 15 migration scenarios passed through 0083.
- Studio TypeScript and hosted/desktop production builds, API typecheck/full build, shared/DB checks, changed-file lint/formatting, migration metadata and release consistency passed.

These checks do not claim live native/hosted cross-device acceptance or provider execution. The configured Personal database was not migrated. A broader shared-package run reported four custody receipt equality failures in unchanged files, with no clean-revision baseline established.

Earlier validation on 2026-10-02:

- Maintained browser acceptance: 28/28, including responsive layouts, exact Clear/Restore, access removal, offline recovery and Agent availability.
- Studio tests: 33 Agent client checks, 5 Home client checks and 340 Node checks.
- API, shared contracts and local-edge routing: 210/210 focused checks. Native overview proxy: 5/5 checks. Counts overlap and are not additive.
- Disposable PostgreSQL 17 + pgvector: 4/4 tests across three suites. These cover reminder authorization/revisions, encrypted mention recipients, source grouping, frozen Job privacy, owner-only PR actions, outcome deduplication and Project-unshare revocation.
- Shared/DB and API builds, hosted/native Studio builds, typechecks, changed-file lint/formatting, migration metadata and diff checks passed.

The mention browser case also passed after adding reload/reopen coverage for unsent recipient selections. No provider execution or external GitHub write was required or performed.
