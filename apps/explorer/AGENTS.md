# AGENTS.md

## Task Completion Requirements

- All of `pnpm fmt:check` and `pnpm typecheck` must pass before considering tasks completed.
- Use `pnpm test` for Vitest.

## Project Snapshot

Koed Explorer is a focused React/Vite web app for browsing captured Koed memory
history.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (API errors, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

Before changing the explorer shell, thread detail loading, sidebar behavior, or
message/event timeline rendering, preserve the project/thread shell, bounded
prewarming, warm detail cache, normalized state, and long-thread virtualization.
These are deliberate architecture, not incidental implementation details.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/explorer`: React/Vite UI. Owns the Koed Explorer and client-side state.

The long-term target is a bare-bones web deployment. Prefer removing unused T3
shell code over preserving upstream abstractions when the Koed app no longer
depends on them.
