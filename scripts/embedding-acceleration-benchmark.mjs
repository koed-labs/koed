#!/usr/bin/env node
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  EMBEDDING_BENCHMARK_SCHEMA_VERSION,
  cosineSimilarity,
  embeddingAccelerationBenchmarkUsage,
  parseEmbeddingAccelerationBenchmarkArgs,
  realisticMemoryEventInputs,
  summarizeBackendSamples
} from "./embedding-acceleration-benchmark-lib.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(import.meta.dirname, "..");
const serviceEntry = resolve(
  repoRoot,
  "apps",
  "embedding-service",
  "dist",
  "index.js"
);
const serviceToken = "koed-synthetic-embedding-benchmark";
const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const sha256File = (path) =>
  new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });

const freePort = () =>
  new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });

const processTree = async (rootPid) => {
  try {
    const { stdout } = await execFile("ps", ["-eo", "pid=,ppid=,rss="]);
    const rows = stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).map(Number))
      .filter((row) => row.length === 3 && row.every(Number.isFinite));
    const pids = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (pids.has(parent) && !pids.has(pid)) {
          pids.add(pid);
          changed = true;
        }
      }
    }
    return {
      pids,
      ramMiB:
        rows
          .filter(([pid]) => pids.has(pid))
          .reduce((total, row) => total + (row[2] ?? 0), 0) / 1024
    };
  } catch {
    return { pids: new Set([rootPid]), ramMiB: null };
  }
};

const cudaVramMiB = async (pids) => {
  try {
    const { stdout } = await execFile("nvidia-smi", [
      "--query-compute-apps=pid,used_memory",
      "--format=csv,noheader,nounits"
    ]);
    const matches = stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.split(",").map((value) => Number(value.trim())))
      .filter(([pid, used]) => pids.has(pid) && Number.isFinite(used));
    return matches.length > 0
      ? matches.reduce((total, row) => total + (row[1] ?? 0), 0)
      : null;
  } catch {
    return null;
  }
};

const cudaSystemUsedMiB = async () => {
  try {
    const { stdout } = await execFile("nvidia-smi", [
      "--query-gpu=memory.used",
      "--format=csv,noheader,nounits"
    ]);
    const values = stdout
      .trim()
      .split(/\r?\n/u)
      .map(Number)
      .filter(Number.isFinite);
    return values.length > 0
      ? values.reduce((total, value) => total + value, 0)
      : null;
  } catch {
    return null;
  }
};

const requestEmbedding = async (baseUrl) => {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koed-embedding-token": serviceToken
    },
    body: JSON.stringify({
      texts: realisticMemoryEventInputs.map(({ text }) => text)
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `Embedding request failed with ${response.status}: ${JSON.stringify(payload)}`
    );
  }
  return {
    durationMs: performance.now() - started,
    measuredTokens:
      typeof payload.measuredTokens === "number"
        ? payload.measuredTokens
        : (payload.chunks?.reduce(
            (total, chunk) => total + Number(chunk.tokenCount ?? 0),
            0
          ) ?? 0),
    vectors: payload.vectors
  };
};

const requestCapacityIdentity = async (baseUrl) => {
  const response = await fetch(`${baseUrl}/capacity/identity`, {
    headers: { "x-koed-embedding-token": serviceToken }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `Capacity identity request failed with ${response.status}: ${JSON.stringify(payload)}`
    );
  }
  return payload;
};

const waitHealthy = async (baseUrl, child, timeoutMs = 240_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Embedding Service exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { "x-koed-embedding-token": serviceToken }
      });
      if (response.ok) return await response.json();
    } catch {
      // Startup is bounded by the deadline below.
    }
    await sleep(250);
  }
  throw new Error("Embedding Service did not become healthy in time");
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(5_000)
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      sleep(5_000)
    ]);
  }
};

