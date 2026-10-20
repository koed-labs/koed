import { describe, expect, it, vi } from "vitest";
import { createChatLifecycleClient } from "./chat-lifecycle-client.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const authority = {
  key: "owner-a|profile-a",
  ownerId: uuid(1),
  apiOrigin: "http://local",
  authorization: "Bearer local"
};
const status = (sessionId: string, batchId: string) => ({
  sessionId,
  batchId,
  state: "freezing",
  complete: false,
  pending: true,
  pendingReviews: []
});

describe("chat lifecycle credential boundary", () => {
  it("dispatches an uncertain DELETE once and keeps its supplied batch", async () => {
    const requestJson = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe(`/v1/memory/graph/sessions/${uuid(2)}`);
      expect(init.method).toBe("DELETE");
      throw new Error("timeout after dispatch");
    });
    const client = createChatLifecycleClient({
      authority: async () => authority,
      requestJson
    });
    await expect(
      client.trash({ sessionId: uuid(2), batchId: uuid(3) })
    ).rejects.toThrow("timeout");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(JSON.parse(String(requestJson.mock.calls[0]?.[1]?.body))).toEqual({
      batchId: uuid(3)
    });
  });
  it("rejects an owner profile flip and mismatched progress identity", async () => {
    let current = authority;
    const requestJson = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe(`/v1/memory/graph/sessions/${uuid(2)}/delete-progress`);
      expect(init.method).toBe("POST");
      current = { ...authority, key: "owner-b|profile-b", ownerId: uuid(4) };
      return status(uuid(2), uuid(3));
    });
    const client = createChatLifecycleClient({
      authority: async () => current,
      requestJson
    });
    await expect(
      client.progress({ sessionId: uuid(2), batchId: uuid(3) })
    ).rejects.toThrow("profile changed");
    expect(requestJson).toHaveBeenCalledOnce();
    current = authority;
    requestJson.mockImplementation(async (path: string, init: RequestInit) => {
      expect(path).toBe(`/v1/memory/graph/sessions/${uuid(2)}/delete-progress`);
      expect(init.method).toBe("POST");
      return status(uuid(5), uuid(3));
    });
    await expect(
      client.progress({ sessionId: uuid(2), batchId: uuid(3) })
    ).rejects.toThrow("identity changed");
  });
  it("uses the same supplied Forget batch without replay on a failed write", async () => {
    const requestJson = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe(`/v1/memory/graph/sessions/${uuid(2)}/forget`);
      expect(init.method).toBe("POST");
      throw new Error("disconnected");
    });
    const client = createChatLifecycleClient({
      authority: async () => authority,
      requestJson
    });
    await expect(
      client.forget({ sessionId: uuid(2), batchId: uuid(6) })
    ).rejects.toThrow("disconnected");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(JSON.parse(String(requestJson.mock.calls[0]?.[1]?.body))).toEqual({
      batchId: uuid(6)
    });
  });
});
