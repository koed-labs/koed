import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import properLockfile from "proper-lockfile";
import type { KoedServerPaths } from "./paths.js";
import { isProcessRunning } from "./process-liveness.js";

export interface KoedLocalPorts {
  api: string;
  postgres: string;
  embedding: string;
  llamaEmbedding: string;
  llamaReranker: string;
}

const DEFAULT_PORTS: KoedLocalPorts = {
  api: "43300",
  postgres: "45432",
  embedding: "43800",
  llamaEmbedding: "18080",
  llamaReranker: "19080"
};

const localPortLeaseSchemaVersion = 1;

type LocalPortLease = {
  koedHome: string;
  pid: number;
  ports: KoedLocalPorts;
  updatedAt: string;
};

type LocalPortLeaseRegistry = {
  schemaVersion: typeof localPortLeaseSchemaVersion;
  leases: Record<string, LocalPortLease>;
};

export interface LocalPortAllocationDependencies {
  canListen?: (port: string) => Promise<boolean>;
  isProcessRunning?: (pid: number) => boolean;
  leaseRegistryPath?: string;
  processId?: number;
}

const ENV_KEYS = {
  api: ["API_HOST_PORT"],
  postgres: ["POSTGRES_HOST_PORT"],
  embedding: ["EMBEDDING_SERVICE_HOST_PORT"],
  llamaEmbedding: [
    "EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT",
    "LLAMA_EMBEDDING_SERVER_PORT"
  ],
  llamaReranker: [
    "EMBEDDING_LLAMA_RERANKER_SERVER_PORT",
    "LLAMA_RERANKER_SERVER_PORT"
  ]
} as const satisfies Record<keyof KoedLocalPorts, readonly string[]>;

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

const nextFreePort = async (
  preferred: string,
  unavailablePorts: Set<string>,
  canListenOnPort: (port: string) => Promise<boolean>
): Promise<string> => {
  const start = Number(preferred);
  for (let port = start; port < Math.min(start + 1000, 65536); port += 1) {
    const candidate = String(port);
    if (
      !unavailablePorts.has(candidate) &&
      (await canListenOnPort(candidate))
    ) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free local port near ${preferred}.`);
};

const defaultLocalPortLeaseRegistryPath = (): string =>
  resolve(homedir(), ".koed", "run", "local-port-leases.json");

const resolveLocalPortLeaseRegistryPath = (
  environment: NodeJS.ProcessEnv,
  dependencyPath?: string
): string => {
  const configured = environment.KOED_LOCAL_PORT_LEASES_PATH?.trim();
  return resolve(
    dependencyPath ?? configured ?? defaultLocalPortLeaseRegistryPath()
  );
};

const emptyLocalPortLeaseRegistry = (): LocalPortLeaseRegistry => ({
  schemaVersion: localPortLeaseSchemaVersion,
  leases: {}
});

const isLocalPortLease = (value: unknown): value is LocalPortLease =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { koedHome?: unknown }).koedHome === "string" &&
  typeof (value as { pid?: unknown }).pid === "number" &&
  typeof (value as { ports?: unknown }).ports === "object" &&
  (value as { ports?: unknown }).ports !== null;

const ensureLocalPortLeaseRegistry = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(emptyLocalPortLeaseRegistry())}\n`, {
      mode: 0o600
    });
  }
};

const readLocalPortLeaseRegistry = (path: string): LocalPortLeaseRegistry => {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<LocalPortLeaseRegistry>;
    if (
      parsed.schemaVersion !== localPortLeaseSchemaVersion ||
      !parsed.leases ||
      typeof parsed.leases !== "object"
    ) {
      return emptyLocalPortLeaseRegistry();
    }
    return {
      schemaVersion: localPortLeaseSchemaVersion,
      leases: Object.fromEntries(
        Object.entries(parsed.leases).filter(([, lease]) =>
          isLocalPortLease(lease)
        )
      )
    };
  } catch {
    return emptyLocalPortLeaseRegistry();
  }
};

