---
"@koed/koed": minor
---

Rename the internal Server package to `@koed-labs/server` and the terminal command to `koed`. Replace `koed-server` commands with `koed` and `pnpm koed-server` with `pnpm koed`. The package remains private; npm installation is not available in this release.

CLI help now loads without initializing service-start modules; operational commands retain the existing implementation.
