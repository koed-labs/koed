import {
  personalDesktopChatDeleteDataSchema,
  personalDesktopChatForgetDataSchema,
  personalDesktopPendingChatForgetsDataSchema,
  personalDesktopDeletedChatsDataSchema,
  personalDesktopPendingChatDeletionsDataSchema,
  type PersonalDesktopRequest
} from "@koed/shared/personal-desktop";

export type ChatLifecycleAuthority = {
  key: string;
  ownerId: string;
  apiOrigin: string;
  authorization: string;
};
type BoundRequest = (
  path: string,
  init: RequestInit,
  maximumResponseBytes: number,
  authority: ChatLifecycleAuthority
) => Promise<Record<string, unknown>>;

/** One exact local credential dispatch per call; uncertain writes reconcile by batch. */
export const createChatLifecycleClient = (input: {
  authority: () => Promise<ChatLifecycleAuthority>;
  requestJson: BoundRequest;
}) => {
  const endpoint = (sessionId: string, suffix = "") =>
    `/v1/memory/graph/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const send = async (path: string, init: RequestInit, maxBytes: number) => {
    const bound = await input.authority();
    const payload = await input.requestJson(path, init, maxBytes, bound);
    const after = await input.authority();
    if (after.key !== bound.key || after.ownerId !== bound.ownerId)
      throw new Error("Conversation lifecycle profile changed.");
    return payload;
  };
  const checkedStatus = (
    payload: Record<string, unknown>,
    sessionId: string,
    batchId: string
  ) => {
    const status = personalDesktopChatDeleteDataSchema.parse({
      status: payload
    }).status;
    if (status.sessionId !== sessionId || status.batchId !== batchId)
      throw new Error("Conversation deletion response identity changed.");
    return { status };
  };
  const checkedForget = (payload: Record<string, unknown>, batchId: string) => {
    const status = personalDesktopChatForgetDataSchema.parse(payload);
    if (status.batchId !== batchId)
      throw new Error("Conversation Forget response identity changed.");
    return status;
  };
  return {
    async forget(
      inputValue: Extract<
        PersonalDesktopRequest,
        { operation: "personal.sessions.forget" }
      >["input"]
    ) {
      const payload = await send(
        endpoint(inputValue.sessionId, "/forget"),
        json("POST", { batchId: inputValue.batchId }),
        1_048_576
      );
      return checkedForget(payload, inputValue.batchId);
    },
    async progressForget(inputValue: { sessionId: string; batchId: string }) {
      const payload = await send(
        endpoint(inputValue.sessionId, "/forget-progress"),
        json("POST", { batchId: inputValue.batchId }),
        1_048_576
      );
      return checkedForget(payload, inputValue.batchId);
    },
    async listPendingForgets() {
      const payload = await send(
        "/v1/memory/graph/sessions/forget-pending",
        { method: "GET" },
        1_048_576
      );
      return personalDesktopPendingChatForgetsDataSchema.parse(payload);
    },
    async undoForget(
      inputValue: Extract<
        PersonalDesktopRequest,
        { operation: "personal.sessions.forget_undo" }
      >["input"]
    ) {
      await send(
        endpoint(inputValue.sessionId, "/forget-undo"),
        json("POST", { batchId: inputValue.batchId }),
        262_144
      );
      return { outcome: "restored" as const };
    },
    async trash(
      inputValue: Extract<
        PersonalDesktopRequest,
        { operation: "personal.sessions.trash" }
      >["input"]
    ) {
      const payload = await send(
        endpoint(inputValue.sessionId),
        json("DELETE", { batchId: inputValue.batchId }),
        1_048_576
      );
      return checkedStatus(payload, inputValue.sessionId, inputValue.batchId);
    },
    async progress(
      inputValue: Extract<
        PersonalDesktopRequest,
        { operation: "personal.sessions.delete_progress" }
      >["input"]
    ) {
      const payload = await send(
        endpoint(inputValue.sessionId, "/delete-progress"),
        json("POST", { batchId: inputValue.batchId }),
        1_048_576
      );
      return checkedStatus(payload, inputValue.sessionId, inputValue.batchId);
    },
    async restore(
      inputValue: Extract<
        PersonalDesktopRequest,
        { operation: "personal.sessions.restore" }
      >["input"]
    ) {
      await send(
        endpoint(inputValue.sessionId, "/restore"),
        json("POST", inputValue.batchId ? { batchId: inputValue.batchId } : {}),
        262_144
      );
      return { outcome: "restored" as const };
    },
    async listDeleted(inputValue: { cursor?: string } = {}) {
      const path = `/v1/memory/graph/sessions/deleted${inputValue.cursor ? `?cursor=${encodeURIComponent(inputValue.cursor)}` : ""}`;
      const payload = await send(path, { method: "GET" }, 1_048_576);
      return personalDesktopDeletedChatsDataSchema.parse(payload);
    },
    async listPending() {
      const payload = await send(
        "/v1/memory/graph/sessions/delete-pending",
        { method: "GET" },
        1_048_576
      );
      return personalDesktopPendingChatDeletionsDataSchema.parse(payload);
    }
  };
};
