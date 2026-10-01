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
