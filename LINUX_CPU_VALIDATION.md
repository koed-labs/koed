# Linux CPU and CUDA-fallback validation

## Task for the agent

Complete ticket 08 in `tickets.md` on this Linux environment.
Prove native CPU installation, inference, service readiness, and CPU recovery within the CUDA bundle.
Preserve the runtime engine, model, tokenizer, masking rules, integrity checks, and lifecycle locks.
Fix failures within this scope, preserve their evidence, and repeat the affected checks against a new identified candidate.
Do not publish, push, create releases, contact the CUDA operator, or claim CUDA success.
Run only the checks needed for these acceptance criteria. Do not start a broad test suite by default.

Read the repository `AGENTS.md`, `CONTEXT.md`, `PLAN.md`, and tickets 07–09 before changing code.
Read `docs/optional-privacy-mac-qualification.md` and `docs/optional-privacy-installation.md` for completed Mac evidence and behavior.
The Mac goal is paused at the User's request. This document is a brief for the Linux stage, not permission to publish.
The supported component target is Linux x64 with glibc 2.35 or later.
The advertised Desktop release target remains macOS arm64. Component checks do not establish Linux Electron acceptance.

## Inputs and environment

Obtain the matching implementation and Mac component handoff before testing.
This Markdown file alone does not transfer the implementation or artifacts.
The handoff contains `candidate-identity.json`, `SHA256SUMS`, `tracked-changes.patch`, `additional-source.tar.gz`, and `mac-components/`.
An agent can instead use a matching reviewed branch if its source identity is recorded.
The original snapshot starts from `2b485a7c043ba3ceb38da3d5d7d6db791b78cacf`; the package version is `0.9.2`.
Do not replace previously published artifacts under an existing version.

Verify the handoff checksums before reconstruction. Set `HANDOFF_DIR` to its received absolute path first.

If reconstructing the snapshot, use a fresh checkout at the recorded Git base.
Apply `tracked-changes.patch` and extract `additional-source.tar.gz` there.
Inspect the patch and archive paths before extraction. Do not overwrite unrelated local work.
If source or Mac artifacts are missing, report exactly what is missing. Do not invent catalog pins.

Use Node 24.14.0 and pnpm 11.1.2 for the recorded candidate.
Record `/etc/os-release`, `uname -a`, `uname -m`, `getconf GNU_LIBC_VERSION`, Node versions, and pnpm version.
Record the host architecture, guest architecture, virtualization/container configuration, and any emulation.
An arm64 guest is unsupported. Emulated x64 evidence cannot satisfy native x64 acceptance.
The no-GPU environment must also lack the CUDA/cuDNN host libraries, so it proves CPU independence.

Set these absolute paths before continuing:

```bash
export REPO_ROOT="/absolute/path/to/matching/repository"
export HANDOFF_DIR="/absolute/path/to/received/handoff"
export WORK="$REPO_ROOT/scratch/linux-privacy-validation"
export RUN_ROOT="/absolute/path/outside/the/checkout/for/isolated-artifacts"
export VERSION="0.9.2"
cd "$REPO_ROOT"
mkdir -p "$WORK/reports"
(cd "$HANDOFF_DIR" && sha256sum -c SHA256SUMS)
```

Choose fresh `WORK` and `RUN_ROOT` directories and retain prior evidence. Do not reuse a production profile.
Keep scripts and investigation output under `WORK`. Export admitted artifacts and profiles outside the checkout to detect source fallback.
Use mode `0700` for each test `KOED_HOME`. Remove `NODE_PATH` from test environments.
Keep the Python engine outside this task. Use `PRIVACY_RUNTIME_ENGINE=transformers` for these isolated runs.
Do not disable TLS verification or alter host drivers or firewall policy to make a check pass.

## Build and freeze the Linux candidate

Skip rebuilding if the coordinator supplied the complete frozen candidate with matching source provenance.
Otherwise, build the Linux components before embedding the final catalog:

