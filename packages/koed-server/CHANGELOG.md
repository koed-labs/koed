# @koed/koed-server

## 0.11.0

### Minor Changes

- dbbb72b: Koed now reads an AI Client's conversations only while you have connected it. A client that is detected but not connected is no longer captured or imported, and connecting or disconnecting takes effect within seconds, without a restart. Automatic history import no longer stalls: a Conversation that fails the same way on every pass is skipped and logged instead of holding back newer ones, a closed import run is replaced with a new one, failures record the Memory API's error code, and a restart no longer marks history as stuck.
- dbbb72b: Only setting up or repairing an AI Client now connects it for capture, and only after Koed verifies the integration for the current `KOED_HOME`. Status checks no longer connect clients. Removing a client disconnects it before its integration is changed, so a removal that fails or is interrupted still stops capture, and a setup that was running when the client was removed can no longer reconnect it. Headless remote runtimes no longer reconnect clients when they start. Existing installations must connect each AI Client again, through Koed Desktop or `koed setup <client>`; no Memory is deleted.
- 5e31d33: Add an optional Linux CUDA package to each product release. The CLI installs the CPU core by default. Use `koed runtime install --provider release --dependency-mode bundled-local --with-cuda` to add CUDA while Koed is stopped.
- dbbb72b: Support a saved Chief of Staff name for Koed-created conversations and retry-safe Personal Project creation. Existing callers can continue without supplying either optional field.

### Patch Changes

- a55a62a: Avoid repeatedly polling pending Personal Device Sync outbox entries so other deliveries can make progress.
- b7063ab: Harden release promotion against npm registry visibility delays and reduce temporary disk use during published asset verification.

## 0.10.3

### Patch Changes

- 69065f0: Fix npm provenance verification by including the source repository in the published server package.

## 0.10.2

## 0.10.1

### Patch Changes

- e3cdae1: Add a user-focused package README with headless setup steps and version-matched component download commands.

## 0.10.0

### Minor Changes

- f91ad79: Add nested CLI help through Commander, with command-specific options and validation while preserving existing operation output and Desktop authority.

  Add `koed --version` and `koed -V` using the Changesets-managed Server package version.

  Keep root version reporting separate from subcommand version selection and development archive identifiers. Preserve static admission verification through the lazy component loader.

  Include control-plane version metadata in standalone archives so component inspection works after extraction.

  Preserve the CLI during interrupted source-runtime rebuilds. Stage and check Server compiler output before replacement, then remove obsolete generated modules.

## 0.9.2

### Patch Changes

- 43f02a6: Accept the pnpm argument separator when packing the public Koed Server npm candidate so release jobs no longer fail with an unknown-option error.

## 0.9.1

### Patch Changes

- 4ed0931: Find draft releases by listing releases when uploading release assets, so release jobs no longer fail with a 404 from the tag lookup.

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
