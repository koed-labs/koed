# Local Memory Agent Settings

Koed performs answer and summary synthesis through the connected AI
Client. The backend stores memory and evidence, but it does not run LLM
synthesis itself.

## Flows

Four local synthesis flows have independent effective settings:

- MCP Memory Answer: the `memory_answer` tool used by an AI Client.
- Manual Memory Question: a question sent from the Explorer questions composer.
- LCM Summary: background LCM summary synthesis run by the MCP Server.
- Curated Memory Review: semantic review of durable-memory proposals run by the MCP Server.

Codex is the only supported AI Client for these flows today. The settings model
keeps Codex as a provider/CLI selection so additional AI Client connectors can
be added later without changing the Explorer layout.

## Precedence

MCP Memory Answer settings are resolved in this order:

1. API user settings edited in the Explorer Settings panel.
2. `MEMORY_ANSWER_*`.
3. Documented code defaults.

Manual Memory Question settings are resolved in this order:

1. The per-question settings selected in the Explorer.
2. `MEMORY_MANUAL_ANSWER_*`.
3. `MEMORY_ANSWER_*`.
4. Documented code defaults.

LCM Summary settings are resolved in this order:

1. API user settings edited in the Explorer Settings panel.
2. `MEMORY_LCM_SUMMARY_*`.
3. Documented code defaults.

Curated Memory Review settings are resolved in this order:

1. API user setting stored in `local_memory_agent_settings`.
2. `MEMORY_CURATED_REVIEW_*`.
3. Documented code defaults.

The default model and reasoning effort for all four flows are
`gpt-5.6-luna` and `low`. Manual Memory Questions inherit the Memory Answer
defaults unless they are overridden for a question.

`MEMORY_CODEX_APP_SERVER_BINARY` is the preferred app-server binary setting for
all Codex-backed flows. Flow-specific legacy binary aliases are still read for
compatibility, but fresh installs should use the shared setting.

## Availability

The Explorer asks the local answer bridge for effective settings, Codex
availability, and Codex app-server `model/list` metadata. Model selectors use
the models and supported reasoning efforts reported by Codex. If Codex
app-server cannot be started or initialized, the Explorer must disable local
manual questions and show the missing local AI Client state. Koed should not
silently fall back to another synthesis path.

The default `gpt-5.6-luna` model requires Codex CLI `0.144.0` or newer. Koed
validates each synthesis flow's configured model against one app-server
`model/list` snapshot. Client readiness remains independent from flow-model
readiness: when Codex is available but one configured model is not, valid
alternatives remain selectable so the User can recover in Settings. A flow
with an unavailable model remains unavailable until an exposed model is
selected; it does not silently fall back or fail later during synthesis.

## Persistence

MCP Memory Answer, LCM Summary, and Curated Memory Review user settings are
stored in `local_memory_agent_settings`. The local MCP/bridge reads those
settings at execution time, so changing Settings affects subsequent memory
answers, LCM summary claims, and durable-memory reviews without editing `.env`.

Manual Memory Question settings are stored on the `memory_questions` row when
the question is created. This lets background catch-up and retry use the same
model, reasoning effort, timeout, and attempt settings chosen by the User.

## Editing Scope

The Explorer Settings panel edits MCP Memory Answer and LCM Summary settings.
Manual Memory Questions are selected at prompt time in the composer and are not
shown as a separate Settings card.