const runBackend = async (backend, options) => {
  const [servicePort, embeddingPort, rerankerPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort()
  ]);
  const logs = [];
  const baselineCudaVramMiB =
    backend === "cuda" ? await cudaSystemUsedMiB() : null;
  const child = spawn(process.execPath, [serviceEntry], {
    cwd: resolve(repoRoot, "apps", "embedding-service"),
    env: {
      ...process.env,
      MODEL_PATH: options.modelPath,
      LLAMA_SERVER_BINARY: options.llamaServer,
      KOED_EMBEDDING_ACCELERATION: backend,
      KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS: String(options.idleSeconds),
      KOED_EMBEDDING_HOST: "127.0.0.1",
      KOED_EMBEDDING_PORT: String(servicePort),
      LLAMA_EMBEDDING_SERVER_PORT: String(embeddingPort),
      LLAMA_RERANKER_SERVER_PORT: String(rerankerPort),
      EMBEDDING_SERVICE_TOKEN: serviceToken,
      KOED_EMBEDDING_RUNTIME_VERSION: `sha256:${options.runtimeSha256}`,
      LOG_LEVEL: "warning"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const retainLog = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 100) logs.shift();
  };
  child.stdout?.on("data", retainLog);
  child.stderr?.on("data", retainLog);
  const baseUrl = `http://127.0.0.1:${servicePort}`;
  let peakRamMiB = null;
  let peakVramMiB = null;
  let idleVramMiB = null;
  let vramMeasurement = "unavailable";
  const observe = async () => {
    const tree = await processTree(child.pid);
    if (tree.ramMiB !== null) {
      peakRamMiB = Math.max(peakRamMiB ?? 0, tree.ramMiB);
    }
    const vram = backend === "cuda" ? await cudaVramMiB(tree.pids) : null;
    if (vram !== null) {
      peakVramMiB = Math.max(peakVramMiB ?? 0, vram);
      vramMeasurement = "process";
    } else if (backend === "cuda" && baselineCudaVramMiB !== null) {
      const systemUsed = await cudaSystemUsedMiB();
      if (systemUsed !== null) {
        peakVramMiB = Math.max(
          peakVramMiB ?? 0,
          Math.max(0, systemUsed - baselineCudaVramMiB)
        );
        vramMeasurement = "system_delta";
      }
    }
  };
  try {
    const startupStarted = performance.now();
    const health = await waitHealthy(baseUrl, child);
    const startupMs = performance.now() - startupStarted;
    const capacity = await requestCapacityIdentity(baseUrl);
    await observe();
    const cold = await requestEmbedding(baseUrl);
    await observe();
    const warm = [];
    for (let index = 0; index < options.warmIterations; index += 1) {
      warm.push(await requestEmbedding(baseUrl));
      await observe();
    }
    let wake = null;
    if (backend !== "cpu") {
      await sleep((options.idleSeconds + 1) * 1000);
      await observe();
      if (backend === "cuda" && baselineCudaVramMiB !== null) {
        const systemUsed = await cudaSystemUsedMiB();
        idleVramMiB =
          systemUsed === null
            ? null
            : Math.max(0, systemUsed - baselineCudaVramMiB);
      }
      wake = await requestEmbedding(baseUrl);
      await observe();
    }
    return {
      health,
      capacity,
      cold,
      wake,
      warm,
      summary: summarizeBackendSamples({
        backend,
        startupMs,
        cold,
        wake,
        warm,
        peakRamMiB,
        peakVramMiB,
        idleVramMiB,
        vramMeasurement
      })
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${logs.join("").slice(-8_000)}`,
      { cause: error }
    );
  } finally {
    await stopChild(child);
  }
};

let options;
try {
  options = parseEmbeddingAccelerationBenchmarkArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(embeddingAccelerationBenchmarkUsage());
  process.exit(2);
}
if (options.help) {
  process.stdout.write(embeddingAccelerationBenchmarkUsage());
  process.exit(0);
}
for (const [name, path] of [
  ["Embedding model", options.modelPath],
  ["llama-server", options.llamaServer],
  ["Embedding Service build", serviceEntry]
]) {
  if (!existsSync(path)) throw new Error(`${name} is missing: ${path}`);
}
options.runtimeSha256 = await sha256File(options.llamaServer);

const cpu = await runBackend("cpu", options);
const gpu = await runBackend(options.gpuBackend, options);
const vectorAgreement = realisticMemoryEventInputs.map((input, index) => ({
  inputId: input.id,
  cosineSimilarity: cosineSimilarity(
    cpu.cold.vectors[index] ?? [],
    gpu.cold.vectors[index] ?? []
  )
}));
const report = {
  schemaVersion: EMBEDDING_BENCHMARK_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  model: cpu.health.modelKey,
  dimensions: cpu.health.dimensions,
  modelArtifactHash: cpu.health.artifactHash,
  modelArtifactRevision: cpu.health.artifactRevision,
  runtime: {
    cpu: {
      version: cpu.capacity.runtimeVersion,
      backendClass: cpu.capacity.backendClass,
      settingsFingerprint: cpu.capacity.settingsFingerprint
    },
    gpu: {
      version: gpu.capacity.runtimeVersion,
      backendClass: gpu.capacity.backendClass,
      settingsFingerprint: gpu.capacity.settingsFingerprint
    }
  },
  inputClasses: realisticMemoryEventInputs.map(({ id, targetTokens }) => ({
    id,
    targetTokens
  })),
  cpu: cpu.summary,
  gpu: gpu.summary,
  speedup:
    cpu.summary.warm.tokensPerSecond && gpu.summary.warm.tokensPerSecond
      ? gpu.summary.warm.tokensPerSecond / cpu.summary.warm.tokensPerSecond
      : null,
  vectorAgreement
};
if (options.output) {
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  });
}
if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(
    [
      `Embedding acceleration benchmark (${report.model}, ${report.dimensions} dimensions)`,
      `CPU: startup ${report.cpu.startupMs.toFixed(0)} ms, cold ${report.cpu.coldRequestMs.toFixed(0)} ms, warm ${report.cpu.warm.tokensPerSecond?.toFixed(1)} tokens/s`,
      `${options.gpuBackend.toUpperCase()}: startup ${report.gpu.startupMs.toFixed(0)} ms, cold ${report.gpu.coldRequestMs.toFixed(0)} ms, wake ${report.gpu.idleWakeRequestMs?.toFixed(0)} ms, warm ${report.gpu.warm.tokensPerSecond?.toFixed(1)} tokens/s`,
      `Warm speedup: ${report.speedup?.toFixed(2)}x`,
      `Minimum CPU/GPU cosine agreement: ${Math.min(...vectorAgreement.map(({ cosineSimilarity }) => cosineSimilarity ?? 0)).toFixed(6)}`,
      options.output ? `Report: ${options.output}` : ""
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}
