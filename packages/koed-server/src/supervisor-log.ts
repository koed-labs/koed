import { appendFileSync, statSync, truncateSync } from "node:fs";

export const SUPERVISOR_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const SUPERVISOR_LOG_CHECK_INTERVAL_MS = 5_000;

export const capSupervisorLog = (
  logPath: string,
  maxBytes = SUPERVISOR_LOG_MAX_BYTES
): boolean => {
  try {
    if (statSync(logPath).size <= maxBytes) return false;
    truncateSync(logPath, 0);
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}] Supervisor log exceeded ${maxBytes} bytes and was truncated.\n`,
      { mode: 0o600 }
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const maintainSupervisorLog = (
  environment: NodeJS.ProcessEnv,
  options: {
    intervalMs?: number;
    maxBytes?: number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  } = {}
): (() => void) => {
  const logPath = environment.KOED_SERVER_SUPERVISOR_LOG_PATH?.trim();
  if (!logPath) return () => undefined;
  const maxBytes = options.maxBytes ?? SUPERVISOR_LOG_MAX_BYTES;
  const cap = () => {
    try {
      capSupervisorLog(logPath, maxBytes);
    } catch (error) {
      console.error(
        `Could not enforce supervisor log retention: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  cap();
  const timer = (options.setInterval ?? setInterval)(
    cap,
    options.intervalMs ?? SUPERVISOR_LOG_CHECK_INTERVAL_MS
  );
  timer.unref?.();
  return () => (options.clearInterval ?? clearInterval)(timer);
};
