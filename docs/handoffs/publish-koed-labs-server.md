# Handoff: publish Koed server and CLI as `@koed-labs/server`

## Purpose and authorization

Migrate Koed distribution to one public npm installation entrypoint, with configuration-selected service-runtime artifacts and an opt-in Desktop terminal launcher.

This handoff records approved direction and remaining engineering work. It is not authorization to publish npm packages, create credentials, or release artifacts. Producing this handoff does not mean implementation or platform validation has been completed. Finalize and review implementation design and plan before changing product code.

## Confirmed decisions

- Public npm package: **`@koed-labs/server`**. Earlier naming proposals are superseded.
- Primary terminal command: **`koed`**. Do **not** retain a `koed-server` executable alias. Document the command migration and update supported integrations.
- Keep CLI and supervisor together. Service artifacts are provisioned through this package, not separately user-installed npm packages.
- Ship a lightweight npm control plane plus exact-version, target-specific service-runtime archives.
- Split optional local Privacy Filter runtime from base service runtime.
- Desktop privacy runtime is **provisioned on demand**, not bundled by default.
- Desktop offers an opt-in **Install CLI** action, following Paseo's user-triggered pattern. Do not install terminal integration automatically.
- Keep private Desktop workspace identity **`@koed/desktop`**; rename deferred. Product branding, application identity, `Koed.app`, and installer names remain unchanged.
- Keep private `@koed/koed` product release manifest. Broad internal scope migration is out of scope.
- Retain one coordinated product version across npm package, runtime components, standalone distribution, and Desktop.
- **Minor release bump confirmed.** Absence of compatibility executable must be called out in release notes.
- Native Postgres/pgvector, llama-server, and models retain separate provisioning under `KOED_HOME`.
- No backend LLM synthesis or service-requirement changes.

### Engineering assumptions

User authorized reasonable assumptions for Node support and artifact authentication:

- Target **Node 24 LTS** for npm/headless use; declare an appropriate Node 24 engine range after checking dependencies and CI. Existing release CI uses Node 24.13.1. Do not claim other Node majors supported without validation.
- Authenticate artifact metadata binding component, version, platform/architecture, and SHA-256; fail closed on verification failure. Prefer existing trusted-signature/provenance machinery. Key provisioning and CI signing design still need validation; no credentials are authorized by this handoff.
- Desktop's bundled Electron Node runtime needs separate compatibility validation; npm's Node assumption does not establish Electron compatibility.

## Audit baseline and evidence limits

Audit ran against `/Users/jedd/agents/koed`, clean `main`, HEAD `39dd6db1a`. Product/server/Desktop versions were `0.8.1`; latest GitHub release was `v0.8.1`; PR #400 proposed `v0.9.0`. Refresh branch, HEAD, release/PR state, and nested instructions before starting. Preserve unrelated work.

Current implementation:

- `packages/koed-server/package.json` is private `@koed/koed-server`, with `koed-server` bin and private workspace dependency. Its manifest alone is not a complete service distribution.
- Shared staging assembles all service JS and production dependencies. Configuration controls startup, not installed JS composition.
- Desktop stages a co-built workspace runtime, not a published npm artifact.
- Changesets versions private product manifest; custom scripts synchronize product versions. Server and Desktop are ignored by Changesets.
- Release workflow publishes GitHub assets, not npm packages.
- Public npm lookup for `@koed-labs/server` returned E404. This does not prove scope ownership or publishing permission.

### Size findings

Decimal MB:

| Artifact                                                    | Compressed |               Expanded |
| ----------------------------------------------------------- | ---------: | ---------------------: |
| Published v0.8.1 macOS arm64                                |   38.78 MB |      Not measured here |
| Published v0.8.1 Linux x64                                  |  239.25 MB |              443.15 MB |
| Current macOS arm64 assembly                                |   38.33 MB |              126.73 MB |
| Experimental macOS assembly minus privacy-exclusive closure |   18.98 MB | Approximately 65.70 MB |

Privacy-exclusive declared dependency closure measured 31 packages and 61.03 MB expanded on macOS. It includes ONNX, Transformers, tokenizers, sharp/libvips, and associated dependencies. Removing this closure roughly halved compressed macOS payload.

Published Linux archive contains `onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so`, **315,724,552 bytes**, approximately 71% of expanded archive.

