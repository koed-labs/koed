# Publishing Koed Server

`@koed-labs/server`, the standalone Koed distribution, and Desktop use the same
product version. The public package is built with the existing public-server
package builder; standalone release artifacts are independently assembled as
base and privacy components. Each component archive has SHA-256, a component
manifest, and detached signature metadata. Unsigned local builds are marked
`unsigned-placeholder`; they are not official release artifacts.

## Headless distribution validation

The source Server workspace remains private because it depends on private workspace
packages. Changesets versions it alongside the private product manifest; only the
assembled, dependency-free npm artifact is public. The bundle includes Node
CommonJS loading support, the Privacy Service bootstrap and secret-provider CLI,
and `dist/component-trust-roots.js` for promotion verification.

Component manifests use canonical sorted-key JSON bytes without a trailing newline,
matching both signing and installer verification. Detached signature schema v2 signs
the domain `koed-component-manifest-sha256-v2` plus a newline and the raw SHA-256
digest of those bytes; the manifest schema stays at v1. Archive members are relative to
the payload root, matching the signed inventory. The headless release builder runs
under Node 24 and records its actual modules ABI. It does not declare Electron
compatibility; that requires separate packaged validation.

After `pnpm install --frozen-lockfile` and `pnpm build`, run the opt-in native smoke:

```bash
node scripts/headless-distribution-smoke.mjs \
  --postgres-bin-dir /absolute/path/to/postgres/bin \
  --llama-server-bin /absolute/path/to/llama-server \
  --embedding-model /absolute/path/to/embedding.gguf
```

The smoke builds and signs real Base/Privacy archives with an ephemeral test key,
embeds the public key only in copied fixture output, installs the resulting npm
package offline outside the checkout, installs both signed components, and runs Personal startup, readiness,
core doctor checks, shutdown, and a second startup/doctor/shutdown cycle in an isolated
Koed home. Acceptance verifies the healthy runtime belongs to the launched
supervisor, confirms supervisor exit and runtime-state cleanup after each stop,
and rejects a restart that reuses the first supervisor PID. AI Client authentication and capture setup remain separate; the smoke
does not use the User's credentials.
It does not install production roots or enable signing/publication. Linux and
Desktop acceptance remain separate release gates.

### Linux x64 and WSL standalone acceptance

Run acceptance as a non-root user inside a clean Ubuntu x64 environment with Node
24.13.1 and pnpm 11.1.2. Containers must use an init process (for example Docker
`--init`) so detached supervisors are reaped after shutdown. Install and build the
checkout there; do not copy macOS
`node_modules` or mount the Operator's existing `KOED_HOME` or AI Client credentials.
On Apple Silicon, a full x86_64 Colima/QEMU VM avoids user-mode emulation failures
observed during Node/libuv component staging. Emulated results establish compatibility,
not native performance. No Electron installation, desktop display, or published npm
version is required.

Use native inputs matching `scripts/native-runtime/sources.linux-x64.json`:
PostgreSQL 17.6 with pgcrypto, pgvector 0.8.3, and llama.cpp b10514. Verify upstream
SHA-256 values before building/extracting them. The input directories must include
PostgreSQL client tools and extensions, and llama-server's sibling shared libraries.
The smoke uses these explicit paths; it does **not** validate cold installation or
relocation of the complete packaged native-runtime payload, CUDA, or GPU drivers.
Those remain separate acceptance requirements.

For fresh model provisioning through the assembled, installed CLI, replace
`--embedding-model` with `--install-models`. This explicitly allows pinned model
network downloads before startup. The npm install remains offline, and production
trust roots still reject the ephemeral fixture signing key. Use separate output
directories that do not already exist:

```bash
node scripts/headless-distribution-smoke.mjs \
  --postgres-bin-dir /absolute/path/to/postgres/bin \
  --llama-server-bin /absolute/path/to/llama-server \
  --install-models \
  --out-dir /absolute/path/to/personal-acceptance

node scripts/headless-distribution-smoke.mjs \
  --postgres-bin-dir /absolute/path/to/postgres/bin \
  --llama-server-bin /absolute/path/to/llama-server \
  --install-models --team \
  --out-dir /absolute/path/to/team-acceptance
```

