import {
  fetchBoundedJson,
  readLocalEdgeUpstreamRegistry,
  upstreamBackendById
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { safeUpstreamProxyUrl } from "../local-edge/upstream-routing.js";

export type SharedDispatchLink = {
  teamBackendId: string;
  workspaceProjectId: string;
  teamPrincipalUserId: string;
};

export async function requireSharedDispatchRunnerAuthority(
  context: ApiRouteContext,
  ownerUserId: string,
  execution: { id: string; projectId: string }
): Promise<void> {
  const repository = context.requireRepository();
  const dispatch = await repository.getSharedWorkItemDispatchForExecution(
    { userId: ownerUserId },
    execution.id
  );
  if (!dispatch) return;
  const link = await repository.getSharedDispatchLink(
    ownerUserId,
    execution.projectId
  );
  if (!link)
    throw Object.assign(new Error("Shared Project link is unavailable"), {
      statusCode: 409
    });
  if (
    link.teamBackendId !== dispatch.teamBackendId ||
    link.teamPrincipalUserId !== dispatch.teamPrincipalUserId ||
    link.workspaceProjectId !== dispatch.workspaceProjectId
  )
    unavailable();
  try {
    await readSharedDispatchAttemptAuthority(context, link, {
      itemId: dispatch.teamWorkItemId,
      dispatchKey: `shared-work-item:${dispatch.workspaceProjectId}:${dispatch.teamWorkItemId}:${dispatch.teamWorkItemVersion}`
    });
  } catch {
    return unavailable();
  }
}

const principalSchema = z
  .object({
    ok: z.literal(true),
    auth: z.literal("device_credential"),
    user: z.object({ id: z.uuid() }).passthrough()
  })
  .passthrough();
const proofSchema = z
  .object({
    projectId: z.uuid(),
    itemId: z.uuid(),
    projectVersion: z.number().int().positive(),
    memberVersion: z.number().int().positive(),
    workItemVersion: z.number().int().positive(),
    title: z.string().min(1).max(500),
    goal: z.string().max(20_000),
    status: z.enum(["todo", "blocked"])
  })
  .strict();
const attemptSchema = z
  .object({
    allowed: z.literal(true),
    projectId: z.uuid(),
    itemId: z.uuid(),
    dispatchKey: z.string().min(1).max(255),
    workItemVersion: z.number().int().positive()
  })
  .strict();

const unavailable = (): never => {
  throw Object.assign(new Error("Authoritative Team dispatch is unavailable"), {
    statusCode: 409
  });
};
const temporarilyUnavailable = (): never => {
  throw Object.assign(
    new Error("Authoritative Team dispatch read is temporarily unavailable"),
    {
      statusCode: 503
    }
  );
};

export async function readSharedDispatchAuthority(
  context: ApiRouteContext,
  link: SharedDispatchLink,
  input: {
    itemId: string;
    expectedProjectVersion: number;
    expectedMemberVersion: number;
    expectedWorkItemVersion: number;
  }
) {
  if (!context.localEdge.remoteOperationsAllowed()) unavailable();
  const backend =
    upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      link.teamBackendId
    ) ?? unavailable();
  const authorization =
    context.localEdge.resolveUpstreamAuthorization(backend) ?? unavailable();
  const get = async (path: string, principal = false) => {
    const url = principal
      ? new URL(
          "v1/local-edge/device-credentials/status",
          new URL(backend.baseUrl.replace(/\/+$/, "/"))
        )
      : safeUpstreamProxyUrl(backend, path);
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      url,
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization
        }
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!result.response.ok) unavailable();
    return result.payload;
  };
  const principal = principalSchema.parse(await get("", true));
  if (principal.user.id !== link.teamPrincipalUserId) unavailable();
  const projectPath = `/v1/workspace-projects/${link.workspaceProjectId}`;
  const query = new URLSearchParams({
    expectedProjectVersion: String(input.expectedProjectVersion),
    expectedMemberVersion: String(input.expectedMemberVersion),
    expectedWorkItemVersion: String(input.expectedWorkItemVersion)
  });
  const proof = proofSchema.parse(
    await get(
      `${projectPath}/work-items/${input.itemId}/dispatch-proof?${query}`
    )
  );
  if (
    proof.projectId !== link.workspaceProjectId ||
    proof.itemId !== input.itemId ||
    proof.projectVersion !== input.expectedProjectVersion ||
    proof.memberVersion !== input.expectedMemberVersion ||
    proof.workItemVersion !== input.expectedWorkItemVersion
  )
    unavailable();
  return { kind: "new" as const, proof };
}

