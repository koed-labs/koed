# Optional Privacy Filter: Linux qualification

This is the handoff from ticket 07 to ticket 08.
The Mac results do not establish Linux execution or CUDA execution.
The advertised Desktop target remains macOS arm64.
Linux qualification exercises the supported Linux x64 components under Node 24.
It does not add a supported Linux Electron target.

## Candidate and environment

Use the source snapshot and Mac component archives identified in the qualification evidence bundle.
The snapshot records its Git base, patch digest, additional source files, lockfile digest, and artifact digests.
Make sure that the received files match those digests before building.
The current source version is `0.9.2`. This development snapshot does not authorize replacing published `0.9.2` assets.
Publication remains a separate release action with a new immutable release identity.

Record the host architecture, guest architecture, Linux distribution, glibc version, Node version, and virtualization configuration.
Record x64 emulation explicitly. An arm64 guest cannot establish Linux x64 acceptance.
Use Node 24.14.0 and pnpm 11.1.2 for the recorded candidate.
Use a separate `KOED_HOME` with mode `0700` and synthetic inputs.
Keep the production profile and any private memory outside the test environment.

Set `WORK` to a dedicated qualification directory on the Linux host.
Set `MAC_COMPONENTS` to the received final Mac component directory.
Run the build commands from the reconstructed repository snapshot.

```bash
pnpm install --frozen-lockfile
pnpm source-runtime:prepare
node scripts/build-koed-component-release.mjs \
  --platform linux --arch x64 --out-dir "$WORK/linux-components" --json
mkdir -p "$WORK/frozen"
cp "$MAC_COMPONENTS"/*.tar.gz* "$WORK/frozen/"
cp "$WORK/linux-components"/*.tar.gz* "$WORK/frozen/"
node scripts/component-manifest-catalog.mjs \
  "$WORK/frozen" "$WORK/component-manifest-hashes.json" 0.9.2
node scripts/verify-frozen-component-assets.mjs \
  "$WORK/frozen" "$WORK/component-manifest-hashes.json" 0.9.2
```

The catalog must contain all five exact component identities.
Both Linux variants must pass canonical manifest, archive, file, native-target, and size validation.
Make sure that the CPU inventory excludes CUDA, TensorRT, and their provider-shared library.
Make sure that the CUDA inventory retains its CPU provider and required GPU libraries.
Do not rebuild or change frozen archives after creating their catalog.
The Mac-only fixture catalog contains unusable Linux pins and cannot authorize this stage.

Build the trusted control plane with the complete catalog.
Keep its bundle separate from the frozen runtime archives.

```bash
export KOED_COMPONENT_MANIFEST_CATALOG="$WORK/component-manifest-hashes.json"
pnpm --filter @koed-labs/server build
node scripts/build-public-server-package.mjs --out-dir "$WORK/control-plane"
```

The package command reports `packageRoot` and `tarball` in its JSON result.
Use the reported `packageRoot/bin/koed.js` as the CLI below.
Export that absolute path as `CLI`.
The compiled Server modules in the reconstructed snapshot remain the reviewed qualification harness.
They use the same embedded catalog as the bundled control plane.

## CPU selection and installation

With no GPU access, the compatibility probe must select `cpu` with a recorded reason.
The probe can also select CPU when its tools are absent or its device mapping is inconclusive.
It must not download a CUDA archive to make this decision.
Set `KOED_HOME` to the isolated profile and enable Team collaboration for the component requirement.

```bash
export KOED_HOME="$WORK/cpu-home"
export KOED_TEAM_COLLABORATION_ENABLED=true
mkdir -p "$KOED_HOME"
chmod 700 "$KOED_HOME"
unset NODE_PATH
node --input-type=module <<'JS'
import { probePrivacyDownloadCompatibility } from './packages/koed-server/dist/privacy-download-compatibility.js';
const result = await probePrivacyDownloadCompatibility();
console.log(JSON.stringify(result, null, 2));
if (result.variant !== 'cpu') throw new Error('No-GPU qualification unexpectedly selected CUDA');
JS
node "$CLI" components install --component base \
  --archive "$WORK/frozen/koed-base-0.9.2-linux-x64.tar.gz" \
  --manifest "$WORK/frozen/koed-base-0.9.2-linux-x64.tar.gz.manifest.json" --json
node "$CLI" components install --component privacy --variant cpu \
  --archive "$WORK/frozen/koed-privacy-0.9.2-linux-x64-cpu.tar.gz" \
  --manifest "$WORK/frozen/koed-privacy-0.9.2-linux-x64-cpu.tar.gz.manifest.json" --json
node "$CLI" models install --kind privacy --json
```

