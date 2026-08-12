# Koed Prompts

This directory contains bundled prompt text for Koed surfaces that call the
local AI Client:

- MCP Server instructions and `memory_answer` tool description
- Memory Answer worker task prompt
- LCM Summary worker prompts
- Session title worker prompt
- AI Client base and developer instructions for local workers
- Prompt-bearing eval judge templates

Self-hosted Operators may override these files by setting `KOED_PROMPT_DIR` to
a directory that mirrors this layout. Missing override files fall back to these
bundled defaults. When `KOED_PROMPT_DIR` is configured, the directory itself
must exist and be readable; an invalid configured directory fails startup
instead of silently disabling all overrides.

Prompt files use simple Markdown plus frontmatter:

```markdown
---
id: memory-answer-worker
version: memory-answer-worker-v4
---

Prompt body with {{placeholder_name}} values.
```

The frontmatter `id` must match the requested prompt. Dynamic JSON schemas,
parser validation, retrieval boundaries, source serialization, redaction rules,
authorization, and persistence behavior remain owned by code.

Each prompt id also has a code-owned set of required runtime placeholders.
Overrides may change wording and add optional content, but they must retain all
required placeholders so they cannot remove the query, evidence, or output
contract supplied by Koed.