export async function readSharedDispatchAttemptAuthority(
  context: ApiRouteContext,
  link: SharedDispatchLink,
  input: { itemId: string; dispatchKey: string }
): Promise<{ workItemVersion: number }> {
  if (!context.localEdge.remoteOperationsAllowed()) temporarilyUnavailable();
  const backend =
    upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      link.teamBackendId
    ) ?? unavailable();
  const authorization =
    context.localEdge.resolveUpstreamAuthorization(backend) ?? unavailable();
  const read = async (url: URL) => {
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      url,
      {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", authorization }
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!result.response.ok) {
      if ([403, 404, 409].includes(result.response.status)) unavailable();
      temporarilyUnavailable();
    }
    return result.payload;
  };
  try {
    const principal = principalSchema.parse(
      await read(
        new URL(
          "v1/local-edge/device-credentials/status",
          new URL(backend.baseUrl.replace(/\/+$/, "/"))
        )
      )
    );
    if (principal.user.id !== link.teamPrincipalUserId) unavailable();
    const query = new URLSearchParams({ dispatchKey: input.dispatchKey });
    const attempt = attemptSchema.parse(
      await read(
        safeUpstreamProxyUrl(
          backend,
          `/v1/workspace-projects/${link.workspaceProjectId}/work-items/${input.itemId}/dispatch-authority?${query}`
        )
      )
    );
    if (
      attempt.projectId !== link.workspaceProjectId ||
      attempt.itemId !== input.itemId ||
      attempt.dispatchKey !== input.dispatchKey
    )
      unavailable();
    return { workItemVersion: attempt.workItemVersion };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error)
      throw error;
    return temporarilyUnavailable();
  }
}

export async function ensureSharedDispatchTeamReceipt(
  context: ApiRouteContext,
  link: SharedDispatchLink,
  input: { itemId: string; teamWorkItemVersion: number; dispatchKey: string }
): Promise<void> {
  if (!context.localEdge.remoteOperationsAllowed()) temporarilyUnavailable();
  const backend =
    upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      link.teamBackendId
    ) ?? unavailable();
  const authorization =
    context.localEdge.resolveUpstreamAuthorization(backend) ?? unavailable();
  try {
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(
        backend,
        `/v1/workspace-projects/${link.workspaceProjectId}/work-items/${input.itemId}/dispatch-receipt`
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization
        },
        body: JSON.stringify({
          expectedVersion: input.teamWorkItemVersion,
          dispatchKey: input.dispatchKey
        })
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (!result.response.ok) unavailable();
    const item = z
      .object({
        id: z.uuid(),
        status: z.literal("doing"),
        dispatchKey: z.literal(input.dispatchKey)
      })
      .passthrough()
      .parse(result.payload);
    if (item.id !== input.itemId) unavailable();
  } catch {
    // A lost PATCH response is resolved by an exact, owner-bound Team read.
  }
  await readSharedDispatchAttemptAuthority(context, link, {
    itemId: input.itemId,
    dispatchKey: input.dispatchKey
  });
}

export type SharedPublicProgress =
  | { kind: "working" | "turn_finished" | "failed" | "explicit_done" }
  | { kind: "review_open"; prUrl: string }
  | { kind: "review_merged" | "review_closed" };

