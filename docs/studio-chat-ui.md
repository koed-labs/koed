# Shared Chat UI

Studio uses a common presentation component for Agent Conversations and human Team chats. `SharedChatUI` owns the message list, scrolling, composer placement and conversation navigation. Each screen supplies its existing controller, loaded messages and explicit mode.

Agent mode displays execution controls. Human mode displays formatting controls. Selecting an Agent in a Team composer uses the existing Agent controls and private handoff. It does not publish the private Agent Conversation to the channel.

Native Studio, hosted Studio and PR chat use `AgentChatMessage` for the common Agent message body. Screens add their existing Memory attribution, feedback, requests and context-specific actions. Human message bodies keep their existing reactions, edits, delivery receipts and thread actions.

Home uses the common composer presentation without a transcript. Project Conversations, standalone Conversations and workshop links retain their existing routes. PR chat retains its own execution adapter and narrow panel. The presentation component does not change account, Team, Project or PR authority.

The navigation rail marks the viewer’s loaded messages. Hover or keyboard focus shows a bounded plain-text preview. Selecting a marker jumps to its message. The current exchange is highlighted. Chat panels below600 pixels hide the rail, and reduced-motion preferences control jump animation.

Navigation uses stable message IDs and resets when its scope changes. The component follows new output while the viewer stays at the bottom. Manual scrolling and navigation preserve the viewer’s position. Loading earlier messages remains an explicit action in the existing controller.

## Extending the component

A message adapter converts a screen’s authorized records into the common presentation fields. The adapter supplies stable IDs and explicit viewer authorship. The screen supplies message-specific actions and its composer. Keep backend requests, draft persistence, streaming reconciliation and permission checks in the existing controller.

Changes to common scrolling, navigation or message presentation belong in the shared component. Capability differences belong in the mode and screen adapter. Private Agent history must never become a human channel message through this adaptation.

## Validation

Use focused navigation tests, Studio typechecking and the configured Studio suite. Validate native and hosted layouts from the same frozen source. Include a long loaded Conversation, a narrow PR panel and human Team messages with existing actions.

Make sure that keyboard jumps, previews and manual scrolling work with variable-height replies. Make sure that scope changes clear the old navigation state. Navigation must not send commands, request unloaded history or call an AI Client. Reuse existing backend authority evidence when those contracts remain unchanged.

## Completed review — October 1, 2026

The configured Studio suite passed309 tests. Studio typechecking and native/hosted builds passed. Changed-file lint added no findings against the existing baseline. Desktop and web acceptance passed long loaded histories, bounded previews, keyboard jumps, stable viewport scrolling, compact panels, human/Agent controls, thread actions and Memory feedback. Narrow composer controls wrap to avoid overlap.

Review history fixtures changed only authorized GET responses. Navigation made no execution or feedback writes and did not request earlier history. Existing provider/device evidence was reused; no new live provider streaming turn was run. Local preview adapters were reviewed and typechecked. Private fixtures and credentials remain outside Git.

## Small shared frontend pieces

`toTeamChatMessages` in `src/lib/team-chat-messages.ts` adapts authorized Team messages for Desktop, web and thread views. It preserves message IDs, content and source records, and computes viewer authorship explicitly. Callers retain their existing visibility tracking, read receipts, edits, reactions and transport.

Project and channel creation use a shared selection-card presentation. Their enabled and disabled behavior remains controlled by each modal. The old unused Public Square view and unused Personal Preview project modal have been removed; active preview routes remain supported.

Human Team channel rows now use `TeamChannelMessageContent`. It renders author, body, reply, edit, reaction and forwarding controls. Desktop and web retain their outer message rows, visibility observers and read receipts. Direct messages continue to use `TeamDirectMessageBubble`.

Team Memory settings use the shared panels in `TeamMemorySettingsPresentation`. Each controller supplies authorized records and actions. Retention, cancellation, removal and review eligibility remain in the original Desktop or web controller, together with account, Team and version guards. Existing labels and layout differences are preserved.

Large controller and composer restructuring remains deferred in `TODO.md`. These extractions change no backend contract or service boundary.

### Cleanup validation

The configured Studio suite passed312 tests, including3 new Team message adapter checks. Studio typechecking, formatting, diff checks and native/hosted builds passed. Changed-file lint added no findings against the existing67 findings in the two Team workspace controllers.

Final Desktop/web UI checks passed channel selection, human formatting, Agent invocation, thread opening, edit cancellation, reaction pickers and PR chat. Desktop also checked the local Project picker and disabled Collaborative option; web checked disabled Project-channel creation. These checks submitted no messages, reactions, Projects or execution commands. The final review source digest was `46c8ac10997681e788815e3d42e39df8988384e2f75d13c0d578b6e338b0ba5c`, based on `a59d5fcb`. Private review artifacts remain outside Git.

## Shared chat panels and review navigation

`ProjectMovePicker` provides the common destination selector and review/cancel controls. Each caller supplies its authorized Project options and original disabled condition; the hosted Move feature gate remains unchanged. `PrepareTeamQuestionAction` provides the common message action. Callers retain their eligibility rules and text limits.

