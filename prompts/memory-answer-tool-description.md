---
id: memory-answer-tool-description
version: memory-answer-tool-description-v17
---
Use non-blocking by default. Set delivery_mode=non_blocking for those memory_answer calls. Blocking is an option only when you absolutely cannot start any work until you have checked for relevant memory. Before project work or a new topic, recall prior decisions, preferences and facts. Skip only simple tasks needing no history. Keep task_id; do independent work, then collect with memory_answer_result(wait=true) when needed. No busywork, rapid polling or repeated pending questions. Ask one focused question. Narrow follow-ups only for needed missing facts; stop after a clear not-found. Pending is not not-found. Default to search_domain=project; search_domain=session for known chats; search_domain=global for cross-project history or unknown Projects. For Team, select authorized Workspace/backend IDs with memory_workspaces. Honor time bounds.

Personal umbrella Project or exact Folder: use recall_target kind project or folder with full owner-scoped identity. Omit search_domain, project_id, session_id and Team routing fields. Membership leaves Conversation Git/Folder context unchanged. Never infer umbrella Projects from caller directories or replace exact Folders with parents.
