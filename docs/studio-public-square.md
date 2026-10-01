# Public Square

Public Square shows work published to the selected Team. Personal Projects and private Conversations do not appear here.

## Project rooms and Job states

Each room represents a Project shared with the Team. Each map entry represents one durable Job. Several Jobs can belong to the same Agent.

- **Working:** the Job is running and has not reported a Checking phase.
- **Checking:** the Agent explicitly reported that it is verifying or reviewing its work. It can report Working again. This signal does not complete the Job or prove that checks passed.
- **Waiting:** the Job is queued, or it needs a response. Queued work retains its Queued label. A person-specific highlight appears only when Koed knows the authorized respondent.
- **Offline:** the execution computer has lost its active lease. The entry retains its last known state and last-seen time. Offline does not mean finished.

Checking and Working signals use the existing Agent tool and authenticated runner flow. They are bound to the current command, execution generation and attempt. Koed does not infer these phases from conversation text or command names. Waiting and Offline take precedence over the reported phase.

The start time is the first actual attempt to execute that Job. It is not the time the Conversation, Agent or publication was created. A queued Job with no attempt has no start time. Retrying a Job does not reset its original start time. The two-hour Running long highlight is informational; it does not stop work or trigger an automatic action.

## Idle and history

The Idle strip shows Agents whose owners explicitly made them available to this Team and who have no active published Job in this Team. Its label is **No active Job in this Team**. These Agents may be working privately elsewhere. The strip does not assign them to a Project or reveal private activity.

Finished and history retain the actual outcome, including failure and cancellation. Entries whose owners left the Team remain frozen history with an Owner left Team label. Departure does not mark unfinished work as completed. Frozen state and phase timestamps do not change when the underlying private work changes later.

Current work is loaded before the remaining paginated history. Idle eligibility is computed across all current Team publications, not just the first page.

## Details and permissions

The side panel opens Highlights by default. Selecting a room opens its Job list; selecting a Job opens its details. Shared surfaces show only a brief the owner reviewed and explicitly shared with this Team. Otherwise they show Details not shared.

The owner can share, edit or withdraw that brief. Private brief drafts remain owner-only. Team administrators retain the existing permitted controls for a former owner's retained brief and for Project sharing. Connecting a local Project continues to use the member's own Project link.

Open workshop reuses the owner's existing working Conversation. Its execution locator is returned only to that owner, and the destination verifies ownership again. A teammate's private Conversation or workshop is not made accessible by selecting their Job. Public Square does not publish prompts, transcripts, Memory evidence or raw results.

## Refresh and recovery

Native and hosted Studio use the same Team-scoped backend data and existing realtime invalidations. Background refresh keeps the map mounted so confirmed changes can move entries between areas. Account changes, Team changes and access loss retain the existing response guards. A failed authoritative read is shown as unavailable; an HTTP response alone is not proof of a live connection.
