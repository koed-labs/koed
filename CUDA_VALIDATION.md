# Native CUDA validation

## Task for the agent

Complete ticket 09 in `tickets.md` on the real NVIDIA host.
Prove native CPU operation, actual CUDA kernel execution, masking parity, and safe CPU recovery using the same frozen candidate.
Keep the model, tokenizer, masking rules, integrity checks, and existing runtime calibration unchanged.
Do not publish, push, create releases, modify host drivers, or contact other people.
Run only the checks needed for these acceptance criteria. Do not start broad tests or performance benchmarks by default.

Read the repository `AGENTS.md`, `CONTEXT.md`, `PLAN.md`, tickets 08–09, and `docs/optional-privacy-installation.md` before changing code.
Use the candidate and reports produced by the Linux CPU/fallback stage.
This file alone does not transfer the implementation, runtime archives, model, or trusted catalog.
The advertised Desktop target remains macOS arm64. These are native Linux component checks, not Linux Electron acceptance.

If validation finds a product bug, retain the failing evidence and fix it within the approved scope.
Do not patch frozen archives in place. Create a new identified candidate and repeat affected Linux CPU/fallback and CUDA checks.
A different artifact or source revision is a different candidate.

## Required inputs and host

Obtain the matching source, both Linux Privacy variants, Linux Base, both Mac components, the complete catalog, and the bundled control plane.
Require the Linux CPU/fallback report and a checksum manifest for the received files.
The catalog must authenticate five exact identities. Zero or invented placeholder pins cannot authorize validation.
The original source snapshot starts at `2b485a7c043ba3ceb38da3d5d7d6db791b78cacf`; its development version is `0.9.2`.
Use the received source/patch identity as authoritative. Do not substitute another checkout because its version string matches.
Do not rebuild the frozen runtime components on the GPU host or replace published artifacts under an existing version.

Use native Linux x64 with glibc 2.35 or later, Node 24.14.0, and pnpm 11.1.2 for the recorded candidate.
Record host/guest architectures, OS, libc, container/VM configuration, and GPU passthrough.
Emulation cannot satisfy native CUDA or native x64 CPU acceptance.
If the earlier Linux run used emulation, retain that limitation and complete native CPU acceptance here.
If the earlier stage failed another required gate, request a corrected candidate before treating this stage as release evidence.

The packaged ONNX Runtime 1.24.3 compatibility probe currently requires:

- Driver 570.26 or later.
- A supported compute capability from 6.x through 9.x.
- CUDA runtime version 12080 through 12999 and cuDNN major version 9.
- Host libraries `libcublasLt.so.12`, `libcublas.so.12`, `libcudnn.so.9`, `libcufft.so.11`, `libcurand.so.10`, `libcudart.so.12`, and `libz.so.1`.
- An unambiguous default GPU mapping. Hidden/remapped devices and multiple GPUs can produce a conservative CPU decision.

Read `packages/koed-server/src/privacy-download-compatibility.ts` for the exact current decision rules.
A compatible GPU name alone is insufficient. Do not force a successful probe or relax these rules to pass this host.
If this host is unsupported or inconclusive, report the reason and keep the automatic CUDA gate open.
Do not install toolkits, change firewall policy, or modify shared-host configuration without the User's authorization.

## Prepare isolated inputs

Set these absolute paths. `CANDIDATE_DIR` must be the Linux stage's completed handoff, not the Mac-only fixture handoff.

```bash
export REPO_ROOT="/absolute/path/to/matching/repository"
export CANDIDATE_DIR="/absolute/path/to/completed/linux-candidate"
export WORK="$REPO_ROOT/scratch/cuda-privacy-validation"
export RUN_ROOT="/absolute/path/outside/the/checkout/for/isolated-artifacts"
export VERSION="0.9.2"
cd "$REPO_ROOT"
mkdir -p "$WORK/reports"
(cd "$CANDIDATE_DIR" && sha256sum -c SHA256SUMS)
```

