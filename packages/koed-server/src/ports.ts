import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export interface KoedLocalPorts {
  api: string;
  explorer: string;
  postgres: string;
  embedding: string;
}

const DEFAULT_PORTS: KoedLocalPorts = {
  api: "43300",
  explorer: "45174",
  postgres: "45432",
  embedding: "43800"
};

const ENV_KEYS = {
  api: "API_HOST_PORT",
  explorer: "EXPLORER_WEB_HOST_PORT",
  postgres: "POSTGRES_HOST_PORT",
  embedding: "EMBEDDING_SERVICE_HOST_PORT"
} as const;

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const validPort = (value: string | undefined): string | undefined => {
  const trimmed = trim(value);
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? String(parsed)
    : undefined;
};

const canListen = (port: string): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(Number(port), "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });

const nextFreePort = async (preferred: string): Promise<string> => {
  const start = Number(preferred);
  for (let port = start; port < Math.min(start + 1000, 65536); port += 1) {
    if (await canListen(String(port))) {
      return String(port);
    }
  }
  throw new Error(`Could not find a free local port near ${preferred}.`);
};

export const readPersistedLocalPorts = (
  paths: KoedServerPaths
): Partial<KoedLocalPorts> => {
  if (!existsSync(paths.localPortsPath)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(paths.localPortsPath, "utf8")
    ) as Partial<KoedLocalPorts>;
    return {
      ...(validPort(parsed.api) ? { api: validPort(parsed.api)! } : {}),
      ...(validPort(parsed.explorer)
        ? { explorer: validPort(parsed.explorer)! }
        : {}),
      ...(validPort(parsed.postgres)
        ? { postgres: validPort(parsed.postgres)! }
        : {}),
      ...(validPort(parsed.embedding)
        ? { embedding: validPort(parsed.embedding)! }
        : {})
    };
  } catch {
    return {};
  }
};

const writePersistedLocalPorts = (
  paths: KoedServerPaths,
  ports: KoedLocalPorts
): void => {
  mkdirSync(dirname(paths.localPortsPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.localPortsPath, `${JSON.stringify(ports, null, 2)}\n`, {
    mode: 0o600
  });
};

export const applyPersistedLocalPorts = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  options: { force?: boolean } = {}
): NodeJS.ProcessEnv => {
  if (!options.force && environment.KOED_AUTO_PORTS !== "1") return environment;
  const persisted = readPersistedLocalPorts(paths);
  return {
    ...environment,
    ...(persisted.api && !trim(environment.API_HOST_PORT)
      ? { API_HOST_PORT: persisted.api }
      : {}),
    ...(persisted.explorer && !trim(environment.EXPLORER_WEB_HOST_PORT)
      ? { EXPLORER_WEB_HOST_PORT: persisted.explorer }
      : {}),
    ...(persisted.postgres && !trim(environment.POSTGRES_HOST_PORT)
      ? { POSTGRES_HOST_PORT: persisted.postgres }
      : {}),
    ...(persisted.embedding && !trim(environment.EMBEDDING_SERVICE_HOST_PORT)
      ? { EMBEDDING_SERVICE_HOST_PORT: persisted.embedding }
      : {})
  };
};

export const allocateAndPersistLocalPorts = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> => {
  if (environment.KOED_AUTO_PORTS !== "1") return environment;

  const persisted = readPersistedLocalPorts(paths);
  const allocated: KoedLocalPorts = { ...DEFAULT_PORTS, ...persisted };

  for (const key of Object.keys(ENV_KEYS) as Array<keyof KoedLocalPorts>) {
    const envKey = ENV_KEYS[key];
    const fromEnv = validPort(environment[envKey]);
    if (fromEnv) {
      allocated[key] = fromEnv;
      continue;
    }
    const preferred = validPort(allocated[key]) ?? DEFAULT_PORTS[key];
    allocated[key] = (await canListen(preferred))
      ? preferred
      : await nextFreePort(preferred);
  }

  writePersistedLocalPorts(paths, allocated);
  return {
    ...environment,
    API_HOST_PORT: environment.API_HOST_PORT ?? allocated.api,
    EXPLORER_WEB_HOST_PORT:
      environment.EXPLORER_WEB_HOST_PORT ?? allocated.explorer,
    POSTGRES_HOST_PORT: environment.POSTGRES_HOST_PORT ?? allocated.postgres,
    EMBEDDING_SERVICE_HOST_PORT:
      environment.EMBEDDING_SERVICE_HOST_PORT ?? allocated.embedding
  };
};
