---
"@koed-labs/server": minor
---

Add nested CLI help through Commander, with command-specific options and validation while preserving existing operation output and Desktop authority.

Add `koed --version` and `koed -V` using the Changesets-managed Server package version.

Keep root version reporting separate from subcommand version selection and development archive identifiers. Preserve static admission verification through the lazy component loader.

Include control-plane version metadata in standalone archives so component inspection works after extraction.

Preserve the CLI during interrupted source-runtime rebuilds. Stage and check Server compiler output before replacement, then remove obsolete generated modules.
