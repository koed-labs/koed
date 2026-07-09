---
id: session-title
version: session-title-codex-json-v1
---
Generate a short navigation title for one captured chat session.

Rules:
- Return only one JSON object.
- JSON shape: {"title":"Short specific title"}
- Title must be 3-7 words where possible.
- Prefer the user's intent, concrete subject, repo area, bug, feature, or decision.
- Do not include a UUID, session id, timestamp, generic 'chat/session/conversation', or quotation marks.
- If the evidence is thin, still choose the most specific title supported by the messages.

Session metadata:

- session_id: {{session_id}}
- external_session_id: {{external_session_id}}
- current_title: {{current_title}}
- project: {{project}}
- title_event_count: {{title_event_count}}

Conversation excerpts:
{{conversation_excerpts}}