Choose new dedicated directories and synthetic profiles. Keep production credentials and memory outside the test.
Verify all received checksums before extracting or executing artifacts.
Record the catalog hash, control-plane hash, each archive/manifest hash, source revision/patch hash, and lockfile hash.
Match the Linux CPU report to these exact hashes.
Record the following host evidence without dumping credentials:

```bash
uname -a
uname -m
cat /etc/os-release
getconf GNU_LIBC_VERSION
node -p 'JSON.stringify(process.versions)'
pnpm --version
nvidia-smi --query-gpu=index,name,driver_version,compute_cap,memory.total --format=csv
```

Choose fresh `WORK` and `RUN_ROOT` directories and retain prior evidence.
Keep temporary scripts and reports under `WORK`. Export artifacts and test profiles outside the checkout to expose source fallback.
Use mode `0700` for each `KOED_HOME`. Remove `NODE_PATH` from test environments.
Use `PRIVACY_RUNTIME_ENGINE=transformers`; the separate Python engine is outside this task.
Do not disable TLS validation or replace pinned model files.

Install source dependencies and compile only the trusted harness with the received catalog:

```bash
pnpm install --frozen-lockfile
export KOED_COMPONENT_MANIFEST_CATALOG="$CANDIDATE_DIR/component-manifest-hashes.json"
pnpm source-runtime:prepare
pnpm --filter @koed-labs/server build
node scripts/verify-frozen-component-assets.mjs \
  "$CANDIDATE_DIR/frozen" "$KOED_COMPONENT_MANIFEST_CATALOG" "$VERSION" \
  > "$WORK/reports/frozen-verification.log"
```

Use the supplied bundled control plane. Export it to the dedicated external directory and set `CLI` to its `bin/koed.js`.
The Linux handoff layout places package contents under `control-plane/`, with `bin/koed.js` and `vendor/` inside it.
If the supplied layout differs, inspect its build report rather than guessing another artifact.

```bash
mkdir -m 700 "$RUN_ROOT"
cp -a "$CANDIDATE_DIR/control-plane" "$RUN_ROOT/control-plane"
export CLI="$RUN_ROOT/control-plane/bin/koed.js"
unset NODE_PATH
```

Building the trusted harness does not authorize rebuilding or replacing frozen service components.
Confirm that the supplied control plane embeds the same complete catalog as the harness.

## Prove automatic selection on this host

Run the normal automatic preference in this isolated validation context:

```bash
node --input-type=module <<'JS' > "$WORK/reports/compatibility.json"
import { probePrivacyDownloadCompatibility } from './packages/koed-server/dist/privacy-download-compatibility.js';
const result = await probePrivacyDownloadCompatibility({ preference: 'auto' });
console.log(JSON.stringify(result, null, 2));
if (result.target !== 'linux-x64' || result.variant !== 'cuda' || result.compatible !== true)
  throw new Error(`Automatic CUDA selection is unproven: ${result.reason}`);
JS
```

Record existing GPU visibility controls and Operator overrides, without silently changing global settings.
A dedicated single-GPU test environment can resolve mapping ambiguity if the User provides it.
Do not replace `nvidia-smi`, fake library versions, or mock the runner to make this native case pass.
The probe has a bounded metadata-only budget. It must not download a payload, run inference, or benchmark providers.
Also check that an explicit CPU preference chooses CPU without GPU probing.

## Install both variants through normal admission

Use separate fresh profiles for CPU and CUDA. Enable Team collaboration so the component requirement includes Privacy.
The following shows the CUDA profile; use `cpu-home` and `--variant cpu` with the matching CPU archive for the native CPU case.

