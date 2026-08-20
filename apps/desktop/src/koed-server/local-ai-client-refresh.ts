import { fetchBoundedJsonObject } from "@koed/shared";
import {
  LOCAL_AI_RUNTIME_PROTOCOL_VERSION,
  readLocalRuntimeRegistration
} from "./local-runtime-registration.js";

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const validPublication = (value: unknown): boolean => {
  const item = objectValue(value);
  return Boolean(
    item &&
    typeof item.instanceId === "string" &&
    typeof item.published === "boolean" &&
    (item.error === null || typeof item.error === "string")
  );
};

export const refreshLocalAiRuntime = async (input: {
  fetch: typeof globalThis.fetch;
  koedHome: string;
}): Promise<{ refreshed: boolean; refreshError: string | null }> => {
  const registration = readLocalRuntimeRegistration(input.koedHome);
  const remote = await fetchBoundedJsonObject(
    input.fetch,
    new URL("/v1/capabilities/refresh", registration.url),
    {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: registration.authorization
      }
    },
    { timeoutMs: 5_000, maxBytes: 512 * 1_024, readErrorBody: true }
  );
  if (!remote.response.ok) {
    return {
      refreshed: false,
      refreshError: "Capability refresh request failed."
    };
  }
  const publications = remote.payload.publications;
  if (!validRefreshPayload(remote.payload, publications)) {
    return {
      refreshed: false,
      refreshError: "Capability refresh returned an invalid response."
    };
  }
  const failedCount = publications.filter(
    (publication) => objectValue(publication)?.published !== true
  ).length;
  return failedCount > 0
    ? {
        refreshed: false,
        refreshError: `Capability refresh failed for ${failedCount} AI Client ${failedCount === 1 ? "instance" : "instances"}.`
      }
    : { refreshed: true, refreshError: null };
};

const validRefreshPayload = (
  payload: Record<string, unknown>,
  publications: unknown
): publications is unknown[] =>
  payload.protocolVersion === LOCAL_AI_RUNTIME_PROTOCOL_VERSION &&
  Array.isArray(publications) &&
  publications.every(validPublication);
