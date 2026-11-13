import {
  getPriority as nodeGetPriority,
  setPriority as nodeSetPriority
} from "node:os";

/** Nice value (0-19) for local background services. 0 keeps normal priority. */
export const BACKGROUND_NICE_ENV = "KOED_BACKGROUND_NICE";
export const DEFAULT_BACKGROUND_NICE = 10;
const MAX_NICE = 19;

export interface ProcessPriorityApi {
  getPriority(pid: number): number;
  setPriority(pid: number, priority: number): void;
}

export const nodeProcessPriority: ProcessPriorityApi = {
  getPriority: (pid) => nodeGetPriority(pid),
  setPriority: (pid, priority) => nodeSetPriority(pid, priority)
};

export type BackgroundPriorityResult =
  | { applied: true; priority: number }
  | {
      applied: false;
      reason: "disabled" | "already_lower" | "failed";
      priority?: number;
    };

/**
 * Returns the configured nice value, or null when lowering is turned off.
 * An invalid value falls back to the default: a performance setting must
 * not stop the runtime from starting.
 */
export const resolveBackgroundNice = (
  environment: NodeJS.ProcessEnv,
  warn: (message: string) => void = console.warn
): number | null => {
  const raw = environment[BACKGROUND_NICE_ENV]?.trim();
  if (!raw) return DEFAULT_BACKGROUND_NICE;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_NICE) {
    warn(
      `${BACKGROUND_NICE_ENV} must be an integer from 0 to ${MAX_NICE}; using ${DEFAULT_BACKGROUND_NICE}.`
    );
    return DEFAULT_BACKGROUND_NICE;
  }
  const value = Number(raw);
  return value === 0 ? null : value;
};

/**
 * Lowers the supervisor's own scheduling priority before it starts services.
 * Every service inherits it, including descendants the supervisor does not
 * spawn directly (Postgres through pg_ctl, llama-server through the
 * Embedding Service, and AI client processes the Local AI Runtime runs).
 * Foreground apps then win CPU contention; idle CPU still goes to Koed.
 * The priority is never raised.
 */
export const lowerBackgroundServicePriority = (
  environment: NodeJS.ProcessEnv,
  api: ProcessPriorityApi = nodeProcessPriority,
  warn: (message: string) => void = console.warn
): BackgroundPriorityResult => {
  const target = resolveBackgroundNice(environment, warn);
  if (target === null) return { applied: false, reason: "disabled" };
  try {
    const current = api.getPriority(0);
    if (current >= target) {
      return { applied: false, reason: "already_lower", priority: current };
    }
    api.setPriority(0, target);
    return { applied: true, priority: target };
  } catch (error) {
    warn(
      `Could not lower Koed background service priority: ${error instanceof Error ? error.message : String(error)}`
    );
    return { applied: false, reason: "failed" };
  }
};