`--team` also installs the pinned Privacy Filter model. Do not combine
`--install-models` with preinstalled model inputs. Preserve `result.json`,
`doctor-initial.json`, `doctor-restart.json`, model-install reports, and failing
supervisor logs as local evidence. These directories contain disposable keys and
runtime state: do not commit them or upload entire directories as public artifacts.
Only a run completing both shutdowns writes a successful result.

Ubuntu-container acceptance is **not WSL2 acceptance**. Repeat inside an actual
WSL2 Ubuntu x64 distribution, keep checkout and `KOED_HOME` on its Linux filesystem
(not `/mnt/c`), and separately check Windows-host connectivity and stop/restart
across WSL shutdown. Until recorded, WSL2 remains unvalidated. Likewise, testing
Ubuntu 24.04 alone does not establish the Ubuntu 22.04/glibc 2.35 baseline.
Neither this smoke nor its fixture signatures authorize npm publication, production
component signing, or release promotion.

### Recorded Linux x64 standalone acceptance: 2026-10-16

Local validation used Ubuntu 24.04 x64 in a full x86_64 Colima/QEMU VM on an
Apple Silicon host, Node 24.13.1, pnpm 11.1.2, and the pinned native inputs above.
A clean checkout built successfully and assembled both base and privacy components.

- **Personal: PASSED.** Offline installation outside the checkout, Base/Privacy
  fixture signature verification, fresh embedding-model provisioning through the
  installed CLI, and core doctor checks (`api`, `database`, `workerQueues`,
  `embeddingService`, `privacyService`, `localAiRuntime`, `apiToken`, `mcpServer`,
  `deviceIdentity`). Healthy supervisor PID 267 stopped; fresh supervisor PID 650
  stopped successfully. Production test key rejected without activating a component.
  No AI Client credentials or MCP setup exercised.
- **Team: BLOCKED.** Fresh embedding and Privacy ONNX provisioning passed. Integrated
  startup timed out twice with `Privacy Filter Service (starting)` and
  `Local AI Runtime (needs_attention)`. Privacy Service loaded CPU parity (~100s in
  emulation) and logged `listening on :48092`; worker reported
  `privacy_service_unavailable_error` three times. Same Privacy payload run in
  isolation completed CPU parity (~50s) and returned HTTP 200 from `/health` with
  `activeProvider:cpu`. The service works alone but fails integrated; root cause
  remains unresolved. This is not proof of an emulation-only failure. Do not weaken
  readiness checks or label Team release-ready.
- **Fault-injection tests:** startup failure blocks before doctor, failed shutdown
  blocks acceptance, unhealthy restart preserves doctor reports, stale supervisor
  cannot pass readiness, and restart requires a different supervisor PID. These
  verifier tests do not replace cold acceptance.
- **Still unvalidated:** actual WSL2 (requires Windows host), Ubuntu 22.04/glibc
  2.35, cold packaged native-runtime install/relocation, GPU/CUDA (driver >=
  550.54.14), and native x64 performance. Emulation does not establish native
  performance.

These are local fixture results, not a published-release or production-signing
rehearsal. Keep Team and remaining platform gates blocked until independently
validated; do not increase timeouts or remove checks merely to obtain a pass.

## Desktop privacy component lifecycle

Desktop installs privacy components through the private supervisor IPC channel;
this is not a public server API. The supervisor stages only a signed privacy
component that matches the packaged bundle's product version and target and the
actual runtime identity. The staged generation descriptor combines the trusted
bundled base with that privacy component. Startup rereads the descriptor and
re-verifies the bundle, component signature, stored bytes, version, target, and
runtime before pinning the generation.

