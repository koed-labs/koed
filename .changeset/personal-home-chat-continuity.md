---
"@koed/koed": minor
---

Improve Home refresh behavior and project selection across AI chat composers. Keep chat execution local, allow conversations without selecting an Agent, and carry Home messages and model settings into New chat.

Fix Codex conversation startup and continuation identity checks, show accepted prompts while tasks are pending or fail, and render AI replies with Markdown formatting.

Select newly started conversations in the sidebar, give them a short title from the first message, and support renaming while preserving the chosen model and reasoning. Remember the last-used AI Client model and reasoning for new chats, including after a desktop restart.

Preserve explicitly selected project folders even inside a parent Git repository. Run those folder-scoped chats at the chosen directory with the existing plain-folder capabilities; retain normal Git checkpoint guarantees for repository roots.

Match Home suggestions to the rounded chips in New chat. Simplify Home activity to Needs you, Ongoing work, and Cleared, with five items per page and navigation to the remaining items.

Show subtle Agent progress across AI chats, including current task status, elapsed wait time and reported activity without exposing private reasoning. Populate the activity panel for direct chats without a named Agent Job, show verified execution settings and command results in Advanced, remember the panel state and Simple/Advanced preference after refresh, and keep its minimized summary visible with the desktop sidebar open.

Show the last five human and AI exchanges in the Simple activity view and expandable file patches in Advanced. Use saved Git checkpoint diffs where available, and label recorded AI Client edits in plain folders with their confirmation status. Keep these details available for direct and hosted chats.

Resolve selected nested folders to their registered Project instead of creating duplicate discovery entries from historical parent-folder metadata. Keep all visible Project conversations in the sidebar when Home is filtered.

Keep saved conversations visible in Project and standalone navigation while the runtime reconciles, pauses, or stops.

Simplify Personal conversation headers to the chat title and an optional folder icon whose tooltip names the Project. Remove the redundant Current Project label, separate Move to Project button, Personal prefix, and three-dot End session menu.

Allow confirmed failed chats stuck in reconciliation to reconnect and continue the existing conversation without automatically replaying a failed message.

Resume verified unchanged Codex conversation history while memory Projection catches up, retaining the backlog guard for actual history rebases.

Show recent readable conversation notes in Advanced activity alongside technical details and file changes, with individual expand/collapse controls for notes and command outputs. Show newest entries first in both Simple and Advanced, with the latest file diff directly beneath its command note.

Show subtle live Agent activity and public reasoning summaries, retaining completed activity collapsed beside each request.

Show lines added in green and deleted in red in the compact Advanced activity card.

Simplify Agents to a name, optional free-text job title and Pixelkin appearance. Remove soul instructions, title templates and profile-specific model defaults from new Agent edits. Keep model, reasoning and access choices in the conversation.

Use native conversation execution and retained delivery records for new Agent work, history and progress. Retire the extra Agent assignment and phase-reporting protocol, remove eager Agent-specific Memory searches, and use the supported Memory flow for all AI chats. Preserve legacy history and sequential conversations with Agents from the same or different AI Clients.

Share local and hosted Personal recipient validation for model, reasoning, permissions and verified device selection. Keep the progress panel with native command activity, readable conversation summaries and labeled file diffs.

Restore owner-approved Agent execution from Team channel requests through the existing native conversation and command lifecycle. Keep private review, durable request status, owner-only controls and explicit question/result sharing, while preserving legacy request history. Draft native request summaries from the exact accepted command rather than unrelated private follow-ups.

Project native Agent activity into Public Square without creating another Job lifecycle. Preserve legacy history, owner-reviewed briefs for each Team, private conversation boundaries and honest queued, waiting, offline and uncertain states.

Complete Pull Request reviews through native conversation commands and editable drafts, preserving exact revision, runner and GitHub account checks. Discover new Pull Requests every five minutes through shared, bounded metadata reads, with manual refresh and visible partial coverage. Keep follow-up chat separate from explicit review refreshes and retain confirmation before GitHub publication.

Connect Home to native Agent commands and conversation deliveries, retaining legacy history and synchronized reminder clearing. Preserve private owned work, accurate attention badges and canonical conversation navigation without creating another Job lifecycle.

