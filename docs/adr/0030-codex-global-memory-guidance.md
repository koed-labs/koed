# ADR 0030: Managed Codex Global Memory Guidance

## Status

Accepted.

## Context

The `memory_answer` tool description explains recall after Codex discovers the
tool, but it does not reliably establish when an AI Client should consult prior
Personal or Team Memory. Project-level `AGENTS.md` files are owned by Users and
repositories, so Koed must not replace or require edits to them.

Codex loads `AGENTS.md` from `CODEX_HOME` as global User instructions before
applying Project instructions. Koed already manages the Codex MCP Server and
Supported Capture Hook configuration during setup and repair.

## Decision

Codex setup and repair reconcile one Koed-managed Markdown block in
`CODEX_HOME/AGENTS.md`. The block tells Codex when to consult `memory_answer`,
how to ask focused follow-up questions, and when recall may be skipped.

The guidance is recommended and enabled by default, but it is not required for
the MCP Server or Capture Hook to operate. Koed persists an explicit opt-out in
its existing server configuration. Setup and repair then remove the managed
block, status and doctor treat its absence as healthy, and an explicit opt-in
reinstalls it.

Koed preserves all content outside its explicit HTML comment markers. Repeated
setup is idempotent, and a changed bundled guidance asset replaces only the
managed block. Missing or stale guidance is repairable through the existing
Codex integration action. Ambiguous, duplicated, or unmatched markers fail
closed with a diagnostic; Koed does not guess which User content to rewrite.

The canonical guidance ships with the MCP Server prompt assets so checkout,
standalone, and Desktop setup use the same text. Codex status and doctor compare
the installed block with that packaged asset. A Codex restart is required after
the global instructions change.

## Consequences

- Project `AGENTS.md` files remain untouched and can add more specific Project
  instructions.
- Koed can update or remove its own block without taking ownership of the
  global file.
- Codex integration health includes proactive memory guidance as well as MCP
  Server and Supported Capture Hook configuration.
- Other supported AI Clients require their own instruction mechanism; this ADR
  does not treat Codex global instructions as a generic AI-client contract.
