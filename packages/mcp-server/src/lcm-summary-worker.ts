import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkTextForModel, countTokensForModel } from "@koed/core";
import type { MemoryApiClient } from "./index.js";

const CODEX_SUMMARY_PROVIDER = "codex";
const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_TOKENS = 48_000;
const SUMMARY_WORKER_ID = `mcp-lcm:${randomUUID()}`;
const PI_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);
export const LCM_SUMMARY_PROMPT_VERSION = "lcm-codex-summary-v1";

export interface LcmSummaryWorkerConfig {
  provider: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  concurrency: number;
  maxPromptTokens: number;
  codexBinary: string;
  piBinary: string;
  piModelFamilies: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PiDiscoveredModel {
  provider: string;
  model: string;
  family: string;
  score: number;
}

interface LcmSourceItem {
  kind?: string;
  sourceTable?: string;
  sourceId?: string;
  nodeId?: string;
  visibility?: string;
  actor?: string;
  turnId?: string | null;
  createdAt?: string;
  text?: string;
  payload?: unknown;
  position?: number;
}

export interface LcmSummaryNode {
  id: string;
  visibility: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  sourceItems: LcmSourceItem[];
  sourceTokenEstimate: number | null;
}

export interface LcmSummaryResult {
  nodeId: string;
  kind: "leaf" | "rollup";
  depth: number;
  submitted: boolean;
  summaryModel?: string;
  promptTokenEstimate?: number;
  maxPromptTokenEstimate?: number;
  promptCallCount?: number;
  summaryTokenEstimate?: number;
  error?: string;
}

export type LcmSummaryRunner = (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  timeoutMs: number
) => Promise<{ text: string; model: string }>;

const resolveEnvValue = (
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

const integerEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const value = Number.parseInt(resolveEnvValue(env, name) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

export const resolveLcmSummaryWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<
    Pick<
      LcmSummaryWorkerConfig,
      | "provider"
      | "model"
      | "reasoningEffort"
      | "timeoutMs"
      | "maxAttempts"
      | "retryDelayMs"
      | "concurrency"
      | "maxPromptTokens"
      | "codexBinary"
      | "piBinary"
      | "piModelFamilies"
      | "cwd"
    >
  > = {}
): LcmSummaryWorkerConfig => {
  const configuredCodexBinary = resolveEnvValue(env, "MEMORY_LCM_CODEX_BINARY");
  const configuredPiBinary = resolveEnvValue(env, "MEMORY_LCM_PI_BINARY");
  const codexBinary =
    configuredCodexBinary ??
    (process.platform === "win32" ? "codex.cmd" : "codex");
  const piBinary =
    configuredPiBinary ?? (process.platform === "win32" ? "pi.cmd" : "pi");
  const configuredPiFamilies = resolveEnvValue(
    env,
    "MEMORY_LCM_PI_MODEL_FAMILIES"
  )
    ?.split(",")
    .map((family) => family.trim())
    .filter(Boolean);
  return {
    provider:
      overrides.provider ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_PROVIDER")?.toLowerCase() ??
      CODEX_SUMMARY_PROVIDER,
    model:
      overrides.model ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_MODEL") ??
      "gpt-5.4-mini",
    reasoningEffort:
      overrides.reasoningEffort ??
      resolveEnvValue(env, "MEMORY_LCM_SUMMARY_REASONING_EFFORT") ??
      "medium",
    timeoutMs:
      overrides.timeoutMs ??
      integerEnv(
        env,
        "MEMORY_LCM_SUMMARY_TIMEOUT_MS",
        DEFAULT_SUMMARY_TIMEOUT_MS
      ),
    maxAttempts: Math.max(
      1,
      overrides.maxAttempts ??
        integerEnv(env, "MEMORY_LCM_SUMMARY_MAX_ATTEMPTS", 2)
    ),
    retryDelayMs: Math.max(
      0,
      overrides.retryDelayMs ??
        integerEnv(env, "MEMORY_LCM_SUMMARY_RETRY_DELAY_MS", 2_000)
    ),
    concurrency: Math.max(
      1,
      overrides.concurrency ??
        integerEnv(env, "MEMORY_LCM_SUMMARY_CONCURRENCY", 1)
    ),
    maxPromptTokens: Math.max(
      1_000,
      overrides.maxPromptTokens ??
        integerEnv(
          env,
          "MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS",
          DEFAULT_MAX_PROMPT_TOKENS
        )
    ),
    codexBinary: overrides.codexBinary ?? codexBinary,
    piBinary: overrides.piBinary ?? piBinary,
    piModelFamilies:
      overrides.piModelFamilies ??
      configuredPiFamilies ??
      [],
    cwd: overrides.cwd ?? process.cwd(),
    env
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const lcmSummaryLockPath = (env: NodeJS.ProcessEnv): string =>
  resolveEnvValue(env, "MEMORY_LCM_SUMMARY_LOCK_PATH") ??
  path.join(os.homedir(), ".koed", "lcm-summary.lock");

export const lcmSummaryLockState = (
  env: NodeJS.ProcessEnv,
  staleMs: number
): { locked: boolean; stale: boolean } => {
  const lockPath = lcmSummaryLockPath(env);
  try {
    const stats = fs.statSync(lockPath);
    const stale = Date.now() - stats.mtimeMs > staleMs;
    return { locked: !stale, stale };
  } catch {
    return { locked: false, stale: false };
  }
};

const acquireLocalSummaryLock = (
  env: NodeJS.ProcessEnv,
  staleMs: number
): (() => void) | null => {
  const lockPath = lcmSummaryLockPath(env);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const stats = fs.statSync(lockPath);
    if (Date.now() - stats.mtimeMs > staleMs) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Missing lock is the normal path.
  }

  try {
    const handle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(
      handle,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString()
      })
    );
    fs.closeSync(handle);
    return () => {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    };
  } catch {
    return null;
  }
};

const normalizeForPrompt = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const itemAnchor = (item: LcmSourceItem): string =>
  [
    item.kind,
    item.sourceTable && item.sourceId
      ? `source:${item.sourceTable}:${item.sourceId}`
      : undefined,
    item.nodeId ? `node:${item.nodeId}` : undefined,
    item.turnId ? `turn:${item.turnId}` : undefined,
    item.createdAt ? `created:${item.createdAt}` : undefined,
    item.position === undefined ? undefined : `position:${item.position}`
  ]
    .filter(Boolean)
    .join(" ");

const itemText = (item: LcmSourceItem): string => {
  const label =
    item.kind === "lcm_child"
      ? "child summary"
      : item.actor
        ? item.actor
        : (item.kind ?? "source");
  const payload =
    item.payload === undefined
      ? ""
      : ` payload:${normalizeForPrompt(JSON.stringify(item.payload))}`;
  return `- [${itemAnchor(item)}] ${label}: ${normalizeForPrompt(
    item.text ?? ""
  )}${payload}`;
};

export const buildLcmSummaryPrompt = (
  node: LcmSummaryNode,
  mode: "summary" | "partial" | "reduce" = "summary"
): string => {
  const isRollup =
    node.kind === "rollup" ||
    node.sourceItems.some((item) => item.kind === "lcm_child");
  const header =
    mode === "partial"
      ? [
          "You are a private local LCM summarisation worker running through the user's configured local AI client.",
          "Summarize this token-bounded shard of one larger LCM node.",
          "",
          "Requirements:",
          "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads from this shard.",
          "- Keep provenance hints such as node IDs, source spans, turn IDs, and chunk indexes when useful.",
          "- Do not add anything that is not supported by this shard.",
          "- Return only the shard summary text, with no preamble."
        ]
      : mode === "reduce"
        ? [
            "You are a private local LCM summarisation worker running through the user's configured local AI client.",
            "Combine these shard summaries into one coherent LCM summary.",
            "",
            "Requirements:",
            "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads.",
            "- Keep provenance hints such as node IDs, source spans, turn IDs, and chunk indexes when useful.",
            "- Do not add anything that is not supported by the shard summaries.",
            "- Return only the final summary text, with no preamble."
          ]
        : isRollup
          ? [
              "You are a private local LCM summarisation worker running through the user's configured local AI client.",
              "Roll up these child LCM summaries into a higher-level memory graph summary.",
              "",
              "Requirements:",
              "- Preserve durable decisions, facts, implementation details, exact identifiers, and open threads.",
              "- Keep provenance hints such as node IDs, source spans, and turn IDs when useful.",
              "- Do not add anything that is not supported by the child summaries.",
              "- Return only the summary text, with no preamble."
            ]
          : [
              "You are a private local LCM summarisation worker running through the user's configured local AI client.",
              "Summarize this captured memory span for a lossless context memory graph.",
              "",
              "Requirements:",
              "- Preserve concrete user requests, decisions, facts, filenames, commands, model names, tool outcomes, errors, and unresolved questions.",
              "- Mention source items in the same order they occurred when they affect meaning.",
              "- Do not invent details. If a source item is ambiguous, say so compactly.",
              "- Write a compact but information-dense summary for future agent retrieval.",
              "- Return only the summary text, with no preamble."
            ];

  const placeholderSection =
    mode === "summary"
      ? ["Existing deterministic placeholder summary:", node.summaryText, ""]
      : [
          "Existing deterministic placeholder summary:",
          "(omitted from this token-bounded prompt; exact source items or shard summaries below are authoritative)",
          ""
        ];

  return [
    ...header,
    "",
    `LCM node: ${node.id}`,
    `Kind: ${node.kind}`,
    `Depth: ${node.depth}`,
    `Visibility: ${node.visibility}`,
    `Source token estimate: ${node.sourceTokenEstimate ?? "unknown"}`,
    "",
    ...placeholderSection,
    "Exact ordered source outline:",
    ...node.sourceItems.map(itemText)
  ].join("\n");
};

const promptTokens = (prompt: string, config: LcmSummaryWorkerConfig): number =>
  countTokensForModel(prompt, { model: config.model }).tokens;

const objectPayload = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const chunkSourceItems = (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  itemTextTokenBudget: number
): LcmSourceItem[] =>
  node.sourceItems.flatMap((item) => {
    const text = item.text ?? "";
    const chunks: string[] = chunkTextForModel(text, {
      model: config.model,
      maxTokens: itemTextTokenBudget
    });
    if (chunks.length <= 1) {
      return [{ ...item, text: chunks[0] ?? text }];
    }
    return chunks.map((chunk, index) => ({
      ...item,
      text: chunk,
      payload: {
        ...objectPayload(item.payload),
        sourceChunkIndex: index,
        sourceChunkCount: chunks.length
      }
    }));
  });

const nodeWithItems = (
  node: LcmSummaryNode,
  sourceItems: LcmSourceItem[]
): LcmSummaryNode => ({
  ...node,
  sourceItems
});

const buildTokenBoundedPrompts = (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  mode: "partial" | "reduce"
): string[] => {
  const maxPromptTokens = config.maxPromptTokens;
  let itemTextTokenBudget = Math.max(256, Math.floor(maxPromptTokens * 0.45));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const expandedItems = chunkSourceItems(node, config, itemTextTokenBudget);
    const prompts: string[] = [];
    let currentItems: LcmSourceItem[] = [];
    let oversizedSinglePrompt = false;

    for (const item of expandedItems) {
      const candidateItems = [...currentItems, item];
      const candidatePrompt = buildLcmSummaryPrompt(
        nodeWithItems(node, candidateItems),
        mode
      );
      if (promptTokens(candidatePrompt, config) <= maxPromptTokens) {
        currentItems = candidateItems;
        continue;
      }

      if (currentItems.length > 0) {
        prompts.push(
          buildLcmSummaryPrompt(nodeWithItems(node, currentItems), mode)
        );
        currentItems = [item];
        const singlePrompt = buildLcmSummaryPrompt(
          nodeWithItems(node, currentItems),
          mode
        );
        if (promptTokens(singlePrompt, config) > maxPromptTokens) {
          oversizedSinglePrompt = true;
          break;
        }
        continue;
      }

      oversizedSinglePrompt = true;
      break;
    }

    if (!oversizedSinglePrompt) {
      if (currentItems.length > 0) {
        prompts.push(
          buildLcmSummaryPrompt(nodeWithItems(node, currentItems), mode)
        );
      }
      if (
        prompts.length > 0 &&
        prompts.every(
          (prompt) => promptTokens(prompt, config) <= maxPromptTokens
        )
      ) {
        return prompts;
      }
    }

    itemTextTokenBudget = Math.max(64, Math.floor(itemTextTokenBudget / 2));
  }

