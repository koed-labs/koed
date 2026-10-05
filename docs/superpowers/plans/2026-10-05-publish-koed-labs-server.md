# Public Koed Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One implementation worker per task, fresh reviewer after each task, whole-branch review at end. Steps use checkboxes. Read approved spec before executing any task.

**Goal:** Ship code-complete public `@koed-labs/server` control plane, authenticated optional service components, and opt-in Desktop CLI installation without publishing anything.

**Architecture:** Extend existing shared assembly into control-plane, base and hermetic privacy payloads. Effective configuration selects exact-version verified components; shared lifecycle exclusion pins generations and prevents mixed-version activation. Desktop bundles base, explicitly provisions privacy, and installs terminal integration only on request.

**Tech Stack:** TypeScript, Node 24, pnpm 11.1.2, Vitest, Node test runner, Electron, Changesets, GitHub Actions, existing Ed25519 provenance primitives.

**Spec:** `docs/superpowers/specs/2026-10-05-publish-koed-labs-server-design.md`.
**Source requirements:** `docs/handoffs/publish-koed-labs-server.md`.

## Global Constraints

- Branch `feat/publish-koed-labs-server`; design commit `d1c79f177`. Preserve untracked handoff and unrelated changes. No worktree needed for current dedicated branch.
- Refresh HEAD, instructions, release state and PR #400 before implementation/version work. Audit version `0.8.1` does not authorize choosing a stale next version.
- Public package `@koed-labs/server`; primary and sole terminal executable `koed`. No `koed-server` executable alias. Keep internal directory names where changing them adds churn.
- Keep private `@koed/desktop` and `@koed/koed`, `Koed.app`, branding and installer names.
- npm engine `>=24 <25`; existing release CI Node `24.13.1`. Validate Electron embedded Node/ABI separately; do not infer Electron support from npm support.
- Native Postgres/pgvector, llama-server and models stay separately provisioned under `KOED_HOME`. No implicit npm lifecycle/start/help downloads.
- No backend LLM synthesis, new service requirements, arbitrary accelerator/provider deletion, credentials, real npm publication or macOS signing/notarization.
- Official fetched and offline components require authenticated metadata. Absent approved production key/signer means production promotion fails closed, not checksum-only fallback.
- Coordinated minor bump already approved. Explain command migration in release notes. Do not run product versioning merely to choose a version on this branch.
- Read `CONTEXT.md` for domain wording; architecture changes update `/docs`; implementation follow-ups go in `TODO.md`, not glossary.
- TDD for each task: write assertions, record RED for intended reason, minimal implementation, GREEN, applicable checks, explicit-path commit, fresh review. Fix review findings in incremental commits; do not rewrite history for cosmetic cleanup.
- Never mark mocked/platform-unavailable criteria passed. Record exact verification commands/results and external gates.
- Register each new suite with existing required-suite/CI policy in its owning task. After each coherent integrated chunk: applicable formatting/lint/typecheck/tests → fresh review → normal branch push → CI watch. Intermediate pushes may be explicitly incomplete; only final delivery claims code complete. Never push known security defects or failing applicable checks.

## Review Focus

1. Explicit env file has broken syntax or Team configuration differs from `server.json`: fail visibly; never silently provision Personal-only. Task 2.
2. Valid signature binds wrong component/version/target or unapproved runtime ABI: reject before extraction/activation. Task 4.
3. Startup races activation/cleanup after initial process lookup: pin one generation under shared exclusion; never mixed roots or deleted live files. Task 6.
4. Launcher/RC file changes between status and repair/removal: preserve unrelated replacement and report conflict. Task 12.
5. npm candidate exists but Desktop/GitHub completion fails: verify immutable tarball, keep public promotion blocked, resume draft without overwriting version. Task 15.

## Execution and file boundaries

Dependent phases: contracts/assembly (1–3), integrity/lifecycle (4–6), resolver/CLI/npm (7–9), Desktop (10–13), standalone/release/final evidence (14–16). These are reviewable chunks of one delivery, not permission to stop at a partially integrated release.

New focused modules, not unrelated large-file refactors:

| Path                                                                | Responsibility                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/koed-server/src/component-contract.ts`                    | Component/target/runtime/generation types and pure requirements         |
| `packages/koed-server/src/effective-runtime-config.ts`              | Strict effective configuration/environment resolution                   |
| `packages/koed-server/src/component-verification.ts`                | Signed schema, archive and extracted-tree verification                  |
| `packages/koed-server/src/component-trust-roots.ts`                 | Immutable approved public roots; no env/CLI trust injection             |
| `packages/koed-server/src/component-store.ts`                       | Download/offline staging, immutable component and generation records    |
| `packages/koed-server/src/generation-lifecycle.ts`                  | Shared exclusion, live pins, activation, rollback guards and cleanup    |
| `packages/koed-server/src/component-commands.ts`                    | Typed status/install/activate/cleanup handlers                          |
| `scripts/component-assembly.mjs`                                    | Closure projection from shared assembly; no second deploy pipeline      |
| `scripts/build-public-server-package.mjs`                           | Complete packable control plane and installer-relative launcher         |
| `scripts/release-promotion-lib.mjs`                                 | Pure immutable retry/promotion state machine                            |
| `apps/desktop/src/cli-install/launcher.ts`                          | Helper validation, ownership/status, safe launcher mutation             |
| `apps/desktop/src/cli-install/shell-path.ts`                        | Consent-bound atomic managed shell block                                |
| `apps/desktop/src/renderer/views/preferences/InstallCliSection.tsx` | Opt-in terminal integration UI                                          |
| `packages/koed-server/src/component-test-fixtures.ts`               | Test-only ephemeral signed archives/generations; never production trust |

Existing integration boundaries: `packages/koed-server/src/{cli,start,stop,status,app-runtime,paths,runtime-artifact-source,local-privacy-runtime,package-runtime,supervisor-lock,runtime-state}.ts`; `scripts/{app-runtime-staging,koed-server-package-lib,build-koed-server-package,product-release-version-lib,product-release-notes}.mjs`; `apps/desktop/src/{koed-server/manager,koed-server/runtime,ipc/protocol,ipc/commands}.ts`; `apps/desktop/src/preload.cts`; Desktop staging/builder configuration; Changesets and release/CI workflows.

### Cross-task interfaces

Task 2 defines these contracts; later tasks import them rather than redefine names:

```ts
export type ComponentId = "base" | "privacy";
export type ProcessId =
  | "api"
  | "worker"
  | "local-ai-runtime"
  | "postgres"
  | "embedding-service"
  | "privacy-service";
