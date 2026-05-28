# Agent Guidance

## Domain Language

- Read `CONTEXT.md` before making domain, naming, API, documentation, or user-facing wording changes.
- Treat `CONTEXT.md` as the glossary and relationship map for Koed Self-Hosted. It is not an implementation spec, roadmap, scratch pad, or changelog.
- Keep `CONTEXT.md` implementation-free. Add only resolved domain terms, relationships, example dialogue, and flagged ambiguities.
- Use the canonical terms from `CONTEXT.md`, especially **Operator**, **Operator Console**, **User**, **API Token**, **AI Client**, **MCP Server**, **Capture Hook**, **Supported Capture Hook**, **Memory Answer**, **Evidence Bundle**, **LCM Placeholder**, **LCM Summary**, **Personal Memory**, **Capture Policy**, **Capture State**, **Capture Target**, and **Capture Pause**.
- If a requested change conflicts with `CONTEXT.md`, stop and surface the conflict instead of silently inventing new language.

## Planning And TODOs

- Put implementation follow-ups in `TODO.md`, not `CONTEXT.md`.
- `TODO.md` is the current implementation backlog from the domain discussion. Check it before starting cleanup work.
- Current API-token behavior is personal-memory only.
- Server-side LLM synthesis is out of scope for this self-hosted build. Do not add or revive backend LLM calls for answer or LCM summary synthesis.

## ADRs

- ADRs live in `docs/adr/`.
- Add an ADR only for decisions that are hard to reverse, surprising without context, and the result of a real trade-off.
- `docs/adr/0001-ai-client-synthesis-only.md` is accepted direction: Koed Self-Hosted relies on the connected AI Client for LLM synthesis.

## Ticketing

- When a developer asks you to work on a Linear ticket, assign the developer to that ticket before starting work.
- Move the Linear ticket to In Progress when starting work.
- If a developer asks you to create a PR for work tied to a Linear ticket, include the appropriate Linear closing keyword in the PR description, such as `Closes KOED-123`, so the ticket state change is captured by Linear.

## Pull Requests

- Use the repository pull request template at `.github/pull_request_template.md` when drafting PR descriptions.
- Before creating a PR, validate that the change satisfies all acceptance criteria for the linked ticket. If any acceptance criterion is not met, state that explicitly in the PR description with the reason.

## Current Product Boundaries

- Codex is currently the only supported AI Client, but generic Koed naming is preferred for package names, binaries, env vars, and token names unless describing actual source provenance.
- The TypeScript capture hook is the supported Capture Hook. The Python hook has been removed.
- The MCP Server is the recall/tool integration. The Capture Hook is the only supported automatic capture path in this build.
- `memory_answer` remains the supported recall tool name, but it must not imply backend answer synthesis.
- Low-level memory tools are diagnostic-only and should stay hidden unless explicitly enabled.
- The LCM Summary Service is local background work run with the MCP Server, enabled by default, and not an agent-facing tool.
