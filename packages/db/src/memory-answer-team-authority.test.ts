import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedMemoryConflictError } from "@koed/shared";
import {
  assertMemoryAnswerTeamAuthorityWithClient,
  freezeMemoryAnswerTeamAuthorityWithClient,
  MemoryAnswerTeamAuthorityError
} from "./memory-answer-team-authority.js";
import {
  freezeSharedMemorySemanticRecallBoundaryWithClient,
  readSharedMemoryGrantAuthorityWithClient
} from "./shared-memory-repository.js";

vi.mock("./shared-memory-repository.js", async (original) => ({
  ...(await original<typeof import("./shared-memory-repository.js")>()),
  freezeSharedMemorySemanticRecallBoundaryWithClient: vi.fn(),
  readSharedMemoryGrantAuthorityWithClient: vi.fn()
}));

const actor = { userId: "11111111-1111-4111-8111-111111111111" };
const client: Pick<pg.PoolClient, "query"> = { query: vi.fn() };
const boundary = {
  teamId: "22222222-2222-4222-8222-222222222222",
  teamVersion: 1,
  teamWorkspaceId: "33333333-3333-4333-8333-333333333333",
  workspaceVersion: 1,
  membershipVersion: 1,
  workspaceAccessVersion: 1,
  userRowVersion: "1",
  shareGrantIds: ["44444444-4444-4444-8444-444444444444"]
};
const freeze = vi.mocked(freezeSharedMemorySemanticRecallBoundaryWithClient);
const read = vi.mocked(readSharedMemoryGrantAuthorityWithClient);

describe("Memory Answer Team authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    freeze.mockResolvedValue(structuredClone(boundary));
    read.mockResolvedValue({
      row: {},
      grant: { grantVersion: 1, consentId: "consent" },
      representation: {
        sourceRevisionHash: "source",
        provenanceHash: "provenance",
        effectivePrivacyPolicyHash: "privacy"
      }
    } as Awaited<ReturnType<typeof readSharedMemoryGrantAuthorityWithClient>>);
  });

  const frozen = () =>
    freezeMemoryAnswerTeamAuthorityWithClient(client, actor, {
      teamWorkspaceId: boundary.teamWorkspaceId
    });

  it("preserves the original grant boundary while validating current bindings", async () => {
    const authority = await frozen();
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).resolves.toBeUndefined();
    expect(freeze).toHaveBeenLastCalledWith(
      client,
      actor,
      expect.objectContaining({
        lockRows: true,
        onlyGrantIds: boundary.shareGrantIds
      })
    );
    expect(read).toHaveBeenCalledWith(
      client,
      actor,
      expect.objectContaining({ representation: "curated_assertions" }),
      true,
      expect.any(Object)
    );
  });

  it("denies changed source authorization and grant revisions", async () => {
    const authority = await frozen();
    read.mockResolvedValue({
      row: {},
      grant: { grantVersion: 2 },
      representation: { provenanceHash: "changed" }
    } as Awaited<ReturnType<typeof readSharedMemoryGrantAuthorityWithClient>>);
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
  });

  it("denies changed membership and requester identity", async () => {
    const authority = await frozen();
    freeze.mockResolvedValue({ ...boundary, membershipVersion: 2 });
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(
        client,
        { userId: "other" },
        authority
      )
    ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
  });

  it("accepts persisted JSONB property ordering and rejects malformed boundaries", async () => {
    const authority = await frozen();
    authority.recallBoundary = Object.fromEntries(
      Object.entries(authority.recallBoundary).reverse()
    ) as typeof boundary;
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).resolves.toBeUndefined();
    authority.recallBoundary.teamWorkspaceId = "invalid";
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
  });

  it("normalizes stale privacy authority without swallowing database failures", async () => {
    const authority = await frozen();
    read.mockRejectedValue(new SharedMemoryConflictError("Privacy changed"));
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).rejects.toBeInstanceOf(MemoryAnswerTeamAuthorityError);
    const unavailable = new Error("database unavailable");
    read.mockRejectedValue(unavailable);
    await expect(
      assertMemoryAnswerTeamAuthorityWithClient(client, actor, authority)
    ).rejects.toBe(unavailable);
  });
});