```bash
pnpm install --frozen-lockfile
pnpm source-runtime:prepare
node scripts/build-koed-component-release.mjs \
  --platform linux --arch x64 --out-dir "$WORK/linux-components" --json \
  > "$WORK/reports/component-build.json"
mkdir -p "$WORK/frozen"
cp "$HANDOFF_DIR/mac-components/"*.tar.gz* "$WORK/frozen/"
cp "$WORK/linux-components/"*.tar.gz* "$WORK/frozen/"
node scripts/component-manifest-catalog.mjs \
  "$WORK/frozen" "$WORK/component-manifest-hashes.json" "$VERSION"
node scripts/verify-frozen-component-assets.mjs \
  "$WORK/frozen" "$WORK/component-manifest-hashes.json" "$VERSION" \
  > "$WORK/reports/frozen-verification.log"
```

The catalog must authenticate five exact identities: Mac Base, Mac Privacy, Linux Base, Linux Privacy CPU, and Linux Privacy CUDA.
The Mac test catalog with zero Linux pins cannot authorize this stage.
Inspect both Linux archives and retain their file inventories, hashes, compressed sizes, and expanded sizes.
The CPU variant must retain `libonnxruntime.so.1` and `onnxruntime_binding.node`.
It must exclude `libonnxruntime_providers_cuda.so`, `libonnxruntime_providers_shared.so`, and `libonnxruntime_providers_tensorrt.so`.
The CUDA variant must retain all five files and its complete dependency closure.
Verify notices, licenses, manifests, required files, native architecture, and libc compatibility.
A manifest or fixture with a Linux label is not proof of a native Linux binary.

Do not modify or rebuild frozen components after catalog generation.
Build the trusted control plane separately, then export its package outside the checkout:

```bash
export KOED_COMPONENT_MANIFEST_CATALOG="$WORK/component-manifest-hashes.json"
pnpm --filter @koed-labs/server build
node scripts/build-public-server-package.mjs --out-dir "$WORK/control-plane" \
  > "$WORK/reports/control-plane-build.json"
mkdir -m 700 "$RUN_ROOT"
cp -a "$WORK/control-plane/package" "$RUN_ROOT/control-plane"
export CLI="$RUN_ROOT/control-plane/bin/koed.js"
unset NODE_PATH
```

If using a supplied control-plane package, verify its embedded catalog against the received complete catalog.
Do not substitute a downloaded sidecar checksum for embedded manifest authority.

## Prove no-GPU selection

Run the real bounded probe before installing a Privacy runtime:

```bash
node --input-type=module <<'JS' > "$WORK/reports/compatibility.json"
import { probePrivacyDownloadCompatibility } from './packages/koed-server/dist/privacy-download-compatibility.js';
const result = await probePrivacyDownloadCompatibility({ preference: 'auto' });
console.log(JSON.stringify(result, null, 2));
if (result.target !== 'linux-x64' || result.variant !== 'cpu')
  throw new Error('No-GPU host did not select the CPU bundle');
JS
```

Retain the observed reason. Missing tools, incompatible versions, timeout, and inconclusive mapping must select CPU.
An explicit CPU preference must skip GPU probing.
Use the existing controlled probe cases only where native evidence does not cover these branches.
Label fixtures as simulated; do not modify the probe to claim compatible CUDA.
The probe must not download CUDA files, perform inference, or run a performance benchmark.

## Install the CPU variant into a fresh profile

```bash
export KOED_HOME="$RUN_ROOT/cpu-home"
export KOED_TEAM_COLLABORATION_ENABLED=true
export PRIVACY_RUNTIME_ENGINE=transformers
mkdir -m 700 "$KOED_HOME"
node "$CLI" components install --component base \
  --archive "$WORK/frozen/koed-base-$VERSION-linux-x64.tar.gz" \
  --manifest "$WORK/frozen/koed-base-$VERSION-linux-x64.tar.gz.manifest.json" --json \
  > "$WORK/reports/cpu-base-install.json"
node "$CLI" components install --component privacy --variant cpu \
  --archive "$WORK/frozen/koed-privacy-$VERSION-linux-x64-cpu.tar.gz" \
  --manifest "$WORK/frozen/koed-privacy-$VERSION-linux-x64-cpu.tar.gz.manifest.json" --json \
  > "$WORK/reports/cpu-runtime-install.json"
node "$CLI" models install --kind privacy --json > "$WORK/reports/cpu-model-install.json"
```

These commands use authenticated offline runtime archives and a separate pinned model installation.
The CLI requires an explicit variant; the real probe result supplies that choice in this validation.
Do not describe this as a Linux Desktop one-action installation.
If approved immutable HTTPS runtime URLs are available, repeat from empty caches using `--archive-url` and `--manifest-url` instead.
Otherwise, mark runtime network transport as untested. Do not publish assets just to complete that case.
Prove that the CPU path transfers no CUDA/TensorRT runtime payload.

