import { fetchBoundedJsonObject } from "@koed/shared";
import {
  readLocalRuntimeRegistration,
  LOCAL_AI_RUNTIME_PROTOCOL_VERSION
} from "./local-runtime-registration.js";

export const refreshLocalAiClientUsage = async (input: {
  fetch: typeof globalThis.fetch;
  koedHome: string;
  instanceId: string;
}): Promise<{
  outcome: "checked" | "failed" | "unsupported";
  observedAt: string;
}> => {
  const registration = readLocalRuntimeRegistration(input.koedHome);
  const url = new URL("/v1/usage/refresh", registration.url);
  url.searchParams.set("instanceId", input.instanceId);
  const remote = await fetchBoundedJsonObject(
    input.fetch,
    url,
    {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: registration.authorization,
        accept: "application/json"
      }
    },
    { timeoutMs: 15_000, maxBytes: 4_096 }
  );
  const body = remote.payload;
  if (
    !remote.response.ok ||
    body.protocolVersion !== LOCAL_AI_RUNTIME_PROTOCOL_VERSION ||
    body.instanceId !== input.instanceId ||
    !["checked", "failed", "unsupported"].includes(String(body.outcome)) ||
    typeof body.observedAt !== "string"
  )
    throw new Error("Invalid usage refresh response");
  return {
    outcome: body.outcome as "checked" | "failed" | "unsupported",
    observedAt: body.observedAt
  };
};
