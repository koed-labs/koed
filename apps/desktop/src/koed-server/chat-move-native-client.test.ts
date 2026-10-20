import { describe, expect, it, vi } from "vitest";
import { createChatMoveNativeClient } from "./chat-move-native-client.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = uuid(1),
  batchId = uuid(2),
  actionGrantId = uuid(3);
const authority = {
  key: "owner-profile",
  ownerId: uuid(4),
  apiOrigin: "http://local",
  authorization: "token",
  canWrite: true
};
const reservation = {
  sessionId,
  batchId,
  actionGrantId,
  bindingId: uuid(5),
  commandRequestId: uuid(6),
  oldProjectId: uuid(7),
  oldWorkspaceProjectId: uuid(12),
  oldProjectVersion: 2,
  targetProjectId: null,
  mappingVersion: 2,
  backendId: "backend-1",
  logicalMemoryId: uuid(8),
  teamId: uuid(9),
  teamWorkspaceId: uuid(10),
  shareGrantId: uuid(11),
  reviewedGrantVersion: 3,
  manifestHash: "a".repeat(64)
};
const status = {
  sessionId,
  batchId,
  pending: true,
  complete: false,
  projectId: uuid(7),
  pendingReviews: [{ bindingId: uuid(5), actionGrantId }]
};

describe("chat move trusted Native client", () => {
  it("reads an exact reservation through bound owner authority", async () => {
    const requestJson = vi.fn(async () => reservation);
    const client = createChatMoveNativeClient({
      authority: async () => authority,
      requestJson
    });
    const prepared = await client.prepareReview(
      sessionId,
      batchId,
      actionGrantId
    );
    expect(prepared).toEqual({
      reservation,
      authorityKey: authority.key,
      ownerId: authority.ownerId
    });
    expect(requestJson).toHaveBeenCalledExactlyOnceWith(
      `/v1/memory/graph/sessions/${sessionId}/move-reviews/${actionGrantId}?batchId=${batchId}`,
      { method: "GET" },
      authority
    );
  });

  it("rejects operation mismatches and a changed owner profile", async () => {
    for (const changed of [
      { ...reservation, sessionId: uuid(20) },
      { ...reservation, batchId: uuid(21) },
      { ...reservation, actionGrantId: uuid(22) }
    ]) {
      const client = createChatMoveNativeClient({
        authority: async () => authority,
        requestJson: async () => changed
      });
      await expect(
        client.prepareReview(sessionId, batchId, actionGrantId)
      ).rejects.toThrow("identity changed");
    }
    let call = 0;
    const requestJson = vi.fn(async () => reservation);
    const client = createChatMoveNativeClient({
      authority: async () =>
        ++call < 3 ? authority : { ...authority, ownerId: uuid(23) },
      requestJson
    });
    await expect(
      client.prepareReview(sessionId, batchId, actionGrantId)
    ).rejects.toThrow("identity changed");
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("sends one bound progress request and accepts pending status", async () => {
    const requestJson = vi.fn(async () => status);
    const client = createChatMoveNativeClient({
      authority: async () => authority,
      requestJson
    });
    await expect(client.progress(sessionId, batchId)).resolves.toEqual(status);
    expect(requestJson).toHaveBeenCalledExactlyOnceWith(
      `/v1/memory/graph/sessions/${sessionId}/move-progress`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId })
      },
      authority
    );
  });

  it("does not dispatch without write authority and rejects mismatched progress", async () => {
    const requestJson = vi.fn(async () => status);
    const noWrite = createChatMoveNativeClient({
      authority: async () => ({ ...authority, canWrite: false }),
      requestJson
    });
    await expect(noWrite.progress(sessionId, batchId)).rejects.toThrow(
      "authority is unavailable"
    );
    expect(requestJson).not.toHaveBeenCalled();
    for (const changed of [
      { ...status, sessionId: uuid(20) },
      { ...status, batchId: uuid(21) }
    ]) {
      const client = createChatMoveNativeClient({
        authority: async () => authority,
        requestJson: async () => changed
      });
      await expect(client.progress(sessionId, batchId)).rejects.toThrow(
        "identity changed"
      );
    }
  });
});
