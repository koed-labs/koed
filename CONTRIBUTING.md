# Contributing

Thanks for your interest in Koed Self-Hosted.

## License

Koed is licensed under the Apache License 2.0 (`Apache-2.0`). Unless you
explicitly state otherwise, contributions intentionally submitted for inclusion
in Koed are provided under `Apache-2.0`, subject to any separate contributor
agreement you have executed with Koed Labs.

Before accepting non-trivial external code contributions, Koed Labs requires a
signed contributor agreement confirming that the contributor has the rights
needed to submit the contribution and granting Koed Labs the rights needed to
use, modify, sublicense, and relicense it.

Do not submit code that you do not have the right to contribute.

## Contribution Process

- Open an issue before starting large changes.
- Keep pull requests focused and explain the user-facing behavior they change.
- Include tests or validation notes for behavior changes.
- Do not include secrets, private deployment details, customer data, or captured
  memory data in issues, pull requests, logs, or screenshots.

Koed Labs may decline or defer contributions that do not have the required
contributor agreement in place.

## Formatting and linting

Install the pinned workspace dependencies with `pnpm install`. Use `pnpm fmt`
to format files with Oxfmt and `pnpm fmt:check` to check formatting. The formatter
preserves the 80-column width and authored-prompt exclusions. Import, package,
and Tailwind sorting stay disabled.

Run `pnpm lint` for production typechecking and typed Oxlint checks. This command
runs the existing TypeScript build first because Oxlint needs current workspace
declarations. It reuses incremental build state on later runs. Run
`pnpm typecheck:test` separately to check test sources. TypeScript 6 remains the
compiler for both checks. Native Oxlint compiler diagnostics are not enabled.

The official Oxc editor extension is recommended in `.vscode/extensions.json`.
The workspace selects it for supported web and documentation formats and disables
the ESLint editor runner. Run `pnpm lint` after a fresh checkout or changes to
workspace exports so editor checks can use current declarations.

Oxlint runs native rules only. There is no ESLint plugin or package dependency.
The native optional-chain rule stays enabled. The duplicate-argument, legacy-octal,
and useless-assignment rules are deliberately retired. This reduces rule coverage
from the exact-parity migration rather than preserving those three checks.

Use `.mjs` for tracked JavaScript and `.tsx` for JSX. A source-policy test rejects
tracked `.js`, `.jsx`, and `.cjs` files. This keeps JavaScript under native parser
strict-mode checks after the duplicate-argument and octal rules are retired.
Generated JavaScript in ignored build directories is unaffected. Before adding a
different JavaScript source extension, explicitly review and replace the retired
syntax checks.

Existing typescript-eslint suppression comments remain supported. Declare new
globals in `.oxlintrc.json`, because native Oxlint does not honor the existing
`/* global ... */` comments. The configuration already records those globals.

The MCP Server test project extends `tsconfig.test.json` for workspace aliases
and test globals, and enables TypeScript extensions in its imports.
`scripts/oxlint-safety.test.mjs` checks typed rules,
production/test overrides, native optional-chain checks, suppression behavior, and
the JavaScript source-file policy.