These findings justify privacy split, not arbitrary accelerator removal. Preserve current inference behavior and supported execution providers.

Evidence limits:

- Current assembly reused existing compiled outputs; not a fresh-build validation.
- Reduced artifact was a size-only probe with stale manifest/required-file contracts; not runnable distribution.
- Linux measurements came from published artifact inspection report, not local Linux execution.
- Supervisor's declared dependency closure measured 5.08 MB across nine packages; not proof of complete operational control-plane payload.
- Existing assembly passed packaged CLI/PTY checks, and relocated archive help worked outside checkout in a path containing spaces. Full lifecycle, npm installation, Desktop lifecycle, upgrades, and platform matrix were not validated.

Audit temporary artifacts: `/tmp/koed-distribution-audit.1VpG0q`. They may no longer exist; do not make implementation depend on them.

## Distribution architecture

| Component            | Contents                                                                                                                                | Delivery                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| npm control plane    | CLI, supervisor, configuration, installation, diagnostics, complete control-plane dependencies                                          | `@koed-labs/server`                     |
| Base service runtime | API, Worker, MCP Server, Capture Hook, Local AI Runtime entrypoints, embedding-service JS, migrations, prompts, production dependencies | Exact-version target archive            |
| Privacy runtime      | Privacy Filter Service JS and exclusive production dependencies, including required native JS libraries                                 | Exact-version target archive, on demand |
| Native runtime       | Postgres/pgvector, llama-server and related assets                                                                                      | Existing provisioning flows             |
| Models               | Embedding, privacy, other supported model assets                                                                                        | Existing model installation flows       |

Reuse shared assembly for archives, Desktop, and standalone route. Do not invent a second packaging pipeline. Initially retain all non-privacy service composition in base artifact, even where a configuration does not start those services.

Desired npm UX:

```bash
npm install -g @koed-labs/server
koed --help
```

Help must work without service/native/model downloads. Define explicit setup/provisioning commands in design; do not promise that `koed start` silently installs missing dependencies. npm lifecycle scripts must not implicitly download service artifacts or models.

## Configuration-to-runtime requirements

`runtimeMode` and `dependencyMode` are independent switches. Preserve current behavior:

| Configuration                                          | Supervisor starts                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `local-personal` + `bundled-local`, Team off           | API, Worker, Local AI Runtime, Postgres, Embedding Service          |
| Same, Team on                                          | Above plus Privacy Filter Service                                   |
| `local-personal` / `developer` + external dependencies | API, Worker, Local AI Runtime                                       |
| Runtime mode `external` + external dependencies        | API, Worker                                                         |
| Runtime mode `external` + explicit `bundled-local`     | API, Worker, Postgres, Embedding Service; privacy when Team enabled |

External dependency mode requires configured Postgres/pgvector and embedding endpoint, Redis when BullMQ selected, and privacy endpoint/tokens when Team enabled.

Bundled-local defaults to Postgres-backed local queue. External dependency mode defaults to BullMQ unless overridden. Local queue still requires Worker. BullMQ's static imports mean it remains in base dependency graph unless separately justified.

Privacy selection:

- Local Privacy Filter Service required: install matching privacy component and model assets.
- Team disabled: privacy component not required.
- External privacy service selected: local privacy component not required.
- Transition to local privacy: inspect existing state, explicitly provision missing component/models, and report actionable errors before launch.

Evidence anchors: `packages/koed-server/src/config.ts:108–170`, `packages/koed-server/src/start.ts:243–255`, `packages/koed-server/src/start.ts:1156–1249`, `packages/koed-server/src/start.ts:1404–1428`.

## Implementation work

### 1. Package identity and executable

Rename public server workspace identity and update lockfile, dependencies, resolution, staging wrappers, Desktop paths, scripts, tests, and docs. Keep folder names where renaming would create unrelated churn.

Validate final bin path against assembled npm tarball. Update old command references without confusing executable names with internal directories or artifact identities.

### 2. Control-plane payload and security boundaries

Bundle or otherwise fully resolve required private dependencies; no unresolved `workspace:*` references.

Audit every command for DB/MCP/runtime asset dependencies. Basic help, configuration, and provisioning must work before service runtime exists; runtime-dependent commands must report missing components clearly.

