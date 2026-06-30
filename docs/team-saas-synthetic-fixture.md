# Team SaaS Synthetic Memory Fixture

This fixture is the shared synthetic data set for Team SaaS backend, API, Agent,
and later Electron validation.

It creates a deterministic near-real Koed Team with four users, three
Workspaces, private memories, shared memories, revoked shares, a removed
Workspace member, and Team-retained knowledge after personal deletion.

The goal is to let humans and Agents test against the same known world instead
of inventing one-off examples for each PR.

## Commands

Run from the repository root.

```bash
pnpm team-fixture:seed
```

Runs DB migrations, resets only this fixture's rows, seeds the fixture, and
validates the core access expectations.

```bash
pnpm team-fixture:validate
```

Validates the already-seeded fixture against the expected access outcomes.

```bash
pnpm team-fixture:reset
```

Removes only rows belonging to `team-saas-fixture-v1`, returning the fixture
state to square 1. It does not truncate the full database.

All commands require `DATABASE_URL`.

## Team

| Person | Fixture email           | Role   | Main memory domain                                 |
| ------ | ----------------------- | ------ | -------------------------------------------------- |
| Alice  | `alice.fixture@koed.ai` | Owner  | Dataflows, DB architecture, product and governance |
| Bob    | `bob.fixture@koed.ai`   | Member | Frontend, Electron UX, setup flows, DevOps         |
| Carol  | `carol.fixture@koed.ai` | Admin  | Architecture, backend, APIs, service contracts     |
| David  | `david.fixture@koed.ai` | Member | Agentic workflows, AI behavior, MCP/tooling        |

## Workspaces

| Workspace                   | Project path                                | Access model                                                                               |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Electron Team App           | `/fixture/koed/electron-team-app`           | Alice, Bob, and David can write. Carol can read.                                           |
| Cloud Memory Platform       | `/fixture/koed/cloud-memory-platform`       | Alice, Carol, and David can write. Bob has been removed and has disabled Workspace access. |
| Managed Knowledge Ingestion | `/fixture/koed/managed-knowledge-ingestion` | Alice, Carol, and David can write. Bob can read.                                           |

## Memory Truth Sheet

| Memory                          | Owner | Workspace                   | State                           | Expected Team behavior                                                                                      |
| ------------------------------- | ----- | --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Workspace Memory Timeline UX    | Bob   | Electron Team App           | Active share                    | Visible to authorized Electron Workspace members.                                                           |
| Agent Collaboration Rooms       | David | Electron Team App           | Active share                    | Visible to authorized Electron Workspace members.                                                           |
| Revoked Electron Experiment     | David | Electron Team App           | Revoked share                   | Hidden from Team recall; remains David's personal memory.                                                   |
| Private DevOps Scratchpad       | Bob   | Electron Team App           | Private                         | Hidden from Team recall.                                                                                    |
| Flat User-Owned Memory Model    | Alice | Cloud Memory Platform       | Active share                    | Visible to authorized Cloud Workspace members.                                                              |
| Cloud API Superset Contract     | Carol | Cloud Memory Platform       | Active share                    | Visible to authorized Cloud Workspace members.                                                              |
| Retained Billing Grace Decision | Carol | Cloud Memory Platform       | Personal deleted, Team retained | Visible to authorized Cloud Workspace members even though Carol's personal source is soft-deleted.          |
| Removed Member Deployment Note  | Bob   | Cloud Memory Platform       | Active share                    | Visible to authorized Cloud Workspace members, but not to Bob after his Cloud Workspace access is disabled. |
| Private Pricing Scratchpad      | Alice | Cloud Memory Platform       | Private                         | Hidden from Team recall.                                                                                    |
| Provider Fallback Ingestion     | David | Managed Knowledge Ingestion | Active share                    | Visible to authorized Ingestion Workspace members.                                                          |
| Checksum Dedupe Inventory       | Carol | Managed Knowledge Ingestion | Active share                    | Visible to authorized Ingestion Workspace members.                                                          |
| Memory Inbox Product Boundary   | Alice | Managed Knowledge Ingestion | Active share                    | Visible to authorized Ingestion Workspace members.                                                          |
| Private Agent Prompt Scratchpad | David | Managed Knowledge Ingestion | Private                         | Hidden from Team recall.                                                                                    |

## Expected Checks

Use these as the first API/data-level assertions before adding UI checks.

| Actor | Workspace                   | Should see                                                                                                                 | Must not see                                                           |
| ----- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Carol | Electron Team App           | Workspace Memory Timeline UX; Agent Collaboration Rooms                                                                    | Revoked Electron Experiment; Private DevOps Scratchpad                 |
| Alice | Cloud Memory Platform       | Flat User-Owned Memory Model; Cloud API Superset Contract; Retained Billing Grace Decision; Removed Member Deployment Note | Private Pricing Scratchpad                                             |
| Bob   | Cloud Memory Platform       | Nothing                                                                                                                    | All Cloud Workspace memories, because his Workspace access is disabled |
| Bob   | Managed Knowledge Ingestion | Provider Fallback Ingestion; Checksum Dedupe Inventory; Memory Inbox Product Boundary                                      | Private Agent Prompt Scratchpad                                        |

## Agent Testing Playbook

1. Run `pnpm team-fixture:seed`.
2. Read this document before writing tests or prompts.
3. Verify data/API behavior first: authorization, recall, graph, expansion, and
   evidence must match the truth sheet.
4. Treat any mismatch as either a fixture bug or product bug. Do not silently
   alter the fixture assumptions.
5. When the Electron app is ready, reuse this same fixture for UI-level checks.
6. If a failure blocks launch validation, create or link a Linear ticket before
   release.

## Design Notes

- The reset mechanism is fixture-scoped. It deletes deterministic fixture rows
  by IDs, emails, and source hashes instead of truncating the whole database.
- The data intentionally includes edge cases, not only happy paths.
- Bob's Cloud Workspace removal tests that user-owned contributions can remain
  useful to the Team while the removed member loses access.
- Carol's retained billing memory tests that personal deletion does not destroy
  Team-retained knowledge for authorized Workspace members.
- Revoked and private memories exist to prove Team recall does not overreach.