## Run real inference and service validation

Create this temporary harness under `WORK`. It admits the stored component under the embedded pins before invoking inference.
The parent harness comes from the matching trusted source; the inference engine must come from the admitted external component.

```bash
cat > "$WORK/verify-installed.mjs" <<'JS'
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = realpathSync(process.env.REPO_ROOT);
const load = file => import(pathToFileURL(resolve(repo, 'packages/koed-server/dist', file)).href);
const { resolveKoedServerPaths } = await load('paths.js');
const { discoverActualRuntimeIdentity } = await load('component-runtime-identity.js');
const { readStoredComponents } = await load('component-store.js');
const { collectPrivacyModelStatus } = await load('privacy-model-runtime.js');
const { verifyPrivacyComponentInference } = await load('privacy-inference.js');
const paths = resolveKoedServerPaths(process.env);
const variant = process.env.PRIVACY_TEST_VARIANT;
assert.ok(['cpu', 'cuda'].includes(variant));
const runtime = discoverActualRuntimeIdentity();
const component = (await readStoredComponents(paths, runtime)).find(entry =>
  entry.manifest.component === 'privacy' && entry.manifest.variant === variant &&
  entry.manifest.productVersion === process.env.VERSION);
assert.ok(component, 'No authenticated matching component');
const componentRoot = realpathSync(component.root);
const location = relative(repo, componentRoot);
assert.ok(isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`),
  'Installed inference component must be outside the checkout');
const model = await collectPrivacyModelStatus(paths);
assert.equal(model.ok, true, model.message);
const result = await verifyPrivacyComponentInference({ paths, componentRoot,
  modelPath: model.modelPath, provider: variant, environment: process.env });
assert.equal(result.activeProvider, process.env.EXPECTED_PROVIDER);
assert.equal(result.proof, 'onnx-execution-profile');
if (variant === 'cuda' && result.activeProvider === 'cpu')
  assert.equal(result.fallbackReason, 'cuda_initialization_or_inference_failed');
const report = { runtime, variant, componentRoot, modelPath: model.modelPath,
  manifestDigest: component.manifestDigest, archiveSha256: component.manifest.archive.sha256,
  productVersion: component.manifest.productVersion, result };
