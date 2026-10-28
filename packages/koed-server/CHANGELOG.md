# @koed/koed-server

## 0.9.0

### Minor Changes

- ff0eb4b: Admit verified Desktop-bundled runtimes for fresh packaged installations.

  Allow private Desktop asset management before Team services start, preserve authenticated Privacy readiness, admit installation-owned bundle upgrades, and route Claude Code/Pi setup and repair through the private supervisor. Share bundle authentication and per-request runtime validation; isolate supervisor transport and Privacy rollback sequencing. Keep local API Token provisioning aligned with the active pepper, ensure Codex bootstrap runs from symlinked checkouts, and surface unavailable Ask AI Clients as a completed state so a User can select a ready AI Client instead of waiting indefinitely.

- 5292e19: Publish Koed Server as `@koed-labs/server` with the `koed` command. Packaged service startup uses only a version-matched, verified, pinned component generation and fails closed without downloading or falling back to checkout files. The old `koed-server` executable alias is removed; native runtime and model provisioning remain explicit setup steps, with privacy components provisioned when required.

  Headless releases use canonical manifests with v2 domain-separated SHA-256 digest signatures compatible with managed Ed25519 signing, payload-relative archives and explicit Node 24 ABI metadata. The public npm bundle includes its runtime helpers; promotion streams large assets and uses npm-valid candidate tags. The approved KMS public root and authenticated signing service support production component verification; publication remains gated pending release acceptance and explicit authorization.

- 3030a65: The `koed` launcher installed from Koed Desktop now manages Desktop's own
  instance: `status`, `doctor`, `setup`, client repair, `start`, `stop`, and
  `restart` work whether Desktop is open or closed, and Desktop reconnects to a
  supervisor started by the launcher without starting a duplicate. Desktop shows
  an externally stopped instance as stopped with a Start action. An independently
  installed CLI keeps its own instance. Local API Token checks retry one short,
  locally rate-limited access check and expose retry metadata when still blocked.
  Reinstall the launcher from Desktop to upgrade an existing one.
- ff0eb4b: Admit Base and Privacy components using versioned manifest pins embedded in trusted control planes. Acquire archive and manifest without detached signature inputs; reject legacy installed component records with reinstall guidance. Preserve external standalone launchers across restart, bind Desktop readiness to required catalog pins, and verify packaged catalog consistency before release promotion.
- ff0eb4b: Support pinned component generation upgrades across versions while preserving the prior generation's component presence in upgrade status. Release promotion now verifies candidates against protected reviewed-build identity before any publication: the npm package is inspected statically (archive safety, ESM package scope, and generated CLI admission bindings), downloaded assets must match the protected build bytes before they are read, and candidate code is never executed in the credential-bearing verifier.

### Patch Changes

- 3030a65: Write Desktop bundle manifests with the same public file mode preserved by Electron Builder, allowing packaged runtime reproducibility checks to pass.
- 3030a65: Preserve packaged Desktop Team smoke failure diagnostics before temporary-home cleanup, and include bounded supervisor stderr when private management startup fails.

## 0.2.0

### Minor Changes

- 5a84477: Add native bundled-local Embedding Service runtime selection and status wiring.
