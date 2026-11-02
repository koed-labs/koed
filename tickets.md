# Oxlint and Oxfmt evaluation tickets

The original work package covered evaluation only. The User later requested both
tools together. That combined migration is now complete and qualified, as recorded
at the end of this file and in [PLAN.md](PLAN.md). Production and test typechecks
remain in place. Earlier tickets retain the original evaluation outcomes.

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

**Status:** complete, Oxfmt compatible and now adopted with Oxlint

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

**Status:** original incompatibility evaluated, superseded by the qualified combined migration

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

**Status:** original evaluation complete, superseded by the qualified combined migration

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

## TypeScript 7-compatible configuration follow-up

**Status:** complete, configuration cleanup validated with TypeScript 6

- [x] Remove legacy configuration options and rebase aliases in an isolated
      snapshot while keeping the compiler and existing check commands.
- [x] Resolve the declaration-emission regression by preserving the old lookup
      root through explicit wildcard paths.
- [x] Pass production, test, Desktop Electron, browser, and ESLint checks.
      Compare import resolution and retain the same lint file coverage.
- [x] Compare native diagnostics before and after declaration builds. Probe
      promise-rule execution throughout the executable typed-file scope.
- [x] Record remaining native project-context and rule differences in the plan
      and implementation backlog before reconsidering benchmarks.

The [completed configuration experiment](https://github.com/koed-labs/koed/actions/runs/41438422137)
retains TypeScript 6.0.3, passes all retained checks, and removes all 31 native
configuration errors. It detects all 1,754 promise probes and changes none of
37,568 tested import-resolution targets. Native lint still reports 226 diagnostics
after declaration builds, so a full lint switch remains unqualified.

## Final native compatibility follow-up

**Status:** complete, project-context repair validated and rule differences explained

- [x] Compare a small MCP test project with native discovery and the existing
      flat lint program. Restore all diagnostic-only project changes afterward.
- [x] Test the four ESLint core implementations through Oxlint's JavaScript
      plugin API, including deliberate violations and suppression comments.
- [x] Reproduce both remaining typed-rule differences independently of workspace
      imports. Distinguish the native false positive from the existing ESLint gap.
- [x] Compare optional native compiler errors with a TypeScript 6 flat-project
      control, without dropping existing production/test checks.
- [x] Record the remaining adoption requirements and retain the Oxfmt-only
      recommendation until an equivalent lint candidate qualifies for measurement.

The [final compatibility pass](https://github.com/koed-labs/koed/actions/runs/41446353334)
finds that one MCP test project removes all 209 unsafe-type reports. The four-rule
JavaScript bridge removes all 15 core-rule differences and restores missing rule
implementations, with dependency and suppression-syntax costs. The two typed-rule
reports remain: a native `Promise.finally` false positive and an OAuth callback
that ESLint overlooks because its reply parameter is promise-like. Compiler
upgrades alone do not resolve these rule differences. No production adoption or
qualified Oxlint benchmark is included.

## Combined migration

**Status:** complete, both tools migrated and qualified together

- [x] Implement both formatter and linter changes with pinned versions.
- [x] Retain compiler checks, align native test discovery, and preserve missing
      core rules through the JavaScript compatibility plugin.
- [x] Resolve both remaining native lint reports and pass 110 focused checks.
- [x] Qualify the current implementation on the PR runner, including DB-backed
      OAuth/terminal tests and complete typed coverage.
- [x] Record incremental lint and complete-job measurements, including the
      compatibility plugin and declaration prerequisites.

The [combined qualification](https://github.com/koed-labs/koed/actions/runs/41452153956)
passes. It verifies all 1,754 typed probes, 110 focused compatibility cases, and
49 route tests with no skips. Five measured pairs show 80.6% less combined
formatting/lint time and 34.1% less sampled peak memory against Oxfmt plus ESLint.
The complete original static sequence takes 154.40 seconds versus 74.98 seconds
for the combined migration. Both sequences pass every retained check. The repeated
comparison clears the 50% time and 30% memory targets. The separate formatting
commit contains the previously reviewed 32-file change. The User confirmed no
release changeset.

## Native-only simplification

**Status:** in progress, User-approved rule-policy change

- [x] Remove the ESLint dependency and four-rule bridge.
- [x] Retire duplicate-argument, octal, and useless-assignment rules. Keep native
      optional-chain checking and the existing application tests.
- [x] Repair the 13 affected test expressions. Pass the 104 safety cases and the
      JavaScript source-policy test.
- [ ] Validate compiler checks, affected application tests, and complete typed
      coverage on the PR runner.

The earlier benchmark remains evidence for the previous bridge implementation.
This simplification intentionally retires three checks and requires no claim of
exact rule parity with the original ESLint setup.
