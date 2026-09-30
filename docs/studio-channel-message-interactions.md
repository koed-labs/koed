# Studio channel message interactions

Team channel messages use Koed’s existing encrypted collaboration storage, current channel authorization, durable delivery and realtime recovery. They remain collaboration data; they do not become Personal or Team Memory automatically.

## Replies and unread activity

Reply in thread opens the prototype’s right-side Thread pane. The pane shows the original channel message and a flat list of replies. Replying to a reply keeps the same original message as its root. The main channel shows the original message with a reply count and a link to the thread.

Every member with current channel access may view and reply. A reply carries the original message identity in addition to its channel identity. Delivery retains a stable client message identity and uses the existing Pending path. Access is checked again when delivery resumes. Exact retries validate the original accepted content and root even if the author has since edited the message. The sender’s receipt carries that accepted content separately from the latest message shown in Studio.

The channel and each message thread have separate read progress. Viewing the main channel cannot mark hidden replies read. Thread replies become read only when visible in the open thread. Channel unread activity includes unseen thread replies.

## Editing

Only the message author with current channel access may edit a channel message or reply. A saved edit displays the latest text with an Edited label. Previous versions are retained encrypted. This feature does not provide a version-history viewer.

Each save checks the version the editor started from. If another window or device saved a newer version, Studio keeps the unsaved draft and displays the latest saved text. The User must review that version before saving again. Draft text, its version basis and conflict information stay encrypted on the device, scoped to the verified account, backend, Team, channel and message.

While disconnected, the User may continue editing locally. Saving requires a restored connection and current authorization.

## Reactions

Members with current channel access can add or remove their own emoji reactions to messages and replies. Matching emoji appear together with a count. Studio highlights the current User’s selections.

Writes set the desired state for that User, message and emoji. Repeating the same write does not add a second contribution or accidentally toggle it back. Reaction changes require a connection.

## Agent requests

A request made inside a message thread preserves that root as its destination. Ticket13’s owner-controlled review, acceptance and explicit forwarding still apply. Reviewed questions and outcome summaries return to that original thread.

Editing a public message changes its visible text. It cannot silently update an accepted private goal, alter a Job, dispatch work or steer an Agent. Reactions and thread participation do not grant Agent control.

## Backend contracts and storage

Collaboration contract version 7 adds the root identity to message paging, sending, read progress and delivery receipts. Edit commands carry the expected message version. Reaction commands carry the desired active state. Realtime `message_updated` events carry current authorized message aggregates so other clients can reconcile edits, reply counts and reactions.

Migration `0062_team_channel_message_threads.sql` adds message versions, encrypted revisions, reaction membership and root-specific read progress. Database constraints bind replies and their read receipts to the same channel and original message. Existing purge relationships remain intact. A member’s current access is checked for each read or write.

Exact send recovery keeps the original accepted body separately from the latest edited message. Protected receipt lookup and acknowledgment also check the captured root. A mismatched acknowledgment leaves the receipt intact. Original legacy receipts can be read through the protected upgrade path; an edited receipt without original-content proof is rejected.

## Validation and later work

The Ticket14 review script records the exact tested revision and results for Desktop, hosted Studio, Pending replies, unread progress, edit conflicts, reaction convergence and access revocation. Popup and system notifications remain later work. A history viewer and deletion policy require separate product decisions.
