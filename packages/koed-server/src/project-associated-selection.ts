import { z } from "zod";
import {
  fetchBoundedJsonObject,
  isLoopbackHostname,
  type AssociatedRepositorySelection
} from "@koed/shared";
import type { KoedServerPaths } from "./paths.js";
import { resolveActiveIntegrationApiToken } from "./credentials.js";
import { loadRepoEnv, resolveApiUrl } from "./env-file.js";
import { applyPersistedLocalPorts } from "./ports.js";
import { readActiveRuntimeState } from "./runtime-state.js";

const selectionSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("selected"),
      anchorFingerprint: z.string().min(1).max(512)
    })
    .strict(),
  z.object({ state: z.literal("conflict") }).strict()
]);
const responseSchema = z
  .object({
    association: z
      .object({
        groupId: z.string().min(1),
        associationId: z.string().min(1),
        selectionId: z.string().min(1),
        selection: selectionSchema.nullable()
      })
      .strict()
      .nullable()
  })
  .strict();

/** Only called for a checkout whose User explicitly enabled local association lookup. */
export const lookupAcceptedProjectSelection = async (
  paths: KoedServerPaths,
  checkout: { originatingDeviceId: string; checkoutId: string },
  deps: { environment?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}
): Promise<AssociatedRepositorySelection | undefined> => {
  const environment = deps.environment ?? process.env;
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const token = resolveActiveIntegrationApiToken(paths, environment, repoEnv);
  if (!token)
    throw new Error(
      "Project association lookup requires the local API credential"
    );
  const runtime = readActiveRuntimeState(paths.runtimeStatePath);
  const origin = new URL(
    runtime?.apiUrl ??
      resolveApiUrl(
        applyPersistedLocalPorts(paths, environment, { force: true }),
        repoEnv
      )
  );
  if (
    !isLoopbackHostname(origin.hostname) ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error(
      "Project association lookup requires the local Personal API"
    );
  const url = new URL("/v1/memory/repository-selection", origin);
  url.search = new URLSearchParams(checkout).toString();
  const { response, payload } = await fetchBoundedJsonObject(
    deps.fetch ?? globalThis.fetch,
    url,
    {
      headers: { authorization: `Bearer ${token.token}` },
      redirect: "error"
    },
    { timeoutMs: 10_000, maxBytes: 64 * 1024 }
  );
  if (!response.ok) {
    throw new Error(
      "Project association lookup is unavailable; retry discovery"
    );
  }
  const result = responseSchema.parse(payload);
  const association = result.association;
  return association?.selection
    ? {
        associationId: association.associationId,
        selection: association.selection
      }
    : undefined;
};
