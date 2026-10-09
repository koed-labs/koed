---
"@koed/koed": minor
"@koed-labs/server": minor
---

Publish Koed Server as `@koed-labs/server` with the `koed` command. Packaged service startup uses only a version-matched, verified, pinned component generation and fails closed without downloading or falling back to checkout files. The old `koed-server` executable alias is removed; native runtime and model provisioning remain explicit setup steps, with privacy components provisioned when required.

Headless releases use canonical signed manifests, payload-relative archives and explicit Node 24 ABI metadata. The public npm bundle includes its runtime helpers; promotion streams large assets and uses npm-valid candidate tags. Production publication remains gated pending approved trust roots and infrastructure.
