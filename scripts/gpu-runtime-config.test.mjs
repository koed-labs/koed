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
  assert.doesNotMatch(cpuDockerfile, /server-cuda/);

  assert.match(cudaDockerfile, /llama\.cpp:server-cuda@sha256:[a-f0-9]{64}/);
  assert.match(cudaDockerfile, /KOED_EMBEDDING_ACCELERATION=cuda/);
  assert.match(cudaDockerfile, /KOED_RERANKER_ACCELERATION=cpu/);

  assert.match(cpuCompose, /KOED_EMBEDDING_ACCELERATION:-cpu/);
  assert.match(cudaCompose, /Dockerfile\.cuda/);
  assert.match(cudaCompose, /gpus: all/);
  assert.match(cudaCompose, /KOED_EMBEDDING_ACCELERATION:-cuda/);
});

test("Linux native artifact CI installs and requires the pinned CUDA toolkit", () => {
  const workflow = read(".github/workflows/ci.yml");
  const linuxJob = workflow
    .split("  native-runtime-linux-x64:")[1]
    .split("  ci-required:")[0];
  const buildScript = read("scripts/native-runtime/build-linux-x64.mjs");

  assert.match(linuxJob, /cuda-toolkit-12-4/);
  assert.match(linuxJob, /CUDA_HOME=\/usr\/local\/cuda-12\.4/);
  assert.match(linuxJob, /sha256sum --check --strict/);
  assert.match(
    buildScript,
    /Pinned CUDA runtime is required for the Linux x64 artifact/
  );
});
