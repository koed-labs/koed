# Public Koed distribution design

Status: proposed for Operator review. Product implementation has not started.

## Intent and boundaries

Implement `docs/handoffs/publish-koed-labs-server.md`: one public npm entrypoint,
`@koed-labs/server`, exposing only `koed`, plus exact-version service components
and opt-in Desktop terminal integration. Keep coordinated product versions,
private `@koed/desktop` and `@koed/koed` identities, native/model provisioning,
standalone installation, and existing service requirements. No backend LLM
synthesis, automatic npm downloads, npm publication, credential creation, or
macOS signing/notarization work is authorized.

User requested incremental implementation commits, review between chunks, and
branch push at code-complete stopping point. Design review precedes a separate
implementation plan and its review. Work is on `feat/publish-koed-labs-server`.

Baseline: `39dd6db1a`, product `0.8.1`, release `v0.8.1`, open release PR #400.
Minor bump approval is recorded in handoff; implementation must refresh release
state and coordinate with that PR rather than assume its proposed version.

## Architecture choice

Recommend shared assembly with three independently validated payloads:

| Payload           | Contents                                                                                                                              | Delivery                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Control plane     | CLI, supervisor, configuration, provisioning, diagnostics and complete dependencies                                                   | Public npm package; also staged into Desktop/standalone                     |
| Base component    | API, Worker, Local AI Runtime, MCP Server, Capture Hook, Embedding Service, migrations, prompts and complete non-privacy dependencies | Target-specific exact-version archive; bundled with Desktop                 |
| Privacy component | Privacy Filter Service and its complete dependency closure/assets                                                                     | Target-specific exact-version archive; explicitly provisioned when required |

Native Postgres/pgvector, llama-server and models stay separate under `KOED_HOME`.
Base retains all non-privacy service JS even when configuration starts only a
subset. BullMQ stays in base unless complete import analysis proves otherwise.

Alternatives rejected: monolithic payload defeats optional privacy and lightweight
npm installation; separately installed service npm packages violate approved
single entrypoint and complicate coordinated activation. Reuse
`scripts/app-runtime-staging.mjs` rather than build a second assembly pipeline.

## Control-plane contract

Rename workspace package identity, dependencies, lockfile references and supported
command integrations, keeping `packages/koed-server/` directory. No `koed-server`
executable alias. Remove old executable usage, not historical/internal names.

Assembled npm manifest uses public access, Node `>=24 <25`, only `koed` bin,
explicit shipped files, licences and resolved dependencies. This is proposed
support, not validated support. Internal private code must be bundled or staged
inside tarball; no `workspace:*`, checkout paths or external symlinks survive.

Launcher sets installation-relative `KOED_SERVER_PACKAGE_ROOT` for control-plane
resources only and explicit packaged execution mode. Change existing resolver
semantics: that variable must not imply `<root>/koed-runtime`. Resolve services
through verified selected `KOED_HOME` generation; Desktop explicitly binds its
trusted bundled base and a verified matching privacy component. Standalone binds
its distribution manifest and verifies component integrity before execution.

Packaged mode rejects arbitrary `KOED_JS_RUNTIME_ROOT`, legacy runtime-directory
fallbacks, Desktop CLI/Node overrides and source/check-out paths. Enumerate existing
overrides in implementation tests; no alternate compiled-JS trust bypass survives.
Embedded Desktop/standalone payloads must match distribution manifest digests;
installed components require authenticated manifests. Source development and its
overrides require explicit development mode, unavailable through shipped launchers.
Control-plane root and component roots are distinct typed resolver inputs.

Audit command imports, including transitive DB/MCP/native imports. Help,
configuration, component status/install, native provisioning and model
provisioning load without service components. Service-dependent commands lazily
load their implementations after validating requirements. Missing components
produce actionable errors; never trigger implicit installation.

Proposed CLI:

```bash
npm install -g @koed-labs/server
koed --help
koed components status --json
koed components install --component base --json
koed runtime install --provider homebrew --dependency-mode bundled-local --json
koed models install --kind embedding --json
koed start
```

`runtime install` retains native provisioning semantics. `components install`
selects current control-plane version and host target by default. It stages and
activates a complete compatible generation only while stopped. Running runtime
allows staging but activation requires explicit stop; no silent service restart.
`components activate` selects a fully staged generation while stopped. Explicit
`--version` different from invoking control plane stages only; activation requires
invoking matching control-plane version. Rollback therefore first selects matching
prior control plane, then explicitly activates retained generation after migration
checks. Non-mutating status/diagnostic inspection can report version mismatches.

