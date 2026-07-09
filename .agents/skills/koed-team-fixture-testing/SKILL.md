---
name: koed-team-fixture-testing
description: Test Koed Team SaaS backend data, API authorization, lexical recall, graph, evidence, Agent workflow, staged remote/VPS dogfood readiness, or Electron behavior against the deterministic Team SaaS synthetic memory fixture. Use when validating Team Workspace authorization, shared memory visibility, revoked/private memory boundaries, retained Team knowledge, launch validation, or UI flows that should match the fixture truth sheet.
---

# Koed Team Fixture Testing

Use this skill to validate Koed Team SaaS behavior against the deterministic
synthetic fixture and launch validation harness.

This skill is a guardrail, not a ceiling. Use it to anchor testing in the
repo-owned truth sheet, but do not stop at the commands listed here when the
task clearly needs additional API, database, security, Electron, deployment,
or manual checks. If the skill is stale, incomplete, or narrower than the
current task, tell the User what is missing and continue with the best
repo-grounded validation plan.

## Required References

Before designing or running assertions, read:

- `docs/team-saas-synthetic-fixture.md`
- `docs/team-saas-launch-validation.md`

The synthetic fixture document is the fixture truth sheet. Treat it as the
source of truth for users, Workspaces, memories, expected visibility, and
expected denial cases. The launch validation document explains which checks
are automated, which require staged remote/VPS inputs, and which remain manual.

## Workflow

1. Inspect the current branch and confirm the fixture commands exist in
   `package.json`.
2. Confirm the target environment:
   - local bundled runtime,
   - local external/Docker dependencies,
   - disposable staging,
   - private VPS,
   - Team self-hosted,
   - Koed-managed cloud.
3. Run or request the appropriate fixture command:
   - `pnpm team-fixture:seed` to migrate, reset fixture rows, seed data, and
     validate the core fixture.
   - `pnpm team-fixture:validate` to validate an already-seeded fixture.
   - `pnpm team-launch:validate` to print the launch gate report.
   - `pnpm team-launch:validate --with-automated-tests` to run the focused
     API, DB, encryption, hosted ops, and validation tests behind the launch
     gates.
   - `pnpm team-launch:validate --with-staged-remote` to probe a running
     VPS/staging/cloud-like API using a browser session, scoped device
     credential, optional API Token rejection check, and optional local-edge
     proxy check.
   - `pnpm team-fixture:reset` to remove only fixture rows and return to square
     1.
4. Use the truth sheet to build API, repository, lexical recall, graph,
   expansion, evidence, Agent, or Electron checks.
5. Assert positive and negative outcomes. Do not only test happy paths.
6. If the task asks "are we ready to use this as a team?", include a minimal
   dogfood proof:
   - one member has Team Workspace access,
   - another member's Captured Session or Memory Event is shared into that
     Workspace,
   - browser session or scoped device credential can recall that shared memory,
   - API Token cannot access Team Workspace recall,
   - private, revoked, removed-member, and retained-knowledge cases match the
     truth sheet,
   - graph/source/evidence expansion follows the same Team boundary.
7. If a result disagrees with the truth sheet, classify it as one of:
   - fixture bug,
   - product bug,
   - stale test expectation,
   - missing implementation dependency.
8. Do not silently change fixture assumptions. Report mismatches with the exact
   actor, Workspace, memory title, command, endpoint, and observed behavior.
9. If the mismatch blocks launch validation, create or link a Linear issue
   before release.
10. If this skill omits a relevant route, capability, credential type, or
    deployment mode, report that limitation to the User and use the repo docs,
    tests, and code to extend the validation beyond the skill.

## Expected Fixture Shape

The fixture contains:

- Four users: Alice, Bob, Carol, and David.
- Three Workspaces: Electron Team App, Cloud Memory Platform, and Managed
  Knowledge Ingestion.
- Active shared memories.
- Private memories that must not leak to Team recall.
- Revoked shares that must not appear to Team readers.
- A removed Workspace member who must lose access while their prior
  Team-visible contribution remains visible to authorized members.
- Team-retained knowledge after personal deletion.

## Validation Priorities

Prefer this order:

1. Data-level fixture integrity: rows exist, reset is fixture-scoped, reseed is
   deterministic.
2. Authorization: disabled or unauthorized users cannot access Workspace memory.
3. Team lexical recall/search: authorized users see only shared, active,
   retained Workspace memory.
4. Graph and expansion: sources, evidence, and supporting context respect the
   same Workspace boundary.
5. Agent workflow checks: Agents reason from the same fixture truth sheet and
   report discrepancies consistently.
6. Staged remote checks: a running private VPS/staging/cloud-like API accepts
   browser session and scoped device credential Team routes, rejects API Token
   Team access, and does not echo credential sentinels.
7. Electron/UI checks: UI state must match the same fixture expectations rather
   than using separate demo data.

## Environment Notes

- The fixture scripts read `DATABASE_URL` from the environment/root `.env`.
  A bundled-local desktop/runtime install may use generated ports under
  `KOED_HOME` instead of the root `.env` values. If a fixture command cannot
  reach Postgres, inspect `koed-server doctor --json`,
  `KOED_HOME/config/local-ports.json`, and the active process list before
  concluding the product behavior is broken.
- `API_TOKEN_PEPPER` must be configured before seeding when API-session-backed
  fixture users or staged remote browser-session checks are required.
- The fixture seeds production-shaped rows but does not precompute embeddings.
  Do not expect semantic vector search hits until the normal embedding service
  or backfill path has embedded the relevant records. Use deterministic
  fixture validation, lexical/data-level checks, graph, evidence, and
  `/v1/memory/answer` where appropriate.
- For `--with-staged-remote`, provide the target API base URL, browser session
  cookie, scoped device credential, optional API Token, Team Workspace ID, and
  optional local-edge backend ID. Do not paste real production credentials into
  committed files or issue comments.

## Guardrails

- Never run destructive full-database resets for fixture work.
- Use the fixture reset command when cleanup is needed.
- Do not add real captured memory, API tokens, session cookies, production
  exports, or secrets to the fixture.
- Do not seed the deterministic fixture into production or shared staging with
  real long-lived secrets. Use disposable validation databases or intentionally
  isolated staging fixtures.
- Do not expect semantic search hits until embeddings have been generated by
  the normal embedding service or backfill path.
- Do not infer expected behavior from intuition when the truth sheet says
  otherwise.
- Keep follow-up test cases deterministic so other Agents can reproduce them.
- Do not treat this skill as the full release checklist. It points at the
  fixture and launch validation harness; the User's task, current repo docs,
  Linear issues, and implementation code may require broader testing.