Desktop Preferences calls the manager-owned `privacyInstall` capability. The
main process communicates with its private supervisor using the startup nonce
and request-ID-correlated status, progress, install, cancel, and activation RPCs.
Renderer IPC accepts only the allowed origin's main frame. Online installs use
the exact Desktop version and target from the canonical
`https://github.com/koed-labs/koed/releases/download/v<version>/` release path;
offline imports require archive, manifest, and detached-signature paths. No
renderer-supplied release owner, version, or key is accepted.

While Koed is running, installation stages a candidate without changing the
active generation. Manager confirms supervisor exit before activating the
staged descriptor in a short-lived child using the same private authority, then
restarts and waits for readiness. Failed or cancelled staging leaves the
current generation pointer unchanged. Activation/restart failures attempt to
restore the previously active generation and restart it. Production signing
and trust-root prerequisites below remain unchanged; test fixture keys are not
production trust material. Builds without approved production trust roots
report that signer prerequisite with update guidance and fail installation closed.
The approved KMS public root is embedded in this branch's control-plane source;
Desktop bundles receive it when rebuilt.

## Required production infrastructure

Release publication remains blocked until Operator-managed infrastructure is
configured. CI requires all of these repository variables before promotion:

- `KOED_COMPONENT_SIGNER_URL`: approved external signing service endpoint.
- `KOED_COMPONENT_SIGNER_KEY_ID`: production signing identity.
- `KOED_COMPONENT_TRUST_ROOTS_SHA256`: SHA-256 of approved production trust
  roots. Empty or malformed value fails closed.
- `KOED_NPM_PUBLICATION_AUTHORIZED=true`: npm organization has enabled GitHub
  Actions trusted publishing for the exact repository and workflow, with
  package write permission and OIDC; no long-lived npm token is used.
- `KOED_RELEASE_PROMOTION_APPROVED=true`: separate explicit release approval.

The approved KMS root, hosted signing service and signer/trust-root repository
variables are configured. An authorized signing-only GitHub rehearsal passed
signature, archive and tampering verification; temporary branch signing access
was removed afterward. npm publication authorization and release promotion
approval remain explicitly false. Complete full v2 lifecycle acceptance and
review npm trusted publishing before enabling them. Without those authorizations,
release workflows must leave GitHub releases as drafts and must not publish npm
packages or stable tags.

## Immutable candidate and retry protocol

1. Build all release bytes from one product version and retain the npm tarball,
   SHA-512 integrity, and deterministic inventory SHA-256.
2. Upload missing GitHub draft assets only. Existing same-name assets are
   downloaded and compared byte-for-byte by SHA-256; exact matches are
   idempotent, while any mismatch blocks without overwrite.
3. Publish the npm version once under its immutable semver identity and a
   version-specific `candidate-<version>` dist-tag. If the version already exists, verify
   exact SHA-512 integrity and inventory before continuing; mismatches block.
4. Verify the candidate from the npm registry, then move `latest` only if that
   cannot downgrade it. Publish the GitHub release only after all expected
   asset identities and checksums verify.
5. Retries resume from remote state: missing assets may be added to a draft,
   matching assets and an identical npm candidate are no-ops, and conflicting
   bytes, identities, or tags block. Never use asset replacement, npm version
   overwrite, or blind `--clobber`.

`scripts/release-promotion-lib.mjs` is a pure state planner for this ordering;
it emits no credentials and performs no publication. `scripts/ensure-release-assets.mjs`
implements byte-checked, no-overwrite GitHub draft asset retries. Actual external
signing, npm candidate publication/registry verification, and trust-root
verification remain infrastructure gates, not simulated successes.

## Signing and key rotation

Production signing keys stay in an external signer; private key material must
not enter the repository, workflow artifacts, or logs. Component manifests
bind product version, target, required files, runtime constraints, and archive
hash. Signatures use the existing Koed component-manifest canonical format.
Before signing is enabled, verifier policy must pin reviewed trust roots and
key IDs. Rotation requires publishing the new approved trust roots, verifying
artifacts signed by both old and new keys during the transition, then removing
old roots only after all supported artifacts have migrated. Fixture keys used
by tests are never production trust roots.