Offline provisioning accepts explicit archive plus signed metadata paths for
base and optional privacy. No network fallback. `components status` distinguishes
required, installed, staged, active, incompatible and missing components.

Existing `package` commands remain standalone controls, delegated to common
verification/generation logic rather than a second security policy.

## Configuration and component ownership

Resolve effective configuration before component validation through one shared
requirements calculation used by status/install/start/Desktop. Include server
configuration, explicit env-file input, existing environment precedence and Team
endpoint/token detection; do not assume Team state lives in `server.json`. Packaged
mode never implicitly loads checkout environment files. Malformed supplied config
fails with actionable error rather than silently becoming default configuration;
validate any source-mode behavior change separately. `runtimeMode` and
`dependencyMode` remain independent:

| Mode/dependencies                      | Processes                                                  |
| -------------------------------------- | ---------------------------------------------------------- |
| local-personal or developer / external | API, Worker, Local AI Runtime                              |
| external / external                    | API, Worker                                                |
| local-personal / bundled-local         | API, Worker, Local AI Runtime, Postgres, Embedding Service |
| external / explicit bundled-local      | API, Worker, Postgres, Embedding Service                   |

Bundled-local plus Team adds local Privacy Filter Service; external dependencies
with Team require configured external privacy endpoint/tokens, not local privacy
artifact. Preserve current supported configuration validation; do not introduce
a new mixed local/external privacy selector as incidental packaging work.
Bundled-local defaults to Postgres queue; external defaults to BullMQ; both need
Worker. Base required for all managed local service starts.

Component ownership comes from production dependency graph plus dynamic import,
asset and native-loader analysis. Shared dependencies remain available to base;
privacy receives every dependency it needs in its own hermetic resolution tree,
including duplicated shared dependencies where necessary. Privacy cannot depend
on incidental ancestor `node_modules`. No deletion based on audit's 31-package
size probe. Preserve execution providers, third-party licences, migrations,
prompts and native files; pruning follows existing target policies only.

Replace unconditional privacy required-file checks in
`packages/koed-server/src/app-runtime.ts` and
`packages/koed-server/src/package-runtime.ts` with component contracts. Give
`packages/koed-server/src/local-privacy-runtime.ts` explicit privacy root.

## Integrity, installation and activation

Each signed manifest binds schema version, coordinated product version, component
identity, platform/architecture, supported Node range, ABI/native constraints,
Linux libc constraints where needed, required files, archive size and SHA-256.
Validate canonical serialization, signature, trusted key ID, target and version
before extraction/activation. Reject traversal, escaping links, incomplete files,
corrupt cache and incompatible runtime. Hashes alone do not establish origin.

Recommend existing Ed25519 provenance format extended to component manifests,
with immutable public trust roots shipped in control plane. Official downloaded
and offline artifacts require signatures; unsigned-placeholder and checksum-only
policies cannot activate them. Trust-key replacement requires a new trusted
control-plane release; include key IDs for rotation. No runtime-provided arbitrary
key or unsigned override in public provisioning path.

Signing production manifests requires externally provisioned trusted signer.
Prefer OIDC-authorized signing service/KMS only if its supported algorithm matches
existing verifier; otherwise Operator-approved managed Ed25519 key infrastructure.
Do not assume any cloud KMS supports Ed25519. Local tests use disposable fixture
keys injected into test-only verification APIs, never production trust roots.
Until approved public key and signing infrastructure exist, CI may validate fixtures
and build unsigned candidates, but production promotion fails closed. This is an
explicit external release gate, not completed artifact authentication.

Install stages immutable component directories and generation manifest under
`KOED_HOME`; generation selects matching base/privacy version and target. Hold
installation lock across validation/activation, reject conflicting supervisor
activity, then atomically replace one current-generation pointer. Define shared
lifecycle exclusion with supervisor startup: acquire locks in one documented order,
startup pins generation before releasing exclusion, activation requires no live
pins, and cleanup cannot delete pinned generations. Do not substitute a racy
check-then-switch process lookup for this protocol. Recover stale pins only after
verifying process identity/liveness, failing closed on uncertainty. Never remove
working version directory before replacement. Failed download, cancellation,
verification or activation retains active generation. Desktop bundled base plus
installed privacy must obey same exact-version set validation.

