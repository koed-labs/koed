# Team SaaS Launch Validation

This is the runnable launch checklist for the first Team SaaS release. It uses
the deterministic Team SaaS fixture as the known data world, then separates
what is already automated from the gates that still need a human or staging
environment.

## Commands

Run from the repository root.

```bash
pnpm team-fixture:seed
pnpm team-launch:validate
```

`pnpm team-fixture:seed` resets only the synthetic fixture rows, seeds the
fixture, runs migrations, and validates the fixture's access expectations.

`pnpm team-launch:validate` validates the seeded fixture and prints the launch
validation report. The report is suitable for local or disposable staging
validation databases. Do not seed the deterministic fixture into production.
`API_TOKEN_PEPPER` is required because the Auth launch gate depends on seeded
deterministic API sessions. If the fixture was seeded without
`API_TOKEN_PEPPER`, run `pnpm team-fixture:seed` again after configuring it.

## Automated Gates

The validation command currently covers:

- Synthetic user sessions when `API_TOKEN_PEPPER` is configured.
- Team and Workspace data shape.
- Authorized Team-visible recall of shared personal memory.
- Revoked-share and private-memory exclusion.
- Removed Workspace member access loss with Team-retained knowledge.
- Personal soft-deletion with Team-retained recall.

## Manual Gates

These remain manual until the Electron app and cloud-only modules expose stable
test surfaces:

- Electron connects to the target backend and shows the correct account context.
- Electron guides MCP Server and Supported Capture Hook setup.
- A real captured session can be shared, recalled by another member, and
  inspected through the UI.

## Staging Gates

These need the staging cloud backend or a dedicated staging stub:

- Billing and seat-state transitions: paid, grace, plan-limited, and blocked.
- Audit log, health checks, error logs, and launch-path alerting.

Any failed launch blocker should be linked to a Linear ticket before release.

## Relationship To The Fixture

The fixture is the shared synthetic data set. This launch validation layer is
the release gate on top of it. If a critical-path behavior is missing from the
fixture, extend the fixture first, then add the launch gate here.
