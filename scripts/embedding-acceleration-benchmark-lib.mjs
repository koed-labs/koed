import { homedir, platform } from "node:os";
import { resolve } from "node:path";

export const EMBEDDING_BENCHMARK_SCHEMA_VERSION = 1;
export const DEFAULT_WARM_ITERATIONS = 3;
export const DEFAULT_IDLE_SECONDS = 2;

const memoryEventParagraph =
  "The project discussion compared the current implementation with the accepted architecture, recorded the selected approach, identified the affected modules, and described the focused validation needed before release. The agent inspected existing code, changed only the owned runtime boundary, ran typechecking and integration tests, and recorded the remaining operational evidence without including credentials or private source data.";

export const realisticMemoryEventInputs = [256, 1024, 2048].map(
  (targetTokens, index) => ({
    id: `synthetic-memory-event-${index + 1}`,
    targetTokens,
    text: Array.from(
      { length: Math.ceil(targetTokens / 55) },
      () => memoryEventParagraph
    ).join(" ")
  })
);

const positiveInteger = (value, name) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const requiredValue = (args, index, name) => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
};

export const embeddingAccelerationBenchmarkUsage = () => `Usage:
  pnpm embedding:benchmark -- [options]

Options:
  --model-path <path>       Pinned embedding GGUF (default KOED_HOME model)
  --llama-server <path>     Verified llama-server binary (or LLAMA_SERVER_BINARY)
  --gpu-backend <backend>   cuda on Linux/WSL, metal on macOS
  --warm-iterations <n>     Warm requests per backend (default ${DEFAULT_WARM_ITERATIONS})
  --idle-seconds <n>        GPU idle unload delay used by this benchmark (default ${DEFAULT_IDLE_SECONDS})
  --output <path>           Write the JSON report to this path
  --json                    Print JSON instead of the concise report
`;

export const parseEmbeddingAccelerationBenchmarkArgs = (
  argv,
  environment = process.env,
  hostPlatform = platform()
) => {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const koedHome = environment.KOED_HOME?.trim() || resolve(homedir(), ".koed");
  const options = {
    modelPath:
      environment.KOED_EMBEDDING_MODEL_PATH?.trim() ||
      resolve(koedHome, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
    llamaServer:
      environment.LLAMA_SERVER_BINARY?.trim() ||
      environment.KOED_EMBEDDING_LLAMA_SERVER_BIN?.trim() ||
      "",
    gpuBackend: hostPlatform === "darwin" ? "metal" : "cuda",
    warmIterations: DEFAULT_WARM_ITERATIONS,
    idleSeconds: DEFAULT_IDLE_SECONDS,
    output: null,
    json: false,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--model-path") {
      options.modelPath = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--llama-server") {
      options.llamaServer = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--gpu-backend") {
      options.gpuBackend = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--warm-iterations") {
      options.warmIterations = positiveInteger(
        requiredValue(args, index, arg),
        arg
      );
      index += 1;
    } else if (arg === "--idle-seconds") {
      options.idleSeconds = positiveInteger(
        requiredValue(args, index, arg),
        arg
      );
      index += 1;
    } else if (arg === "--output") {
      options.output = requiredValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.help && !options.llamaServer) {
    throw new Error(
      "--llama-server or LLAMA_SERVER_BINARY is required for the benchmark"
    );
  }
  if (!new Set(["cuda", "metal"]).has(options.gpuBackend)) {
    throw new Error("--gpu-backend must be cuda or metal");
  }
  return options;
};

export const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  ];
};

export const cosineSimilarity = (left, right) => {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? null : dot / denominator;
};

export const summarizeBackendSamples = ({
  backend,
  startupMs,
  cold,
  wake,
  warm,
  peakRamMiB,
  peakVramMiB,
  idleVramMiB = null,
  vramMeasurement = "unavailable"
}) => {
  const warmLatencies = warm.map((sample) => sample.durationMs);
  const totalWarmTokens = warm.reduce(
    (total, sample) => total + sample.measuredTokens,
    0
  );
  const totalWarmMs = warmLatencies.reduce((total, value) => total + value, 0);
  return {
    backend,
    startupMs,
    coldRequestMs: cold.durationMs,
    idleWakeRequestMs: wake?.durationMs ?? null,
    warm: {
      iterations: warm.length,
      p50Ms: percentile(warmLatencies, 0.5),
      p95Ms: percentile(warmLatencies, 0.95),
      measuredTokens: totalWarmTokens,
      tokensPerSecond:
        totalWarmMs > 0 ? totalWarmTokens / (totalWarmMs / 1000) : null
    },
    peakRamMiB,
    peakVramMiB,
    idleVramMiB,
    vramMeasurement
  };
};
