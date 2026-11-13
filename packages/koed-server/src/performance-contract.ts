import type { ResourceProfile } from "./resource-profile.js";

export type { ResourceProfile } from "./resource-profile.js";
export interface ResourceValues {
  backgroundNice: number;
  embeddingThreads: number;
  transcriptPollMs: number;
}
export type ResourceOverrides = Partial<ResourceValues>;
export interface PerformancePreference {
  profile: ResourceProfile;
  overrides: ResourceOverrides;
}
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
export interface PerformanceSnapshot {
  revision: string;
  runtimeEpoch: string;
  runtimeState: "running" | "starting" | "stopped" | "unavailable";
  cpuCount: number;
  preference: PerformancePreference;
  effective: ResourceValues;
  profileManaged: boolean;
  managed: Partial<Record<keyof ResourceValues, string>>;
  readOnlyReason: string | null;
}
export interface PerformanceChoice extends PerformancePreference {
  expectedRevision: string;
}
export interface PerformanceOperation {
  id: string;
  state: "running" | "complete" | "failed" | "interrupted";
  message: string;
}
export interface DesktopPerformanceState {
  snapshot: PerformanceSnapshot | null;
  operation: PerformanceOperation | null;
}
export interface DesktopPerformanceApi {
  inspect: () => Promise<DesktopPerformanceState>;
  apply: (choice: PerformanceChoice) => Promise<DesktopPerformanceState>;
}
