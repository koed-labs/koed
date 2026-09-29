import { describe, expect, it, vi } from "vitest";

import { CommandOpIdStore } from "../src/command-op-id-store.js";
import type { MemoryApiClient } from "../src/index.js";
import type {
  ManagedConversationControlActionResult,
  ManagedConversationControlActionState
} from "../src/managed-conversation-command-types.js";

const SEGMENT_KEY = "command_action_state";

const mockMemoryClient = (): {
  client: MemoryApiClient;
  list: ReturnType<typeof vi.fn>;
  getContent: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
} => {
  const list = vi.fn();
  const getContent = vi.fn();
  const append = vi.fn();
  const client = {
    listConversationSourceSegments: list,
    getConversationSourceSegmentContent: getContent,
    appendConversationSourceSegment: append
  } as unknown as MemoryApiClient;
  return { client, list, getContent, append };
};

describe("CommandOpIdStore", () => {
  describe("get / set", () => {
    it("returns undefined for unknown operation ID", () => {
      const { client } = mockMemoryClient();
      const store = new CommandOpIdStore(client);
      expect(store.get("unknown-op")).toBeUndefined();
    });

    it("stores and retrieves operation state", () => {
      const { client } = mockMemoryClient();
      const store = new CommandOpIdStore(client);
      const result: ManagedConversationControlActionResult = {
        status: "accepted"
      };
      store.set("op-1", result);
      expect(store.get("op-1")).toEqual(result);
    });

    it("overwrites existing state", () => {
      const { client } = mockMemoryClient();
      const store = new CommandOpIdStore(client);
      store.set("op-1", { status: "unknown" });
      store.set("op-1", { status: "accepted" });
      expect(store.get("op-1")).toEqual({ status: "accepted" });
    });

    it("tracks has() correctly", () => {
      const { client } = mockMemoryClient();
      const store = new CommandOpIdStore(client);
      expect(store.has("op-1")).toBe(false);
      store.set("op-1", { status: "accepted" });
      expect(store.has("op-1")).toBe(true);
    });
  });

  describe("ensureArtifact (restore)", () => {
    it("restores states from segment content", async () => {
      const { client, list, getContent } = mockMemoryClient();
      const state: Omit<ManagedConversationControlActionState, "operationId" | "actionId" | "executionGeneration"> = {
        status: "accepted",
        createdAt: "2025-01-01T00:00:00.000Z"
      };
      const segmentData = {
        version: 1,
        states: {
          "op-1": state,
          "op-2": { ...state, status: "rejected", reason: "unsupported_action" }
        }
      };
      list.mockResolvedValue({
        segments: [{ id: "seg-1", key: SEGMENT_KEY }]
      });
      getContent.mockResolvedValue({
        content: JSON.stringify(segmentData)
      });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("op-1")).toEqual({ status: "accepted" });
      expect(store.get("op-2")).toEqual({ status: "rejected", reason: "unsupported_action" });
    });

    it("ignores non-matching segment keys", async () => {
      const { client, list } = mockMemoryClient();
      list.mockResolvedValue({
        segments: [{ id: "seg-1", key: "other_key" }]
      });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("any-op")).toBeUndefined();
    });

    it("silently fails when artifact has no segments", async () => {
      const { client, list } = mockMemoryClient();
      list.mockResolvedValue({ segments: [] });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("any-op")).toBeUndefined();
    });

    it("silently fails on API error", async () => {
      const { client, list } = mockMemoryClient();
      list.mockRejectedValue(new Error("network error"));
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("any-op")).toBeUndefined();
    });

    it("skips invalid segment versions", async () => {
      const { client, list, getContent } = mockMemoryClient();
      list.mockResolvedValue({
        segments: [{ id: "seg-1", key: SEGMENT_KEY }]
      });
      getContent.mockResolvedValue({
        content: JSON.stringify({ version: 2, states: {} })
      });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("any-op")).toBeUndefined();
    });

    it("idempotent: second call does not re-restore", async () => {
      const { client, list, getContent } = mockMemoryClient();
      const state: Omit<ManagedConversationControlActionState, "operationId" | "actionId" | "executionGeneration"> = {
        status: "accepted",
        createdAt: "2025-01-01T00:00:00.000Z"
      };
      list.mockResolvedValue({
        segments: [{ id: "seg-1", key: SEGMENT_KEY }]
      });
      getContent.mockResolvedValue({
        content: JSON.stringify({ version: 1, states: { "op-1": state } })
      });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");
      await store.ensureArtifact("artifact-1");

      expect(store.get("op-1")).toEqual({ status: "accepted" });
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("guards against concurrent restores", async () => {
      const { client, list } = mockMemoryClient();
      let resolveRestore: () => void;
      const restorePromise = new Promise<void>((resolve) => {
        resolveRestore = resolve;
      });
      list.mockReturnValue(restorePromise);
      const store = new CommandOpIdStore(client);

      const p1 = store.ensureArtifact("artifact-1");
      const p2 = store.ensureArtifact("artifact-1");

      resolveRestore!();

      await Promise.all([p1, p2]);

      expect(list).toHaveBeenCalledTimes(1);
    });
  });

  describe("save", () => {
    it("writes in-memory states to segment", async () => {
      const { client, append } = mockMemoryClient();
      append.mockResolvedValue({});
      const store = new CommandOpIdStore(client);
      store.set("op-1", { status: "accepted" });
      store.set("op-2", { status: "rejected", reason: "test" });

      await store.save("artifact-1");

      expect(append).toHaveBeenCalledWith("artifact-1", expect.objectContaining({
        key: SEGMENT_KEY
      }));
      const call = append.mock.calls[0];
      const parsed = JSON.parse(call[1].content as string);
      expect(parsed.version).toBe(1);
      expect(parsed.states["op-1"].status).toBe("accepted");
      expect(parsed.states["op-2"].status).toBe("rejected");
      expect(parsed.states["op-2"].reason).toBe("test");
    });

    it("skips save when no states exist", async () => {
      const { client, append } = mockMemoryClient();
      append.mockResolvedValue({});
      const store = new CommandOpIdStore(client);

      await store.save("artifact-1");

      expect(append).not.toHaveBeenCalled();
    });

    it("silently fails on save error", async () => {
      const { client, append } = mockMemoryClient();
      append.mockRejectedValue(new Error("conflict"));
      const store = new CommandOpIdStore(client);
      store.set("op-1", { status: "accepted" });

      await store.save("artifact-1");

      // Should not throw
    });
  });

  describe("status mapping", () => {
    it("converts pending stored state to unknown result", async () => {
      const { client, list, getContent } = mockMemoryClient();
      const state: Omit<ManagedConversationControlActionState, "operationId" | "actionId" | "executionGeneration"> = {
        status: "pending",
        createdAt: "2025-01-01T00:00:00.000Z"
      };
      list.mockResolvedValue({
        segments: [{ id: "seg-1", key: SEGMENT_KEY }]
      });
      getContent.mockResolvedValue({
        content: JSON.stringify({ version: 1, states: { "op-1": state } })
      });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("op-1")).toEqual({ status: "unknown" });
    });

    it("converts already_accepted stored state to accepted result", async () => {
      const { client, list, getContent } = mockMemoryClient();
      const state: Omit<ManagedConversationControlActionState, "operationId" | "actionId" | "executionGeneration"> = {
        status: "accepted",
        createdAt: "2025-01-01T00:00:00.000Z"
      };
      list.mockResolvedValue({
        segments: [{ id: "seg-1", key: SEGMENT_KEY }]
      });
      getContent.mockResolvedValue({
        content: JSON.stringify({ version: 1, states: { "op-1": state } })
      });
      const store = new CommandOpIdStore(client);

      await store.ensureArtifact("artifact-1");

      expect(store.get("op-1")).toEqual({ status: "accepted" });
    });
  });
});