Upgrade npm control plane does not automatically provision runtime. Report
mismatch with explicit matching install instructions. Retain previous compatible
generation for rollback. Activation checks migration downgrade/rollback constraints;
never promise recovery across irreversible migrations. Database migration failure
must not be described as pointer-only rollback safety.

Cleanup deletes only inactive unreferenced verified caches/generations under
lock. Default uninstall removes launch/package integration, not User state,
models or active runtime. Destructive state removal requires separate explicit
confirmation and is not part of routine component cleanup.

## Desktop provisioning

Desktop packages base and matching control plane from shared staging, without
first-run base JS download. Privacy runtime/model becomes setup prerequisite only
when configuration requires local Privacy Filter Service. Extend existing
renderer → preload → validated IPC → `KoedServerManager` → JSON CLI flow.

Before download show consent, component/model sizes when known and destination.
Expose progress, cancellation, retry and signed local/offline inputs. Cancellation
leaves working runtime untouched. Failure blocks required local privacy start;
never disables privacy or silently changes endpoints. Transition from external to
local dependencies checks existing component/model state before launch. Switching
back does not delete cached artifacts or User state. Personal-only setup requires
neither privacy artifact nor model.

Current Electron resolves to 39.8.10 from declared `^39.2.7`; actual packaged
embedded Node/ABI and RunAsNode fuse must be measured. npm Node 24 support does
not establish Electron compatibility. Component manifest permits Electron only
with separately tested constraints.

## Opt-in Install CLI

Settings may inspect status but never install launcher or edit shell files on
open. Initial validated Desktop target is macOS arm64; no inferred Linux Desktop
or native Windows support.

Install a Koed-owned launcher at `~/.local/bin/koed` after explicit action. Prefer
an atomically written launcher with ownership marker and validated app/helper
binding, not an unqualified symlink overwrite. Resolve paths safely with spaces
and symlinks; executable permissions required. Invoke bundled control plane using
a validated macOS helper and `ELECTRON_RUN_AS_NODE=1`, without system Node/npm or
GUI lifecycle side effects. If helper/fuse cannot meet contract, disable action
with actionable unsupported-runtime error; never fall back to GUI executable.

Status reports independently: destination ownership, target existence/validity,
control-plane version, helper viability and PATH visibility. Shell PATH visibility
from Desktop process can be stale; label current process status, not universal
shell detection. Moved/missing app yields repair instruction. Updates at same app
path remain valid; repair explicitly rebinds after relocation.

Existing unrelated executable or npm launcher is conflict: preserve it; offer
cancel/keep-existing or explicit user-selected alternate launcher path. No silent
replacement or deletion. Repair/removal verify owned content and bound target;
changed file or unexpected symlink is a conflict, including races during action.

Separate consent for PATH changes. Support identified shell files only, reject
unsafe symlink targets, atomically preserve content and use one managed block.
Removal deletes only unchanged Koed-owned block; preserve user-edited content.
Report new shell may be required. Unsupported shell gets manual instructions.

Shared `KOED_HOME` does not transfer ownership. Desktop declares runtime owner in
supervisor/generation state. npm CLI may inspect compatible runtime but cannot
activate/replace Desktop-managed runtime. Desktop component requests use its
bundled control plane and validated private manager/supervisor channel bound to
installation identity; never authorize by caller-supplied owner flag alone.
Manager stages privacy against bundled-base digest/version, stops owned services
explicitly, activates matching set under shared exclusion, then restarts. Desktop
update changes bundled-base binding only while stopped; missing matching privacy
blocks Team startup and requests provisioning. Other callers cannot rebind owner.
Lifecycle mutations use matching supervisor contract and explicit owner checks;
mismatch reports which Desktop or CLI owns it. Do not kill arbitrary processes or
silently take over ownership.

## Versioning and release promotion

Make public server Changesets-managed and public-access while retaining private
product release manifest. Synchronization must enforce one product version across
control plane, base/privacy manifests, standalone and Desktop. Avoid double bumps
from Changesets and custom synchronization. Minor release notes must state removed
`koed-server` executable and explicit provisioning/optional privacy changes.

