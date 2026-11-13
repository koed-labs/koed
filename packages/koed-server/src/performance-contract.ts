import type {
  ResourceProfile,
  ResourceValues
} from "@koed-labs/shared/resource-profiles";

export {
  resourceProfileValues,
  type ResourceProfile,
  type ResourceValues
} from "@koed-labs/shared/resource-profiles";
export type ResourceOverrides = Partial<ResourceValues>;
export interface PerformancePreference {
  profile: ResourceProfile;
  overrides: ResourceOverrides;
}
export interface PerformanceSnapshot {
  revision: string;
  runtimeEpoch: string;
  runtimeState: "running" | "starting" | "stopped" | "unavailable";
  cpuCount: number;
  preference: PerformancePreference;
  effective: ResourceValues;
  profileManaged: boolean;
  managed: Partial<Record<keyof ResourceValues, string>>;
  /** Environment values the components ignore, and the value they use instead. */
  invalid: Partial<Record<keyof ResourceValues, string>>;
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

/**
 * A performance choice refused before anything was written, so the saved
 * configuration is unchanged and stopped services can safely restart.
 */
export class PerformanceChoiceRejectedError extends Error {
  readonly rejected = true;
  constructor(message: string) {
    super(message);
    this.name = "PerformanceChoiceRejectedError";
  }
}
/** Also recognizes a rejection relayed across the Desktop supervisor RPC. */
export const isPerformanceChoiceRejection = (error: unknown): boolean =>
  error instanceof Error && (error as { rejected?: unknown }).rejected === true;