/** Publish only fixed public metadata, after the caller has checked private evidence. */
export async function publishSharedWorkItemProgress(
  context: ApiRouteContext,
  ownerUserId: string,
  execution: { id: string; projectId: string },
  progress: SharedPublicProgress
): Promise<boolean> {
  const repository = context.requireRepository();
  const dispatch = await repository.getSharedWorkItemDispatchForExecution(
    { userId: ownerUserId },
    execution.id
  );
  if (!dispatch) return false;
  const link = await repository.getSharedDispatchLink(
    ownerUserId,
    execution.projectId
  );
  if (
    !link ||
    link.teamBackendId !== dispatch.teamBackendId ||
    link.workspaceProjectId !== dispatch.workspaceProjectId ||
    link.teamPrincipalUserId !== dispatch.teamPrincipalUserId
  )
    return unavailable();
  const dispatchKey = `shared-work-item:${dispatch.workspaceProjectId}:${dispatch.teamWorkItemId}:${dispatch.teamWorkItemVersion}`;
  const backend =
    upstreamBackendById(
      readLocalEdgeUpstreamRegistry(context.localEdge.upstreamBackendsPath),
      link.teamBackendId
    ) ?? unavailable();
  const authorization =
    context.localEdge.resolveUpstreamAuthorization(backend) ?? unavailable();
  const itemPath = `/v1/workspace-projects/${link.workspaceProjectId}/work-items/${dispatch.teamWorkItemId}`;
  const fixed =
    progress.kind === "working"
      ? { status: "doing", stepLabel: "Working now" }
      : progress.kind === "turn_finished"
        ? { status: "doing", stepLabel: "Agent finished this turn" }
        : progress.kind === "failed"
          ? { status: "blocked", stepLabel: "Execution stopped" }
          : progress.kind === "explicit_done"
            ? { status: "done", stepLabel: "Done" }
            : progress.kind === "review_merged"
              ? {
                  status: "done",
                  stepLabel: "Pull request merged",
                  prState: "merged"
                }
              : progress.kind === "review_closed"
                ? {
                    status: "blocked",
                    stepLabel: "Pull request closed",
                    prState: "closed"
                  }
                : {
                    status: "review",
                    stepLabel: "Pull request open",
                    prUrl: "prUrl" in progress ? progress.prUrl : "",
                    prState: "open"
                  };
  const matches = (item: unknown): boolean => {
    const parsed = z
      .object({
        id: z.uuid(),
        status: z.string(),
        stepLabel: z.string().nullable(),
        prUrl: z.string().nullable(),
        prState: z.string().nullable(),
        dispatchKey: z.string().nullable()
      })
      .passthrough()
      .safeParse(item);
    return (
      parsed.success &&
      parsed.data.id === dispatch.teamWorkItemId &&
      parsed.data.dispatchKey === dispatchKey &&
      parsed.data.status === fixed.status &&
      parsed.data.stepLabel === fixed.stepLabel &&
      (progress.kind === "review_open"
        ? parsed.data.prUrl === progress.prUrl && parsed.data.prState === "open"
        : progress.kind === "review_merged"
          ? parsed.data.prState === "merged"
          : progress.kind === "review_closed"
            ? parsed.data.prState === "closed"
            : true)
    );
  };
  const readCurrent = async (): Promise<boolean> => {
    try {
      const result = await fetchBoundedJson(
        context.localEdge.fetch,
        safeUpstreamProxyUrl(
          backend,
          `${itemPath}/dispatch-status?dispatchKey=${encodeURIComponent(dispatchKey)}`
        ),
        {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", authorization }
        },
        { timeoutMs: 15_000, maxBytes: 8_192 }
      );
      if (!result.response.ok) {
        if ([403, 404, 409].includes(result.response.status)) unavailable();
        temporarilyUnavailable();
      }
      return matches(result.payload);
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error)
        throw error;
      return temporarilyUnavailable();
    }
  };
  if (!context.localEdge.remoteOperationsAllowed()) temporarilyUnavailable();
  let version: number;
  try {
    version = (
      await readSharedDispatchAttemptAuthority(context, link, {
        itemId: dispatch.teamWorkItemId,
        dispatchKey
      })
    ).workItemVersion;
  } catch (error) {
    if (await readCurrent()) return true; // Lost prior terminal response: read only.
    if (error && typeof error === "object" && "statusCode" in error)
      throw error;
    return temporarilyUnavailable();
  }
  if (await readCurrent()) return true;
  try {
    const result = await fetchBoundedJson(
      context.localEdge.fetch,
      safeUpstreamProxyUrl(backend, `${itemPath}/dispatch-progress`),
      {
        method: "PATCH",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization
        },
        body: JSON.stringify({
          expectedVersion: version,
          dispatchKey,
          ...fixed
        })
      },
      { timeoutMs: 15_000, maxBytes: 64_000 }
    );
    if (result.response.ok && matches(result.payload)) return true;
  } catch {
    // Unknown dispatch outcome is reconciled by a read, never a second PATCH.
  }
  if (await readCurrent()) return true;
  return unavailable();
}
