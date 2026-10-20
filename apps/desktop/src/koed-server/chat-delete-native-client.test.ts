import { describe, expect, it, vi } from "vitest";
import { createChatDeleteNativeClient } from "./chat-delete-native-client.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe("chat deletion Native client", () => {
  it("rejects a deletion progress response for another session or batch", async () => {
    const authority = {
      key: "profile",
      ownerId: uuid(1),
      apiOrigin: "http://local",
      authorization: "token",
      canWrite: true
    };
    const requestJson = vi.fn(async () => ({
      sessionId: uuid(3),
      batchId: uuid(2),
      state: "complete",
      complete: true,
      pending: false,
      pendingReviews: []
    }));
    const client = createChatDeleteNativeClient({
      authority: async () => authority,
      requestJson
    });
    await expect(client.progress(uuid(4), uuid(2))).rejects.toThrow(
      "identity changed"
    );
    requestJson.mockResolvedValueOnce({
      sessionId: uuid(4),
      batchId: uuid(5),
      state: "complete",
      complete: true,
      pending: false,
      pendingReviews: []
    });
    await expect(client.progress(uuid(4), uuid(2))).rejects.toThrow(
      "identity changed"
    );
  });
});
