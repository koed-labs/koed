export type HealthStatus = "ok" | "degraded" | "error";

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export const createHealth = (
  service: string,
  status: HealthStatus = "ok",
  details?: Record<string, unknown>
): ServiceHealth => ({
  service,
  status,
  checkedAt: new Date().toISOString(),
  ...(details ? { details } : {})
});

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const requireEnv = (
  names: string[],
  environment: NodeJS.ProcessEnv = process.env
): void => {
  const missing = names.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`
    );
  }
};

const truthyConfigValues = new Set(["1", "true", "yes", "on"]);

export const configFlagEnabled = (value: string | undefined): boolean =>
  value ? truthyConfigValues.has(value.trim().toLowerCase()) : false;