```bash
export KOED_HOME="$RUN_ROOT/cuda-home"
export KOED_TEAM_COLLABORATION_ENABLED=true
export PRIVACY_RUNTIME_ENGINE=transformers
mkdir -m 700 "$KOED_HOME"
unset NODE_PATH
node "$CLI" components install --component base \
  --archive "$CANDIDATE_DIR/frozen/koed-base-$VERSION-linux-x64.tar.gz" \
  --manifest "$CANDIDATE_DIR/frozen/koed-base-$VERSION-linux-x64.tar.gz.manifest.json" --json \
  > "$WORK/reports/cuda-base-install.json"
node "$CLI" components install --component privacy --variant cuda \
  --archive "$CANDIDATE_DIR/frozen/koed-privacy-$VERSION-linux-x64-cuda.tar.gz" \
  --manifest "$CANDIDATE_DIR/frozen/koed-privacy-$VERSION-linux-x64-cuda.tar.gz.manifest.json" --json \
  > "$WORK/reports/cuda-runtime-install.json"
node "$CLI" models install --kind privacy --json > "$WORK/reports/cuda-model-install.json"
```

The CLI requires an explicit variant. The real automatic probe supplies the decision in this harness; the CLI itself is not an automatic Desktop installer.
If approved immutable HTTPS runtime URLs are supplied, repeat the fresh CUDA case using `--archive-url` and `--manifest-url` instead.
Otherwise, identify runtime transport as offline and leave exact runtime downloading untested.
Do not publish assets or change pins to complete that case.
The model remains separately pinned and authenticated. Complete model blobs can be reused between profiles only through normal hash verification.
The CPU archive must contain no CUDA/TensorRT providers; the CUDA archive must retain the CPU path and complete dependencies.

## Require executed CUDA kernels and masking parity

Create this temporary harness under `WORK`. It verifies the stored component and model before running the installed engine.
It is self-contained and does not depend on receiving the CPU agent's temporary scripts.

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
if (result.activeProvider === 'cuda')
  assert.ok(result.executedProviders.includes('CUDAExecutionProvider'));
if (variant === 'cuda' && result.activeProvider === 'cpu')
  assert.equal(result.fallbackReason, 'cuda_initialization_or_inference_failed');
const report = { runtime, variant, componentRoot, modelPath: model.modelPath,
  manifestDigest: component.manifestDigest, archiveSha256: component.manifest.archive.sha256,
  productVersion: component.manifest.productVersion, result };
