# Linux CUDA candidate handover

This bundle prepares ticket 08 for a colleague with a suitable Linux machine.
The CUDA builder, packaging tests, and loader checks are unrun.
The bundle includes the exact CPU candidate that passed ticket 03.
It contains no CUDA archive, model, production pin, or packaged CLI validator.
All CUDA testing remains deferred until the Operator arranges the machine.

The supplied checks cover candidate packaging and the combined filesystem layout.
They do not qualify GPU inference or installation through the release provider.
Tickets 09 and 11 require the shipped CLI validator before production CUDA publication.
Do not publish an add-on based only on this bundle's results.

## Prepare the machine

Use an unprivileged account on Ubuntu 22.04, Linux x64, with glibc 2.35.
Use Node 24.13.1 for candidate packaging and repeat packaging.
Install `build-essential`, `cmake`, `curl`, `ca-certificates`, and `binutils` before the build.
Arrange CUDA toolkit 12.4 at `/usr/local/cuda-12.4` through the machine's normal administration process.
The builder records installed package versions, compiler hashes, and toolkit file hashes.
The source download requires access to GitHub.

For later GPU qualification, arrange an NVIDIA GPU supported by architectures 75, 80, 86, 89, or 90.
That qualification requires driver 550.54.14 or later and a loadable host `libcuda.so.1`.
The add-on never bundles the host driver.
The layout check permits that one missing driver library and reports its absence.
That allowance does not establish GPU readiness.

The CPU bundle occupies approximately 24 MB compressed.
The CUDA budget permits 750 MB compressed and 1.6 GB of regular files after extraction.
Keep separate space for the toolkit, compilation, both candidate archives, extracted trees, and repeat packaging.
Record actual free space and peak use during the build.
No fresh-build disk measurement exists for this add-on yet.

## Open the handover

Obtain `koed-cuda-handover.tar.gz` and its checksum together from the reviewer.
Make sure that the checksum matches before extraction:

```bash
sha256sum --check koed-cuda-handover.tar.gz.sha256
tar -xzf koed-cuda-handover.tar.gz
cd koed-cuda-handover
sha256sum --check koed-core-qualification.tar.gz.sha256
tar -xzf koed-core-qualification.tar.gz
```

`handover.json` records source file digests and the included CPU candidate identity.
The CPU archive SHA-256 is `2b55fbe003bd185a20b4bec40c669d95d6606656cf7168d21b82829444d2277e`.
Its llama.cpp revision is `7221e24f579efbb5fd2a2ced1fffaef1aff2fe0d`.
Make sure that the CPU archive matches its supplied checksum, then extract it:

```bash
(
  cd koed-core-qualification
  sha256sum --check koed-native-core-*.tar.gz.sha256
)
mkdir core-extracted
tar -xzf koed-core-qualification/koed-native-core-*.tar.gz -C core-extracted
mkdir evidence
```

## Run the deferred candidate checks

Run these commands only after the Operator releases the CUDA testing deferral.
No dependency installation or repository checkout is required for the fixture tests.
These tests use synthetic files and perform no native execution:

```bash
node --test scripts/native-runtime/cuda-artifact.test.mjs \
  > evidence/cuda-packaging-tests.log 2>&1
```

Require exit code 0 before continuing.
The tests cover repeat packaging, recipe inputs, compatibility, unsafe links, payload boundaries, and size budgets.
They do not establish that a fresh CUDA compilation works.

Build the candidate from the pinned source with the installed toolkit:

```bash
node scripts/native-runtime/build-cuda-addon-linux-x64.mjs \
  --core-dir "$PWD/core-extracted/koed-runtime" \
  --out-dir "$PWD/cuda-candidate" --json \
  > evidence/cuda-build.log 2>&1
```

The output directory must not exist.
The builder uses two compilation jobs and the exclusive directory `/tmp/koed-native-cuda-v1`.
It refuses an existing build directory and removes only the directory it creates.
The source archive digest, toolkit, compiler, flags, and build logic determine the recipe identity.
Postgres inputs and product versions do not enter that identity.

Require exit code 0 and retain `cuda-candidate/cuda-candidate.json`.
Inspect the actual archive against the separate CUDA budgets:

```bash
node scripts/inspect-release-artifact.mjs \
  --path "$PWD"/cuda-candidate/koed-native-cuda-*.tar.gz \
  --platform linux --arch x64 \
  --policy config/release-artifact-size-policy.json \
  --out evidence/cuda-artifact-policy.json --json
```

Require exit code 0 and `policy.ok: true`.
Make sure that the candidate checksum matches, then extract the exact archive:

```bash
(
  cd cuda-candidate
  sha256sum --check koed-native-cuda-*.tar.gz.sha256
)
mkdir cuda-extracted
tar -xzf cuda-candidate/koed-native-cuda-*.tar.gz -C cuda-extracted
node scripts/native-runtime/qualify-cuda-layout-linux-x64.mjs \
  --core-root "$PWD/core-extracted/koed-runtime" \
  --cuda-root "$PWD/cuda-extracted/koed-runtime" \
  --out-dir "$PWD/evidence/layout"
```

Require exit code 0 and `ok: true` in `evidence/layout/cuda-layout-qualification.json`.
This check authenticates both frozen inventories and their exact revision and layout contracts.
It composes temporary selection links without copying payloads or changing an installed runtime.
It checks ELF loaders with a one-minute loader deadline and removes its temporary links.
It does not start Koed, Postgres, an embedding server, or GPU inference.

Repeat packaging from the extracted frozen CUDA payload:

```bash
node scripts/native-runtime/build-cuda-addon-linux-x64.mjs \
  --core-dir "$PWD/core-extracted/koed-runtime" \
  --source-dir "$PWD/cuda-extracted/koed-runtime" \
  --out-dir "$PWD/cuda-repack" --json
cmp cuda-candidate/koed-native-cuda-*.tar.gz cuda-repack/koed-native-cuda-*.tar.gz
```

Require exit code 0 from both commands.
Repeat packaging does not compile or replace provenance.
Identical frozen inputs must produce identical bytes under the same Node runtime.
This requirement does not claim identical fresh compilations on different hosts.

## Return evidence and finish release qualification

Return the original handover digest and all files under `evidence/`.
Include the CUDA archive, checksum, candidate report, OS version, driver version, and GPU model.
Record manual interventions and failed commands, including partial build logs.
Treat missing or failed checks as unresolved acceptance criteria.

After tickets 05, 08, 09, and 10 are complete, use ticket 11's shipped CLI qualification path.
Bind its results to the exact core archive, CUDA archive, and packaged CLI digests.
The remaining release checks include:

- Require device discovery and real CUDA kernels with the installed embedding model.
- Require finite, nonempty vectors with matching dimensions and cosine agreement of at least 0.999 for every input.
- Exercise first installation, combined revision updates, explicit CPU policy, removal, and Postgres-only updates that reuse CUDA bytes.
- Exercise running-runtime refusal, missing models, device failures, external VRAM pressure, and cleanup after failed validation.
- Exercise explicit Operator stop/install/start transitions without automatic service control.
- Publish only after acceptance, then review production pins and repeat the documented path from published packages.

The repository benchmark does not replace that shipped CLI path.
This handover makes no claim about those pending checks.

To reproduce this source bundle from a repository checkout, use the recorded CPU handover:

```bash
node scripts/native-runtime/package-cuda-handover.mjs \
  --core-bundle /absolute/path/to/koed-core-qualification.tar.gz \
  --out-dir /absolute/path/to/new-handover
```

Bundle creation authenticates the CPU handover and records source digests.
It does not import the CUDA builder or execute tests.
