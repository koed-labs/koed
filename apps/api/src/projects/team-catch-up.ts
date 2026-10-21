import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fetchBoundedJson,
  verifyLocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import {
  workspaceProjectActivityPageSchema,
  workspaceProjectActivitySeenSchema
} from "@koed/shared/workspace-project-contract";
import type { PersonalWorkspaceProjectRepository } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  readLocalEdgeUpstreamRegistry,
  safeUpstreamProxyUrl,
  upstreamBackendById
} from "../local-edge/upstream-routing.js";

const principalSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: z.object({ id: z.uuid() }).passthrough()
  })
  .passthrough();
const lifecycleSchema = z
  .object({
    id: z.uuid(),
    active: z.boolean(),
    version: z.number().int().positive(),
    memberVersion: z.number().int().positive()
  })
  .passthrough();

const unavailable = (message: string, statusCode = 409): never => {
  throw Object.assign(new Error(message), { statusCode });
};

export type LinkedTeamCatchUpWindow = Readonly<{
  teamBackendId: string;
  workspaceProjectId: string;
  teamPrincipalUserId: string;
  memberId: string;
  projectVersion: number;
  memberVersion: number;
  seenCursor: string;
  highCursor: string;
  welcomeDue: boolean;
  events: ReadonlyArray<{
    kind: "work_item_created" | "work_item_done" | "source_added" | "pr_merged";
    ref: string;
    at: string;
  }>;
}>;

type TeamCatchUpInput = {
  context: ApiRouteContext;
  repository: PersonalWorkspaceProjectRepository;
  request: FastifyRequest;
  ownerUserId: string;
  personalProjectId: string;
};

/** Reads metadata only through the exact enrolled Team backend and principal. */
export const readLinkedTeamCatchUp = async (
  input: TeamCatchUpInput
): Promise<LinkedTeamCatchUpWindow | null> => {
  const link = await input.repository.getLink(
    input.ownerUserId,
    input.personalProjectId
  );
  if (!link) return null;
  if (!input.context.localEdge.remoteOperationsAllowed())
    unavailable("Remote Team operations are unavailable", 424);
  const header = input.request.headers["x-koed-team-client-credential"];
  const credential = verifyLocalEdgeClientCredentialAuthorization(
    input.context.config.koedHome,
    (Array.isArray(header) ? header[0] : header)?.trim(),
    { backendId: link.teamBackendId, operationFamily: "team_workspace_read" }
  );
  if (!credential) unavailable("Enrolled Team read authority required", 403);
  const backend = upstreamBackendById(
    readLocalEdgeUpstreamRegistry(input.context.localEdge.upstreamBackendsPath),
    link.teamBackendId
  );
  if (!backend) unavailable("Linked Team backend is unavailable", 424);
  const authorization = input.context.localEdge.resolveUpstreamAuthorization(
    backend!
  );
  if (!authorization) unavailable("Enrolled Team upstream is unavailable", 424);
  const base = new URL(backend!.baseUrl.replace(/\/+$/, "/"));
  if (base.username || base.password || base.search || base.hash)
    unavailable("Unsafe linked Team backend", 424);
  const get = async (path: string, maxBytes = 128_000): Promise<unknown> => {
    if (!input.context.localEdge.remoteOperationsAllowed())
      unavailable("Remote Team operations are unavailable", 424);
    const remote = await fetchBoundedJson(
      input.context.localEdge.fetch,
      path === "/v1/local-edge/device-credentials/status"
        ? new URL("v1/local-edge/device-credentials/status", base)
        : safeUpstreamProxyUrl(backend!, path),
      {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", authorization: authorization! }
      },
      { timeoutMs: 15_000, maxBytes }
    );
    if (!remote.response.ok)
      unavailable("Current Team Project authority is unavailable", 424);
    return remote.payload;
  };
  const principal = principalSchema.parse(
    await get("/v1/local-edge/device-credentials/status", 64_000)
  ).user.id;
  if (
    (await input.repository.principalBinding(
      input.ownerUserId,
      link.teamBackendId
    )) !== principal
  )
    unavailable("Enrolled Team principal changed", 409);
  const path = `/v1/workspace-projects/${link.workspaceProjectId}`;
  const lifecycle = lifecycleSchema.parse(await get(`${path}/lifecycle`));
  if (lifecycle.id !== link.workspaceProjectId || !lifecycle.active)
    unavailable("Linked Team Project changed", 409);
  const seen = workspaceProjectActivitySeenSchema.parse(
    await get(`${path}/activity/seen`)
  );
  // The Team feed includes completion rows that are intentionally excluded
  // from the assistant prompt. Scan past them so a later eligible change is
  // not hidden behind the first page. The window stores at most 100 eligible
  // rows, while its high cursor binds every row scanned for terminal ACK.
  const events: LinkedTeamCatchUpWindow["events"][number][] = [];
  const visited = new Set([seen.cursor]);
  let highCursor = seen.cursor;
  let hasMore = false;
  let reachedWindowLimit = false;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = workspaceProjectActivityPageSchema.parse(
      await get(
        `${path}/activity?after=${encodeURIComponent(highCursor)}&limit=100`
      )
    );
    if (
      page.projectId !== link.workspaceProjectId ||
      page.memberId !== seen.memberId
    )
      unavailable("Team activity membership changed", 409);
    if (
      (page.items.length > 0 &&
        page.nextCursor !== page.items.at(-1)?.cursor) ||
      (page.hasMore && !page.nextCursor)
    )
      unavailable("Team activity cursor changed", 409);
    for (const item of page.items) {
      if (visited.has(item.cursor))
        unavailable("Team activity cursor stalled", 409);
      visited.add(item.cursor);
      highCursor = item.cursor;
      if (item.kind === "work_item_created" || item.kind === "source_added")
        events.push({ kind: item.kind, ref: item.ref, at: item.at });
      if (events.length === 100) {
        reachedWindowLimit = true;
        break;
      }
    }
    hasMore = page.hasMore;
    if (reachedWindowLimit || !hasMore) break;
    if (page.items.length === 0)
      unavailable("Team activity cursor stalled", 409);
  }
  if (hasMore && events.length < 100)
    unavailable("Team activity scan limit reached", 409);
  const finalLifecycle = lifecycleSchema.parse(await get(`${path}/lifecycle`));
  if (
    finalLifecycle.id !== link.workspaceProjectId ||
    !finalLifecycle.active ||
    finalLifecycle.version !== lifecycle.version ||
    finalLifecycle.memberVersion !== lifecycle.memberVersion
  )
    unavailable("Team Project version changed during catch-up read", 409);
  const finalPrincipal = principalSchema.parse(
    await get("/v1/local-edge/device-credentials/status", 64_000)
  ).user.id;
  if (finalPrincipal !== principal)
    unavailable("Enrolled Team principal changed during catch-up read", 409);
  const current = await input.repository.getLink(
    input.ownerUserId,
    input.personalProjectId
  );
  if (
    !current ||
    current.teamBackendId !== link.teamBackendId ||
    current.workspaceProjectId !== link.workspaceProjectId ||
    (await input.repository.principalBinding(
      input.ownerUserId,
      link.teamBackendId
    )) !== principal
  )
    unavailable("Linked Team Project changed", 409);
  return {
    teamBackendId: link.teamBackendId,
    workspaceProjectId: link.workspaceProjectId,
    teamPrincipalUserId: principal,
    memberId: seen.memberId,
    projectVersion: lifecycle.version,
    memberVersion: lifecycle.memberVersion,
    seenCursor: seen.cursor,
    highCursor,
    welcomeDue: seen.welcomeDue,
    events
  };
};

