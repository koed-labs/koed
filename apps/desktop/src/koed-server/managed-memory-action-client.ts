import {
  managedMemoryActionRequestSchema,
  managedMemoryActionResultSchema,
  type ManagedMemoryActionRequest,
  type ManagedMemoryActionResult
} from "../ipc/managed-memory-action-protocol.js";
import type { ProjectsAuthority } from "./projects-client.js";
import { fetchBoundedJsonObject } from "@koed/shared";

export const createManagedMemoryActionClient =
  (
    requestJson: (
      path: string,
      init: RequestInit,
      bound: ProjectsAuthority
    ) => Promise<Record<string, unknown>>,
    authority: () => Promise<ProjectsAuthority>
  ) =>
  async (
    value: ManagedMemoryActionRequest
  ): Promise<ManagedMemoryActionResult> => {
    const request = managedMemoryActionRequestSchema.parse(value);
    const bound = await authority();
    if (request.operation === "undo" && !bound.canWrite)
      throw new Error("Memory action write authority is unavailable.");
    if ((await authority()).key !== bound.key)
      throw new Error("Memory profile changed before request.");
    const base = `/v1/managed-conversations/${encodeURIComponent(request.executionId)}/memory-actions`;
    const result = managedMemoryActionResultSchema.parse(
      await requestJson(
        request.operation === "undo"
          ? `${base}/${encodeURIComponent(request.actionId)}/undo`
          : base,
        { method: request.operation === "undo" ? "POST" : "GET" },
        bound
      )
    );
    if ((await authority()).key !== bound.key)
      throw new Error("Memory profile changed during request.");
    if (
      result.operation !== request.operation ||
      result.executionId !== request.executionId ||
      (result.operation === "list" &&
        result.actions.some(
          (action) => action.executionId !== request.executionId
        )) ||
      (request.operation === "undo" &&
        result.operation === "undo" &&
        (result.action.id !== request.actionId ||
          result.action.executionId !== request.executionId ||
          result.action.outcome !== "undone"))
    )
      throw new Error("Memory action response crossed Conversation identity.");
    return result;
  };

export const createBoundManagedMemoryActionClient = (
  fetcher: typeof fetch,
  authority: () => Promise<ProjectsAuthority>
) =>
  createManagedMemoryActionClient(async (path, init, bound) => {
    const remote = await fetchBoundedJsonObject(
      fetcher,
      new URL(path, bound.apiOrigin),
      {
        ...init,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: bound.authorization
        }
      },
      { timeoutMs: 30_000, maxBytes: 512_000 }
    );
    if (!remote.response.ok) {
      await remote.response.body?.cancel().catch(() => undefined);
      throw new Error("Memory actions are unavailable.");
    }
    return remote.payload;
  }, authority);
