/** How much of the machine local Koed services may use. */
export type ResourceProfile = "low" | "balanced" | "full";

export interface ResourceValues {
  /** Nice value (0-19) for local background services. */
  backgroundNice: number;
  /** llama-server CPU threads for the Embedding Service. */
  embeddingThreads: number;
  /** How often the Codex Transcript Watcher checks for changes. */
  transcriptPollMs: number;
}

/**
 * The one table of what each resource profile means. Balanced is each
 * component's own default, so the components read their defaults from here
 * and the Desktop shows the same values that the services use.
 *
 * Balanced llama-server threads are half the logical CPUs. On SMT machines
 * that is the physical core count (llama.cpp's own default). On Apple Silicon
 * base chips it is the performance core count, which keeps the background
 * Embedding Service off the cores the User's apps need.
 */
export const resourceProfileValues = (
  profile: ResourceProfile,
  cpuCount: number
): ResourceValues => ({
  backgroundNice: profile === "low" ? 19 : profile === "full" ? 0 : 10,
  embeddingThreads: Math.max(
    1,
    Math.floor(
      cpuCount / (profile === "low" ? 4 : profile === "balanced" ? 2 : 1)
    )
  ),
  transcriptPollMs: profile === "low" ? 15_000 : 1_000
});