/** Only the caller with a proven retained Personal terminal item may invoke this. */
export const ackLinkedTeamCatchUp = async (
  input: TeamCatchUpInput & {
    window: LinkedTeamCatchUpWindow;
  }
): Promise<z.infer<typeof workspaceProjectActivitySeenSchema>> => {
  if (input.window.events.length === 0 && !input.window.welcomeDue)
    unavailable("Excluded Team activity is not acknowledged", 409);
  const verify = async () => {
    const current = await readLinkedTeamCatchUp(input);
    if (!current)
      return unavailable(
        "Team Project authority changed before acknowledgment",
        409
      );
    if (
      current.teamBackendId !== input.window.teamBackendId ||
      current.workspaceProjectId !== input.window.workspaceProjectId ||
      current.teamPrincipalUserId !== input.window.teamPrincipalUserId ||
      current.memberId !== input.window.memberId ||
      current.memberVersion !== input.window.memberVersion ||
      current.projectVersion < input.window.projectVersion
    )
      return unavailable(
        "Team Project authority changed before acknowledgment",
        409
      );
    return current;
  };
  await verify();
  const backend = upstreamBackendById(
    readLocalEdgeUpstreamRegistry(input.context.localEdge.upstreamBackendsPath),
    input.window.teamBackendId
  );
  if (!backend) unavailable("Linked Team backend is unavailable", 424);
  const authorization = input.context.localEdge.resolveUpstreamAuthorization(
    backend!
  );
  if (!authorization) unavailable("Enrolled Team upstream is unavailable", 424);
  const path = `/v1/workspace-projects/${input.window.workspaceProjectId}/activity/seen`;
  try {
    if (!input.context.localEdge.remoteOperationsAllowed())
      unavailable("Remote Team operations are unavailable", 424);
    const remote = await fetchBoundedJson(
      input.context.localEdge.fetch,
      safeUpstreamProxyUrl(backend!, path),
      {
        method: "PUT",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: authorization!
        },
        body: JSON.stringify({
          cursor: input.window.highCursor,
          welcomeDelivered: input.window.welcomeDue
        })
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!remote.response.ok)
      unavailable("Team Project acknowledgment is unavailable", 424);
    const acknowledged = workspaceProjectActivitySeenSchema.parse(
      remote.payload
    );
    if (acknowledged.memberId !== input.window.memberId)
      unavailable("Team Project member changed during acknowledgment", 409);
    // A successful Team response is authoritative for this exact, immutable
    // cursor. The Team repository advances seen monotonically for this member.
    await verify();
    return acknowledged;
  } catch (cause) {
    // A committed Team PUT may lose its response. Read current authority and
    // exact seen state; otherwise leave the same cursor available for retry.
    const current = await verify();
    if (
      current.seenCursor === input.window.highCursor &&
      (!input.window.welcomeDue || !current.welcomeDue)
    ) {
      if (!input.context.localEdge.remoteOperationsAllowed())
        unavailable("Remote Team operations are unavailable", 424);
      const response = await fetchBoundedJson(
        input.context.localEdge.fetch,
        safeUpstreamProxyUrl(backend!, path),
        {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", authorization: authorization! }
        },
        { timeoutMs: 15_000, maxBytes: 64_000 }
      );
      if (response.response.ok) {
        const seen = workspaceProjectActivitySeenSchema.parse(response.payload);
        if (
          seen.memberId === input.window.memberId &&
          seen.cursor === input.window.highCursor &&
          (!input.window.welcomeDue || !seen.welcomeDue)
        )
          return seen;
      }
    }
    throw cause;
  }
};
