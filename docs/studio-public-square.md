# Public Square

Public Square shows work published through Projects connected to the selected Team. Work in unconnected Personal Projects and the contents of private Conversations remain private.

## Project rooms and activity states

Each room represents a Project shared with the Team. Each map entry represents one native work command or a retained legacy Job. Several work entries can belong to the same Agent. Setup, private request refinement and internal maintenance do not create Team activity.

- **Working:** native execution is actively running under a valid lease.
- **Checking:** retained legacy work may have an explicitly recorded verification phase. New native activity does not infer Checking from prose or restore the retired phase-reporting tools.
- **Waiting:** the work needs a response for its own provider turn. Queued work retains its Queued label. A person-specific highlight appears only when Koed knows the authorized respondent.
- **Offline:** the execution computer has lost its active lease. The entry retains its last known state and last-seen time. Offline does not mean finished.

Native activity uses its exact command, execution generation and trusted runtime state. A stale generation or uncertain dispatch shows an unavailable status rather than success or Idle. An unrelated later private turn must not change an earlier work entry. Waiting and Offline take precedence over any retained legacy phase.

The start time is the first actual dispatch of that work. It is not the time the Conversation, Agent or publication was created. Queued work with no dispatch has no start time. A retry does not reset the original start time. The two-hour Running long highlight is informational; it does not stop work or trigger an automatic action.

## Idle and history

The Idle strip shows Agents whose owners explicitly made them available to this Team and who have no active published work in this Team. Its label is **No active work in this Team**. These Agents may be working privately elsewhere. The strip does not assign them to a Project or reveal private activity.

Finished and history retain the actual outcome, including failure and cancellation. Entries whose owners left the Team remain frozen history with an Owner left Team label. Departure does not mark unfinished work as completed. Frozen state and phase timestamps do not change when the underlying private work changes later.

Current work is loaded before the remaining paginated history. Idle eligibility is computed across all current Team publications, not just the first page.

## Details and permissions

The side panel opens Highlights by default. Selecting a room opens its work list; selecting a work entry opens its details. Shared surfaces show only a brief the owner reviewed and explicitly shared with this Team. Otherwise they show Details not shared.

The owner can share, edit or withdraw that brief. Private brief drafts remain owner-only. Team administrators retain the existing permitted controls for a former owner's retained brief and for Project sharing. Connecting a local Project continues to use the member's own Project link.

Open workshop reuses the owner's existing working Conversation. Its execution locator is returned only to that owner, and the destination verifies ownership again. A teammate's private Conversation or workshop is not made accessible by selecting their work entry. Public Square does not publish prompts, transcripts, Memory evidence or raw results.

## Refresh and recovery

Native and hosted Studio use the same Team-scoped backend data and existing realtime invalidations. Publication creation, command state changes, exact-turn waits and access withdrawal invalidate the shared view using Team and publication identifiers only.
While Public Square is open and has current work, a status-only refresh runs at a 30-second completion-based cadence. It pauses while hidden or offline, backs off after failures and avoids overlapping reads. It does not reload Project connections on each tick. A successful read replaces cached publications so withdrawn entries cannot survive a missed realtime event. Account changes, Team changes and access loss retain the existing response guards. A failed authoritative read is shown as unavailable; an HTTP response alone is not proof of a live connection.

## Native publication boundaries

A native work entry keeps the Agent identity and local Project selected for that command. A later Conversation move cannot publish earlier private work under the new Project.
When a Project is first connected to a Team, only active work can begin publication from that moment; completed private work is not backfilled. Precise details remain hidden until the owner explicitly reviews and shares a brief for that Team.
Each Team has its own publication and brief. Unsharing a Project removes both current and historical entries from that Team's authorized reads. Owner departure freezes that Team's previously permitted record and ends later updates; it does not stop the owner's private execution.
Native entries use their publication identity, not fabricated legacy Job IDs. Private command identifiers and execution locations are not Team navigation capabilities. Only the owner receives the existing private conversation destination.

## Implementation validation

The native replacement is implemented under Ticket 12. Focused validation passes; live native/hosted acceptance and deployment remain open. See the integration plan for the validation record. Branch migrations must only run against disposable test databases during this work; the configured Personal database belongs to a different runtime revision.

Migration 0080 adds an immutable command/Agent/original-Project snapshot and separate Team publication rows. These are visibility read models; the native command remains the sole execution lifecycle. Brief drafts use Personal encryption and published briefs use the selected Team encryption scope. Legacy Job-backed publications retain their original storage and history. No new phase tools or backend LLM calls are introduced.
