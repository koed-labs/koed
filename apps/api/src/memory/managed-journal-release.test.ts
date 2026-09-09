import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerRawConversationRoutes } from "./raw-conversation-routes.js";
import { createFilesystemConversationSourceStorage } from "./conversation-source-storage.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "koed-journal-release-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const artifactId = randomUUID();
  const sessionId = randomUUID();
  const bytes = Buffer.from(
    [
      { type: "session", id: "native", version: 3 },
      {
        type: "message",
        id: "user",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "synthetic" }]
        }
      },
      {
        type: "message",
        id: "answer",
        parentId: "user",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "synthetic" }],
          stopReason: "stop"
        }
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const storage = createFilesystemConversationSourceStorage(home);
  const stored = storage.put({ artifactId, plaintextDigest: digest, bytes });
  const artifact = {
    id: artifactId,
    sessionId,
    ownerUserId: "owner",
    sourceKind: "pi",
    sourceComponentId: "main",
    externalSessionId: "native",
    lifecycle: "active",
    journalStartOffset: 0,
    journalStartLine: 0,
    providerCursorOffset: bytes.length
  };
  const segment = {
    id: randomUUID(),
    artifactId,
    sourceStartOffset: 0,
    sourceEndOffset: bytes.length,
    sourceStartLine: 0,
    sourceEndLine: 3,
    storageProvider: "filesystem",
    storageKey: stored.storageKey,
    plaintextDigest: digest
  };
  const repo = {
    getConversationSourceArtifact: vi.fn().mockResolvedValue(artifact),
    getCapturedSession: vi
      .fn()
      .mockResolvedValue({ metadata: { managedConversation: true } }),
    listConversationSourceSegments: vi.fn().mockResolvedValue([segment]),
    releaseConversationProjectionHold: vi
      .fn()
      .mockResolvedValue({ conversationItemIds: ["released"] })
  };
  const auth = vi.fn(async () => ({ id: "owner" }));
  const context = {
    requireRepository: () => repo,
    config: { koedHome: home, deploymentProfile: "developer" },
    auth: { authenticateApiToken: auth, authenticateSession: auth },
    capture: { scheduleProjectedMemoryEventProcessing: vi.fn() },
    encryption: {},
    rateLimit: {
      sourceJournal: async () => {},
      memoryRead: async () => {},
      memoryWrite: async () => {},
      projectionRebuild: async () => {}
    }
  };
  const app = Fastify();
  registerRawConversationRoutes(app, context as unknown as ApiRouteContext);
  cleanup.push(() => app.close());
  const payload = { artifactId, sessionId, sourceOffset: bytes.length };
  return {
    app,
    repo,
    auth,
    context,
    artifact,
    segment,
    payload,
    send: () =>
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items/release-journal",
        payload
      })
  };
}

describe("managed journal release route", () => {
  it("reads verified source bytes and supplies a derived capability to the repository", async () => {
    const f = await fixture();
    const result = await f.send();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ conversationItemIds: ["released"] });
    expect(f.repo.releaseConversationProjectionHold).toHaveBeenCalledWith(
      { userId: "owner" },
      expect.objectContaining({
        verifiedJournal: expect.objectContaining({
          sourceOffset: f.payload.sourceOffset,
          items: expect.arrayContaining([
            expect.objectContaining({ stable: "answer:0" })
          ])
        })
      })
    );
  });
  it("authenticates before reading any source", async () => {
    const f = await fixture();
    f.auth.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { statusCode: 401 })
    );
    expect((await f.send()).statusCode).toBe(401);
    expect(f.repo.getConversationSourceArtifact).not.toHaveBeenCalled();
  });
  it("rejects an unowned artifact without reading bytes", async () => {
    const f = await fixture();
    f.repo.getConversationSourceArtifact.mockResolvedValue(null);
    expect((await f.send()).statusCode).toBe(409);
    expect(f.repo.listConversationSourceSegments).not.toHaveBeenCalled();
  });
  it("rejects the surface on a hosted profile", async () => {
    const f = await fixture();
    f.context.config.deploymentProfile = "managed_cloud";
    expect((await f.send()).statusCode).toBe(404);
    expect(f.repo.getConversationSourceArtifact).not.toHaveBeenCalled();
  });
  it("rejects mismatched session identity and non-managed sessions before source reads", async () => {
    const f = await fixture();
    f.payload.sessionId = randomUUID();
    expect((await f.send()).statusCode).toBe(409);
    f.payload.sessionId = f.artifact.sessionId;
    f.repo.getCapturedSession.mockResolvedValue({
      metadata: { managedConversation: false }
    });
    expect((await f.send()).statusCode).toBe(404);
    expect(f.repo.listConversationSourceSegments).not.toHaveBeenCalled();
  });
  it("rejects gaps, changed bytes, and incomplete frontiers without releasing", async () => {
    const f = await fixture();
    f.segment.sourceStartOffset = 1;
    expect((await f.send()).statusCode).toBe(409);
    f.segment.sourceStartOffset = 0;
    const digest = f.segment.plaintextDigest;
    f.segment.plaintextDigest = "0".repeat(64);
    expect((await f.send()).statusCode).not.toBe(200);
    f.segment.plaintextDigest = digest;
    f.payload.sourceOffset -= 1;
    expect((await f.send()).statusCode).toBe(409);
    expect(f.repo.releaseConversationProjectionHold).not.toHaveBeenCalled();
  });
});