`teamReviewSavedHref` centralizes conditional review-version URL updates while preserving the current route and query parameters. Controllers retain saved-review state, account/Team scope, transport and recovery. These extractions introduce no backend contract or service-boundary changes.

### Chat-panel extraction validation

The configured Studio suite passed315 tests, including3 review-navigation tests. The role-template client suite passed14 tests. Studio typechecking, native/hosted builds, formatting and diff checks passed. Changed-file lint retained one existing LiveAgentChat warning and added no findings. Desktop/web checks passed existing Team chat controls, thread actions and PR chat; no messages or execution commands were submitted.

The reported Agent suggestion issue was traced to an empty published catalogue in the running review backend. The existing Local Operator Script published the six unchanged reviewed templates using a loopback database connection. No migration, new template, permission change or existing-Agent update was needed. Desktop/web checks verified Project Manager suggestions, explicit instruction application and provenance, replacement confirmation, empty/failed catalogue retry and zero Agent/execution writes. Original device drafts were restored after the checks.

UI review digest: `f4539700233c00629aa9f89fbf8ba603ba8daf5fe1f3340e9c6a72fd11f368d5`, based on `332584fa`. Final source formatting only followed the builds. Private artifacts remain outside Git.

## Shared Team rows and Memory settings validation

The configured Studio suite passed all315 tests, including the7 Team Memory guard tests. Studio typechecking, changed-file formatting, native and hosted builds passed. The new presenters and both settings controllers have no lint findings; the existing67 Team workspace findings are unchanged.

Desktop and web checks passed channel formatting, Agent invocation, main-feed and thread reaction pickers, edit cancellation, replies and PR chat. Team Memory checks passed member switches, all tabs, existing owned-share rows and retained-memory removal confirmation/cancellation. The retained-memory fixture replaced read responses only. No messages, execution commands or memory mutations were submitted, and no page errors were observed.

The original Team Memory request and recovery logic was compared with the previous revision; only formatting parentheses changed. The outer message-row visibility observers, attributes and read receipt callbacks remain unchanged. The review used working-tree source on `6a02c829`, digest `d3ee044c56d8ec9e1b6f2c9ddbd24f51687693de5dbefac10acf9125952ed4b0`. No new provider/device matrix was needed for these presentation changes. Private review artifacts remain outside Git.

## Agents presentation boundaries

`AgentsView` retains account verification, activity refresh pacing, late-response guards, drafts, profile edits, cloning and lifecycle actions. `AgentDetailPanel` groups Agent details with their Job cards and statistics. `WorkingAgentCard` renders current work, and `RetireAgentDialog` renders retirement confirmation. Small display-format helpers live in `agents-presentation-utils`. These are presentation extractions with unchanged markup and behavior; they introduce no service or backend contract changes.

## Team workspace hook boundaries

Desktop and web draft authorities are memoized by backend, account, Team and thread. Selection changes clear stale presentation before commit; committed refs and the existing request guards keep asynchronous reads and receipts attached to their original scope. Read markers reset when the selected channel or authority changes.

Hosted reconnect retry calls the existing reply-send pipeline through a React Effect Event. The shared draft helper preserves text typed after a pending reply. Same-channel message refreshes merge authorized messages with already loaded pages and live updates. No lint rule is suppressed, and no backend contract changes are introduced.

### Agents and hook cleanup validation

The configured Studio suite passed315 tests, and the focused Agents suites passed26 tests. All affected runtime files have zero lint errors or warnings, including the two Team controllers that previously had67 findings. Studio typechecking, formatting, diff checks and native/hosted builds passed. No lint suppression or artificial scheduling was added.

Desktop/web checks passed Agents Cards/List views, lifecycle filters, retire/restore, verified current work, failed-read recovery and late-response guards. Existing Agent functions were compared with the previous revision and retained their original bodies. Chat checks passed human/Agent controls, thread and PR chat, edit cancellation, reactions, live teammate reply/edit updates, author-only edit controls and preservation of typed drafts during updates.

Draft checks covered channel switching, reload, offline edits and returning to a thread. The web offline reply check verified one accepted message after reconnect, preservation of later unsent text after receipt settlement and reload, and encrypted edit-draft recovery. Recovery tests wait for asynchronous hydration rather than assuming a fixed delay. Independent review checked revoked-Team cache cleanup and account/backend-scoped read state; delayed cleanup is guarded against a newer authority or authorization snapshot. Synthetic message writes used the isolated review Team only. No Agent execution, production data or backend contract was changed.

The final runtime review source digest was `bc76b2444585c8115b27a7efcfad5265c120c0b5cc729aa48d6b08cb5932a305`, based on `a9ed7a5a`. The additional web account-switch check passed draft isolation and channel-pane reset. Release bookkeeping remains deferred to the combined epic review, as previously agreed. Private credentials and review artifacts remain outside Git.

## Live Agent progress

`SharedChatUI` renders `AgentThinkingIndicator` beneath the transcript when a controller supplies `AgentChatProgress`. Native New Chat, standalone and Project Conversations, hosted Conversations, private Team Agent chats and real PR chats adapt their existing managed runtime through `managedChatProgress`. Home hands the submitted message to that live Conversation. Team channel and thread request cards use the same indicator with shared assignment status only; ordinary human chats have no Agent indicator.

