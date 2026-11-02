# Oxlint and Oxfmt migration

Both tools are migrated together. The current simplification removes the ESLint
bridge under a User-approved policy that retires three rules and keeps native
optional-chain checking. The latest section records that change and validation.
The earlier [combined qualification](https://github.com/koed-labs/koed/actions/runs/41452153956)
measured the bridge implementation. Its performance results remain historical,
rather than measurements of the simplified rule set. Earlier sections retain the
original evaluation plan and decisions.

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

## 3. Original evaluation decision

The original evaluation recommended Oxfmt only, subject to separate adoption
approval. At that stage, the viable candidate used Oxfmt with unchanged ESLint.
Typed Oxlint lacked a valid repository benchmark because its configuration failed.
The qualified combined migration at the end of this file supersedes this decision.

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
The official-migrator follow-up below confirms the same repository blockers after
correcting the generated test scopes. That stage retained the Oxfmt-only recommendation.
The later configuration-only experiment removes all 31 configuration errors while
retaining TypeScript 6.0.3 and passing the existing checks. Typed Oxlint still has
226 diagnostics after declaration builds. The remaining work concerns project
context and rule behavior, rather than the removed configuration options.

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

`no-dupe-args` and `no-octal` lack direct native rule mappings. The original
parser-only probes reject failing MJS examples and accept failing CJS examples
under Oxlint. A later check with the complete ESLint configuration corrects the
parser comparison: it uses typescript-eslint for JavaScript too. ESLint rejects
duplicate CJS parameters through rules and octal literals through parsing.
Therefore strict-mode assumptions alone do not establish equivalent protection.
No tracked CJS file exists in the measured source. The final compatibility pass
below tests both missing rules through ESLint implementations loaded by Oxlint.

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

## Official migrator cross-check, 2026-11-02

The [completed compatibility run](https://github.com/koed-labs/koed/actions/runs/41431837454)
uses `@oxlint/migrate 1.90.0`, matching Oxlint `1.90.0`, and
oxlint-tsgolint `7.0.2005`. It checks the original source commit
`f22c4f3bc7b0aaf3c74a2776c00f591c6ea677bf` on the same PR runner class,
Node `24.13.1`, and pnpm `11.1.2`. The evaluation head is
`5ffc903eedc5df8ca0056d2e51d95c0520418a24`.

The [official migrator](https://github.com/oxc-project/oxlint-migrate) runs first
with `--type-aware --details`, then with `--with-nursery` added. The comparison
also tests a copy of the second output with the production/test boundary restored.
Each configuration resides at the isolated snapshot root so its relative globs
apply correctly. Root and package-local dependencies receive complete installations.

The ESLint baseline checks 2,055 files with zero errors and zero warnings.
Every candidate traverses exactly those files, with zero missing or additional
files. The integrity check confirms that migration leaves the original source
entries unchanged. The `oxlint-migrate-evaluation` artifact contains generated
configurations, full diagnostics, command arguments, rule comparisons, and fixtures.
The workflow retains it for 14 days. Local evidence remains in the designated
scratch directory. No equivalent typed-lint benchmark becomes available.

| Candidate                                   | Mapped enabled rule names | Safety cases matching ESLint | Repository typed lint |
| ------------------------------------------- | ------------------------: | ---------------------------: | --------------------- |
| Default migration flags                     |                   92 / 96 |                     90 / 100 | Fails configuration   |
| With `--with-nursery`                       |                   94 / 96 |                     90 / 100 | Fails configuration   |
| With nursery rules and restored test scopes |                   94 / 96 |                    100 / 100 | Fails configuration   |

The default command skips `no-undef` and `no-useless-assignment` because the
migrator classifies them as nursery rules. Adding `--with-nursery` retains them.
Both commands skip `no-dupe-args` and `no-octal`, with the explanation that strict
mode supersedes them. That classification does not establish equivalent
protection for the CJS examples. The supported name mappings agree with the earlier
manual candidate. This repository's enabled rule declarations contain no custom
option arrays.

The migrator warns that `ignore list inside overrides is not supported`.
It drops the production override's test exclusion. Seven safety-rule settings
then differ across 393 test files. Four unsafe-value rules become enabled in
152 files that exclude them under ESLint. Three other rules become enabled in
all 393 affected test files. These produce 1,787 file/rule severity differences.
The runtime fixtures reproduce the boundary error: ten cases fail because rules
run in test scopes where ESLint disables them.

The corrected configuration inserts a test override immediately after the
production override. It disables that override's seven rules for these patterns:

```json
[
  "apps/api/src/**/*.{test,spec}.ts",
  "apps/worker/src/**/*.{test,spec}.ts",
  "packages/*/src/**/*.{test,spec}.ts"
]
```

The existing selected-test override then re-enables its four unsafe-value rules.
This preserves glob-based coverage for future files and restores all 100 targeted
safety cases. The rule comparison expands generated globs across the baseline
manifest, and runtime fixtures exercise repository-shaped paths. After this repair,
the only remaining rule/severity differences are the two unsupported core rules.

All three repository executions exit with status 1. Each reports the same 13
removed-`baseUrl` errors and 18 non-relative-path errors. The corrected candidate
also reports the same 13,106 unsafe-type diagnostics, 13 optional-chain differences,
and two assignment differences as the earlier manual candidate. Excluding 195
known inline-global diagnostics, the candidates have identical diagnostic counts
by rule, file, and message: 13,152 matching records. This comparison excludes
positions because the earlier candidate uses the Oxfmt-formatted snapshot.

The tested invocation leaves source comments unchanged. Its 195 inline-global
diagnostics still need the earlier per-file globals treatment or another verified
conversion. The optional `--replace-eslint-comments` path is not exercised here.
The TypeScript configuration failures remain after the test-scope repair, so the
migrator does not remove the runtime blocker. The earlier recommendation stands:
use Oxfmt independently and retain ESLint while typed-workspace compatibility is
unresolved. The performance table above remains unchanged.

Three earlier helper attempts stopped during dependency resolution, directory-link
hashing, or the ESLint baseline's default heap limit. They supply no compatibility
result. The completed run uses the repository's existing 8 GiB heap setting and
passes the baseline, source-integrity, and result-consistency checks. This follow-up
changes evaluation evidence only. Architecture documentation needs no update.

## TypeScript 7-compatible configuration with TypeScript 6, 2026-11-02

The [completed configuration experiment](https://github.com/koed-labs/koed/actions/runs/41438422137)
keeps TypeScript `6.0.3`, all production/test checks, Node `24.13.1`, and pnpm
`11.1.2`. It uses the same PR runner class and pinned Oxc versions. The source
revision remains `f22c4f3bc7b0aaf3c74a2776c00f591c6ea677bf`. The evaluation head
is `3506c4c3073f827cca3f107baea0d863e05122bd`.

Only the isolated snapshot receives configuration edits. The experiment removes
`baseUrl` and its `ignoreDeprecations: "6.0"` entry. It makes root path targets
explicitly relative and rebases both Desktop configurations. The changed files
are `tsconfig.base.json`, `apps/desktop/tsconfig.json`, and
`apps/desktop/tsconfig.electron.json`. Compiler versions, strictness, file scopes,
declaration settings, and check commands stay unchanged.

Simply removing `baseUrl` and rebasing aliases causes eight TypeScript 6
declaration-emission errors, all TS2883. The affected exported functions expose
inferred types from internal Server declarations. This reveals an existing
dependency on the implicit lookup root, even though source import targets stay
the same. A small standalone reproduction shows the same failure and repair.

The successful candidate preserves that lookup through explicit wildcard paths:

| Configuration                  | Added fallback     |
| ------------------------------ | ------------------ |
| Root base configuration        | `"*": ["./*"]`     |
| Desktop configuration          | `"*": ["../../*"]` |
| Desktop Electron configuration | `"*": ["../../*"]` |

This follows the documented migration approach for preserving existing lookup
behavior. See [Microsoft's TypeScript 6 migration notes](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/).
The fallback restores declaration portability without source annotations or
disabled checks. All 19 configurations parse, and none inherits `baseUrl`.

| Retained check or compatibility measure | Result                                |
| --------------------------------------- | ------------------------------------- |
| Compiler                                | TypeScript 6.0.3, unchanged           |
| ESLint                                  | 2,055 files, zero errors and warnings |
| `pnpm typecheck`                        | Pass                                  |
| `pnpm typecheck:test`                   | Pass                                  |
| Desktop Electron check with `--noEmit`  | Pass                                  |
| API browser check with `--noEmit`       | Pass                                  |
| Import-resolution comparisons           | 37,568, zero changed targets          |
| Native Oxlint configuration errors      | Zero, previously 31                   |
| Executable typed-file promise probes    | 1,754 / 1,754 detected                |

The resolution comparison uses the existing compiler across project configurations
in both import and require modes. Existing unresolved lookups remain unchanged:
7,832 in each control. These include lookups that do not produce a physical
module result through this API. The result establishes no changed targets for
the tested inputs, rather than claiming that every lookup resolves to a file.

The coverage probe appends an unhandled `globalThis.Promise.resolve(...)` call
to each executable file in the explicit typed-rule scope. Oxlint reports the
expected `no-floating-promises` diagnostic at every inserted call. The remaining
file in the 1,755-file typed scope is a declaration file and receives no executable
probe. Every probe is restored afterward. The source-integrity check confirms
that only the three intended configuration files differ from the original source.

The experiment retains the official migrator's nursery rules, corrected test
exclusions, and per-file globals for the 26 inline-global declarations. Oxlint
traverses all 2,055 lint files before and after declaration builds. The existing
production typecheck supplies those declarations. This is a prerequisite-order
finding, not a new production CI change.

| Native diagnostic category                                 | Before declarations | After declarations |
| ---------------------------------------------------------- | ------------------: | -----------------: |
| Configuration errors                                       |                   0 |                  0 |
| Unsafe argument, assignment, member, or return diagnostics |              13,106 |                209 |
| Optional-chain and assignment differences                  |                  15 |                 15 |
| Additional typed-rule differences                          |                   2 |                  2 |
| Total lint diagnostics                                     |              13,123 |                226 |

The 209 remaining unsafe-type diagnostics occur in four MCP Server test files.
They coincide with unresolved `vi` or `@koed/db` types in native program contexts.
The two additional typed-rule diagnostics concern `no-misused-promises` in
`apps/api/src/managed-conversations/routes.ts` and `require-await` in
`apps/api/src/auth/remote-mcp-oauth-routes.ts`. These differences still require
explanation against the clean ESLint control.

Enabling native compiler diagnostics reports 47 additional errors: 42 missing
`vi` names, two unresolved `@koed/db` imports, one CSS side-effect import, one
Desktop event-mapping argument error, and one Vite configuration overload error.
The clean TypeScript 6 production/test/browser/Electron checks do not report them.
The test globals, aliases, and CSS declarations show that native program context
still differs from the custom lint/test projects. The two other compiler errors
need separate investigation.

Promise probes establish rule execution with standard promise types throughout
the executable scope. They do not establish correct resolution of every global
or imported type. Therefore the successful coverage result does not clear the
remaining native project-context failures or establish full lint equivalence.

The configuration-only approach is viable with the existing compiler and checks.
It removes the previously blocking legacy-option errors. It does not yet qualify
typed Oxlint for adoption, so no equivalent performance benchmark is added.
The next work is native lint/test project alignment and the remaining rule-level
differences. A full TypeScript compiler upgrade is not required for this tested
configuration cleanup and is not evaluated here.

The `oxlint-ts7config-evaluation` artifact retains the configuration diff, command
logs, module-resolution comparison, native diagnostics, and coverage results for
14 days. Raw evidence also remains in the designated scratch area. The first
configuration attempt records the TS2883 regression and is excluded from claims
that retained checks pass. The completed run above includes the explicit fallback
and passes all retained controls. Production configuration remains unchanged.
Architecture documentation needs no update for this evaluation.

## Native compatibility pass before adoption, 2026-11-02

The [final compatibility run](https://github.com/koed-labs/koed/actions/runs/41446353334)
uses evaluation head `8255c056551519bf32b79c04a6c82b4f3b170b1d`. It retains the
same source revision, runner class, tool versions, compiler, and configuration
cleanup as the preceding experiment. The evaluation passes its assertions about
compatibility failures. Oxlint itself still exits with errors. Production
configuration stays unchanged. The workflow is `.github/workflows/oxlint-compatibility-evaluation.yml`.

### Native project selection

Oxlint's typed engine discovers conventional `tsconfig.json` files. Its
`--tsconfig tsconfig.eslint.json` argument does not select that engine's project.
The [Oxlint CLI documentation](https://oxc.rs/docs/guide/usage/linter/cli.html)
explicitly distinguishes import resolution from typed-rule project discovery.

A single additional file fixes the MCP test context in the isolated snapshot:

```json
{
  "extends": "../../../tsconfig.eslint.json",
  "include": ["./**/*.ts"],
  "exclude": []
}
```

The file belongs at `packages/mcp-server/tests/tsconfig.json`. It reuses the
existing lint project's aliases and ambient types. It removes all 209 unsafe-type
reports, the 41 missing `vi` names in MCP tests, and both missing `@koed/db`
imports. It changes no lint rules. Native lint then reports the 15 core-rule
differences and the two additional typed-rule differences.

A separate diagnostic experiment temporarily removes conventional project files
and exposes the existing flat lint project through the root `tsconfig.json`.
This also removes the API test's missing `vi` name and the browser CSS error.
All project files are restored afterward. This experiment establishes the cause
of the context errors. Replacing production project boundaries this way is not
an adoption proposal.

### Core rules through JavaScript plugins

Oxlint can load the installed ESLint implementations of `no-dupe-args`,
`no-octal`, `no-unsafe-optional-chaining`, and `no-useless-assignment`. The small
plugin exports those four rules from `eslint/use-at-your-own-risk`, under the
`eslint-compat` namespace. Native optional-chain and assignment rules are disabled
in this trial. The duplicate-argument rule retains its JavaScript-only scope.

This removes all 15 core-rule differences in the flat-project experiment. It
also detects the four deliberately invalid examples. The trial excludes the
added plugin implementation from the measured source set, which retains 2,055
files. The plugin does not resolve typed-rule differences.

Suppression syntax needs attention. All four examples remain reported when a
comment uses its original rule name. Comments using `eslint-compat/<rule>` suppress
them. No tracked source comment names these four rules, so this experiment needs
no suppression edits to existing source. That result does not establish general
compatibility for unchanged future suppression comments.

The [Oxlint JavaScript plugin documentation](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
labels the API alpha and excludes rules that need TypeScript type information.
This bridge therefore retains ESLint as a dependency and cannot host the two
remaining typescript-eslint rules. It is a compatibility option with maintenance
cost, rather than a full removal of ESLint dependencies.

### Remaining typed-rule differences

Focused examples reproduce both differences without repository imports or project
references. The unchanged ESLint control also remains clean for both affected
API source files.

`no-misused-promises` reports a promise returned by the callback passed to
`Promise.finally`. The installed typescript-eslint implementation explicitly
exempts `Promise.finally`, which handles returned promises. Native Oxlint reports
the small example and the repository's terminal-attachment cleanup. Both engines
still detect the ordinary unsafe `() => void` callback example. This is a native
false positive relative to the retained rule behavior. A compiler upgrade does
not supply the missing rule exception.

`require-await` reports the async OAuth route callback with no await or returned
promise. typescript-eslint accepts a minimal version when one parameter has a
promise-like type. Its arrow-function selector also visits parameters and marks
the function as having an await. The repository callback receives a promise-like
Fastify reply. Oxlint reports both the ordinary and promise-like-parameter cases.
This identifies an existing ESLint detection gap. Any route adaptation still
needs a separate behavior review. Adding a meaningless await is not a migration
repair.

### Compiler diagnostics and decision

| Isolated setup                     | Lint reports | Additional compiler reports |
| ---------------------------------- | -----------: | --------------------------: |
| Validated configuration cleanup    |          226 |                          47 |
| Plus the MCP test project          |           17 |                           4 |
| Flat lint project instead          |           17 |                           2 |
| Flat project plus four-rule plugin |            2 |                           2 |

With the flat project context, native `--type-check` retains two errors. The
Desktop `flatMap` inference error is absent from the TypeScript 6 flat-project
control. The Vite configuration overload error also occurs in that control.
The latter is an existing error in a configuration file outside the retained
production/test check commands. Neither finding justifies removing an existing
check. Native compiler diagnostics are an additional experiment, not an existing
lint requirement or a completed TypeScript 7 compiler migration.

The retained ESLint and TypeScript 6 production, test, Electron, and browser checks
pass again. The preceding configuration assertions retain 37,568 unchanged
resolution comparisons and detect all 1,754 executable promise probes. Project
experiments restore every tracked file to that validated configuration candidate.

The largest compatibility obstacle now has a small configuration repair. Four
core rules also have a working JavaScript bridge. Adoption still needs a deliberate
choice about that dependency and suppression syntax, a repair or narrowly reviewed
handling of the native `Promise.finally` false positive, and a reviewed OAuth
callback adaptation. The flat-project experiment alone does not establish a
maintainable replacement for native project discovery throughout the workspace.

The recommendation remains Oxfmt independently, with ESLint retained. No qualified
Oxlint performance claim is added while repository lint still reports the two
typed-rule differences. If those differences receive acceptable repairs, measure
the full candidate, including the JavaScript plugin and declaration prerequisites,
against Oxfmt plus ESLint. The existing time and memory gates still apply.

The `oxlint-compatibility-evaluation` artifact retains source controls, native
outputs, project and plugin configurations, focused examples, and command records
for 14 days. Earlier attempts expose evaluation setup failures: absent native
rule names cannot appear even with severity off, the plugin adds a source file
unless excluded, and fixtures under ignored paths need an isolated working root.
They do not establish a passing compatibility result. Production tooling and
application code remain unchanged. Architecture documentation needs no update.

## Combined migration implementation, 2026-11-02

The User requests Oxfmt and Oxlint together. This supersedes the earlier
Oxfmt-only recommendation as the intended adoption scope. The implementation pins
Oxfmt 0.75.0, Oxlint 1.90.0, and oxlint-tsgolint 7.0.2005. It removes Prettier and
typescript-eslint from the root development dependencies. ESLint 10.4.0 remains
pinned for the four compatibility rule implementations. Oxlint runs them in its
JavaScript plugin worker, without a separate ESLint pass.

`pnpm lint` now runs the existing production typecheck before typed Oxlint. CI
and `pnpm verify` retain the check once through that command and retain the
separate test typecheck. The compiler remains TypeScript 6.0.3. The native engine
uses the three validated configuration repairs and the small MCP test project.
`tsconfig.lint.json` replaces the former ESLint-named lint project.

The OAuth callback now returns the Fastify reply after handing the response to
the SDK. This follows Fastify's documented async-handler pattern. The terminal
cleanup keeps its returned promise and error handling. One explained native
suppression covers only the known `Promise.finally` false positive. The ordinary
unsafe void-callback example remains detected in the regression suite.

Repository native lint reports zero diagnostics. The 110 focused regression cases
pass against the actual configuration. Full local formatting identifies only the
pre-existing untracked `CONFIG.md`. The tracked migration-file checks pass. The
32-file formatter change follows the previously reviewed trial output.

The [combined qualification](https://github.com/koed-labs/koed/actions/runs/41452153956)
passes at implementation head `123500e17c48965eb0348057107c079f9ee58e5a`.
It uses Node 24.13.1, pnpm 11.1.2, and the same Blacksmith four-vCPU PR runner
class. The control source remains `f22c4f3bc7b0aaf3c74a2776c00f591c6ea677bf`.
No production or test check is removed to obtain the clean result.

The four earlier one-off evaluation workflows are retired from the current tree.
Their recorded evaluation heads retain the original scripts and dependencies.
The combined qualification workflow covers the implemented migration.

### Qualified combined results

The candidate reports zero warnings and errors across 2,056 files and 96 rules.
The original ESLint control checks 2,055 files. All 2,054 shared original source
files remain. The old ESLint configuration is removed, and two tooling scripts
are added. All 1,754 executable typed-file probes are detected and restored.
The 110 scope/rule/suppression cases pass. All 49 OAuth and terminal-route tests
pass, with zero failures and skips. Production, test, Electron, and browser
TypeScript checks also pass.

The incremental control uses Oxfmt with unchanged ESLint. This isolates the gain
from adopting Oxlint after formatting already uses Oxfmt. Each tool receives an
unmeasured warm-up. Five measured pairs alternate control and candidate order.
Lint caches are disabled. Native plugin workers and the Go engine contribute to
sampled simultaneous RSS across the full process tree. Sampling uses 10 ms
intervals. Each combined peak is the larger formatter or lint command peak.

| Formatting plus lint measure | Oxfmt + ESLint | Oxfmt + Oxlint | Reduction |
| ---------------------------- | -------------: | -------------: | --------: |
| Median elapsed seconds       |          65.89 |          12.77 |     80.6% |
| Elapsed range, seconds       |    59.68–70.44 |    12.30–15.95 |           |
| Median sampled peak, MiB     |         6250.3 |         4118.7 |     34.1% |
| Sampled peak range, MiB      |  6214.3–6314.6 |  3818.5–4179.7 |           |

The ranges do not overlap. Even the slowest candidate against the fastest control
reduces time by 73.3%. The largest candidate peak against the smallest control peak
reduces memory by 32.7%. The 50% time and 30% memory targets therefore pass for
these five paired measurements, independently of the earlier formatter gain.

The complete-job comparison restores the original Prettier source and includes
dependency installation, environment/ADR checks, formatting, lint, production/test
typechecks, and the Electron/browser checks. Dependency directories and TypeScript
build-info files are removed before each sequence. The shared pnpm store remains
warm. The candidate runs the production check once through `pnpm lint`.

| Complete static sequence  | Original Prettier + ESLint | Combined Oxc | Reduction |
| ------------------------- | -------------------------: | -----------: | --------: |
| Elapsed seconds           |                     154.40 |        74.98 |     51.4% |
| Sampled process peak, MiB |                     6391.4 |       4219.7 |     34.0% |
| Exit status               |                          0 |            0 |           |

Complete-job values come from one paired sequence, rather than five samples.
They include the required declaration build and installed tooling dependencies.
They do not measure a cold network install or application runtime performance.
The five-pair comparison supplies the repeated evidence for the migration gates.

The combined migration now qualifies under the evaluated safety, coverage, time,
and memory criteria. Adopt both tools together as requested. Retain the four-rule
ESLint library bridge and the one documented `Promise.finally` exception until
native implementations cover those cases. Future rule changes must pass the
committed compatibility suite. The compiler remains TypeScript 6.

The `oxc-migration-qualification` artifact retains commands, measurements, route-test
results, coverage data, and the measurement scripts for 14 days. The workflow and
tested commit retain the reproducible setup. Later changes only record findings
and retire the superseded evaluation workflows. The 32-file formatting commit is
separate from the tooling implementation. No architecture documentation update is
needed. The User confirmed omission of a release changeset for this migration.

## Native-only policy simplification, 2026-11-02

The User approved removal of the compatibility bridge and a deliberate change to
the exact-parity requirement. Retire `no-dupe-args`, `no-octal`, and
`no-useless-assignment`. Keep Oxlint's native `no-unsafe-optional-chaining` rule.
Remove the ESLint package, plugin file, plugin configuration, and six obsolete
rule fixtures. The focused suite retains 104 cases and adds a JavaScript source
policy test. Existing typed safety rules and application tests stay in place.

The repository contains no tracked `.js`, `.jsx`, or `.cjs` files. Use `.mjs` for
JavaScript and `.tsx` for JSX. The source-policy test enforces this choice so
future files cannot silently escape the native parser's strict-mode protection.
The policy does not affect generated JavaScript in ignored output directories.
Retiring useless-assignment checking is an accepted loss of that quality guard.

Native optional-chain checking identifies 13 test expressions across five files.
The changes keep their existing assertions. Safe access now continues past type
assertions around optional values. The PI fixture and Desktop preview test also
assert that required values exist before reading them. No application test is
removed. The `Promise.finally` exception remains separate and unchanged.

Local native lint reports zero diagnostics across 2,055 files. The removed bridge
script accounts for the one-file reduction from the previous implementation.
The 104 safety cases and source-policy test pass. PR-runner checks for the five
affected test files, compiler checks, and complete typed coverage remain pending.
The existing benchmark covers the bridge implementation with the stricter rule
policy. It does not establish new performance figures for this simplification.
Performance comparisons now require an explicit manual workflow input. Routine
qualification retains compiler, regression, route, and typed-coverage checks.