const writeLocalPortLeaseRegistry = (
  path: string,
  registry: LocalPortLeaseRegistry
): void => {
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600
  });
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
      ...(validPort(parsed.postgres)
        ? { postgres: validPort(parsed.postgres)! }
        : {}),
      ...(validPort(parsed.embedding)
        ? { embedding: validPort(parsed.embedding)! }
        : {}),
      ...(validPort(parsed.llamaEmbedding)
        ? { llamaEmbedding: validPort(parsed.llamaEmbedding)! }
        : {}),
      ...(validPort(parsed.llamaReranker)
        ? { llamaReranker: validPort(parsed.llamaReranker)! }
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
    ...(persisted.postgres && !trim(environment.POSTGRES_HOST_PORT)
      ? { POSTGRES_HOST_PORT: persisted.postgres }
      : {}),
    ...(persisted.embedding && !trim(environment.EMBEDDING_SERVICE_HOST_PORT)
      ? { EMBEDDING_SERVICE_HOST_PORT: persisted.embedding }
      : {}),
    ...(persisted.llamaEmbedding &&
    !ENV_KEYS.llamaEmbedding.some((key) => trim(environment[key]))
      ? { EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT: persisted.llamaEmbedding }
      : {}),
    ...(persisted.llamaReranker &&
    !ENV_KEYS.llamaReranker.some((key) => trim(environment[key]))
      ? { EMBEDDING_LLAMA_RERANKER_SERVER_PORT: persisted.llamaReranker }
      : {})
  };
};

export const allocateAndPersistLocalPorts = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  dependencies: LocalPortAllocationDependencies = {}
): Promise<NodeJS.ProcessEnv> => {
  if (environment.KOED_AUTO_PORTS !== "1") return environment;

  const registryPath = resolveLocalPortLeaseRegistryPath(
    environment,
    dependencies.leaseRegistryPath
  );
  ensureLocalPortLeaseRegistry(registryPath);
  const release = await properLockfile.lock(registryPath, {
    realpath: false,
    retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 250 }
  });

  try {
    const processIsRunning = dependencies.isProcessRunning ?? isProcessRunning;
    const canListenOnPort = dependencies.canListen ?? canListen;
    const registry = readLocalPortLeaseRegistry(registryPath);
    const activeLeases = Object.values(registry.leases).filter(
      (lease) =>
        lease.koedHome !== paths.koedHome && processIsRunning(lease.pid)
    );
    registry.leases = Object.fromEntries(
      Object.entries(registry.leases).filter(
        ([, lease]) =>
          lease.koedHome === paths.koedHome || processIsRunning(lease.pid)
      )
    );

    const unavailablePorts = new Set<string>(
      activeLeases.flatMap((lease: LocalPortLease) =>
        (Object.keys(DEFAULT_PORTS) as Array<keyof KoedLocalPorts>).map(
          (key) => lease.ports[key]
        )
      )
    );
    const persisted = readPersistedLocalPorts(paths);
    const allocated: KoedLocalPorts = { ...DEFAULT_PORTS, ...persisted };

    for (const key of Object.keys(ENV_KEYS) as Array<keyof KoedLocalPorts>) {
      const fromEnv = ENV_KEYS[key]
        .map((envKey) => validPort(environment[envKey]))
        .find((port) => port !== undefined);
      const preferred =
        fromEnv ?? validPort(allocated[key]) ?? DEFAULT_PORTS[key];
      allocated[key] =
        !unavailablePorts.has(preferred) && (await canListenOnPort(preferred))
          ? preferred
          : await nextFreePort(preferred, unavailablePorts, canListenOnPort);
      unavailablePorts.add(allocated[key]);
    }

    writePersistedLocalPorts(paths, allocated);
    registry.leases[paths.koedHome] = {
      koedHome: paths.koedHome,
      pid: dependencies.processId ?? process.pid,
      ports: allocated,
      updatedAt: new Date().toISOString()
    };
    writeLocalPortLeaseRegistry(registryPath, registry);
    return {
      ...environment,
      API_HOST_PORT: allocated.api,
      POSTGRES_HOST_PORT: allocated.postgres,
      EMBEDDING_SERVICE_HOST_PORT: allocated.embedding,
      EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT: allocated.llamaEmbedding,
      EMBEDDING_LLAMA_RERANKER_SERVER_PORT: allocated.llamaReranker
    };
  } finally {
    await release();
  }
};
