# Evaluate Oxlint and Oxfmt

Decide whether replacing ESLint and Prettier reduces CI time and peak RAM while
preserving our existing checks. This evaluation does not commit us to migration.

## Scope

Compare the current tools with Oxfmt and **type-aware** Oxlint. Keep production
and test typechecking unchanged. Evaluate formatting and linting separately so
we can adopt either tool independently.

Use an isolated evaluation branch. Put temporary configs, fixtures, scripts, and
raw measurements under `scratch/oxc-evaluation/`. Record the final results and
decision in this file. Track subsequent implementation work in `TODO.md`.

## 1. Establish equivalent coverage

- Export ESLint's effective rules for representative JS, TS, TSX, production,
  test, and configuration files. Map every enabled rule and its options to
  Oxlint; record gaps and behavior differences.
- Preserve file overrides, globals, ignore patterns, and suppression comments.
  Compare the actual file lists; no speedup may come from checking fewer files.
- Verify workspace import resolution and typed coverage of all intended TS/TSX
  files. Investigate TypeScript 6, `baseUrl`, and project discovery. Record
  required config/compiler changes and added build prerequisites.
- Use small failing examples to verify every explicitly enabled typed safety
  rule, including promise handling and unsafe assignments/access. Test the
  production/test overrides and suppressions. Explain repo diagnostic differences.
- Preserve Prettier options, explicitly including `printWidth: 80`, and ignores
  such as authored prompts. Disable optional sorting. Review a trial formatting
  diff and report changed files and added/deleted lines separately from setup.

## 2. Measure on the CI runner

Use the current PR runner class with identical CPU/RAM, Node, pnpm, source files,
and environment. Record the commit, exact tool versions, runner, and commands.

- Measure Prettier check versus Oxfmt check, and ESLint versus typed Oxlint,
  excluding dependency installation but including added build prerequisites.
  Each formatter checks its own correctly formatted snapshot of the same source
  revision. All measured commands must pass.
- Run one untimed warm-up per command, then **five measured runs per command**,
  alternating baseline and candidate. Disable tool caches; keep generated
  outputs consistent. These are fresh-process runs, not cold-filesystem tests.
- Record wall time and peak memory per run. Prefer an isolated Linux cgroup peak
  for each command; otherwise sample aggregate process-tree RSS and document
  the interval and limitations. Include Node, Oxlint, and the Go typed engine;
  do not add independent per-process peaks or treat the heap cap as usage.
- Report medians and min/max ranges. For the sequential formatting/lint pair,
  report combined elapsed time and the larger command peak. Calculate reduction
  as `100 * (baseline - candidate) / baseline`.
- Record complete static-check job duration and peak memory for both setups,
  including installation and unchanged typechecks. Identify remaining bottlenecks.

## 3. Record the decision

The recommendation is Oxfmt only, subject to separate adoption approval.
The viable candidate below uses Oxfmt with unchanged ESLint. Typed Oxlint has no
valid equivalent repository benchmark because its workspace configuration fails.

| Metric                                             | Prettier + ESLint         | Oxfmt + unchanged ESLint  | Reduction                       |
| -------------------------------------------------- | ------------------------- | ------------------------- | ------------------------------- |
| Formatting: median seconds [min–max]               | 37.570 [33.740–39.832]    | 0.402 [0.383–0.445]       | 98.9%                           |
| Formatting: median peak MiB [min–max]              | 676.0 [635.6–1,103.6]     | 463.7 [430.6–466.2]       | 31.4%                           |
| Typed ESLint: median seconds [min–max]             | 70.149 [62.670–75.579]    | 67.134 [61.628–70.572]    | 4.3%, overlapping ranges        |
| Combined formatting/lint: median seconds [min–max] | 104.710 [100.320–113.149] | 67.576 [62.030–71.017]    | 35.5%                           |
| Formatting/lint: median peak MiB [min–max]         | 6,248.8 [6,073.1–6,262.9] | 6,171.5 [6,024.9–6,268.4] | 1.2%, overlapping ranges        |
| Complete static checks: seconds / peak MiB         | 170.485 / 6,300.4         | 129.589 / 6,406.6         | 24.0% less time / 1.7% more RAM |