Connect Team For you to native Agent work while preserving message attention and retained history. Keep shared outcomes, reminders and seen acknowledgements scoped to each User and Team, with safe links to published work and no private chat content. Preserve loaded For you pages across refreshes and keep identical reminders independent in each Team.

Enable instruction-only Claude Project guidance for fresh sessions after live validation. Load a bounded root CLAUDE.md into a private immutable session snapshot while keeping Koed permissions and filesystem settings isolation intact. Preserve snapshot expectations through restart, show root-only progress and readable failures, and reject unverified selected-skill turns before submission. Keep existing conversations unchanged and retain an explicit initialization rollback switch; marked sessions still require their frozen snapshots. Reject fork/device transfer of instruction-enabled sessions before changing source state.

Refresh Team Agent request status when its bound native work changes, without exposing private execution data or changing request consent versions. Keep unrelated private activity and work after owner departure outside Team status notifications.

Reuse the Team Agent request workflow in private and group chats for Agents owned by current participants. Keep owner review and native execution private, require explicit result sharing to the originating chat, and preserve shared Project authorization without widening the chat audience. Preserve human mentions and drafts when changing chats, and prevent delayed Agent setup from sending or navigating after the User leaves its originating conversation.

Reuse one scoped native Skill picker across Studio and Electron AI chats, including owner-private launch. Distinguish AI Client availability from Koed execution support, keep discovery bounded, and recheck Client/device access before returning resources. Preserve opaque Skill selections across first and later messages, clear them when the execution scope changes, and require fresh choices after expiry. Installation and account sign-in remain in the original AI Client.

Support one verified native Claude Skill per turn through an isolated adapter for the pinned runtime. Keep filesystem settings and hooks disabled, preserve Koed's tool approval decisions, and leave incompatible extensions unavailable for managed execution. Reuse the configured Client's native definitions through the existing capture flow, without pasting Skill bodies into the chat prompt or adding another Memory path. Keep native Skill-expansion records out of human-message display while preserving raw provider evidence.

Add owner-managed recurring Agent tasks with interval or time-zone-aware daily and weekly schedules. Keep each run in a private native Codex or Claude conversation with the existing Memory, permissions and progress flow. Save changes paused, require explicit activation, run only the latest missed occurrence after offline time, prevent overlapping runs and require review when earlier effects are uncertain. Include pause, Run now, archive and occurrence history without automatically sharing results with Teams.

Keep hosted Collaboration composers read-only until their verified draft is ready. Preserve new text and human mentions when an earlier chat finishes sending after the User switches conversations.

Recognize checksum-verified embedding model status during Desktop setup, while keeping privacy-model and installation success checks strict. Prevent a valid local model from leaving setup blocked.

Preserve Collaboration forms and drafts when returning from a native dialog or refreshing the same authenticated Team context on focus. Clear the workspace when access changes or revalidation fails, and keep explicit refresh behavior intact.

Use the authenticated Team principal and backend for Agent availability instead of comparing the remote account with the separate local private-draft owner. Preserve server ownership checks and clear stale Team context when authentication changes.

Wake paired runners when a local Project runtime binding is created, alongside remote command notifications. Prepare the selected Project promptly and clean up local notification connections during setup failures and shutdown.

Preserve the active chat when a private Team Agent review updates its URL version. Keep the first message and selected AI Client settings through the execution-start handoff instead of remounting the composer before the prompt is sent.

Wire paired runners to the existing private Team Agent review lookups. Recheck owner, Device and execution authority before dispatch, retaining read-only planning for unaccepted requests and the existing access checks for accepted work.

Bound paired-runner output recovery to the current execution generation and provider turn, using the existing encrypted runtime items. Preserve the owner’s review controls and unsaved edits during status refreshes. Restore Team request context when reopening a private Agent conversation, and offer an explicit new blank planning chat for eligible stopped reviews without replaying an unconfirmed prompt.

Keep Team review versions current through delayed chat starts and preserve the verified Agent selection when reopening a private review. Keep recovery tied to the same authenticated runner and require a new message in a fresh planning chat.
