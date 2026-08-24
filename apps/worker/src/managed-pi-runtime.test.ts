import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryApiClient } from "@koed/mcp-server";

const mocks = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("@koed/mcp-server", () => ({
  completeTranscriptBoundary: () => 100,
  piSessionIdentity: () => ({ id: "native-session", cwd: "/source" }),
  processPiTranscriptSignal: mocks.process
}));
import { captureManagedPiTurn } from "./managed-pi-runtime.js";

const homes: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const home of homes.splice(0)) await rm(home, { recursive: true });
});

async function fixture(providerOffset = 100, offsets = [100]) {
  const home = await mkdtemp(join(tmpdir(), "koed-pi-capture-"));
  homes.push(home);
  const transcriptPath = join(home, "session.jsonl");
  await writeFile(transcriptPath, "{}\n");
  const artifact = {
    id: "artifact",
    sessionId: "captured",
    providerCursorOffset: providerOffset
  };
  const cursor = vi.fn();
  for (const sourceOffset of offsets)
    cursor.mockResolvedValueOnce({ cursor: { sourceOffset } });
  const client = {
    lookupConversationSourceArtifact: vi.fn().mockResolvedValue({ artifact }),
    getConversationSourceCursor: cursor,
    releaseManagedJournalProjection: vi
      .fn()
      .mockResolvedValue({ conversationItemIds: ["released-item"] }),
    projectConversationItems: vi.fn().mockResolvedValue({})
  };
  return {
    artifact,
    client,
    run: () =>
      captureManagedPiTurn({
        client: client as unknown as MemoryApiClient,
        sessionId: "native-session",
        transcriptPath,
        sessionDirectory: home,
        cwd: "/receiving-workspace",
        env: {}
      })
  };
}

describe("managed Pi canonical capture", () => {
  it("drains every canonical page through the completed source frontier", async () => {
    const f = await fixture(100, [30, 60, 100]);
    expect((await f.run()).artifact).toEqual(f.artifact);
    expect(mocks.process).toHaveBeenCalledTimes(3);
    expect(
      f.client.releaseManagedJournalProjection
    ).toHaveBeenCalledExactlyOnceWith({
      sessionId: "captured",
      artifactId: "artifact",
      sourceOffset: 100
    });
    expect(f.client.projectConversationItems).toHaveBeenCalledExactlyOnceWith({
      conversationItemIds: ["released-item"],
      limit: 1
    });
    expect(mocks.process.mock.calls[0]?.[2]).toMatchObject({
      cwd: "/source",
      sourceSessionId: "native-session",
      eventName: "agent_settled"
    });
  });

  it("requires the current turn to be journaled even when the previous cursor is caught up", async () => {
    const f = await fixture(50, [50]);
    await expect(f.run()).rejects.toThrow(
      "ManagedConversationPiCaptureIncompleteError"
    );
  });

  it("fails closed when terminal verification rejects the journal", async () => {
    const f = await fixture();
    f.client.releaseManagedJournalProjection.mockRejectedValue(
      new Error("managed_terminal_journal_invalid")
    );
    await expect(f.run()).rejects.toThrow("managed_terminal_journal_invalid");
    expect(f.client.projectConversationItems).not.toHaveBeenCalled();
  });

  it("fails when canonical consumption stops making progress", async () => {
    const f = await fixture(100, [30, 30]);
    await expect(f.run()).rejects.toThrow(
      "ManagedConversationPiCaptureProgressError"
    );
  });
});