writeFileSync(process.env.PROOF_FILE, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
JS
export PRIVACY_TEST_VARIANT=cpu
export EXPECTED_PROVIDER=cpu
export PROOF_FILE="$WORK/reports/cpu-inference.json"
node "$WORK/verify-installed.mjs"
export COMPONENT_ROOT="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_FILE)).componentRoot')"
export MODEL_CACHE="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_FILE)).modelPath')"
node scripts/validate-packaged-privacy-runtime.mjs \
  --runtime-root "$COMPONENT_ROOT" --transformers-cache "$MODEL_CACHE" --provider cpu \
  > "$WORK/reports/cpu-service.json"
```

Require real `CPUExecutionProvider` events, successful masking, the pinned model identity, and the expected classifier hash.
The inference verifier inspects kernel events and removes its temporary profiles; retain its validated result and source/artifact hashes.
The service check must pass classification, provider controls, and applicable reload checks.
Compare labels, spans, UTF-8 offsets, secret handling, and final masked output against the existing synthetic fixtures.
Do not change the model or masking rules to force a pass.
Component health alone does not prove full Koed or Team sharing readiness.

## Prove CPU recovery inside the CUDA bundle

Use a second fresh `KOED_HOME`, such as `"$RUN_ROOT/cuda-fallback-home"`, with mode `0700`.
Repeat the Base install, then install `--variant cuda` using the matching `-cuda` archive and manifest.
Install the same pinned model through its normal installer, or reuse complete assets only after its normal hash checks.
This explicit harness admission is allowed to exercise fallback; automatic no-GPU selection must still choose CPU.

```bash
export KOED_HOME="$RUN_ROOT/cuda-fallback-home"
mkdir -m 700 "$KOED_HOME"
node "$CLI" components install --component base \
  --archive "$WORK/frozen/koed-base-$VERSION-linux-x64.tar.gz" \
  --manifest "$WORK/frozen/koed-base-$VERSION-linux-x64.tar.gz.manifest.json" --json
node "$CLI" components install --component privacy --variant cuda \
  --archive "$WORK/frozen/koed-privacy-$VERSION-linux-x64-cuda.tar.gz" \
  --manifest "$WORK/frozen/koed-privacy-$VERSION-linux-x64-cuda.tar.gz.manifest.json" --json
node "$CLI" models install --kind privacy --json
export PRIVACY_TEST_VARIANT=cuda
export EXPECTED_PROVIDER=cpu
export PROOF_FILE="$WORK/reports/cuda-bundle-fallback.json"
node "$WORK/verify-installed.mjs"
export COMPONENT_ROOT="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_FILE)).componentRoot')"
export MODEL_CACHE="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_FILE)).modelPath')"
node scripts/validate-packaged-privacy-runtime.mjs \
  --runtime-root "$COMPONENT_ROOT" --transformers-cache "$MODEL_CACHE" --provider cpu \
  > "$WORK/reports/cuda-bundle-cpu-service.json"
```

Require `requestedProvider=cuda`, `activeProvider=cpu`, the recorded fallback reason, and real CPU execution after CUDA failure.
The CUDA bundle must supply that CPU path without a second runtime download.
Do not count this result as CUDA success.
The explicit CPU service check proves readiness of that admitted bundle; it does not establish Desktop preference persistence.

## Recovery, integrity, and sharing cases

Exercise the applicable native cases from tickets 04–06 using isolated profiles and synthetic inputs:

- Cancel or interrupt runtime and model provisioning. Relaunch without false readiness, then retry through normal admission.
- Reuse complete pinned assets and reject partial or corrupt cache entries.
- Reject a substituted manifest, renamed/mismatched variant, corrupt archive, corrupt model, wrong target, and unsupported runtime.
- Prove rejected payloads do not execute, selection remains valid, and an adjacent checksum cannot replace embedded pins.
- Exercise active-pin, concurrent-selection, activation-failure, and supported same-version recovery paths.
- Preserve authenticated assets across ordinary relaunch and record the actual provider.
- Keep required sharing unavailable until inference and service readiness pass. Test protected publication through the production Worker if claiming sharing acceptance.

Use the Team fixture skill and its two required reference documents before Team authorization/materialization assertions.
Do not seed production or shared databases. Use the same encryption-provider lineage for seed, API, Worker, and validation.
Do not infer Team grant authorization from service health or a Personal API Token.
If full startup requires native storage/embedding assets, report and provision those explicitly through the existing bundled-local path.
Do not silently replace bundled-local operation with Docker-managed product dependencies.

## Deliverables and stopping point

Write `LINUX_CPU_RESULTS.md`, structured JSON results, command logs, and artifact inventories under `WORK`.
For every case, record `passed`, `failed`, `blocked`, or `not_run` with an evidence path and reason.
Include source/patch identity, lockfile hash, toolchain, architectures/emulation, catalog hash, artifact hashes/sizes, model identity, and actual providers.
Record offline installation separately from HTTPS runtime/model downloading and component-only checks separately from full sharing or GUI checks.
List fixes and their affected revalidation. Update ticket 08 checkboxes only when the evidence supports them.
Missing native evidence, mocks, emulation, skipped inference, or a CPU result cannot pass a native CUDA gate.

Prepare a CUDA handoff with the unchanged frozen archives, complete catalog, bundled control plane, source identity, synthetic fixtures, reports, and checksums.
Use `frozen/` for all five component archive/manifest pairs and `component-manifest-hashes.json` for the complete catalog.
Use `control-plane/` for the package contents containing `bin/koed.js` and `vendor/`.
Include the matching source reconstruction inputs or reviewed commit, and `LINUX_CPU_RESULTS.md` with its JSON/log evidence.
If fixes changed the source, export the corrected source identity rather than reusing the original Mac snapshot identity.
Do not include profile secret stores, tokens, cookies, or unrestricted environment dumps.
Include `CUDA_VALIDATION.md`. Verify that the recipient can reconstruct the matching source and verify every received file.
Stop only the processes owned by this validation and confirm cleanup.
Stop before native CUDA work, publication, or contacting the colleague.
If native Linux CPU/fallback fails, keep ticket 08 incomplete and identify what blocks the CUDA handoff.