  throw new Error(
    `LCM node ${node.id} cannot fit within ${maxPromptTokens} prompt tokens after token chunking`
  );
};

const buildSummaryPrompts = (
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig
): Array<{ prompt: string; mode: "summary" | "partial" | "reduce" }> => {
  const prompt = buildLcmSummaryPrompt(node);
  if (promptTokens(prompt, config) <= config.maxPromptTokens) {
    return [{ prompt, mode: "summary" }];
  }
  return buildTokenBoundedPrompts(node, config, "partial").map((bounded) => ({
    prompt: bounded,
    mode: "partial"
  }));
};

const normalizedFamily = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");

const piThinkingLevel = (reasoningEffort: string): string => {
  const normalized = reasoningEffort.trim().toLowerCase();
  if (PI_THINKING_LEVELS.has(normalized)) {
    return normalized;
  }
  if (normalized === "low") {
    return "minimal";
  }
  if (normalized === "high") {
    return "medium";
  }
  return "low";
};

const scorePiModelCandidate = (family: string, model: string): number => {
  const normalizedModel = normalizedFamily(model);
  const normalized = normalizedFamily(family);
  if (normalizedModel === normalized) {
    return 100;
  }
  if (normalizedModel.startsWith(`${normalized}-`)) {
    return 90;
  }
  if (normalizedModel.includes(normalized)) {
    return 80;
  }
  if (
    normalized === "gemini-3-flash" &&
    /gemini-3(?:-5)?-flash/.test(normalizedModel)
  ) {
    return 70;
  }
  return 0;
};

