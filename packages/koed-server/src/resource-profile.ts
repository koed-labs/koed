import { cpus } from "node:os";
import {
  resourceProfileValues,
  type ResourceProfile,
  type ResourceValues
} from "@koed-labs/shared/resource-profiles";
import type { ResourceOverrides } from "./performance-contract.js";

export type { ResourceProfile } from "@koed-labs/shared/resource-profiles";
export const resourceProfiles: readonly ResourceProfile[] = [
  "low",
  "balanced",
  "full"
];
export const DEFAULT_RESOURCE_PROFILE: ResourceProfile = "balanced";

export const isResourceProfile = (value: unknown): value is ResourceProfile =>
  typeof value === "string" &&
  (resourceProfiles as readonly string[]).includes(value);

/**
 * The variables behind each resource value. The first is the one a profile
 * fills in; any of them set to a non-empty value is an explicit choice.
 */
export const resourceVariables: Record<
  keyof ResourceValues,
  readonly [string, ...string[]]
> = {
  backgroundNice: ["KOED_BACKGROUND_NICE"],
  embeddingThreads: ["EMBEDDING_LLAMA_N_THREADS", "LLAMA_N_THREADS"],
  transcriptPollMs: ["MEMORY_CODEX_TRANSCRIPT_POLL_MS"]
};
const resourceKeys = Object.keys(resourceVariables) as (keyof ResourceValues)[];

/**
 * Fills in the settings a resource profile controls. A setting the Operator
 * set explicitly, in the environment or the repository env file, always wins.
 * Balanced leaves every setting to the component, whose default is the
 * Balanced value.
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
  const isExplicit = (key: keyof ResourceValues) =>
    resourceVariables[key].some((name) =>
      Boolean(environment[name]?.trim() || options.explicit?.[name]?.trim())
    );
  const cpuCount = Math.max(1, options.cpuCount ?? (cpus().length || 1));
  const values: Partial<ResourceValues> =
    profile === "balanced" ? {} : resourceProfileValues(profile, cpuCount);
  const overrides = options.overrides ?? {};
  const output = { ...environment };
  for (const key of resourceKeys) {
    if (isExplicit(key)) continue;
    const value = overrides[key] ?? values[key];
    if (value !== undefined) output[resourceVariables[key][0]] = String(value);
  }
  return output;
};
