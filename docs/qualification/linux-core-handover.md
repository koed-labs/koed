# Linux CPU core qualification handover

This bundle tests one exact CPU candidate. It contains the archive, its digests,
candidate metadata, and a standalone Node runner. It needs no checkout or npm
dependencies. CUDA testing remains deferred. This CPU report cannot authorize
CUDA publication or prove the release-provider installation path.

Use an unprivileged account on Linux x64 with glibc 2.35 or later and Node
24.13.1. Install `tar`, `sha256sum`, `ldd`, and OpenSSL 3 system libraries.
Use a disposable directory with at least 1 GB free, excluding the model.
Keep the model outside the bundle. The runner requires the already-installed
`Qwen3-Embedding-0.6B-Q8_0.gguf` model with SHA-256
`06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`.

Before extracting this bundle, compare its SHA-256 with the handover sender's
record. In the extracted `koed-core-qualification` directory, run:

```bash
sha256sum --check --strict koed-native-core-*.tar.gz.sha256
mkdir extracted
tar -xzf koed-native-core-*.tar.gz -C extracted
node scripts/native-runtime/qualify-core-linux-x64.mjs \
  --runtime-root "$PWD/extracted/koed-runtime" \
  --model-path /absolute/path/to/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --out-dir "$PWD/evidence"
```

Use a new extraction and evidence directory for each run. The runner verifies
the complete inventory before executing binaries. It checks all ELF loaders,
launcher policies, Postgres initialization and restart, both required extensions,
and two CPU embeddings through the composed selection links. It uses temporary
data and isolated ports. It does not download models, start Koed, access existing
database data, or run a CUDA binary.

Success requires exit code 0 and `ok: true` in `evidence/qualification.json`.
The deadline is three minutes plus bounded process cleanup. On failure, retain
the evidence and read the recorded error. A `cleanupError` preserves temporary
probe data for inspection. Do not delete that directory until its own probe
processes stop. The runner never stops unrelated services.

Return `core-candidate.json`, `evidence/qualification.json`,
`evidence/postgres.log`, and `evidence/embedding.log`. Record the bundle digest,
OS version, and any manual intervention. Do not label the candidate as production
qualified if a required check fails.

To create this bundle from a frozen candidate in a repository checkout:

```bash
node scripts/native-runtime/package-core-qualification.mjs \
  --candidate-dir /absolute/path/to/candidate \
  --out-dir /absolute/path/to/new-handover
```

Send `koed-core-qualification.tar.gz` and its checksum from the output directory.
Bundle creation verifies identical frozen packaging and performs no native test.