Existing standalone launcher sets `KOED_SERVER_PACKAGE_ROOT` and `KOED_JS_RUNTIME_ROOT`; npm launcher needs installation-relative equivalent behavior. Current repository-root inference assumes workspace layout. Packaged source-fallback policy currently hinges on Desktop environment flag; npm needs explicit packaged behavior too.

No accidental checkout fallback, external symlinks, credentials exposure, or diagnostics broadening.

### 3. Shared assembly and privacy dependency ownership

Derive component ownership from complete production dependency graph, including dynamic imports and runtime assets. Do not use measured 31-package list as deletion recipe.

Keep shared dependencies needed by base. Give privacy component explicit, hermetic dependency resolution; no incidental parent `node_modules` lookup. Preserve third-party licences and required native JS files.

Current resolver and package manifest require privacy entry unconditionally. Replace with configuration-aware component contracts. Evidence: `packages/koed-server/src/app-runtime.ts:62–81`, `packages/koed-server/src/package-runtime.ts:42–52`.

### 4. Artifact installation, integrity, and upgrades

Define component manifests binding product version, component identity, target, ABI constraints, supported Node range, required files, and authenticated integrity metadata.

Reuse existing archive installer/provenance machinery where practical. Current checksum-only default is not authenticated origin verification.

Required behavior:

- Verify before activation; stage complete selected component set.
- Atomic activation; no mixed-version base/privacy runtime.
- Failed download or verification leaves working runtime intact.
- Reject incompatible cached artifacts and unsupported targets.
- Accept local artifacts for offline provisioning.
- Preserve downgrade and migration rollback safeguards.
- Define npm upgrade behavior and explicit matching-runtime provisioning.
- Retain compatible prior runtime for supported rollback; do not promise rollback across irreversible migrations.
- Cache cleanup and uninstall preserve User state, models, and active runtime unless explicitly requested otherwise.

### 5. Desktop runtime and on-demand privacy

Desktop bundles base assembled runtime with matching supervisor package. Do not require first-run base JS downloads.

Privacy artifact and models provision on demand when local privacy becomes required. Define consent, progress, cancellation, retry, and offline behavior using existing provisioning patterns. Do not silently weaken privacy or substitute a different service after installation failure.

Preserve lifecycle, API behavior, native provisioning, and packaged source-fallback restrictions.

### 6. Desktop Install CLI integration

Add user-triggered action in Desktop settings. Opening Desktop/settings may inspect status but must not install launcher or modify shell files automatically.

Initial supported targets follow shipped Desktop matrix, currently macOS arm64. Headless Linux support does not imply Linux Desktop feature validation. Native Windows remains out of scope unless separately approved.

Launcher requirements:

- Install `~/.local/bin/koed` on supported POSIX Desktop targets.
- Invoke bundled `@koed-labs/server` with Electron's Node runtime; no external Node/npm required.
- Validate suitable helper executable on macOS to avoid inheriting GUI lifecycle behavior.
- Handle symlinks, spaces, executable permissions, moved/missing app, and updates.
- Obtain explicit consent for shell PATH configuration changes; preserve existing content and avoid duplicate entries.
- Never silently overwrite unrelated executable or npm installation. Detect ownership and present explicit conflict choices.
- Report launcher ownership, target validity, and PATH visibility separately. PATH changes may require new shell.
- Provide safe repair/removal for Koed-owned launcher; never delete unrelated files or shell configuration.
- Define npm/Desktop coexistence, version mismatch, shared `KOED_HOME`, and supervisor ownership. CLI must not silently replace Desktop-managed runtime.

Paseo reference audited at commit `dfb8a1a`: installer creates user-local link, edits supported shell config, and invokes bundled CLI using `ELECTRON_RUN_AS_NODE=1`. Its status/ownership handling is weaker than requirements above; follow interaction pattern, not shortcomings.

Reference paths in upstream `getpaseo/paseo`:

- `packages/desktop/src/integrations/cli-install/install.ts`
- `packages/desktop/src/integrations/cli-install/shell-rc.ts`
- `packages/desktop/bin/paseo`
- `packages/app/src/desktop/components/integrations-section.tsx`

### 7. Versioning and secure release plumbing

Make public package Changesets-managed with public access while preserving coordinated version policy. Confirm assembled manifest version, component versions, Desktop version, standalone metadata, and release notes agree.

