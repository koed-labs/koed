# Agent Guidance

## First Stop for Fresh Clones

If you are helping an Operator or User get started in a fresh clone, begin here:

1. `README.md` → Quickstart
2. `docs/codex-integration.md` → Codex setup and manual bootstrap steps
3. `docs/running-koed.md` → local run and operation notes
4. `docs/configuration.md` → environment and deployment settings
5. `CONTEXT.md` → product language and canonical terms

Fresh-clone bootstrap should follow the README bundled-local Quickstart. The happy path avoids Docker and uses Koed-owned native local dependencies under `KOED_HOME`:

```bash
pnpm install
pnpm env:setup
pnpm build
node packages/koed-server/dist/cli.js runtime install --provider homebrew --dependency-mode bundled-local --json
node packages/koed-server/dist/cli.js models install --kind embedding --json
KOED_DEPENDENCY_MODE=bundled-local pnpm desktop:start
```

If Homebrew or native runtime installation is unavailable, surface that first instead of silently switching to Docker or another external dependency path. Docker Compose and other external dependency starters are advanced documentation paths.

If you are making code changes, keep using the contributor guidance below.

## Domain Language

- Read `CONTEXT.md` before making domain, naming, API, documentation, or user-facing wording changes.
- Treat `CONTEXT.md` as the glossary and relationship map for Koed Self-Hosted. It is not an implementation spec, roadmap, scratch pad, or changelog.
- Keep `CONTEXT.md` implementation-free. Add only resolved domain terms, relationships, example dialogue, and flagged ambiguities.
- Use the canonical terms from `CONTEXT.md`, especially **Operator**, **Local Operator Scripts**, **User**, **API Token**, **AI Client**, **MCP Server**, **Capture Hook**, **Supported Capture Hook**, **Projection**, **Project**, **Memory Answer**, **Evidence Bundle**, **LCM Placeholder**, **LCM Summary**, **Personal Memory**, **Capture Policy**, **Capture State**, **Capture Target**, and **Capture Pause**.
- If a requested change conflicts with `CONTEXT.md`, stop and surface the conflict instead of silently inventing new language.

## Architecture Documentation

- Update documentation in `/docs` whenever a change affects service ordering, service boundaries, ingestion, Projection, LCM summarisation, retrieval, embedding, storage, or AI-client integration flow.
- If a change does not require documentation updates, say so explicitly in the final response or PR description.

## Planning And TODOs

- Put implementation follow-ups in `TODO.md`, not `CONTEXT.md`.
- `TODO.md` is the current implementation backlog from the domain discussion. Check it before starting cleanup work.
- If `TODO.md` is present, check it before starting cleanup work.
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
- Prefer normal incremental commits and pushes during active review so reviewers can compare changes from the previously reviewed head. Do not rewrite branch history solely to make it cleaner; squash merging provides a clean final commit. Force-push only when a rebase, sensitive-content removal, or another necessary history rewrite requires it, and always use `--force-with-lease`. After any force-push, refresh approvals, comments, review threads, and CI because prior review state may have been invalidated.
- Immediately before posting a PR comment, submitting a review or approval, or resolving a review thread, refresh the PR head, latest commits, comments, review threads, and checks. Revalidate the intended comment or review against that current state, including changes that landed while other work was in progress, and update or discard anything that is no longer accurate.
- Before pushing PR updates, run the cheap CI-equivalent local checks that apply to the touched files, including formatting, linting, and typechecking. Use full `pnpm fmt:prettier:check`, `pnpm lint`, and relevant `pnpm --filter ... typecheck` / `pnpm --filter ... build` checks when feasible; if local untracked files block a full check, run a targeted equivalent and call out the limitation before pushing.
- After opening or updating a PR, watch CI with `gh run watch` or equivalent until checks finish, unless the user asks not to wait.
- Before adding or omitting a changeset, tell the user whether the issue appears release-noteworthy, recommend a bump level, justify the recommendation, and ask for confirmation. Err toward a minor bump for user-visible features, configuration changes, deployment/runtime changes, or meaningful behavior changes. Reserve major bumps for explicit breaking changes, and patch bumps for narrow fixes or documentation-only release notes.

## Current Product Boundaries

- Codex and Claude Code are supported AI Clients. Use generic Koed naming for package names, binaries, env vars, and token names unless describing provider-specific discovery, capture, execution, or source provenance.
- The TypeScript capture hook is the supported Capture Hook. The Python hook has been removed.
- The MCP Server is the recall/tool integration. The Capture Hook is the only supported automatic capture path in this build.
- `memory_answer` remains the supported recall tool name, but it must not imply backend answer synthesis.
- Low-level memory tools are diagnostic-only and should stay hidden unless explicitly enabled.
- The LCM Summary Service is local background work run with the MCP Server, enabled by default, and not an agent-facing tool.
