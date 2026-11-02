# Oxlint and Oxfmt evaluation tickets

Approved work package, based on [PLAN.md](PLAN.md). Evaluate only;
adoption is a separate decision. Keep production and test typechecking unchanged.

Tickets 01 and 02 can start independently. Ticket 03 follows both evaluations,
including a documented incompatibility outcome if either candidate cannot run.

## Shared measurement contract

Use an isolated evaluation branch and the same source revision, PR runner class,
CPU/RAM, Node, pnpm, and environment. Record exact versions, commands, and checked
file lists. Disable tool caches and control generated outputs. Run one untimed
warm-up, then five measured runs per command, alternating baseline and candidate.
Only successful, equivalent checks count as performance evidence.

Record seconds and peak MiB for the full process tree, including the typed Go
engine. Prefer isolated cgroup peaks; document sampling limitations otherwise.
Report medians and min/max ranges. Exclude installation from command timings;
include added build prerequisites. Retain raw evidence in the repository's
designated scratch area and record durable findings in the evaluation plan.

## 01: Quantify Oxfmt compatibility and performance

**What to build:** A reproducible Prettier/Oxfmt comparison showing formatting
compatibility, review cost, time saved, and RAM saved.

**Blocked by:** None (can start immediately).

**Status:** complete, Oxfmt compatible and recommended independently

- [x] Match existing formatting options, including 80-column width, file coverage,
      and ignores such as authored prompts; disable optional sorting.
- [x] Review a trial formatting diff and report changed files and added/deleted
      lines separately from tooling changes. Explain output differences.
- [x] Check each tool's correctly formatted snapshot of the same source revision
      using the shared measurement contract; record time and memory reductions.
- [x] Verify the normal local/editor formatting workflow and record any limitations.
- [x] Publish findings sufficient to accept or reject Oxfmt independently.

## 02: Quantify typed Oxlint compatibility and performance

**What to build:** A reproducible ESLint/typed-Oxlint comparison demonstrating
whether existing lint protection survives and quantifying time and RAM savings.

**Blocked by:** None (can start immediately).

**Status:** evaluated, incompatible with the current workspace configuration

- [x] Map every effective ESLint rule and option across JS, TS, TSX, production,
      tests, and configuration files. Preserve overrides, globals, ignores, and
      suppressions; report mapped/enabled counts and gaps.
- [x] Verify workspace resolution and typed file coverage. Resolve or document
      TypeScript 6, `baseUrl`, and project-discovery incompatibilities; record
      required changes and build prerequisites without widening migration scope.
- [x] Verify every explicitly enabled typed safety rule with failing examples,
      including production/test overrides and suppressions. Report passed/total
      examples and explain repository diagnostic differences.
- [x] Benchmark equivalent checks using the shared measurement contract, or
      document the exact compatibility blocker if equivalent execution is impossible.
- [x] Verify local/editor linting and publish findings sufficient to accept or
      reject typed Oxlint independently.

## 03: Validate CI impact and recommend an outcome

**What to build:** A completed results table and evidence-backed recommendation
to switch fully, adopt Oxfmt only, or defer.

**Blocked by:** 01 and 02.

**Status:** complete, recommend Oxfmt only

- [x] Record combined formatting/lint elapsed time and the larger command memory
      peak per measured pair; report medians, ranges, and percentage reductions.
- [x] Measure complete baseline and viable candidate static-check jobs, including
      installation, added prerequisites, and unchanged production/test typechecks.
      Record duration, peak RAM, and remaining bottlenecks.
- [x] Assess the proposed full-switch targets: at least 50% less combined
      formatting/lint time and 30% less peak RAM, retained checks, all safety
      examples passing, and zero unexplained differences or skipped files.
      Collect more evidence if overlapping ranges make the result inconclusive.
- [x] Record formatting churn, compatibility costs, workflow limitations, and any
      static-check regression. If only Oxfmt qualifies, report its individual gains.
- [x] Complete the plan's results and decision; put implementation follow-ups in
      the backlog. Leave adoption and production CI changes for separate work.

Results and measurement limits are recorded in [PLAN.md](PLAN.md). The corrected
[PR-runner evaluation](https://github.com/koed-labs/koed/actions/runs/41423567035)
passes. Typed Oxlint has a documented incompatibility outcome. No adoption or
production CI change is included.

## Official migrator follow-up

**Status:** complete, recommendation unchanged

- [x] Generate candidates with `@oxlint/migrate 1.90.0`, `--type-aware`,
      `--details`, and the additional `--with-nursery` comparison.
- [x] Compare rule settings, actual file lists, and repository diagnostics with
      the original evaluation source and clean ESLint baseline.
- [x] Exercise migrated production/test overrides through the safety fixtures.
      Correct the dropped test exclusion in an isolated candidate and reassess
      the remaining blockers before benchmarking.
- [x] Record findings in the plan and update implementation follow-ups.

The [completed migrator cross-check](https://github.com/koed-labs/koed/actions/runs/41431837454)
retains all 2,055 lint files. Generated test scopes pass 90/100 safety cases.
The corrected scopes pass 100/100, while repository lint retains the same
`baseUrl` and relative-path errors. No equivalent typed-Oxlint benchmark is added.