writeFileSync(process.env.PROOF_FILE, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
JS
export PRIVACY_TEST_VARIANT=cuda
export EXPECTED_PROVIDER=cuda
export PROOF_FILE="$WORK/reports/cuda-inference.json"
node "$WORK/verify-installed.mjs"
```

Require `requestedProvider=cuda`, `activeProvider=cuda`, `proof=onnx-execution-profile`, and `CUDAExecutionProvider` in executed providers.
The verifier checks actual kernel events, compares CUDA masking with CPU masking, and removes its temporary profiles.
Retain the validated result with the harness source identity and artifact hashes.
A provider preference, capability label, successful import, mock, or CPU fallback cannot count as CUDA success.
If raw profiles are required for review, preserve synthetic-only traces through the existing probe after normal admission; do not weaken its execution check.

Run the same harness in the native CPU profile with `PRIVACY_TEST_VARIANT=cpu`, `EXPECTED_PROVIDER=cpu`, and a separate `PROOF_FILE`.
Require CPU kernel evidence and successful masking without loading another inference engine from the checkout or global modules.
Compare CPU and CUDA labels, spans, UTF-8 offsets, secret handling, and final masked output.
The verifier already requires exact within-run CPU/CUDA masking parity. Do not invent looser acceptance rules.
Report cross-host differences for investigation rather than changing the fixture or pinned model to hide them.

Validate service behavior from each admitted component root:

```bash
export COMPONENT_ROOT="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_FILE)).componentRoot')"
export MODEL_CACHE="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PROOF_FILE)).modelPath')"
node scripts/validate-packaged-privacy-runtime.mjs \
  --runtime-root "$COMPONENT_ROOT" --transformers-cache "$MODEL_CACHE" --provider cuda \
  > "$WORK/reports/cuda-service.json"
```

Set `PROOF_FILE` back to the CUDA result before that command. Use `--provider cpu` for the CPU result.
The CUDA service check must pass real classification, CPU parity, provider switching, idle unload/reload, and unavailable-provider rejection.
Existing calibration may run during ordinary operation. Do not add a speed benchmark as a download-selection or acceptance requirement.

## Exercise reversible CUDA-to-CPU recovery

Use the already admitted CUDA bundle and its verified model. Do not install the CPU variant into this profile.
First establish the positive CUDA result above. Then hide GPU access only in a new verification subprocess:

```bash
export KOED_HOME="$RUN_ROOT/cuda-home"
export PRIVACY_TEST_VARIANT=cuda
export EXPECTED_PROVIDER=cpu
export PROOF_FILE="$WORK/reports/cuda-hidden-gpu-fallback.json"
CUDA_VISIBLE_DEVICES=-1 node "$WORK/verify-installed.mjs"
```

Require `requestedProvider=cuda`, `activeProvider=cpu`, `fallbackReason=cuda_initialization_or_inference_failed`, and executed CPU kernels.
The verifier must rerun CPU after CUDA failure; an earlier CPU baseline alone is insufficient recovery evidence.
Confirm that the runtime/model hashes and selected CUDA archive stay unchanged and no second runtime download occurs.
This subprocess-local visibility setting does not uninstall or change the host driver.
A CUDA initialization failure on restart is not evidence of a live mid-request GPU failure. Label the exercised failure accurately.

Run the admitted CUDA bundle's CPU service check after recovery.
Also exercise automatic service startup with GPU access unavailable if claiming automatic service recovery.
Use authenticated runtime status, health/classifier identity, and a real classification request to establish readiness.
The component probe does not write a Desktop installation record; do not claim preference persistence from its result alone.
If claiming live-request failure recovery, use a controlled process-scoped fault and verify the actual retry. Do not disrupt a shared GPU or unload drivers.

Keep required sharing blocked during failed inference or unavailable filtering.
If claiming sharing acceptance, use the Team fixture skill and its required documents with a disposable database and matching encryption-provider lineage.
Service health alone does not establish Team authorization or grant publication.
After the controlled failure, return to the normal environment and rerun positive CUDA inference against the same candidate.

## Relaunch, report, and completion

Check ordinary relaunch, authenticated asset reuse, active-provider reporting, and applicable selection/recovery behavior.
Do not start new runtime downloads during an ordinary status or relaunch check.
Retain failure logs and explicit `not_run` cases. Do not turn skipped or inconclusive results into a pass.
Update ticket 09 only when its individual acceptance criteria have direct evidence.

Write `CUDA_RESULTS.md`, structured JSON results, command logs, and artifact checksums under `WORK`.
For every case, record `passed`, `failed`, `blocked`, or `not_run`, with an evidence path and reason.
Include source/patch and lockfile identities, catalog/control-plane hashes, archive/manifest hashes, model revision/classifier hash, native architectures, GPU/driver/library observations, and actual providers.
Report these outcomes separately: native CPU, automatic CUDA selection, executed CUDA kernels, masking parity, CUDA-to-CPU recovery, post-recovery service readiness, and positive CUDA restoration.
Distinguish offline runtime admission from real runtime downloading, synthetic fault injection from hardware failure, and component checks from GUI/sharing checks.

Do not include profile secret stores, tokens, cookies, or unrestricted environment dumps in the evidence package.
Stop only the processes owned by this validation and confirm cleanup before returning results.
Return the report and evidence package to the User. Do not contact the colleague or publish the candidate yourself.
Unsupported hardware, missing Linux evidence, failed CUDA proof, silent CPU execution, or failed CPU recovery leaves the relevant gate open.
Clean-Mac signing/notarization and final exact release-runtime downloading remain separate release gates.
This run cannot by itself declare ticket 10 or the release complete.