The candidate maps 94 of 96 enabled rule names and passes 100 of 100 targeted
safety cases. Typed repository execution still fails. The trial formatting change
touches 32 files with 140 added and 193 deleted lines. The evidence below records
the configuration blockers, remaining diagnostic differences, and prerequisites.

**Proposed full-switch gates:**

- All existing checks retained or equivalent demonstrated; all safety examples
  pass; zero unexplained diagnostic differences or skipped files.
- At least **50% less combined formatting/lint time** and **30% less peak RAM**
  for those steps. If run ranges overlap materially, collect more evidence
  before calling a threshold met.
- Complete static checks pass, with no material regression from added prerequisites.
- Required compatibility changes and formatting churn are documented and
  acceptable; normal local/editor workflows work.

Oxfmt-only adoption retains ESLint and both typechecks. A full switch does not
qualify. The individual Oxfmt results support a separate formatting adoption review.

No runtime or service architecture changes are planned, so architecture docs
do not need updating for this evaluation.

## Evaluation evidence, 2026-11-02

The evaluation uses source commit `f22c4f3bc7b0aaf3c74a2776c00f591c6ea677bf`
on branch `eval/oxc-tooling`. Adoption remains a separate decision. Production
scripts, production CI, and both TypeScript checks remain unchanged.