The CLI commands exercise component admission. They do not claim Desktop one-action acceptance.
Retain command results and the installed inventory.
Use the following harness to select an authenticated installed component and run real inference.

```bash
export PRIVACY_TEST_VARIANT=cpu
node --input-type=module <<'JS'
import { resolveKoedServerPaths } from './packages/koed-server/dist/paths.js';
import { discoverActualRuntimeIdentity } from './packages/koed-server/dist/component-runtime-identity.js';
import { readStoredComponents } from './packages/koed-server/dist/component-store.js';
import { resolvePrivacyModelPaths } from './packages/koed-server/dist/privacy-model-runtime.js';
import { verifyPrivacyComponentInference } from './packages/koed-server/dist/privacy-inference.js';
const paths = resolveKoedServerPaths(process.env);
const variant = process.env.PRIVACY_TEST_VARIANT;
if (!['cpu', 'cuda'].includes(variant)) throw new Error('Invalid qualification variant');
const privacy = (await readStoredComponents(paths, discoverActualRuntimeIdentity()))
  .find(entry => entry.manifest.component === 'privacy' && entry.manifest.variant === variant);
if (!privacy) throw new Error('No authenticated component matches the requested variant');
const result = await verifyPrivacyComponentInference({ paths,
  componentRoot: privacy.root, modelPath: resolvePrivacyModelPaths(paths).cacheDir,
  provider: variant, environment: process.env });
console.log(JSON.stringify({ manifestDigest: privacy.manifestDigest, variant, result }, null, 2));
JS
```

The CPU result must include an ONNX execution profile with `CPUExecutionProvider` and a synthetic masking digest.
Also run the existing `validate-packaged-privacy-runtime.mjs` against the admitted component root with `--provider cpu`.
Use its `--transformers-cache` argument for this profile's verified model cache.
That service check must pass health, classification, classifier identity, and reload behavior.
Keep component inference separate from full Koed and required-sharing readiness.
Full readiness additionally requires the selected native storage runtime, embedding model, API, and sharing gates.

## CUDA bundle without a GPU

Use another isolated profile with the same complete catalog.
Admit the `cuda` variant through the normal CLI with its matching archive and manifest.
This explicit harness admission exercises fallback. It does not force automatic compatibility to report success.
Install or reuse the separately pinned model through its normal integrity rules.
Run the inference harness above with `PRIVACY_TEST_VARIANT=cuda`.

The expected result has `requestedProvider=cuda`, `activeProvider=cpu`, and `fallbackReason=cuda_initialization_or_inference_failed`.
The execution profile must prove CPU execution after the CUDA failure.
The runtime must use the already admitted CUDA bundle's CPU provider without another runtime download.
A missing CUDA provider initialization is expected in this environment.
It cannot count as successful CUDA execution.

Repeat cancellation, interrupted transfer, corrupt model, substituted manifest, relaunch, and concurrent-selection checks for these native paths.
Make sure that rejected assets do not execute or enable required sharing.
Record failure and recovery separately when startup cannot return to a healthy state.

## Colleague handoff

After ticket 08 passes, freeze the exact artifacts, catalog, control-plane bundle, model identity, and successful Linux reports.
The User can share that package with the colleague. This work does not authorize contacting the colleague.
Confirm Linux x64, glibc 2.35 or later, GPU model, driver, CUDA runtime, and cuDNN before running ticket 09.
The automatic probe requires driver 570.26 or later, CUDA runtime 12080 through 12999, and cuDNN major version 9.
Hidden, remapped, or multiple GPUs select CPU when the default device mapping is inconclusive.

The colleague must run CPU, CUDA, and CUDA-to-CPU recovery on the same frozen candidate.
CUDA success requires `activeProvider=cuda` and an ONNX profile with `CUDAExecutionProvider` kernel events.
Provider labels, fixtures, CPU fallback, and performance measurements cannot replace that execution evidence.
Record masking parity, labels, spans, UTF-8 offsets, final output, artifact digests, and environment identity.
Keep signing acceptance, fresh Desktop download acceptance, and publication gates separate from these Linux results.
