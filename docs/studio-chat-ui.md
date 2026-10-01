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

Further message-row, chat-panel and Team Memory settings extraction is recorded in `TODO.md`. Coordinate those changes before starting new tickets in the affected components. Large controller and composer restructuring is deferred. This cleanup changes no backend contract or service boundary.

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