The [evaluation run](https://github.com/koed-labs/koed/actions/runs/41423567035)
uses `blacksmith-4vcpu-ubuntu-2404`, Node `24.13.1`, and pnpm `11.1.2`.
The host provides four AMD EPYC vCPUs and reports 16,168,148 KiB of RAM.
It runs Linux `6.6.141` x86_64 with glibc `2.39`. The evaluation head is
`db142304e7c100622b49ed1186b3bd33d8d23227`.
The evaluation workflow pins Prettier `3.8.3`, ESLint `10.4.0`,
typescript-eslint `8.59.3`, TypeScript `6.0.3`, Oxfmt `0.75.0`, Oxlint `1.90.0`,
and oxlint-tsgolint `7.0.2005`. The baseline versions come from the source lockfile.

The workflow retains an `oxc-evaluation` artifact for 14 days. Local raw evidence
and exploratory programs remain under `scratch/oxc-evaluation/`. The workflow
contains the measurement program, so its commit preserves the reproduction steps.
The artifact contains the source, formatting, and lint manifests, effective
ESLint configurations, rule mappings, command logs, raw measurements, and the
formatting diff. It also contains the environment and candidate installation lockfile.

Performance runs use fresh processes and a warm filesystem. Each snapshot receives
its own complete workspace dependency installation before warm-up. Each command receives
one untimed warm-up and five measured runs. Baseline and candidate alternate,
with the first command reversing between pairs. ESLint uses `--no-cache`.
Neither formatter enables a cache. Installation stays outside individual check
timings. Complete job measurements include installation. All subprocesses use
`NODE_OPTIONS=--max-old-space-size=8192` equally for both controls. This is a heap
limit, not a memory measurement.

Memory measurements sample simultaneous RSS across each command's process session.
The interval contains a 10 ms sleep plus collection time. RSS measures resident memory.
The sampler includes descendant Node and Go processes. It does not add independent
process peaks. Sampling can miss
short peaks and count shared pages more than once. These measurements do not
claim isolated cgroup accuracy. The measurement wrapper contributes elapsed-time
overhead but remains outside the sampled process session. Per-command mean
intervals range from about 10.3 to 15.1 ms after collection cost.

The [initial run](https://github.com/koed-labs/koed/actions/runs/41420011217)
shared root dependencies without installing snapshot package-local dependencies.
Its repeated lint commands failed. Their timings and derived pairs are excluded.
The corrected harness installs dependencies in each snapshot and stops if a
warm-up or measured formatting/lint command fails. The initial formatter and
freshly installed complete-job commands passed, but the final comparison uses
the corrected run throughout.

### Formatting compatibility

Both tools format the same 2,383 tracked source files. The manifest contains
1,608 TS, 147 TSX, 281 MJS, 17 MTS, one CTS, one JS, 174 Markdown, 116 JSON,
21 CSS, 13 YAML, three HTML files, and `.prettierrc`. Prettier changes no source
files before the comparison. Each tool checks its own formatted snapshot.

The candidate uses `printWidth: 80`, `semi: true`, `singleQuote: false`, and
`trailingComma: "none"`. It disables `sortImports`, `sortPackageJson`, and
`sortTailwindcss`. It retains `.prettierignore`, including authored prompts,
generated outputs, environment files, and pnpm files. Explicit prompt and
generated-file probes remain unchanged.

The trial changes 32 files, with 140 added lines and 193 deleted lines.
These counts exclude evaluation configuration and other tooling changes.
The reviewed diff contains arrow-function wrapping, parentheses, omitted spaces
before closing `for` parentheses, CSS font-list wrapping, and Markdown indentation
inside multiline inline code. The Markdown differences change displayed spacing
in command examples. The commands retain their meaning.

All 27 changed JS/TS files retain the same TypeScript syntax tree after removing
positions, trivia, and redundant parentheses. The remaining differences affect
three CSS files and two Markdown files. The complete formatting diff remains in
the raw evidence. No production source receives this trial formatting.

A normal `oxfmt --check .` additionally selects
`packages/evals/src/experience-replay/harbor/pyproject.toml`. Prettier skips TOML.
The benchmark passes the shared manifest explicitly, so this difference does not
affect measured coverage. A normal-workflow candidate adds that exact file to
`ignorePatterns`. Its directory check passes on 2,383 source files plus the
candidate formatter configuration.

The Oxfmt language server returns the expected formatting edit and shuts down
successfully on the PR runner with Node `24.13.1`. The normal CLI directory check
also passes locally on macOS arm64 with Node `26.7.0`. These probes establish
protocol and CLI behavior, but do
not establish installation or format-on-save behavior in a particular editor.
The [editor guide](https://oxc.rs/docs/guide/usage/formatter/editors) describes
the Oxc extension. Adoption requires selecting it as the formatter and using the
same pinned binary and configuration as CI.

### Typed lint compatibility

The effective ESLint inventory contains 2,055 tracked files, eight configurations,
and 96 distinct enabled rules. The actual baseline lint result contains the
same 2,055 files and reports zero errors and zero warnings. The inventory includes
18 MTS/CTS files, which do not receive the explicit typed safety rules.
The explicit TS/TSX safety-rule scope contains 1,755 files.

| Effective scope example                             | Files | Enabled rules | Rules mapped by name |
| --------------------------------------------------- | ----: | ------------: | -------------------: |
| `.github/scripts/ci-policy.mjs`                     |    68 |            82 |                   80 |
| `apps/api/scripts/smoke-webtransport.ts`            |    11 |            70 |                   69 |
| `apps/api/src/analytics/index.ts`                   |   808 |            77 |                   76 |
| `apps/api/src/auth/remote-mcp-oauth-routes.test.ts` |   304 |            70 |                   69 |
| `apps/api/src/browser-approval/AuthPanel.tsx`       |   257 |            70 |                   69 |
| `apps/api/src/server.test.ts`                       |   375 |            74 |                   73 |
| `apps/desktop/scripts/after-pack.mjs`               |   214 |            82 |                   80 |
| `apps/desktop/src/preload.cts`                      |    18 |            68 |                   67 |

The mapping transports all effective options for 94 of 96 distinct enabled rules.
Every transported option key exists in the candidate schema. Name and schema
coverage do not establish equivalent behavior. The complete rule-and-option
mapping remains in `rule-map.json` in the evaluation artifact. Disabled rules,
parser options, and globals remain in `eslint-effective.json`.

Core rules use `eslint/` names. Typescript-eslint rules use `typescript/` names,
except `no-array-constructor`, `no-unused-expressions`, and `no-unused-vars`.
Those three use the corresponding TypeScript-capable core rules. Explicit
file-list overrides preserve the eight scopes. The candidate disables default
rule categories, retains the original ignores, uses ES2022 globals, and copies
the effective Node and Vitest globals into their original scopes.

Oxlint does not honor the observed `/* global ... */` declarations as ESLint does.
The first trial produces 195 `no-undef` diagnostics. Per-file configuration
entries for the 26 affected files remove those diagnostics. This translation
adds maintenance cost. Existing suppression comments and their TypeScript rule
names work in the safety probes. ESLint also warns about unused suppression
comments by default. Equivalent Oxlint invocation requires
`--report-unused-disable-directives-severity warn`.

`no-dupe-args` and `no-octal` lack direct candidate rule mappings. Both parsers
reject the failing MJS examples. The CJS examples expose a gap: this ESLint
configuration forces module parsing, while Oxlint accepts the examples as
CommonJS. No tracked CJS file exists in the measured source. That fact does not
establish preserved future file coverage.

The ten explicit typed rules are `await-thenable`, `no-floating-promises`,
`no-misused-promises`, `no-unsafe-argument`, `no-unsafe-assignment`,
`no-unsafe-member-access`, `no-unsafe-return`, `no-base-to-string`,
`prefer-promise-reject-errors`, and `require-await`.

Each fixture declares exports so TypeScript treats it as a separate module.
The unsafe-value examples declare `value: any`. Each case repeats with
`/* eslint-disable @typescript-eslint/<rule> */` at the top of the file.

| Rule                           | Failing expression or declaration                        |
| ------------------------------ | -------------------------------------------------------- |
| `await-thenable`               | `async function f() { await 1; }`                        |
| `no-floating-promises`         | `Promise.resolve(1);`                                    |
| `no-misused-promises`          | `[1].forEach(async () => { await Promise.resolve(); });` |
| `no-unsafe-argument`           | `takesString(value)`                                     |
| `no-unsafe-assignment`         | `const result: string = value;`                          |
| `no-unsafe-member-access`      | `value.foo`                                              |
| `no-unsafe-return`             | `function f(): string { return value; }`                 |
| `no-base-to-string`            | `String({})`                                             |
| `prefer-promise-reject-errors` | `Promise.reject("bad").catch(() => {});`                 |
| `require-await`                | `async function f() { return 1; }`                       |

Production enables all ten rules. Selected tests enable the three promise rules
and four unsafe-value rules. Other tests, TSX, and configuration files enable
the three promise rules. The scopes preserve the repository's current overrides.

All 100 isolated safety cases pass for ESLint and typed Oxlint. They cover each
rule in production, selected tests, other tests, TSX, and configuration scopes.
The total contains 26 expected detections, 26 effective suppressions, and 48
expected exclusions. The fixture copies each scope's actual rule settings and
uses a standalone TypeScript project. It does not establish workspace resolution.
The local typed Oxlint language server also reports the expected floating-promise
diagnostic. The corrected PR-runner evaluation repeats all 100 safety cases and
both language-server probes successfully with Node `24.13.1`. Local probes also
pass on macOS arm64 with Node `26.7.0`.

The repository execution fails with `typescript(tsconfig-error)`:

```text
Option 'baseUrl' has been removed. Please remove it from your configuration.
```

The fresh-dependency run records 13 removed-`baseUrl` errors and 18 non-relative
path errors. It also reports 13,106 unsafe-type diagnostics while configuration
and resolution fail. Those diagnostic totals do not establish independent rule
regressions. Passing `--tsconfig tsconfig.eslint.json` does not prevent conventional workspace
project discovery. The command still reports errors against the package projects.
Those projects exclude many tests that ESLint includes through its separate
lint project. The candidate reports unresolved `error`-typed values through the
unsafe rules. File traversal alone does not establish typed program coverage.

An exploratory snapshot removes `baseUrl` and prefixes root path mappings with
`./`. Six Desktop mappings then fail because they also need rebasing relative
to `apps/desktop/tsconfig.json`. Rebasing them removes the configuration errors,
but does not establish equivalent type resolution. That exploratory snapshot also
lacks complete package-local dependencies, so its unsafe-type diagnostic totals
are not valid compatibility evidence. Desktop aliases reference built `.d.ts`
files. The [typed-lint guide](https://oxc.rs/docs/guide/usage/linter/type-aware)
also requires dependency declarations for workspace resolution. A candidate needs
an explicit lint-project strategy and measured declaration-build prerequisites.
These changes remain outside this evaluation's production configuration.

The candidate also reports 13 `no-unsafe-optional-chaining` differences around
TypeScript assertions and two `no-useless-assignment` differences in the redirect
counter and reassigned receiver configuration. Their rule-level control-flow
equivalence remains unresolved. The full switch fails the requirement for zero
unexplained differences. The working standalone rules do not justify timing a
failed repository lint run as an equivalent check.

### CI impact and decision

Typed Oxlint does not qualify for adoption against this source configuration.
No equivalent typed-Oxlint performance result exists. Its failed command time
and memory appear only as compatibility evidence, outside the results table.
Production and test typechecking retain `pnpm typecheck` and
`pnpm typecheck:test`. No server, service, retrieval, or storage behavior changes,
so architecture documentation does not require an update.

The corrected run contains 22 successful measured commands: five formatting and
five lint commands for each control, plus two complete static-check sequences.
All four warm-ups pass. The formatter manifests contain the same 2,383 files.
ESLint results and Oxlint traversal contain the same 2,055 files. Equal traversal
does not establish equivalent typed coverage for the failing Oxlint execution.

The combined table uses each measured formatter/lint pair's elapsed-time sum and
larger command memory peak. It does not add the two command peaks. The formatting
time and memory ranges do not overlap. Combined elapsed-time ranges also remain
separate. ESLint time and memory ranges overlap, so the small lint and overall
memory differences do not establish improvements. No extra runs are needed to
reject the full switch because compatibility already fails.

Each complete static-check sequence starts at dependency installation and ends
after test typechecking. Checkout, Node/pnpm setup, and evidence upload stay
outside both timing windows. Both snapshots start without root or package-local
`node_modules`. The package store and filesystem are warm. The candidate also
includes an isolated `npm install` of pinned Oxfmt, which takes about two seconds.
Oxfmt adds no declaration build prerequisite. Both sequences retain environment
example checks, ADR checks, ESLint, `pnpm typecheck`, and `pnpm typecheck:test`.
Every command exits successfully. These are one complete sequence per control,
so their differences are observations rather than repeated-job medians.

The candidate sequence finishes about 40.9 seconds sooner. Its sampled peak is
about 106.2 MiB higher. One job pair does not establish a repeatable RAM regression.
The result provides no evidence of an overall RAM saving. Unchanged typed lint
and typechecking remain the time and memory bottlenecks after formatting falls
below half a second.

The full switch fails retained-check and diagnostic-equivalence requirements.
All 100 targeted safety cases pass, but repository execution remains incompatible.
There is no valid full-switch time or RAM result to assess against the 50% and
30% targets. The Oxfmt-only control reduces combined time by 35.5% and shows no
material overall RAM reduction. Its independent formatting gains support
Oxfmt-only adoption. The 32-file formatting change and editor selection belong
in that separate adoption review. The implementation backlog records those steps
and the prerequisites for reconsidering typed Oxlint.

Changed-file formatting and workflow syntax checks pass locally. A full local
Prettier scan reports only the pre-existing, untracked `CONFIG.md`. The corrected
runner uses the pinned tracked source and completes all static checks. The User
approved omitting a changeset because this evaluation changes no shipped behavior.
