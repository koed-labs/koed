import {
  PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES,
  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT
} from "@koed/shared";
import {
  parsePrivacyRuntimePreference,
  type PrivacyRuntimePreference
} from "./provider.js";
import {
  OFFICIAL_PRIVACY_MODEL_ID,
  OFFICIAL_PRIVACY_MODEL_REVISION
} from "./provenance.js";

export interface PrivacyServiceConfig {
  host: string;
  port: number;
  token: string;
  controlToken: string;
  modelId: string;
  modelRevision: string;
  transformersCache: string;
  maxFields: number;
  maxFieldBytes: number;
  maxRequestFieldBytes: number;
  maxBodyBytes: number;
  runtimeProvider: PrivacyRuntimePreference;
  gpuIdleUnloadSeconds: number;
}

const positiveInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const nonNegativeInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
};

const contractInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  expected: number
): number => {
  const configured = environment[name];
  if (configured === undefined || configured.trim() === "") return expected;
  const parsed = positiveInteger(environment, name, expected);
  if (parsed !== expected) {
    throw new Error(
      `${name} must match the shared Privacy contract (${expected})`
    );
  }
  return expected;
};

export const resolveConfig = (
  environment: NodeJS.ProcessEnv = process.env
): PrivacyServiceConfig => {
  const transformersCache = environment.KOED_PRIVACY_TRANSFORMERS_CACHE?.trim();
  if (!transformersCache) {
    throw new Error("KOED_PRIVACY_TRANSFORMERS_CACHE is required");
  }
  return {
    host: environment.PRIVACY_SERVICE_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(environment, "PRIVACY_SERVICE_PORT", 8092),
    token: environment.PRIVACY_SERVICE_TOKEN?.trim() || "",
    controlToken: environment.PRIVACY_RUNTIME_CONTROL_TOKEN?.trim() || "",
    modelId: OFFICIAL_PRIVACY_MODEL_ID,
    modelRevision: OFFICIAL_PRIVACY_MODEL_REVISION,
    transformersCache,
    maxFields: contractInteger(
      environment,
      "PRIVACY_MAX_FIELDS",
      PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT
    ),
    maxFieldBytes: contractInteger(
      environment,
      "PRIVACY_MAX_FIELD_BYTES",
      PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES
    ),
    maxRequestFieldBytes: contractInteger(
      environment,
      "PRIVACY_MAX_REQUEST_FIELD_BYTES",
      PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES
    ),
    maxBodyBytes: contractInteger(
      environment,
      "PRIVACY_MAX_BODY_BYTES",
      PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES
    ),
    runtimeProvider: parsePrivacyRuntimePreference(
      environment.PRIVACY_RUNTIME_PROVIDER
    ),
    gpuIdleUnloadSeconds: nonNegativeInteger(
      environment,
      "PRIVACY_GPU_IDLE_UNLOAD_SECONDS",
      300
    )
  };
};