Verify npm organisation ownership and permission independently. Select secure CI authentication; actual credentials/publication require separate authorization.

Define retry-safe ordering and promotion:

- Build and validate complete artifacts before release promotion.
- Handle npm publication success followed by GitHub/Desktop failure.
- Detect already-published immutable version and verify expected contents before continuing.
- Define npm dist-tag policy and interrupted-release recovery.
- Never overwrite published npm version.

Preserve standalone route with component-aware manifests and installation. Fix generated release PR sections that combine synchronized versions with stale changelog headings.

### 8. Documentation

Update `/docs` and installation references for npm headless versus Desktop routes, explicit service provisioning, optional privacy, supported targets/Node, offline installation, upgrades/rollback, state-preserving uninstall, removed executable alias, and opt-in Desktop CLI integration.

## Files to inspect

Read `AGENTS.md`, `CONTEXT.md`, `TODO.md`, and applicable nested instructions first.

- `packages/koed-server/package.json` and `packages/koed-server/src/`
- `packages/koed/package.json` and release-version exports
- `packages/app-runtime-stage/`
- `scripts/app-runtime-staging.mjs`
- `scripts/build-koed-server-package.mjs`
- `scripts/privacy-runtime-package-policy.mjs`
- `scripts/terminal-runtime-package-policy.mjs`
- `scripts/provider-runtime-package-policy.mjs`
- `apps/desktop/package.json`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/scripts/prepare-koed-runtime.mjs`
- `apps/desktop/src/koed-server/manager.ts`
- `apps/desktop/src/koed-server/runtime.ts`
- Product release synchronization, notes, metadata, inspection, and validation scripts
- `.changeset/config.json`, `.github/workflows/release.yml`, `.github/workflows/ci.yml`
- `README.md`, `docs/running-koed.md`, `docs/release-versioning.md`, `apps/desktop/README.md`
- Existing script tests and packaged lifecycle smoke tests

## Acceptance criteria

- [ ] Configuration/component ownership and dependency resolution documented and approved.
- [ ] Fresh global install from packed npm tarball outside checkout exposes `koed --help` without downloads.
- [ ] Paths containing spaces and clean environment without checkout fallbacks tested.
- [ ] Base-only Personal setup/start/status/doctor/stop works under isolated `KOED_HOME`.
- [ ] Team local privacy, external privacy, and transition to local privacy tested.
- [ ] Missing/corrupt/wrong-version/wrong-target components fail safely.
- [ ] Privacy behavior and execution providers preserved after split.
- [ ] No unresolved workspace references, external symlinks, or checkout fallback.
- [ ] Complete runtime assets, migrations, prompts, dependencies, and licences included.
- [ ] Native assets/models remain separately provisioned.
- [ ] Supported target/Node matrix declared and validated, including Electron runtime.
- [ ] Offline installation, cancellation/retry, and failed-download recovery tested.
- [ ] Upgrade activation atomic; mixed versions rejected; User state preserved.
- [ ] Desktop bundles base, provisions privacy on demand, and passes packaged lifecycle smoke tests.
- [ ] Install CLI is opt-in, conflict-safe, and uses bundled runtime without system Node.
- [ ] Launcher validity/PATH checks, repair/removal, app relocation, and npm coexistence tested.
- [ ] No `koed-server` alias; integrations/docs and release notes reflect migration.
- [ ] Standalone distribution remains supported.
- [ ] Coordinated minor version and release notes coherent.
- [ ] Publication authentication, artifact authentication, and retry behavior validated without publishing.
- [ ] Applicable formatting, lint, typechecking, build, and packaging checks pass.

## Workflow constraints

No worktrees or branch changes needed to produce this handoff. Implementation must preserve unrelated work and follow repository workflow.

If tied to Linear ticket, assign developer and move ticket to In Progress before implementation. Use PR template, closing keyword, acceptance-criteria accounting, and CI watch rules. Minor bump approval is recorded here; no need to re-ask unless scope or versioning policy changes.

Do not add backend LLM synthesis. Do not compromise runtime/source security boundaries for convenience. Signing/notarization and MCP Inspector/tool-reference work remain separate follow-ups; artifact authentication in this task is not macOS Developer ID signing or notarization.
