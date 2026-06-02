# Local Memory Agent Settings

Koed Self-Hosted performs answer and summary synthesis through the connected AI
Client. The backend stores memory and evidence, but it does not run LLM
synthesis itself.

## Flows

Three local synthesis flows have independent settings:

- MCP Memory Answer: the `memory_answer` tool used by an AI Client.
- Manual Memory Question: a question sent from the Explorer questions composer.
- LCM Summary: background LCM summary synthesis run by the MCP Server.

Codex is the only supported AI Client for these flows today. The settings model
keeps Codex as a provider/CLI selection so additional AI Client connectors can
be added later without changing the Explorer layout.

## Precedence

MCP Memory Answer settings come from `MEMORY_ANSWER_*`.

Manual Memory Question settings are resolved in this order:

1. The per-question settings selected in the Explorer.
2. `MEMORY_MANUAL_ANSWER_*`.
3. `MEMORY_ANSWER_*`.
4. Documented code defaults.

LCM Summary settings come from `MEMORY_LCM_SUMMARY_*`.

`MEMORY_CODEX_APP_SERVER_BINARY` is the preferred app-server binary setting for
all Codex-backed flows. Flow-specific legacy binary aliases are still read for
compatibility, but fresh installs should use the shared setting.

## Availability

The Explorer asks the local answer bridge for effective settings and Codex
availability. If Codex app-server cannot be started or initialized, the Explorer
must disable local manual questions and show the missing local AI Client state.
Koed should not silently fall back to another synthesis path.

## Persistence

Manual Memory Question settings are stored on the `memory_questions` row when
the question is created. This lets background catch-up and retry use the same
model, reasoning effort, timeout, and attempt settings chosen by the User.

## Editing Scope

The Explorer may edit Manual Memory Question defaults because those are
per-question choices. MCP Memory Answer and LCM Summary settings are displayed
as effective local settings and edited through `.env`, followed by restarting
the MCP Server.
