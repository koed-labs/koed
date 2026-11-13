import { cpus } from "node:os";
import type { ResourceOverrides } from "./performance-contract.js";

/** How much of the machine local Koed services may use. */
export type ResourceProfile = "low" | "balanced" | "full";
export const resourceProfiles: readonly ResourceProfile[] = [
  "low",
  "balanced",
  "full"
];
export const DEFAULT_RESOURCE_PROFILE: ResourceProfile = "balanced";

export const isResourceProfile = (value: unknown): value is ResourceProfile =>
  typeof value === "string" &&
  (resourceProfiles as readonly string[]).includes(value);

type ProfileSetting = {
  /** The variable the profile fills in. */
  name: string;
  /** Any of these set to a non-empty value is an explicit choice. */
  overrides: readonly string[];
  value: (cpuCount: number) => string;
};

const priority = (nice: number): ProfileSetting => ({
  name: "KOED_BACKGROUND_NICE",
  overrides: ["KOED_BACKGROUND_NICE"],
  value: () => String(nice)
});
const embeddingThreads = (
  threads: (cpuCount: number) => number
): ProfileSetting => ({
  name: "EMBEDDING_LLAMA_N_THREADS",
  overrides: ["EMBEDDING_LLAMA_N_THREADS", "LLAMA_N_THREADS"],
  value: (cpuCount) => String(Math.max(1, threads(cpuCount)))
});
const codexTranscriptPoll = (ms: number): ProfileSetting => ({
  name: "MEMORY_CODEX_TRANSCRIPT_POLL_MS",
  overrides: ["MEMORY_CODEX_TRANSCRIPT_POLL_MS"],
  value: () => String(ms)
});

// Balanced uses each component's own defaults: nice 10, half the logical CPUs
// for llama-server, and Codex transcript checks every second.
const profileSettings: Record<ResourceProfile, readonly ProfileSetting[]> = {
  low: [
    priority(19),
    embeddingThreads((cpuCount) => Math.floor(cpuCount / 4)),
    codexTranscriptPoll(15_000)
  ],
  balanced: [],
  full: [priority(0), embeddingThreads((cpuCount) => cpuCount)]
};

/**
 * Fills in the settings a resource profile controls. A setting the Operator
 * set explicitly, in the environment or the repository env file, always wins.
 */
export const applyResourceProfile = (
  environment: NodeJS.ProcessEnv,
  profile: ResourceProfile,
  options: {
    explicit?: Record<string, string | undefined>;
    cpuCount?: number;
    overrides?: ResourceOverrides;
  } = {}
): NodeJS.ProcessEnv => {
  // Check each source on its own: merging first would let a blank process
  // variable hide a non-empty value from the repository env file.
  const isExplicit = (name: string) =>
    Boolean(environment[name]?.trim() || options.explicit?.[name]?.trim());
  const cpuCount = Math.max(1, options.cpuCount ?? (cpus().length || 1));
  const output = { ...environment };
  for (const setting of profileSettings[profile]) {
    if (setting.overrides.some(isExplicit)) continue;
    output[setting.name] = setting.value(cpuCount);
  }
  const overrides = options.overrides ?? {};
  for (const [key, setting] of [
    ["backgroundNice", priority(10)],
    ["embeddingThreads", embeddingThreads((count) => count)],
    ["transcriptPollMs", codexTranscriptPoll(1000)]
  ] as const) {
    if (
      overrides[key] !== undefined &&
      !setting.overrides.some(isExplicit)
    )
      output[setting.name] = String(overrides[key]);
  }
  return output;
};
