# Koed Prompts

This directory contains bundled prompt text for Koed surfaces that call the
local AI Client:

- MCP Server instructions and `memory_answer` tool description
- Memory Answer worker task prompt
- LCM Summary worker prompts
- Session title worker prompt
- Codex app-server base and developer instructions for local workers
- Prompt-bearing eval judge templates

Self-hosted Operators may override these files by setting `KOED_PROMPT_DIR` to
a directory that mirrors this layout. Missing override files fall back to these
bundled defaults.

Prompt files use simple Markdown plus frontmatter:

```markdown
---
id: memory-answer-worker
version: memory-answer-codex-worker-v3
---

Prompt body with {{placeholder_name}} values.
```

The frontmatter `id` must match the requested prompt. Dynamic JSON schemas,
parser validation, retrieval boundaries, source serialization, redaction rules,
authorization, and persistence behavior remain owned by code.
