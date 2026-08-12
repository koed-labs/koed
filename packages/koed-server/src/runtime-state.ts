import { readFileSync as nodeReadFileSync } from "node:fs";
import { isProcessRunning } from "./process-liveness.js";
import type { KoedServerRuntimeState } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const validProcessMap = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    Object.values(value).every(
      (pid) => typeof pid === "number" && Number.isInteger(pid) && pid >= 0
    ));

const validRuntimeState = (value: unknown): value is KoedServerRuntimeState => {
  if (!isRecord(value)) return false;
  const validRuntimeMode =
    value.runtimeMode === undefined ||
    value.runtimeMode === "local-personal" ||
    value.runtimeMode === "external" ||
    value.runtimeMode === "developer";
  const validDependencyMode =
    value.dependencyMode === undefined ||
    value.dependencyMode === "bundled-local" ||
    value.dependencyMode === "external";
  const validAutomaticPorts =
    value.automaticPorts === undefined ||
    typeof value.automaticPorts === "boolean";
  return (
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt)) &&
    typeof value.repoRoot === "string" &&
    Boolean(value.repoRoot.trim()) &&
    validHttpUrl(value.apiUrl) &&
    Array.isArray(value.services) &&
    value.services.every((service) => typeof service === "string") &&
    validRuntimeMode &&
    validDependencyMode &&
    validAutomaticPorts &&
    validProcessMap(value.processes)
  );
};

export const readActiveRuntimeState = (
  path: string,
  readFileSync: typeof nodeReadFileSync = nodeReadFileSync,
  checkPid: (pid: number) => boolean = isProcessRunning
): KoedServerRuntimeState | null => {
  try {
    const parsed: unknown = JSON.parse(String(readFileSync(path, "utf8")));
    return validRuntimeState(parsed) && checkPid(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
};

export const applyActiveRuntimeUrls = (
  environment: NodeJS.ProcessEnv,
  runtime: KoedServerRuntimeState | null
): NodeJS.ProcessEnv => ({
  ...environment,
  ...(runtime?.apiUrl ? { MEMORY_API_URL: runtime.apiUrl } : {}),
  ...(runtime?.automaticPorts ? { KOED_AUTO_PORTS: "1" } : {})
});