export interface ArtifactTarget {
  platform: "macos" | "linux";
  architecture: "arm64" | "x64";
  libc?: { family: "glibc"; minimumVersion: string };
}
export interface RuntimeIdentity {
  kind: "node" | "electron";
  version: string;
  nodeVersion: string;
  modulesAbi: string;
  napiVersion: number;
  platform: ArtifactTarget["platform"];
  architecture: ArtifactTarget["architecture"];
  libcVersion?: string;
}
export interface RuntimeCompatibility {
  kind: RuntimeIdentity["kind"];
  runtimeRange: string;
  nodeRange: string;
  modulesAbi?: string;
  minimumNapi?: number;
}
export interface ComponentManifest {
  schemaVersion: 1;
  productVersion: string;
  component: ComponentId;
  target: ArtifactTarget;
  runtimes: readonly RuntimeCompatibility[];
  archive: { name: string; bytes: number; sha256: string };
  requiredFiles: readonly string[];
  files: readonly { path: string; sha256: string }[];
}
export interface ComponentSignature {
  schemaVersion: 1;
  keyId: string;
  algorithm: "ed25519";
  signature: string;
}
export interface RuntimeRequirements {
  components: readonly ComponentId[];
  processes: readonly ProcessId[];
  queue: "local" | "bullmq";
  native: readonly ("postgres" | "llama-server")[];
  models: readonly ("embedding" | "privacy")[];
}
export interface RuntimeOwner {
  kind: "cli" | "desktop" | "standalone";
  installationId: string;
}
export interface VerifiedComponent {
  manifest: ComponentManifest;
  root: string;
  manifestDigest: string;
}
export interface VerifiedGeneration {
  id: string;
  productVersion: string;
  base: VerifiedComponent;
  privacy?: VerifiedComponent;
  owner: RuntimeOwner;
}
```

Use `RuntimeCompatibility[]`, not one hardcoded Node range, for artifacts: Node entry declares `>=24 <25`; Electron entry exists only after measured compatibility. Non-Node-API native modules bind actual modules ABI; Node-API modules declare minimum N-API and target native constraints. No fabricated libc floor or Electron major approval.

Task 2 also defines:

```ts
export interface EffectiveRuntimeConfig {
  config: KoedServerConfig;
  environment: NodeJS.ProcessEnv;
  teamEnabled: boolean;
}
export function resolveEffectiveRuntimeConfig(
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  execution: "source" | "packaged"
): EffectiveRuntimeConfig;
export function calculateRuntimeRequirements(
  effective: EffectiveRuntimeConfig
): RuntimeRequirements;
```

### Bundled admission and Desktop authority contracts

Define these contracts in Tasks 4–6 before their consumers. Fetched/offline official archives retain mandatory signature verification. Bundled admission is separate, never a public CLI trust mode:

```ts
export interface TrustedDistribution {
  kind: "desktop" | "standalone";
  productVersion: string;
  installationRoot: string;
  componentDigests: ReadonlyMap<ComponentId, string>;
}
export async function verifyBundledComponent(
  distribution: TrustedDistribution,
  component: ComponentId,
  root: string
): Promise<VerifiedComponent>;
```

Factory for `TrustedDistribution` stays internal to installed distribution bootstrap. Read manifest only relative to bootstrap's canonical installed root; bind manifest/component paths, version, archive/file inventory digests and actual runtime target. No environment, CLI, renderer or caller-provided manifest can create trusted context. Desktop anchor is installer-provided resources and app integrity boundary; standalone anchor is Operator-installed authenticated distribution whose signature is verified before registration. Digests alone do not authenticate downloaded distributions. Unsigned local builder fixtures are explicit test/development artifacts, never official installations. Register verified bundled base through Task 5 immutable generation writer without downloading it. Desktop supplied files remain pinned/immutable through lifecycle ownership; activation never rewrites app resources.

Task 6 creates owner credential contract before startup integration: persisted installation ID plus random capability stored with owner-only permissions in installation-owned state; Desktop main manager issues capability to its child over private inherited IPC/file descriptor, not public argv/environment/renderer payload. Supervisor validates capability against installation registration and binds it to process identity/session; restart renews session while installation ID persists, update invalidates old session after stopping owned services. CLI/standalone authority derives from their registered installation context; supplying an owner label grants nothing. Main-process sender validation precedes all Desktop mutations. Same-OS-account adversarial code can read/alter that account's files: this is cooperative installation isolation, not a security sandbox against same-user compromise. Reject uncertain ownership; test unrelated npm invocation and stale/replayed sessions. Task 10 wires existing manager transport to this defined contract rather than inventing authority late.

## Task 1: Public identity and coordinated version policy

**Files:** Modify `packages/koed-server/package.json`, `apps/desktop/package.json`, `packages/app-runtime-stage/package.json`, `package.json`, `pnpm-lock.yaml`, `.changeset/config.json`, `scripts/product-release-version-lib.mjs`, `scripts/product-release-version-lib.test.mjs`, `scripts/ci-policy.test.mjs`; add `.changeset/public-koed-server.md`.

**Consumes:** Current Changesets private product release manifest.
**Produces:** Workspace `@koed-labs/server`, sole `koed` bin, public publish configuration, fixed coordinated release group.

- [ ] Write RED policy test (use UTF-8 when reading JSON):

  ```js
  test("server is public, singly named and coordinated", () => {
    const server = JSON.parse(
      readFileSync("packages/koed-server/package.json", "utf8")
    );
    const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
    assert.equal(server.name, "@koed-labs/server");
    assert.equal(server.private, false);
    assert.deepEqual(server.bin, { koed: "dist/cli.js" });
    assert.equal(server.engines.node, ">=24 <25");
    assert.equal(server.publishConfig.access, "public");
    assert.ok(
      config.fixed.some(
        (group) =>
          group.includes("@koed/koed") && group.includes("@koed-labs/server")
      )
    );
    assert.ok(!config.ignore.includes("@koed-labs/server"));
  });
  ```

- [ ] Run `node --test scripts/product-release-version-lib.test.mjs scripts/ci-policy.test.mjs`; record identity assertion failure, not incidental test setup failure.
- [ ] Rename package references/workspace filters and executable usages, not folders/branding. Set `engines.node`, `publishConfig.access`, one bin and public manifest. Configure fixed group `["@koed/koed", "@koed-labs/server"]`, keep private product versioning enabled, server out of ignore/internal list. `assertChangesetReleasePolicy()` explicitly classifies public server and validates fixed group. Version synchronization asserts fixed-group equality, never applies another bump. Dry-run Changesets against copied workspace fixture with product-only, server-only and combined minor changesets; all produce one identical next version. Add minor changeset naming both release units; explain removed alias and new provisioning. Do not consume changesets or publish source workspace.

  ```json
  { "fixed": [["@koed/koed", "@koed-labs/server"]], "access": "public" }
  ```

- [ ] Run focused tests, `pnpm install --lockfile-only`, `pnpm release:check`, `pnpm --filter @koed-labs/server typecheck`; update old filter expectations in tests. Ensure ordinary workspace tarball cannot bypass assembled-artifact publish workflow; Task 9 supplies tested assembly route.
- [ ] Format touched files, `git diff --check`; commit explicit files with `feat: establish public koed server identity`. Fresh reviewer checks version authority, no old executable alias, no private identity rename. Resolve findings before Task 2.

## Task 2: Effective configuration, strict input and component contracts

**Files:** Create `packages/koed-server/src/component-contract.ts`, `packages/koed-server/src/component-contract.test.ts`, `packages/koed-server/src/effective-runtime-config.ts`, `packages/koed-server/src/effective-runtime-config.test.ts`; modify `packages/koed-server/src/{config,env-file}.ts` and paired tests; update `docs/configuration.md`.

**Consumes:** `KoedServerConfig`, `KoedServerPaths`, existing env/config precedence, Team detector and work-queue behavior in `packages/koed-server/src/start.ts`.
**Produces:** Cross-task types and effective requirements functions above; no change in supported service requirements.

- [ ] Write parameterized RED matrix test using direct typed input:

  ```ts
  it("external runtime plus bundled-local Team requires local privacy", () => {
    const requirements = calculateRuntimeRequirements({
      config: {
        ...defaultKoedServerConfig,
        runtimeMode: "external",
        dependencyMode: "bundled-local"
      },
      environment: {},
      teamEnabled: true
    });
    expect(requirements.components).toEqual(["base", "privacy"]);
    expect(requirements.processes).toEqual([
      "api",
      "worker",
      "postgres",
      "embedding-service",
      "privacy-service"
    ]);
    expect(requirements.queue).toBe("local");
  });
  ```

  Add local-personal/developer/external × external/bundled-local × Team; valid queue overrides; external DB/embedding/Redis/privacy requirements preserved. Strict parser test: `parseEnvFile("TEAM_ENABLED='unterminated", { strict: true, source: "explicit.env" })` throws naming source; valid quoted values, comments, CRLF, empty values and supported existing syntax remain accepted. Explicit missing env path fails; malformed/non-object server JSON fails packaged resolution. Test environment > explicit env > server config, using existing exact Team keys from source rather than inventing `TEAM_ENABLED` as runtime key.

- [ ] Run `pnpm --filter @koed-labs/server exec vitest run src/component-contract.test.ts src/effective-runtime-config.test.ts src/config.test.ts src/env-file.test.ts`; record RED.
- [ ] Implement strict env parsing as optional source-compatible policy, actionable supplied-file failures, config shape/value validation and pure calculation. Preserve source default discovery only in source execution. Derive Team from existing combined environment rules; centralize queue decision presently split across startup. Native requirements include llama-server when embedding provisioning needs it, not a new process named embedding native runtime.

  ```ts
  const localPrivacy =
    effective.config.dependencyMode === "bundled-local" &&
    effective.teamEnabled;
  const components: ComponentId[] = localPrivacy
    ? ["base", "privacy"]
    : ["base"];
  const processes: ProcessId[] = ["api", "worker"];
  if (effective.config.runtimeMode !== "external")
    processes.push("local-ai-runtime");
  if (effective.config.dependencyMode === "bundled-local") {
    processes.push("postgres", "embedding-service");
    if (localPrivacy) processes.push("privacy-service");
  }
  ```

- [ ] Run GREEN command, server typecheck and source regression tests. Document effective precedence, malformed input behavior, queue defaults and privacy selection. No launch integration until Task 7.
- [ ] Commit `feat: define effective runtime component requirements`; fresh review checks no silent Team downgrade or new service requirement.

## Task 3: Hermetic component assembly from shared production graph

**Files:** Create `scripts/component-assembly.mjs`, `scripts/component-assembly.test.mjs`; modify `scripts/app-runtime-staging.mjs`, `scripts/app-runtime-staging.test.mjs`, `scripts/privacy-runtime-package-policy.mjs`, `scripts/privacy-runtime-package-policy.test.mjs`, provider/terminal policies and paired tests only where graph ownership requires; update `docs/running-koed.md`.

**Consumes:** Existing `stageSharedAppRuntime()` production deploy and target policies.
**Produces:** `stageRuntimeComponents({ repoRoot, outputDir, platform, architecture }): Promise<{ baseRoot: string; privacyRoot: string; baseRequired: string[]; privacyRequired: string[] }>`; self-contained trees and licence inventories.

- [ ] Write RED fixture graph test with base-only, shared and privacy-exclusive packages, dynamic import, native-loader file and prompt/migration assets. Fixture executable privacy entry imports its dependencies and exits; no service startup on import. Spawn in relocated directory with no parent `node_modules`, unset `NODE_PATH`, assert `child.status === 0` and expected stdout. An exception-only assertion around `spawnSync` is insufficient.

  ```js
  const child = spawnSync(process.execPath, [privacyFixtureEntry], {
    cwd: isolatedDirectory,
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /privacy-closure-ok/);
  assert.ok(
    !existsSync(resolve(baseRoot, "privacy-service", "dist", "index.js"))
  );
  ```

  Define fixture entry/isolated paths inside each test using `mkdtempSync` and explicit fixture package manifests. Assert shared package still in base, duplicated in privacy if needed, every notice retained, no external/escaping symlink and unchanged provider/native target contract.

- [ ] Run `node --test scripts/component-assembly.test.mjs scripts/app-runtime-staging.test.mjs scripts/privacy-runtime-package-policy.test.mjs scripts/provider-runtime-package-policy.test.mjs scripts/terminal-runtime-package-policy.test.mjs`; record RED.
- [ ] Implement one shared deploy plus closure projection. Traverse actual production manifests and known runtime edges; generate inventory of unresolved dynamic imports/assets and reject incomplete ownership. Reconcile package wrappers/exports and scoped nested dependency resolution, not merely top-level package names. Duplicate shared privacy dependencies for hermetic isolation. Base removes only packages with no base reachability; BullMQ retained. Apply existing native target pruning and provider policy, never remove CUDA based on size probe.

  ```js
  const privacy = dependencyClosure(graph, privacyEntrypointRoots);
  const base = dependencyClosure(graph, baseEntrypointRoots);
  for (const packageId of base) copyPackage(packageId, baseRoot);
  for (const packageId of privacy) copyPackage(packageId, privacyRoot);
  ```

  Define these helpers locally in `scripts/component-assembly.mjs`, with cycle-safe identity using resolved package location/version; they are not pre-existing APIs.

- [ ] Run GREEN tests and fresh `pnpm build`; assemble real target trees and inspect migrations/prompts/ONNX/sharp/argon2/node-pty/licences. Do not yet switch Desktop or standalone consumer to unintegrated component resolver.
- [ ] Commit `feat: assemble hermetic base and privacy components`; fresh dependency/security review checks runtime graph evidence, not 31-package deletion recipe. Document ownership and target policy.

## Task 4: Signed manifest, trust roots and archive/tree verification

**Files:** Create `packages/koed-server/src/component-verification.ts`, `packages/koed-server/src/component-verification.test.ts`, `packages/koed-server/src/component-trust-roots.ts`, `packages/koed-server/src/component-test-fixtures.ts`; modify `scripts/koed-server-package-lib.mjs`, `scripts/koed-server-package-lib.test.mjs` to emit matching canonical component schema.

**Consumes:** Task 2 contracts; existing Ed25519 provenance, checksum and bounded extraction primitives.
**Produces:** Internal testable `verifyComponent(input: ComponentVerificationInput): Promise<ComponentManifest>` and `verifyExtractedComponent(root: string, manifest: ComponentManifest): Promise<void>`.

`ComponentVerificationInput` fields: `manifestBytes: Buffer`, `signature: ComponentSignature`, `archivePath: string`, `expectedComponent: ComponentId`, `expectedVersion: string`, `target: ArtifactTarget`, `runtime: RuntimeIdentity`, `trustedKeys: ReadonlyMap<string, string>`. Public callers always supply `productionComponentTrustRoots`; no CLI/env key option. Empty unapproved map fails closed.

Test-only fixture API:

```ts
export async function signedComponentFixture(
  overrides: Partial<ComponentManifest> = {}
): Promise<{
  input: ComponentVerificationInput;
  root: string;
  dispose(): void;
}>;
```

Fixture creates temporary tiny tar archive/required files and ephemeral Ed25519 key via `generateKeyPairSync`, signs canonical bytes, returns matching verification input and removes owned temp directory on disposal. Exclude fixture module from public tarball/build payload.

- [ ] Write RED using real test signature:

  ```ts
  it("rejects a valid signature for the wrong component", async () => {
    const fixture = await signedComponentFixture({ component: "privacy" });
    try {
      await expect(
        verifyComponent({ ...fixture.input, expectedComponent: "base" })
      ).rejects.toThrow("component mismatch");
    } finally {
      fixture.dispose();
    }
  });
  ```

  Add signed wrong version/target, unsupported Node/Electron/module ABI/N-API/libc, unknown key, noncanonical/duplicate metadata, unsigned placeholder, size/hash mismatch, traversal/absolute paths/hardlinks/escaping symlinks, duplicate tar entries, size limits, required-file corruption and unsupported targets. Verify rejection precedes activation.

- [ ] Run `pnpm --filter @koed-labs/server exec vitest run src/component-verification.test.ts && node --test scripts/koed-server-package-lib.test.mjs`; record RED.
- [ ] Implement schema validation and version/range checks without loosening syntax; reuse existing range dependency or add narrowly justified production dependency if none exists. Signature domain is `koed-component-manifest-v1\n` + canonical UTF-8 bytes. Unknown key or unsupported algorithm fails before extraction. Archive hash/length validated before extraction, safe paths during extraction, all manifest file hashes/required files after extraction. Validate actual runtime identity, not claimed environment values.

  ```ts
  if (!input.trustedKeys.has(input.signature.keyId))
    throw new Error("untrusted component signing key");
  if (manifest.component !== input.expectedComponent)
    throw new Error("component mismatch");
  if (manifest.productVersion !== input.expectedVersion)
    throw new Error("product version mismatch");
  ```

  Production trust roots contain no fixture key and no guessed key; empty roots deliberately block official install/promotion until Operator infrastructure gate resolved.

- [ ] Run GREEN tests, server typecheck/build; test signing/verification interoperability between JS builder and TS verifier using same fixtures.
- [ ] Commit `feat: verify authenticated runtime component manifests`; fresh security reviewer checks offline/auth distinction and every bypass.

## Task 5: Immutable component and generation staging

**Files:** Create `packages/koed-server/src/component-store.ts`, `packages/koed-server/src/component-store.test.ts`; update `packages/koed-server/src/paths.ts` and paired tests for store layout; use download/provenance utilities from `packages/koed-server/src/package-runtime.ts` without activating new legacy policy.

**Consumes:** Task 4 verification; Task 2 generation types.
**Produces:** `stageComponent(paths: KoedServerPaths, input: ComponentSource, context: ComponentInstallContext): Promise<VerifiedComponent>`; `stageGeneration(paths: KoedServerPaths, input: { base: VerifiedComponent; privacy?: VerifiedComponent; owner: RuntimeOwner }): Promise<VerifiedGeneration>`; `readStagedGeneration(paths: KoedServerPaths, id: string): Promise<VerifiedGeneration>`.

`ComponentSource` is discriminated `{ kind: "offline"; archivePath: string; manifestPath: string; signaturePath: string }` or `{ kind: "remote"; archiveUrl: string; manifestUrl: string; signatureUrl: string }`. `ComponentInstallContext` has `expectedComponent`, `expectedVersion`, `target`, `runtime`, `signal?: AbortSignal`, `progress?: (event: { phase: string; transferredBytes: number; totalBytes?: number }) => void`; production roots internal, fetch/extractor test injection internal only.

- [ ] Write RED fixture tests for idempotent digest-addressed install, same version/different digest conflict, cancellation, malformed download, corrupt cache, offline missing metadata with network spy asserting zero calls and mixed-version/target rejection.

  ```ts
  it("rejects mixed generation versions before creating current", async () => {
    const base = await signedComponentFixture({ productVersion: "0.9.0" });
    const privacy = await signedComponentFixture({
      component: "privacy",
      productVersion: "0.9.1"
    });
    // Verify/extract each through internal fixture-key test adapter, never public trust injection.
    const staged = await stageTestFixtureComponents(base, privacy);
    await expect(
      stageGeneration(staged.paths, {
        base: staged.base,
        privacy: staged.privacy,
        owner: staged.owner
      })
    ).rejects.toThrow("mixed component versions");
  });
  ```

  Define `stageTestFixtureComponents` in test support to create isolated `KoedServerPaths` using existing path helper and Task 4 fixture-key internal adapter; cleanup all fixtures via `afterEach`. No unchecked `VerifiedComponent` cast substitutes for verification.

- [ ] Run `pnpm --filter @koed-labs/server exec vitest run src/component-store.test.ts src/paths.test.ts`; record RED.
- [ ] Implement temp downloads/staging under `KOED_HOME` with bounded streaming, cancellation and retries. Digest-addressed immutable directories plus version/target metadata; compare existing record/content rather than delete existing version first. Install lock guards conflicting writes; pointer untouched. Recheck cache bytes/signatures before reuse. Rename only complete verified staged tree, ensure temp files removed on error. Generation digest binds exact verified roots, owner and product version; base/privacy target must agree. Reject unsupported protocols and unsafe path inputs.

  ```ts
  if (
    input.privacy &&
    input.base.manifest.productVersion !== input.privacy.manifest.productVersion
  )
    throw new Error("mixed component versions");
  // Same check for platform, architecture, libc and approved runtime compatibility.
  ```

- [ ] Run GREEN tests, server typecheck; preserve active pointer bytes in every failure test. Retain matching previous generation, no cleanup yet.
- [ ] Commit `feat: stage immutable runtime component generations`; fresh review checks downloaded bytes never execute before authentication and active directory never deleted.

## Task 6: Lifecycle exclusion, live generation pins, rollback and ownership

**Files:** Create `packages/koed-server/src/generation-lifecycle.ts`, `packages/koed-server/src/generation-lifecycle.test.ts`; modify `packages/koed-server/src/{supervisor-lock,runtime-state}.ts` and paired tests; update `docs/running-koed.md`.

**Consumes:** Task 5 store and existing migration compatibility guards.
**Produces:** `pinGenerationForStart(paths: KoedServerPaths, requester: RuntimeOwner): Promise<{ generation: VerifiedGeneration; release(): Promise<void> }>`; `activateGeneration(paths: KoedServerPaths, id: string, requester: RuntimeOwner): Promise<VerifiedGeneration>`; `cleanupGenerations(paths: KoedServerPaths, retain: number, requester: RuntimeOwner): Promise<string[]>`.

Owner context is generated by installed control-plane/validated Desktop manager channel, not CLI payload. Runtime state records generation ID, process identity/start identity, owner and pin token. One lock order: lifecycle exclusion → store lock → supervisor state; no operation may acquire reverse order.

- [ ] Write RED with deterministic barriers, not timer guesses: pause startup while holding exclusion immediately before pin persistence; start activation/cleanup; release startup barrier. Activation fails or waits then rejects pin; cleanup retains pinned files. Spawn child processes to test real lock exclusivity as well as mocked unit barriers.

  ```ts
  const pin = await pinGenerationForStart(paths, cliOwner);
  await expect(activateGeneration(paths, nextId, cliOwner)).rejects.toThrow(
    /running|pinned/
  );
  expect((await readCurrentGeneration(paths)).id).toBe(pin.generation.id);
  await pin.release();
  ```

  Define `readCurrentGeneration(paths: KoedServerPaths): Promise<VerifiedGeneration>` in lifecycle module. Add PID reuse/uncertain liveness, stale pin, mismatched installation owner, Desktop/npm coexistence, interrupted pointer swap, downgrade with `allowsRollback: false` and cleanup preserving active/models/state.

- [ ] Run `pnpm --filter @koed-labs/server exec vitest run src/generation-lifecycle.test.ts src/supervisor-lock.test.ts`; record RED.
- [ ] Implement persistent exclusive locking shared by startup/activation/cleanup; owner check and generation verification under lock; startup pins before release, service lifetime holds pin, stop/error releases only matching token. Check actual process identity/liveness; uncertainty rejects mutation. Atomic current pointer binds whole generation; refuse running activation. Preserve existing migration journal/version downgrade policy. Routine cleanup deletes only verified inactive unreferenced store entries and never User files/models/active runtime.

  ```ts
  if (hasLiveOrUncertainPins(state))
    throw new Error("runtime generation is running or pinned");
  if (!sameOwner(current.owner, requester))
    throw new Error("runtime owner mismatch");
  assertMigrationCompatible(current, candidate);
  await replaceCurrentPointerAtomically(candidate.id);
  ```

  Helpers are module-local implementations tested above; reuse current package downgrade logic rather than inventing migration rollback.

- [ ] Run GREEN tests/typecheck. Document stale lock handling, stopped activation, rollback limit and state-preserving cleanup. Exclusion protocol is ready for integration next task.
- [ ] Commit `feat: serialize verified runtime activation and ownership`; fresh concurrency/security reviewer checks no check-then-switch race.

## Task 7: Trusted service resolver and startup integration

**Files:** Modify `packages/koed-server/src/{app-runtime,runtime-artifact-source,paths,local-privacy-runtime,start,stop,status}.ts`, focused paired tests; update `docs/running-koed.md` and `docs/configuration.md`.

**Consumes:** Tasks 2, 4–6.
**Produces:** `resolveKoedAppRuntime(paths, environment, exists?, selection?: VerifiedGeneration, requirements?: RuntimeRequirements): KoedAppRuntime` with optional privacy entry; async launch callers first load/pin verified selection. Existing source callers remain source-mode tested. `KOED_SERVER_PACKAGE_ROOT` is control-plane root only.

- [ ] Write RED packaged bypass tests for every existing env override/legacy lookup: `KOED_JS_RUNTIME_ROOT`, `KOED_REPO_ROOT`, `KOED_PACKAGED_RESOURCES_PATH`, `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK`, old `runtime/koed-runtime`, old package current, repository sibling runtime. Without verified selection, service launch reports missing authenticated base, not silently executes compiled JS. Base-only Personal has no privacy missing-file error.

  ```ts
  expect(() =>
    resolveKoedAppRuntime(paths, {
      KOED_PACKAGED_EXECUTION: "1",
      KOED_SERVER_PACKAGE_ROOT: "/tmp/control",
      KOED_JS_RUNTIME_ROOT: "/tmp/untrusted"
    })
  ).toThrow(/unsupported override|verified generation/);
  ```

  Start tests read effective configuration first, pin generation before service resolution/spawn, refuse mismatched control-plane version, release pin on startup failure and stop, preserve no-download start behavior. Update MCP/Capture Hook resolver callers using exact selected roots.

- [ ] Run `pnpm --filter @koed-labs/server exec vitest run src/app-runtime.test.ts src/paths.test.ts src/local-privacy-runtime.test.ts src/start.test.ts src/stop.test.ts src/status.test.ts`; record RED.
- [ ] Implement resolver using `selection.base.root` and `selection.privacy?.root`; privacy required files checked only when Task 2 requires privacy. Move startup validation after effective configuration resolution; integrate exclusion/pin into actual supervisor start/stop lifetime. Packaged roots never inferred from repository or caller-controlled runtime env. Source overrides allowed only explicit source execution path. Status can explain missing components without service import or pinning; mutation needs owner/version checks. Handle all resolver call sites, including diagnostics, models, MCP and Capture Hook integration.

  ```ts
  const effective = resolveEffectiveRuntimeConfig(
    paths,
    environment,
    execution
  );
  const required = calculateRuntimeRequirements(effective);
  const pinned = await pinGenerationForStart(paths, trustedOwner);
  const runtime = resolveKoedAppRuntime(
    paths,
    effective.environment,
    existsSync,
    pinned.generation,
    required
  );
  ```

- [ ] Run GREEN tests/server typecheck/build and lifecycle regressions. Missing native/model assets remain separately actionable; configuration process ordering unchanged.
- [ ] Commit `fix: resolve services only from pinned trusted components`; fresh security reviewer checks transitive paths and no arbitrary compiled-JS escape.

## Task 8: Explicit components CLI and lazy command dispatch

**Files:** Create `packages/koed-server/src/component-commands.ts`, `packages/koed-server/src/component-commands.test.ts`; modify `packages/koed-server/src/cli.ts`, `packages/koed-server/src/cli.test.ts`; update `docs/running-koed.md`.

**Consumes:** Effective requirements, verifier/store/lifecycle.
**Produces:** `components status|install|activate|cleanup --json` and lazy service command imports; existing `runtime install` stays native.

Define `ComponentCommandContext` with `paths`, `controlPlaneVersion`, `target`, `runtime`, trusted `owner` and optional signal/progress, generated by launcher/server context; no public owner/trust flag. Export `runComponentStatus(context): Promise<ComponentStatus>`; `runComponentInstall(context, options: { component: ComponentId; version?: string; source?: ComponentSource; stageOnly?: boolean }): Promise<{ state: "staged" | "active"; generationId?: string }>`; `runComponentActivate(context, version: string): Promise<VerifiedGeneration>`; `runComponentCleanup(context): Promise<string[]>`.

- [ ] Write RED `runKoedServerCli` tests: help/config/native/model status run without service modules; service command gives provisioning error not `ERR_MODULE_NOT_FOUND`; no install/start implicit downloads. Test all status categories, offline archive+manifest+signature path completeness, exact-version network source, other-version staging, activation mismatch, running install stages only and requires explicit stopped activate.

  ```ts
  const result = await runComponentInstall(context, {
    component: "base",
    version: "0.9.1",
    source
  });
  expect(result.state).toBe("staged");
  await expect(
    runComponentActivate({ ...context, controlPlaneVersion: "0.9.0" }, "0.9.1")
  ).rejects.toThrow(/matching control plane/);
  ```

  Supply `context`/`source` through Task 4–6 isolated fixture setup; use internal test roots adapter, not production public trust override.

- [ ] Run `pnpm --filter @koed-labs/server exec vitest run src/component-commands.test.ts src/cli.test.ts`; record RED.
- [ ] Implement strict option validation and structured actionable errors. Current version install activates only complete required component set while stopped, otherwise stages with explicit next command. Different `--version` always stage-only; matching older control-plane invocation required for rollback activation. Runtime/native/model provisioning unchanged. Dynamic import service modules after selected command/requirements; preserve `KoedServerCliDependencies` injection and type-only imports. Audit every eager transitive DB/MCP import, not just `start`.

  ```ts
  if (command === "--help" || command === "help") return printHelp();
  if (command === "components") {
    const handlers = await import("./component-commands.js");
    return dispatchComponentCommand(handlers, args);
  }
  ```

  Keep helpers local to CLI or defined dedicated dispatcher; retain current entrypoint/export semantics.

- [ ] Run GREEN tests/server build/typecheck, actual CLI help with empty isolated home. Document Node/npm install followed by explicit components/native/models setup, offline inputs, upgrades and rollback.
- [ ] Commit `feat: expose explicit runtime component provisioning`; fresh review checks help truly component-free and no source/key/owner flags leak.

## Task 9: Pack and test complete npm control plane

**Files:** Create `scripts/build-public-server-package.mjs`, `scripts/build-public-server-package.test.mjs`, `scripts/packed-control-plane.test.mjs`; modify `packages/koed-server/package.json`, `package.json`, shared staging helpers as needed; update `README.md`, `docs/running-koed.md`.

**Consumes:** Task 1 identity, Task 8 CLI, shared staging production control dependency graph.
**Produces:** Packable assembled directory/tarball with private control dependencies fully resolved, installer-relative `koed` launcher, no base/privacy payload downloads or service graph.

- [ ] Write RED npm-pack inspection/global-install fixture test: create clean prefix/path containing spaces, install packed tarball with registry/network disabled, cwd outside checkout, env without `NODE_PATH`/repo flags, invoke actual installed `koed --help` executable (not only `node dist/cli.js`). Count network requests and assert zero. Inspect tarball manifest/bin/dependency tree/licences for unresolved `workspace:*`, checkout `file:`, escaping/external symlinks, secrets and `koed-server` alias.

  ```js
  const run = spawnSync(resolve(prefix, "bin", "koed"), ["--help"], {
    cwd: emptyDirectory,
    env: cleanEnvironment,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Usage: koed /);
  assert.equal(networkRequests.length, 0);
  ```

  Define prefix/empty directory and clean env in test with `mkdtempSync`; use real `npm install --global --prefix ... <tarball>` local command under Node 24. Bundle dependencies or install from test-seeded offline npm cache; do not mistake registry resolution for permitted service download. Test `runtime`/`models` status and config without components; unsupported Node reports engine/runtime error.

- [ ] Run `node --test scripts/build-public-server-package.test.mjs scripts/packed-control-plane.test.mjs`; record RED.
- [ ] Implement assembled public manifest and full control-plane closure, bundling private modules or staging resolved code inside package. Dist launcher discovers own root using `import.meta.url`, sets packaged mode, clears/rejects unsafe execution overrides, delegates CLI. Exclude service JS, test keys, source paths and test helpers. No npm lifecycle downloader. Preserve required control-native files such as terminal dependencies only when command audit requires them; include licence notices. Route real publish workflow through inspected packed tarball, not raw workspace.

  ```js
  const manifest = {
    ...sourceManifest,
    name: "@koed-labs/server",
    private: false,
    engines: { node: ">=24 <25" },
    bin: { koed: "bin/koed.js" },
    publishConfig: { access: "public" },
    files: ["bin", "dist", "vendor", "LICENSE", "third-party-notices.json"]
  };
  ```

  Final bin path may differ from source workspace; inspect tarball proves assembled path exists/executable.

- [ ] Run GREEN under Node 24, targeted lint/format/server build. Global installed help outside checkout is mandatory local evidence, not a mocked pass.
- [ ] Commit `feat: assemble independently installable public control plane`; fresh reviewer inspects tarball and install logs, licences and graph completeness.

## Task 10: Desktop trusted bundled base and optional component plumbing

**Files:** Modify `apps/desktop/scripts/prepare-koed-runtime.mjs`, `apps/desktop/electron-builder.yml`, `apps/desktop/src/koed-server/runtime.ts`, `apps/desktop/src/koed-server/runtime.test.ts`, `apps/desktop/src/koed-server/manager.ts`, `apps/desktop/src/koed-server/manager.test.ts`; update `apps/desktop/README.md`.

**Consumes:** Shared base assembly, authenticated store and lifecycle, assembled control plane.
**Produces:** Trusted installed Desktop distribution binding base digest/version and private installation owner; privacy optional until required; explicit manager-owned activation channel.

- [ ] Write RED packaged manager tests: base bundled and no base download; Personal setup no privacy file/model requirement; env Desktop `KOED_SERVER_CLI`/`KOED_NODE_COMMAND` overrides rejected packaged; altered bundled digest fails; signed privacy wrong Desktop version blocks Team start; npm caller cannot rebind Desktop owner. Verify packaged paths use staged `@koed-labs/server`, private Desktop identity untouched.
- [ ] Run `pnpm --filter @koed/desktop exec vitest run src/koed-server/runtime.test.ts src/koed-server/manager.test.ts`; record RED.
- [ ] Consume Task 3 base/Task 9 control plane in Desktop preparation, remove unconditional privacy required-file/builder inclusion. Package distribution manifest binding base/control-plane digests, verify before execution. Manager binds installation identity through existing validated private process channel; add dedicated manager-owned capability/channel state if current contract lacks one. Never trust public `--owner desktop`, renderer owner fields or environment owner claims. Stop owned services under shared exclusion before rebind/update; provision matching privacy when Team requires it. Preserve existing native/service lifecycle behavior.

  ```ts
  if (
    privacy &&
    privacy.manifest.productVersion !== bundledBase.manifest.productVersion
  )
    throw new Error("Desktop privacy component version mismatch");
  // Owner and bundled base identity originate in main-process validated context, not renderer input.
  ```

- [ ] Run GREEN/Desktop typecheck/build; measure actual Electron runtime version, Node modules ABI, N-API and RunAsNode fuse from built target. Populate artifact compatibility only for actually tested combinations; unsupported identity blocks launch rather than assumes Node 24.
- [ ] Commit `feat: bind Desktop to base-only verified runtime`; fresh security/lifecycle review. Packaged target validation remains named gate if unavailable.

## Task 11: Desktop privacy consent/progress/cancel/retry/offline UX

**Files:** Modify `apps/desktop/src/{ipc/protocol,ipc/commands,koed-server/manager}.ts` and tests, `apps/desktop/src/preload.cts`, existing setup/provisioning renderer views found through manager progress consumers; update `apps/desktop/README.md`, `docs/configuration.md`.

**Consumes:** Task 10 manager authority; Task 5 download/cancellation; existing setup-progress UI/IPC.
**Produces:** Validated `components_status`, `components_install`, `components_cancel` IPC; install request only `component: "privacy"`, consent, optional three local file paths; no owner/key/runtime-root fields. Progress includes requestId, phase, bytes, optional total.

- [ ] Write RED sender/args tests and renderer tests: opening settings/setup only inspects; download requires explicit consent after size/destination display, unknown size labeled; cancellation tied to same request/sender; offline selection no fetch; retry works; failure never disables privacy or changes endpoint. Team local transition checks component/model; external privacy avoids local installation; Personal needs neither. Persist caches on switching away.

  ```ts
  await expect(
    managerInstallPrivacy({ component: "privacy", consent: false })
  ).rejects.toThrow(/consent/);
  expect(fetchSpy).not.toHaveBeenCalled();
  ```

  `managerInstallPrivacy` is a test-bound invocation of new manager IPC handler, using existing manager fixture setup. Add consent enforcement in main process, not UI-only boolean convention.

- [ ] Run `pnpm --filter @koed/desktop exec vitest run src/koed-server/manager.test.ts src/ipc/commands.test.ts` and exact renderer suite selected during test creation; record RED.
- [ ] Implement existing renderer → preload → sender-validated IPC → manager → bundled JSON CLI path. UI explicitly approves plan once, shows separate runtime/model phases, cancels with AbortSignal and leaves active generation intact. File selection uses native dialog/main-process paths and validates full signed input set. Manager blocks local Team launch until verified privacy/model ready; explicit stop/activate/restart respects Task 6/10 ownership. Do not add new service selection semantics.

  ```ts
  if (!request.consent)
    throw new Error("Privacy provisioning requires explicit consent");
  const controller = new AbortController();
  requests.set(requestId, { senderId, controller });
  // Pass signal/progress to verified installer; clear matching request in finally.
  ```

- [ ] Run GREEN/Desktop typecheck/build. Document offline/cancellation/progress and state preservation.
- [ ] Commit `feat: provision local Desktop privacy with explicit consent`; fresh review checks sender capability, safe transitions and failure behavior.

## Task 12: Owned launcher, helper validation and safe PATH blocks

**Files:** Create `apps/desktop/src/cli-install/{launcher,shell-path}.ts` and paired tests; modify `apps/desktop/src/koed-server/runtime.ts` and tests for shared helper probe only where appropriate; update `docs/running-koed.md`.

**Consumes:** Trusted Desktop app/base/control-plane identity; no system Node/npm prerequisite.
**Produces:** `inspectLauncher(input: LauncherInput): Promise<LauncherStatus>`; `installLauncher(input: LauncherMutation): Promise<LauncherStatus>`; `repairLauncher(input: LauncherMutation): Promise<LauncherStatus>`; `removeLauncher(input: LauncherMutation): Promise<LauncherStatus>`; `updateManagedPathBlock(input: ShellPathMutation): Promise<void>`.

`LauncherInput`: destination, trusted appPath, expected product version, current process PATH. `LauncherStatus`: ownership `absent|koed|unrelated|changed`, target `valid|missing|invalid`, helper `supported|unsupported`, version and pathVisible independent. Mutation adds explicit consent and inspected fingerprint; main process selects app/helper, renderer never supplies executable. Shell mutation binds supported shell/rcPath/operation/consent and inspected fingerprint.

- [ ] Write RED temp-filesystem tests: install in spaces/symlinks, executable permissions, missing/moved app repair, same-path update, unrelated npm binary conflict, alternate destination, changed file/symlink after inspection, helper unsupported and no GUI/system Node fallback. RC tests exact managed block idempotence, preservation of unrelated/edited block, symlink RC rejection, unsupported shell, cancellation/no-consent zero writes.

  ```ts
  const observed = await inspectLauncher(input);
  writeFileSync(input.destination, "#!/bin/sh\necho unrelated\n");
  await expect(
    repairLauncher({ ...input, observed, consent: true })
  ).rejects.toThrow(/conflict/);
  expect(readFileSync(input.destination, "utf8")).toContain("unrelated");
  ```

- [ ] Run `pnpm --filter @koed/desktop exec vitest run src/cli-install/launcher.test.ts src/cli-install/shell-path.test.ts src/koed-server/runtime.test.ts`; record RED.
- [ ] Implement macOS arm64-only helper resolution/probe: actual helper executable must honor `ELECTRON_RUN_AS_NODE=1` and report expected Node identity without starting GUI. Unsupported probe disables feature. Shell launcher safely quotes canonical trusted paths, has versioned ownership marker/content hash and no shell interpolation of arbitrary data. Validate target/executable and bound package entry; updates retain path binding, relocation needs repair.

  ```sh
  #!/bin/sh
  # koed-desktop-launcher:v1
  export ELECTRON_RUN_AS_NODE=1
  exec '/validated/app helper path' '/validated/control-plane/bin/koed.js' "$@"
  ```

  Generated paths must use tested shell escaping; sample is template, not hardcoded production path. Use safe no-follow creation/link operations and fingerprints at mutation time. Do not claim atomic rename plus earlier `lstat` eliminates races: ensure unrelated replacements cannot be overwritten; if filesystem primitives cannot guarantee this for repair, refuse automatic replace and require explicit conflict/manual action. Same rule for removal and shell RC writes. Managed PATH block adds `~/.local/bin`, separately consented, preserves exact other bytes and refuses edited block on removal.

- [ ] Run GREEN/Desktop typecheck, real helper probe on packaged macOS where available; otherwise gate unsupported until verified. PATH result explicitly current-process visibility/new-shell caveat.
- [ ] Commit `feat: manage conflict-safe Desktop terminal launcher`; fresh filesystem/security review checks race guarantee, not only mocked happy path.

## Task 13: Opt-in Install CLI settings controls

**Files:** Create `apps/desktop/src/renderer/views/preferences/InstallCliSection.tsx`, `InstallCliSection.test.tsx`; modify `apps/desktop/src/renderer/views/preferences/PreferencesView.tsx` and test, `apps/desktop/src/{ipc/protocol,ipc/commands,main}.ts`, `apps/desktop/src/ipc/commands.test.ts`, `apps/desktop/src/preload.cts`; update `apps/desktop/README.md`.

**Consumes:** Task 12 launcher/path mutation APIs and existing trusted sender checks.
**Produces:** `cli_install_status`, `cli_install`, `cli_repair`, `cli_remove`, `cli_path_add`, `cli_path_remove` typed IPC with explicit consent. Status never mutates.

- [ ] Write RED UI test using existing mocked desktop invoke fixture:

  ```tsx
  render(<InstallCliSection />);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(
      "cli_install_status",
      expect.anything()
    )
  );
  expect(
    invokeMock.mock.calls.some(([command]) => command === "cli_install")
  ).toBe(false);
  expect(
    invokeMock.mock.calls.some(([command]) => command === "cli_path_add")
  ).toBe(false);
  ```

  Adapt existing invoke call shape exactly; assert no install/path action on mount. Add explicit conflict keep/cancel/alternate choice, separate PATH consent, missing app repair, unsupported helper, npm/version/owner mismatch messaging; untrusted IPC sender and unexpected fields rejected.

- [ ] Run `pnpm --filter @koed/desktop exec vitest run src/ipc/commands.test.ts src/renderer/views/preferences/InstallCliSection.test.tsx src/renderer/views/preferences/PreferencesView.test.tsx`; record RED.
- [ ] Implement small preferences section with separate ownership/target/PATH/version diagnostics and user-triggered actions. Main process derives trusted app paths and validates consent/destination; conflict defaults to keep existing, never silent replace. Explain npm/Desktop shared `KOED_HOME` owner/version rules and manual PATH alternative. Supported shell files only; settings opening never edits anything.

  ```ts
  if (!trustedSender(event.senderFrame))
    throw new Error("Untrusted Desktop IPC sender");
  if (args.consent !== true)
    throw new Error("CLI installation requires explicit consent");
  ```

  Use existing exact sender validator/error conventions, not a second inconsistent validation system.

- [ ] Run GREEN/Desktop typecheck/build and React performance checks for touched component (load `vercel-react-best-practices` during implementation).
- [ ] Commit `feat: expose opt-in Desktop Install CLI settings`; fresh UI/security reviewer checks consent enforced below renderer and no surprise shell changes.

## Task 14: Standalone component distribution and packaged lifecycle tests

**Files:** Modify `scripts/build-koed-server-package.mjs`, `scripts/koed-server-package-lib.mjs` and tests, `scripts/inspect-release-artifact.mjs`, `scripts/compare-package-trees.test.mjs`, `scripts/validate-packaged-privacy-runtime.mjs`, `packages/koed-server/src/package-runtime.ts` and test, `apps/desktop/scripts/smoke-packaged-desktop-app.mjs` and library test; update `docs/running-koed.md`.

**Consumes:** Shared assembly, verifier/store/lifecycle, trusted npm/Desktop roots.
**Produces:** Standalone `bin/koed`, distribution manifest binding exact control plane/base/optional privacy; existing `package` commands delegate common verification/activation, no checksum-only activation bypass.

- [ ] Write RED standalone layout/relocation test: `bin/koed` exists/executable, no `bin/koed-server`, matching components/digests, optional privacy, complete notices/assets. Relocate archive outside checkout into spaced path and run help/config. Legacy schema inspection can read old metadata, but unsigned legacy activation cannot enter official trusted component path.

  ```js
  assert.ok(existsSync(resolve(tree, "bin", "koed")));
  assert.ok(!existsSync(resolve(tree, "bin", "koed-server")));
  assert.equal(manifest.components.base.productVersion, manifest.version);
  ```

  Define `tree`/`manifest` using builder's temporary fixture. Add lifecycle smoke with isolated home: Personal base-only setup/start/status/doctor/stop; Team local/external/transition; wrong component fail; native/model separation. Provider behavior tests retain supported execution providers. Test downgrade safeguards, state-preserving uninstall, npm upgrade mismatch.

- [ ] Run `node --test scripts/koed-server-package-lib.test.mjs scripts/compare-package-trees.test.mjs && pnpm --filter @koed-labs/server exec vitest run src/package-runtime.test.ts`; record RED.
- [ ] Delegate standalone installation to component verifier/store/lifecycle, replace unconditional privacy manifest contract. No destructively replacing existing version directory. Bundled manifest verification before execution; state/model retention on uninstall. Update artifact inspection and Desktop smoke to assert base-only default and demand privacy prerequisites only when Team local requires them. Record runtime/Node/Electron/libc identity from actual target, never guess.
- [ ] Run GREEN plus `pnpm koed-server:package -- --json`, `pnpm desktop:package:smoke:mac` where host/toolchain allow. Run Linux x64 lifecycle on real Linux runner and macOS arm64/Electron packaged smoke on actual target; unavailable tests documented external, not passed.
- [ ] Commit `feat: retain component-aware standalone distribution`; fresh reviewer compares all three delivery roots/security contracts.

## Task 15: Immutable release state machine, guarded signer/publication and coherent notes

**Files:** Create `scripts/release-promotion-lib.mjs`, `scripts/release-promotion-lib.test.mjs`, `scripts/product-release-notes.test.mjs`; modify `scripts/product-release-notes.mjs`, `scripts/product-release-version-lib.mjs` and tests, `scripts/write-koed-release-artifact-metadata.mjs` and test, `scripts/validate-published-release-assets.mjs` and test, `.github/workflows/release.yml`, `.github/workflows/release-desktop-assets.yml`, `.github/workflows/ci.yml`; update `docs/release-versioning.md`, create `docs/publishing-koed-server.md`.

**Consumes:** Packed npm payload and validated signed components/Desktop/standalone inventories.
**Produces:** `planReleasePromotion(expected: ImmutableReleaseManifest, remote: RemoteReleaseState, authorization: ReleaseAuthorization): PromotionPlan` pure helper; guarded workflow executes only approved plan actions.

Define JS record schema in helper with runtime validation: expected version, npm tarball SHA-512 integrity/content inventory digest, immutable named GitHub assets with SHA-256/component signature, complete required target/Desktop set; remote includes npm version/integrity/tags and draft/published asset hashes; authorization includes independently approved publishing and configured production signer/trust roots. Plan result is `blocked` with reasons or ordered `upload-missing-draft-assets`, `publish-candidate`, `verify-registry`, `promote-latest`, `publish-github` actions. No overwrite action.

- [ ] Write RED partial failure tests:

  ```js
  const plan = planReleasePromotion(
    expected,
    {
      npm: {
        version: expected.version,
        integrity: expected.npm.integrity,
        tag: "candidate"
      },
      github: { draft: true, assets: incompleteDesktopAssets }
    },
    authorizedFixture
  );
  assert.ok(
    !plan.actions.some((action) => action.kind === "publish-candidate")
  );
  assert.ok(!plan.actions.some((action) => action.kind === "promote-latest"));
  assert.ok(
    plan.actions.some((action) => action.kind === "upload-missing-draft-assets")
  );
  ```

  Define expected/remote/authorization fixtures in test using deterministic hashes, not real services. Add wrong existing npm bytes, existing asset mismatch, complete candidate retry, partial tag promotion recovery, no `latest` downgrade, absent signer/roots/publication authorization blocked; stale changelog heading selection and synchronized manifest versions.

- [ ] Run `node --test scripts/release-promotion-lib.test.mjs scripts/product-release-notes.test.mjs scripts/product-release-version-lib.test.mjs scripts/write-koed-release-artifact-metadata.test.mjs scripts/validate-published-release-assets.test.mjs scripts/ci-policy.test.mjs`; record RED.
- [ ] Implement schema/remote validation and immutable state transitions. Stage/upload complete draft before candidate publish; if remote later incomplete, resume draft but block `latest`. Verify candidate registry tarball and signed assets before promotions; never overwrite immutable npm version. Existing assets either match or stop, no blind `--clobber`. Release-exists boolean no longer skips incomplete draft jobs. Candidate tag `candidate`; public stable tag `latest`; clean candidate only after successful promotion/verification.

  ```js
  if (remote.npm && remote.npm.integrity !== expected.npm.integrity)
    return blocked(
      "Published npm version differs from expected immutable tarball"
    );
  if (
    !authorization.publish ||
    !authorization.signerReady ||
    !authorization.trustRootsReady
  )
    return blocked(
      "Production release authorization or authenticated signer is unavailable"
    );
  ```

  Wire secure npm trusted publishing/OIDC prerequisites as guarded configuration only; no credentials/actions that publish during this task. Signing adapter must use approved algorithm-compatible signer; absent infrastructure leaves explicit fail-closed promotion gate. Test fixture signing does not count as production verification. Notes select matching version heading and generated release PR section, explain removed executable and provisioning minor change. ADR only if actual hard-to-reverse trade-off is resolved with Operator.

- [ ] Run GREEN/mock tests, `pnpm release:check`, workflow policy/format checks. Document retry operations for npm-success/GitHub-failure, npm org ownership, key provisioning/rotation and separate authorization before any publication.
- [ ] Commit `feat: gate authenticated immutable release promotion`; fresh release/security review examines real workflow ordering and CI exposure, not pure helper alone.

## Task 16: Acceptance accounting, complete docs, whole-branch review and push

**Files:** Update `README.md`, `docs/{running-koed,configuration,codex-integration,release-versioning,publishing-koed-server}.md`, `apps/desktop/README.md`, supported Claude/Pi/Codex integration scripts/examples where executable changes; `scripts/required-test-suites.mjs`, `scripts/ci-policy.test.mjs`, `scripts/packed-control-plane.test.mjs`; create `docs/handoffs/publish-koed-labs-server-validation.md`; use `TODO.md` for implementation gaps, not to disguise incomplete product scope as external validation.

**Consumes:** All task review/check evidence.
**Produces:** Acceptance table with PASS/BLOCKED/FAIL, exact commands, host/runtime/target, evidence and external owner; code-complete claim only when implementation/local checks/reviews support it.

- [ ] Write RED required-suite and supported command-reference tests. Inspect actual `scripts/required-test-suites.mjs` representation and register component/packed/release suites through its existing policy (not string-only assertion if it has structured suite registry). Obsolete executable use fails; historical/internal folder/package references exempt by explicit known scope.
- [ ] Run `node --test scripts/ci-policy.test.mjs scripts/packed-control-plane.test.mjs && pnpm test:required-suites`; record RED.
- [ ] Register tests in CI, complete docs for npm vs Desktop/standalone, explicit component/native/model provisioning, privacy transitions, offline signed input, supported Node/Electron/target/libc matrix, version mismatch/ownership, opt-in launcher/PATH/conflicts, upgrade/rollback/migration limits, state-preserving uninstall, removed executable. Populate validation record from real outputs and separate external gates. Search supported executable references with `rg -n 'koed-server' README.md docs scripts packages apps .github`; classify results instead of blanket replacing internal identity/history.

  ```md
  | Criterion | State | Evidence | Remaining gate |
  | Packed global help outside checkout | PASS/BLOCKED/FAIL | Exact command/Node/host | Named reason if not PASS |
  ```

  Replace sample alternatives with actual measured state; never leave ambiguous labels in delivered validation record.

- [ ] Run full cheap CI-equivalents: `pnpm fmt:prettier:check`, `pnpm lint`, `pnpm --filter @koed-labs/server typecheck`, `pnpm --filter @koed/desktop typecheck`, relevant server/Desktop builds, `pnpm test:required-suites`, `node --test scripts/*.test.mjs`, and affected Vitest suites. Run full `pnpm test`, packaging and lifecycle smokes where feasible. If untracked files block full check, targeted equivalent and explicit limitation before push; do not modify unrelated handoff without consent.
- [ ] Commit `docs: document public distribution validation and recovery`. Fresh whole-branch reviewer gets approved spec/plan/handoff, base HEAD, branch diff, test evidence and external gates. Resolve all product/security review defects; repeat relevant checks and whole-branch review for material fixes.
- [ ] Refresh `git status`, diff, latest release/PR state; push normal branch with `git push -u origin feat/publish-koed-labs-server` only after local checks. User requested branch push, not automatic PR creation/publication. Watch triggered CI with `gh run watch` until finished; report run URLs, any failures and external acceptance gaps. Never force push to main or publish npm.

## Handoff acceptance matrix

| Acceptance criterion                                                       | Task/evidence                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Component ownership/dependency resolution documented and approved          | Approved spec; 2–3 graph/asset/licence review                              |
| Fresh packed global install outside checkout/help no download; spaced path | 8–9 actual npm install/executable test                                     |
| Personal base-only setup/start/status/doctor/stop                          | 2, 6–8, 14 isolated home lifecycle                                         |
| Team local/external privacy and transition                                 | 2–3, 7–8, 10–11, 14                                                        |
| Missing/corrupt/wrong-version/target fails safely                          | 4–8 negative signed fixtures and real artifacts                            |
| Privacy providers preserved; complete assets/licences/native JS            | 3–4, 14 archive inspection and execution                                   |
| No workspace references/external symlinks/checkout fallback                | 3, 7, 9, 14 tarball and resolver tests                                     |
| Native assets/models separately provisioned                                | 2, 8–11, 14                                                                |
| Node/target matrix and Electron validated                                  | 4, 9–10, 12, 14; real platform gates explicit                              |
| Offline, cancellation/retry, failed download recovery                      | 4–5, 8, 11                                                                 |
| Atomic upgrades/no mixed versions/User state preserved                     | 5–7, 10, 14 concurrency and migration tests                                |
| Desktop base/on-demand privacy/packaged lifecycle                          | 10–11, 14                                                                  |
| CLI opt-in/conflict-safe/bundled helper/no system Node                     | 12–13 actual helper plus UI/IPC/FS tests                                   |
| PATH/repair/removal/app relocation/npm coexistence                         | 6, 10, 12–13                                                               |
| Removed alias/integration docs/release notes                               | 1, 8–9, 13–16                                                              |
| Standalone preserved                                                       | 14                                                                         |
| Coordinated minor version and coherent notes                               | 1, 15 fixed-group dry run/notes tests                                      |
| Publication/authentication/retry without publishing                        | 4, 15 mocks and guarded workflow; production validation separately blocked |
| Formatting/lint/typecheck/build/packaging checks                           | Each task and 16                                                           |

## External gates and stopping rules

- Operator must verify npm organisation ownership and configure trusted publishing permissions; no code/test proves ownership.
- Operator must approve production public key and establish algorithm-compatible signer/OIDC access. Verify real signed components without publishing before lifting promotion gate. Empty production roots are intentionally non-releasable, not implementation failure hidden by fixture keys.
- Execute Linux x64/libc/native/provider lifecycle on real Linux; record actual minimum target constraints. macOS arm64 packaged Electron helper/fuse/Node/native compatibility requires actual bundle, not unit mock.
- Large model/native downloads, physical Desktop/privacy setup and migrations need available host prerequisites and explicit consent. Record unavailable execution as BLOCKED with reproduction command.
- If Electron helper fundamentally cannot satisfy launcher contract, or signing design cannot support required offline trust, stop and surface design change; do not silently switch architecture.
- Missing implemented scope or failed local tests is not an external gate. Complete/fix before calling code complete. Incremental reviewed, passing chunks may be pushed with explicit incomplete status; final review-ready delivery requires full implemented scope. No publication authorized by any stage of this plan.
