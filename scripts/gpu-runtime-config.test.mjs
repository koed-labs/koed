import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("CPU and CUDA Compose paths remain explicit and independent", () => {
  const cpuDockerfile = read("apps/embedding-service/Dockerfile");
  const cudaDockerfile = read("apps/embedding-service/Dockerfile.cuda");
  const cpuCompose = read("examples/docker-compose/docker-compose.yml");
  const cudaCompose = read("examples/docker-compose/docker-compose.cuda.yml");

  assert.match(cpuDockerfile, /llama\.cpp:server@sha256:[a-f0-9]{64}/);
  assert.match(cpuDockerfile, /KOED_EMBEDDING_ACCELERATION=cpu/);
  assert.match(cpuDockerfile, /KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS=300/);
  assert.doesNotMatch(cpuDockerfile, /server-cuda/);

  assert.match(cudaDockerfile, /llama\.cpp:server-cuda@sha256:[a-f0-9]{64}/);
  assert.match(cudaDockerfile, /KOED_EMBEDDING_ACCELERATION=cuda/);
  assert.match(cudaDockerfile, /KOED_RERANKER_ACCELERATION=cpu/);
  assert.match(cudaDockerfile, /KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS=300/);
  assert.match(cudaDockerfile, /KOED_RERANKER_GPU_IDLE_UNLOAD_SECONDS=300/);

  assert.match(cpuCompose, /KOED_EMBEDDING_ACCELERATION:-cpu/);
  assert.match(cpuCompose, /KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS:-300/);
  assert.match(cudaCompose, /Dockerfile\.cuda/);
  assert.match(cudaCompose, /gpus: all/);
  assert.match(cudaCompose, /KOED_EMBEDDING_ACCELERATION:-cuda/);
  assert.match(cudaCompose, /KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS:-300/);
  assert.match(cudaCompose, /KOED_RERANKER_GPU_IDLE_UNLOAD_SECONDS:-300/);
});

test("Linux native artifact CI installs and requires the pinned CUDA toolkit", () => {
  const workflow = read(".github/workflows/ci.yml");
  const cacheWorkflow = read(
    ".github/workflows/native-runtime-linux-cache.yml"
  );
  const releaseWorkflow = read(".github/workflows/release.yml");
  const linuxJob = workflow
    .split("  native-runtime-linux-x64:")[1]
    .split("  ci-required:")[0];
  const buildScript = read("scripts/native-runtime/build-linux-x64.mjs");

  assert.match(linuxJob, /cuda-toolkit-12-4/);
  assert.match(linuxJob, /CUDA_HOME=\/usr\/local\/cuda-12\.4/);
  assert.match(linuxJob, /sha256sum --check --strict/);
  assert.match(linuxJob, /actions\/cache\/restore@/);
  assert.match(linuxJob, /actions\/cache\/save@/);
  assert.match(linuxJob, /steps\.native-cache\.outputs\.cache-hit != 'true'/);
  assert.match(linuxJob, /Upload verified Linux native runtime artifact/);
  assert.match(cacheWorkflow, /runs-on: ubuntu-22\.04/);
  assert.match(cacheWorkflow, /branches:\n\s+- main/);
  assert.match(
    cacheWorkflow,
    /Validate native runtime payload before use or save/
  );
  assert.match(cacheWorkflow, /Save verified Linux native runtime payload/);
  assert.match(
    releaseWorkflow,
    /Require prebuilt verified native runtime payload/
  );
  assert.match(
    releaseWorkflow,
    /koed-native-runtime-linux-x64-\$\{\{ needs\.release\.outputs\.version \}\}\.provenance\.json/
  );
  const releaseJob = releaseWorkflow
    .split("  native-runtime-linux-x64-release-assets:")[1]
    .split("  unsigned-desktop-release-assets:")[0];
  assert.doesNotMatch(
    `${linuxJob}\n${cacheWorkflow}\n${releaseJob}`,
    /key:[^\n]*(?:loader-validation|validate-runtime)/
  );
  assert.doesNotMatch(releaseJob, /cuda-toolkit|Cold-build/);
  assert.equal(
    releaseJob.match(
      /jq '\{ok, error, errors, timings, contentPolicy, postgresExtensions:/g
    )?.length,
    2,
    "both Linux release validations should preserve top-level errors in compact failure diagnostics"
  );
  assert.doesNotMatch(releaseJob, /run: pnpm native-runtime:validate/);
  assert.match(
    buildScript,
    /Pinned CUDA runtime is required for the Linux x64 artifact/
  );
});
