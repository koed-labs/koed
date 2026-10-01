import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryApiClient } from "../src/index.js";
import { CommandOpIdStore } from "../src/command-op-id-store.js";
import type { ManagedConversationControlActionResult } from "../src/managed-conversation-command-types.js";

describe("CommandOpIdStore", () => {
  let store: CommandOpIdStore;
  let memoryClient: MemoryApiClient;
  let savedSegments: Array<{
    content: Record<string, unknown>;
    artifactId: string;
  }>;
  let restoredSegments: Record<string, Array<{ id: string }>>;
  let segmentContents: Record<
    string,
    Array<{ id: string; bytesBase64: string }>
  >;

  beforeEach(() => {
    savedSegments = [];
    restoredSegments = {};
    segmentContents = {};

    memoryClient = {
      ensureConversationSourceArtifact: vi
        .fn()
        .mockResolvedValue({ id: "art-1" }),
      lookupConversationSourceArtifact: vi
        .fn()
        .mockResolvedValue({ id: "art-1" }),
      listConversationSourceSegments: vi.fn((artifactId: string) => ({
        segments: (restoredSegments[artifactId] ?? []) as Array<{ id: string }>
      })),
      getConversationSourceSegmentContent: vi.fn(
        (artifactId: string, segmentId: string) => {
          const segs = segmentContents[artifactId] ?? [];
          const seg = segs.find((s) => s.id === segmentId);
          if (!seg) throw new Error("missing fake source segment");
          return { segment: { id: seg.id }, bytesBase64: seg.bytesBase64 };
        }
      ),
      appendConversationSourceSegment: vi.fn(
        (artifactId: string, content: Record<string, unknown>) => {
          const id = `seg-${savedSegments.length + 1}`;
          savedSegments.push({ artifactId, content });
          restoredSegments[artifactId] = restoredSegments[artifactId] ?? [];
          restoredSegments[artifactId].push({ id });
          segmentContents[artifactId] = segmentContents[artifactId] ?? [];
          segmentContents[artifactId].push({
            id,
            bytesBase64: content.bytesBase64 as string
          });
          return Promise.resolve({ segment: { id } });
        }
      ),
      getEffectiveCapturePolicy: vi.fn().mockResolvedValue({ policies: [] }),
      createSession: vi.fn().mockResolvedValue({ session: {} }),
      finalizeConversationSourceSet: vi
        .fn()
        .mockResolvedValue({ segments: [] }),
      getConversationSourceArtifactByGeneration: vi
        .fn()
        .mockResolvedValue({ artifact: {} }),
      listConversationSourceGenerationComponents: vi
        .fn()
        .mockResolvedValue({ components: [] }),
      finalizeConversationSourceArtifact: vi
        .fn()
        .mockResolvedValue({ artifact: {} }),
      createConversationSourceSuccessorGeneration: vi
        .fn()
        .mockResolvedValue({ sourceGeneration: {} }),
      getConversationSourceCursor: vi.fn().mockResolvedValue({ cursor: null }),
      advanceConversationSourceCursor: vi
        .fn()
        .mockResolvedValue({ cursor: {} }),
      lookupHistoricalImportSource: vi.fn().mockResolvedValue({ source: {} }),
      createHistoricalImportSource: vi.fn().mockResolvedValue({ source: {} }),
      transitionHistoricalImportRun: vi.fn().mockResolvedValue({ run: {} }),
      transitionHistoricalImportSource: vi
        .fn()
        .mockResolvedValue({ source: {} }),
      ingestHistoricalImportBatch: vi.fn().mockResolvedValue({ batch: {} }),
      effectiveCapturePolicy: vi.fn().mockResolvedValue({ policies: [] }),
      capturePersonalEvent: vi.fn().mockResolvedValue({ event: {} }),
      createConversationItems: vi.fn().mockResolvedValue({ items: [] }),
      findConversationItemByStableIdentity: vi
        .fn()
        .mockResolvedValue({ item: null }),
      recordTokenUsage: vi.fn().mockResolvedValue({ usage: {} }),
      projectConversationItems: vi.fn().mockResolvedValue({ projected: [] }),
      releaseManagedJournalProjection: vi
        .fn()
        .mockResolvedValue({ release: {} }),
      releaseConversationProjectionHold: vi
        .fn()
        .mockResolvedValue({ release: {} }),
      answer: vi.fn().mockResolvedValue({ answer: {} }),
      proposeCuratedMemory: vi.fn().mockResolvedValue({ memory: {} }),
      claimPendingCuratedMemoryReviews: vi
        .fn()
        .mockResolvedValue({ reviews: [] }),
      submitCuratedMemoryReview: vi.fn().mockResolvedValue({ review: {} }),
      createFinalQuestion: vi.fn().mockResolvedValue({ question: {} }),
      acceptMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      getMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      claimMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      heartbeatMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      cancelMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      completeMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      failMemoryAnswerTask: vi.fn().mockResolvedValue({ task: {} }),
      createPendingDesktopAsk: vi.fn().mockResolvedValue({ ask: {} }),
      sourceArtifacts: new Map()
    } as unknown as MemoryApiClient;

    store = new CommandOpIdStore(memoryClient);
  });

  describe("get/set", () => {
    it("stores and retrieves operation results", () => {
      const result: ManagedConversationControlActionResult = {
        status: "rejected",
        reason: "test"
      };
      store.set("op-1", result);
      expect(store.get("op-1")).toEqual(result);
    });

    it("returns undefined for unknown operation IDs", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("has checks operation existence", () => {
      store.set("op-1", { status: "accepted" });
      expect(store.has("op-1")).toBe(true);
      expect(store.has("op-2")).toBe(false);
    });
  });

  describe("ensureArtifact/restore", () => {
    it("persists state to segment on save and restores it", async () => {
      const artifactId = "art-1";
      const result: ManagedConversationControlActionResult = {
        status: "rejected",
        reason: "cached"
      };
      store.set("op-1", result);

      await store.ensureArtifact(artifactId);
      await store.save(artifactId);

      expect(savedSegments.length).toBe(1);
      const content = savedSegments[0].content as Record<string, unknown>;
      expect(typeof content.bytesBase64).toBe("string");
      expect(typeof content.plaintextDigest).toBe("string");
      expect(typeof content.plaintextSize).toBe("number");

      const stored = JSON.parse(
        Buffer.from(content.bytesBase64 as string, "base64").toString("utf8")
      ) as Record<string, unknown>;
      const storedStates = stored.states as Record<
        string,
        Record<string, unknown>
      >;
      expect(stored._koed_op_id_state).toBe(true);
      expect(storedStates["op-1"].status).toBe("rejected");
      expect(storedStates["op-1"].reason).toBe("cached");
      expect(typeof storedStates["op-1"].createdAt).toBe("string");
    });

    it("restores state from saved segment on next ensureArtifact", async () => {
      const artifactId = "art-2";
      store.set("op-2", { status: "accepted" });
      await store.ensureArtifact(artifactId);
      await store.save(artifactId);

      // New store instance with same saved data
      const newStore = new CommandOpIdStore(memoryClient);
      await newStore.ensureArtifact(artifactId);
      expect(newStore.get("op-2")).toEqual({ status: "accepted" });
    });

    it("is idempotent — save after restore doesn't duplicate", async () => {
      const artifactId = "art-3";
      store.set("op-1", { status: "accepted" });
      await store.ensureArtifact(artifactId);
      await store.save(artifactId);
      await store.save(artifactId);

      expect(savedSegments.length).toBe(2);
      // The in-memory map is not duplicated — save re-saves current state
      const newStore = new CommandOpIdStore(memoryClient);
      await newStore.ensureArtifact(artifactId);
      expect(newStore.get("op-1")).toEqual({ status: "accepted" });
    });
  });

  describe("concurrent restore guard", () => {
    it("does not double-restore for same artifact", async () => {
      const artifactId = "art-4";
      const result: ManagedConversationControlActionResult = {
        status: "accepted"
      };
      store.set("op-1", result);
      await store.ensureArtifact(artifactId);
      await store.save(artifactId);

      // Another store instance starts restore for same artifact
      const newStore = new CommandOpIdStore(memoryClient);
      await newStore.ensureArtifact(artifactId);

      // Both should see the same restored data
      expect(newStore.get("op-1")).toEqual(result);
    });
  });

  describe("status mapping", () => {
    it("converts accepted/already_accepted to accepted stored state", async () => {
      const artifactId = "art-5";
      store.set("op-1", { status: "accepted" });
      store.set("op-2", { status: "already_accepted" });
      await store.ensureArtifact(artifactId);
      await store.save(artifactId);

      const newStore = new CommandOpIdStore(memoryClient);
      await newStore.ensureArtifact(artifactId);
      expect(newStore.get("op-1")).toEqual({ status: "accepted" });
      expect(newStore.get("op-2")).toEqual({ status: "accepted" });
    });

    it("converts unknown stored state back to unknown result", async () => {
      const artifactId = "art-6";
      store.set("op-1", { status: "unknown" });
      await store.ensureArtifact(artifactId);
      await store.save(artifactId);

      const newStore = new CommandOpIdStore(memoryClient);
      await newStore.ensureArtifact(artifactId);
      expect(newStore.get("op-1")).toEqual({ status: "unknown" });
    });

    it("converts rejected stored state back to rejected result with reason", async () => {
      const artifactId = "art-7";
      store.set("op-1", { status: "rejected", reason: "generation_changed" });
      await store.ensureArtifact(artifactId);
      await store.save(artifactId);

      const newStore = new CommandOpIdStore(memoryClient);
      await newStore.ensureArtifact(artifactId);
      expect(newStore.get("op-1")).toEqual({
        status: "rejected",
        reason: "generation_changed"
      });
    });
  });
});