The quiet progress line distinguishes sending, queued work, active work, streaming replies, required input and uncertain task status. An elapsed wait timer starts when the current indicator appears, resets for a new command and stops while waiting for input or checking an uncertain outcome. It is not an estimate of completion or server execution time. Motion respects reduced-motion settings, and timer updates are excluded from live-region announcements.

Only explicit user-facing phase signals from an active selected Job appear in the collapsed Agent activity details, capped at five bounded entries. Raw provider reasoning, hidden runtime items and previous-generation output are never displayed. Completion, failure, cancellation and stopped executions remove the indicator; existing error, approval, Stop and cancellation controls retain their behavior. This presentation reuses the existing runtime and progress refresh cadence without new network polling or backend contracts.

## Conversation activity panel

Native and hosted managed Conversations populate the Build panel from named Agent Jobs when available. Direct chats without a Job use the matching execution generation and latest runtime command instead, displaying its verified status and matching user request. Completed direct chats show a bounded excerpt of the matching Agent reply as an explicitly reported outcome in Simple. Replies from other requests and Personal Memory attribution footers are excluded. Advanced adds the execution client, model, reasoning setting and access policy, and retains reported command results. Assistant replies are not treated as evidence of file edits.

Completed direct chats also read the existing owner-authorized saved turn-diff API. Execution, generation and command identity must match before its file changes enter the existing Advanced presenter. The controller caches up to five bounded results per owner/backend scope, retaining display patches without adding polling. Line counts come from complete text hunks only; binary, excluded or truncated patches leave totals unknown. Older tasks use their saved checkpoints rather than today's workspace. Plain-folder Codex turns can use the recorded-edit fallback below; other requests without a saved diff explicitly report unavailable file counts. Named Job events retain their existing source and history, with the latest conversation patches labelled separately.

The panel labels its plain-language view Simple and shares the saved Simple/Advanced preference through `BuildViewProvider`. Its expanded, compact or closed state is also saved per device and restored on reload; the native chat header uses the same restored state for layout. Invalid or unavailable storage falls back to compact mode with a visible expand control. The status fallback reuses existing conversation and runtime reads without adding polling.

On desktop, minimizing retains the 300px summary card when the chat area has at least 660px available, allowing room for both the card and chat content with the sidebar open. The compact header has an explicit maximize control as well as the clickable summary. Narrow windows retain the compact expand button. Reopening a closed panel opens its full view directly. Floating controls and the panel header exclude native window dragging so mouse clicks reach the controls.

The native gateway forwards only a GET turn-diff read with an execution UUID, `scope=turn` and a command UUID. It uses the existing Desktop local credential for managed file inspection and the 4 MiB response ceiling; unsupported query parameters, full-conversation diff reads and writes are rejected. An ordinary Personal API Token is not a fallback for file inspection. Hosted reads reuse the existing managed file-read authority.

The Simple activity view retains the last five conversation exchanges from the
authorized prompt history, including the request and a readable reply summary.
Named Agent activity keeps this conversation history alongside its selected Job.
Advanced renders saved text patches in expandable, scrollable file views. Patch
retention is bounded to 200 files, 32 KiB per file, 256 KiB per turn, and five cached
turns; partial patches and unavailable content are labelled explicitly.

For a local Codex chat in a plain folder, the existing authenticated turn-diff
read can fall back to `apply_patch` edits in its bound transcript. Direct calls
require successful application output. Literal patch arguments inside completed
`exec` calls are shown as recorded patches with application explicitly unverified;
recorded JavaScript is never executed. The
API verifies the owner, execution generation, completed prompt, provider turn,
Captured Session, transcript session header, and exact project folder before
returning any edit. This reports recorded applied edits rather than pretending
to have a Git workspace comparison. Reads are limited to 16 MiB, refuse symlink
transcripts, omit out-of-project paths and sensitive content, and retain at most
100 edits and 256 KiB of patch text. Unrecorded shell writes, other AI Clients,
missing transcripts, and deleted-file contents still have no recoverable patch.
No Git repository is created and the parent repository is never inspected.

### Personal Project discovery

Local conversation discovery prefers a registered Project's canonical root over another Project's historical working-directory alias. This keeps an explicitly selected nested folder separate from its parent and reuses its registered ID rather than creating a duplicate discovery Project. Conflicting records for the same root remain ambiguous, and unrelated folders are never merged by name. Home filters affect its content only; the sidebar retains conversations across all visible Projects.

Saved conversations remain in sidebar navigation during reconciliation, pause and stop transitions, as well as after stopping or failure. Their current runtime state does not change their Project association.

The Personal conversation header shows a folder icon beside the chat title only when the conversation belongs to a Project. Hovering or focusing the icon reveals the Project name. The redundant Current Project label and separate Move to Project header button are removed; the composer retains its folder picker.

The Personal chat header contains only the conversation title and optional Project folder icon. It omits the Personal prefix and the three-dot End session menu.
