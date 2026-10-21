import {
  managedProjectRecallContextSchema,
  readDesktopLocalCredentialAuthorization,
  type ManagedProjectRecallContext
} from "@koed/shared";
import { z } from "zod";
export type { ManagedProjectRecallContext } from "@koed/shared";

/** The MCP connection receives this selector from its launch, never from a tool call. */
export const managedRecallSelector = (environment: NodeJS.ProcessEnv) => {
  const executionId = z
    .uuid()
    .safeParse(environment.KOED_MANAGED_RECALL_EXECUTION_ID);
  const generation = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(environment.KOED_MANAGED_RECALL_EXECUTION_GENERATION);
  const apiUrl = environment.KOED_MANAGED_RECALL_API_URL;
  const koedHome = environment.KOED_HOME;
  if (!executionId.success || !generation.success || !apiUrl || !koedHome)
    return null;
  const url = new URL(apiUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    return null;
  return {
    executionId: executionId.data,
    generation: generation.data,
    apiUrl: url,
    koedHome
  };
};

export const readManagedProjectRecallContext = async (
  selector: NonNullable<ReturnType<typeof managedRecallSelector>>,
  send: typeof fetch = fetch
): Promise<ManagedProjectRecallContext> => {
  const endpoint = selector.apiUrl;
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("Managed Project recall endpoint must be local HTTP");
  const credential = readDesktopLocalCredentialAuthorization(selector.koedHome);
  if (
    !credential?.operationFamilies.includes("personal_collaboration_read") ||
    !credential.operationFamilies.includes("managed_execution")
  )
    throw new Error("Managed Project recall lacks current owner authority");
  const url = new URL(
    `/v1/managed-conversations/${selector.executionId}/recall-context`,
    selector.apiUrl
  );
  url.searchParams.set("executionGeneration", String(selector.generation));
  const response = await send(url, {
    method: "GET",
    redirect: "error",
    headers: {
      authorization: credential.authorization,
      accept: "application/json"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok)
    throw new Error(
      `Managed Project recall context is unavailable (${response.status})`
    );
  const raw = await response.text();
  if (raw.length > 4096)
    throw new Error("Managed Project recall context exceeded its limit");
  return managedProjectRecallContextSchema.parse(JSON.parse(raw));
};
