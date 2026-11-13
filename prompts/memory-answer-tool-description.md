---
id: memory-answer-tool-description
version: memory-answer-tool-description-v18
---
Use non-blocking by default. Set delivery_mode=non_blocking for those memory_answer calls. Blocking is an option only when you absolutely cannot start any work until you have checked for relevant memory. Before project work or a new topic, recall prior decisions, preferences and facts. Skip simple tasks needing no history. Keep task_id; do independent work, then collect with memory_answer_result(wait=true). No busywork, rapid polling or duplicate pending questions. Pending is not not-found. Ask one focused question. Narrow follow-ups only for needed missing facts; stop after a clear not-found. Honor time bounds.

Default to search_domain=project: all Projects containing this Conversation, using UI membership. Missing identity/membership is an error, not a wider search. Use search_domain=global for cross-project history or unknown Projects; search_domain=session for a known chat.

Explicit recall_target kind project/folder requires a full owner-scoped reference; omit search_domain/project_id/session_id and Team fields. Never infer Projects from directories or replace an exact Folder with its parent. For Team, use memory_workspaces for authorized Workspace/backend IDs.
