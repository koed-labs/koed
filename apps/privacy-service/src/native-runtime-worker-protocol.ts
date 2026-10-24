import type { PrivacyRuntimeProvider } from "./provider.js";
import type { RawPrivacyClassification } from "./runtime.js";

export interface NativeRuntimeWorkerConfig {
  modelId: string;
  modelRevision: string;
  cacheDir: string;
  provider: PrivacyRuntimeProvider;
}

export interface NativeRuntimeIdentity {
  modelId: string;
  modelRevision: string;
  classifierHash: string;
  provider: PrivacyRuntimeProvider;
}

export type NativeRuntimeRequest =
  | { id: number; operation: "load" | "unload" | "dispose" }
  | { id: number; operation: "classify"; text: string };

export type NativeRuntimeResponse =
  | {
      id: number;
      ok: true;
      ready: boolean;
      identity: NativeRuntimeIdentity;
      classification?: RawPrivacyClassification;
    }
  | {
      id: number;
      ok: false;
      ready: boolean;
      error: { name: string; message: string };
    };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const parseNativeRuntimeResponse = (
  value: unknown
): NativeRuntimeResponse | undefined => {
  if (
    !record(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.ready !== "boolean"
  ) {
    return undefined;
  }
  if (value.ok === true) {
    const identity = value.identity;
    if (
      !record(identity) ||
      typeof identity.modelId !== "string" ||
      typeof identity.modelRevision !== "string" ||
      typeof identity.classifierHash !== "string" ||
      typeof identity.provider !== "string" ||
      (value.classification !== undefined &&
        (!record(value.classification) ||
          typeof value.classification.decodedText !== "string" ||
          !Array.isArray(value.classification.tokenOffsets) ||
          !Array.isArray(value.classification.logits) ||
          !record(value.classification.viterbiBiases)))
    ) {
      return undefined;
    }
  } else if (value.ok === false) {
    if (
      !record(value.error) ||
      typeof value.error.name !== "string" ||
      typeof value.error.message !== "string"
    ) {
      return undefined;
    }
  } else {
    return undefined;
  }
  return value as NativeRuntimeResponse;
};