Build and validate packed npm payload, both target component sets, Desktop and
standalone before promotion. Upload immutable assets to draft GitHub release,
verify expected hashes/signatures, then publish npm under candidate tag only after
separate publication authorization. Verify registry tarball contents/integrity
before promoting `latest` and publishing GitHub release. A failed later step leaves
recoverable draft/candidate state, not permission to overwrite npm version.

Retry derives progress from immutable expected manifest and remote artifacts, not
release-exists boolean. Already-published version must match expected tarball;
otherwise stop. Existing GitHub assets must match; avoid blind `--clobber` for
validated release artifacts. Document recovery for npm-success/Desktop-failure and
partial tag promotion. `latest` never deliberately moves backward without explicit
Operator action. npm trusted publishing/OIDC needs organisation/permission setup;
this work may configure guarded workflow but cannot create credentials/publish.

Generated release notes/PR sections validate changelog heading against synchronized
version rather than borrowing stale first section.

## Validation and code-complete boundary

Implementation plan must map every handoff acceptance criterion to evidence or
named external gate. Required automated coverage:

- Packed global npm install outside checkout, spaces, clean environment and no
  downloads for help/config/provisioning; no workspace refs/external symlinks.
- Dependency/asset/licence completeness and hermetic privacy execution with
  ancestor resolution disabled; preserved inference providers.
- Configuration matrix, Personal lifecycle, Team local/external privacy and
  transition; separate native/model prerequisites.
- Signature/hash/version/target/ABI rejection, traversal, corrupt cache, offline
  input, cancellation/retry, failed install preserving active generation.
- Concurrent installation/activation, stopped-runtime requirement, matching sets,
  downgrade/migration guards, cleanup and state-preserving uninstall.
- Desktop consent/progress/cancel/retry, Personal base-only setup and packaged
  lifecycle; Electron helper invocation without system Node or GUI side effects.
- Launcher conflicts/races, spaces/symlinks, permissions, PATH managed blocks,
  repair/removal, relocation/update and npm/Desktop mismatch/ownership.
- Coordinated versions, release-note headings, immutable retry/promotion using
  mocked registry/GitHub/signer; no real publication.
- Applicable formatting, lint, typecheck, build and packaging checks.

External gates: npm organisation ownership/trusted publishing, production signer
and trust-root approval, real signature/release integration without publishing,
Linux target/libc execution, packaged macOS helper and Electron/native compatibility,
full native/model lifecycle where local prerequisites unavailable. Never mark
acceptance criteria passed solely from code or mocked tests.

Code-complete means approved design/plan implemented with review issues resolved,
applicable local checks passing, and outstanding external gates documented. It
never means releasable while authentication or platform gates remain unvalidated.

## Evidence and affected boundaries

Read-only scouts identified these starting points (not proof of runtime success):

- `packages/koed-server/src/cli.ts`: eager imports before command dispatch.
- `packages/koed-server/src/start.ts`: runtime validation precedes configuration.
- `packages/koed-server/src/runtime-artifact-source.ts` and
  `packages/koed-server/src/paths.ts`: packaged/source and checkout inference.
- `scripts/app-runtime-staging.mjs`: shared hoisted graph and package wrappers.
- `scripts/privacy-runtime-package-policy.mjs`: native target pruning, not closure.
- `scripts/koed-server-package-lib.mjs`: optional Ed25519 provenance and unsigned
  placeholder; `packages/koed-server/src/package-runtime.ts`: checksum default,
  one-pointer activation and destructive same-version replacement.
- `apps/desktop/scripts/prepare-koed-runtime.mjs` and
  `apps/desktop/electron-builder.yml`: current bundled privacy contract.
- `apps/desktop/src/koed-server/runtime.ts`: current Electron process invocation.
- `apps/desktop/src/ipc/protocol.ts`, `apps/desktop/src/ipc/commands.ts`,
  `apps/desktop/src/koed-server/manager.ts`: provisioning/consent/progress patterns.
- `.changeset/config.json`, `scripts/product-release-version-lib.mjs`,
  `scripts/product-release-notes.mjs`, `.github/workflows/release.yml`: private
  server policy, coordinated versions and interrupted-release handling.

Update installation/configuration/runtime/release/Desktop docs during implementation;
keep `CONTEXT.md` implementation-free. Record implementation follow-ups in `TODO.md`.