export const parsePiListModelsOutput = (
  output: string,
  family: string
): PiDiscoveredModel[] => {
  const discovered: PiDiscoveredModel[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^provider\s+model\b/i.test(line)) {
      continue;
    }
    const [provider, model] = line.split(/\s{2,}/, 3);
    if (!provider || !model) {
      continue;
    }
    const score = scorePiModelCandidate(family, model);
    if (score <= 0) {
      continue;
    }
    discovered.push({ provider, model, family, score });
  }
  return discovered;
};

const runLocalCommand = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    stdin?: string;
  }
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      handler: () => void,
      error?: unknown
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        handler();
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(
        () => undefined,
        new Error(
          `${command} ${args[0] ?? ""}`.trim() +
            ` timed out after ${options.timeoutMs}ms`
        )
      );
    }, options.timeoutMs);

    child.once("error", (error) => {
      finish(() => undefined, error);
    });

    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
          reject(
            new Error(
              `${command} exited with code ${code ?? "unknown"}${suffix}`
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    if (options.stdin !== undefined) {
      child.stdin!.end(options.stdin);
    }
  });

const discoverPiModelCandidates = async (
  config: LcmSummaryWorkerConfig
): Promise<PiDiscoveredModel[]> => {
  const discovered: PiDiscoveredModel[] = [];
  const discoveryErrors: string[] = [];
  const seen = new Set<string>();
  for (const family of config.piModelFamilies) {
    try {
      const { stdout } = await runLocalCommand(
        config.piBinary,
        ["--list-models", family],
        {
          cwd: config.cwd,
          env: config.env,
          timeoutMs: Math.min(config.timeoutMs, 8_000)
        }
      );
      for (const candidate of parsePiListModelsOutput(stdout, family)) {
        const key = `${candidate.provider}\u0000${candidate.model}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        discovered.push(candidate);
      }
    } catch (error) {
      discoveryErrors.push(
        `${family}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  discovered.sort((left, right) => {
    const familyOrder =
      config.piModelFamilies.indexOf(left.family) -
      config.piModelFamilies.indexOf(right.family);
    return familyOrder !== 0 ? familyOrder : right.score - left.score;
  });
  if (discovered.length === 0 && discoveryErrors.length > 0) {
    throw new Error(
      `Pi model discovery failed: ${discoveryErrors.join("; ")}`
    );
  }
  return discovered;
};

const runPiWithCandidate = async (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  timeoutMs: number,
  candidate: PiDiscoveredModel
): Promise<{ text: string; model: string }> => {
  const args = [
    "-p",
    "--provider",
    candidate.provider,
    "--model",
    candidate.model,
    "--thinking",
    piThinkingLevel(config.reasoningEffort),
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt",
    "You are a private local LCM summarisation worker. Return only the final summary text.",
    prompt
  ];
  const { stdout } = await runLocalCommand(config.piBinary, args, {
    cwd: config.cwd,
    env: config.env,
    timeoutMs
  });
  const text = stdout.trim();
  if (!text) {
    throw new Error(
      `Pi LCM summary produced empty output for ${candidate.provider}/${candidate.model}`
    );
  }
  return {
    text,
    model: `pi:${candidate.provider}/${candidate.model}:${piThinkingLevel(
      config.reasoningEffort
    )}`
  };
};

const createPiLcmSummaryRunner = (
  config: LcmSummaryWorkerConfig
): LcmSummaryRunner => {
  let discoveryPromise: Promise<PiDiscoveredModel[]> | undefined;
  let preferredCandidateKey: string | undefined;
  const candidates = async () => {
    if (!discoveryPromise) {
      discoveryPromise = discoverPiModelCandidates(config);
    }
    const discovered = await discoveryPromise;
    if (!preferredCandidateKey) {
      return discovered;
    }
    return [...discovered].sort((left, right) => {
      const leftPreferred =
        `${left.provider}\u0000${left.model}` === preferredCandidateKey ? 1 : 0;
      const rightPreferred =
        `${right.provider}\u0000${right.model}` === preferredCandidateKey ? 1 : 0;
      return rightPreferred - leftPreferred;
    });
  };

  return async (prompt, runnerConfig, timeoutMs) => {
    const failures: string[] = [];
    for (const candidate of await candidates()) {
      try {
        const result = await runPiWithCandidate(
          prompt,
          runnerConfig,
          timeoutMs,
          candidate
        );
        preferredCandidateKey = `${candidate.provider}\u0000${candidate.model}`;
        return result;
      } catch (error) {
        failures.push(
          `${candidate.provider}/${candidate.model}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    throw new Error(
      failures.length > 0
        ? `Pi LCM summary failed after trying ${failures.length} model candidate(s): ${failures.join("; ")}`
        : "Pi LCM summary could not find any suitable models from `pi --list-models`."
    );
  };
};

const createAutoLcmSummaryRunner = (
  config: LcmSummaryWorkerConfig
): LcmSummaryRunner => {
  const piRunner = createPiLcmSummaryRunner(config);
  return async (prompt, runnerConfig, timeoutMs) => {
    const failures: string[] = [];
    try {
      return await runCodexLcmSummary(prompt, runnerConfig, timeoutMs);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    try {
      return await piRunner(prompt, runnerConfig, timeoutMs);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    throw new Error(
      `Local LCM summary failed for providers codex and pi: ${failures.join("; ")}`
    );
  };
};

export const resolveLcmSummaryRunner = (
  config: LcmSummaryWorkerConfig
): LcmSummaryRunner => {
  switch (config.provider) {
    case "codex":
      return runCodexLcmSummary;
    case "pi":
      return createPiLcmSummaryRunner(config);
    case "auto":
      return createAutoLcmSummaryRunner(config);
    default:
      throw new Error(
        `Unsupported local LCM summary provider: ${config.provider}`
      );
  }
};

export const runCodexLcmSummary: LcmSummaryRunner = (
  prompt,
  config,
  timeoutMs
) =>
  new Promise((resolve, reject) => {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-lcm-summary-")
    );
    const outputFile = path.join(tempDirectory, "summary.txt");
    const args = [
      "exec",
      "-m",
      config.model,
      "-c",
      `reasoning_effort="${config.reasoningEffort}"`,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-C",
      config.cwd,
      "--output-last-message",
      outputFile,
      "-"
    ];
    const child = spawn(config.codexBinary, args, {
      cwd: config.cwd,
      env: config.env,
      stdio: ["pipe", "ignore", "ignore"],
      shell: process.platform === "win32",
      windowsHide: true
    });

    let settled = false;
    const cleanup = () => {
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      cleanup();
      reject(new Error(`Codex LCM summary timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error(
            `Codex LCM summary exited with code ${code ?? "unknown"}`
          );
        }
        const text = fs.existsSync(outputFile)
          ? fs.readFileSync(outputFile, "utf8").trim()
          : "";
        if (text.length === 0) {
          throw new Error("Codex LCM summary produced empty output");
        }
        resolve({
          text,
          model: `codex:${config.model}:${config.reasoningEffort}`
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        cleanup();
      }
    });

    child.stdin.end(prompt);
  });

const runPromptWithRetries = async (
  prompt: string,
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner
): Promise<{ text: string; model: string }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await runner(prompt, config, config.timeoutMs * attempt);
    } catch (error) {
      lastError = error;
      if (attempt < config.maxAttempts && config.retryDelayMs > 0) {
        await sleep(config.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
};

const reduceShardSummaries = async (
  node: LcmSummaryNode,
  shardSummaries: Array<{ text: string; model: string }>,
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner,
  stats: {
    promptTokenSum: number;
    maxPromptTokens: number;
    promptCallCount: number;
  }
): Promise<{ text: string; model: string }> => {
  if (shardSummaries.length === 1) {
    return shardSummaries[0]!;
  }

  const reduceNode: LcmSummaryNode = {
    ...node,
    sourceItems: shardSummaries.map((summary, index) => ({
      kind: "lcm_child",
      nodeId: `${node.id}:shard-${index}`,
      visibility: node.visibility,
      text: summary.text,
      payload: {
        shardIndex: index,
        shardCount: shardSummaries.length,
        sourceSummaryModel: summary.model
      },
      position: index
    }))
  };
  const reducePrompts = buildTokenBoundedPrompts(reduceNode, config, "reduce");
  const nextSummaries: Array<{ text: string; model: string }> = [];

  for (const prompt of reducePrompts) {
    const tokens = promptTokens(prompt, config);
    stats.promptTokenSum += tokens;
    stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
    stats.promptCallCount += 1;
    nextSummaries.push(await runPromptWithRetries(prompt, config, runner));
  }

  if (nextSummaries.length === shardSummaries.length) {
    throw new Error(
      `LCM node ${node.id} reduce step did not shrink ${shardSummaries.length} shard summaries`
    );
  }

  return reduceShardSummaries(node, nextSummaries, config, runner, stats);
};

const summarizeNode = async (
  client: MemoryApiClient,
  node: LcmSummaryNode,
  config: LcmSummaryWorkerConfig,
  runner: LcmSummaryRunner
): Promise<LcmSummaryResult> => {
  const stats = {
    promptTokenSum: 0,
    maxPromptTokens: 0,
    promptCallCount: 0
  };

  try {
    const prompts = buildSummaryPrompts(node, config);
    const shardSummaries: Array<{ text: string; model: string }> = [];
    for (const entry of prompts) {
      const tokens = promptTokens(entry.prompt, config);
      stats.promptTokenSum += tokens;
      stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
      stats.promptCallCount += 1;
      shardSummaries.push(
        await runPromptWithRetries(entry.prompt, config, runner)
      );
    }
    const result =
      prompts.length === 1
        ? shardSummaries[0]!
        : await reduceShardSummaries(
            node,
            shardSummaries,
            config,
            runner,
            stats
          );
    const summaryText = result.text.trim();
    const summaryTokens = countTokensForModel(summaryText, {
      model: config.model
    });
    await client.submitLcmSummary(node.id, {
      workerId: SUMMARY_WORKER_ID,
      summaryText,
      summaryModel: result.model,
      summaryPromptVersion: LCM_SUMMARY_PROMPT_VERSION,
      summaryTokenEstimate: summaryTokens.tokens
    });
    return {
      nodeId: node.id,
      kind: node.kind,
      depth: node.depth,
      submitted: true,
      summaryModel: result.model,
      promptTokenEstimate: stats.promptTokenSum,
      maxPromptTokenEstimate: stats.maxPromptTokens,
      promptCallCount: stats.promptCallCount,
      summaryTokenEstimate: summaryTokens.tokens
    };
  } catch (error) {
    return {
      nodeId: node.id,
      kind: node.kind,
      depth: node.depth,
      submitted: false,
      promptTokenEstimate: stats.promptTokenSum,
      maxPromptTokenEstimate: stats.maxPromptTokens,
      promptCallCount: stats.promptCallCount,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]!);
      }
    }
  );
  await Promise.all(runners);
  return results;
};

export const summarizePendingLcmNodes = async (
  client: MemoryApiClient,
  options: {
    limit?: number;
    config?: LcmSummaryWorkerConfig;
    runner?: LcmSummaryRunner;
  } = {}
) => {
  const config = options.config ?? resolveLcmSummaryWorkerConfig();
  const runner = options.runner ?? resolveLcmSummaryRunner(config);
  const requestedLimit = options.limit ?? 10;
  const releaseLock = acquireLocalSummaryLock(
    config.env,
    Math.max(config.timeoutMs * config.maxAttempts * requestedLimit, 1_800_000)
  );
  if (!releaseLock) {
    return {
      requestedLimit,
      processedCount: 0,
      submittedCount: 0,
      failedCount: 0,
      skippedReason: "already_running",
      localOnly: true,
      config: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        concurrency: config.concurrency,
        maxPromptTokens: config.maxPromptTokens,
        codexBinary: config.codexBinary
      },
      results: []
    };
  }

  const results: LcmSummaryResult[] = [];

  try {
    while (results.length < requestedLimit) {
      const pending = (await client.listPendingLcmSummaries({
        limit: requestedLimit - results.length,
        workerId: SUMMARY_WORKER_ID
      })) as { nodes?: LcmSummaryNode[] };
      const nodes = pending.nodes ?? [];
      if (nodes.length === 0) {
        break;
      }

      const nextDepth = Math.min(...nodes.map((node) => node.depth));
      const depthNodes = nodes.filter((node) => node.depth === nextDepth);
      const depthResults = await runWithConcurrency(
        depthNodes,
        config.concurrency,
        (node) => summarizeNode(client, node, config, runner)
      );
      results.push(...depthResults);
      if (depthResults.every((result) => !result.submitted)) {
        break;
      }
    }

    return {
      requestedLimit,
      processedCount: results.length,
      submittedCount: results.filter((result) => result.submitted).length,
      failedCount: results.filter((result) => !result.submitted).length,
      localOnly: true,
      config: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        retryDelayMs: config.retryDelayMs,
        concurrency: config.concurrency,
        maxPromptTokens: config.maxPromptTokens,
        codexBinary: config.codexBinary
      },
      results
    };
  } finally {
    releaseLock();
  }
};
