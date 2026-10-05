---
"@koed/koed": minor
---

Improve Home refresh behavior and project selection across AI chat composers. Keep chat execution local, allow conversations without selecting an Agent, and carry Home messages and model settings into New chat.

Fix Codex conversation startup and continuation identity checks, show accepted prompts while tasks are pending or fail, and render AI replies with Markdown formatting.

Select newly started conversations in the sidebar, give them a short title from the first message, and support renaming while preserving the chosen model and reasoning. Remember the last-used AI Client model and reasoning for new chats, including after a desktop restart.

Preserve explicitly selected project folders even inside a parent Git repository. Run those folder-scoped chats at the chosen directory with the existing plain-folder capabilities; retain normal Git checkpoint guarantees for repository roots.
