import { existsSync, readFileSync, statSync } from "node:fs";
import { assertSecureHttpTransport } from "./http-transport-security.js";

export type LocalEdgeUpstreamRoutePolicyKey =
  | "personalMemoryRead"
  | "personalCollaboration"
  | "teamWorkspaceRead"
  | "shareGrantManagement"
  | "captureWrites"
  | "sync"
  | "managedExecution"
  | "admin";

export interface LocalEdgeUpstreamBackend {
  id: string;
  baseUrl: string;
  profile?:
    | "developer"
    | "local_personal"
    | "private_vps"
    | "team_self_hosted"
    | "koed_managed_cloud"
    | null;
  routePolicy: Partial<
    Record<LocalEdgeUpstreamRoutePolicyKey, "enabled" | "disabled">
  >;
  credential?: { status?: string; reference?: string };
  capabilities?: {
    state?: "validated" | "stale" | "failed" | "not_checked";
    expiresAt?: string | null;
    schemaVersion?: number | null;
    payload?: {
      capabilitySchemaVersion?: number;
      protocols?: {
        collaborationRealtime?: {
          version?: number;
          transport?: string;
        };
        sharedMemorySourceAdmission?: {
          version?: number;
        };
      };
      capabilities?: Record<
        string,
        { availability?: "available" | "partial" | "unavailable" }
      >;
    };
  };
}

export interface LocalEdgeUpstreamRegistry {
  schemaVersion: 2;
  activeBackendId: string | null;
  backends: LocalEdgeUpstreamBackend[];
}

export interface LocalEdgeUpstreamEnrollmentBinding {
  backendId: string;
  enrollmentId: string;
  deviceCredentialId: string;
  principalUserId: string;
}

interface RegistryCacheEntry {
  mtimeMs: number;
  registry: LocalEdgeUpstreamRegistry;
}

const registryCache = new Map<string, RegistryCacheEntry>();

const hasSecureUpstreamBaseUrl = (value: string): boolean => {
  try {
    assertSecureHttpTransport(new URL(value), "Upstream URL");
    return true;
  } catch {
    return false;
  }
};

const isUpstreamBackend = (
  value: unknown
): value is LocalEdgeUpstreamBackend => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { baseUrl?: unknown }).baseUrl !== "string"
  ) {
    return false;
  }
  return hasSecureUpstreamBaseUrl((value as { baseUrl: string }).baseUrl);
};

export const readLocalEdgeUpstreamRegistry = (
  path: string,
  deps: {
    existsSync?: typeof existsSync;
    readFileSync?: typeof readFileSync;
    statSync?: typeof statSync;
  } = {}
): LocalEdgeUpstreamRegistry => {
  const resolvedExistsSync = deps.existsSync ?? existsSync;
  const resolvedReadFileSync = deps.readFileSync ?? readFileSync;
  const resolvedStatSync = deps.statSync ?? statSync;
  const cached = registryCache.get(path);
  if (!resolvedExistsSync(path)) {
    const registry: LocalEdgeUpstreamRegistry = {
      schemaVersion: 2,
      activeBackendId: null,
      backends: []
    };
    registryCache.set(path, { mtimeMs: -1, registry });
    return registry;
  }
  const mtimeMs = resolvedStatSync(path).mtimeMs;
  if (cached?.mtimeMs === mtimeMs) {
    return cached.registry;
  }
  const parsed = JSON.parse(
    resolvedReadFileSync(path, "utf8") as string
  ) as Partial<LocalEdgeUpstreamRegistry>;
  if (parsed.schemaVersion !== 2) {
    throw new Error("Upstream backend registry schema is unsupported.");
  }
  const backends = Array.isArray(parsed.backends)
    ? parsed.backends.filter(isUpstreamBackend)
    : [];
  const activeBackendId =
    typeof parsed.activeBackendId === "string" ? parsed.activeBackendId : null;
  if (
    activeBackendId &&
    !backends.some((backend) => backend.id === activeBackendId)
  ) {
    throw new Error("Active upstream backend is not registered.");
  }
  const registry: LocalEdgeUpstreamRegistry = {
    schemaVersion: 2,
    activeBackendId,
    backends
  };
  registryCache.set(path, { mtimeMs, registry });
  return registry;
};

export const upstreamBackendById = (
  registry: LocalEdgeUpstreamRegistry,
  upstreamBackendId: string
): LocalEdgeUpstreamBackend | null =>
  registry.backends.find((backend) => backend.id === upstreamBackendId) ?? null;

export const activeUpstreamBackend = (
  registry: LocalEdgeUpstreamRegistry
): LocalEdgeUpstreamBackend | null =>
  registry.activeBackendId
    ? upstreamBackendById(registry, registry.activeBackendId)
    : null;

export const upstreamAdvertisesCapability = (
  backend: LocalEdgeUpstreamBackend,
  capability: string
): boolean =>
  backend.capabilities?.payload?.capabilities?.[capability]?.availability ===
  "available";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readLocalEdgeUpstreamEnrollmentBinding = (
  path: string,
  backendId: string,
  deps: {
    existsSync?: typeof existsSync;
    readFileSync?: typeof readFileSync;
  } = {}
): LocalEdgeUpstreamEnrollmentBinding | null => {
  const resolvedExistsSync = deps.existsSync ?? existsSync;
  const resolvedReadFileSync = deps.readFileSync ?? readFileSync;
  if (!resolvedExistsSync(path)) return null;

  try {
    const parsed = JSON.parse(
      resolvedReadFileSync(path, "utf8") as string
    ) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.enrollments)) {
      return null;
    }
    const enrollments = Array.from(parsed.enrollments as unknown[]);
    const record = enrollments
      .reverse()
      .find((candidate): candidate is Record<string, unknown> => {
        if (
          candidate === null ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          return false;
        }
        const enrollment = candidate as Record<string, unknown>;
        return (
          enrollment.backendId === backendId && enrollment.state === "exchanged"
        );
      });
    if (
      !record ||
      typeof record.requestId !== "string" ||
      !record.requestId.trim() ||
      typeof record.deviceCredentialId !== "string" ||
      !uuidPattern.test(record.deviceCredentialId) ||
      typeof record.principalUserId !== "string" ||
      !uuidPattern.test(record.principalUserId)
    ) {
      return null;
    }
    return {
      backendId,
      enrollmentId: record.requestId,
      deviceCredentialId: record.deviceCredentialId.toLowerCase(),
      principalUserId: record.principalUserId.toLowerCase()
    };
  } catch {
    return null;
  }
};
