---
id: memory-answer-tool-description
version: memory-answer-tool-description-v6
---
Recall captured AI Client conversations, remembered user preferences, and user-provided facts. Before substantive work in a new chat or on a sufficiently new topic, call memory_answer when prior knowledge could affect the task. Ask one focused question; call again with a narrower question if needed; stop after a clear not-found answer. Default to search_domain=project; use search_domain=session for a known conversation and search_domain=global only for cross-project recall. Team recall requires authorized Team Workspace scope: call memory_workspaces to discover IDs, then pass team_workspace_id and team_backend_id. Global without a Workspace searches Personal Memory only. Use global within a Workspace for Team-wide questions; project/session also filter shared source context. Add time bounds only when requested. Default to answer_only; use with_citations for sources and with_evidence for debugging.
