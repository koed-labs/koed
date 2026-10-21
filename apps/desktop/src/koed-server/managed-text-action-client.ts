import { fetchBoundedJsonObject } from "@koed/shared";
import {
  managedTextActionRequestSchema,
  managedTextActionResultSchema,
  type ManagedTextActionRequest,
  type ManagedTextActionResult
} from "../ipc/managed-text-action-protocol.js";
import type { ProjectsAuthority } from "./projects-client.js";

export const createBoundManagedTextActionClient =
  (fetcher: typeof fetch, authority: () => Promise<ProjectsAuthority>) =>
  async (value: ManagedTextActionRequest): Promise<ManagedTextActionResult> => {
    const request = managedTextActionRequestSchema.parse(value);
    const bound = await authority();
    if (
      request.operation !== "list" &&
      request.operation !== "get" &&
      request.operation !== "deck-result" &&
      !bound.canWrite
    )
      throw new Error("Koed action write authority is unavailable.");
    if ((await authority()).key !== bound.key)
      throw new Error("Koed profile changed before request.");
    const base = `/v1/managed-conversations/${encodeURIComponent(request.executionId)}/text-actions`;
    const path =
      request.operation === "list"
        ? base
        : request.operation === "get"
          ? `${base}/${encodeURIComponent(request.actionId)}`
          : request.operation === "deck-result"
            ? `${base}/${encodeURIComponent(request.actionId)}/deck-result`
            : `${base}/${encodeURIComponent(request.actionId)}/${request.operation}`;
    const init: RequestInit =
      request.operation === "list" ||
      request.operation === "get" ||
      request.operation === "deck-result"
        ? { method: "GET" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              request.operation === "review"
                ? {
                    expectedRevision: request.expectedRevision,
                    decision: request.decision
                  }
                : { expectedRevision: request.expectedRevision }
            )
          };
    const remote = await fetchBoundedJsonObject(
      fetcher,
      new URL(path, bound.apiOrigin),
      {
        ...init,
        redirect: "error",
        headers: {
          accept: "application/json",
          ...init.headers,
          authorization: bound.authorization
        }
      },
      { timeoutMs: 30_000, maxBytes: 512_000 }
    );
    if (!remote.response.ok) {
      await remote.response.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error("Koed action could not be confirmed."), {
        statusCode: remote.response.status
      });
    }
    if ((await authority()).key !== bound.key)
      throw new Error("Koed profile changed during request.");
    const result = managedTextActionResultSchema.parse({
      operation: request.operation,
      executionId: request.executionId,
      ...remote.payload
    });
    if (result.operation === "list") {
      if (
        result.actions.some(
          (action) =>
            action.executionId !== request.executionId ||
            action.ownerUserId !== bound.ownerId
        )
      )
        throw new Error("Koed action list crossed owner identity.");
    } else if (request.operation === "deck-result") {
      if (result.operation !== "deck-result")
        throw new Error("Koed Deck result crossed operation identity.");
    } else if (
      request.operation !== "list" &&
      result.operation !== "deck-result"
    ) {
      if (
        result.action.executionId !== request.executionId ||
        result.action.ownerUserId !== bound.ownerId ||
        result.action.id !== request.actionId
      )
        throw new Error("Koed action crossed owner or action identity.");
    }
    return result;
  };
